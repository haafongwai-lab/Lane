import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The layout regression that turned answers into vertical text.
 *
 * `.chat-msg` was a flex ROW with one child, which was harmless until the
 * reasoning block, the action row and the truncation note became siblings of
 * the answer: a row laid them out side by side, squeezing the text into a strip
 * that wrapped one character per line. A message is a column; alignment, not
 * justification, is what pushes the user's bubble right.
 *
 * The table had the same shape of problem from the other side: squeezed into a
 * narrow container it broke short headers like 「票价」 into single characters.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const CSS = read("desktop/styles.css");

test("a message is a column, so its parts stack instead of sitting side by side", () => {
  const rule = CSS.slice(CSS.indexOf(".chat-msg {"), CSS.indexOf("}", CSS.indexOf(".chat-msg {")));
  assert.match(rule, /flex-direction: column/);
  assert.match(rule, /min-width: 0/);
});

test("the user's bubble is pushed right by alignment, not justification", () => {
  assert.match(CSS, /\.chat-msg\.user \{ align-items: flex-end; \}/);
  assert.match(CSS, /\.chat-msg\.assistant \{ align-items: stretch; \}/);
  // The old row-era rules are gone.
  assert.equal(/\.chat-msg \{ display: flex; \}/.test(CSS), false, "no bare flex row");
  assert.equal(/\.chat-msg\.user \{ justify-content: flex-end; \}/.test(CSS), false, "no justification on a column");
});

test("the action row and the stop note hug the answer's left edge", () => {
  const actions = CSS.slice(CSS.indexOf(".chat-actions {"), CSS.indexOf("}", CSS.indexOf(".chat-actions {")));
  assert.match(actions, /align-self: flex-start/);
  const note = CSS.slice(CSS.indexOf(".chat-truncated {"), CSS.indexOf("}", CSS.indexOf(".chat-truncated {")));
  assert.match(note, /align-self: flex-start/);
});

test("a table keeps its natural width instead of breaking headers", () => {
  const table = CSS.slice(CSS.indexOf(".chat-text table {"), CSS.indexOf("}", CSS.indexOf(".chat-text table {")));
  assert.match(table, /min-width: max-content/);
  const cell = CSS.slice(CSS.indexOf(".chat-text td {"), CSS.indexOf("}", CSS.indexOf(".chat-text td {")));
  assert.match(cell, /min-width: 4\.5em/);
});
