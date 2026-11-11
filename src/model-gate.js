import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { writeTextAtomic } from "./agents/store.js";
import { crossProcessLock } from "./accounts.js";

/**
 * The model allowlist: only models the user has explicitly added are served
 * to agents (the /v1/models list, and requests resolved from it).
 *
 * The upstream catalogues are big — WorkBuddy and Trae each publish dozens of
 * models, and agents read the whole list — so the app exposes the full list in
 * the 模型 directory page and a per-model 添加 switch gates what agents see.
 *
 * Entries are provider-scoped: `workbuddy:hy3` and `trae:hy3` are different
 * choices even though the ids match. Bare ids in an old models.json are kept
 * as legacy entries and match every provider until the user changes that row.
 *
 * Nothing is added by default: an install with no models.json serves an empty
 * catalogue until the user picks models. That is deliberate (the list is an
 * opt-in), and the page says so instead of looking broken.
 */

const FILE = "models.json";
// Last successfully parsed selection per data directory. A transient read or
// parse failure (an antivirus rename, a half-written hand edit) must not
// silently disable every model until the next successful write.
const lastGood = new Map();

function providerOf(model) {
  return String(model?.owned_by || model?.provider || "workbuddy");
}

// A provider may already hand back an id that carries its own prefix (a saved
// allowlist entry read back through a provider that kept it). The key must not
// stack the prefix on top: `trae:trae:glm-5.3` matched nothing and read as
// "enabled" while every request for it was refused.
function bareOf(id) {
  const name = String(id);
  for (const known of ["workbuddy", "trae", "qoder"]) {
    if (name.startsWith(`${known}:`)) return name.slice(known.length + 1);
  }
  return name;
}

function keyOf(id, provider = "") {
  return provider ? `${provider}:${bareOf(id)}` : String(id);
}

async function readModels(env = process.env) {
  const file = path.join(dataDir(env), FILE);
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    // No file is a fresh install: nothing is enabled. A read error is not
    // the same thing and must not silently disable every model.
    if (error?.code === "ENOENT") {
      lastGood.delete(file);
      return { ids: new Set(), corrupt: false };
    }
    return { ids: new Set(lastGood.get(file) || []), corrupt: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const ids = new Set(normaliseIds(parsed.map(String)));
      lastGood.set(file, ids);
      return { ids, corrupt: false };
    }
    if (Array.isArray(parsed?.ids)) {
      const ids = new Set(normaliseIds(parsed.ids.map(String)));
      lastGood.set(file, ids);
      return { ids, corrupt: false };
    }
  } catch {}
  return { ids: new Set(lastGood.get(file) || []), corrupt: true };
}

/** The models agents may use; empty until the user adds some. */
export async function allowedModels(env = process.env) {
  return (await readModels(env)).ids;
}

/** The upstream catalogue, keeping only the models the user added. */
export async function restrictModels(models = [], env = process.env) {
  const { ids: allowed } = await readModels(env);
  // A corrupt file falls back to the last good selection (or an empty set on
  // a fresh process); the page reports the corruption separately.
  return models.filter((model) => {
    const id = String(model?.id);
    if (allowed.has(id)) return true;
    if (allowed.has(keyOf(id, providerOf(model)))) return true;
    // A bare id saved before models were namespaced still selects the model
    // it named — but only for the provider that owns the bare namespace.
    //
    // `glm-5.3-flash-max` in the file means WorkBuddy's model of that name.
    // Letting it also match `trae:glm-5.3-flash-max` turned one old entry into
    // every provider's lookalike, so an account switched into the pool served
    // five models nobody had added.
    const bare = model?.bareId ? String(model.bareId) : "";
    if (!bare) return false;
    // Only the default provider's rows carry the plain id, so only they may
    // claim a bare entry.
    return providerOf(model) === "workbuddy" && allowed.has(bare);
  });
}

/**
 * Drops entries the current id scheme can never match.
 *
 * A broken key builder once prefixed an already-prefixed id, leaving
 * `trae:trae:glm-5.3` in the file. No row carries that id, so the page could
 * neither show it as on nor switch it off — it was stuck on, serving a model
 * the user believed was not enabled.
 *
 * Such an entry is dropped rather than repaired. Repairing would guess that
 * the stacked prefix meant the model underneath, but the only way it got
 * written was the bug itself, and a user who did mean to add that model can
 * add it again in one click. A stuck-on model nobody can turn off is the
 * worse failure.
 *
 * A `workbuddy:` prefix is a valid key and is left alone.
 */
export function normaliseIds(ids = []) {
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const name = String(raw || "");
    if (!name) continue;
    // A stacked prefix names nothing; drop it instead of guessing.
    if (/^(workbuddy|trae|qoder):(workbuddy|trae|qoder):/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Adds or removes one provider's model id in the allowlist. */
export async function setModelEnabled(id, enabled, env = process.env, provider = "") {
  const name = String(id || "");
  if (!name) return false;
  const key = keyOf(name, provider);
  // Two quick switches are two read-modify-write operations; without the
  // shared queue the later write drops the earlier choice.
  return crossProcessLock(path.join(dataDir(env), FILE), async () => {
    const { ids: allowed } = await readModels(env);
    if (enabled) {
      allowed.add(key);
    } else {
      allowed.delete(key);
      // A legacy bare id was a choice for every provider; removing this row
      // removes that broad choice rather than leaving it to reappear.
      allowed.delete(name);
    }
    await writeTextAtomic(
      path.join(dataDir(env), FILE),
      `${JSON.stringify({ version: 2, ids: normaliseIds([...allowed]) }, null, 2)}\n`
    );
    lastGood.set(path.join(dataDir(env), FILE), new Set(normaliseIds([...allowed])));
    return true;
  });
}

/** Whether one model id has been added, for one provider when named. */
export async function isModelEnabled(id, env = process.env, provider = "") {
  const { ids: allowed } = await readModels(env);
  const name = String(id || "");
  return allowed.has(name) || allowed.has(keyOf(name, provider));
}

/** Whether models.json could not be read or parsed; the page says so. */
export async function modelGateCorrupt(env = process.env) {
  return (await readModels(env)).corrupt;
}
