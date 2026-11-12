import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The three additions: what a turn cost, the two new local tools, and search
 * plus continue in the panel.
 *
 * The meta line reports the same numbers the journal records, so the panel and
 * the 积分花费 page cannot disagree. lane_skills and lane_settings are read-only
 * like the rest. Continue keeps the turn instead of replacing it — a long answer
 * cut at the token limit can be extended without losing what it already said.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const APP = read("desktop/app.js");
const MAIN = read("desktop/main.js");
const HTML = read("desktop/index.html");
const CSS = read("desktop/styles.css");
const TOOLS = read("src/console-tools.js");

test("a successful turn returns what it cost", () => {
  assert.match(MAIN, /meta: \{ model, tokens: totalTokens, prompt: prevInput, elapsedMs: Date\.now\(\) - started \}/);
  // Both exits carry it: the plain answer and a budget-stopped one.
  assert.equal((MAIN.match(/elapsedMs: Date\.now\(\) - started/g) || []).length >= 2, true);
});

test("the panel prints that meta under the answer", () => {
  assert.match(APP, /function chatMetaLine\(anchor, meta\)/);
  assert.match(APP, /chatMetaLine\(answer, result\.meta\)/);
  assert.match(CSS, /\.chat-meta \{/);
});

test("lane_skills and lane_settings are declared and read-only", () => {
  assert.match(TOOLS, /name: "lane_skills"/);
  assert.match(TOOLS, /name: "lane_settings"/);
  assert.match(TOOLS, /async lane_skills\(\)/);
  assert.match(TOOLS, /async lane_settings\(\)/);
  // The settings reader is injected, not reached through a method that does not
  // exist on the control centre.
  assert.match(TOOLS, /export function createLocalTools\(\{ control, settings = null \} = \{\}\)/);
  assert.match(MAIN, /settings: \(\) => readSettings\(\)/);
});

test("an MCP test lists the tool names, not only a count", () => {
  assert.match(TOOLS, /可用工具（\$\{result\.tools\.length\}）/);
});

test("the history panel is gone: this is a one-shot conversation", () => {
  assert.equal(/chat-history/.test(HTML), false, "no history markup");
  assert.equal(/chat-history/.test(APP), false, "no history logic");
  assert.equal(/consoleSessions/.test(APP), false, "no session bridge");
  assert.equal(/chat-history/.test(CSS), false, "no history styles");
});


test("a long answer can be continued without replacing it", () => {
  assert.match(APP, /more\.dataset\.chatAction = "continue"/);
  assert.match(APP, /action\.dataset\.chatAction === "continue"/);
  assert.match(APP, /继续，接着上面没说完的地方写/);
  // Continue sends a new turn; it must not drop the previous one the way retry
  // does.
  const from = APP.indexOf('action.dataset.chatAction === "continue"');
  const to = APP.indexOf('action.dataset.chatAction === "retry"');
  const branch = APP.slice(from, to);
  assert.equal(/chatHistory = chatHistory\.slice/.test(branch), false, "continue keeps the turn");
});
