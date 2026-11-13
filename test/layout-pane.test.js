import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The shell is a desk with one card on it, which is how DeepSeek Harness builds
 * its frame (dsh-client-ui-layout):
 *
 *   .frame       background: sidebar fill; overflow: hidden
 *   .sidebarCol  background: sidebar fill
 *   .centerCol   background: bg-base; border-radius: 16px 0 0 0
 *
 * Lane has no titlebar, so the desk cannot come from a strip above the card —
 * it has to surround it. A canvas-coloured border on the card is that surround,
 * and the card scrolls its own content so its four corners stay put.
 *
 * The failure this replaced: two flat planes meeting at a hairline, with the
 * card scrolling under the page scrollbar so its right corners never existed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, "..", "desktop", "styles.css"), "utf8");
const MAIN = fs.readFileSync(path.join(HERE, "..", "desktop", "main.js"), "utf8");

const rule = (selector) => {
  const at = CSS.indexOf(`\n${selector}`);
  if (at < 0) return "";
  const from = at + 1;
  return CSS.slice(from, CSS.indexOf("}", from) + 1);
};

const token = (name) => [...CSS.matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());

test("the window is the desk: one colour, no page scroll", () => {
  assert.deepEqual(token("--canvas"), ["#f2f1ed", "#151517"]);
  // The Electron backdrop must be the same colour or the first paint flashes.
  assert.match(MAIN, /backgroundColor: nativeTheme\.shouldUseDarkColors \? "#151517" : "#f2f1ed"/);
  assert.match(CSS, /html, body \{ margin: 0; height: 100vh; overflow: hidden; \}/);
});

test("the sidebar has no fill of its own, so it sits on the desk", () => {
  const sidebar = rule(".sidebar {");
  assert.match(sidebar, /background: transparent;/);
  // No hairline: the card's rounded corner does the separating.
  assert.equal(/border-right/.test(sidebar), false);
});

test("the content is a card with all four corners", () => {
  const main = rule("main {");
  assert.match(main, /background: var\(--pane-bg\)/);
  assert.match(main, /background-clip: padding-box/);
  // The border is the desk showing through: it is what makes the corners read.
  assert.match(main, /border: 8px solid var\(--canvas\)/);
  assert.match(main, /border-radius: 24px/);
});

test("the card scrolls its own content", () => {
  const main = rule("main {");
  // DSH keeps the frame fixed and lets panels scroll; a page-scrolling card
  // loses its right corners under the window's scrollbar.
  assert.match(main, /overflow-y: auto/);
  assert.match(main, /height: 100vh/);
});

test("the card has its own thin scrollbar", () => {
  assert.match(CSS, /main::-webkit-scrollbar \{ width: 10px; \}/);
  assert.match(CSS, /main::-webkit-scrollbar-thumb \{[\s\S]*?background-clip: padding-box/);
});

test("the card and the desk are distinct surfaces", () => {
  const pane = token("--pane-bg");
  const canvas = token("--canvas");
  assert.equal(pane.length, 2);
  assert.notEqual(pane[0], canvas[0], "light: card differs from desk");
  assert.notEqual(pane[1], canvas[1], "dark: card differs from desk");
});

test("views carry their own bottom spacing now that main is the scroll box", () => {
  const view = rule(".view {");
  assert.match(view, /padding: 42px 42px 56px/);
});
