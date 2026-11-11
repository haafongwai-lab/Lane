import {
  loadAccounts,
  upsertAccount,
  updateAccountAuth,
  updateAccountLabel,
  activateAccount,
  setAccountEnabled,
  setAccountRoutable,
  removeAccount,
  activeAccount,
  publicAccount,
  accountIdOf,
  normalizeSite
} from "./accounts.js";
import { prepareChat, restoreToolNames, resetSanitize } from "./sanitize.js";
import { SecretVault, redactBody, redactForLog, resolveRules, restoreResponse } from "./redact.js";
import { readSettings } from "./settings.js";
import { ERROR_KIND, withKind } from "./error-kind.js";
import { DEFAULT_EGRESS_MODE, installEgressGuard } from "./egress.js";
import { pluginEntryUrl } from "./plugin-store.js";

// The plugin is vendored under vendor/ so a fresh clone builds and runs with
// no registry access. The plugin updater can install a newer copy under the
// data directory; pluginEntryUrl() prefers it and falls back to this vendor
// copy, which is what keeps a failed update from bricking Lane.

// The plugin's models hook fetches /v3/config live on every call. Lane asks
// it from the model routes, the journal's rate lookup and the desktop
// status poll — without a short cache that is several upstream calls per
// request and twenty per minute of window polling, each adding a network
// round trip to the request's first byte.
const MODEL_CACHE_MS = 30_000;
// How long a chat request may wait for WorkBuddy's response head. The body
// itself streams for as long as the generation runs; only the wait for the
// upstream to accept the request is bounded.
const CHAT_HEADERS_TIMEOUT_MS = Number(process.env.LANE_UPSTREAM_TIMEOUT_MS) || 120_000;

/**
 * WorkBuddy plugins are OpenCode v1 plugins: a factory receives a client
 * and returns hooks. Lane supplies only the auth persistence the plugin
 * needs; everything vendor-specific stays in the plugin.
 *
 * One plugin instance runs per signed-in account, so the tokens a refresh
 * writes back land on the account that asked for them. Only the active
 * account carries requests; the others stay signed in and idle.
 */
export class WorkBuddyProvider {
  constructor({ env = process.env, factory = null, hooks = null } = {}) {
    this.env = env;
    this.factory = factory;
    this.state = { version: 1, activeId: "", accounts: [] };
    this.sessions = new Map();
    this.anonymous = new Map();
    // Hooks with no account behind them: only the static model catalogue
    // and the sign-in flow need them.
    this.hooks = hooks;
    this.models = [];
    this.ready = false;
    // One plugin per site: the domestic build and the international build are
    // separate packages with separate endpoints and separate catalogues.
    this.factories = new Map();
    this.modelCache = new Map();
    this.modelLoads = new Map();
    // Reversible redaction for this process. The map is memory-only; a
    // restart leaves old placeholders unresolved rather than inventing a
    // value, so a secret can never be recovered from disk.
    this.secrets = new SecretVault();
    this.ownedBy = "workbuddy";
    // One best-effort repair of names imported as "?" by old sign-in code.
    this.labelRefresh = null;
    // Every host a vendored plugin reaches, newest last, bounded: the settings
    // page shows this list, and it is what a review of "enforce" mode reads.
    this.egress = [];
    this.egressMode = DEFAULT_EGRESS_MODE;
  }

  /** Forget every loaded plugin instance so the next call imports the new copy. */
  reloadPlugins() {
    this.factories.clear();
    this.anonymous.clear();
    this.sessions.clear();
    resetSanitize();
    this.invalidateModels();
  }

  /**
   * Records one outbound request from a plugin. Bounded and deduplicated by
   * host: the list answers "which hosts does this plugin talk to", not "how
   * many requests did it make".
   */
  recordEgress(entry) {
    const host = String(entry?.host || "");
    if (!host) return;
    const existing = this.egress.find((item) => item.host === host);
    if (existing) {
      existing.at = Date.now();
      existing.count += 1;
      existing.verdict = entry.verdict;
      existing.blocked = Boolean(entry.blocked) || existing.blocked;
      // Paths are kept per host so the page can show which doors were used,
      // not just which server was reached.
      this.notePath(existing, entry);
      return;
    }
    this.egress.push({
      host,
      verdict: entry.verdict,
      blocked: Boolean(entry.blocked),
      at: Date.now(),
      count: 1,
      paths: [],
      suspicious: []
    });
    this.notePath(this.egress[this.egress.length - 1], entry);
    if (this.egress.length > 200) this.egress.shift();
  }

