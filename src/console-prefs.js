import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { writeJSON } from "./agents/store.js";

/**
 * The 问答 panel's own settings, kept apart from the gateway's `settings.json`.
 *
 * They are a client preference, not gateway behaviour: which MCP servers the
 * panel may use, and the budgets that keep a tool loop (or a long conversation)
 * from running away. Stored in `console.json` so a gateway settings rewrite
 * never drops them, and so the file can be inspected or deleted on its own.
 */

const file = (env) => path.join(dataDir(env), "console.json");

export const DEFAULTS = {
  mcpEnabled: false,
  mcpServers: [],
  maxRounds: 6,          // tool rounds per question
  maxTokens: 24_000,     // total tokens across every round of one question
  maxDurationMs: 180_000, // wall-clock ceiling for one question
  historyTurns: 10       // message pairs kept as context
};

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

export function normalizePrefs(raw = {}) {
  return {
    mcpEnabled: raw?.mcpEnabled === true,
    mcpServers: Array.isArray(raw?.mcpServers)
      ? [...new Set(raw.mcpServers.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim()))].slice(0, 50)
      : [],
    maxRounds: clamp(raw?.maxRounds, 1, 12, DEFAULTS.maxRounds),
    maxTokens: clamp(raw?.maxTokens, 1_000, 200_000, DEFAULTS.maxTokens),
    maxDurationMs: clamp(raw?.maxDurationMs, 10_000, 900_000, DEFAULTS.maxDurationMs),
    historyTurns: clamp(raw?.historyTurns, 1, 50, DEFAULTS.historyTurns)
  };
}

export async function readConsolePrefs(env = process.env) {
  try {
    return normalizePrefs(JSON.parse(await fs.readFile(file(env), "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return { ...DEFAULTS };
  }
}

export async function writeConsolePrefs(patch, env = process.env) {
  const current = await readConsolePrefs(env);
  const next = normalizePrefs({ ...current, ...(patch && typeof patch === "object" ? patch : {}) });
  const target = file(env);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeJSON(target, next);
  return next;
}
