import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Three fixes on the 问答 module, plus the 128k limits.
 *
 * A1  The slider's stops come from the selected model's own reasoning levels.
 *     They differ across the pool (hy4free offers only "high", qoder offers
 *     low/medium/xhigh), so a fixed five-stop slider could send a level the
 *     upstream rejects outright.
 * A2  Trimming the carried context is announced, never silent — an answer that
 *     cannot resolve "it" is confusing unless the user knows the early turns
 *     went.
 * A3  A stopped answer keeps what it already said, so "continue" has context.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const APP = read("desktop/app.js");
const MAIN = read("desktop/main.js");
const PREFS = read("src/console-prefs.js");

test("A1: the effort stops follow the selected model's own levels", () => {
  assert.match(APP, /function chatEffortLevels\(\)/);
  // Read from the model's advertised efforts, with 自动 always first.
  assert.match(APP, /Array\.isArray\(model\?\.efforts\) \? model\.efforts\.filter/);
  assert.match(APP, /const stops = \[CHAT_EFFORT_AUTO\]/);
  // The old fixed list is gone.
  assert.equal(/const CHAT_EFFORT_LEVELS = \[/.test(APP), false, "no hardcoded five-stop list");
  // A model with no levels of its own has nothing to drag.
  assert.match(APP, /range\.disabled = levels\.length < 2/);
  // Switching models rebuilds the slider.
  assert.match(APP, /renderChatEffort\(\);\s*\n\s*\$\("#chat-input"\)\?\.focus\(\);/);
});

test("A2: trimming the context is announced", () => {
  assert.match(APP, /function chatTrimHistory\(\{ notify = false \} = \{\}\)/);
  assert.match(APP, /if \(notify\) toast\(`已丢弃最早的/);
  // Both the success and the stopped path pass notify.
  assert.equal((APP.match(/chatTrimHistory\(\{ notify: true \}\)/g) || []).length >= 2, true);
});

test("A3: a stopped answer keeps what it already said", () => {
  assert.match(APP, /const partial = streamed \|\| reasoned;/);
  assert.match(APP, /if \(partial\) \{/);
  assert.match(APP, /chatHistory\.push\(\{ role: "user", content: text \}, \{ role: "assistant", content: partial \}\)/);
});

test("both limits are 128k", () => {
  assert.match(APP, /const CHAT_MAX_TOKENS = 131072;/);
  assert.match(APP, /const CHAT_CONTEXT_TOKEN_CEILING = 131072;/);
  assert.match(MAIN, /Number\(maxTokens\) \|\| 131072, 256\), 131072/);
  assert.match(MAIN, /const tokenBudget = prefs\?\.maxTokens \|\| 131_072/);
  assert.match(PREFS, /maxTokens: 131_072/);
  // 128k of context deserves more than ten turns.
  assert.match(PREFS, /historyTurns: 40/);
});
