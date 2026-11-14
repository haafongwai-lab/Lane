import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readState, writeState, writeTextAtomic } from "./store.js";
import { gatewayBase } from "../config.js";

/**
 * DeepSeek Harness's model providers, as its current release reads them.
 *
 * The obvious file is the wrong one. `~/.dsh/settings.yaml` is an import
 * source from earlier releases: the settings plugin reads it once, writes
 * each section into the active profile's Cordis entry, and renames it to
 * `settings.yaml.imported` before the first write. Anything written there
 * afterwards is picked up only if the plugin re-imports, and what it does
 * with a section no plugin claims is to leave it in the renamed file. A
 * provider written to that path is silently inert.
 *
 * What the harness actually loads is the active profile's patch layer,
 * `~/.dsh/profiles/<name>/cordis.patch.yml`: a top-level YAML array of
 * loader entries whose `config` overrides the bundle's. Lane's provider lives
 * in the `llm-pi-ai` entry's `config.providers.lane`, beside the user's own
 * providers; the default model, set in `agent-default-model`, is only
 * routable when the provider declares the effort it asks for — a model entry
 * with no `reasoning.efforts` accepts no effort at all, which is how
 * `UNSUPPORTED_REASONING_EFFORT` is raised before any request is sent.
 *
 * The file is the user's: profile after profile of their own configuration,
 * and comments explaining the format. It is edited as text at the positions
 * Lane owns rather than parsed and re-emitted, so their ordering, comments
 * and quoting survive.
 */

const PROVIDER_ID = "lane";
const PI_AI_ENTRY = "llm-pi-ai";
const DEFAULT_MODEL_ENTRY = "agent-default-model";

export function dshHome(env = process.env) {
  return env.DSH_HOME ? path.resolve(env.DSH_HOME) : path.join(env.USERPROFILE || os.homedir(), ".dsh");
}

/** The profile the desktop app runs; a harness installed elsewhere may differ. */
export function dshProfile(env = process.env) {
  return env.DSH_PROFILE || "desktop";
}

export function dshPatchPath(env = process.env) {
  return path.join(dshHome(env), "profiles", dshProfile(env), "cordis.patch.yml");
}

// The refused-effort error names the model; these are the ids a catalogue
// can carry. A model with no declared effort is the one that broke.
const EFFORT_NAMES = { off: "Off", none: "None", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };

// YAML 1.1 reads these plain scalars as booleans, null or numbers. A model id
// that happens to spell one (`off`, `123`, `3.5`) would come back out of the
// patch file as the wrong type and misroute the request, so it gets quoted.
const YAML_AMBIGUOUS = /^(?:true|false|yes|no|on|off|null|~|\.nan|\.inf|-?0x[0-9a-fA-F]+|-?\d+(?:\.\d+)?(?::\d{1,3})*)$/i;

function yamlScalar(value) {
  const text = String(value ?? "");
  if (text === "") return '""';
  if (/^[\w][\w.\-/@ ]*$/.test(text) && !/[:#]/.test(text) && !YAML_AMBIGUOUS.test(text)) return text;
  return JSON.stringify(text);
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Finds a top-level entry of the patch array by its `id:` line, and the span
 * of its `config:` block. Both are measured from the file rather than
 * assumed: entries are `- id:` at column zero in this format, but the file a
 * user hands us may indent them under an anchor.
 */
function locateEntry(lines, id) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!new RegExp(`^\\s*-\\s+id:\\s*["']?${id}["']?\\s*$`).test(line)) continue;
    const dashIndent = indentOf(line);
    // The entry runs to the next line that starts another array item or ends
    // the document.
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim()) continue;
      if (/^\s*-/.test(next) && indentOf(next) <= dashIndent) {
        end = j;
        break;
      }
      if (indentOf(next) < dashIndent) {
        end = j;
        break;
      }
    }
    // `config:` sits one level in from the dash.
    let configStart = -1;
    let configIndent = -1;
    for (let j = i + 1; j < end; j += 1) {
      const inner = /^(\s*)config:\s*$/.exec(lines[j]);
      if (inner) {
        configStart = j;
        configIndent = inner[1].length;
        break;
      }
    }
    // Two spaces under `config:` is this format's convention, but measure the
    // first child when there is one.
    let childIndent = configIndent >= 0 ? configIndent + 2 : dashIndent + 4;
    if (configStart >= 0) {
      for (let j = configStart + 1; j < end; j += 1) {
        if (!lines[j].trim()) continue;
        childIndent = indentOf(lines[j]);
        break;
      }
    }
    return { start: i, end, configStart, configIndent, childIndent };
  }
  return null;
}

