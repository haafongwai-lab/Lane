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

test("the panel offers the level beside the model picker", () => {
  assert.match(HTML, /id="chat-effort"/);
  assert.match(HTML, /id="chat-effort-menu"/);
  for (const level of ["none", "low", "high"]) {
    assert.ok(HTML.includes(`data-effort="${level}"`), `${level} is offered`);
  }
  assert.ok(HTML.includes('data-effort=""'), "automatic is offered");
  assert.match(APP, /function renderChatEffort\(/);
  assert.match(APP, /saveChatPrefs\(\{ effort:/);
  assert.match(CSS, /\.chat-effort-option \{/);
});
