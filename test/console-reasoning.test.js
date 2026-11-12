import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePrefs, DEFAULTS, EFFORTS } from "../src/console-prefs.js";

/**
 * Reasoning and the answer share one max_tokens.
 *
 * Measured against deepseek-v4.1-flash through the real gateway: the default
 * spent 84 reasoning tokens for a 62-character answer, `reasoning_effort:
 * "none"` spent 0, and a 64-token cap with low effort ended with
 * finish_reason "length", 126 characters of reasoning and an EMPTY answer —
 * exactly the "the model produced no text" the panel used to show.
 *
 * So there are two remedies, and both are pinned here: the level is
 * controllable (自动 / 不思考 / 轻度 / 中度 / 深度), and a round that spends the
 * whole budget on reasoning is retried once with reasoning off.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const MAIN = read("desktop/main.js");
const APP = read("desktop/app.js");
const HTML = read("desktop/index.html");
const CSS = read("desktop/styles.css");

test("the reasoning level is a stored preference with a safe default", () => {
  assert.equal(DEFAULTS.effort, "", "automatic by default: send nothing");
  assert.deepEqual(EFFORTS, ["", "none", "low", "medium", "high"]);
  assert.equal(normalizePrefs({ effort: "none" }).effort, "none");
  assert.equal(normalizePrefs({ effort: "bogus" }).effort, "", "an unknown level falls back to automatic");
});

test("the chosen level rides on every request to the gateway", () => {
  assert.match(MAIN, /const effort = prefs\?\.effort === undefined \? "" : String\(prefs\.effort \|\| ""\)/);
  assert.match(MAIN, /\.\.\.\(level \? \{ reasoning_effort: level \} : \{\}\)/);
});

test("a round that thinks through its whole budget is retried without reasoning", () => {
  // The signature of the failure: length-limited, no text, no tool call.
  assert.match(MAIN, /if \(!out\.text && !out\.calls\.length && out\.finish === "length" && effort !== "none"\)/);
  assert.match(MAIN, /const retry = await send\(true, body, "none"\)/);
  // The retry's result replaces the empty one, and the user is told why.
  assert.match(MAIN, /if \(second\.text \|\| second\.calls\.length\) out = second/);
  assert.match(MAIN, /思考占满了输出预算，已关闭思考重试/);
});

test("the level control follows dsh-effort-switcher's shape", () => {
  // That plugin is the reference this was asked to match: a trigger naming the
  // level, and a frosted panel above it with a gradient slider.
  assert.match(HTML, /id="chat-effort-button"/);
  assert.match(HTML, /id="chat-effort-panel"/);
  assert.match(HTML, /<input type="range" id="chat-effort-range"/);
  assert.match(HTML, /id="chat-effort-knob"/);
  assert.match(HTML, /id="chat-effort-ticks"/);
  assert.match(HTML, /class="chat-effort-bloom"/);
});

test("the slider geometry and colour are the reference's own", () => {
  // 26px rail at 13px radius, 30px knob between 15px insets, 4px ticks, a
  // #4c8dff fill blooming blue→violet at the top level over .315s.
  const rail = CSS.slice(CSS.indexOf(".chat-effort-rail {"), CSS.indexOf("}", CSS.indexOf(".chat-effort-rail {")));
  assert.match(rail, /height: 26px/);
  assert.match(CSS, /\.chat-effort-groove \{[\s\S]*?border-radius: 13px/);
  const knob = CSS.slice(CSS.indexOf(".chat-effort-knob {"), CSS.indexOf("}", CSS.indexOf(".chat-effort-knob {")));
  assert.match(knob, /width: 30px/);
  assert.match(knob, /transition: left \.315s ease/);
  assert.match(CSS, /\.chat-effort-fill \{[\s\S]*?background: #4c8dff/);
  assert.match(CSS, /\.chat-effort-bloom \{[\s\S]*?linear-gradient\(90deg, #4c8dff 0%, #7b6cff 52%, #b56bff 100%\)/);
  assert.match(CSS, /\.chat-effort-fill\.max \.chat-effort-bloom \{ opacity: 1; \}/);
  assert.match(CSS, /\.chat-effort-tick \{[\s\S]*?rgba\(255, 255, 255, \.38\)/);
});

test("the panel is frosted and the native input is invisible", () => {
  assert.match(CSS, /\.chat-effort-panel \{[\s\S]*?backdrop-filter: blur\(40px\) saturate\(150%\)/);
  assert.match(CSS, /\.chat-effort-range::-webkit-slider-thumb \{[\s\S]*?background: transparent/);
  assert.match(CSS, /\.chat-effort-range \{[\s\S]*?height: 38px/);
});

test("dragging moves a draft and only release saves", () => {
  assert.match(APP, /function chatEffortPaint\(index\)/);
  // The input handler repaints only; the change handler is the one that saves.
  assert.match(APP, /\$\("#chat-effort-range"\)\?\.addEventListener\("input", \(event\) => \{\s*chatEffortPaint\(Number\(event\.target\.value\) \|\| 0\);/);
  assert.match(APP, /\$\("#chat-effort-range"\)\?\.addEventListener\("change"/);
  assert.match(APP, /saveChatPrefs\(\{ effort: level\.value \}\)/);
  // Opening repaints from the saved level, so an abandoned draft never shows.
  assert.match(APP, /if \(open\) chatEffortPaint\(chatEffortIndex\(\)\)/);
});