  /**
   * Records the path a request used, and any reason the audit flagged.
   *
   * Bounded per host: a chat endpoint is called constantly and its path list
   * would otherwise grow without limit. A suspicious reason is kept even when
   * the path list is full, because that is the part worth reading.
   */
  notePath(hostEntry, entry) {
    const path = String(entry?.path || "");
    if (!path) return;
    hostEntry.paths ||= [];
    const known = hostEntry.paths.find((item) => item.path === path);
    if (known) {
      known.count += 1;
      known.at = Date.now();
    } else if (hostEntry.paths.length < 20) {
      hostEntry.paths.push({
        path,
        verdict: entry.pathVerdict || "unknown",
        count: 1,
        at: Date.now()
      });
    }
    const reasons = Array.isArray(entry?.suspicious) ? entry.suspicious : [];
    if (!reasons.length) return;
    hostEntry.suspicious ||= [];
    for (const reason of reasons) {
      const seen = hostEntry.suspicious.find((item) => item.reason === reason);
      if (seen) {
        seen.count += 1;
        seen.at = Date.now();
        continue;
      }
      if (hostEntry.suspicious.length >= 20) continue;
      hostEntry.suspicious.push({ reason, path, at: Date.now(), count: 1 });
    }
  }

  /** The recorded egress list, newest first, for the status snapshot. */
  egressReport() {
    const hosts = [...this.egress].sort((a, b) => b.at - a.at);
    return {
      mode: this.egressMode,
      hosts,
      // A flat count so the page can warn without walking every entry.
      suspicious: hosts.reduce((sum, item) => sum + (item.suspicious?.length || 0), 0)
    };
  }

  /**
   * Runs `work` with the outbound guard installed.
   *
   * The plugins were written for a host that hands them a global `fetch`, and
   * they call it directly — including from their own helpers — so the guard
   * replaces the global for the duration of one provider operation and puts it
   * back afterwards. `monitor` only records; `enforce` refuses a host that is
   * neither an exact upstream nor inside a provider's own domain family.
   */
  async withEgress(work) {
    const settings = await readSettings(this.env).catch(() => ({ egressMode: DEFAULT_EGRESS_MODE }));
    const mode = settings.egressMode || DEFAULT_EGRESS_MODE;
    this.egressMode = mode;
    if (mode === "off") return work();
    const guard = installEgressGuard({
      mode,
      record: (entry) => this.recordEgress(entry)
    });
    try {
      return await work();
    } finally {
      guard.restore();
    }
  }

  /**
   * The plugin factory for one site. An injected factory (tests, the desktop
   * shell) stands in for every site.
   */
  async factoryFor(site) {
    const key = normalizeSite(site);
    if (this.factory) return this.factory;
    if (this.factories.has(key)) return this.factories.get(key);
    const factory = await loadFactory(key, this.env);
    this.factories.set(key, factory);
    return factory;
  }

  async init() {
    if (this.ready) return this;
    // The plugin is loaded per site in factoryFor(), not here: caching the
    // domestic build as a shared factory would send an international sign-in
    // to the domestic login page.
    await this.reload();
    this.ready = true;
    return this;
  }

  async reload() {
    this.state = await loadAccounts(this.env);
    return this.state;
  }

  async accounts() {
    await this.init();
    // The file is the source of truth: the CLI, the check-in scheduler or a
    // second Lane may have signed an account in or switched the route since
    // this process last looked, and a refresh must show what is there now.
    this.state = await loadAccounts(this.env);
    if (!this.labelRefresh) {
      this.labelRefresh = this.repairLabels().catch(() => {});
    }
    return this.state.accounts.map(publicAccount);
  }

