import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How an answer is shown.
 *
 * The model writes Markdown; the panel renders it — headings, lists, code,
 * emphasis — instead of showing raw asterisks. Rendering is building nodes, not
 * injecting HTML, so a model that writes markup cannot become markup.
 *
 * A tool call is a one-line status ("正在调用「… MCP」…") above the composer,
 * never a transcript entry. And the MCP count badge centres its digit.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const APP = read("desktop/app.js");
const HTML = read("desktop/index.html");
const CSS = read("desktop/styles.css");
const MAIN = read("desktop/main.js");

test("answers are rendered from Markdown", () => {
  assert.match(APP, /function renderMarkdown\(/);
  assert.match(APP, /function chatInline\(/);
  assert.match(APP, /document\.createElement\("pre"\)/);
  assert.match(APP, /document\.createElement\("code"\)/);
  assert.match(APP, /document\.createElement\("ul"\)/);
  assert.match(APP, /document\.createElement\("ol"\)/);
  assert.match(APP, /chatPaint\(answer, streamed\)/);
  assert.match(APP, /chatPaint\(answer, final, true\)/);
});

test("rendering never trusts model HTML", () => {
  // Text runs become text nodes; the only innerHTML in the chat module is the
  // empty-state copy, never model output.
  assert.match(APP, /document\.createTextNode/);
  const from = APP.indexOf("function chatInline(");
  const to = APP.indexOf("// ---- MCP picker");
  const region = APP.slice(from, to);
  assert.equal(/\.innerHTML\s*=/.test(region), false, "no innerHTML with model text");
  assert.equal(/\binsertAdjacentHTML\b/.test(region), false);
});

test("a tool call is a transient status line, not a transcript entry", () => {
  assert.equal(/chatToolLine/.test(APP), false, "the transcript line is gone");
  assert.match(APP, /function chatToolStatus\(/);
  assert.match(APP, /正在调用「\$\{server\} MCP」…/);
  assert.match(HTML, /id="chat-tool-status"/);
  assert.match(CSS, /\.chat-tool-status \{/);
  // The server name rides on the event so the status can name it.
  assert.match(MAIN, /server: target\?\.session\?\.name \|\| ""/);
});

test("the MCP count badge centres its digit", () => {
  const rule = CSS.slice(CSS.indexOf(".chat-mcp-count {"), CSS.indexOf("}", CSS.indexOf(".chat-mcp-count {")));
  assert.match(rule, /display: inline-flex/);
  assert.match(rule, /align-items: center/);
  assert.match(rule, /justify-content: center/);
  assert.match(rule, /line-height: 1/);
  assert.match(rule, /box-sizing: border-box/);
});
