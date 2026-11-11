import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { writeTextAtomic } from "./agents/store.js";
import { WorkBuddyProvider } from "./workbuddy.js";
import { TraeProvider } from "./trae.js";
import { QoderProvider } from "./qoder.js";
import { restrictModels } from "./model-gate.js";

/** The upstream a site belongs to. One provider can serve several sites. */
export const SITE_PROVIDER = {
  workbuddy: "workbuddy",
  "workbuddy-ai": "workbuddy",
  "trae-cn": "trae",
  "trae-global": "trae",
  qoder: "qoder",
  "qoder-cn": "qoder"
};

export function providerOfSiteName(site) {
  return SITE_PROVIDER[String(site || "")] || "workbuddy";
}

/**
 * Lane's upstream switchboard.
 *
 * Every provider keeps its own account store and its own sign-in; this router
 * is the one object the gateway, control center and CLI talk to. It merges the
 * account lists for the UI, remembers which account owns the route in
 * provider-route.json, and delegates every provider operation to the owner.
 * Model ids are namespaced by the provider that serves them, so an existing
 * WorkBuddy-only install behaves exactly as before.
 */
export class ProviderRouter {
  constructor({ env = process.env, workbuddy = null, trae = null, qoder = null } = {}) {
    this.env = env;
    this.providers = {
      workbuddy: workbuddy || new WorkBuddyProvider({ env }),
      trae: trae || new TraeProvider({ env }),
      qoder: qoder || new QoderProvider({ env })
    };
    // Named handles kept for callers that already reach for one provider.
    this.workbuddy = this.providers.workbuddy;
    this.trae = this.providers.trae;
    this.qoder = this.providers.qoder;
    this.routeFile = path.join(dataDir(env), "provider-route.json");
    this.ready = false;
    this.route = null;
  }

  /** Every provider, in the order the UI lists them. */
  list() {
    return Object.values(this.providers);
  }

  providerNamed(name) {
    return this.providers[name] || this.providers.workbuddy;
  }

  async init() {
    if (this.ready) return this;
    // A broken optional upstream must not take the primary one down: a
    // truncated Trae or Qoder account file is that provider's problem, not a
    // WorkBuddy outage.
    await Promise.all([
      this.workbuddy.init(),
      this.trae.init().catch(() => null),
      this.qoder.init().catch(() => null)
    ]);
    this.route = await this.readRoute();
    this.ready = true;
    return this;
  }

  async readRoute() {
    try {
      const value = JSON.parse(await fs.readFile(this.routeFile, "utf8"));
      if (value && typeof value === "object" && typeof value.id === "string" && value.id) {
        return {
          provider: this.providers[value.provider] ? value.provider : "workbuddy",
          id: value.id
        };
      }
    } catch {}
    return null;
  }

  async saveRoute(provider, id) {
    const name = this.providers[provider] ? provider : "workbuddy";
    this.route = id ? { provider: name, id } : null;
    if (!this.route) {
      await fs.rm(this.routeFile, { force: true }).catch(() => {});
      return;
    }
    await writeTextAtomic(this.routeFile, `${JSON.stringify(this.route)}\n`);
  }

  async accounts() {
    await this.init();
    const lists = await Promise.all(
      Object.entries(this.providers).map(async ([name, provider]) => {
        const accounts = await provider.accounts().catch(() => []);
        return accounts.map((account) => ({ ...account, provider: name }));
      })
    );
    return lists.flat();
  }

  async accountOf(id) {
    return (await this.accounts()).find((account) => account.id === id) || null;
  }

  providerForAccount(account) {
    return this.providerNamed(account?.provider);
  }

