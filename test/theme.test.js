import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Theme foundation: theme.js applies the saved choice before the stylesheet,
 * the settings page offers light / dark / follow-system, and the main process
 * mirrors it onto the native window chrome. Component polish comes later, so
 * these pin the contract rather than every colour.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const THEME = fs.readFileSync(path.join(ROOT, "desktop/theme.js"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "desktop/app.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "desktop/index.html"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "desktop/styles.css"), "utf8");
const PRELOAD = fs.readFileSync(path.join(ROOT, "desktop/preload.cjs"), "utf8");
const MAIN = fs.readFileSync(path.join(ROOT, "desktop/main.js"), "utf8");

function boot(saved, systemDark) {
  const root = { dataset: {} };
  const window = { matchMedia: () => ({ matches: systemDark }) };
  const localStorage = { getItem: () => saved };
  new Function("document", "window", "localStorage", THEME)(
    { documentElement: root }, window, localStorage
  );
  return root.dataset;
}

test("theme.js resolves the three modes before CSS loads", () => {
  assert.deepEqual(boot("dark", false), { theme: "dark", themeMode: "dark" });
  assert.deepEqual(boot("light", true), { theme: "light", themeMode: "light" });
  assert.deepEqual(boot("system", true), { theme: "dark", themeMode: "system" });
  assert.deepEqual(boot("system", false), { theme: "light", themeMode: "system" });
  // A missing or corrupt preference falls back to following the system.
  assert.deepEqual(boot(null, true), { theme: "dark", themeMode: "system" });
  assert.deepEqual(boot("nonsense", false), { theme: "light", themeMode: "system" });
});

test("theme.js is a plain script in the head, before the stylesheet", () => {
  const head = HTML.slice(0, HTML.indexOf("</head>"));
  const scriptAt = head.indexOf('<script src="theme.js"></script>');
  const cssAt = head.indexOf('<link rel="stylesheet" href="styles.css">');
  assert.ok(scriptAt >= 0, "theme.js is referenced");
  assert.ok(cssAt > scriptAt, "theme.js runs before styles.css");
  assert.match(head, /Content-Security-Policy[^>]*script-src 'self'/, "CSP still blocks inline scripts");
});

test("the settings page offers all three choices", () => {
  const seg = HTML.slice(HTML.indexOf('id="theme-seg"'), HTML.indexOf("</div>", HTML.indexOf('id="theme-seg"')));
  for (const mode of ["light", "dark", "system"]) {
    assert.match(seg, new RegExp(`data-theme-mode="${mode}"`), mode);
  }
  assert.match(seg, /跟随系统/);
});

test("the renderer switches live, persists and follows the system", () => {
  assert.match(APP, /const THEME_MODES = \["light", "dark", "system"\]/);
  assert.match(APP, /localStorage\.getItem\("lane\.themeMode"\)/);
  assert.match(APP, /localStorage\.setItem\("lane\.themeMode"/);
  assert.match(APP, /\$\("#theme-seg"\)\.addEventListener\("click"/);
  assert.match(APP, /systemTheme\.addEventListener\("change"/);
  assert.match(APP, /document\.documentElement\.dataset\.theme = resolvedTheme\(\)/);
  assert.match(PRELOAD, /setTheme: \(mode\) => ipcRenderer\.invoke\("lane:set-theme"/);
});

test("the main process mirrors the choice onto native chrome", () => {
  assert.match(MAIN, /nativeTheme\.themeSource = next/);
  assert.match(MAIN, /handleIpc\("lane:set-theme"/);
  assert.match(MAIN, /nativeTheme\.on\("updated"/);
  assert.match(MAIN, /backgroundColor: nativeTheme\.shouldUseDarkColors/);
});

test("the palette defines dark values for every base surface token", () => {
  const block = CSS.slice(CSS.indexOf(':root[data-theme="dark"]'), CSS.indexOf("* { box-sizing"));
  for (const token of ["--canvas", "--sidebar", "--surface", "--surface-raised", "--ink", "--ink-soft", "--muted", "--faint", "--line", "--line-soft", "--green", "--red", "--blue", "--panel-bg", "--glass", "--recess", "--shadow"]) {
    assert.ok(block.includes(`${token}:`), `dark palette carries ${token}`);
  }
  assert.match(block, /--canvas: #151517/);
  // The sidebar is the window's own colour, so it follows --canvas exactly.
  assert.match(block, /--sidebar-bg: #151517/);
  // The pane is the raised sheet the rounded corners are cut out of.
  assert.ok(block.includes("--pane-bg:"), "dark palette carries --pane-bg");
  assert.match(block, /--surface-raised: #353638/);
  assert.match(block, /--ink: #f9fafb/);
  assert.match(block, /--green: #22c55e/);
  assert.match(block, /--link: #7aaaff/);
});

test("component surfaces use the tokens instead of literal light colours", () => {
  // The phase-2 sweep: these are the places that stayed a glaring white or
  // grey block in dark mode when they kept a literal colour.
  assert.match(CSS, /\.model-head \{[^}]*background: var\(--glass\)/);
  assert.match(CSS, /\.mcp-editor \{[^}]*background: var\(--recess\)/);
  assert.match(CSS, /\.mcp-json textarea \{[^}]*background: var\(--surface-raised\)/);
  assert.match(CSS, /\.recent-state\.live \{ color: var\(--blue\)/);
  // The account list no longer highlights a "primary" row: a request goes to
  // whichever account owns its model, so there is no chosen account to mark.
  assert.doesNotMatch(CSS, /\.account-row\.active/);
  // The model rows sit inside a panel, so in dark mode they stay transparent
  // and only lift on hover — the same surface the usage and account lists use.
  assert.match(CSS, /:root\[data-theme="dark"\] \.models-panel \.model-row \{ background: transparent; \}/);
  assert.match(CSS, /:root\[data-theme="dark"\] \.models-panel \.model-row:hover \{ background: #ffffff14; \}/);
});
