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

test("the level is a slider, the way ZCode renders it", () => {
  // ZCode uses a native range input over a drawn track, not a menu: its bundle
  // builds `input type:"range"` with one stop per level, a 24px track and a
  // 28px round thumb. This pins that shape.
  assert.match(HTML, /<input type="range" id="chat-effort-range"/);
  assert.match(HTML, /id="chat-effort-fill"/);
  assert.match(HTML, /id="chat-effort-stops"/);
  assert.match(HTML, /id="chat-effort-thumb"/);
  assert.equal(/chat-effort-menu/.test(HTML), false, "no dropdown remains");
  assert.equal(/chat-effort-button/.test(HTML), false, "no trigger button remains");
});

test("the slider geometry follows ZCode's own values", () => {
  const range = CSS.slice(CSS.indexOf(".chat-effort-range {"), CSS.indexOf("}", CSS.indexOf(".chat-effort-range {")));
  assert.match(range, /height: 32px/, "32px hit area");
  assert.match(range, /appearance: none/);
  // The native thumb is transparent; the visible one is drawn beneath it.
  assert.match(CSS, /\.chat-effort-range::-webkit-slider-thumb \{[\s\S]*?background: transparent/);
  const thumb = CSS.slice(CSS.indexOf(".chat-effort-thumb {"), CSS.indexOf("}", CSS.indexOf(".chat-effort-thumb {")));
  assert.match(thumb, /width: 28px/);
  assert.match(thumb, /border-radius: 50%/);
  assert.match(thumb, /transition: left \.12s ease-out/);
  const fill = CSS.slice(CSS.indexOf(".chat-effort-fill {"), CSS.indexOf("}", CSS.indexOf(".chat-effort-fill {")));
  assert.match(fill, /transition: width \.12s ease-out/);
  // The fill turns to the accent at the top level, like ZCode's.
  assert.match(CSS, /\.chat-effort-fill\[data-max="true"\] \{ background: var\(--chat-accent\); \}/);
});

test("dragging repaints live and saves on release", () => {
  assert.match(APP, /\$\("#chat-effort-range"\)\?\.addEventListener\("input"/);
  assert.match(APP, /\$\("#chat-effort-range"\)\?\.addEventListener\("change"/);
  assert.match(APP, /saveChatPrefs\(\{ effort: level\.value \}\)/);
  assert.match(APP, /CHAT_EFFORT_LEVELS/);
  // The thumb and fill are positioned from the level index.
  assert.match(APP, /const percent = last \? \(index \/ last\) \* 100 : 0/);
  assert.match(APP, /calc\(14px \+ \(100% - 28px\) \* /);
});