  /**
   * Older sign-in imports could persist a Chinese nickname as literal "?".
   * Ask WorkBuddy's own account list once per process and repair those labels;
   * ids and tokens are not touched. A failed lookup leaves the existing label.
   */
  async repairLabels() {
    for (const account of this.state.accounts) {
      if (!account.label || !(/^\?+$/.test(String(account.label)) || String(account.label).includes("\uFFFD"))) continue;
      try {
        const session = await this.session(account.id);
        if (!session?.auth) continue;
        await this.refreshIfNeeded(session).catch(() => {});
        const base = await this.baseURL(account.id);
        if (!base) continue;
        const response = await this.withEgress(() => fetch(`${base}/plugin/accounts`, {
          headers: {
            authorization: `Bearer ${session.auth.access}`,
            "x-domain": account.domain || (account.site === "workbuddy-ai" ? "www.workbuddy.ai" : "www.workbuddy.cn"),
            "x-product": "SaaS",
            "x-ide-type": "WorkBuddy",
            "x-ide-name": "WorkBuddy"
          },
          signal: AbortSignal.timeout(8000)
        }));
        if (!response.ok) continue;
        const payload = await response.json().catch(() => null);
        const rows = Array.isArray(payload?.data?.accounts) ? payload.data.accounts : [];
        const found = rows.find((row) => row?.uid === account.uid || row?.uid === account.id);
        const nickname = String(found?.nickname || "").trim();
        if (!nickname) continue;
        await updateAccountLabel(account.id, nickname, this.env);
        account.label = nickname;
        if (account.auth) account.auth.accountId = nickname;
      } catch {}
    }
  }

  async activeId() {
    await this.init();
    this.state = await loadAccounts(this.env);
    return this.state.activeId;
  }

  activeAccount() {
    return activeAccount(this.state);
  }

  /**
   * The session of one account: its own plugin instance, its own loader,
   * its own token persistence.
   */
  async session(id) {
    await this.init();
    const target = id || this.state.activeId;
    if (!target) return null;
    const existing = this.sessions.get(target);
    if (existing) return existing;
    // A check-in round and a first chat can ask for the same account at the
    // same moment; one load is shared rather than building two plugin
    // instances and keeping whichever happened to land last.
    this.sessionLoads ||= new Map();
    const pending = this.sessionLoads.get(target);
    if (pending) return pending;
    const load = this.loadSession(target).finally(() => this.sessionLoads.delete(target));
    this.sessionLoads.set(target, load);
    return load;
  }

  async loadSession(target) {
    const account = this.state.accounts.find((item) => item.id === target);
    if (!account) return null;
    const factory = await this.factoryFor(account.site);
    const session = { id: target, auth: account.auth, hooks: null, loader: null };
    session.hooks = await factory({
      client: {
        auth: {
          set: async ({ body }) => {
            if (!body || typeof body !== "object") return;
            session.auth = { ...session.auth, ...body };
            await updateAccountAuth(target, body, this.env);
            const stored = this.state.accounts.find((item) => item.id === target);
            if (stored) {
              stored.auth = session.auth;
              if (body.domain) stored.domain = body.domain;
            }
          }
        }
      }
    });
    this.sessions.set(target, session);
    return session;
  }

  async activeSession() {
    const session = await this.session();
    return session && session.auth ? session : null;
  }

  async anonymousHooks(site = "workbuddy") {
    if (this.hooks) return this.hooks;
    const key = normalizeSite(site);
    if (this.anonymous.has(key)) return this.anonymous.get(key);
    const factory = await this.factoryFor(key);
    const hooks = await factory({
      client: { auth: { set: async () => {} } }
    });
    this.anonymous.set(key, hooks);
    return hooks;
  }

  async loaderFor(session) {
    if (!session) throw new Error("WorkBuddy is not signed in");
    if (!session.auth) throw new Error("WorkBuddy is not signed in");
    if (!session.loader) {
      session.loader = await session.hooks.auth.loader(async () => {
        if (!session.auth) throw new Error("WorkBuddy is not signed in");
        return session.auth;
      });
    }
    return session.loader;
  }

