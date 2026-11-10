import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readState, writeState, writeTextAtomic } from "./store.js";
import { gatewayBase } from "../config.js";

/**
 * VS Code through the Claude Code extension.
 *
 * VS Code has no provider file of its own. The Claude Code extension launches
 * the Claude Code runtime and reads the same `~/.claude/settings.json` as the
 * CLI, so the one durable place Lane can wire is that file's `env` block:
 *
 *   ANTHROPIC_BASE_URL    the gateway, speaking Anthropic Messages
 *   ANTHROPIC_AUTH_TOKEN  a local placeholder; the gateway is loopback-only
 *   ANTHROPIC_MODEL       the first allowed upstream model
 *
 * The rest of the user's settings 鈥?their login, model settings, plugins and
 * other environment variables 鈥?is preserved. Disconnect restores only the
 * three keys Lane set, and only when their current value is still Lane's.
 */

const ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"];
const LOCAL_TOKEN = "lane";

export function vscodePaths(env = process.env) {
  if (env.LANE_VSCODE_CONFIG) {
    const config = path.resolve(env.LANE_VSCODE_CONFIG);
    return { dir: path.dirname(config), config };
  }
  const home = env.CLAUDE_CONFIG_DIR
    ? path.resolve(env.CLAUDE_CONFIG_DIR)
    : path.join(env.USERPROFILE || os.homedir(), ".claude");
  return { dir: home, config: path.join(home, "settings.json") };
}

function asDocument(parsed, where) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Claude Code settings must be a JSON object (${where})`);
  }
  return parsed;
}

async function readConfig(file) {
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!text.trim()) return { document: {}, hadFile: false };
  try {
    return { document: asDocument(JSON.parse(text), file), hadFile: true };
  } catch (error) {
    throw new Error(`Claude Code settings is not valid JSON (${file}): ${error.message}`);
  }
}

function laneValues(gateway, modelId) {
  return {
    ANTHROPIC_BASE_URL: String(gateway).replace(/\/+$/, ""),
    ANTHROPIC_AUTH_TOKEN: LOCAL_TOKEN,
    ANTHROPIC_MODEL: modelId || "auto"
  };
}

/**
 * The first model the gateway serves. The extension passes ANTHROPIC_MODEL
 * through unchanged, so this must be an id the gateway can resolve rather
 * than a Claude-branded name that happens to sound familiar.
 */
function firstModel(models) {
  return Array.isArray(models) && models[0]?.id ? String(models[0].id) : "auto";
}

async function readModels(providerModels) {
  if (typeof providerModels !== "function") return { models: [], known: true };
  try {
    const models = await providerModels();
    return { models: Array.isArray(models) ? models : [], known: Array.isArray(models) };
  } catch {
    return { models: [], known: false };
  }
}

export async function connectVscode({
  env = process.env,
  gateway = gatewayBase(),
  providerModels
} = {}) {
  const paths = vscodePaths(env);
  const state = await readState(env);
  const { document, hadFile } = await readConfig(paths.config);
  const { models } = await readModels(providerModels);
  const modelId = firstModel(models);
  const envBlock = document.env && typeof document.env === "object" && !Array.isArray(document.env)
    ? { ...document.env }
    : {};
  const previous = {};
  for (const key of ENV_KEYS) previous[key] = envBlock[key];
  Object.assign(envBlock, laneValues(gateway, modelId));
  document.env = envBlock;

  await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await writeTextAtomic(paths.config, `${JSON.stringify(document, null, 2)}\n`);
  state.vscode = {
    connected: true,
    gateway: String(gateway),
    configPath: paths.config,
    modelId,
    previous,
    hadFile
  };
  await writeState(state, env);
  return {
    agent: "vscode",
    connected: true,
    gateway,
    configPath: paths.config,
    restartRequired: true
  };
}

export async function syncVscodeCatalog({ env = process.env, models = [] } = {}) {
  const state = await readState(env);
  const saved = state.vscode;
  if (!saved?.connected) return { changed: false };
  const paths = vscodePaths(env);
  const { document } = await readConfig(paths.config);
  const envBlock = document.env && typeof document.env === "object" && !Array.isArray(document.env)
    ? { ...document.env }
    : {};
  const modelId = firstModel(models);
  envBlock.ANTHROPIC_BASE_URL = saved.gateway || envBlock.ANTHROPIC_BASE_URL;
  envBlock.ANTHROPIC_AUTH_TOKEN = LOCAL_TOKEN;
  envBlock.ANTHROPIC_MODEL = modelId;
  document.env = envBlock;
  await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await writeTextAtomic(paths.config, `${JSON.stringify(document, null, 2)}\n`);
  saved.modelId = modelId;
  await writeState(state, env);
  return { changed: true };
}

export async function disconnectVscode({ env = process.env } = {}) {
  const state = await readState(env);
  const saved = state.vscode;
  if (!saved) return { agent: "vscode", connected: false, changed: false };
  const paths = vscodePaths(env);
  try {
    const { document } = await readConfig(paths.config);
    const envBlock = document.env && typeof document.env === "object" && !Array.isArray(document.env)
      ? { ...document.env }
      : null;
    if (envBlock) {
      const want = laneValues(saved.gateway, saved.modelId);
      for (const key of ENV_KEYS) {
        // Only undo a value Lane itself set. A user who changed ANTHROPIC_MODEL
        // after connecting keeps their choice.
        if (envBlock[key] !== want[key]) continue;
        if (saved.previous?.[key] === undefined) delete envBlock[key];
        else envBlock[key] = saved.previous[key];
      }
      document.env = envBlock;
      await writeTextAtomic(paths.config, `${JSON.stringify(document, null, 2)}\n`);
    }
  } catch {
    // A file the user has since made invalid is theirs to fix; the state
    // entry still goes away so Lane stops claiming the connection.
  }
  delete state.vscode;
  await writeState(state, env);
  return { agent: "vscode", connected: false, changed: true, restartRequired: true };
}

export async function vscodeStatus({ env = process.env } = {}) {
  const state = await readState(env);
  const saved = state.vscode;
  return {
    connected: Boolean(saved?.connected),
    configPath: vscodePaths(env).config,
    installed: Boolean(saved?.connected)
  };
}

