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
  accountIdOf
} from "./accounts.js";

const require = createRequire(import.meta.url);
const PACKAGE = "@magpie-community/opencode-workbuddy-auth";

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
    this.anonymous = null;
    // Hooks with no account behind them: only the static model catalogue
    // and the sign-in flow need them.
    this.hooks = hooks;
    this.ready = false;
  }

  async init() {
    if (this.ready) return this;
    this.factory = this.factory || (await loadFactory());
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
    return this.state.accounts.map(publicAccount);
  }

  async activeId() {
    await this.init();
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
    const account = this.state.accounts.find((item) => item.id === target);
    if (!account) return null;
    const session = { id: target, auth: account.auth, hooks: null, loader: null };
    session.hooks = await this.factory({
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

  async anonymousHooks() {
    if (this.hooks) return this.hooks;
    if (!this.anonymous) {
      this.anonymous = await this.factory({
        client: { auth: { set: async () => {} } }
      });
    }
    this.hooks = this.anonymous;
    return this.anonymous;
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

  async listModels(id) {
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

  async chat(body) {
    const session = await this.activeSession();
    if (!session) throw new Error("WorkBuddy is not signed in");
    await this.refreshIfNeeded(session);
    const loader = await this.loaderFor(session);
    const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: body.stream ? "text/event-stream" : "application/json"
      },
      body: JSON.stringify({ ...body, stream: true })
    });
    return response;
  }

  async activate(id) {
    await this.init();
    const account = await activateAccount(id, this.env);
    this.state = await loadAccounts(this.env);
    return publicAccount(account);
  }

  async setEnabled(id, enabled) {
    await this.init();
    const account = await setAccountEnabled(id, enabled, this.env);
    this.state = await loadAccounts(this.env);
    if (!enabled) this.sessions.delete(id);
    return publicAccount(account);
  }

  async forget(id) {
    await this.init();
    const result = await removeAccount(id, this.env);
    this.sessions.delete(id);
    this.state = await loadAccounts(this.env);
    return result;
  }

  async authorize() {
    await this.init();
    const hooks = await this.anonymousHooks();
    const method = hooks.auth.methods?.find((item) => item.label?.includes("browser"));
    if (!method) throw new Error("WorkBuddy plugin has no browser sign-in method");
    // The plugin returns an OpenCode auth object already
    // ({url, instructions, callback}); authorize() itself is not a callback.
    const result = await method.authorize();
    if (!result?.url) throw new Error("WorkBuddy plugin returned no browser URL");
    return result;
  }

  /**
   * A finished sign-in always adds an account. The first one becomes the
   * route; a later one joins the list switched on but idle.
   */
  async finishSignIn(result) {
    const auth = await result.callback();
    if (auth?.type !== "success") {
      throw new Error(auth?.error || "WorkBuddy sign-in failed");
    }
    const stored = {
      type: "oauth",
      access: auth.access,
      refresh: auth.refresh,
      expires: auth.expires,
      refreshExpiresAt: auth.refreshExpiresAt || 0,
      domain: auth.domain || "",
      tokenType: auth.tokenType || "",
      uid: auth.uid || "",
      enterpriseId: auth.enterpriseId || "",
      accountId: auth.accountId || ""
    };
    const id = accountIdOf(stored);
    if (!id) throw new Error("WorkBuddy sign-in returned no account id");
    await upsertAccount(stored, this.env, { activate: !this.state.activeId });
    this.sessions.delete(id);
    this.state = await loadAccounts(this.env);
    return { ...stored, id };
  }
}

async function loadFactory() {
  let entry;
  try {
    entry = await import(pathToFileURL(require.resolve(PACKAGE)).href);
  } catch (error) {
    throw new Error(
      `WorkBuddy plugin is not installed. Run npm install. (${error.message})`
    );
  }
  return entry.WorkBuddyAuthPlugin;
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