  async baseURL(id) {
    const session = await this.session(id);
    if (!session?.auth) return "";
    const loader = await this.loaderFor(session);
    const base = String(loader?.baseURL || "").replace(/\/+$/, "");
    const site = await this.siteOf(session.id);
    const origin = site === "workbuddy-ai" ? "https://www.workbuddy.ai" : "https://copilot.tencent.com";
    // 0.1.34 changed baseURL from an absolute endpoint to a relative path, and
    // from 0.1.33 on the plugin says "" and leaves the URL to each model's own
    // api.url. Either shape would make a bare concatenation fetch a relative
    // URL ("Failed to parse URL from /chat/completions"), so every base is
    // resolved against the account's own endpoint: the API lives at <origin>/v2.
    if (!base) return `${origin}/v2`;
    if (/^https?:\/\//i.test(base)) return base;
    try {
      return new URL(base, origin).href.replace(/\/+$/, "");
    } catch {
      return base;
    }
  }

  async signedIn() {
    await this.init();
    const account = activeAccount(this.state);
    if (!account || !account.enabled) return false;
    return Boolean(account.auth?.access);
  }

  async refreshIfNeeded(session) {
    const target = session || (await this.activeSession());
    if (!target) return null;
    const refresh = target.hooks?.auth?.refresh;
    if (typeof refresh !== "function") return target.auth;
    // Concurrent chats on one account share the refresh: a rotating refresh
    // token spent twice spends an already-dead token the second time, and
    // the losing write would persist it. Same sharing as sessionLoads.
    this.refreshLoads ||= new Map();
    const pending = this.refreshLoads.get(target.id);
    if (pending) return pending;
    const load = this.refresh(target, refresh).finally(() => this.refreshLoads.delete(target.id));
    this.refreshLoads.set(target.id, load);
    return load;
  }

  async refresh(target, refresh) {
    const changed = await refresh.call(target.hooks.auth, target.auth);
    if (changed && typeof changed === "object") {
      target.auth = { ...target.auth, ...changed };
      await updateAccountAuth(target.id, changed, this.env);
      const stored = this.state.accounts.find((item) => item.id === target.id);
      if (stored) stored.auth = target.auth;
    }
    return target.auth;
  }

  // The catalogue the last listModels() settled on, so request accounting can
  // cost a model without asking the upstream on every status poll.
  cachedModels() {
    return this.models || [];
  }

  // A route change or a new sign-in can change what the catalogue says;
  // those are the moments the cached catalogues stop being trusted. The
  // generation rises per invalidation so a load that started before the
  // switch cannot re-cache the old catalogue after it lands. In-flight loads
  // go too: returning one that started before the switch would hand out the
  // stale catalogue the generation guard was meant to drop.
  invalidateModels() {
    this.modelGeneration = (this.modelGeneration || 0) + 1;
    this.modelCache.clear();
    if (this.modelLoads) for (const load of this.modelLoads.values()) load.catch(() => {});
    this.modelLoads?.clear();
  }

  async listModels(id) {
    await this.init();
    const key = id || this.state.activeId || "";
    const hit = this.modelCache.get(key);
    if (hit && Date.now() - hit.at < MODEL_CACHE_MS) {
      this.models = hit.value;
      return hit.value;
    }
    // Callers arrive in bursts (the model routes ask twice per request); one
    // load serves them all rather than racing N upstream fetches.
    const existing = this.modelLoads.get(key);
    if (existing) return existing;
    const generation = this.modelGeneration || 0;
    const load = this.loadModels(id).finally(() => this.modelLoads.delete(key));
    this.modelLoads.set(key, load);
    const models = await load;
    if (generation === (this.modelGeneration || 0)) {
      this.modelCache.set(key, { at: Date.now(), value: models });
      this.models = models;
    }
    return models;
  }

  async loadModels(id) {
    await this.init();
    const session = await this.session(id);
    // Each build declares its provider under its own key: the international
    // plugin answers to "workbuddy-ai", not "workbuddy". Ask the account's
    // own site for the key instead of assuming the domestic one.
    const site = await this.siteOf(id || this.state.activeId);
    const hooks = session?.hooks || (await this.anonymousHooks(site));
    const config = { provider: {} };
    await hooks.config(config);
    const providers = config.provider || {};
    const provider = providers[site] || providers.workbuddy || Object.values(providers)[0];
    if (!provider) throw new Error("WorkBuddy plugin did not declare a provider");
    const auth = session?.auth || null;
    if (!auth) {
      return Object.entries(provider.models || {}).map(([modelId, value]) => ({
        id: modelId,
        ...modelDetails(modelId, value, site, this.ownedBy)
      }));
    }
    const models = await this.withEgress(() => hooks.provider.models(structuredClone(provider), { auth }));
    return Object.entries(models || {}).map(([modelId, value]) => ({
      id: modelId,
      ...modelDetails(modelId, value, site, this.ownedBy)
    }));
  }

  /**
   * The account's credits, from the plugin's usage hook: the cycle's credits
   * used against what it grants, plus when the credits left run out.
   */
  async usage(id) {
    await this.init();
    const session = await this.session(id);
    if (!session?.auth) return { error: "not signed in" };
    if (typeof session.hooks.auth?.usage !== "function") {
      return { error: "usage is not available" };
    }
    try {
      const result = await this.withEgress(() => session.hooks.auth.usage(async () => session.auth));
      return localizeUsage(result);
    } catch (error) {
      return { error: error?.message || "usage is unknown" };
    }
  }

  /**
   * `signal` aborts the request when the client that caused it hangs up, so
   * WorkBuddy stops generating instead of billing a stream nobody reads. The
   * wait for the response head is separately bounded: an upstream that
   * accepts neither would otherwise leave the client hanging forever, and
   * the body itself may stream for as long as the generation runs.
   */
  async chat(body, { signal, accountId = "" } = {}) {
    // The account that owns the model, not the route: with several accounts
    // serving models at once, the router resolves which one this request
    // belongs to and passes it here. Without it the request went out on the
    // route account, so a model served by any other account failed — the
    // catalogue listed it but the call could not use it.
    const session = accountId ? await this.session(accountId) : await this.activeSession();
    if (!session) throw new Error("WorkBuddy is not signed in");
    if (!session.auth) throw new Error("WorkBuddy is not signed in");
    await this.refreshIfNeeded(session);
    const loader = await this.loaderFor(session);
    // WorkBuddy refuses a chat whose prompt carries another client's words,
    // and refuses tool shapes its models cannot take. The plugin knows both
    // lists; this is the same preparation it applies to its own requests.
    // DSH's name is hidden here too unless the user turned that off: a name
    // WorkBuddy can read back is what got an account banned. The same read
    // decides whether credentials are redacted before they leave the machine.
    const settings = await readSettings(this.env).catch(() => ({
      hideDsh: true,
      redactSecrets: true,
      redactPersonal: true,
      redactRules: undefined,
      redactAllowlist: [],
      redactCustom: []
    }));
    const prepared = await prepareChat({ ...body, stream: true }, { hideDsh: settings.hideDsh !== false, env: this.env });
    // Redact after the plugin's own request preparation: what it writes is
    // what is actually sent, and every string in it is a possible carrier.
    const rules = resolveRules(settings.redactRules, {
      secrets: settings.redactSecrets !== false,
      personal: settings.redactPersonal !== false
    });
    const outgoing = settings.redactSecrets !== false
      ? redactBody(prepared.body, {
        vault: this.secrets,
        rules,
        allowlist: settings.redactAllowlist,
        custom: settings.redactCustom
      })
      : prepared.body;
    // The plugin's loader takes an absolute URL: from 0.1.33 its baseURL is ""
    // because each model's api.url names where it is served (/v2 for a chat,
    // /v1 for a Messages model). Lane relays chat completions only, so it asks
    // the account's own /v2 — resolved here, once, instead of trusting the
    // loader's empty base.
    const endpoint = await this.baseURL(session.id);
    const gate = new AbortController();
    // The reason names its own kind: the relay's catch sees only the
    // rejection, and an AbortError by itself cannot be told apart from the
    // client hanging up.
    const timer = setTimeout(
      () => gate.abort(withKind(
        new Error(`WorkBuddy did not answer within ${CHAT_HEADERS_TIMEOUT_MS / 1000}s`),
        ERROR_KIND.upstreamTimeout
      )),
      CHAT_HEADERS_TIMEOUT_MS
    );
    // A client abort already carries its own kind from the relay; passing its
    // reason through keeps that classification instead of relabelling it.
    const passThrough = () => gate.abort(signal.reason);
    if (signal) {
      if (signal.aborted) passThrough();
      else signal.addEventListener("abort", passThrough, { once: true });
    }
    let response;
    try {
      response = await this.withEgress(() => loader.fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: body.stream ? "text/event-stream" : "application/json"
        },
        body: JSON.stringify(outgoing),
        signal: gate.signal
      }));
    } finally {
      clearTimeout(timer);
    }
    // A refusal names no client and no word, so the only way to find the
    // offending wording is to keep what was actually sent. User content in
    // the persistent log is a cost, though: it is written only when request
    // tracing is on, and only the system prompt's head is kept.
    if (response.status === 400) {
      const text = await response.clone().text().catch(() => "");
      if (/unapproved channel|illegal api invocation/i.test(text)) {
        if (process.env.LANE_TRACE_REQUEST === "1") {
          const system = (outgoing?.messages || [])
            .filter((message) => message?.role === "system")
            .map((message) => typeof message.content === "string"
              ? message.content
              : (message.content || []).map((part) => part?.text || "").join(""))
            .join("\n")
            .slice(0, 600);
          // The body has already been redacted; run the one-way mask over it
          // once more so even a bug in the vault cannot put a value in a log.
          console.error(`WorkBuddy refused a prompt. System prompt head:\n${redactForLog(system)}`);
        }
      }
    }
    const named = await restoreToolNames(response, prepared.names);
    return restoreResponse(named, this.secrets);
  }

  async activate(id) {
    await this.init();
    const account = await activateAccount(id, this.env);
    this.state = await loadAccounts(this.env);
    this.invalidateModels();
    return publicAccount(account);
  }

  async setEnabled(id, enabled) {
    await this.init();
    const account = await setAccountEnabled(id, enabled, this.env);
    this.state = await loadAccounts(this.env);
    if (!enabled) this.sessions.delete(id);
    this.invalidateModels();
    return publicAccount(account);
  }

  /** Keeps the sign-in and the check-in; only leaves the model pool. */
  async setRoutable(id, routable) {
    await this.init();
    const account = await setAccountRoutable(id, routable, this.env);
    this.state = await loadAccounts(this.env);
    this.invalidateModels();
    return publicAccount(account);
  }

  async forget(id) {
    await this.init();
    const result = await removeAccount(id, this.env);
    this.sessions.delete(id);
    this.state = await loadAccounts(this.env);
    this.invalidateModels();
    return result;
  }

  async authorize(site = "workbuddy") {
    await this.init();
    const key = normalizeSite(site);
    const hooks = await this.anonymousHooks(key);
    const method = hooks.auth.methods?.find((item) => item.label?.includes("browser"));
    if (!method) throw new Error("WorkBuddy plugin has no browser sign-in method");
    // The plugin returns an OpenCode auth object already
    // ({url, instructions, callback}); authorize() itself is not a callback.
    const result = await this.withEgress(() => method.authorize());
    if (!result?.url) throw new Error("WorkBuddy plugin returned no browser URL");
    return { ...result, site: key };
  }

  /**
   * A finished sign-in always adds an account. The first one becomes the
   * route; a later one joins the list switched on but idle.
   *
   * `auth` is the outcome of an already-awaited `result.callback()`. The
   * desktop's sign-in flow waits for the callback itself to tell the window
   * when the browser round trip is over; without the result handed in,
   * waiting again would poll the plugin's token endpoint a second time with
   * the same state, which the endpoint is free to refuse.
   */
  async finishSignIn(result, site = result?.site || "workbuddy", auth = null) {
    const outcome = auth || await this.withEgress(() => result.callback());
    if (outcome?.type !== "success") {
      throw new Error(outcome?.error || "WorkBuddy sign-in failed");
    }
    const stored = {
      type: "oauth",
      access: outcome.access,
      refresh: outcome.refresh,
      expires: outcome.expires,
      refreshExpiresAt: outcome.refreshExpiresAt || 0,
      domain: outcome.domain || "",
      tokenType: outcome.tokenType || "",
      uid: outcome.uid || "",
      enterpriseId: outcome.enterpriseId || "",
      accountId: outcome.accountId || ""
    };
    const id = accountIdOf(stored);
    if (!id) throw new Error("WorkBuddy sign-in returned no account id");
    const key = normalizeSite(site);
    await upsertAccount(stored, this.env, { activate: !this.state.activeId, site: key });
    this.sessions.delete(id);
    this.state = await loadAccounts(this.env);
    this.invalidateModels();
    return { ...stored, id, site: key };
  }

  /** Which site an account belongs to; unknown or legacy accounts are domestic. */
  async siteOf(id) {
    await this.init();
    const target = id || this.state.activeId;
    const account = this.state.accounts.find((item) => item.id === target);
    return normalizeSite(account?.site);
  }
}

