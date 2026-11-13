import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The empty transcript is the Lane mark, and the 工具 sheet is a grouped panel
 * with real switches.
 *
 * The mark has to survive every path that rebuilds the transcript — entering the
 * page, clearing, a new session, opening a saved one, and the "no model" state —
 * and it must not take the floating 回到底部 button with it, since that lives in
 * the same container.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const APP = read("desktop/app.js");
const HTML = read("desktop/index.html");
const CSS = read("desktop/styles.css");

test("the empty state is the Lane mark, not a paragraph", () => {
  assert.match(HTML, /class="chat-empty-wordmark"[^>]*>Lane</);
  assert.match(APP, /function chatEmptyNode\(message = ""\)/);
  assert.match(APP, /mark\.textContent = "Lane"/);
  // The artistic word: italic serif at 64px, quiet, no image asset.
  assert.match(CSS, /\.chat-empty-wordmark \{[\s\S]*?font-style: italic/);
  assert.match(CSS, /\.chat-empty-wordmark \{[\s\S]*?font-size: 64px/);
  assert.equal(/chat-empty-mark/.test(HTML), false, "the icon is gone");
});

test("every rebuild of the transcript uses that mark", () => {
  // Entering with no model, clearing, a new session, and an empty saved session
  // all go through the one helper.
  const uses = (APP.match(/chatEmptyNode\(/g) || []).length;
  assert.ok(uses >= 3, `expected several uses, saw ${uses}`);
  assert.equal(/直接问一句/.test(HTML), false, "the old heading is gone from the shell");
});

test("rebuilding the empty state keeps the floating button", () => {
  // `chatResetEmpty` removes only messages and the old empty block, so the
  // button that also lives inside #chat-log survives.
  assert.match(APP, /function chatResetEmpty\(message = ""\)/);
  assert.match(APP, /chatClearLog\(\);\s*\n\s*log\.append\(chatEmptyNode\(message\)\)/);
  assert.equal(/log\.replaceChildren\(chatEmptyNode/.test(APP), false, "no wholesale replace of the log");
  assert.match(APP, /\[\.\.\.log\.querySelectorAll\("\.chat-msg, \.chat-empty"\)\]/);
});

test("the 工具 sheet is grouped, titled, and uses drawn switches", () => {
  assert.match(HTML, /class="chat-menu-group-title">本地工具/);
  assert.match(HTML, /class="chat-menu-group-title">本地/);
  assert.match(HTML, /class="chat-menu-group-title">/);
  // No footnote at the bottom of the sheet.
  assert.equal(/chat-mcp-note/.test(HTML), false);
  // Two real checkboxes with a drawn track beside each.
  assert.equal((HTML.match(/class="chat-menu-check"/g) || []).length >= 2, true);
  assert.equal((HTML.match(/class="chat-menu-track"/g) || []).length >= 2, true);
  // DSH's geometry, on Lane's accent: the switch must be the same blue as the
  // send button, which is the one control it sits near.
  assert.match(CSS, /\.chat-menu-track \{[\s\S]*?width: 32px; height: 18px/);
  assert.match(CSS, /\.chat-menu-check:checked \+ \.chat-menu-track \{ background: var\(--chat-accent\); \}/);
  // And the send button uses that same token, so they cannot drift apart.
  assert.match(CSS, /\.chat-send \{[\s\S]*?background: var\(--chat-accent\)/);
  assert.match(CSS, /\.chat-menu-check:checked \+ \.chat-menu-track \.chat-menu-knob \{ transform: translateX\(14px\); \}/);
});

test("server rows are a name and a switch, and dim when MCP is off", () => {
  // No transport sub-line: the row is one line of text now.
  assert.equal(/const kind = server\.transport/.test(APP), false);
  assert.match(APP, /chat-menu-row sub' \+ \(master\.checked \? "" : " muted"\)/);
  assert.match(APP, /if \(hint\) hint\.textContent = master\.checked \?/);
  assert.match(CSS, /\.chat-menu-row\.muted \{ opacity: \.5; \}/);
  // The popover is DSH's own surface: 70% fill over a 40px frost, 16px radius,
  // and an elevation whose first layer is the hairline stroke.
  assert.match(CSS, /\.chat-mcp-menu \{[\s\S]*?background: var\(--dsh-menu-surface\)/);
  assert.match(CSS, /--dsh-menu-frost: blur\(40px\) saturate\(150%\);/);
  assert.match(CSS, /--dsh-menu-radius: 16px;/);
  assert.match(CSS, /--dsh-menu-shadow: 0 0 0 \.5px var\(--dsh-menu-stroke\)/);
});
