import fs from "node:fs/promises";
import path from "node:path";
import { codexConfigPath } from "./paths.js";
import { readState, writeState, writeTextAtomic } from "./store.js";
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
    models: models.map((model, index) => {
      const efforts = Array.isArray(model.efforts) ? model.efforts : [];
      return {
        slug: model.id,
        display_name: model.name || model.id,
        description: `${model.name || model.id} via Lane`,
        base_instructions: "You are a helpful coding agent.",
        default_reasoning_level: efforts.length ? defaultEffort(efforts) : null,
        supported_reasoning_levels: efforts.map((effort) => ({
          effort,
          description: effortDescription(effort)
        })),
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
        supports_reasoning_summaries: efforts.length > 0
      };
    })
  };
}

function defaultEffort(efforts) {
  for (const preferred of ["medium", "high", "low"]) {
    if (efforts.includes(preferred)) return preferred;
  }
  return efforts.find((effort) => effort !== "none") || efforts[0];
}

function effortDescription(effort) {
  return {
    none: "No additional reasoning",
    minimal: "Minimal reasoning for the fastest responses",
    low: "Fast responses with lighter reasoning",
    medium: "Balances speed and reasoning depth for everyday tasks",
    high: "Greater reasoning depth for complex problems",
    xhigh: "Extra high reasoning depth for complex problems",
    max: "Maximum reasoning depth for the hardest problems",
    ultra: "Maximum reasoning with automatic task delegation"
  }[effort] || `${effort} reasoning`;
}

export async function connectCodex({ env = process.env, gateway = gatewayBase(), providerModels } = {}) {
  // The model list is asked for before anything is written: a provider that
  // cannot be reached must not leave config.toml pointing at a gateway whose
  // wiring state was never recorded — disconnect would have nothing to undo.
  let models = null;
  if (typeof providerModels === "function") models = await providerModels();
  const configPath = codexConfigPath(env);
  const state = await readState(env);
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const existing = state[PROVIDER];
  const hadProviderTable = hasProviderTable(text);
  const saved = existing || {
    previous: {
      model_provider: topValue(text, "model_provider"),
      model_catalog_json: topValue(text, "model_catalog_json"),
      hadProviderTable,
      providerTable: hadProviderTable ? providerTableBlock(text) : ""
    }
  };
  if (saved.previous && !Object.hasOwn(saved.previous, "providerTable")) {
    // Wiring written before the provider table was kept in the snapshot left
    // only Lane's own table in the file; the user's original, if there ever
    // was one, is not recoverable, so restoring nothing beats restoring
    // Lane's stale table.
    saved.previous.providerTable = "";
  }
  let next = setTopValue(text, "model_provider", `"${PROVIDER}"`);
  next = setTopValue(next, "model_catalog_json", '"lane-models.json"');
  next = hasProviderTable(next)
    ? replaceProviderTable(next, providerTable(gateway))
    : `${next.replace(/\s*$/, "\n\n")}${providerTable(gateway)}`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  // The catalog lands before the config that points at it: config.toml is
  // the commit step, and a failure above it leaves the machine untouched.
  if (models) {
    const catalogPath = path.join(path.dirname(configPath), "lane-models.json");
    await writeTextAtomic(catalogPath, catalogText(models));
  }
  await writeTextAtomic(configPath, next);
  state[PROVIDER] = { ...saved, connected: true, gateway, configPath };
  await writeState(state, env);
  return { agent: "codex", connected: true, gateway, restartRequired: true };
}

