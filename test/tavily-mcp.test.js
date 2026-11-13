import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Tavily MCP server.
 *
 * It gives the 问答 panel the one thing it cannot do alone: look something up.
 * The protocol surface and the guards are covered here; the live searches are
 * exercised by a probe against the real API, not in the offline suite — a test
 * that needs a paid key would fail on every machine but one.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SCRIPT = path.join(ROOT, "scripts", "tavily-mcp.mjs");
const SOURCE = fs.readFileSync(SCRIPT, "utf8");

function rpc(messages, { timeoutMs = 8000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      // A clean environment: a key left in the shell must not change the test.
      env: { ...process.env, TAVILY_API_KEY: "", ...env }
    });
    let buffer = "";
    const replies = [];
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line) replies.push(JSON.parse(line));
      }
    });
    child.on("error", reject);
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    const expected = messages.filter((m) => !String(m.method).startsWith("notifications/")).length;
    const timer = setInterval(() => {
      if (replies.length >= expected) {
        clearInterval(timer);
        clearTimeout(deadline);
        child.kill();
        resolve(replies);
      }
    }, 40);
    const deadline = setTimeout(() => {
      clearInterval(timer);
      child.kill();
      reject(new Error(`no reply within ${timeoutMs}ms; got ${replies.length}/${expected}`));
    }, timeoutMs);
  });
}

test("it speaks the MCP handshake and lists its two tools", async () => {
  const replies = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ]);
  const init = replies.find((r) => r.id === 1);
  assert.equal(init.result.serverInfo.name, "tavily");
  assert.equal(init.result.capabilities.tools.listChanged, false);

  const list = replies.find((r) => r.id === 2);
  const names = list.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["web_search", "web_extract"]);
  // Both carry a schema, or the model cannot call them.
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description);
  }
  assert.deepEqual(list.result.tools[0].inputSchema.required, ["query"]);
  assert.deepEqual(list.result.tools[1].inputSchema.required, ["urls"]);
});

test("a notification is never answered", async () => {
  const replies = await rpc([
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 7, method: "ping" }
  ]);
  assert.equal(replies.length, 1, "only the ping is answered");
  assert.equal(replies[0].id, 7);
});

test("an unknown method is refused, not silently dropped", async () => {
  const replies = await rpc([{ jsonrpc: "2.0", id: 3, method: "tools/nope" }]);
  assert.equal(replies[0].error.code, -32601);
});

test("a missing key is reported as a tool error, in words", async () => {
  const replies = await rpc([
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "web_search", arguments: { query: "x" } } }
  ]);
  const result = replies[0].result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /TAVILY_API_KEY/);
});

test("a malformed key is refused before it reaches the network", async () => {
  const replies = await rpc([
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "web_search", arguments: { query: "x" } } }
  ], { env: { TAVILY_API_KEY: "not-a-tavily-key" } });
  assert.match(replies[0].result.content[0].text, /tvly-/);
});

test("an empty query and a bad URL are refused without a request", async () => {
  const replies = await rpc([
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "web_search", arguments: { query: "   " } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "web_extract", arguments: { urls: ["ftp://x"] } } }
  ], { env: { TAVILY_API_KEY: "tvly-aaaaaaaaaaaa" } });
  assert.match(replies.find((r) => r.id === 6).result.content[0].text, /缺少搜索词/);
  assert.match(replies.find((r) => r.id === 7).result.content[0].text, /http\(s\)/);
});

test("the key never reaches a log line or a result", () => {
  // It is read once, sent as a bearer header, and never printed.
  assert.match(SOURCE, /authorization: `Bearer \$\{apiKey\(\)\}`/);
  assert.equal(/log\([^)]*key/.test(SOURCE), false, "no log line mentions the key");
  assert.equal(/text: .*apiKey\(\)/.test(SOURCE), false, "no result carries the key");
});

test("the caps are the ones the panel can absorb", () => {
  assert.match(SOURCE, /const MAX_TEXT = 12_000/);
  // Results per search, and URLs per extract.
  assert.match(SOURCE, /max_results: Math\.min\(Math\.max\(Number\(count\) \|\| 5, 1\), 10\)/);
  assert.match(SOURCE, /\.slice\(0, 5\)/);
});

test("it is registered as a Lane MCP script, like the npm one", () => {
  // Lane runs it with the same node it runs itself with; no install step.
  assert.match(SOURCE, /^#!\/usr\/bin\/env node/);
  assert.match(SOURCE, /api\.tavily\.com/);
});
