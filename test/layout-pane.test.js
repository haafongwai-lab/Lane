import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The window is two zones, the way DeepSeek Harness builds it: a sidebar that
 * takes the window colour, and a content sheet laid on top with its left
 * corners rounded.
 *
 * DSH's own layout (dsh-client-ui-layout) is the reference for the shape:
 *
 *   .frame        padding-top: titlebar; background: sidebar fill
 *   .sidebarCol   background: sidebar fill; border-right: .5px
 *   .centerCol    background: bg-base; border-radius: 16px 0 0 0
 *
 * Lane has no titlebar — it keeps the system one — so the sheet runs the full
 * height and both left corners show, but the rest is the same: the sidebar is
 * the window surface, the content is the raised sheet, the seam is a half-pixel
 * hairline, and the radius is DSH's 16px.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, "..", "desktop", "styles.css"), "utf8");

const rule = (selector) => {
  const at = CSS.indexOf(`\n${selector}`);
  if (at < 0) return "";
  const from = at + 1;
  return CSS.slice(from, CSS.indexOf("}", from) + 1);
};

const token = (name) => [...CSS.matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());

test("the sidebar is the window colour in both themes", () => {
  assert.deepEqual(token("--canvas"), ["#f2f1ed", "#151517"]);
  assert.deepEqual(token("--sidebar-bg"), ["#f2f1ed", "#151517"]);
});

test("the content is a distinct raised sheet", () => {
  assert.deepEqual(token("--pane-bg"), ["#fbfaf7", "#1b1b1c"]);
  const main = rule("main {");
  assert.match(main, /background: var\(--pane-bg\)/);
});

test("the sheet has DSH's 16px radius on both left corners", () => {
  const main = rule("main {");
  // 16px is DSH's --dsh-windows-content-radius.
  assert.match(main, /border-radius: 16px 0 0 16px/);
});

test("the seam is a half-pixel hairline, as in DSH", () => {
  const sidebar = rule(".sidebar {");
  assert.match(sidebar, /border-right: \.5px solid var\(--sidebar-line\)/);
});

test("main is not a scroll container", () => {
  // overflow:hidden would make the chat view's sticky bars stop sticking.
  const main = rule("main {");
  assert.equal(/overflow/.test(main), false);
});
