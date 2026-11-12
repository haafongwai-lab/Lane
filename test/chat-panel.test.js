import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The 问答 panel's risk controls.
 *
 * It speaks to the local gateway as a plain client, so the upstream sees the
 * same account, session and request shape as a coding agent. What it must not
 * become is a burst of tiny probes: those are what a risk model reads as a
 * script rather than a person. The safeguards are pinned here so a later edit
 * cannot quietly drop them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");

const APP = read("desktop/app.js");
const MAIN = read("desktop/main.js");
const PRELOAD = read("desktop/preload.cjs");
const HTML = read("desktop/index.html");
const SERVER = read("src/server.js");

test("the panel exists in the shell and its own nav entry", () => {
  assert.match(HTML, /<section class="view" id="view-chat">/);
  assert.match(HTML, /data-view="chat"/);
  assert.match(HTML, /id="chat-input"/);
  assert.match(HTML, /id="chat-send"/);
});

test("the renderer cannot reach the gateway itself; it goes through IPC", () => {
  // CSP is default-src 'self', so the call must be an IPC bridge, not fetch.
  assert.match(HTML, /default-src 'self'/);
  assert.match(PRELOAD, /consoleChat: \(request\) => ipcRenderer\.invoke\("lane:console-chat"/);
  assert.match(PRELOAD, /onConsoleDelta:/);
  // The renderer never addresses the gateway directly.
  assert.equal(/fetch\(\s*[`"']http/.test(APP), false, "no direct fetch to a URL in the renderer");
});

test("one request at a time, and no retry", () => {
  assert.match(MAIN, /let consoleBusy = false/);
  assert.match(MAIN, /if \(consoleBusy\) return \{ ok: false, error: "上一条还在回答，请稍候" \}/);
  // A retry loop is the behaviour most likely to be flagged; there is none.
  assert.equal(/for \(let attempt/.test(MAIN), false);
  assert.equal(/retry/i.test(MAIN.slice(MAIN.indexOf("lane:console-chat"), MAIN.indexOf("lane:console-cancel"))), false);
});

test("it marks the request as Lane's own, and never forwards that marker", () => {
  assert.match(MAIN, /"x-lane-client": "lane"/);
  // The gateway turns the marker into a journal source; providers build their
  // own outbound headers, so this cannot reach an upstream.
  assert.match(SERVER, /function isLaneConsole\(req\)/);
  assert.match(SERVER, /isLaneConsole\(req\) \? "lane"/);
});

test("the answer length is capped and the cadence is throttled", () => {
  // The cap must be room for a full answer: 1024 tokens truncated Chinese
  // mid-sentence, which read as "the model stopped halfway".
  assert.match(MAIN, /const cap = Math\.min\(Math\.max\(Number\(maxTokens\) \|\| 8192, 256\), 16384\)/);
  assert.match(APP, /const CHAT_MAX_TOKENS = 8192/);
  assert.match(APP, /const CHAT_MIN_GAP_MS = 2000/);
  assert.match(APP, /if \(since < CHAT_MIN_GAP_MS\)/);
});

test("a truncated answer says so, and a dropped stream tail is not lost", () => {
  // finish_reason "length" travels back so the panel can tell the user.
  assert.match(MAIN, /truncated: lastFinish === "length"/);
  assert.match(APP, /result\.truncated/);
  // The last SSE frame may arrive without its blank-line terminator.
  assert.match(MAIN, /if \(buffer\.trim\(\)\) handleFrame\(buffer\.replace\(\/\\r\\n\/g, "\\n"\)\)/);
});

test("the model list is the enabled allowlist, not every upstream model", () => {
  // snapshot.models is the agent-facing list (added models only).
  assert.match(APP, /return \(snapshot\?\.models \|\| \[\]\)\.filter/);
});

test("a failed turn is not carried into the next question", () => {
  const at = APP.indexOf("async function sendChat");
  const body = APP.slice(at, APP.indexOf("$(\"#chat-send\")", at));
  assert.match(body, /if \(result\?\.ok\)/);
  assert.match(body, /chatHistory\.push/, "context grows only on success");
  assert.match(body, /answer\.classList\.add\("error"\)/, "a failure is shown, not silently retried");
});
