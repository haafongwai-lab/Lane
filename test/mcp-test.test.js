import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { testMcpServer } from "../src/mcp-test.js";

/**
 * The extensions page's lamps only ever said "configuration written" — the
 * first 12306-mcp deployment carried wrong args into three clients and
 * nothing in the UI could notice. This is the in-product version of the
 * stdio handshake probe: spawn, initialize, tools/list. The spawn is faked
 * here so the states are deterministic; the real handshake was exercised
 * against 12306-mcp itself during the incident.
 */

// A fake child process: feeds scripted stdout lines, records what was written.
function fakeChild(script) {
  const child = new EventEmitter();
  child.stdin = {
    writes: [],
    write(data) { this.writes.push(data); }
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  child.emit_line = (line) => child.stdout.emit("data", Buffer.from(`${line}\n`));
  queueMicrotask(() => {
    for (const step of script) step(child);
  });
  return child;
}

const OK_SERVER = { name: "x", transport: "stdio", command: "npx", args: ["-y", "x"] };

test("a healthy server: initialize answers, then the tool list", async () => {
  const result = await testMcpServer(OK_SERVER, {
    timeoutMs: 5000,
    spawnImpl: () => fakeChild([
      (child) => {
        const init = JSON.parse(child.stdin.writes[0]);
        assert.equal(init.method, "initialize");
        assert.equal(init.params.clientInfo.name, "lane");
        child.emit_line(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: { serverInfo: { name: "fake-mcp", version: "1.2.3" } }
        }));
      },
      (child) => {
        // initialized notification carries no id; then the tools request.
        assert.equal(JSON.parse(child.stdin.writes[1]).method, "notifications/initialized");
        assert.equal(JSON.parse(child.stdin.writes[2]).method, "tools/list");
        child.emit_line(JSON.stringify({
          jsonrpc: "2.0", id: 2,
          result: { tools: [{ name: "get-tickets" }, { name: "get-current-date" }] }
        }));
      }
    ])
  });
  assert.equal(result.ok, true);
  assert.match(result.phases[0], /fake-mcp 1\.2\.3/);
  assert.deepEqual(result.tools, ["get-tickets", "get-current-date"]);
});

test("a server that exits early reports its last stderr line", async () => {
  const result = await testMcpServer(OK_SERVER, {
    timeoutMs: 5000,
    spawnImpl: () => fakeChild([
      (child) => {
        child.stderr.emit("data", Buffer.from("npm warn Unknown cli config\n"));
        child.stderr.emit("data", Buffer.from("文件名、目录名或卷标语法不正确。\n"));
        child.emit("exit", 1);
      }
    ])
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /code 1/);
  assert.match(result.error, /卷标语法不正确/);
});

test("a server that never speaks is killed at the timeout", async () => {
  const result = await testMcpServer(OK_SERVER, {
    timeoutMs: 120,
    spawnImpl: () => fakeChild([])
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /未完成握手/);
});

test("a spawn that throws immediately is a clean failure", async () => {
  const result = await testMcpServer(OK_SERVER, {
    timeoutMs: 5000,
    spawnImpl: () => { throw new Error("ENOENT"); }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});

test("a server that answers initialize but refuses tools/list", async () => {
  const result = await testMcpServer(OK_SERVER, {
    timeoutMs: 5000,
    spawnImpl: () => fakeChild([
      (child) => child.emit_line(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "x" } } })),
      (child) => child.emit_line(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "no tools" } }))
    ])
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /no tools/);
});

test("on Windows an ENOENT for a .cmd shim falls back to a shell attempt", async () => {
  // npx is a batch shim on Windows: the bare spawn emits ENOENT async, and
  // the clients run it through cmd.exe. The test must follow.
  const calls = [];
  const result = await testMcpServer(OK_SERVER, {
    timeoutMs: 5000,
    spawnImpl: (command, args, opts) => {
      calls.push(opts.shell === true);
      if (opts.shell !== true) {
        // First attempt: the ENOENT, async as Node delivers it.
        const failing = fakeChild([]);
        queueMicrotask(() => failing.emit("error", Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" })));
        return failing;
      }
      return fakeChild([
        (child) => child.emit_line(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: { serverInfo: { name: "shim", version: "1.0" } }
        })),
        (child) => child.emit_line(JSON.stringify({
          jsonrpc: "2.0", id: 2,
          result: { tools: [{ name: "work" }] }
        }))
      ]);
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [false, true], "exactly one shell fallback");
  assert.match(result.phases[0], /shell/);
  assert.deepEqual(result.tools, ["work"]);
});

test("a non-Windows ENOENT does not retry through a shell", async () => {
  const calls = [];
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    const result = await testMcpServer(OK_SERVER, {
      timeoutMs: 5000,
      spawnImpl: (command, args, opts) => {
        calls.push(opts.shell === true);
        const failing = fakeChild([]);
        queueMicrotask(() => failing.emit("error", Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" })));
        return failing;
      }
    });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, [false], "one attempt only");
    assert.match(result.error, /ENOENT/);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});
