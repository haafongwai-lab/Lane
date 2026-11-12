import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePrefs, readConsolePrefs, writeConsolePrefs, DEFAULTS } from "../src/console-prefs.js";

/**
 * The 问答 panel's tool loop and its context budget.
 *
 * A tool loop is bounded here, not in the page: rounds, total tokens and
 * wall-clock time. And a conversation carries only the last few turns, trimmed
 * again by a token ceiling, so a long chat cannot quietly grow a request until
 * the model's window overflows.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(HERE, "..", rel), "utf8");
const MAIN = read("desktop/main.js");
const APP = read("desktop/app.js");

test("default budgets are 6 rounds, a token ceiling and a time ceiling", () => {
  assert.equal(DEFAULTS.maxRounds, 6);
  assert.equal(DEFAULTS.maxTokens, 24_000);
  assert.equal(DEFAULTS.maxDurationMs, 180_000);
  assert.equal(DEFAULTS.historyTurns, 10);
  assert.equal(DEFAULTS.mcpEnabled, false, "tools are opt-in");
});

test("prefs are clamped to sane ranges and dedupe server names", () => {
  const prefs = normalizePrefs({ maxRounds: 999, maxTokens: 1, mcpServers: ["a", "a", "", 5], mcpEnabled: "yes" });
  assert.equal(prefs.maxRounds, 12, "rounds clamped to 12");
  assert.equal(prefs.maxTokens, 1_000, "tokens clamped up to the floor");
  assert.deepEqual(prefs.mcpServers, ["a"]);
  assert.equal(prefs.mcpEnabled, false, "only an explicit true enables tools");
});

test("prefs round-trip through console.json", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-console-prefs-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, LANE_DATA_DIR: dir };
  const saved = await writeConsolePrefs({ mcpEnabled: true, mcpServers: ["github"], maxRounds: 4 }, env);
  assert.equal(saved.mcpEnabled, true);
  assert.deepEqual(saved.mcpServers, ["github"]);
  assert.equal(saved.maxRounds, 4);
  const readBack = await readConsolePrefs(env);
  assert.equal(readBack.maxRounds, 4);
  assert.equal(readBack.maxDurationMs, DEFAULTS.maxDurationMs, "untouched keys keep their default");
});

test("the tool loop enforces all three budgets", () => {
  assert.match(MAIN, /const rounds = prefs\?\.maxRounds \|\| 6/);
  assert.match(MAIN, /const tokenBudget = prefs\?\.maxTokens \|\| 24_000/);
  assert.match(MAIN, /const durationBudget = prefs\?\.maxDurationMs \|\| 180_000/);
  assert.match(MAIN, /for \(let round = 1; round <= rounds; round \+= 1\)/);
  assert.match(MAIN, /stopped: "rounds"/);
  assert.match(MAIN, /stopped: "tokens"/);
  assert.match(MAIN, /stopped: "time"/);
  // Sessions are closed however the loop ends, so no child leaks.
  assert.match(MAIN, /for \(const session of toolSet\.sessions\) \{ try \{ session\.close\(\); \} catch \{\} \}/);
});

test("tools are offered to the model and a tool result is fed back", () => {
  assert.match(MAIN, /body\.tools = toolSet\.defs/);
  assert.match(MAIN, /body\.tool_choice = "auto"/);
  assert.match(MAIN, /role: "tool",/);
  assert.match(MAIN, /tool_call_id:/);
});

test("the context is trimmed by turns and again by tokens", () => {
  assert.match(APP, /const CHAT_CONTEXT_TOKEN_CEILING = 6000/);
  assert.match(APP, /function chatTrimHistory\(\)/);
  assert.match(APP, /chatHistory = chatHistory\.slice\(-limit\)/);
  assert.match(APP, /function chatBuildMessages\(text\)/);
  // Drop the oldest pairs until the carried text fits the ceiling.
  assert.match(APP, /while \(hist\.length >= 2 && chars\(hist\) \+ chatRoughTokens\(text\) > CHAT_CONTEXT_TOKEN_CEILING\)/);
  assert.match(APP, /hist = hist\.slice\(2\)/);
});

test("the transcript has no scrollbar of its own; the composer is pinned", () => {
  const CSS = read("desktop/styles.css");
  assert.match(CSS, /\.chat-scroll \{[\s\S]*?overflow: visible/);
  assert.match(CSS, /\.chat-dock \{[\s\S]*?position: sticky/);
  // The eyebrow is gone from the shell.
  assert.equal(/自带问答/.test(read("desktop/index.html")), false);
});
