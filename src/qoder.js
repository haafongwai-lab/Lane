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
import { redactBody, resolveRules, restoreResponse } from "./redact.js";
import { concealDshName } from "./sanitize.js";
import { readSettings } from "./settings.js";
import { pluginEntryUrl } from "./plugin-store.js";

const SITE_EXPORTS = {
  qoder: "QoderAuthPlugin",
  "qoder-cn": "QoderCNAuthPlugin"
};
// The plugin renews a chat token this close to its end before a request
// (REFRESH_LEAD), and magpie renews at 10 minutes. Lane refreshes at the
// request threshold: renewing earlier spends rotating refresh tokens for
// nothing, and two Lane processes doing it would invalidate each other.
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const DOMAIN = { qoder: "qoder.com", "qoder-cn": "qoder.cn" };

function qoderSite(site) {
  const value = String(site || "");
  return value === "qoder-cn" ? "qoder-cn" : "qoder";
}

/**
 * Qoder is the third upstream.
 *
 * Its community plugin has the same OpenCode shape as WorkBuddy's and Trae's,
 * so this class reuses WorkBuddyProvider's session/model/refresh machinery and
 * overrides only what differs:
 *
 * - the plugin exports one factory per Qoder site (international, CN);
 * - accounts live in a provider-scoped data directory, so neither the
 *   WorkBuddy store nor Trae's is touched;
 * - its loader already speaks OpenAI chat completions in both directions, so
 *   chat needs only Lane's outbound redaction — WorkBuddy's `prepareChat`
 *   rewrites are WorkBuddy's, not Qoder's;
 * - `auth.checkin` is the vendor's daily-credits claim, which Lane's check-in
 *   round prefers over its own WorkBuddy HTTP path.
 */
export class QoderProvider extends WorkBuddyProvider {
  constructor({ env = process.env, ...options } = {}) {
    const baseEnv = env;
    const isolated = { ...env, LANE_DATA_DIR: path.join(dataDir(env), "providers", "qoder") };
    super({ ...options, env: isolated });
    this.baseEnv = baseEnv;
    this.ownedBy = "qoder";
    this.label = "Qoder";
    // Qoder's campaign reports one amount for the whole campaign — a live one
    // read 500 while the day grants 100 — so the hook's figure is not a
    // reward. Lane measures the account's balance around the claim instead.
    this.checkinRewardMeasured = true;
    this.qoderFactories = new Map();
  }

  /** A new plugin copy may change either site factory; drop both. */
  reloadPlugins() {
    this.qoderFactories.clear();
    return super.reloadPlugins();
  }

  async factoryFor(site) {
    const key = qoderSite(site);
    if (this.factory) return this.factory;
    if (this.qoderFactories.has(key)) return this.qoderFactories.get(key);
    let entry;
    try {
      const pluginUrl = await pluginEntryUrl("qoder-auth", this.env);
      entry = await import(pluginUrl.href);
    } catch (error) {
      throw new Error(
        `Qoder plugin copy is missing or unreadable at vendor/qoder-auth/index.mjs. (${error.message})`
      );
    }
    const factory = entry[SITE_EXPORTS[key]];
    if (typeof factory !== "function") {
      throw new Error(`Qoder plugin does not export ${SITE_EXPORTS[key]}`);
    }
    this.qoderFactories.set(key, factory);
    return factory;
  }

  async accounts() {
    await this.init();
    // No WorkBuddy label repair: Qoder names come from its own sign-in payload.
    this.state = await loadAccounts(this.env);
    return this.state.accounts.map(publicAccount);
  }

  async siteOf(id) {
    await this.init();
    const target = id || this.state.activeId;
    const account = this.state.accounts.find((item) => item.id === target);
    return qoderSite(account?.site);
  }

