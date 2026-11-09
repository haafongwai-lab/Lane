import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { writeTextAtomic } from "./agents/store.js";
import { WorkBuddyProvider } from "./workbuddy.js";
import { TraeProvider } from "./trae.js";
import { restrictModels } from "./model-gate.js";

/**
 * Lane's second upstream switchboard.
 *
 * WorkBuddy and Trae keep separate account stores and separate sign-ins; this
 * router is the one object the gateway, control center and CLI talk to. It
 * merges the two account lists for the UI, remembers which account owns the
 * route in provider-route.json, and delegates every provider operation to the
 * owner. Model ids are namespaced by the provider that currently owns the
 * route, so an existing WorkBuddy-only install behaves exactly as before.
 */
export class ProviderRouter {
  constructor({ env = process.env, workbuddy = null, trae = null } = {}) {
    this.env = env;
    this.workbuddy = workbuddy || new WorkBuddyProvider({ env });
    this.trae = trae || new TraeProvider({ env });
    this.routeFile = path.join(dataDir(env), "provider-route.json");
    this.ready = false;
    this.route = null;
  }

  async init() {
    if (this.ready) return this;
    // A broken optional upstream must not take the primary one down: a
    // truncated Trae account file is a Trae problem, not a WorkBuddy outage.
    await Promise.all([
      this.workbuddy.init(),
      this.trae.init().catch(() => null)
    ]);
    this.route = await this.readRoute();
    this.ready = true;
    return this;
  }

  async readRoute() {
    try {
      const value = JSON.parse(await fs.readFile(this.routeFile, "utf8"));
      if (value && typeof value === "object" && typeof value.id === "string" && value.id) {
        return { provider: value.provider === "trae" ? "trae" : "workbuddy", id: value.id };
      }
    } catch {}
    return null;
  }

  async saveRoute(provider, id) {
    this.route = id ? { provider: provider === "trae" ? "trae" : "workbuddy", id } : null;
    if (!this.route) {
      await fs.rm(this.routeFile, { force: true }).catch(() => {});
      return;
    }
    await writeTextAtomic(this.routeFile, `${JSON.stringify(this.route)}\n`);
  }

  async accounts() {
    await this.init();
    const [workbuddy, trae] = await Promise.all([
      this.workbuddy.accounts().catch(() => []),
      this.trae.accounts().catch(() => [])
    ]);
    return [
      ...workbuddy.map((account) => ({ ...account, provider: "workbuddy" })),
      ...trae.map((account) => ({ ...account, provider: "trae" }))
    ];
  }

  async accountOf(id) {
    return (await this.accounts()).find((account) => account.id === id) || null;
  }

  providerForAccount(account) {
    return account?.provider === "trae" ? this.trae : this.workbuddy;
  }

  async activeId() {
    await this.init();
    const route = await this.readRoute();
    this.route = route;
    if (route?.id) {
      const found = await this.accountOf(route.id);
      if (found) return route.id;
    }
    const workbuddy = await this.workbuddy.activeId().catch(() => "");
    if (workbuddy) {
      // Keep the in-memory route in step with the fallback, so cachedModels()
      // does not pick the provider named by a route file whose account is
      // gone. The file itself is left alone until the next explicit switch.
      this.route = { provider: "workbuddy", id: workbuddy };
      return workbuddy;
    }
    const trae = await this.trae.activeId().catch(() => "");
    if (trae) {
      this.route = { provider: "trae", id: trae };
      return trae;
    }
    return "";
  }

  async activeProvider() {
    const id = await this.activeId();
    const account = id ? await this.accountOf(id) : null;
    if (account) return this.providerForAccount(account);
    return this.workbuddy;
  }

  /**
   * The full upstream catalogue, unfiltered. Only the model page uses this:
   * it must show every model so the user can choose which ones to add.
   */
  async catalogue(id) {
    // Resolve an explicit account before asking a provider. Without an id a
    // provider's own activeId may have drifted from the router's route; the
    // model page must describe the account the gateway actually serves.
    const target = id || (await this.activeId());
    const account = target ? await this.accountOf(target) : null;
    return (account ? this.providerForAccount(account) : await this.activeProvider()).listModels(target);
  }

