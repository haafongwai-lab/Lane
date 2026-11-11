import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent page used to be a grid of four hand-written cards with three
 * different labels ("模型" / "模式" / "方式") and two different second rows,
 * and Codex's "Hy3 · WorkBuddy" was a hard-coded model name. It is now one
 * row per client: the marks read down a column, so "which of these is
 * connected" is answerable at a glance. Every value still comes from the
 * status snapshot.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const HTML = fs.readFileSync(path.join(ROOT, "desktop/index.html"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "desktop/app.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "desktop/styles.css"), "utf8");
const CONTROL = fs.readFileSync(path.join(ROOT, "src/control-center.js"), "utf8");

function rows() {
  const list = HTML.slice(HTML.indexOf('<div class="agent-list">'), HTML.indexOf("</section>", HTML.indexOf('<div class="agent-list">')));
  return list.split('<div class="agent-row">').slice(1).map((chunk) => chunk.split("</div>\n          </div>")[0]);
}

test("the agent page is a list, one row per client", () => {
  assert.doesNotMatch(HTML, /class="agent-card"/, "no cards left");
  assert.doesNotMatch(HTML, /class="agent-grid"/, "no card grid left");
  const list = rows();
  assert.equal(list.length, 5, "five clients");
});

test("every row carries the same cells and one state chip", () => {
  for (const [i, row] of rows().entries()) {
    // The row's icon cell has its own class: the route graph uses
    // `.agent-mark` for its stacked icon-plus-label, and sharing the name
    // made the row inherit that column layout.
    assert.match(row, /class="agent-mark-cell [a-z]+"/, `row ${i + 1} has a mark`);
    assert.match(row, /class="connection-state" id="[a-z]+-connect-state"/, `row ${i + 1} has a state chip`);
    // The head names the columns, so a row carries only values. A repeated
    // label inside every row was the noise the list was meant to remove.
    assert.doesNotMatch(row, /<div class="agent-field"><span>/, `row ${i + 1} repeats no column label`);
    assert.equal((row.match(/class="agent-field"/g) || []).length, 2, `row ${i + 1} has two fields`);
    assert.match(row, /<code id="[a-z]+-address">/, `row ${i + 1} has a dynamic gateway address`);
    assert.match(row, /<code class="agent-path" id="[a-z]+-path"><\/code>/, `row ${i + 1} has a dynamic config path`);
  }
});

test("no hard-coded model, mode or path is left in the list", () => {
  const list = HTML.slice(HTML.indexOf('<div class="agent-list">'), HTML.indexOf("</section>", HTML.indexOf('<div class="agent-list">')));
  assert.doesNotMatch(list, /Hy3 · WorkBuddy/);
  assert.doesNotMatch(list, /3p Gateway Profile/);
  assert.doesNotMatch(list, /<span>模型<\/span>|<span>模式<\/span>|<span>方式<\/span>|<span>配置<\/span>/);
  assert.doesNotMatch(list, /~\/\.(zcode|dsh)\//, "no made-up config paths");
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

test("the list's columns line up and a long path stays on one line", () => {
  // Head and rows share one track definition; a per-row max-content track
  // would let one long path widen its own row only.
  const head = CSS.slice(CSS.indexOf(".agent-list-head,"), CSS.indexOf(".agent-list-head {"));
  assert.match(head, /grid-template-columns/);
  const rowRule = CSS.slice(CSS.indexOf(".agent-row {"), CSS.indexOf(".agent-row:hover"));
  assert.match(rowRule, /grid-template-columns/);
  const pathRule = CSS.slice(CSS.indexOf(".agent-path {"), CSS.indexOf(".agent-path {") + 240);
  assert.match(pathRule, /text-overflow: ellipsis/);
  assert.match(pathRule, /white-space: nowrap/);
});

test("the state chip sits beside the name, not in a card corner", () => {
  const rule = CSS.slice(CSS.indexOf(".connection-state {"), CSS.indexOf(".connection-state.on"));
  assert.doesNotMatch(rule, /position: absolute/, "a chip in a row is not absolutely placed");
});

test("the row icon does not inherit the route graph's stacked mark", () => {
  // `.agent-mark` is the route graph's icon-plus-label column; reusing that
  // name for the row cell made it 42px wide with a stacked layout, which
  // shrank the Codex tile.
  const cell = CSS.slice(CSS.indexOf(".agent-mark-cell {"), CSS.indexOf(".agent-mark-cell {") + 200);
  assert.match(cell, /width: 38px/, "the cell has its own fixed box");
  assert.doesNotMatch(cell, /flex-direction: column/, "it is not a stacked column");
  const codex = CSS.slice(CSS.indexOf(".agent-mark-cell.codex img"), CSS.indexOf(".agent-mark-cell.codex img") + 200);
  assert.match(codex, /width: 40px/, "the Codex tile sits between the cell and the others' optical weight");
});
