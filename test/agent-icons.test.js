import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lane's own runs get a mark in the recent-request list.
 *
 * The other agents already carry their official icons there, so a Lane row was
 * the one row you had to read rather than recognise. Its mark is the robot line
 * drawing, on transparency — no plate behind it — and it is inverted on the dark
 * theme, where dark ink on a dark pill would otherwise disappear.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const APP = read("desktop/app.js");
const CSS = read("desktop/styles.css");

test("lane is in the agent icon table", () => {
  assert.match(APP, /lane: "assets\/lane-96\.png"/);
  assert.match(APP, /function agentIcon\(agent\)/);
});

test("the pill names the agent on the image, so the theme can target one", () => {
  assert.match(APP, /<img class="agent-mark" src="\$\{agentIcon\(item\.agent\)\}" data-agent="\$\{esc\(item\.agent\)\}" alt="">/);
});

test("the dark theme inverts lane's line drawing", () => {
  assert.match(CSS, /:root\[data-theme="dark"\] \.agent-pill \.agent-mark\[data-agent="lane"\] \{/);
  assert.match(CSS, /filter: invert\(1\)/);
});

test("the mark is sized with the others and has no plate", () => {
  const rule = CSS.slice(CSS.indexOf(".agent-pill .agent-mark {"), CSS.indexOf("}", CSS.indexOf(".agent-pill .agent-mark {")));
  assert.match(rule, /width: 13px/);
  assert.match(rule, /object-fit: contain/);
  // A transparent PNG: the drawing sits on the pill, not on a tile.
  assert.equal(/background/.test(rule), false, "no background plate");
});
