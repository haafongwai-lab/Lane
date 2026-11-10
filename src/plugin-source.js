/**
 * What a plugin source file says it talks to.
 *
 * Used both by the audit scripts and by the plugin updater: before a new
 * version is applied, Lane compares the hosts and paths it names with the
 * installed copy, so "upgrade" is never a blind trust decision.
 */

const URL_RE = /https?:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z]{2,}[a-zA-Z0-9._/-]*/g;
const PATH_RE = /["'`](\/[a-zA-Z0-9][a-zA-Z0-9._\-/{}:]*)/g;
const API_PREFIXES = ["/v1/", "/v2/", "/v3/", "/trae/", "/api/", "/billing/", "/cloudide/", "/plugin/"];

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
