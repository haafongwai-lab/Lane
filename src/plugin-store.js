import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dataDir } from "./config.js";
import { readSettings } from "./settings.js";
import {
  hostsInSource,
  pathsInSource,
  diffSets,
  exportsInSource,
  versionConstantsInSource,
  sizeOfSource
} from "./plugin-source.js";

/**
 * The real fetch, captured before any egress guard can replace the global.
 *
 * The updater talks to the npm registry, not to a provider, so it must not be
 * subject to the plugin egress allowlist. The guard swaps `globalThis.fetch`
 * for the duration of a provider's work (see egress.js); a status poll doing a
 * usage read while the user pressed 检查更新 made every registry request look
 * like third-party plugin traffic and get refused with "registry.npmjs.org is
 * not an allowed upstream host" — the check reported no update for a plugin
 * that had one. Capturing the native fetch at import time keeps this one call
 * out of that window.
 */
const nativeFetch = globalThis.fetch;

// Where the plugin metadata may be read from, in order. The public registry
// is the canonical source; the mirror is the same packages behind a CDN that
// answers from inside mainland China, where the canonical host times out.
const REGISTRIES = [
  "https://registry.npmjs.org",
  "https://registry.npmmirror.com"
];

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

// The registry that answered last. A mainland connection cannot reach the
// canonical host at all, so every check would otherwise pay its connect
// timeout before falling through to the mirror.
let preferredRegistry = "";

/**
 * One registry document.
 *
 * The first call races the registries and keeps whichever answers; later calls
 * go straight to it. A failure used to reach the user as undici's bare "fetch
 * failed", which says neither what happened nor what to do, so each cause is
 * named and every registry's outcome is reported when none works.
 */
export async function fetchJson(pathname, timeoutMs = 15000) {
  const order = preferredRegistry
    ? [preferredRegistry, ...REGISTRIES.filter((base) => base !== preferredRegistry)]
    : REGISTRIES;

  if (preferredRegistry) {
    const doc = await readRegistry(preferredRegistry, pathname, timeoutMs);
    if (doc.ok) return doc.value;
    // The preferred one went away; forget it and try the rest.
    preferredRegistry = "";
  }

  const failures = [];
  const attempts = REGISTRIES.map(async (base) => {
    const doc = await readRegistry(base, pathname, timeoutMs);
    if (!doc.ok) throw Object.assign(new Error(doc.reason), { base });
    return { base, value: doc.value };
  });

  // Racing keeps the slow, unreachable host from delaying the answer: the
  // mirror replies in a few hundred milliseconds while the canonical host is
  // still waiting for a connection that will never open.
  try {
    const first = await Promise.any(attempts);
    preferredRegistry = first.base;
    return first.value;
  } catch (error) {
    for (const item of error?.errors || []) failures.push(item?.message || String(item));
    throw new Error(failures.join("；") || "无法连接 npm registry");
  }
}

async function readRegistry(base, pathname, timeoutMs) {
  const url = `${base}${pathname}`;
  try {
    const response = await nativeFetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { ok: false, reason: `${hostOf(base)} 返回 ${response.status}` };
    return { ok: true, value: await response.json() };
  } catch (error) {
    return { ok: false, reason: `${hostOf(base)} ${reasonOf(error)}` };
  }
}

function hostOf(base) {
  return String(base).replace(/^https?:\/\//, "");
}

/** A cause the user can act on, not undici's "fetch failed". */
function reasonOf(error) {
  const code = String(error?.cause?.code || error?.code || "");
  if (code === "UND_ERR_CONNECT_TIMEOUT" || /timeout/i.test(code)) return "连接超时";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "域名解析失败";
  if (code === "ECONNREFUSED") return "拒绝连接";
  if (code === "ECONNRESET" || /socket hang up/i.test(String(error?.message))) return "连接被重置";
  if (/aborted/i.test(String(error?.message))) return "超时未响应";
  return String(error?.message || error || "未知错误");
}

/** The registry's `latest` document for one plugin, cached briefly. */
export async function latestInfo(key, env = process.env) {
  const spec = PLUGINS[key];
  if (!spec) throw new Error(`unknown plugin: ${key}`);
  const cacheKey = `${dataDir(env)}:${key}`;
  const hit = metaCache.get(cacheKey);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.value;
  const encoded = encodeURIComponent(spec.packageName).replace(/^%40/, "@");
  const doc = await fetchJson(`/${encoded}/latest`);
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
  const response = await nativeFetch(latest.tarball, { signal: AbortSignal.timeout(30000) });
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
  const publishedAt = await publishedTime(key, latest.version, env);
  await writeStaged(key, env, files);
  return {
    key,
    title: info.title,
    fromVersion: info.version,
    toVersion: String(pkg.version || latest.version || ""),
    license: String(pkg.license || ""),
    integrity: latest.integrity,
    publishedAt,
    upToDate: false,
    diff: {
      hosts: diffSets(hostsInSource(before), hostsInSource(after)),
      paths: diffSets(pathsInSource(before), pathsInSource(after)),
      // What else the upgrade carries, read from the two copies of the source.
      // The vendor ships no changelog, so this is the honest shape of "what
      // changed": factories, protocol version pins, and the file's size.
      exports: diffSets(exportsInSource(before), exportsInSource(after)),
      versions: versionConstantDiff(before, after),
      size: { from: sizeOfSource(before), to: sizeOfSource(after) }
    }
  };
}

/**
 * The release time of one version, from the registry's packument.
 *
 * The `/latest` document carries no `time`, so this is a second read — but it
 * happens only when a user opens an update, for one plugin. A failure is not
 * fatal: the summary simply omits the date.
 */
async function publishedTime(key, version, env = process.env) {
  try {
    const spec = PLUGINS[key];
    const encoded = encodeURIComponent(spec.packageName).replace(/^%40/, "@");
    const doc = await fetchJson(`/${encoded}`, 20000);
    return String(doc?.time?.[version] || "");
  } catch {
    return "";
  }
}

/** Which declared version constants moved between two copies. */
function versionConstantDiff(before, after) {
  const from = versionConstantsInSource(before);
  const to = versionConstantsInSource(after);
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  const changed = [];
  for (const name of keys) {
    if ((from[name] || "") === (to[name] || "")) continue;
    changed.push({ name, from: from[name] || "", to: to[name] || "" });
  }
  return changed;
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

/** Numeric-aware compare of two plugin versions; <0 when a is older. */
function compareVersions(a, b) {
  const parts = (v) => String(v || "").split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    return String(p ?? "") < String(q ?? "") ? -1 : 1;
  }
  return 0;
}

async function dirVersion(dir) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    return String(pkg?.version || "");
  } catch {
    return "";
  }
}

/**
 * Remove the external copy (or restore the backup) and use the built-in one.
 *
 * The backup is restored only when it is genuinely older. Applying the same
 * release twice leaves a backup of the version it replaced, so an unconditional
 * restore "rolled back" to the same version and the row then showed no update
 * at all — the release the user had found stayed invisible.
 */
export async function rollbackPlugin(key, env = process.env) {
  const backup = backupDir(key, env);
  const external = externalDir(key, env);
  const currentVersion = await dirVersion(external);
  await fs.rm(external, { recursive: true, force: true });
  if (await exists(backup)) {
    const backupVersion = await dirVersion(backup);
    const older = backupVersion && (!currentVersion || compareVersions(backupVersion, currentVersion) < 0);
    if (older) {
      await fs.rename(backup, external);
    } else {
      // Not a rollback: same or newer than what it would replace. Drop it and
      // fall through to the built-in copy.
      await fs.rm(backup, { recursive: true, force: true });
    }
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

