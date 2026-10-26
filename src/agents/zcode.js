import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readState, writeState, writeTextAtomic } from "./store.js";
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
  // the user adds later. An existing order that already holds Lane is left
  // exactly as it is: a reconnect must not undo the user demoting Lane below
  // their default provider.
  if (!Array.isArray(config.providerOrder)) {
    config.providerOrder = [PROVIDER_ID];
  } else if (!config.providerOrder.includes(PROVIDER_ID)) {
    config.providerOrder = [PROVIDER_ID, ...config.providerOrder];
  }

  await writeTextAtomic(paths.config, `${JSON.stringify(document, null, 2)}\n`);

  state.zcode = {
    connected: true,
    gateway,
    configPath: paths.config,
    hadFile
    // The file's previous text is deliberately not kept here: it carries the
    // user's API keys for every provider, and a second plaintext copy in
    // wiring.json would outlive its purpose — disconnect removes Lane's rule
    // from the live file rather than restoring bytes, because ZCode rewrites
    // the file while running.
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

/**
 * ZCode keeps the provider's model ids in its own file rather than asking
 * the endpoint, so the list Lane wrote at connect time is all it will ever
 * offer. Switching to an account on another site changes the catalogue
 * behind the same gateway URL (the international build serves 26 models
 * where the domestic one serves 19), and ZCode went on showing the ids
 * captured at connect — every model unique to the new account was missing
 * until the user disconnected and reconnected.
 *
 * The user may have reordered or pruned the list in ZCode's own UI, so this
 * refreshes only when Lane's rule is in place and the set of ids actually
 * differs. Order is preserved where the ids survive: the user's arrangement
 * comes first, new ids join at the end, and ids the new account cannot serve
 * leave. A model removed from the middle would otherwise reorder everything
 * after it on every account switch.
 */
export async function syncZcodeCatalog({ env = process.env, models = [] } = {}) {
  if (!models.length) return { changed: false };
  const state = await readState(env);
  const saved = state.zcode;
  if (!saved?.connected) return { changed: false };
  const paths = zcodePaths(env);
  let text = "";
  try {
    text = await fs.readFile(paths.config, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { changed: false };
  }
  if (!text) return { changed: false };
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    // Not ours to rewrite; the user is looking at a file Lane cannot parse.
    return { changed: false, warning: "provider config is not valid JSON" };
  }
  const rules = document?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return { changed: false };
  const rule = rules.find((item) => item?.providerId === PROVIDER_ID);
  // Disconnected by hand, or the rule was replaced: nothing to sync into.
  if (!rule || !rule.config) return { changed: false };

  const ids = models.map((model) => model.id);
  const next = orderModels(ids, rule.config.personalModelIds);
  const current = Array.isArray(rule.config.personalModelIds) ? rule.config.personalModelIds : [];
  const order = orderModels(ids, rule.config.modelOrder);
  const currentOrder = Array.isArray(rule.config.modelOrder) ? rule.config.modelOrder : [];
  if (sameList(current, next) && sameList(currentOrder, order)) return { changed: false };

  rule.config.personalModelIds = next;
  rule.config.modelOrder = order;
  await writeTextAtomic(paths.config, `${JSON.stringify(document, null, 2)}\n`);
  return { changed: true };
}

// orderModels keeps the ids the user already arranged, in their arrangement,
// and appends the ones this account adds. Ids the account cannot serve drop
// out because only `available` is walked.
function orderModels(available, previous) {
  const keep = new Set(available);
  const out = [];
  for (const id of Array.isArray(previous) ? previous : []) {
    if (keep.has(id) && !out.includes(id)) out.push(id);
  }
  for (const id of available) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
    await writeTextAtomic(paths.config, `${JSON.stringify(document, null, 2)}\n`);
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
