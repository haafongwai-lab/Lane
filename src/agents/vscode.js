import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readState, writeState, writeTextAtomic } from "./store.js";
import { gatewayBase } from "../config.js";

/**
 * VS Code's own Chat (the Copilot Chat panel built into VS Code Stable since
 * 1.122) takes models of other vendors through its Custom Endpoint provider.
 * The catalog lives in `chatLanguageModels.json` beside the default profile's
 * `settings.json`, as a JSONC array of groups:
 *
 *   { "vendor": "customendpoint", "name": "lane",
 *     "apiType": "chat-completions",
 *     "models": [{ "id": "lane/<model>", "url": ".../v1/chat/completions",
 *                 "requestHeaders": { "Authorization": "Bearer lane" } }] }
 *
 * Lane writes one such group and sets `chat.defaultModel` to its first
 * model. On disconnect it removes only that group and restores the previous
 * default. Other groups, other settings and the user's editor preferences are
 * preserved.
 *
 * This is the local VS Code Chat path, not an installed extension. A portable
 * build keeps its User folder in its data directory; VSCODE_USER_DIR points
 * the adapter at one when automatic discovery cannot find it.
 */

export const VSCODE_GROUP_NAME = "lane";
const LOCAL_TOKEN = "lane";
const TOKEN_PREFIX = "lane/";

export function vscodePaths(env = process.env) {
  if (env.VSCODE_USER_DIR) {
    const dir = path.resolve(env.VSCODE_USER_DIR);
    return pathsFor(dir);
  }
  if (env.LANE_VSCODE_SETTINGS) {
    const settings = path.resolve(env.LANE_VSCODE_SETTINGS);
    return { dir: path.dirname(settings), settings, models: path.join(path.dirname(settings), "chatLanguageModels.json") };
  }
  const appData = env.APPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Roaming");
  // VS Code Stable is the default; Insiders keeps the same layout under its
  // own folder and is used when Stable's User folder does not exist.
  const stable = path.join(appData, "Code", "User");
  const insiders = path.join(appData, "Code - Insiders", "User");
  return pathsFor(pathExistsSync(stable) || !pathExistsSync(insiders) ? stable : insiders);
}

function pathsFor(dir) {
  return { dir, settings: path.join(dir, "settings.json"), models: path.join(dir, "chatLanguageModels.json") };
}

function pathExistsSync(file) {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

function stripJsonComments(text) {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next || "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function parseJsonc(text, where) {
  if (!String(text || "").trim()) return null;
  try {
    return JSON.parse(stripJsonComments(String(text)).replace(/,\s*([}\]])/g, "$1"));
  } catch (error) {
    throw new Error(`${where} is not valid JSON: ${error.message}`);
  }
}

async function readJsonc(file) {
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { text, value: parseJsonc(text, file), hadFile: Boolean(text.trim()) };
}

function isLaneGroup(group) {
  return Boolean(group) && typeof group === "object" &&
    (group.name === VSCODE_GROUP_NAME) &&
    (group.vendor === "customendpoint" || group.vendor === "customoai");
}

function modelId(model) {
  return `${TOKEN_PREFIX}${model.id}`;
}

function laneGroup(models, gateway) {
  const list = Array.isArray(models) && models.length ? models : [{ id: "auto", name: "Auto" }];
  return {
    name: VSCODE_GROUP_NAME,
    vendor: "customendpoint",
    apiType: "chat-completions",
    models: list.map((model) => {
      const context = Number(model.context || model.contextWindow) || 128000;
      const output = Number(model.maxOutputTokens || model.output || model.maxOutput) || Math.min(8192, Math.floor(context / 4));
      const entry = {
        id: modelId(model),
        name: String(model.name || model.id),
        url: `${String(gateway).replace(/\/+$/, "")}/v1/chat/completions`,
        toolCalling: true,
        vision: Boolean(model.image || model.vision),
        contextWindow: context,
        maxOutputTokens: Math.min(output, Math.floor(context / 4)),
        requestHeaders: { Authorization: `Bearer ${LOCAL_TOKEN}` }
      };
      if (Array.isArray(model.efforts) && model.efforts.length) {
        entry.supportsReasoningEffort = model.efforts;
        entry.reasoningEffortFormat = "chat-completions";
      }
      return entry;
    })
  };
}

async function readModels(providerModels) {
  if (typeof providerModels !== "function") return [];
  try {
    const models = await providerModels();
    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Rewrites one top-level string key in a JSONC document in place, leaving
 * every comment the user wrote where it is. The scanner walks the raw text
 * (strings, line and block comments, brace depth) and only touches the span
 * between the key's colon and its old value. Returns null whenever the edit
 * cannot be done safely — key absent, or the old value not a string — and
 * the caller falls back to the parse-and-rewrite, which loses comments.
 */
function patchJsoncStringKey(text, key, value) {
  const src = String(text ?? "");
  const encoded = JSON.stringify(key);
  let depth = 0;
  let quote = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i += 1; continue; }
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "{" || ch === "[") { depth += 1; i += 1; continue; }
    if (ch === "}" || ch === "]") { depth -= 1; i += 1; continue; }
    if (depth === 1 && ch === '"' && src.startsWith(encoded, i)) {
      let j = i + encoded.length;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] !== ":") { i += 1; continue; }
      j += 1;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] !== '"') return null;
      let end = j + 1;
      while (end < src.length) {
        if (src[end] === "\\") { end += 2; continue; }
        if (src[end] === '"') { end += 1; break; }
        end += 1;
      }
      if (end > src.length) return null;
      return src.slice(0, j) + JSON.stringify(value) + src.slice(end);
    }
    i += 1;
  }
  return null;
}

