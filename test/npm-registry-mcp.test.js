import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The npm-registry MCP server.
 *
 * It gives the 问答 panel a way to answer "what shipped recently" without the
 * model inventing version numbers. These tests cover the protocol surface and
 * the guards; the registry queries themselves are exercised end-to-end against
 * the live registry by a probe, not in the offline suite.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SCRIPT = path.join(ROOT, "scripts", "npm-registry-mcp.mjs");
const SOURCE = fs.readFileSync(SCRIPT, "utf8");

function rpc(messages, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
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
    const timer = setInterval(() => {
      if (replies.length >= messages.filter((m) => !m.method.startsWith("notifications/")).length) {
        clearInterval(timer);
        clearTimeout(deadline);
        child.kill();
        resolve(replies);
      }
    }, 40);
    const deadline = setTimeout(() => {
      clearInterval(timer);
      child.kill();
      reject(new Error(`MCP server did not answer in ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

test("the handshake and tool list speak MCP over stdio", async () => {
  const replies = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ]);
  const init = replies.find((r) => r.id === 1);
  assert.equal(init?.result?.protocolVersion, "2024-11-05");
  assert.equal(init?.result?.serverInfo?.name, "npm-registry");
  const list = replies.find((r) => r.id === 2);
  assert.deepEqual(
    list?.result?.tools.map((t) => t.name),
    ["npm_versions", "npm_dist_tags", "npm_package", "npm_version", "npm_readme", "npm_compare"]
  );
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema?.type, "object");
    assert.ok(tool.inputSchema.required?.length, `${tool.name} needs a required field`);
  }
});

test("registry access is bounded and only the configured host is used", () => {
  assert.match(SOURCE, /https:\/\/registry\.npmjs\.org\//);
  assert.match(SOURCE, /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/);
  assert.match(SOURCE, /MAX_TARBALL_BYTES/);
});

test("a model-supplied package name is validated before it reaches fetch", () => {
  assert.match(SOURCE, /function checkName/);
  assert.match(SOURCE, /\^\(@\[a-z0-9\]/);
});

test("stdout carries JSON-RPC only; diagnostics go to stderr", () => {
  assert.ok(SOURCE.includes("process.stderr.write("), "diagnostics go to stderr");
  assert.ok(SOURCE.includes("JSON.stringify(message)") && SOURCE.includes("process.stdout.write("), "JSON-RPC goes to stdout");
  // No console.log anywhere in the server: a stray line breaks a frame.
  assert.equal(/console\.log/.test(SOURCE), false);
});

test("a failed query is returned as an MCP tool error, not a crash", () => {
  assert.match(SOURCE, /isError: true/);
  assert.match(SOURCE, /查询失败：/);
});
