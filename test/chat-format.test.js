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
  assert.match(APP, /function chatList\(/);
  assert.match(APP, /document\.createElement\(ordered \? "ol" : "ul"\)/);
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

test("the typography matches DSH's markdown surface", () => {
  // Read from DSH's own stylesheet: base 14px/24px, h1 21px/30px, h2 19/28,
  // h3 18/26, h4 14/24, 16px block gaps, 18px list indent.
  assert.match(CSS, /font: 14px\/24px var\(--font-sans\)/);
  assert.match(CSS, /\.chat-text h1 \{ font: 700 21px\/30px/);
  assert.match(CSS, /\.chat-text h2 \{ font: 700 19px\/28px/);
  assert.match(CSS, /\.chat-text h3 \{ font: 700 18px\/26px/);
  assert.match(CSS, /\.chat-text p \{ margin: 16px 0; \}/);
  assert.match(CSS, /\.chat-text :where\(ul,ol\) \{ margin: 16px 0; padding-left: 18px; \}/);
  assert.match(CSS, /\.chat-text hr \{[^}]*height: \.5px/);
  assert.match(CSS, /text-decoration: underline dotted/);
});

test("headings keep their real level instead of being shifted down two", () => {
  // The old renderer mapped # to h3 to dodge the page's own h1; DSH uses h1-h6
  // directly and the scoped CSS keeps them from inheriting the page heading.
  assert.match(APP, /document\.createElement\(`h\$\{head\[1\]\.length\}`\)/);
  assert.equal(/head\[1\]\.length \+ 2/.test(APP), false);
});

test("code blocks are header'd cards with a copy button, like DSH's", () => {
  assert.match(APP, /function chatCodeCard\(/);
  assert.match(APP, /chat-code-head/);
  assert.match(APP, /chat-code-copy/);
  assert.match(APP, /navigator\.clipboard\.writeText\(/);
  assert.match(CSS, /\.chat-code \{[\s\S]*?border-radius: 16px/);
  assert.match(CSS, /\.chat-code pre \{[\s\S]*?font: 11px\/19px/);
  assert.match(CSS, /\.chat-text :not\(pre\) > code \{[\s\S]*?border-radius: 8px/);
});

test("tables and task lists render, not the raw pipes and brackets", () => {
  assert.match(APP, /function chatTable\(/);
  assert.match(APP, /CHAT_TABLE_SEP/);
  assert.match(CSS, /\.chat-text th \{/);
  assert.match(CSS, /\.chat-text td \{/);
  assert.match(APP, /box\.type = "checkbox"/);
});

test("the DSH palette has its own dark-theme values", () => {
  assert.match(CSS, /:root\[data-theme="dark"\] \.chat-msg\.assistant \.chat-text \{/);
  assert.match(CSS, /--md-code-bg: #1b1d21/);
});
