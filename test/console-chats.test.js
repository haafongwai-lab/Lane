import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  listSessions, getSession, createSession, appendTurn,
  renameSession, deleteSession, clearSessions, titleFrom
} from "../src/console-chats.js";

/**
 * Saved 问答 conversations.
 *
 * Plaintext by request. The list is what the history panel draws; the session is
 * what reopening it replays. A session begins with its first successful answer,
 * so an abandoned question leaves nothing behind, and its title is taken from
 * that first question and never renames itself later.
 */

async function tempEnv(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-chats-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { ...process.env, LANE_DATA_DIR: dir };
}

test("a title is the first line, trimmed to a readable length", () => {
  assert.equal(titleFrom("查一下余额"), "查一下余额");
  assert.equal(titleFrom("  多行\n第二行"), "多行");
  assert.equal(titleFrom(""), "新对话");
  const long = titleFrom("一".repeat(40));
  assert.equal(long.length, 25, "24 chars plus the ellipsis");
  assert.ok(long.endsWith("…"));
});

test("appending the first turn creates the session and names it", async (t) => {
  const env = await tempEnv(t);
  const session = await appendTurn("s1", { prompt: "今天花了多少积分", answer: "共 34.5 积分" }, env);
  assert.equal(session.id, "s1");
  assert.equal(session.title, "今天花了多少积分");
  assert.deepEqual(session.messages, [
    { role: "user", content: "今天花了多少积分" },
    { role: "assistant", content: "共 34.5 积分" }
  ]);
});

test("the title is set once, not renamed by a later turn", async (t) => {
  const env = await tempEnv(t);
  await appendTurn("s1", { prompt: "第一个问题", answer: "回答一" }, env);
  const after = await appendTurn("s1", { prompt: "完全不同的问题", answer: "回答二" }, env);
  assert.equal(after.title, "第一个问题", "the first question keeps naming the conversation");
  assert.equal(after.messages.length, 4);
});

test("the list is newest-first and carries no message bodies", async (t) => {
  const env = await tempEnv(t);
  await appendTurn("old", { prompt: "旧问题", answer: "旧回答" }, env);
  await new Promise((r) => setTimeout(r, 5));
  await appendTurn("new", { prompt: "新问题", answer: "新回答" }, env);
  const list = await listSessions(env);
  assert.deepEqual(list.map((s) => s.id), ["new", "old"]);
  assert.equal(list[0].turns, 1);
  assert.equal("messages" in list[0], false, "the list stays light");
});

test("get, rename, delete and clear behave", async (t) => {
  const env = await tempEnv(t);
  await appendTurn("s1", { prompt: "问题", answer: "回答" }, env);
  assert.equal((await getSession("s1", env)).messages.length, 2);
  assert.equal((await getSession("nope", env)), null);

  const renamed = await renameSession("s1", "自定义标题", env);
  assert.equal(renamed.title, "自定义标题");

  assert.deepEqual(await deleteSession("s1", env), { removed: 1 });
  assert.equal((await getSession("s1", env)), null);

  await appendTurn("s2", { prompt: "另一个", answer: "回答" }, env);
  await clearSessions(env);
  assert.deepEqual(await listSessions(env), []);
});

test("an empty or corrupt file reads as no sessions rather than throwing", async (t) => {
  const env = await tempEnv(t);
  assert.deepEqual(await listSessions(env), []);
  const file = path.join(env.LANE_DATA_DIR, "chats.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{ not json", "utf8");
  assert.deepEqual(await listSessions(env), []);
});

test("the panel is wired to save and replay", () => {
  const APP = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "app.js"), "utf8");
  const MAIN = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "main.js"), "utf8");
  const HTML = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "index.html"), "utf8");
  // Saving happens after a turn reaches the screen, not on every keystroke.
  // The persisted prompt records attachment names rather than base64.
  assert.match(APP, /chatPersistTurn\(sentNames \?/);
  assert.match(APP, /chatPersistTurn\(text, partial\)/);
  // Replay rebuilds the transcript from stored messages.
  assert.match(APP, /chatOpenSession/);
  // The IPC surface exists.
  assert.match(MAIN, /"lane:console-sessions"/);
  assert.match(HTML, /id="chat-history-panel"/);
  assert.match(HTML, /id="chat-history-list"/);
});