/**
 * The plugin's usage hook speaks as a plugin host: a refused sign-in reads
 * "Sign in to it again in magpie: Providers → WorkBuddy → this account's
 * Sign in again." Lane is the host here, has no Providers page, and has its
 * own "添加账号" button. The sentence is replaced rather than shown, keeping
 * the HTTP reason and the action; a message with no such sentence is left
 * exactly as it came, so the plugin's own diagnostic detail survives.
 */
function localizeUsage(value) {
  if (!value || typeof value !== "object" || typeof value.error !== "string") return value || {};
  const error = value.error
    // The host-specific instructions, in the spellings 0.2.x uses: the
    // browser sign-in's ("Providers → … → Sign in again"), the desktop
    // sign-in's, and the API key's (which names a Providers page too).
    .replace(/\s*Sign in to [^.;]+ again in magpie:[^]*$/i, " 请重新登录 WorkBuddy。")
    .replace(/\s*Sign in to [^.;]+ again in magpie\.?/i, " 请重新登录 WorkBuddy。")
    .replace(/\s*Sign in to [^.;]+ desktop again;? magpie reads its sign-in on the next request\.?/i, " 请重新登录 WorkBuddy 桌面版。")
    .replace(/\s*,?\s*then add it again in magpie:[^]*$/i, "，然后在 Lane 中重新添加该密钥。")
    // Any other "in magpie" phrasing the plugin adds later: name the product
    // it is actually running in, never another app the user does not have.
    .replace(/\bin magpie\b/gi, "在 Lane 中");
  return error === value.error ? value : { ...value, error };
}

