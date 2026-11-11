import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dataDir } from "./config.js";
import { readSettings } from "./settings.js";
import { hostsInSource, pathsInSource, diffSets } from "./plugin-source.js";

/**
 * The vendored upstream plugins, and the updater around them.
 *
 * The copy shipped in vendor/ is the fallback and the known-good baseline. A
 * newer copy, when the user asks for one, lives under
 * `%LOCALAPPDATA%\lane\plugins\<key>\` and is what the providers load first.
 * Nothing is ever replaced silently: a download is staged, the hosts and paths
 * it names are diffed against the installed copy, and the user applies it after
 * reading that diff. A failed load falls back to the older copy.
 */

export const PLUGINS = {
  "workbuddy-auth": {
    title: "WorkBuddy Auth",
    packageName: "@magpie-community/opencode-workbuddy-auth",
    builtin: "workbuddy-auth",
    description: "WorkBuddy 国内版 / 海外版的登录、模型与请求适配"
  },
  "trae-auth": {
    title: "Trae Auth",
    packageName: "@magpie-community/opencode-trae-auth",
    builtin: "trae-auth",
    description: "Trae CN / Trae Global 的登录、模型与请求适配"
  },
  "qoder-auth": {
    title: "Qoder Auth",
    packageName: "@magpie-community/opencode-qoder-auth",
    builtin: "qoder-auth",
    description: "Qoder 国际版 / 国内版的登录、模型与请求适配"
  }
};

export const PLUGIN_KEYS = Object.keys(PLUGINS);

export function pluginRoot(env = process.env) {
  return path.join(dataDir(env), "plugins");
}

function builtinDir(key) {
  return fileURLToPath(new URL(`../vendor/${PLUGINS[key].builtin}/`, import.meta.url));
}

function externalDir(key, env) {
  return path.join(pluginRoot(env), key);
}

function stagingDir(key, env) {
  return path.join(pluginRoot(env), ".staging", key);
}

function backupDir(key, env) {
  return path.join(pluginRoot(env), ".backup", key);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** The directory a provider should import for this plugin. */
export async function pluginDir(key, env = process.env) {
  const external = externalDir(key, env);
  if (await exists(path.join(external, "index.mjs"))) return external;
  return builtinDir(key);
}

/**
 * The URL a provider imports. An external install wins; the vendored copy is
 * the fallback, which is also what keeps a failed update from bricking Lane.
 */
export async function pluginEntryUrl(key, env = process.env) {
  if (!PLUGINS[key]) throw new Error(`unknown plugin: ${key}`);
  const external = externalDir(key, env);
  if (await exists(path.join(external, "index.mjs"))) {
    return pathToFileURL(path.join(external, "index.mjs"));
  }
  return pathToFileURL(path.join(builtinDir(key), "index.mjs"));
}

/** Local facts about one plugin: which copy is loaded, version, license, sha. */
export async function pluginInfo(key, env = process.env) {
  const spec = PLUGINS[key];
  if (!spec) throw new Error(`unknown plugin: ${key}`);
  const external = externalDir(key, env);
  const externalIndex = path.join(external, "index.mjs");
  const installed = await exists(externalIndex);
  const dir = installed ? external : builtinDir(key);
  const pkg = await readJson(path.join(dir, "package.json"));
  const indexFile = path.join(dir, "index.mjs");
  let sha = "";
  try {
    sha = createHash("sha256").update(await fs.readFile(indexFile)).digest("hex");
  } catch {}
  return {
    key,
    title: spec.title,
    packageName: spec.packageName,
    description: spec.description,
    installed,
    version: pkg?.version || "",
    license: pkg?.license || "",
    sha,
    path: installed ? external : "内置",
    // Even a first external install can be rolled back: removing it returns
    // the provider to the built-in copy that shipped with Lane.
    canRollback: installed || (await exists(backupDir(key, env)))
  };
}

export async function listPlugins(env = process.env) {
  return Promise.all(PLUGIN_KEYS.map((key) => pluginInfo(key, env)));
}

const META_TTL_MS = 10 * 60 * 1000;
const metaCache = new Map();

async function fetchJson(url, timeoutMs = 15000) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`registry answered ${response.status}`);
  return response.json();
}

