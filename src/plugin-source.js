/**
 * What a plugin source file says it talks to.
 *
 * Used both by the audit scripts and by the plugin updater: before a new
 * version is applied, Lane compares the hosts and paths it names with the
 * installed copy, so "upgrade" is never a blind trust decision.
 */

const URL_RE = /https?:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z]{2,}[a-zA-Z0-9._/-]*/g;
const PATH_RE = /["'`](\/[a-zA-Z0-9][a-zA-Z0-9._\-/{}:]*)/g;
const API_PREFIXES = ["/v1/", "/v2/", "/v3/", "/trae/", "/api/", "/algo/", "/sash/", "/billing/", "/cloudide/", "/plugin/"];

export function hostsInSource(text) {
  const hosts = new Set();
  for (const match of String(text).matchAll(URL_RE)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase();
      if (host === "github.com" || host.endsWith(".github.com")) continue;
      if (host === "registry.npmjs.org" || host === "www.npmjs.com") continue;
      hosts.add(host);
    } catch {}
  }
  return hosts;
}

export function pathsInSource(text) {
  const paths = new Set();
  for (const match of String(text).matchAll(PATH_RE)) {
    const value = match[1].split("?")[0];
    if (value.split("/").filter(Boolean).length < 2) continue;
    // Only API-shaped paths count: a plugin's comments and error strings also
    // contain filesystem paths like /root/... which are not endpoints.
    if (!API_PREFIXES.some((prefix) => value.startsWith(prefix))) continue;
    paths.add(value);
  }
  return paths;
}

export function diffSets(before, after) {
  const old = new Set(before);
  const next = new Set(after);
  return {
    added: [...next].filter((item) => !old.has(item)).sort(),
    removed: [...old].filter((item) => !next.has(item)).sort()
  };
}

/**
 * The plugin factories a source file exports.
 *
 * A new `…Plugin` export is a new provider or realm — the most consequential
 * change an upgrade can carry, and the one a user can read at a glance.
 */
export function exportsInSource(text) {
  const out = new Set();
  for (const match of String(text).matchAll(/export\s+(?:const|function|async function)\s+(\w*Plugin)\b/g)) {
    out.add(match[1]);
  }
  return out;
}

/**
 * The protocol version constants a plugin declares.
 *
 * WorkBuddy, Trae and Qoder all pin the build of the vendor client they
 * imitate (`clientVersion`, `ideVersion`, `pluginVersion`, `cosyVersion`).
 * When one of those moves, the upstream protocol changed and the new copy is
 * speaking a different dialect — worth seeing before an update is applied,
 * because it is exactly what breaks a chat when it is guessed wrong.
 */
export const VERSION_CONSTANTS = ["clientVersion", "clientVersionCode", "ideVersion", "ideVersionCode", "pluginVersion", "cosyVersion"];

export function versionConstantsInSource(text) {
  const out = {};
  const src = String(text);
  for (const key of VERSION_CONSTANTS) {
    const m = src.match(new RegExp(`\\b${key}\\s*:\\s*"([0-9][0-9A-Za-z.\\-]*)"`));
    if (m) out[key] = m[1];
  }
  return out;
}

/** Lines and bytes, so an upgrade's size is visible even when nothing else is. */
export function sizeOfSource(text) {
  const src = String(text);
  return { bytes: Buffer.byteLength(src), lines: src.split("\n").length };
}
