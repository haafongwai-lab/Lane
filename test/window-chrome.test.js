import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The window keeps its OS frame, and `titleBarOverlay` paints the strip.
 *
 * This replaces a frameless window that drew its own three buttons. That route
 * had to fake maximise - the OS overruns a frameless window eight pixels past
 * every edge, and a maximised window ignores setBounds, so it had to be sized
 * by hand - and it had to redraw glyphs that never matched Windows. Keeping the
 * frame and the overlay gets all of it from the OS: correct maximise, correct
 * resize, the system's own buttons (which is the "same as Windows" the icons
 * were chasing), and the strip still takes the desk colour so the window reads
 * as one surface.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const CSS = read("desktop/styles.css");
const MAIN = read("desktop/main.js");
const HTML = read("desktop/index.html");

test("the window keeps its frame and paints the titlebar through the overlay", () => {
  assert.match(MAIN, /titleBarStyle: "hidden"/);
  assert.match(MAIN, /titleBarOverlay: \{ color: chrome\.color, symbolColor: chrome\.symbolColor, height: TITLEBAR_HEIGHT \}/);
  // Frameless is gone: it is what forced the manual maximise.
  assert.equal(/frame: false/.test(MAIN), false, "no frameless window");
});

test("maximise is the OS's, so it matches the desktop", () => {
  assert.match(MAIN, /if \(window\.isMaximized\(\)\) window\.unmaximize\(\)/);
  assert.match(MAIN, /else window\.maximize\(\)/);
  // The hand-rolled path must not come back.
  assert.equal(/maximizeToWorkArea/.test(MAIN), false, "no manual maximise");
  assert.equal(/setMaximizable\(false\)/.test(MAIN), false, "the system may maximise");
});

test("the titlebar and the desk share one colour, per theme", () => {
  assert.match(MAIN, /color: "#151517", symbolColor: "#f9fafb"/);
  assert.match(MAIN, /color: "#f2f1ed", symbolColor: "#0f1115"/);
  assert.match(MAIN, /backgroundColor: chrome\.color/);
});

test("a theme switch repaints the overlay", () => {
  assert.match(MAIN, /window\.setTitleBarOverlay\(\{ color: chrome\.color/);
  assert.match(MAIN, /try \{\s*\n\s*window\.setTitleBarOverlay/);
});

test("the page reserves the overlay strip on Windows", () => {
  assert.match(CSS, /\[data-platform="win32"\] \{ --titlebar-h: 40px; \}/);
  assert.match(CSS, /\[data-platform="win32"\] body \{ padding-top: var\(--titlebar-h\); \}/);
  assert.match(CSS, /\[data-platform="win32"\] \.sidebar \{ inset: var\(--titlebar-h\) auto 0 0; \}/);
  assert.match(CSS, /\[data-platform="win32"\] main \{ height: calc\(100vh - var\(--titlebar-h\)\); \}/);
});

test("the page no longer draws its own window buttons", () => {
  assert.equal(/titlebar-btn/.test(HTML), false, "no drawn buttons in markup");
  assert.equal(/data-win-action/.test(HTML), false, "no button wiring in markup");
  assert.equal(/titlebar-btn/.test(CSS), false, "no drawn-button styles");
});

test("the renderer learns its platform", () => {
  assert.match(MAIN, /document\.documentElement\.dataset\.platform = \$\{JSON\.stringify\(process\.platform\)\}/);
});