  /**
   * The device-flow sign-in, which is the method with no prompts. The plugin
   * also offers a PAT method and, on Qoder CN, enterprise VPC and dedicated
   * domain methods; those are not reachable from Lane yet, so the browser
   * flow is the one this picks.
   */
  async authorize(site = "qoder") {
    await this.init();
    const key = qoderSite(site);
    const hooks = await this.anonymousHooks(key);
    const method = hooks.auth.methods?.find(
      (item) => item?.type === "oauth" && !item.prompts?.length
    );
    if (!method) throw new Error("Qoder plugin has no browser sign-in method");
    const result = await this.withEgress(() => method.authorize());
    if (!result?.url) throw new Error("Qoder plugin returned no browser URL");
    return { ...result, site: key };
  }

  async finishSignIn(result, site = result?.site || "qoder", auth = null) {
    const outcome = auth || await this.withEgress(() => result?.callback?.());
    if (outcome?.type !== "success") {
      throw new Error(outcome?.error || "Qoder sign-in failed");
    }
    const key = qoderSite(site || result?.site);
    // Keep every field the plugin saved: `deviceToken` signs the usage read
    // and the daily check-in, and dropping it left the card and the check-in
    // without a token that worked.
    const stored = {
      ...outcome,
      type: "oauth",
      domain: String(outcome.domain || DOMAIN[key] || "").trim() || DOMAIN[key]
    };
    delete stored.callback;
    const id = accountIdOf(stored);
    if (!id) throw new Error("Qoder sign-in returned no account id");
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
    // Same lock as chat: a usage read and a chat can otherwise both rotate
    // the device token and log the account out upstream.
    await this.refreshIfNeeded(session);
    try {
      return await this.withEgress(() => session.hooks.auth.usage(async () => session.auth));
    } catch (error) {
      return { error: error?.message || "usage is unknown" };
    }
  }

  /**
   * Qoder's `auth.refresh` renews when the token is inside the plugin's own
   * lead, so calling it before every chat is cheap — but two Lane processes
   * can still rotate one refresh token at the same moment. Serialise the
   * renewal across processes, and skip it entirely when the token is fresh.
   */
  async refreshIfNeeded(session) {
    const target = session || (await this.activeSession());
    if (!target) return null;
    const expires = Number(target.auth?.expires) || 0;
    if (expires && expires - Date.now() > REFRESH_EARLY_MS) return target.auth;
    return crossProcessLock(path.join(dataDir(this.env), "qoder-refresh"), async () => {
      // Another process may have renewed while this one waited for the lock.
      this.state = await loadAccounts(this.env);
      const latest = this.state.accounts.find((item) => item.id === target.id);
      if (latest?.auth) target.auth = latest.auth;
      const current = Number(target.auth?.expires) || 0;
      if (current && current - Date.now() > REFRESH_EARLY_MS) return target.auth;
      return super.refreshIfNeeded(target);
    });
  }

  /**
   * The plugin's loader already speaks OpenAI chat completions both ways:
   * the request is a standard chat body and the reply is a standard
   * `chat.completion` / `chat.completion.chunk` stream. Only Lane's outbound
   * redaction applies — `prepareChat` is WorkBuddy's rewriting and would
   * corrupt a Qoder request.
   */
  async chat(body, { signal, accountId = "" } = {}) {
    const session = accountId ? await this.session(accountId) : await this.activeSession();
    if (!session) throw new Error("Qoder is not signed in");
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
    // Qoder skips WorkBuddy's `prepareChat`, but not the one step that matters
    // for risk control: a prompt naming the harness is a signal the upstream
    // can read back. Same `hideDsh` setting WorkBuddy uses.
    const spoken = settings.hideDsh === false ? outgoing : concealDshName(outgoing).body;
    const endpoint = await this.baseURL(session.id);
    const response = await this.withEgress(() => loader.fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: body.stream ? "text/event-stream" : "application/json"
      },
      body: JSON.stringify(spoken),
      signal
    }));
    return restoreResponse(response, this.secrets);
  }
}
