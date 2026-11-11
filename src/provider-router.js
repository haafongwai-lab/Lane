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
   *
   * With no explicit account this is the merged catalogue of every routable
   * account, so the page can show that one model is served by two accounts.
   * An explicit id still asks that one account, which is what the account
   * page's per-row figures need.
   */
  async catalogue(id) {
    if (!id) return this.catalogueMerged();
    const account = await this.accountOf(id);
    if (!account) return (await this.activeProvider()).listModels("");
    return this.providerForAccount(account).listModels(id);
  }

  /**
   * The models agents may read: the merged catalogue minus everything the
   * user has not added. Every agent-facing path (the /v1/models route, model
   * resolution, the Codex and ZCode catalogue files) goes through this, so a
   * model that is not in the allowlist can neither be listed nor requested.
   */
  async listModels(id) {
    return restrictModels(await this.catalogue(id), this.env);
  }

  async chat(body, options) {
    return (await this.activeProvider()).chat(body, options);
  }

  /**
   * Sends one request to the account that owns its model.
   *
   * This is the multi-account path: the model id decides the account, not the
   * route. A model the allowlist does not serve is refused before anything is
   * sent, and a failure is reported as it came — never retried on another
   * account, because that would move the charge to a different payer.
   */
  async chatOn(body, options = {}) {
    const resolved = await this.resolveModel(body?.model);
    if (!resolved.known) return { resolved };
    return {
      resolved,
      response: await resolved.providerInstance.chat(
        { ...body, model: resolved.id },
        { ...options, accountId: resolved.accountId }
      )
    };
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

  /**
   * The accounts that contribute models to the merged catalogue, in a stable
   * order: the route account first, then WorkBuddy, then the rest by sign-in
   * order.
   *
   * `routable` is separate from `enabled`: an account can stay signed in and
   * keep its check-in while being left out of the model pool. An account that
   * is switched off entirely is never routable.
   */
  async routableAccounts() {
    const accounts = await this.accounts();
    const activeId = await this.activeId();
    const pool = accounts.filter((account) => account.enabled && account.routable !== false);
    // Provider first, route second. WorkBuddy has to lead even when the route
    // is a Trae account: its ids are the ones every existing models.json
    // names, so they keep the plain id, while Trae's are namespaced. Within
    // WorkBuddy the route account leads, so a model several accounts serve
    // resolves to the one the user last chose.
    const rank = (account) => (account.provider === "workbuddy" ? 0 : 1);
    return pool.sort((a, b) => {
      const byProvider = rank(a) - rank(b);
      if (byProvider) return byProvider;
      if (a.id === activeId && b.id !== activeId) return -1;
      if (b.id === activeId && a.id !== activeId) return 1;
      return String(a.addedAt || "").localeCompare(String(b.addedAt || ""));
    });
  }

  /**
   * A model id as the agents see it.
   *
   * Two providers can publish the same id (GLM-5.3, MiniMax, Kimi are on both
   * WorkBuddy and Trae), so a bare id is ambiguous. Every model from a
   * non-default provider is therefore namespaced: `trae:glm-5.3`. The
   * catalogue also carries `bareId`, so the model page can show the plain
   * name and the allowlist can migrate an old bare entry.
   */
  static qualifiedId(provider, id) {
    return provider === "workbuddy" ? String(id) : `${provider}:${id}`;
  }

  /** One account's models, each tagged with the account that serves it. */
  async accountModels(account) {
    const provider = this.providerForAccount(account);
    const models = await provider.listModels(account.id).catch(() => []);
    return (Array.isArray(models) ? models : []).map((model) => {
      const bareId = String(model.id);
      const qualified = ProviderRouter.qualifiedId(account.provider, bareId);
      return {
        ...model,
        id: qualified,
        bareId,
        provider: account.provider,
        ownerAccountId: account.id,
        ownerLabel: account.label || "",
        // Two accounts of the SAME provider can serve one id too (a domestic
        // and an overseas WorkBuddy account both publish hy3). Only the first
        // in the pool order keeps the plain id; the later ones are qualified
        // by their account so both remain selectable.
        sharedWith: []
      };
    });
  }

  /**
   * The full upstream catalogue, merged across every routable account.
   *
   * Used by the model page (which must show everything so the user can pick)
   * and by `listModels` (which then applies the allowlist).
   *
   * Collapsing rules, in order:
   *
   *   - Two providers publishing one id: WorkBuddy keeps the plain id and the
   *     other provider is namespaced (`trae:glm-5.3`), because the plain id
   *     is what every existing models.json names.
   *   - Two accounts of the SAME provider publishing one id: the first keeps
   *     the id and the rest are folded into its `sharedWith`, not emitted as
   *     separate rows. Four WorkBuddy accounts all publish `hy3`, and listing
   *     four identical rows per model is noise, not choice: the accounts are
   *     interchangeable for that model, so one row with a count is the truth.
   *     The folded accounts are still reachable by their `#suffix` id for a
   *     client that wants a specific one.
   */
  async catalogueMerged() {
    const accounts = await this.routableAccounts();
    const rows = (await Promise.all(accounts.map((account) => this.accountModels(account)))).flat();
    const byId = new Map();
    const out = [];
    for (const row of rows) {
      const seen = byId.get(row.id);
      if (!seen) {
        byId.set(row.id, row);
        out.push(row);
        continue;
      }
      // Same provider, same id: one row, with the others recorded on it. The
      // suffixed id is kept in `sharedWith` so it can still be selected.
      const suffix = row.ownerAccountId.slice(0, 8);
      const qualified = `${row.id}#${suffix}`;
      seen.sharedWith.push({ id: qualified, ownerAccountId: row.ownerAccountId, ownerLabel: row.ownerLabel });
      byId.set(qualified, row);
    }
    return out;
  }

  /**
   * Which account serves a requested model.
   *
   * The merged catalogue is the source of truth, because it is the only place
   * that knows about the `#suffix` ids minted when two accounts serve one
   * model id. Resolving against a fresh per-account scan would miss those and
   * refuse a model the page lists.
   *
   * A failure is never retried against another account: switching silently
   * would move the charge to a different account, and the bill would stop
   * matching what the user chose. The caller reports the refusal instead.
   */
  async resolveModel(requested) {
    const wanted = String(requested || "");
    if (!wanted) return { known: false };
    const catalogue = await this.catalogueMerged();
    const hit = catalogue.find((model) => model.id === wanted);
    if (!hit) {
      // A `#suffix` id names one folded account specifically; it is not a row
      // of its own, so it is matched against the folded list.
      for (const model of catalogue) {
        const folded = (model.sharedWith || []).find((item) => item.id === wanted);
        if (!folded) continue;
        const account = (await this.accounts()).find((item) => item.id === folded.ownerAccountId);
        if (!account) return { known: false };
        return {
          known: true,
          id: model.bareId,
          requested: wanted,
          provider: account.provider,
          accountId: account.id,
          providerInstance: this.providerForAccount(account),
          model
        };
      }
      return { known: false };
    }
    const account = (await this.accounts()).find((item) => item.id === hit.ownerAccountId);
    if (!account) return { known: false };
    return {
      known: true,
      id: hit.bareId,
      requested: wanted,
      provider: account.provider,
      accountId: account.id,
      providerInstance: this.providerForAccount(account),
      model: hit
    };
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

  /**
   * The hosts each provider's vendored plugin reached, plus the guard mode.
   * Merged across providers so the settings page shows one list: the question
   * it answers is "what does Lane talk to", not "what does one plugin do".
   */
  egressReport() {
    const parts = [this.workbuddy, this.trae].map((provider) =>
      (typeof provider?.egressReport === "function"
        ? provider.egressReport()
        : { mode: "off", hosts: [] }));
    const hosts = new Map();
    for (const part of parts) {
      for (const item of part.hosts || []) {
        const existing = hosts.get(item.host);
        if (existing) {
          existing.count += item.count;
          existing.at = Math.max(existing.at, item.at);
          existing.blocked = existing.blocked || item.blocked;
          // Both providers can reach the same host; the merged row keeps the
          // paths and audit reasons from each, deduplicated by path/reason.
          for (const path of item.paths || []) {
            const seen = existing.paths.find((entry) => entry.path === path.path);
            if (seen) {
              seen.count += path.count;
              seen.at = Math.max(seen.at, path.at);
            } else if (existing.paths.length < 20) {
              existing.paths.push({ ...path });
            }
          }
          for (const reason of item.suspicious || []) {
            const seen = existing.suspicious.find((entry) => entry.reason === reason.reason);
            if (seen) {
              seen.count += reason.count;
              seen.at = Math.max(seen.at, reason.at);
            } else if (existing.suspicious.length < 20) {
              existing.suspicious.push({ ...reason });
            }
          }
          continue;
        }
        hosts.set(item.host, { ...item, paths: [...(item.paths || [])], suspicious: [...(item.suspicious || [])] });
      }
    }
    return {
      mode: parts.find((part) => part.mode && part.mode !== "off")?.mode || "monitor",
      hosts: [...hosts.values()].sort((a, b) => b.at - a.at),
      suspicious: [...hosts.values()].reduce((sum, item) => sum + (item.suspicious?.length || 0), 0)
    };
  }

  invalidateModels() {
    this.workbuddy.invalidateModels();
    this.trae.invalidateModels();
  }

  /** Drop every loaded plugin instance after an update or a rollback. */
  reloadPlugins() {
    this.workbuddy.reloadPlugins?.();
    this.trae.reloadPlugins?.();
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
