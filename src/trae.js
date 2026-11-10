import path from "node:path";
import { dataDir } from "./config.js";
import {
  loadAccounts,
  upsertAccount,
  publicAccount,
  accountIdOf,
  crossProcessLock
} from "./accounts.js";
import { WorkBuddyProvider } from "./workbuddy.js";
import { SecretVault, redactBody, resolveRules, restoreResponse } from "./redact.js";
import { readSettings } from "./settings.js";
import { pluginEntryUrl } from "./plugin-store.js";

const SITE_EXPORTS = {
  "trae-cn": "TraeCNAuthPlugin",
  "trae-global": "TraeGlobalAuthPlugin"
};
// Same early-renewal window the plugin uses for `fresh`: a token this close
// to its end is renewed before a request instead of being sent and refused.
const REFRESH_EARLY_MS = 2 * 60 * 1000;

function traeSite(site) {
  const value = String(site || "");
  return value === "trae-global" ? "trae-global" : "trae-cn";
}

/**
 * Trae is the second upstream. Its community plugin has the same OpenCode
 * plugin shape as WorkBuddy's, so this class reuses WorkBuddyProvider's
 * session/model/refresh machinery and overrides only what differs:
 *
 * - the vendored Trae plugin exports two realm factories, not one per site;
 * - accounts live in a provider-scoped data directory, so the WorkBuddy
 *   account store (and its token mirror) is untouched;
 * - the plugin speaks Trae's own SSE behind an OpenAI-compatible loader.fetch,
 *   so chat does not run WorkBuddy's request rewriting.
 */
export class TraeProvider extends WorkBuddyProvider {
  constructor({ env = process.env, ...options } = {}) {
    const baseEnv = env;
    const isolated = { ...env, LANE_DATA_DIR: path.join(dataDir(env), "providers", "trae") };
    super({ ...options, env: isolated });
    this.baseEnv = baseEnv;
    this.ownedBy = "trae";
    this.traeFactories = new Map();
  }

  /** A new plugin copy may change either site factory; drop both. */
  reloadPlugins() {
    this.traeFactories.clear();
    return super.reloadPlugins();
  }

  async factoryFor(site) {
    const key = traeSite(site);
    if (this.factory) return this.factory;
    if (this.traeFactories.has(key)) return this.traeFactories.get(key);
    let entry;
    try {
      const pluginUrl = await pluginEntryUrl("trae-auth", this.env);
      entry = await import(pluginUrl.href);
    } catch (error) {
      throw new Error(
        `Trae plugin copy is missing or unreadable at vendor/trae-auth/index.mjs. (${error.message})`
      );
    }
    const factory = entry[SITE_EXPORTS[key]];
    if (typeof factory !== "function") {
      throw new Error(`Trae plugin does not export ${SITE_EXPORTS[key]}`);
    }
    this.traeFactories.set(key, factory);
    return factory;
  }

  async accounts() {
    await this.init();
    // No WorkBuddy label repair: Trae names come from its own sign-in payload.
    this.state = await loadAccounts(this.env);
    return this.state.accounts.map(publicAccount);
  }

  async siteOf(id) {
    await this.init();
    const target = id || this.state.activeId;
    const account = this.state.accounts.find((item) => item.id === target);
    return traeSite(account?.site);
  }

  async authorize(site = "trae-cn") {
    await this.init();
    const key = traeSite(site);
    const hooks = await this.anonymousHooks(key);
    const method = hooks.auth.methods?.find((item) => item.label?.includes("browser"));
    if (!method) throw new Error("Trae plugin has no browser sign-in method");
    const result = await this.withEgress(() => method.authorize());
    if (!result?.url) throw new Error("Trae plugin returned no browser URL");
    return { ...result, site: key };
  }

  async finishSignIn(result, site = result?.site || "trae-cn", auth = null) {
    // The callback polls Trae's token endpoint, so it is guarded too.
    const outcome = auth || await this.withEgress(() => result?.callback?.());
    if (outcome?.type !== "success") {
      throw new Error(outcome?.error || "Trae sign-in failed");
    }
    const key = traeSite(site || result?.site);
    const stored = {
      ...outcome,
      type: "oauth",
      domain: key === "trae-global" ? "www.trae.ai" : "www.trae.cn"
    };
    delete stored.callback;
    const id = accountIdOf(stored);
    if (!id) throw new Error("Trae sign-in returned no account id");
    await upsertAccount(stored, this.env, { activate: !this.state.activeId, site: key });
    this.sessions.delete(id);
    this.state = await loadAccounts(this.env);
    this.invalidateModels();
    return { ...stored, id, site: key };
  }