/** The span of `providers:` inside an entry's config, and of one entry in it. */
function locateProviders(lines, range) {
  if (!range || range.configStart < 0) return null;
  for (let i = range.configStart + 1; i < range.end; i += 1) {
    const m = /^(\s*)providers:\s*$/.exec(lines[i]);
    if (!m) continue;
    const providersIndent = m[1].length;
    let providersEnd = range.end;
    for (let j = i + 1; j < range.end; j += 1) {
      if (!lines[j].trim()) continue;
      if (indentOf(lines[j]) <= providersIndent) {
        providersEnd = j;
        break;
      }
    }
    // The provider ids are measured, not assumed to be providersIndent + 2.
    let entryIndent = -1;
    for (let j = i + 1; j < providersEnd; j += 1) {
      if (!lines[j].trim() || lines[j].trimStart().startsWith("#")) continue;
      entryIndent = indentOf(lines[j]);
      break;
    }
    if (entryIndent < 0) entryIndent = providersIndent + 2;
    let entry = null;
    for (let j = i + 1; j < providersEnd; j += 1) {
      const line = lines[j];
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      if (indentOf(line) !== entryIndent) continue;
      if (!new RegExp(`^\\s*${PROVIDER_ID}:\\s*$`).test(line)) continue;
      let end = providersEnd;
      for (let k = j + 1; k < providersEnd; k += 1) {
        if (!lines[k].trim()) continue;
        if (indentOf(lines[k]) <= entryIndent) {
          end = k;
          break;
        }
      }
      entry = [j, end];
      break;
    }
    return { start: i, end: providersEnd, entryIndent, entry };
  }
  return null;
}

/**
 * The lane provider block, with each model's reasoning efforts declared.
 *
 * The efforts are what Lane's own catalogue returned: the harness refuses an
 * effort a model does not declare, and a model entry with no `reasoning` key
 * declares nothing at all — the failure this module was written after.
 */
function providerBlock(models, entryIndent, gateway) {
  const pad = " ".repeat(entryIndent);
  const inner = " ".repeat(entryIndent + 2);
  const item = " ".repeat(entryIndent + 4);
  const field = " ".repeat(entryIndent + 6);
  const lines = [
    `${pad}${PROVIDER_ID}:`,
    `${inner}displayName: Lane`,
    `${inner}api: openai-completions`,
    `${inner}baseURL: ${gateway}/v1`,
    `${inner}headers:`,
    // The gateway reads this to attribute the request: the harness's own
    // client sends no User-Agent of its own, so without a marker every one of
    // its requests is journaled as a generic OpenAI client's.
    `${inner}  X-Lane-Client: dsh`,
    `${inner}  Authorization: Bearer lane`,
    `${inner}apiKey: lane`
  ];
  if (!models.length) {
    lines.push(`${inner}models: []`);
    return lines.join("\n");
  }
  lines.push(`${inner}models:`);
  for (const model of models) {
    lines.push(`${item}- id: ${yamlScalar(model.id)}`);
    lines.push(`${field}name: ${yamlScalar(model.name || model.id)}`);
    const efforts = Array.isArray(model.efforts) ? model.efforts.filter(Boolean) : [];
    if (efforts.length) {
      lines.push(`${field}reasoning:`);
      lines.push(`${field}  efforts:`);
      for (const effort of efforts) {
        lines.push(`${field}    - id: ${yamlScalar(effort)}`);
        lines.push(`${field}      name: ${yamlScalar(EFFORT_NAMES[effort] || effort)}`);
      }
      // The default the harness picks when the user names none: the highest
      // level the model takes, which is what a coding agent is expected to
      // reach for and never exceeds the declaration.
      lines.push(`${field}  defaultEffort: ${yamlScalar(efforts[efforts.length - 1])}`);
    }
  }
  return lines.join("\n");
}