/**
 * Sets one top-level string setting, preferring the comment-preserving patch.
 * Returns false when the caller must fall back to rewriting the document.
 */
async function writeStringSetting(file, current, key, value) {
  if (current.hadFile) {
    const patched = patchJsoncStringKey(current.text, key, value);
    if (patched == null) return false;
    if (patched !== current.text) await writeTextAtomic(file, patched);
    return true;
  }
  return false;
}

export async function connectVscode({
  env = process.env,
  gateway = gatewayBase(),
  providerModels
} = {}) {
  const paths = vscodePaths(env);
  const state = await readState(env);
  const settings = await readJsonc(paths.settings);
  const document = settings.value && typeof settings.value === "object" && !Array.isArray(settings.value)
    ? settings.value
    : {};
  const groups = parseJsonc((await readJsonc(paths.models)).text || "[]", paths.models);
  // A models file that parses but is not an array is the user's own shape;
  // silently replacing it with an array would eat their configuration.
  if (groups != null && !Array.isArray(groups)) {
    throw new Error(`${paths.models} is not a JSON array; refusing to edit it`);
  }
  const list = Array.isArray(groups) ? groups : [];
  const models = await readModels(providerModels);
  const first = models[0] || { id: "auto", name: "Auto" };
  const previousDefault = document["chat.defaultModel"];
  const next = list.filter((group) => !isLaneGroup(group));
  next.unshift(laneGroup(models.length ? models : [first], gateway));
  await writeJson(paths.models, next);
  // The settings file is the user's, comments included; patch it in place
  // when the shape allows, and only rewrite — dropping comments — otherwise.
  if (!(await writeStringSetting(paths.settings, settings, "chat.defaultModel", modelId(first)))) {
    document["chat.defaultModel"] = modelId(first);
    await writeJson(paths.settings, document);
  }
  state.vscode = {
    connected: true,
    gateway: String(gateway),
    settingsPath: paths.settings,
    modelsPath: paths.models,
    modelIds: models.map((model) => model.id),
    previousDefault
  };
  await writeState(state, env);
  return {
    agent: "vscode",
    connected: true,
    gateway,
    configPath: paths.models,
    restartRequired: true
  };
}

export async function syncVscodeCatalog({ env = process.env, models = [] } = {}) {
  const state = await readState(env);
  const saved = state.vscode;
  if (!saved?.connected) return { changed: false };
  const paths = vscodePaths(env);
  const settings = await readJsonc(paths.settings);
  const document = settings.value && typeof settings.value === "object" && !Array.isArray(settings.value)
    ? settings.value
    : {};
  const groups = parseJsonc((await readJsonc(paths.models)).text || "[]", paths.models);
  if (groups != null && !Array.isArray(groups)) {
    throw new Error(`${paths.models} is not a JSON array; refusing to edit it`);
  }
  const list = Array.isArray(groups) ? groups : [];
  const first = models[0] || { id: "auto", name: "Auto" };
  const next = list.filter((group) => !isLaneGroup(group));
  next.unshift(laneGroup(models.length ? models : [first], saved.gateway));
  await writeJson(paths.models, next);
  if (String(document["chat.defaultModel"] || "").startsWith(TOKEN_PREFIX)) {
    if (!(await writeStringSetting(paths.settings, settings, "chat.defaultModel", modelId(first)))) {
      document["chat.defaultModel"] = modelId(first);
      await writeJson(paths.settings, document);
    }
  }
  saved.modelIds = models.map((model) => model.id);
  await writeState(state, env);
  return { changed: true };
}

export async function disconnectVscode({ env = process.env } = {}) {
  const state = await readState(env);
  const saved = state.vscode;
  if (!saved) return { agent: "vscode", connected: false, changed: false };
  const paths = vscodePaths(env);
  try {
    const settings = await readJsonc(paths.settings);
    const document = settings.value && typeof settings.value === "object" && !Array.isArray(settings.value)
      ? settings.value
      : {};
    const restoreDefault = String(document["chat.defaultModel"] || "").startsWith(TOKEN_PREFIX);
    const groups = parseJsonc((await readJsonc(paths.models)).text || "[]", paths.models);
    if (Array.isArray(groups)) await writeJson(paths.models, groups.filter((group) => !isLaneGroup(group)));
    if (restoreDefault) {
      if (saved.previousDefault === undefined) {
        delete document["chat.defaultModel"];
        await writeJson(paths.settings, document);
      } else if (!(await writeStringSetting(paths.settings, settings, "chat.defaultModel", saved.previousDefault))) {
        document["chat.defaultModel"] = saved.previousDefault;
        await writeJson(paths.settings, document);
      }
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
    configPath: vscodePaths(env).models,
    installed: Boolean(saved?.connected)
  };
}
