import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The window reads as one surface with a sheet on it.
 *
 * The sidebar used to be a shade darker than the canvas, so the window looked
 * like two panes meeting at a seam. It now takes the window colour exactly, and
 * the content is a raised sheet whose left edge is rounded. Measured in the
 * running app: light body rgb(242,241,237) = sidebar rgb(242,241,237), dark
 * rgb(21,21,23) both, and the pane computes to `20px 0px 0px 20px`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, "..", "desktop", "styles.css"), "utf8");

const rule = (selector) => {
  const at = CSS.indexOf(`\n${selector}`);
  if (at < 0) return "";
  const from = at + 1;
  return CSS.slice(from, CSS.indexOf("}", from) + 1);
};

const token = (name) => {
  const matches = [...CSS.matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());
  return matches;
};

test("the sidebar is the window's own colour in both themes", () => {
  // Light: canvas #f2f1ed, sidebar the same. Dark: #151517 both.
  assert.deepEqual(token("--canvas"), ["#f2f1ed", "#151517"]);
  assert.deepEqual(token("--sidebar-bg"), ["#f2f1ed", "#151517"]);
});

test("the content pane is its own token, distinct from the window", () => {
  assert.deepEqual(token("--pane-bg"), ["#fbfaf7", "#1b1b1c"]);
});

test("the pane is rounded on the left and flush on the right", () => {
  const main = rule("main {");
  assert.match(main, /background: var\(--pane-bg\)/);
  assert.match(main, /border-radius: var\(--radius-lg\) 0 0 var\(--radius-lg\)/);
  // No overflow:hidden — it would make main a scroll container and the chat
  // view's sticky bars would stop sticking.
  assert.equal(/overflow/.test(main), false);
});

test("the seam no longer carries a hairline", () => {
  const sidebar = rule(".sidebar {");
  assert.equal(/border-right/.test(sidebar), false);
});

test("the sticky bars fade to the pane, not the window", () => {
  // Both gradients sit inside main; on --canvas they would paint a band of the
  // window colour across the sheet.
  assert.match(CSS, /linear-gradient\(to bottom, var\(--pane-bg\) 60%, transparent\)/);
  assert.match(CSS, /linear-gradient\(to bottom, transparent, var\(--pane-bg\) 22px\)/);
});
