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

// ---- remote (streamable HTTP) servers ----

function httpResponse(body, { status = 200, sessionId = "" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => String(name).toLowerCase() === "mcp-session-id" ? sessionId : "" },
    text: async () => body
  };
}

const REMOTE = {
  name: "github", transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  headers: { Authorization: "Bearer ghp_test" }
};

test("a remote server gets a real initialize/tools-list handshake", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return httpResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "github-mcp", version: "1" } } }), { sessionId: "sess-1" });
    }
    if (calls.length === 2) return httpResponse("", { status: 202 });
    return httpResponse(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "get_file_contents" }, { name: "list_issues" }] } }));
  };
  const result = await testMcpServer(REMOTE, { timeoutMs: 3000, fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tools, ["get_file_contents", "list_issues"]);
  assert.match(result.phases[0], /github-mcp/);
  assert.equal(calls.length, 3, "initialize, initialized, tools/list");
  assert.equal(calls[0].url, REMOTE.url);
  assert.equal(calls[0].init.headers.Authorization, "Bearer ghp_test", "the token is sent");
  assert.equal(calls[2].init.headers["mcp-session-id"], "sess-1", "the session rides along");
  assert.equal(JSON.parse(calls[2].init.body).method, "tools/list");
});

test("an SSE reply is read as well as a bare JSON one", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    const payload = n === 1
      ? { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "sse" } } }
      : { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search_code" }] } };
    return httpResponse(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const result = await testMcpServer(REMOTE, { timeoutMs: 3000, fetchImpl });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.tools, ["search_code"]);
});

test("a 401 says the token is missing instead of 'cannot start'", async () => {
  // The real header carries WWW-Authenticate; check the hint is passed on.
  const withAuth = async () => ({
    ok: false, status: 401,
    headers: { get: (name) => String(name).toLowerCase() === "www-authenticate" ? 'Bearer error="invalid_token"' : "" },
    text: async () => ""
  });
  const result = await testMcpServer(REMOTE, { timeoutMs: 3000, fetchImpl: withAuth });
  assert.equal(result.ok, false);
  assert.match(result.error, /认证失败（401）/);
  assert.match(result.error, /Authorization: Bearer/);
  assert.match(result.error, /invalid_token/);
});

test("a refused connection is reported as a connection error", async () => {
  const fetchImpl = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
  const result = await testMcpServer(REMOTE, { timeoutMs: 3000, fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /getaddrinfo/);
});