/** The plugin export that serves one site. */
const SITE_EXPORTS = {
  workbuddy: "WorkBuddyAuthPlugin",
  "workbuddy-ai": "WorkBuddyAIAuthPlugin"
};

async function loadFactory(site = "workbuddy", env = process.env) {
  let entry;
  try {
    const pluginUrl = await pluginEntryUrl("workbuddy-auth", env);
    entry = await import(pluginUrl.href);
  } catch (error) {
    throw new Error(
      `WorkBuddy plugin copy is missing or unreadable at vendor/workbuddy-auth/index.mjs. (${error.message})`
    );
  }
  const key = normalizeSite(site);
  const name = SITE_EXPORTS[key];
  const factory = entry[name];
  if (typeof factory !== "function") {
    throw new Error(`WorkBuddy plugin does not export ${name}`);
  }
  return factory;
}

function modelDetails(id, value = {}, site = "", ownedBy = "workbuddy") {
  const details = {
    name: value.name || id,
    context: value.limit?.context || 0,
    owned_by: ownedBy
  };
  // The plugin's live /v3/config carries the real reply cap; keep it with
  // the model instead of dropping it, so a client that reads a model's
  // output limit is not left to models.dev's guess (the 0.2.26 issue).
  // The declared catalogue is used when the config cannot be read; these
  // are the values WorkBuddy's own config names for it.
  const declaredOutput = {
    workbuddy: {
      "deepseek-v4.1-flash": 128000,
      "deepseek-v4-pro": 128000,
      "glm-5.3-flash": 131072
    },
    "workbuddy-ai": {
      "default-model": 24000,
      "fast-model": 32000,
      "primary-model": 72000,
      hy3: 64000,
      "gemini-3.5-flash": 65536,
      "glm-5.2": 48000,
      "kimi-k3": 32000
    }
  };
  const output = Number(value.limit?.output) > 0
    ? Number(value.limit.output)
    : (declaredOutput[site]?.[id] || 0);
  if (output > 0) details.output = output;
  const efforts = modelEfforts(value);
  if (efforts.length) {
    details.reasoning = true;
    details.efforts = efforts;
  }
  if (typeof value.free === "boolean") details.free = value.free;
  if (Number.isFinite(value.rate) && value.rate >= 0) details.rate = value.rate;
  if (Number.isFinite(value.rateWas) && value.rateWas > 0) details.rateWas = value.rateWas;
  return details;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function modelEfforts(value) {
  const raw = Array.isArray(value.efforts)
    ? value.efforts
    : value.reasoning?.supportedEfforts || Object.keys(value.variants || {});
  const efforts = new Set(
    raw
      .map((effort) => typeof effort === "string" ? effort : effort?.effort)
      .filter((effort) => EFFORT_ORDER.includes(effort))
  );
  return EFFORT_ORDER.filter((effort) => efforts.has(effort));
}
