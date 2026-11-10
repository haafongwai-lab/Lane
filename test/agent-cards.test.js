import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent cards used to be hand-written with three different labels
 * ("模型" / "模式" / "方式") and two different second rows ("网关" / "配置"),
 * and Codex's "Hy3 · WorkBuddy" was a hard-coded model name that never
 * changed with the account. Pin the uniform shape and that every value now
 * comes from the status snapshot.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const HTML = fs.readFileSync(path.join(ROOT, "desktop/index.html"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "desktop/app.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "desktop/styles.css"), "utf8");
const CONTROL = fs.readFileSync(path.join(ROOT, "src/control-center.js"), "utf8");

function cards() {
  const grid = HTML.slice(HTML.indexOf('<div class="agent-grid">'), HTML.indexOf("</section>", HTML.indexOf('<div class="agent-grid">')));
  return grid.split('<article class="agent-card">').slice(1).map((chunk) => chunk.split("</article>")[0]);
}

test("all five cards use the same two detail rows", () => {
  const list = cards();
  assert.equal(list.length, 5, "five agent cards");
  for (const [i, card] of list.entries()) {
    const labels = [...card.matchAll(/<div class="agent-detail"><span>([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(labels, ["接入方式", "网关"], `card ${i + 1} labels`);
    assert.match(card, /<code id="[a-z-]+-address">/, `card ${i + 1} has a dynamic gateway address`);
    assert.match(card, /<code class="agent-path" id="[a-z-]+-path"><\/code>/, `card ${i + 1} has a dynamic config path`);
  }
});

test("no hard-coded model, mode or path is left in the cards", () => {
  const grid = HTML.slice(HTML.indexOf('<div class="agent-grid">'), HTML.indexOf("</section>", HTML.indexOf('<div class="agent-grid">')));
  assert.doesNotMatch(grid, /Hy3 · WorkBuddy/);
  assert.doesNotMatch(grid, /3p Gateway Profile/);
  assert.doesNotMatch(grid, /<span>模型<\/span>|<span>模式<\/span>|<span>方式<\/span>|<span>配置<\/span>/);
  assert.doesNotMatch(grid, /~\/\.(zcode|dsh)\//, "no made-up config paths");
});

test("every address and every config path is filled from the status snapshot", () => {
  for (const id of ["codex", "claude", "zcode", "vscode", "dsh"]) {
    assert.match(APP, new RegExp(`\\$\\("#${id}-address"\\)\\.textContent`), `${id} address is dynamic`);
    assert.match(APP, new RegExp(`setAgentPath\\("${id}-path"`), `${id} path is dynamic`);
  }
  for (const [rendererField, sourceField] of [
    ["agents?.codex?.configPath", "configPath: codexConfigPath(env)"],
    ["agents?.claudeDesktop?.modeConfig", "modeConfig: claudePaths(env).modeConfig"],
    ["agents?.zcode?.configPath", "configPath: zcodePaths(env).config"],
    ["agents?.vscode?.configPath", "configPath: vscodePaths(env).models"],
    ["agents?.dsh?.configPath", "configPath: dshPatchPath(env)"]
  ]) {
    assert.ok(APP.includes(rendererField), `renderer reads ${rendererField}`);
    assert.ok(CONTROL.includes(sourceField), `the status snapshot carries ${sourceField}`);
  }
});

test("a long path stays on one ellipsised line", () => {
  const rule = CSS.slice(CSS.indexOf(".agent-path {"), CSS.indexOf(".agent-path {") + 260);
  assert.match(rule, /display: block/);
  assert.match(rule, /text-overflow: ellipsis/);
  assert.match(rule, /white-space: nowrap/);
});