/** The registry's `latest` document for one plugin, cached briefly. */
export async function latestInfo(key, env = process.env) {
  const spec = PLUGINS[key];
  if (!spec) throw new Error(`unknown plugin: ${key}`);
  const cacheKey = `${dataDir(env)}:${key}`;
  const hit = metaCache.get(cacheKey);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.value;
  const encoded = encodeURIComponent(spec.packageName).replace(/^%40/, "@");
  const doc = await fetchJson(`https://registry.npmjs.org/${encoded}/latest`);
  const value = {
    version: String(doc.version || ""),
    tarball: String(doc.dist?.tarball || ""),
    integrity: String(doc.dist?.integrity || ""),
    publishedAt: doc.time || ""
  };
  metaCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export async function checkUpdates(env = process.env) {
  const rows = [];
  for (const key of PLUGIN_KEYS) {
    const local = await pluginInfo(key, env);
    try {
      const latest = await latestInfo(key, env);
      rows.push({
        key,
        title: local.title,
        installedVersion: local.version,
        latestVersion: latest.version,
        updateAvailable: Boolean(latest.version && latest.version !== local.version),
        integrity: latest.integrity,
        error: ""
      });
    } catch (error) {
      rows.push({
        key,
        title: local.title,
        installedVersion: local.version,
        latestVersion: "",
        updateAvailable: false,
        error: error?.message || "无法连接 npm registry"
      });
    }
  }
  return rows;
}

/** Extract a gzipped npm tarball into a Map of `package/...` -> Buffer. */
export function untar(gz) {
  const buf = zlib.gunzipSync(gz);
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
    const data = buf.subarray(offset + 512, offset + 512 + size);
    if (name && !name.endsWith("/")) files.set(name.replace(/^\.\//, ""), Buffer.from(data));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function verifyIntegrity(buffer, integrity) {
  const match = /^sha512-(.+)$/.exec(String(integrity || ""));
  if (!match) return false;
  const actual = createHash("sha512").update(buffer).digest("base64");
  return actual === match[1];
}

async function currentSource(key, env) {
  const info = await pluginInfo(key, env);
  const file = info.installed
    ? path.join(externalDir(key, env), "index.mjs")
    : path.join(builtinDir(key), "index.mjs");
  return fs.readFile(file, "utf8");
}

async function writeStaged(key, env, files) {
  const dir = stagingDir(key, env);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, buffer] of files) {
    const base = path.basename(name);
    if (!["index.mjs", "opencode.mjs", "opencode2.mjs", "package.json", "README.md", "LICENSE", "NOTICE.md"].includes(base)) continue;
    await fs.writeFile(path.join(dir, base), buffer, { mode: 0o600 });
  }
  const entry = path.join(dir, "index.mjs");
  if (!(await exists(entry))) throw new Error("插件包中没有 index.mjs");
  // Import before it can replace anything: a module that cannot even load
  // must fail here, while the installed copy is still untouched.
  await import(pathToFileURL(entry).href);
  return dir;
}

/**
 * Download and stage the latest release, returning the diff a user needs to
 * approve. Nothing under plugins/<key>/ is changed until applyUpdate().
 */
export async function stageUpdate(key, env = process.env) {
  const info = await pluginInfo(key, env);
  const latest = await latestInfo(key, env);
  if (!latest.version || latest.version === info.version) {
    return { key, upToDate: true, ...info };
  }
  if (!latest.tarball) throw new Error("registry did not return a tarball");
  const response = await fetch(latest.tarball, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`下载插件包失败：${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!verifyIntegrity(buffer, latest.integrity)) {
    throw new Error("插件包校验失败：SHA-512 与 registry 不一致，已拒绝安装");
  }
  const files = untar(buffer);
  const pkg = JSON.parse(files.get("package/package.json")?.toString("utf8") || "{}");
  const before = await currentSource(key, env);
  const after = files.get("package/index.mjs")?.toString("utf8") || "";
  if (!after) throw new Error("插件包中没有 index.mjs");
  await writeStaged(key, env, files);
  return {
    key,
    title: info.title,
    fromVersion: info.version,
    toVersion: String(pkg.version || latest.version || ""),
    license: String(pkg.license || ""),
    integrity: latest.integrity,
    upToDate: false,
    diff: {
      hosts: diffSets(hostsInSource(before), hostsInSource(after)),
      paths: diffSets(pathsInSource(before), pathsInSource(after))
    }
  };
}

async function backupCurrent(key, env) {
  const external = externalDir(key, env);
  if (!(await exists(external))) return false;
  const backup = backupDir(key, env);
  await fs.rm(backup, { recursive: true, force: true });
  await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
  await fs.rename(external, backup);
  return true;
}

/** Apply the staged copy, keeping the previous external copy for rollback. */
export async function applyUpdate(key, env = process.env) {
  const stage = stagingDir(key, env);
  if (!(await exists(path.join(stage, "index.mjs")))) {
    throw new Error("没有待安装的插件，请先检查更新");
  }
  await backupCurrent(key, env);
  await fs.mkdir(pluginRoot(env), { recursive: true, mode: 0o700 });
  try {
    await fs.rename(stage, externalDir(key, env));
  } catch (error) {
    // The old external copy was moved aside before the new one landed; put it
    // back so a failed install is not a failed install *and* a lost old copy.
    const backup = backupDir(key, env);
    if (await exists(backup)) {
      await fs.rename(backup, externalDir(key, env)).catch(() => {});
    }
    throw error;
  }
  return pluginInfo(key, env);
}

/** Remove the external copy (or restore the backup) and use the built-in one. */
export async function rollbackPlugin(key, env = process.env) {
  const backup = backupDir(key, env);
  const external = externalDir(key, env);
  await fs.rm(external, { recursive: true, force: true });
  if (await exists(backup)) {
    await fs.rename(backup, external);
  }
  return pluginInfo(key, env);
}

/** The staged diff, if a download is waiting. */
export async function stagedPreview(key, env = process.env) {
  const stage = stagingDir(key, env);
  if (!(await exists(path.join(stage, "index.mjs")))) return null;
  try {
    const pkg = await readJson(path.join(stage, "package.json"));
    return { key, version: pkg?.version || "", license: pkg?.license || "" };
  } catch {
    return null;
  }
}

/**
 * The opt-in automatic path. It only installs a release whose host and path
 * sets are unchanged: a new endpoint is exactly what a user must review, and
 * applying it silently would defeat the point of the updater.
 *
 * A release with additions is downloaded and staged, then left as "pending" —
 * the plugin page shows it with the diff and waits for a click.
 */
export async function autoUpdate(env = process.env) {
  const settings = await readSettings(env).catch(() => ({}));
  if (settings.pluginAutoUpdate !== true) return { skipped: true, results: [] };
  const results = [];
  for (const key of PLUGIN_KEYS) {
    try {
      const preview = await stageUpdate(key, env);
      if (preview.upToDate) {
        results.push({ key, action: "current" });
        continue;
      }
      const additions = (preview.diff?.hosts?.added?.length || 0) + (preview.diff?.paths?.added?.length || 0);
      if (additions > 0) {
        results.push({ key, action: "needs-review", preview });
        continue;
      }
      const info = await applyUpdate(key, env);
      results.push({ key, action: "updated", version: info.version });
    } catch (error) {
      results.push({ key, action: "error", error: error?.message || "update failed" });
    }
  }
  return { skipped: false, results };
}

