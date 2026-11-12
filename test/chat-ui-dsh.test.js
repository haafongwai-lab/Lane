import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The 问答 surface follows DSH's chat.
 *
 * A centred column, the user's words in a soft bubble on the right, the
 * assistant's text flowing without one, and a floating card at the bottom with
 * the input, the model picker and a circular send button. The model picker is a
 * custom dropdown (a native <select> cannot be styled to match), so it carries
 * the trigger/menu markup and the open/close behaviour DSH's has.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const HTML = read("desktop/index.html");
const APP = read("desktop/app.js");
const CSS = read("desktop/styles.css");

test("the composer is a floating card with a circular send button", () => {
  assert.match(HTML, /class="chat-card"/);
  assert.match(HTML, /class="chat-scroll" id="chat-log"/);
  assert.match(HTML, /class="chat-send" id="chat-send"/);
  assert.match(CSS, /\.chat-card \{[\s\S]*?border-radius: var\(--chat-radius-card\)/);
  assert.match(CSS, /--chat-radius-card: 28px/);
  assert.match(CSS, /\.chat-send, \.chat-stop \{[\s\S]*?border-radius: 50%/);
});

test("the model picker is a custom dropdown, not a native select", () => {
  assert.match(HTML, /id="chat-model-button"[\s\S]*?aria-haspopup="listbox"/);
  assert.match(HTML, /id="chat-model-menu"[\s\S]*?role="listbox" hidden/);
  // The old native control is gone.
  assert.equal(/<select[^>]*id="chat-model"/.test(HTML), false, "no native model select");
  // Open/close is wired, including a click elsewhere to dismiss.
  assert.match(APP, /function chatMenuOpen\(open\)/);
  assert.match(APP, /#chat-model-button"?\)?\?\.addEventListener\("click"/);
  assert.match(APP, /document\.addEventListener\("click", \(event\) => \{\s*\n\s*if \(!event\.target\.closest\("#chat-model-picker"\)\)/);
  assert.match(APP, /data-model=/);
});

test("the palette is DSH's: bluish neutrals and the #4176E6 accent", () => {
  assert.match(CSS, /--chat-accent: #4176e6;/);
  assert.match(CSS, /--chat-accent-hover: #3568d6;/);
  assert.match(CSS, /--chat-user-bubble: #f1f3f5;/);
  // Dark theme swaps the same variables rather than hardcoding colour.
  assert.match(CSS, /:root\[data-theme="dark"\] \{[\s\S]*?--chat-card:/);
});

test("user and assistant read differently: a bubble vs flowing text", () => {
  assert.match(CSS, /\.chat-msg\.user \.chat-text \{[\s\S]*?background: var\(--chat-user-bubble\)/);
  assert.match(CSS, /\.chat-msg\.assistant \.chat-text \{[\s\S]*?line-height: 1\.75/);
  // The bubble is pushed right by alignment: the message is a column now, so
  // justification would act on the vertical axis and do nothing.
  assert.match(CSS, /\.chat-msg\.user \{ align-items: flex-end; \}/);
});