  async activeId() {
    await this.init();
    const route = await this.readRoute();
    this.route = route;
    if (route?.id) {
      const found = await this.accountOf(route.id);
      if (found) return route.id;
    }
    for (const [name, provider] of Object.entries(this.providers)) {
      const id = await provider.activeId().catch(() => "");
      if (!id) continue;
      // Keep the in-memory route in step with the fallback, so cachedModels()
      // does not pick the provider named by a route file whose account is
      // gone. The file itself is left alone until the next explicit switch.
      this.route = { provider: name, id };
      return id;
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
   * order: WorkBuddy first (its ids stay unqualified), then the route account
   * among them, then the rest by sign-in order.
   *
   * Only accounts explicitly switched into the pool take part. `routable` is
   * separate from `enabled`: an account can stay signed in and keep its
   * check-in while being left out of the pool, and a switched-off account is
   * never routable either way.
   */
  async routableAccounts() {
    const accounts = await this.accounts();
    const activeId = await this.activeId();
    const pool = accounts.filter((account) => account.enabled && account.routable === true);
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
    // A provider can hand back an id that already carries a prefix (a saved
    // allowlist entry read back through a provider that kept it). Strip it
    // first, or the prefix doubles into `trae:trae:…`.
    let name = String(id);
    for (const known of ["workbuddy", "trae", "qoder"]) {
      if (name.startsWith(`${known}:`)) {
        name = name.slice(known.length + 1);
        break;
      }
    }
    // WorkBuddy keeps the plain id: it is what every existing models.json
    // names, and what a client sends when it has not been told otherwise.
    return provider === "workbuddy" ? name : `${provider}:${name}`;
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
    const accounts = await this.accounts();

    const answer = (model, account, id) => ({
      known: true,
      id,
      requested: wanted,
      provider: account.provider,
      accountId: account.id,
      providerInstance: this.providerForAccount(account),
      model
    });

    const hit = catalogue.find((model) => model.id === wanted);
    if (hit) {
      const account = accounts.find((item) => item.id === hit.ownerAccountId);
      return account ? answer(hit, account, hit.bareId) : { known: false };
    }

    // A `#suffix` id names one folded account specifically; it is not a row
    // of its own, so it is matched against the folded list.
    for (const model of catalogue) {
      const folded = (model.sharedWith || []).find((item) => item.id === wanted);
      if (!folded) continue;
      const account = accounts.find((item) => item.id === folded.ownerAccountId);
      return account ? answer(model, account, model.bareId) : { known: false };
    }

    // An agent that namespaces its own models sends that namespace back. VS
    // Code's Chat writes every entry as `lane/<id>` and sends exactly that,
    // so a request arriving as `lane/trae:glm-5.3` has to be read as
    // `trae:glm-5.3` or every VS Code turn is refused as an unknown model.
    const stripped = wanted.replace(/^lane\//i, "");
    if (stripped !== wanted) {
      const inner = await this.resolveModel(stripped);
      // The reply keeps the id the caller asked with, so a client that
      // matches responses by its own model name still recognises them.
      return inner.known ? { ...inner, requested: wanted } : inner;
    }

    // A bare id a client still carries from before the ids were namespaced
    // (Claude Desktop keeps the chosen model in the conversation, and an
    // agent's config names it). Refusing it turned a working setup into a
    // 400 the moment the pool listed that model under a prefixed id.
    //
    // A bare id that more than one provider serves is ambiguous: the
    // unprefixed row is the default provider's, and the first match in the
    // pool order wins, which is exactly the row that kept the plain id.
    const byBare = catalogue.find((model) => model.bareId === wanted && model.id === wanted)
      || catalogue.find((model) => model.bareId === wanted);
    if (byBare) {
      const account = accounts.find((item) => item.id === byBare.ownerAccountId);
      return account ? answer(byBare, account, byBare.bareId) : { known: false };
    }
    return { known: false };
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
    return this.providerNamed(this.route?.provider).cachedModels();
  }

  /**
   * The hosts each provider's vendored plugin reached, plus the guard mode.
   * Merged across providers so the settings page shows one list: the question
   * it answers is "what does Lane talk to", not "what does one plugin do".
   */
  egressReport() {
    const parts = this.list().map((provider) =>
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
    for (const provider of this.list()) provider.invalidateModels();
  }

  /** Drop every loaded plugin instance after an update or a rollback. */
  reloadPlugins() {
    for (const provider of this.list()) provider.reloadPlugins?.();
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

  /**
   * Takes one account in or out of the model pool.
   *
   * Forwarded here because the account page talks to the router, not to a
   * provider: without this the switch had no effect and the pool stayed
   * empty no matter what the user did.
   */
  async setRoutable(id, routable) {
    const account = await this.accountOf(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    const provider = this.providerForAccount(account);
    if (typeof provider.setRoutable !== "function") {
      throw new Error(`${account.provider} accounts cannot join the model pool`);
    }
    const updated = await provider.setRoutable(id, routable);
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
    const provider = this.providerNamed(providerOfSiteName(site));
    return provider.authorize(site);
  }

  async finishSignIn(result, site, auth = null) {
    const provider = this.providerNamed(providerOfSiteName(site || result?.site));
    const stored = await provider.finishSignIn(result, site, auth);
    const current = await this.activeId();
    if (!current) await this.saveRoute(stored.provider || providerOfSiteName(stored.site), stored.id);
    return { ...stored, provider: providerOfSiteName(stored.site) };
  }
}
