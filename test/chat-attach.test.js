import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Image and file attachments.
 *
 * An image becomes an `image_url` part and a text file is inlined as a fenced
 * block, both inside the ordinary message content — so the request shape a
 * vendor sees is unchanged, it just carries more of it. Limits exist because a
 * base64 image is about a third larger than the file and a 128k context will not
 * survive several of them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const APP = read("desktop/app.js");
const HTML = read("desktop/index.html");
const CSS = read("desktop/styles.css");

test("the composer has an attach button, a file input and a tray", () => {
  assert.match(HTML, /id="chat-attach"/);
  assert.match(HTML, /id="chat-file"/);
  assert.match(HTML, /id="chat-attach-tray"/);
  assert.match(CSS, /\.chat-attach \{/);
  assert.match(CSS, /\.chat-attach-tray \{/);
});

test("images become image parts and text files are inlined", () => {
  assert.match(APP, /function chatAttachContent\(prompt\)/);
  assert.match(APP, /parts\.push\(\{ type: "image_url", image_url: \{ url: item\.dataUrl \} \}\)/);
  assert.match(APP, /parts\.push\(\{ type: "text", text: `\\n\\n文件 \$\{item\.name\}：\\n\\n/);
  // A plain question still sends a plain string.
  assert.match(APP, /return parts\.length === 1 && parts\[0\]\.type === "text" \? parts\[0\]\.text : parts/);
});

test("limits keep one turn from blowing the context", () => {
  assert.match(APP, /const CHAT_IMAGE_MAX_BYTES = 4 \* 1024 \* 1024/);
  assert.match(APP, /const CHAT_TEXT_MAX_BYTES = 512 \* 1024/);
  assert.match(APP, /const CHAT_TEXT_MAX_CHARS = 24_000/);
  assert.match(APP, /const CHAT_ATTACH_MAX = 6/);
  assert.match(APP, /图片过大：/);
  assert.match(APP, /文件过大：/);
});

test("three ways to attach: the button, a drop, and a paste", () => {
  assert.match(APP, /\$\("#chat-attach"\)\?\.addEventListener\("click", \(\) => \$\("#chat-file"\)\?\.click\(\)\)/);
  assert.match(APP, /addEventListener\("drop"/);
  assert.match(APP, /addEventListener\("paste"/);
  assert.match(APP, /clipboardData\?\.files/);
});

test("attachments belong to one turn only", () => {
  // The tray is emptied as the turn is sent.
  assert.match(APP, /chatAttachments = \[\];\s*\n\s*renderChatAttachments\(\);/);
  // An attachment alone can be sent, with no typed text.
  assert.match(APP, /if \(!typed && !chatAttachments\.length\) return;/);
  // The transcript and the saved history record the names, not the base64.
  assert.match(APP, /附件：\$\{attached\}/);
  assert.match(APP, /chatPersistTurn\(sentNames \?/);
});

test("context budgeting understands a parts array", () => {
  assert.match(APP, /function chatContentTokens\(content\)/);
  assert.match(APP, /part\?\.type === "text" \? chatRoughTokens\(part\.text\) : 0/);
});
