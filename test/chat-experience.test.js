import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The 问答 panel's experience pass, plus 回到底部.
 *
 * Rendered answers now highlight code, nest lists by indent, and are painted in
 * two layers so a long answer is not rebuilt from scratch on every tick. A
 * stopped or failed turn no longer loses its text, thinking stays readable in a
 * collapsible block, each answer can be copied or asked again, a question typed
 * mid-answer is queued rather than refused, and a floating button returns the
 * reader to the end — DSH's own shape, 34px round, 16px above the composer.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const APP = read("desktop/app.js");
const HTML = read("desktop/index.html");
const CSS = read("desktop/styles.css");

test("code blocks are highlighted without a library", () => {
  assert.match(APP, /const CHAT_CODE_KEYWORDS = \{/);
  assert.match(APP, /function chatHighlight\(code, lang\)/);
  for (const token of ["tok-comment", "tok-string", "tok-number", "tok-keyword"]) {
    assert.ok(APP.includes(token), `${token} is produced`);
    assert.ok(CSS.includes(`.${token}`), `${token} is styled`);
  }
  // The highlighter builds text nodes and spans only, never markup.
  assert.match(APP, /code\.append\(chatHighlight\(source, lang\)\)/);
});

test("lists nest by indent instead of flattening", () => {
  assert.match(APP, /const depthOf = \(text\) => Math\.floor/);
  assert.match(APP, /const stack = \[\{ depth: 0, node: list \}\]/);
  assert.match(APP, /if \(lastItem\) lastItem\.append\(nested\); else parent\.append\(nested\)/);
});

test("a long answer is painted in two layers, not rebuilt whole", () => {
  assert.match(APP, /function chatStablePrefix\(text\)/);
  assert.match(APP, /chat-md-settled/);
  assert.match(APP, /chat-md-live/);
  // The settled layer is only re-rendered when its own text changes.
  assert.match(APP, /if \(layer\.dataset\.settled !== settled\)/);
  assert.match(CSS, /\.chat-text > \.chat-md-settled, \.chat-text > \.chat-md-live \{ display: block; \}/);
});

test("thinking stays readable in a collapsible block", () => {
  assert.match(APP, /function chatReasoningPaint\(answer, text\)/);
  assert.match(APP, /block = document\.createElement\("details"\)/);
  assert.match(APP, /summary\.textContent = "思考过程"/);
  assert.match(CSS, /\.chat-reasoning-summary \{/);
});

test("an answer can be copied whole or asked again", () => {
  assert.match(APP, /copy\.dataset\.chatAction = "copy"/);
  assert.match(APP, /retry\.dataset\.chatAction = "retry"/);
  assert.match(APP, /navigator\.clipboard\.writeText\(body\.textContent/);
  // Retry drops the turn it replaces, so it does not read as a follow-up.
  assert.match(APP, /chatHistory = chatHistory\.slice\(0, -2\)/);
  assert.match(CSS, /\.chat-msg\.assistant:hover \.chat-actions/);
});

test("a question typed mid-answer is queued, not refused", () => {
  assert.match(APP, /let chatQueued = null;/);
  assert.match(APP, /chatQueued = text;/);
  assert.match(APP, /已排队，上一条回答结束后发送/);
  // And it is sent when the turn ends.
  assert.match(APP, /if \(chatQueued\) \{/);
});

test("回到底部 follows DSH: 34px round, above the composer, shown when away", () => {
  assert.match(HTML, /id="chat-to-bottom"/);
  assert.match(HTML, /aria-label="回到底部"/);
  const rule = CSS.slice(CSS.indexOf(".chat-to-bottom {"), CSS.indexOf("}", CSS.indexOf(".chat-to-bottom {")));
  assert.match(rule, /width: 34px/);
  assert.match(rule, /height: 34px/);
  assert.match(rule, /border-radius: 50%/);
  assert.match(rule, /position: fixed/);
  // Shown only once the reader has left the end.
  assert.match(APP, /function chatUpdateToBottom\(\)/);
  assert.match(APP, /button\.hidden = atBottom/);
  assert.match(APP, /window\.addEventListener\("scroll", chatUpdateToBottom/);
  // Smooth, like DSH's.
  assert.match(APP, /behavior: "smooth"/);
});
