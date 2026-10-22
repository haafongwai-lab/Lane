import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readState, writeState } from "./store.js";
import { gatewayBase } from "../config.js";

/**
 * ZCode keeps its providers in a plain JSON file: each entry in
 * `config.providerConfigRules.providerRules` names a provider, and a rule
 * without a `templateId` is complete on its own — its `config.api.baseUrl`
 * becomes the endpoint its requests go to, its `config.api.type` picks the
 * protocol. Lane writes one such rule pointing at the gateway, and removes
 * it on disconnect, leaving the user's other providers untouched.
 *
 * The file also carries the user's API keys and everything else ZCode stores
 * about providers, so it is edited as a whole parsed document with only the
 * Lane paths touched — never reformatted or rebuilt.
 */

const PROVIDER_ID = "lane";
const PROVIDER_NAME = "Lane";
// Lane speaks Anthropic Messages on /v1/messages; ZCode's runtime maps
// "anthropic-messages" to its anthropic client, pointed at baseUrl as-is.
const API_TYPE = "anthropic-messages";

// Lane's own fallback catalogue, used only when the account's list is
// unavailable at connect time.
const FALLBACK_MODELS = [
  { id: "auto", name: "Auto", context: 256000 },
  { id: "hy3", name: "Hy3", context: 192000 }
];

export function zcodePaths(env = process.env) {
  const home = env.ZCODE_HOME
    ? path.resolve(env.ZCODE_HOME)
    : path.join(env.USERPROFILE || os.homedir(), ".zcode");
  const dir = path.join(home, "v2");
  return { home, dir, config: path.join(dir, "provider_config.json") };
}

export async function connectZcode({
  env = process.env,
  gateway = gatewayBase(),
  providerModels
} = {}) {
  const paths = zcodePaths(env);
  const state = await readState(env);
  const previous = state.zcode || {};
  const text = await readText(paths.config);
  const hadFile = text !== "";
  let document;
  try {
    document = hadFile ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`ZCode provider config is not valid JSON (${paths.config}): ${error.message}`);
  }

  let models = [];
  try {
    models = typeof providerModels === "function" ? await providerModels() : [];
  } catch {
    models = [];
  }
  if (!models.length) models = FALLBACK_MODELS;
  const ids = models.map((model) => model.id);

  // The document is ZCode's own; only the paths below are Lane's.
  document.schemaVersion = document.schemaVersion ?? 1;
  const config = (document.config ??= {});
  const rules = (config.providerConfigRules ??= {});
  const list = (rules.providerRules ??= []);
  const rule = {
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    enabled: true,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "lane" },
      api: { type: API_TYPE, baseUrl: String(gateway).replace(/\/+$/, "") },
      personalModelIds: ids,
      modelOrder: ids
    }
  };
  const existing = list.findIndex((item) => item?.providerId === PROVIDER_ID);
  if (existing >= 0) list[existing] = rule;
  else list.push(rule);

  // A fresh config has no order yet; creating one puts Lane ahead of whatever
  // the user adds later, and an existing order keeps its other entries.
  const order = Array.isArray(config.providerOrder)
    ? config.providerOrder.filter((id) => id !== PROVIDER_ID)
    : [];
  config.providerOrder = [PROVIDER_ID, ...order];

  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.config, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  state.zcode = {
    connected: true,
    gateway,
    configPath: paths.config,
    hadFile,
    // The document as it was before this connect, so a user who wants Lane's
    // entry gone without other drift can compare; disconnect removes the rule
    // rather than restoring bytes, because ZCode rewrites the file while running.
    savedConfig: hadFile ? text : ""
  };
  await writeState(state, env);

  return {
    agent: "zcode",
    connected: true,
    gateway,
    models: models.length,
    configPath: paths.config,
    restartRequired: true
  };
}

export async function disconnectZcode({ env = process.env } = {}) {
  const paths = zcodePaths(env);
  const state = await readState(env);
  const saved = state.zcode;
  if (!saved) return { agent: "zcode", connected: false, changed: false };

  const text = await readText(paths.config);
  if (!text) {
    delete state.zcode;
    await writeState(state, env);
    return { agent: "zcode", connected: false, changed: false };
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    // A file we cannot read is not ours to edit; the wiring record goes, the
    // file stays for the user to look at.
    delete state.zcode;
    await writeState(state, env);
    return { agent: "zcode", connected: false, changed: false, warning: "provider config is not valid JSON" };
  }

  let changed = false;
  const rules = document?.config?.providerConfigRules?.providerRules;
  if (Array.isArray(rules)) {
    const next = rules.filter((item) => item?.providerId !== PROVIDER_ID);
    if (next.length !== rules.length) {
      document.config.providerConfigRules.providerRules = next;
      changed = true;
    }
  }
  if (Array.isArray(document?.config?.providerOrder)) {
    const next = document.config.providerOrder.filter((id) => id !== PROVIDER_ID);
    if (next.length !== document.config.providerOrder.length) {
      document.config.providerOrder = next;
      changed = true;
    }
  }
  if (changed) {
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.config, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
  delete state.zcode;
  await writeState(state, env);
  return { agent: "zcode", connected: false, changed, restartRequired: true };
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}
