import { ALLOW_HOSTS, underFamily } from "./egress-hosts.js";
import { inspectRequest } from "./egress-paths.js";

/**
 * The outbound guard for vendored plugin traffic.
 *
 * The vendored plugins are whole, third-party files. They receive the full prompt
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
 *   "enforce"   allow the exact hosts and the provider families over https;
 *               refuse everything else with a named error.
 *
 * Every hop is checked. The guard fetches with `redirect: "manual"` and
 * follows the Location chain itself, so a 307 from an allowed host cannot
 * forward the (redacted) prompt body to a host the allowlist never named —
 * the old single-check fetch followed redirects invisibly, past the guard.
 * A refusal is never silent: it throws an `EgressBlocked` error whose message
 * names the host, and the caller records it.
 */

export const EGRESS_MODES = ["off", "monitor", "enforce"];
export const DEFAULT_EGRESS_MODE = "monitor";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export class EgressBlocked extends Error {
  constructor(host, url, reason = "host") {
    const cause = reason === "scheme"
      ? `outbound request blocked: ${host} is an allowed upstream host but the request is not https`
      : `outbound request blocked: ${host} is not an allowed upstream host`;
    super(cause);
    this.name = "EgressBlocked";
    this.kind = "egress-blocked";
    this.host = host;
    this.url = url;
    this.reason = reason;
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

function targetOf(input) {
  const raw = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input?.url;
  return String(raw || "");
}

function hostOf(input) {
  try {
    return new URL(targetOf(input)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Why an enforce-mode request may not leave, or null when it may.
 *
 * The host check is the allowlist; the scheme check closes the hole where an
 * allowed hostname answered over plain http — same name, no confidentiality.
 * Every real provider endpoint is https, so the check costs nothing honest.
 */
function enforceReason(verdict, url) {
  if (verdict === "third-party") return "host";
  try {
    if (new URL(url).protocol !== "https:") return "scheme";
  } catch {
    return "host";
  }
  return null;
}

/**
 * Wraps a `fetch` so every call and every redirect hop is checked and recorded.
 *
 * `record` receives `{ host, verdict, mode, blocked, url }` plus the request
 * audit from `inspectRequest` (path, body size, suspicious reasons); the
 * control center feeds it a bounded in-memory list the settings page shows.
 * A missing `record` still enforces, so the guard is never a no-op by
 * accident.
 *
 * The audit never blocks. Only the host and scheme checks refuse traffic,
 * because a path heuristic that guessed wrong would break a chat for no
 * security gain.
 *
 * Redirects are followed manually so each hop pays the same check and the
 * same record. 307/308 keep the method and body; 301/302/303 degrade a POST
 * to a GET without one, as a browser would. A `Request` object whose body is
 * a stream cannot be replayed on a 307 — the redirect response is returned
 * as-is in that case, the same thing `redirect: "manual"` would hand back.
 */
export function createEgressGuard({
  mode = DEFAULT_EGRESS_MODE,
  record = () => {},
  realFetch = globalThis.fetch
} = {}) {
  const active = normalizeEgressMode(mode);
  const guarded = async (input, init) => {
    const first = targetOf(input);
    let url = first;
    let method = String(init?.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
    let body = init?.body !== undefined ? init.body : (typeof input === "object" && !(input instanceof URL) ? input?.body : undefined);
    const headers = init?.headers ?? (typeof input === "object" && !(input instanceof URL) ? input?.headers : undefined);
    for (let hop = 0; ; hop += 1) {
      const host = hostOf(url);
      const verdict = classifyHost(host);
      const reason = active === "enforce" ? enforceReason(verdict, url) : null;
      const blocked = Boolean(reason);
      let pathname = "";
      try {
        pathname = new URL(url).pathname;
      } catch {}
      const audit = inspectRequest({
        pathname,
        body,
        method
      });
      try {
        record({
          host,
          verdict,
          mode: active,
          blocked,
          url: url.slice(0, 300),
          ...(hop ? { redirect: hop } : {}),
          ...audit
        });
      } catch {}
      if (blocked) throw new EgressBlocked(host, url, reason);
      const response = await realFetch(url, {
        ...init,
        method,
        headers,
        body,
        redirect: "manual"
      });
      if (!REDIRECT_STATUSES.has(response.status) || hop >= MAX_REDIRECTS) return response;
      const location = response.headers?.get?.("location");
      if (!location) return response;
      let next;
      try {
        next = new URL(location, url);
      } catch {
        return response;
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") return response;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      url = next.href;
    }
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
