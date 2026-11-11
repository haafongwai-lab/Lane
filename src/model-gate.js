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

function keyOf(id, provider = "") {
  return provider ? `${provider}:${String(id)}` : String(id);
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
      const ids = new Set(parsed.map(String));
      lastGood.set(file, ids);
      return { ids, corrupt: false };
    }
    if (Array.isArray(parsed?.ids)) {
      const ids = new Set(parsed.ids.map(String));
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
    // it named. `trae:glm-5.3` is served when the file holds `glm-5.3`, so an
    // existing selection survives the multi-account upgrade instead of
    // silently emptying the agent's list.
    const bare = model?.bareId ? String(model.bareId) : "";
    if (bare && allowed.has(bare)) return true;
    return Boolean(bare) && allowed.has(keyOf(bare, providerOf(model)));
  });
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
      `${JSON.stringify({ version: 2, ids: [...allowed] }, null, 2)}\n`
    );
    lastGood.set(path.join(dataDir(env), FILE), new Set(allowed));
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
