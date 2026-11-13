import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The window's titlebar is drawn by the page, in the desk colour.
 *
 * Windows' own titlebar met Lane's #f2f1ed / #151517 at a seam across the top
 * of the window, which broke the "one surface" reading. Electron's
 * `titleBarOverlay` paints that strip, but its buttons live in a DWM layer no
 * capture API can see - so there was no way to prove a user still had a close
 * button. A frameless window with three buttons the page draws removes the
 * doubt: what is written here is what ships, at any DPI, in any theme.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, "..", "desktop", "styles.css"), "utf8");
const MAIN = fs.readFileSync(path.join(HERE, "..", "desktop", "main.js"), "utf8");
const HTML = fs.readFileSync(path.join(HERE, "..", "desktop", "index.html"), "utf8");
const PRELOAD = fs.readFileSync(path.join(HERE, "..", "desktop", "preload.cjs"), "utf8");

const rule = (selector) => {
  const at = CSS.indexOf(`\n${selector}`);
  if (at < 0) return "";
  const from = at + 1;
  return CSS.slice(from, CSS.indexOf("}", from) + 1);
};

test("the window is frameless on Windows only", () => {
  assert.match(MAIN, /process\.platform === "win32" \? \{ frame: false, thickFrame: true \} : \{\}/);
  // The OS overlay is gone: its buttons could not be verified.
  assert.equal(/titleBarOverlay:/.test(MAIN), false, "no DWM overlay");
});

test("the page draws the titlebar in the desk colour", () => {
  const tb = rule(".titlebar {");
  assert.match(tb, /position: fixed/);
  assert.match(tb, /height: var\(--titlebar-h, 40px\)/);
  assert.match(tb, /background: var\(--canvas\)/);
  assert.match(tb, /-webkit-app-region: drag/);
  // Only where the OS titlebar is gone.
  assert.match(CSS, /\[data-platform="win32"\] \.titlebar \{ display: flex; \}/);
});

test("it carries the three window buttons, and only those", () => {
  const actions = [...HTML.matchAll(/data-win-action="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(actions, ["minimize", "toggle-maximize", "close"]);
  // The buttons must not be drag regions, or they would not receive clicks.
  assert.match(CSS, /\.titlebar-buttons \{[^}]*-webkit-app-region: no-drag/);
});

test("the renderer can drive the window, through a narrow channel", () => {
  assert.match(PRELOAD, /windowAction: \(action\) => ipcRenderer\.invoke\("lane:window-action", action\)/);
  assert.match(MAIN, /handleIpc\("lane:window-action"/);
  // Exactly three actions: no generic BrowserWindow access from the page.
  assert.match(MAIN, /action === "minimize"/);
  assert.match(MAIN, /action === "toggle-maximize"/);
  assert.match(MAIN, /action === "close"/);
});

test("maximise is done by hand so it cannot overrun the desktop", () => {
  // The OS maximises a frameless window eight pixels past every edge (measured
  // 1552x832 at -7,-7 on a 1536x816 desktop), and a maximised window ignores
  // setBounds, so it cannot be corrected afterwards.
  assert.match(MAIN, /function maximizeToWorkArea\(\)/);
  assert.match(MAIN, /window\.setBounds\(display\.workArea\)/);
  assert.match(MAIN, /winRestoreBounds = from/);
  assert.match(MAIN, /window\.setMaximizable\(false\)/);
  assert.equal(/window\.maximize\(\)/.test(MAIN), false, "no system maximise");
});

test("the maximise glyph reflects the state", () => {
  assert.match(CSS, /\[data-maximized\] \.titlebar-btn \.icon-restore \{ display: block; \}/);
  assert.match(CSS, /\[data-maximized\] \.titlebar-btn \.icon-max \{ display: none; \}/);
});

test("the page reserves the strip on Windows", () => {
  assert.match(CSS, /\[data-platform="win32"\] \{ --titlebar-h: 40px; \}/);
  assert.match(CSS, /\[data-platform="win32"\] body \{ padding-top: var\(--titlebar-h\); \}/);
  assert.match(CSS, /\[data-platform="win32"\] \.sidebar \{ inset: var\(--titlebar-h\) auto 0 0; \}/);
  assert.match(CSS, /\[data-platform="win32"\] main \{ height: calc\(100vh - var\(--titlebar-h\)\); \}/);
});

test("the renderer learns its platform", () => {
  assert.match(MAIN, /document\.documentElement\.dataset\.platform = \$\{JSON\.stringify\(process\.platform\)\}/);
});
