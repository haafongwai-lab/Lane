import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The chrome around the transcript must not move when the transcript scrolls.
 *
 * Two causes. The bar was static, so it rode up with the page. And 回到底部 is
 * position:fixed — but `#view-chat` carried a transform from its entrance
 * animation (`animation: ... both` leaves an identity matrix), and a transformed
 * ancestor becomes the containing block for a fixed child, so the button was
 * pinned to the view instead of the viewport and scrolled with the content.
 * Measured before: tools 52→-548, 回到底部 2474→1874. After: no movement at all.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, "..", "desktop", "styles.css"), "utf8");

const rule = (selector) => {
  // Anchor to the start of a rule so `body.view-chat .chat-topbar {` does not
  // answer for `.chat-topbar {`.
  const at = CSS.indexOf(`\n${selector}`);
  if (at < 0) return "";
  const from = at + 1;
  return CSS.slice(from, CSS.indexOf("}", from) + 1);
};

test("the top bar sticks to the top instead of riding up with the page", () => {
  const topbar = rule(".chat-topbar {");
  assert.match(topbar, /position: sticky/);
  assert.match(topbar, /top: 0/);
  // A background, or the transcript would scroll visibly through it.
  assert.match(topbar, /background: linear-gradient/);
});

test("the chat view has no transform, so a fixed child pins to the viewport", () => {
  const view = rule("#view-chat.active {");
  assert.match(view, /animation: none/);
  assert.equal(/transform:/.test(view), false, "no transform on the view");
});

test("the view's top padding is removed so the bar never slides on first scroll", () => {
  assert.match(CSS, /body\.view-chat #view-chat \{ padding-top: 0; padding-bottom: 0; \}/);
});

test("历史 and 清空 are visually separated", () => {
  const clear = rule(".chat-clear {");
  assert.match(clear, /margin-left: 6px/);
});

test("工具, 历史 and 清空 are one family of controls", () => {
  // One rule shapes all three, so the row reads as a single control set.
  const group = /\.chat-mcp-trigger, \.chat-history-trigger, \.chat-clear \{[\s\S]*?\}/.exec(CSS);
  assert.ok(group, "the shared rule exists");
  assert.match(group[0], /height: 28px/);
  assert.match(group[0], /border: 1px solid var\(--line\)/);
  assert.match(group[0], /border-radius: var\(--radius-sm\)/);
  assert.match(group[0], /font: 600 11\.5px/);
  // The old per-button overrides are gone, or they would undo the shared rule.
  assert.equal(/\.chat-history-trigger \{ padding: 4px 10px/.test(CSS), false);
});

test("the attach control is a plus, aligned with the model name", () => {
  const html = fs.readFileSync(path.join(HERE, "..", "desktop", "index.html"), "utf8");
  const attach = html.slice(html.indexOf('id="chat-attach"') - 120, html.indexOf('id="chat-attach"') + 220);
  assert.match(attach, /<span aria-hidden="true">\+<\/span>/);
  assert.equal(/<svg/.test(attach), false, "the paperclip icon is gone");
  const btn = rule(".chat-attach {");
  assert.match(btn, /width: 28px/);
  assert.match(btn, /height: 28px/);
  assert.match(btn, /align-items: center/);
  assert.match(btn, /justify-content: center/);
  assert.match(CSS, /\.chat-attach span \{/);
});

test("回到底部 is fixed to the viewport", () => {
  const button = rule(".chat-to-bottom {");
  assert.match(button, /position: fixed/);
});
