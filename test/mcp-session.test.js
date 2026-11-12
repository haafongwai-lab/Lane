import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { openMcpSession } from "../src/mcp-session.js";

/**
 * A live MCP session: list the tools once, call one repeatedly, then close.
 * The fake transports below answer the same JSON-RPC the real ones do, so the
 * session's correlation, timeout and result-shaping are exercised without a
 * child process or a network.
 */

function fakeStdioChild(handler) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();
  stdin.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const reply = handler(message);
      if (reply) setImmediate(() => stdout.write(`${JSON.stringify(reply)}\n`));
    }
  });
  return {
    stdin, stdout, stderr,
    on: (event, fn) => events.on(event, fn),
    kill: () => events.emit("exit", 0)
  };
}

const TOOLS = [{
  name: "echo",
  description: "echo text back",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
}];

function stdioHandler(message) {
  if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "fake", version: "1.0" } } };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } };
  if (message.method === "tools/call") {
    return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `echo:${message.params.arguments.text}` }] } };
  }
  return null; // notifications/initialized and anything else are silent
}

test("a stdio session lists tools and calls one", async () => {
  let killed = false;
  const session = await openMcpSession(
    { name: "fake", transport: "stdio", command: "fake-mcp" },
    { timeoutMs: 2000, spawnImpl: () => { const child = fakeStdioChild(stdioHandler); const kill = child.kill; child.kill = () => { killed = true; kill(); }; return child; } }
  );
  assert.equal(session.tools.length, 1);
  assert.equal(session.tools[0].name, "echo");
  assert.match(session.tools[0].description, /echo/);

  const result = await session.callTool("echo", { text: "hi" });
  assert.equal(result.ok, true);
  assert.equal(result.text, "echo:hi");

  session.close();
  assert.equal(killed, true, "close ends the child");
});

test("a JSON-RPC error from callTool is surfaced, not swallowed", async () => {
  const handler = (message) => (message.method === "tools/call"
    ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "boom" } }
    : stdioHandler(message));
  const session = await openMcpSession(
    { name: "fake", transport: "stdio", command: "fake-mcp" },
    { timeoutMs: 2000, spawnImpl: () => fakeStdioChild(handler) }
  );
  await assert.rejects(() => session.callTool("echo", { text: "x" }), /boom/);
  session.close();
});

test("a request that never answers times out instead of hanging", async () => {
  const handler = () => null; // never replies
  await assert.rejects(
    () => openMcpSession(
      { name: "slow", transport: "stdio", command: "fake-mcp" },
      { timeoutMs: 120, spawnImpl: () => fakeStdioChild(handler) }
    ),
    /未响应/
  );
});

function httpResponse(body, { sessionId } = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === "mcp-session-id" ? sessionId || null : null) },
    text: async () => JSON.stringify(body)
  };
}

test("an HTTP session keeps the session id and calls a tool", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const message = JSON.parse(init.body);
    seen.push({ method: message.method, session: init.headers["mcp-session-id"] || "" });
    if (message.method === "initialize") {
      return httpResponse({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "remote" } } }, { sessionId: "s-1" });
    }
    if (message.method === "notifications/initialized") return httpResponse({}, { sessionId: "s-1" });
    if (message.method === "tools/list") return httpResponse({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } }, { sessionId: "s-1" });
    if (message.method === "tools/call") {
      return httpResponse({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "remote:" + message.params.arguments.text }] } }, { sessionId: "s-1" });
    }
    return httpResponse({});
  };
  const session = await openMcpSession(
    { name: "remote", transport: "http", url: "https://mcp.test/endpoint" },
    { timeoutMs: 2000, fetchImpl }
  );
  assert.equal(session.tools[0].name, "echo");
  const result = await session.callTool("echo", { text: "yo" });
  assert.equal(result.text, "remote:yo");
  // The session id from initialize rode along on the later calls.
  const later = seen.filter((row) => row.method === "tools/list" || row.method === "tools/call");
  assert.ok(later.every((row) => row.session === "s-1"), "session id carried");
});
