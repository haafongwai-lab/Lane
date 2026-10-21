import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readAuth, writeAuth } from "./auth-store.js";

const require = createRequire(import.meta.url);
const PACKAGE = "@magpie-community/opencode-workbuddy-auth";

/**
 * WorkBuddy plugins are OpenCode v1 plugins: a factory receives a client
 * and returns hooks. Lane supplies only the auth persistence the plugin
 * needs; everything vendor-specific stays in the plugin.
 */
export class WorkBuddyProvider {
  constructor({ env = process.env, auth } = {}) {
    this.env = env;
    this.auth = auth ?? null;
    this.hooks = null;
    this.loader = null;
  }

  async init() {
    if (this.hooks) return this;
    let entry;
    try {
      entry = await import(pathToFileURL(require.resolve(PACKAGE)).href);
    } catch (error) {
      throw new Error(
        `WorkBuddy plugin is not installed. Run npm install. (${error.message})`
      );
    }
    this.hooks = await entry.WorkBuddyAuthPlugin({
      client: {
        auth: {
          set: async ({ body }) => {
            this.auth = body;
            await writeAuth(body, this.env);
          }
        }
      }
    });
    this.auth = this.auth ?? (await readAuth(this.env));
    return this;
  }

  async getAuth() {
    this.auth = this.auth ?? (await readAuth(this.env));
    return this.auth;
  }

  async signedIn() {
    await this.init();
    return Boolean((await this.getAuth())?.access);
  }

  async getLoader() {
    await this.init();
    if (!(await this.getAuth())) throw new Error("WorkBuddy is not signed in");
    if (!this.loader) {
      this.loader = await this.hooks.auth.loader(async () => {
        const current = await this.getAuth();
        if (!current) throw new Error("WorkBuddy is not signed in");
        return current;
      });
    }
    return this.loader;
  }

  async refreshIfNeeded() {
    await this.init();
    const auth = await this.getAuth();
    if (!auth) return;
    const changed = await this.hooks.auth.refresh?.(auth);
    if (changed && typeof changed === "object") {
      this.auth = { ...auth, ...changed };
      await writeAuth(this.auth, this.env);
    }
  }

  async listModels() {
    await this.init();
    const config = { provider: {} };
    await this.hooks.config(config);
    const provider = config.provider.workbuddy;
    if (!provider) throw new Error("WorkBuddy plugin did not declare a provider");
    const auth = await this.getAuth();
    if (!auth) {
      return Object.entries(provider.models || {}).map(([id, value]) => ({
        id,
        ...modelDetails(id, value)
      }));
    }
    const models = await this.hooks.provider.models(
      structuredClone(provider),
      { auth }
    );
    return Object.entries(models || {}).map(([id, value]) => ({
      id,
      ...modelDetails(id, value)
    }));
  }

  /**
   * The account's credits, from the plugin's usage hook: the cycle's credits
   * used against what it grants, plus when the credits left run out.
   */
  async usage() {
    await this.init();
    const auth = await this.getAuth();
    if (!auth) return { error: "not signed in" };
    if (typeof this.hooks.auth?.usage !== "function") {
      return { error: "usage is not available" };
    }
    try {
      const result = await this.hooks.auth.usage(async () => {
        const current = await this.getAuth();
        if (!current) throw new Error("WorkBuddy is not signed in");
        return current;
      });
      return result || {};
    } catch (error) {
      return { error: error?.message || "usage is unknown" };
    }
  }

  async chat(body) {
    await this.refreshIfNeeded();
    const loader = await this.getLoader();
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

  async authorize() {
    await this.init();
    const method = this.hooks.auth.methods?.find((item) => item.label?.includes("browser"));
    if (!method) throw new Error("WorkBuddy plugin has no browser sign-in method");
    // The plugin returns an OpenCode auth object already
    // ({url, instructions, callback}); authorize() itself is not a callback.
    const result = await method.authorize();
    if (!result?.url) throw new Error("WorkBuddy plugin returned no browser URL");
    return result;
  }

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
    this.auth = stored;
    await writeAuth(stored, this.env);
    return stored;
  }
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
