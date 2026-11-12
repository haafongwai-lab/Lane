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

test("回到底部 is fixed to the viewport", () => {
  const button = rule(".chat-to-bottom {");
  assert.match(button, /position: fixed/);
});
