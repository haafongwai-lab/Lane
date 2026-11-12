import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The composer stays put at the bottom of the window.
 *
 * It is a sticky box, and a sticky box stops at its containing block's bottom
 * edge. `main` carries 56px of bottom padding for every other view, so at the
 * very bottom of the scroll the dock was lifted by exactly that much — measured
 * as `gapBelowDock: 56` before the fix, `0` after.
 *
 * The fix gives the page's bottom edge to the chat view only while it is open:
 * a body class, so the other views keep their own padding.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const APP = read("desktop/app.js");
const CSS = read("desktop/styles.css");

test("the chat view drops the page's bottom padding while it is open", () => {
  assert.match(CSS, /body\.view-chat main \{ padding-bottom: 0; \}/);
  assert.match(CSS, /body\.view-chat #view-chat \{ padding-bottom: 0; \}/);
  // The shell's floor accounts for the view's own top padding, not main's.
  assert.match(CSS, /body\.view-chat \.chat-shell \{ min-height: calc\(100vh - 42px\); \}/);
});

test("the body class follows the active view", () => {
  assert.match(APP, /document\.body\.classList\.toggle\("view-chat", view === "chat"\)/);
  // It is set in go(), which every navigation passes through.
  const at = APP.indexOf("function go(view)");
  const body = APP.slice(at, APP.indexOf("\n}", at));
  assert.match(body, /view-chat/);
});

test("the dock is still sticky to the bottom", () => {
  const rule = CSS.slice(CSS.indexOf(".chat-dock {"), CSS.indexOf("}", CSS.indexOf(".chat-dock {")));
  assert.match(rule, /position: sticky/);
  assert.match(rule, /bottom: 0/);
});
