import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The remote-MCP form asks for headers as `Authorization: Bearer …` — that
 * is both its placeholder and what "paste JSON" writes into the box. The
 * save path used parsePairs(), which splits on "=", so a token typed exactly
 * as prompted was silently dropped and GitHub's hosted MCP server answered
 * 401 with no clue in the UI. The renderer's functions live in app.js, which
 * touches window.lane on load, so parseHeaders is lifted out of the source.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(HERE, "..", "desktop", "app.js"), "utf8");

function lift(name) {
  const from = APP.indexOf("function " + name + "(");
  // These two are the last function declarations in the file; a closing
  // brace at column zero is the end of the body. Matching on the next
  // `function` would fail here, and slicing to EOF would execute the DOM
  // listeners that follow.
  const end = APP.indexOf("\n}", from);
  assert.ok(from >= 0 && end > from, name + " is still in app.js");
  return new Function(APP.slice(from, end + 2) + "\nreturn " + name + ";")();
}

const parseHeaders = lift("parseHeaders");
const parsePairs = lift("parsePairs");

test("a header typed as the placeholder shows it is kept", () => {
  assert.deepEqual(parseHeaders("Authorization: Bearer ghp_abc123"), {
    Authorization: "Bearer ghp_abc123"
  });
});

test("several headers, and the format 'paste JSON' writes", () => {
  assert.deepEqual(
    parseHeaders("Authorization: Bearer ghp_abc123, X-MCP-Readonly: true"),
    { Authorization: "Bearer ghp_abc123", "X-MCP-Readonly": "true" }
  );
});

test("a comma inside a value is not a new header", () => {
  // GitHub's X-MCP-Toolsets takes a comma-separated list.
  assert.deepEqual(parseHeaders("X-MCP-Toolsets: repos,issues,pull_requests"), {
    "X-MCP-Toolsets": "repos,issues,pull_requests"
  });
});

test("colons and equals inside a value survive", () => {
  assert.deepEqual(parseHeaders("X-Forwarded: https://api.githubcopilot.com/mcp/"), {
    "X-Forwarded": "https://api.githubcopilot.com/mcp/"
  });
  assert.deepEqual(parseHeaders("Authorization= Bearer ghp_x"), { Authorization: "Bearer ghp_x" });
});

test("an empty box is an empty object", () => {
  assert.deepEqual(parseHeaders(""), {});
  assert.deepEqual(parseHeaders("   "), {});
});

test("environment variables keep their KEY=value parser", () => {
  assert.deepEqual(parsePairs("API_KEY=abc, DEBUG=1"), { API_KEY: "abc", DEBUG: "1" });
});

test("the save path uses the header parser, not the env parser", () => {
  const save = APP.slice(APP.indexOf('$("#mcp-save")'), APP.indexOf('$("#mcp-list")'));
  assert.match(save, /server\.headers = parseHeaders\(/);
  assert.match(save, /server\.env = parsePairs\(/);
  assert.doesNotMatch(save, /server\.headers = parsePairs\(/);
});