  /**
   * The models agents may read: the catalogue minus everything the user has
   * not added. Every agent-facing path (the /v1/models route, model
   * resolution, the Codex and ZCode catalogue files) goes through this, so a
   * model that is not in the allowlist can neither be listed nor requested.
   */
  async listModels(id) {
    return restrictModels(await this.catalogue(id), this.env);
  }

  async chat(body, options) {
    return (await this.activeProvider()).chat(body, options);
  }

  async usage(id) {
    const account = id ? await this.accountOf(id) : null;
    if (account) return this.providerForAccount(account).usage(id);
    return (await this.activeProvider()).usage(id);
  }

  /**
   * The billing read that feeds an account chip. Trae overrides this to keep
   * a billing-page "expired" from claiming the account is logged out while
   * its chat still works; every provider without that distinction simply
   * answers with its usage. The router has to forward it, or the override is
   * unreachable from the control center.
   */
  async accountUsage(id) {
    const account = id ? await this.accountOf(id) : null;
    const provider = account ? this.providerForAccount(account) : await this.activeProvider();
    return typeof provider.accountUsage === "function"
      ? provider.accountUsage(id)
      : provider.usage(id);
  }

  async signedIn() {
    return (await this.activeProvider()).signedIn();
  }

  async session(id) {
    const account = id ? await this.accountOf(id) : null;
    if (account) return this.providerForAccount(account).session(id);
    return (await this.activeProvider()).session(id);
  }

  async siteOf(id) {
    const account = id ? await this.accountOf(id) : null;
    if (account) return this.providerForAccount(account).siteOf(id);
    return (await this.activeProvider()).siteOf(id);
  }

  async baseURL(id) {
    const account = id ? await this.accountOf(id) : null;
    if (account) return this.providerForAccount(account).baseURL(id);
    return (await this.activeProvider()).baseURL(id);
  }

  async refreshIfNeeded(session) {
    const account = session?.id ? await this.accountOf(session.id) : null;
    if (account) return this.providerForAccount(account).refreshIfNeeded(session);
    return (await this.activeProvider()).refreshIfNeeded(session);
  }

  cachedModels() {
    const provider = this.route?.provider === "trae" ? this.trae : this.workbuddy;
    return provider.cachedModels();
  }

  invalidateModels() {
    this.workbuddy.invalidateModels();
    this.trae.invalidateModels();
  }

  async activate(id) {
    const account = await this.accountOf(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    const provider = this.providerForAccount(account);
    const activated = await provider.activate(id);
    await this.saveRoute(account.provider, id);
    return { ...activated, provider: account.provider };
  }

  async setEnabled(id, enabled) {
    const account = await this.accountOf(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    const provider = this.providerForAccount(account);
    const updated = await provider.setEnabled(id, enabled);
    if (!enabled && (this.route?.id === id || (await this.activeId()) === id)) {
      await this.saveRoute(null, "");
    }
    return { ...updated, provider: account.provider };
  }

  async forget(id) {
    const account = await this.accountOf(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    const provider = this.providerForAccount(account);
    // Read the route before deleting: after the account is gone activeId()
    // can no longer return it, so the old post-delete check left
    // provider-route.json naming a deleted account for the next restart.
    const wasRoute = (await this.activeId()) === id;
    const result = await provider.forget(id);
    if (wasRoute) await this.saveRoute(null, "");
    return result;
  }

  async authorize(site) {
    return String(site || "").startsWith("trae-")
      ? this.trae.authorize(site)
      : this.workbuddy.authorize(site);
  }

  async finishSignIn(result, site, auth = null) {
    const provider = String(site || result?.site || "").startsWith("trae-") ? this.trae : this.workbuddy;
    const stored = await provider.finishSignIn(result, site, auth);
    const current = await this.activeId();
    if (!current) await this.saveRoute(provider === this.trae ? "trae" : "workbuddy", stored.id);
    return { ...stored, provider: provider === this.trae ? "trae" : "workbuddy" };
  }
}