  async baseURL(id) {
    const session = await this.session(id);
    if (!session?.auth) return "";
    const loader = await this.loaderFor(session);
    return String(loader?.baseURL || "").replace(/\/+$/, "");
  }

  async usage(id) {
    await this.init();
    const session = await this.session(id);
    if (!session?.auth) return { error: "not signed in" };
    if (typeof session.hooks.auth?.usage !== "function") {
      return { error: "usage is not available" };
    }
    // Refresh under the same cross-process lock chat uses: a usage read and
    // a chat can otherwise both rotate one refresh token on separate Lane
    // processes, and the loser is logged out upstream.
    await this.refreshIfNeeded(session);
    try {
      return await this.withEgress(() => session.hooks.auth.usage(async () => session.auth));
    } catch (error) {
      return { error: error?.message || "usage is unknown" };
    }
  }

  /**
   * Trae's plugin `auth.refresh` renews unconditionally, unlike WorkBuddy's.
   * Calling it before every chat therefore rotates the refresh token on every
   * request; two Lane processes doing that invalidate each other and look like
   * random "sign-in expired" failures. Renew only when the access token is
   * near its end, and serialise that renewal across processes so only one
   * process spends a rotating refresh token.
   */
  async refreshIfNeeded(session) {
    const target = session || (await this.activeSession());
    if (!target) return null;
    const expires = Number(target.auth?.expires) || 0;
    if (expires && expires - Date.now() > REFRESH_EARLY_MS) return target.auth;
    return crossProcessLock(path.join(dataDir(this.env), "trae-refresh"), async () => {
      // Another process may have renewed while this one waited for the lock.
      // Re-read the account store and use its token instead of spending the
      // already-rotated refresh token a second time.
      this.state = await loadAccounts(this.env);
      const latest = this.state.accounts.find((item) => item.id === target.id);
      if (latest?.auth) target.auth = latest.auth;
      const current = Number(target.auth?.expires) || 0;
      if (current && current - Date.now() > REFRESH_EARLY_MS) return target.auth;
      return super.refreshIfNeeded(target);
    });
  }

  /**
   * The balance read that feeds the account chip. Trae's usage endpoint can
   * answer "sign-in expired" (a 401, or a lapsed-code path in the plugin)
   * while the agent's own requests keep working — the chat loader renews or
   * re-signs on demand, and a refusal there is the real test. A billing-page
   * hiccup must not paint the whole account as logged out, so the expired
   * flag is dropped here and the raw message kept for the tooltip.
   */
  async accountUsage(id) {
    const usage = await this.usage(id);
    if (usage && typeof usage === "object" && usage.signIn === "expired") {
      return { ...usage, signIn: "kept" };
    }
    return usage;
  }

  /**
   * Trae's loader already translates the OpenAI-shaped body to Trae's
   * protocol and back. Only Lane's outbound redaction is shared with
   * WorkBuddy; `prepareChat` is deliberately not used because its rewrites
   * are WorkBuddy's, not Trae's.
   */
  async chat(body, { signal } = {}) {
    const session = await this.activeSession();
    if (!session) throw new Error("Trae is not signed in");
    await this.refreshIfNeeded(session);
    const loader = await this.loaderFor(session);
    const settings = await readSettings(this.baseEnv).catch(() => ({
      redactSecrets: true,
      redactPersonal: true,
      redactRules: undefined,
      redactAllowlist: [],
      redactCustom: []
    }));
    const rules = resolveRules(settings.redactRules, {
      secrets: settings.redactSecrets !== false,
      personal: settings.redactPersonal !== false
    });
    const outgoing = settings.redactSecrets !== false
      ? redactBody(body, {
        vault: this.secrets,
        rules,
        allowlist: settings.redactAllowlist,
        custom: settings.redactCustom
      })
      : body;
    const endpoint = await this.baseURL(session.id);
    const response = await this.withEgress(() => loader.fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: body.stream ? "text/event-stream" : "application/json"
      },
      body: JSON.stringify(outgoing),
      signal
    }));
    return restoreResponse(response, this.secrets);
  }
}
