import { ALLOW_HOSTS, underFamily } from "./egress-hosts.js";
import { inspectRequest } from "./egress-paths.js";

/**
 * The outbound guard for vendored plugin traffic.
 *
 * The two plugins are whole, third-party files. They receive the full prompt
 * and the account tokens, and in Node they can call `fetch` on anything. This
 * module is the one place that decides which hosts that traffic may reach, so
 * "trust the plugin" becomes "trust the plugin plus this list".
 *
 * Three modes, set in settings.json as `egressMode`:
 *
 *   "off"       no checks at all.
 *   "monitor"   allow everything, but record every host (the default: a new
 *               provider endpoint shows up in the log instead of breaking a
 *               chat, and a third-party host shows up before anyone is hurt).
 *   "enforce"   allow the exact hosts and the provider families; refuse the
 *               rest with a named error.
 *
 * A refusal is never silent: it throws an `EgressBlocked` error whose message
 * names the host, and the caller records it. That is what turns "the gateway
 * broke one day" into "a host was blocked, here it is".
 */

export const EGRESS_MODES = ["off", "monitor", "enforce"];
export const DEFAULT_EGRESS_MODE = "monitor";

export class EgressBlocked extends Error {
  constructor(host, url) {
    super(`outbound request blocked: ${host} is not an allowed upstream host`);
    this.name = "EgressBlocked";
    this.kind = "egress-blocked";
    this.host = host;
    this.url = url;
  }
}

export function normalizeEgressMode(value) {
  const mode = String(value || "").toLowerCase();
  return EGRESS_MODES.includes(mode) ? mode : DEFAULT_EGRESS_MODE;
}

/** Classifies one hostname: "allowed" | "family" | "third-party". */
export function classifyHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return "third-party";
  if (ALLOW_HOSTS.has(host)) return "allowed";
  if (underFamily(host)) return "family";
  return "third-party";
}

function hostOf(input) {
  const raw = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input?.url;
  try {
    return new URL(String(raw)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function urlOf(input) {
  const raw = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input?.url;
  return String(raw || "");
}

/**
 * Wraps a `fetch` so every call is checked and recorded.
 *
 * `record` receives `{ host, verdict, mode, blocked, url }` plus the request
 * audit from `inspectRequest` (path, body size, suspicious reasons); the
 * control center feeds it a bounded in-memory list the settings page shows.
 * A missing `record` still enforces, so the guard is never a no-op by
 * accident.
 *
 * The audit never blocks. Only the host check refuses traffic, because a path
 * heuristic that guessed wrong would break a chat for no security gain.
 */
export function createEgressGuard({
  mode = DEFAULT_EGRESS_MODE,
  record = () => {},
  realFetch = globalThis.fetch
} = {}) {
  const active = normalizeEgressMode(mode);
  const guarded = async (input, init) => {
    const host = hostOf(input);
    const verdict = classifyHost(host);
    const blocked = active === "enforce" && verdict === "third-party";
    const url = urlOf(input);
    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch {}
    const audit = inspectRequest({
      pathname,
      body: init?.body,
      method: init?.method || input?.method || "GET"
    });
    try {
      record({
        host,
        verdict,
        mode: active,
        blocked,
        url: url.slice(0, 300),
        ...audit
      });
    } catch {}
    if (blocked) throw new EgressBlocked(host, url);
    return realFetch(input, init);
  };
  guarded.mode = active;
  return guarded;
}

/**
 * Installs a guard on `globalThis.fetch` and returns the previous value.
 *
 * The plugins call the global `fetch` directly (they were written for a host
 * that hands them a global), so the only way to cover every call — including
 * one inside a plugin's own helper — is to replace it for the duration of the
 * provider's work. `restore` puts it back.
 */
export function installEgressGuard(options = {}) {
  const previous = globalThis.fetch;
  // An explicit `realFetch` wins: tests inject a stub, and a caller that
  // already wrapped the global can hand its own inner fetch through instead
  // of having this module reach past it.
  const guarded = createEgressGuard({ ...options, realFetch: options.realFetch || previous });
  globalThis.fetch = guarded;
  return {
    guarded,
    restore() {
      if (globalThis.fetch === guarded) globalThis.fetch = previous;
    }
  };
}