export async function syncCodexCatalog({ env = process.env, models = [] } = {}) {
  const state = await readState(env);
  const saved = state[PROVIDER];
  if (!saved?.connected) return { changed: false };
  const configPath = saved.configPath || codexConfigPath(env);
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { changed: false };
  }
  if (unquote(topValue(text, "model_provider")) !== PROVIDER) return { changed: false };
  const catalogPath = path.join(path.dirname(configPath), "lane-models.json");
  const configured = unquote(topValue(text, "model_catalog_json"));
  if (!configured || path.resolve(path.dirname(configPath), configured) !== catalogPath) {
    return { changed: false };
  }
  const next = catalogText(models);
  let current = "";
  try {
    current = await fs.readFile(catalogPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (current === next) return { changed: false };
  await writeTextAtomic(catalogPath, next);
  return { changed: true };
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
  if (saved.previous?.providerTable) {
    text = replaceProviderTable(text, saved.previous.providerTable);
  } else if (!saved.previous?.hadProviderTable) {
    text = removeProviderTable(text);
  }
  await writeTextAtomic(configPath, text);
  if (!saved.previous?.model_catalog_json) {
    await fs.rm(path.join(path.dirname(configPath), "lane-models.json"), { force: true });
  }
  delete state[PROVIDER];
  await writeState(state, env);
  return { agent: "codex", connected: false, changed: true, restartRequired: true };
}

// The top-level region of a Codex config: the lines before the first
// [section] header. `model_provider` and `model_catalog_json` are top-level
// keys, but Codex profiles set `model_provider` inside their own
// [profiles.<name>] sections too — key edits that scanned the whole file
// rewrote or deleted those, silently breaking the user's profiles.
function topLevelEnd(lines) {
  const end = lines.findIndex((line) => /^\s*\[/.test(line));
  return end < 0 ? lines.length : end;
}

function topValue(text, key) {
  const lines = text.split(/\r?\n/);
  const line = lines
    .slice(0, topLevelEnd(lines))
    .find((entry) => new RegExp(`^${key}\\s*=`).test(entry));
  return line ? line.replace(new RegExp(`^${key}\\s*=\\s*`), "").trim() : "";
}

function unquote(value = "") {
  return value.replace(/^"(.*)"$/, "$1");
}

function catalogText(models) {
  return `${JSON.stringify(catalog(models), null, 2)}\n`;
}

// Line-ending preservation: splitLines remembers which style the file uses
// and finish() writes it back with the same one. Editing with split(/\r?\n/)
// and join("\n") used to rewrite CRLF files as LF — a connect+disconnect
// roundtrip was not byte-reversible, and the restored provider table (kept
// verbatim, CRLF and all) mixed styles into the bargain.
function splitLines(text) {
  return { crlf: /\r\n/.test(text), lines: text.split(/\r?\n/) };
}

function finishLines(lines, crlf) {
  const eol = crlf ? "\r\n" : "\n";
  const body = lines.join(eol).replace(/\s*$/, "");
  return body ? `${body}${eol}` : "";
}

function collapseBlanks(lines) {
  const out = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.trim()) {
      blanks = 0;
      out.push(line);
      continue;
    }
    blanks += 1;
    if (blanks <= 1) out.push(line);
  }
  return out;
}

function setTopValue(text, key, value) {
  const { crlf, lines } = splitLines(text);
  const pattern = new RegExp(`^${key}\\s*=`);
  const index = lines.slice(0, topLevelEnd(lines)).findIndex((line) => pattern.test(line));
  const replacement = `${key} = ${value}`;
  if (index >= 0) lines[index] = replacement;
  else lines.unshift(replacement);
  return finishLines(lines, crlf);
}

function removeTopValue(text, key) {
  const { crlf, lines } = splitLines(text);
  const pattern = new RegExp(`^${key}\\s*=`);
  const limit = topLevelEnd(lines);
  return finishLines(
    lines.filter((line, index) => index >= limit || !pattern.test(line)),
    crlf
  );
}

// Codex accepts the table name quoted or bare, and a config written by hand
// may use either form; the matchers below recognise both. Matching only the
// bare form used to leave the user's quoted table in place while Lane added
// a second `[model_providers.lane]` — TOML's last-wins rule made the pair
// look like one table, but the user's was never replaced and a disconnect
// could not restore it cleanly.
function laneTableStart(line) {
  return /^\[model_providers\.(?:"lane"|lane)\][ \t]*$/.test(line);
}

function hasProviderTable(text) {
  return splitLines(text).lines.some(laneTableStart);
}

// The table block: its header line plus every line up to the next header.
function tableEnd(lines, start) {
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return end;
}

function providerTableBlock(text) {
  const { lines } = splitLines(text);
  const start = lines.findIndex(laneTableStart);
  if (start < 0) return "";
  return `${lines.slice(start, tableEnd(lines, start)).join("\n")}\n`;
}

// Replaces the first Lane provider table with `table` and drops any other
// Lane tables — duplicates an older Lane version could leave behind, quoted
// and bare alike. An empty `table` removes every one of them.
function spliceProviderTable(text, table) {
  const { crlf, lines } = splitLines(text);
  if (!lines.some(laneTableStart)) return text;
  const out = [];
  let skipping = false;
  let inserted = false;
  for (const line of lines) {
    if (laneTableStart(line)) {
      skipping = true;
      if (!inserted && table) {
        out.push(...splitLines(table.replace(/\r?\n$/, "")).lines);
        inserted = true;
      }
      continue;
    }
    if (skipping) {
      // The block runs to the next header of any kind; a header line ends
      // the skip and is kept.
      if (/^\s*\[/.test(line)) {
        skipping = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return finishLines(collapseBlanks(out), crlf);
}

function replaceProviderTable(text, table) {
  return spliceProviderTable(text, table);
}

function removeProviderTable(text) {
  return spliceProviderTable(text, "");
}
