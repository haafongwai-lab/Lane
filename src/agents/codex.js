import fs from "node:fs/promises";
import path from "node:path";
import { codexConfigPath } from "./paths.js";
import { readState, writeState } from "./store.js";
import { gatewayBase } from "../config.js";

const PROVIDER = "lane";

function providerTable(gateway) {
  return [
    `[model_providers.${PROVIDER}]`,
    `name = "Lane"`,
    `base_url = "${gateway}/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    `supports_websockets = false`,
    ""
  ].join("\n");
}

function catalog(models) {
  return {
    models: models.map((model, index) => ({
      slug: model.id,
      display_name: model.name || model.id,
      description: `${model.name || model.id} via Lane`,
      base_instructions: "You are a helpful coding agent.",
      default_reasoning_level: null,
      supported_reasoning_levels: [],
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: index + 1,
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: "freeform",
      truncation_policy: { mode: "tokens", limit: 10000 },
      experimental_supported_tools: [],
      input_modalities: ["text"],
      context_window: model.context || undefined,
      service_tiers: [],
      supports_search_tool: true,
      supports_parallel_tool_calls: true,
      supports_reasoning_summaries: false
    }))
  };
}

export async function connectCodex({ env = process.env, gateway = gatewayBase(), providerModels } = {}) {
  const configPath = codexConfigPath(env);
  const state = await readState(env);
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const saved = state[PROVIDER] || {
    previous: {
      model_provider: topValue(text, "model_provider"),
      model_catalog_json: topValue(text, "model_catalog_json"),
      hadProviderTable: hasProviderTable(text)
    }
  };
  let next = setTopValue(text, "model_provider", `"${PROVIDER}"`);
  next = setTopValue(next, "model_catalog_json", '"lane-models.json"');
  if (!hasProviderTable(next)) next = `${next.replace(/\s*$/, "\n\n")}${providerTable(gateway)}`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, next, "utf8");
  if (typeof providerModels === "function") {
    const models = await providerModels();
    const catalogPath = path.join(path.dirname(configPath), "lane-models.json");
    await fs.writeFile(catalogPath, `${JSON.stringify(catalog(models), null, 2)}\n`);
  }
  state[PROVIDER] = { ...saved, connected: true, gateway, configPath };
  await writeState(state, env);
  return { agent: "codex", connected: true, gateway, restartRequired: true };
}

export async function disconnectCodex({ env = process.env } = {}) {
  const configPath = codexConfigPath(env);
  const state = await readState(env);
  const saved = state[PROVIDER];
  if (!saved) return { agent: "codex", connected: false, changed: false };
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const previous = saved.previous?.model_provider;
  if (previous) text = setTopValue(text, "model_provider", previous);
  else text = removeTopValue(text, "model_provider");
  const previousCatalog = saved.previous?.model_catalog_json;
  if (previousCatalog) text = setTopValue(text, "model_catalog_json", previousCatalog);
  else text = removeTopValue(text, "model_catalog_json");
  if (!saved.previous?.hadProviderTable) text = removeProviderTable(text);
  await fs.writeFile(configPath, text, "utf8");
  if (!saved.previous?.model_catalog_json) {
    await fs.rm(path.join(path.dirname(configPath), "lane-models.json"), { force: true });
  }
  delete state[PROVIDER];
  await writeState(state, env);
  return { agent: "codex", connected: false, changed: true, restartRequired: true };
}

function topValue(text, key) {
  const line = text.split(/\r?\n/).find((entry) => new RegExp(`^${key}\\s*=`).test(entry));
  return line ? line.replace(new RegExp(`^${key}\\s*=\\s*`), "").trim() : "";
}

function setTopValue(text, key, value) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^${key}\\s*=`).test(line));
  const replacement = `${key} = ${value}`;
  if (index >= 0) lines[index] = replacement;
  else lines.unshift(replacement);
  return lines.join("\n").replace(/\n*$/, "\n");
}

function removeTopValue(text, key) {
  return text
    .split(/\r?\n/)
    .filter((line) => !new RegExp(`^${key}\\s*=`).test(line))
    .join("\n")
    .replace(/\n*$/, "\n");
}

function hasProviderTable(text) {
  return /^\[model_providers\.lane\]\s*$/m.test(text);
}

function removeProviderTable(text) {
  return text
    .replace(/\n?\[model_providers\.lane\]\s*\n(?:(?!\[).*\n?)*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n*$/, "\n");
}