/** The default-model entry, pointed at Lane and at an effort the model takes. */
function defaultModelBlock(entryIndent, modelId, effort) {
  const inner = " ".repeat(entryIndent + 2);
  return [
    `- id: ${DEFAULT_MODEL_ENTRY}`,
    `  name: "@deepseek-ai/dsh-agent-default-model"`,
    `  config:`,
    `${inner}provider: ${PROVIDER_ID}`,
    `${inner}model: ${yamlScalar(modelId)}`,
    `${inner}reasoningEffort: ${yamlScalar(effort)}`
  ].join("\n");
}

/**
 * The effort to set for the default model: the one the user already asked
 * for when the model supports it, else the model's own default. A default
 * that names an effort the model cannot take is exactly the failure this
 * repairs, so it is never preserved blindly.
 */
function effortFor(model, requested) {
  const efforts = Array.isArray(model?.efforts) ? model.efforts.filter(Boolean) : [];
  if (!efforts.length) return "";
  if (requested && efforts.includes(requested)) return requested;
  return efforts[efforts.length - 1];
}

/**
 * Points DeepSeek Harness at Lane in the file the harness actually loads.
 *
 * Returns { changed, models, configPath, defaultModel } and records the
 * wiring, so a disconnect removes exactly Lane's provider.
 */
