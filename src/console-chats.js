import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { writeJSON } from "./agents/store.js";

/**
 * The 问答 panel's saved conversations.
 *
 * Plaintext on purpose: the panel is a local tool, and encrypting it would need
 * a passphrase the user has to keep. `chats.json` sits beside the other data
 * files and can be deleted at any time.
 *
 * A session holds whole turns only — a user message and the answer it produced.
 * A turn that failed or was stopped mid-word is stored as what it reached, so
 * reopening a session shows exactly what was on screen.
 */

const file = (env) => path.join(dataDir(env), "chats.json");
const MAX_SESSIONS = 100;
const MAX_MESSAGES = 400;
const TITLE_CHARS = 24;

export function titleFrom(text) {
  const line = String(text || "").trim().split("\n")[0] || "";
  const trimmed = line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS)}…` : line;
  return trimmed || "新对话";
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = raw.role === "assistant" ? "assistant" : raw.role === "user" ? "user" : "";
  if (!role) return null;
  return { role, content: String(raw.content ?? "") };
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(normalizeMessage).filter(Boolean).slice(-MAX_MESSAGES)
    : [];
  return {
    id,
    title: String(raw.title || titleFrom(messages.find((m) => m.role === "user")?.content || "")),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    messages
  };
}

function normalizeStore(raw) {
  const sessions = Array.isArray(raw?.sessions) ? raw.sessions.map(normalizeSession).filter(Boolean) : [];
  return { version: 1, sessions: sessions.slice(0, MAX_SESSIONS) };
}

async function readStore(env) {
  try {
    return normalizeStore(JSON.parse(await fs.readFile(file(env), "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return { version: 1, sessions: [] };
  }
}

async function writeStore(store, env) {
  const target = file(env);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeJSON(target, normalizeStore(store));
  return normalizeStore(store);
}

/** Newest first, without the message bodies: enough to draw a list. */
export async function listSessions(env = process.env) {
  const store = await readStore(env);
  return store.sessions
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, title, createdAt, updatedAt, messages }) => ({
      id,
      title,
      createdAt,
      updatedAt,
      turns: Math.ceil(messages.length / 2)
    }));
}

export async function getSession(id, env = process.env) {
  const store = await readStore(env);
  return store.sessions.find((session) => session.id === String(id || "")) || null;
}

export async function createSession({ id, title } = {}, env = process.env) {
  const store = await readStore(env);
  const now = Date.now();
  const session = {
    id: String(id || `s${now}${Math.floor(Math.random() * 1000)}`),
    title: String(title || "新对话"),
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  store.sessions.unshift(session);
  await writeStore(store, env);
  return session;
}

/**
 * Appends one turn. Creates the session when it does not exist yet, which is
 * the normal path: a session begins with its first successful answer.
 */
export async function appendTurn(id, { prompt, answer, title } = {}, env = process.env) {
  const store = await readStore(env);
  const now = Date.now();
  let session = store.sessions.find((item) => item.id === String(id || ""));
  if (!session) {
    session = {
      id: String(id || `s${now}${Math.floor(Math.random() * 1000)}`),
      title: "",
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    store.sessions.unshift(session);
  }
  session.messages.push({ role: "user", content: String(prompt ?? "") });
  session.messages.push({ role: "assistant", content: String(answer ?? "") });
  if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
  // The title is taken from the first question and never changes afterwards:
  // a later turn renaming the conversation would be disorienting.
  if (!session.title || session.title === "新对话") session.title = titleFrom(title || prompt);
  session.updatedAt = now;
  store.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeStore(store, env);
  return session;
}

export async function renameSession(id, title, env = process.env) {
  const store = await readStore(env);
  const session = store.sessions.find((item) => item.id === String(id || ""));
  if (!session) return null;
  session.title = titleFrom(title) || session.title;
  await writeStore(store, env);
  return session;
}

export async function deleteSession(id, env = process.env) {
  const store = await readStore(env);
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((item) => item.id !== String(id || ""));
  await writeStore(store, env);
  return { removed: before - store.sessions.length };
}

export async function clearSessions(env = process.env) {
  await writeStore({ version: 1, sessions: [] }, env);
  return { removed: true };
}
