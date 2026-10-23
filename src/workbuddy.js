import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  loadAccounts,
  upsertAccount,
  updateAccountAuth,
  activateAccount,
  setAccountEnabled,
  removeAccount,
  activeAccount,
  publicAccount,
  accountIdOf,
  normalizeSite
} from "./accounts.js";
import { prepareChat, restoreToolNames } from "./sanitize.js";

const require = createRequire(import.meta.url);
const PACKAGE = "@magpie-community/opencode-workbuddy-auth";

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
  }

  /**
   * The plugin factory for one site. An injected factory (tests, the desktop
   * shell) stands in for every site.
   */
  async factoryFor(site) {
    const key = normalizeSite(site);
    if (this.factory) return this.factory;
    if (this.factories.has(key)) return this.factories.get(key);
    const factory = await loadFactory(key);
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
    return this.state.accounts.map(publicAccount);
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
    return String(loader?.baseURL || "").replace(/\/+$/, "");
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
  // those are the moments the cached catalogues stop being trusted.
  invalidateModels() {
    this.modelCache.clear();
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
    const load = this.loadModels(id).finally(() => this.modelLoads.delete(key));
    this.modelLoads.set(key, load);
    const models = await load;
    this.modelCache.set(key, { at: Date.now(), value: models });
    this.models = models;
    return models;
  }

  async loadModels(id) {
    await this.init();
    const session = await this.session(id);
    const hooks = session?.hooks || (await this.anonymousHooks());
    const config = { provider: {} };
    await hooks.config(config);
    const provider = config.provider.workbuddy;
    if (!provider) throw new Error("WorkBuddy plugin did not declare a provider");
    const auth = session?.auth || null;
    if (!auth) {
      return Object.entries(provider.models || {}).map(([modelId, value]) => ({
        id: modelId,
        ...modelDetails(modelId, value)
      }));
    }
    const models = await hooks.provider.models(structuredClone(provider), { auth });
    return Object.entries(models || {}).map(([modelId, value]) => ({
      id: modelId,
      ...modelDetails(modelId, value)
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
      const result = await session.hooks.auth.usage(async () => session.auth);
      return result || {};
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
  async chat(body, { signal } = {}) {
    const session = await this.activeSession();
    if (!session) throw new Error("WorkBuddy is not signed in");
    await this.refreshIfNeeded(session);
    const loader = await this.loaderFor(session);
    // WorkBuddy refuses a chat whose prompt carries another client's words,
    // and refuses tool shapes its models cannot take. The plugin knows both
    // lists; this is the same preparation it applies to its own requests.
    const prepared = await prepareChat({ ...body, stream: true });
    const gate = new AbortController();
    const timer = setTimeout(
      () => gate.abort(new Error(`WorkBuddy did not answer within ${CHAT_HEADERS_TIMEOUT_MS / 1000}s`)),
      CHAT_HEADERS_TIMEOUT_MS
    );
    const passThrough = () => gate.abort(signal.reason);
    if (signal) {
      if (signal.aborted) passThrough();
      else signal.addEventListener("abort", passThrough, { once: true });
    }
    let response;
    try {
      response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: body.stream ? "text/event-stream" : "application/json"
        },
        body: JSON.stringify(prepared.body),
        signal: gate.signal
      });
    } finally {
      clearTimeout(timer);
    }
    // A refusal names no client and no word, so the only way to find the
    // offending wording is to keep what was actually sent. This runs only on
    // a refusal, and only the system prompt's head is kept.
    if (response.status === 400) {
      const text = await response.clone().text().catch(() => "");
      if (/unapproved channel|illegal api invocation/i.test(text)) {
        const system = (prepared.body?.messages || [])
          .filter((message) => message?.role === "system")
          .map((message) => typeof message.content === "string"
            ? message.content
            : (message.content || []).map((part) => part?.text || "").join(""))
          .join("\n")
          .slice(0, 600);
        console.error(`WorkBuddy refused a prompt. System prompt head:\n${system}`);
      }
    }
    return restoreToolNames(response, prepared.names);
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
    const result = await method.authorize();
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
    const outcome = auth || await result.callback();
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

/** The plugin export that serves one site. */
const SITE_EXPORTS = {
  workbuddy: "WorkBuddyAuthPlugin",
  "workbuddy-ai": "WorkBuddyAIAuthPlugin"
};

async function loadFactory(site = "workbuddy") {
  let entry;
  try {
    entry = await import(pathToFileURL(require.resolve(PACKAGE)).href);
  } catch (error) {
    throw new Error(
      `WorkBuddy plugin is not installed. Run npm install. (${error.message})`
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

function modelDetails(id, value = {}) {
  const details = {
    name: value.name || id,
    context: value.limit?.context || 0,
    owned_by: "workbuddy"
  };
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