export async function connectDsh({ env = process.env, gateway = gatewayBase(), providerModels } = {}) {
  const file = dshPatchPath(env);
  const state = await readState(env);

  let models = [];
  if (typeof providerModels === "function") {
    models = await providerModels().catch(() => []);
    if (!Array.isArray(models)) models = [];
  }

  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const hadFile = text !== "";
  const lines = hadFile ? text.split(/\r?\n/) : [];

  // The default the file asks for now, so a supported choice is kept.
  let requestedModel = "";
  let requestedEffort = "";
  const defaultRange = locateEntry(lines, DEFAULT_MODEL_ENTRY);
  if (defaultRange) {
    for (let i = defaultRange.start; i < defaultRange.end; i += 1) {
      const m = /^\s*model:\s*["']?([^"'\s#]+)["']?/.exec(lines[i]);
      if (m) requestedModel = m[1];
      const e = /^\s*reasoningEffort:\s*["']?([^"'\s#]+)["']?/.exec(lines[i]);
      if (e) requestedEffort = e[1];
    }
  }

  // Which model the default names: Lane's catalogue decides what it can take.
  const target = models.find((model) => model.id === requestedModel)
    || models.find((model) => model.id === "deepseek-v4.1-flash")
    || models[0]
    || null;
  const effort = target ? effortFor(target, requestedEffort) : "";

  const piRange = locateEntry(lines, PI_AI_ENTRY);
  const providers = locateProviders(lines, piRange);
  const entryIndent = providers?.entryIndent ?? 6;
  const block = providerBlock(models, entryIndent, gateway);

  let next;
  if (!hadFile) {
    // A profile with no patch layer yet: the array is Lane's own, with the
    // default-model entry only when a model was chosen.
    const parts = ["- id: llm-pi-ai", '  name: "@deepseek-ai/dsh-llm-pi-ai"', "  config:", "    providers:", block];
    if (target && effort) parts.push("", defaultModelBlock(2, target.id, effort));
    next = parts.join("\n");
  } else if (!piRange) {
    // The patch layer exists but never touched llm-pi-ai: append the entry.
    const body = text.replace(/\s*$/, "");
    next = `${body}\n\n- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n${block}\n`;
  } else if (!providers) {
    // The llm-pi-ai entry exists without a providers key.
    const insertAt = piRange.configStart >= 0 ? piRange.end : piRange.end;
    const child = " ".repeat(piRange.childIndent || 4);
    const out = [
      ...lines.slice(0, insertAt),
      `${child}providers:`,
      block,
      ...lines.slice(insertAt)
    ];
    next = out.join("\n");
  } else if (providers.entry) {
    const [start, end] = providers.entry;
    next = [...lines.slice(0, start), block, ...lines.slice(end)].join("\n");
  } else {
    next = [...lines.slice(0, providers.end), block, ...lines.slice(providers.end)].join("\n");
  }

  // The default model has to name an effort the model declares; a file that
  // already routes through Lane is repaired in place.
  if (target && effort) {
    const again = next.split(/\r?\n/);
    const range = locateEntry(again, DEFAULT_MODEL_ENTRY);
    if (range) {
      const fixed = defaultModelBlock(2, target.id, effort);
      // Replace only the three config lines, keeping the entry's name line
      // and anything else the user added to it.
      let providerAt = -1;
      for (let i = range.start; i < range.end; i += 1) {
        if (/^\s*provider:/.test(again[i])) { providerAt = i; break; }
      }
      if (providerAt >= 0) {
        const replaced = [
          ...again.slice(0, providerAt),
          `    provider: ${PROVIDER_ID}`,
          `    model: ${yamlScalar(target.id)}`,
          `    reasoningEffort: ${yamlScalar(effort)}`,
          // Drop the old model/effort lines that followed the provider line.
          ...again.slice(providerAt + 1).filter((line, k) => {
            const at = providerAt + 1 + k;
            if (at >= range.end) return true;
            return !/^\s*(model|reasoningEffort):/.test(line);
          })
        ];
        next = replaced.join("\n");
      } else {
        const insertAt = range.configStart >= 0 ? range.configStart + 1 : range.end;
        next = [
          ...again.slice(0, insertAt),
          `    provider: ${PROVIDER_ID}`,
          `    model: ${yamlScalar(target.id)}`,
          `    reasoningEffort: ${yamlScalar(effort)}`,
          ...again.slice(insertAt)
        ].join("\n");
      }
      void fixed;
    }
  }

  next = `${next.replace(/\s*$/, "")}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (next !== text) await writeTextAtomic(file, next);

  state.dsh = {
    connected: true,
    gateway,
    configPath: file,
    hadFile: state.dsh?.hadFile ?? hadFile
  };
  await writeState(state, env);

  return {
    agent: "dsh",
    connected: true,
    gateway,
    models: models.length,
    configPath: file,
    defaultModel: target ? { id: target.id, effort } : null,
    restartRequired: true
  };
}

/** Removes Lane's provider from the patch layer. */
export async function disconnectDsh({ env = process.env } = {}) {
  const file = dshPatchPath(env);
  const state = await readState(env);
  // No wiring record is not a reason to leave a lane provider in place: a
  // user who wired the harness by hand expects disconnect to remove it, and
  // the file is the truth about what is there.
  const saved = state.dsh || { hadFile: true };

  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!text) {
    delete state.dsh;
    await writeState(state, env);
    return { agent: "dsh", connected: false, changed: false };
  }

  const lines = text.split(/\r?\n/);
  const range = locateEntry(lines, PI_AI_ENTRY);
  const providers = locateProviders(lines, range);
  if (!providers?.entry) {
    delete state.dsh;
    await writeState(state, env);
    return { agent: "dsh", connected: false, changed: false };
  }

  const [start, end] = providers.entry;
  const next = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  // A patch layer Lane created entirely leaves as no file.
  if (!saved.hadFile && !next.trim()) {
    await fs.rm(file, { force: true });
  } else {
    await writeTextAtomic(file, `${next.replace(/\s*$/, "")}\n`);
  }
  delete state.dsh;
  await writeState(state, env);
  return { agent: "dsh", connected: false, changed: true, restartRequired: true };
}

/** Whether the harness's patch layer currently carries Lane's provider. */
export async function dshStatus({ env = process.env } = {}) {
  const file = dshPatchPath(env);
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { connected: false, configPath: file, installed: false };
  }
  const lines = text.split(/\r?\n/);
  const providers = locateProviders(lines, locateEntry(lines, PI_AI_ENTRY));
  return {
    connected: Boolean(providers?.entry),
    configPath: file,
    installed: true
  };
}
