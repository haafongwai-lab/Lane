import { assertLoopbackHost, dataDir, gatewayBase } from "./config.js";
import { ProviderRouter } from "./provider-router.js";
import { allowedModels, modelGateCorrupt, restrictModels, setModelEnabled } from "./model-gate.js";
import { readState } from "./agents/store.js";
import { codexConfigPath, claudePaths } from "./agents/paths.js";
import { RequestJournal } from "./request-journal.js";
import { connectCodex, disconnectCodex, syncCodexCatalog } from "./agents/codex.js";
import {
  connectClaudeDesktop,
  disconnectClaudeDesktop
} from "./agents/claude-desktop.js";
import { connectZcode, disconnectZcode, syncZcodeCatalog, zcodePaths } from "./agents/zcode.js";
import { connectDsh, disconnectDsh, dshStatus, dshPatchPath } from "./agents/dsh.js";
import { installWindowsTask, uninstallWindowsTask, startupDir } from "./windows-task.js";
import { checkinOverview, forgetCheckinAccount, runCheckins, startCheckinScheduler, updateSettings } from "./checkin.js";
import { summary as usageSummary, RANGES, billedRates, rangeStart, rangeEnd } from "./usage.js";
import * as mcpServers from "./mcp-servers.js";
import * as mcpDeploy from "./mcp-deploy.js";
import * as skills from "./skills.js";
import { freeAllowance } from "./free-window.js";
import { testMcpServer } from "./mcp-test.js";
import fs from "node:fs/promises";
import path from "node:path";

export function createControlCenter({
  env = process.env,
  port = 3426,
  host = "127.0.0.1",
  onSignIn = () => {},
  checkins = false,
  // A secondary window attached to a gateway another Lane owns: its journal
  // follows the owner's file instead of serving the snapshot from start-up.
  shared = false
} = {}) {
  // The control center is reachable over the same loopback socket as the
  // data plane; never let it be constructed for a LAN address by accident.
  assertLoopbackHost(host);
  const root = dataDir(env);
  const journal = new RequestJournal({ dir: root, shared });
  const gateway = gatewayBase(host, port);
  let provider;
  // Keyed by site: the two builds sign in independently, and a pending
  // domestic sign-in must not answer an overseas request.
  const signInPending = new Map();
  let signInError = "";
  let scheduler = null;
  // Set when the control is stopped; a scheduler that finishes mounting
  // afterwards must not start behind a control that is already gone.
  let disposed = false;
  let mounting = null;

  // The promise is what is memoized, not the result: callers that overlap
  // with init() must wait for one provider, not each build their own — two
  // instances race the same rotating refresh tokens, and the loser's write
  // leaves a dead token in accounts.json until the user signs in again.
  let providerLoading = null;
  const getProvider = () => {
    if (provider) return Promise.resolve(provider);
    providerLoading ??= new ProviderRouter({ env }).init()
      .then((instance) => {
        provider = instance;
        return instance;
      })
      .catch((error) => {
        // A failed init must not poison every later call: forget the
        // promise so the next caller tries again.
        providerLoading = null;
        throw error;
      });
    return providerLoading;
  };

  // WorkBuddy's usage hook is two billing calls, and both the window's status
  // poll and the usage view ask for it. Answer from a short-lived cache so a
  // foreground window costs one upstream read a minute instead of one every
  // 3 seconds, and a failing read is not retried on every poll either.
  //
  // The cache is keyed by account: switching the route must show the new
  // account's credits at once, not the previous account's until it expires.
  const USAGE_TTL_MS = 60_000;
  const USAGE_ERROR_TTL_MS = 15_000;
  const usageCache = new Map();
  const cachedUsage = async (instance) => {
    const id = await instance.activeId().catch(() => "");
    const now = Date.now();
    const hit = usageCache.get(id);
    if (hit && now - hit.at < hit.ttl) return hit.value;
    let value;
    try {
      // accountUsage() so a Trae billing-page "expired" does not light the
      // whole route account as logged out while its chat keeps working.
      value = typeof instance.accountUsage === "function"
        ? await instance.accountUsage()
        : await instance.usage();
    } catch (error) {
      value = { error: error?.message || "usage is unknown" };
    }
    const failed = Boolean(value?.error);
    usageCache.set(id, {
      at: now,
      ttl: failed ? USAGE_ERROR_TTL_MS : USAGE_TTL_MS,
      value
    });
    return value;
  };
  // A finished request spends credits upstream, so the cached figure
  // is stale the moment it lands; dropping it here makes the next status
  // poll read the balance as it is now, not up to a minute late.
  // The per-account read also feeds the accounts list's credits chip and
  // the international Free plan's allowance, which lives on that account
  // even while another account is the route. It is read per its own id —
  // a network round trip — and cached longer: a balance moves slowly, and
  // the list holds several accounts.
  const FREE_TTL_MS = 5 * 60_000;
  // Stale-while-revalidate, deliberately: neither the usage route nor the
  // status poll may block on a WorkBuddy round trip - the first visit would
  // render seconds late. A cached value answers at once and the refresh runs
  // behind; the card appears on the next poll. A never-fetched account
  // answers null once.
  //
  // Keyed by account: two accounts hold different balances, and a single
  // slot would hand the second one the first one's figures for five minutes
  // after a switch.
  const freeUsageCache = new Map();
  const cachedAccountUsage = (instance, id) => {
    const key = String(id || "");
    const entry = freeUsageCache.get(key);
    const now = Date.now();
    if (entry && now - entry.at < FREE_TTL_MS) return Promise.resolve(entry.value);
    if (!entry?.refreshing) {
      freeUsageCache.set(key, { at: entry?.at ?? 0, value: entry?.value ?? null, refreshing: true });
      // A Trae account's billing read can say "expired" while its chat keeps
      // working; the chip must not claim the whole account is logged out
      // over a billing-page hiccup, so the read goes through accountUsage().
      const read = typeof instance.accountUsage === "function"
        ? instance.accountUsage(id)
        : instance.usage(id);
      read
        .then((value) => {
          freeUsageCache.set(key, { at: Date.now(), value });
        })
        .catch(() => {
          freeUsageCache.set(key, { at: Date.now(), value: { error: "usage is unknown" } });
        });
    }
    return Promise.resolve(freeUsageCache.get(key)?.value ?? null);
  };

  // Every account row in the status snapshot carries its own credits, read
  // through the same stale-while-revalidate cache the usage route's free
  // allowance uses: the accounts list answers from cache at once, a
  // never-fetched account shows nothing once, and the figures fill in on
  // the next poll without anyone waiting on a billing round trip.
  const withCredits = async (instance, accounts) => {
    return Promise.all(accounts.map(async (account) => ({
      ...account,
      credits: await cachedAccountUsage(instance, account.id)
    })));
  };

  /**
   * The free-model allowance belongs to WorkBuddy's Free plan, not to one
   * account: every signed-in account declares the same `notModels`, and the
   * day's traffic is routed through whichever account happens to be active.
   * Lane used to count only the international account's rows, so the card
   * showed "0 今日请求" whenever a domestic account was the route — the usual
   * case. Read the credit window from any account that declares one (the
   * international build is preferred, as the card was written for its Free
   * plan), but count free-model traffic over the whole journal, which is what
   * "今日请求 / 本机累计" means. The same report feeds the model list, so an
   * exhausted allowance names its real reset time there too.
   *
   * `routeId` is the account carrying requests, and it decides which
   * allowance the model list reflects: the state must follow the route
   * account and nothing else. Each account's model list shows THAT account's
   * allowance; a Trae account has no free-model allowance, so it gets null
   * (the model list then reads "可用" for everything) rather than leaking a
   * WorkBuddy account's exhausted state into it.
   */
  const freeReportFor = async (instance, rows, accounts = null, routeId = null) => {
    try {
      const list = Array.isArray(accounts) ? accounts : await instance.accounts();
      if (!list.length) return null;
      const route = routeId ? list.find((item) => item.id === routeId) : null;
      // A route id that no longer names an account must not silently fall
      // back to another account: that is how a switched-away account's
      // exhausted free models kept showing on the new account.
      if (routeId && !route) return null;
      // The route account alone decides. Without an explicit route (the usage
      // page calling for the whole journal) try each WorkBuddy account until
      // one actually declares a Free plan; picking the first non-Trae account
      // could hide the free card whenever that account was paid.
      const candidates = route
        ? [route]
        : list.filter((item) => item.provider !== "trae");
      for (const source of candidates) {
        const usage = await cachedAccountUsage(instance, source.id);
        const report = freeAllowance(usage, rows, { accountId: source.id });
        if (report) return report;
      }
      return null;
    } catch {
      return null;
    }
  };

  // A finished request spends credits upstream, so the caches are stale the
  // moment it lands. The active account's quota card revalidates behind the
  // next poll, and so does that account's row in the accounts list — but
  // only that account: the others' balances have not moved, and dropping
  // every entry here would put a billing read per account on the wire after
  // each request, since the status poll now consults this cache. A request
  // names the account it billed; the caller passes it.
  const invalidateUsage = (accountId = "") => {
    usageCache.clear();
    if (accountId) freeUsageCache.delete(String(accountId));
    else freeUsageCache.clear();
  };
  // Switching, switching off or removing the route invalidates every entry:
  // the figure that matters is always the current account's.
  const forgetUsage = () => {
    usageCache.clear();
    freeUsageCache.clear();
  };

  // Only the process that owns the gateway runs the daily check-in; a
  // second Lane window attaches to it instead of claiming twice.
  if (checkins) {
    mounting = getProvider()
      .then((instance) => {
        // stop() can overtake this mount when a gateway start fails on its
        // listen call: the scheduler must not come up behind a control
        // that is already gone.
        if (!disposed) {
          scheduler = startCheckinScheduler({ provider: instance, env });
        }
      })
      .catch(() => {});
  }

  const activeAccount = async (instance) => {
    const id = await instance.activeId();
    return (await instance.accounts()).find((account) => account.id === id) || null;
  };

  const applyConnect = async (agent, options) => {
    const target = options.gateway || gateway;
    if (agent === "codex") {
      const instance = await getProvider();
      return connectCodex({
        env,
        gateway: target,
        providerModels: () => instance.listModels()
      });
    }
    if (agent === "claude-desktop") {
      return connectClaudeDesktop({ env, gateway: target });
    }
    if (agent === "zcode") {
      const instance = await getProvider();
      return connectZcode({
        env,
        gateway: target,
        providerModels: () => instance.listModels()
      });
    }
    if (agent === "dsh") {
      const instance = await getProvider();
      return connectDsh({
        env,
        gateway: target,
        providerModels: () => instance.listModels()
      });
    }
    throw new Error(`unknown agent: ${agent}`);
  };

  const applyDisconnect = async (agent) => {
    if (agent === "codex") return disconnectCodex({ env });
    if (agent === "claude-desktop") return disconnectClaudeDesktop({ env });
    if (agent === "zcode") return disconnectZcode({ env });
    if (agent === "dsh") return disconnectDsh({ env });
    throw new Error(`unknown agent: ${agent}`);
  };

  // Every wiring change reads, edits and rewrites the one wiring.json; two
  // changes at once (each agent's toggle clicked in quick succession) would
  // have the second read the state before the first wrote it, and the file
  // would remember only one of them.
  let wiringQueue = Promise.resolve();
  const serializeWiring = (task) => {
    const next = wiringQueue.then(task, task);
    wiringQueue = next.catch(() => {});
    return next;
  };

  return {
    journal,

    invalidateUsage,

    async status() {
      const instance = await getProvider();
      // The status snapshot carries fields that need no network (accounts,
      // wiring, autostart); a catalogue the upstream cannot serve right now
      // must not take those down with it — and must not take the catalogue
      // Codex already has down either: syncing an empty list would wipe
      // lane-models.json for as long as the outage lasts.
      //
      // The page renders the FULL catalogue with a per-row 添加 switch, while
      // every agent-facing path serves only the allowed models. Both are plain
      // data: a function in this object would break the IPC structured clone
      // and leave the window with no snapshot at all.
      const catalogue = await (typeof instance.catalogue === "function"
        ? instance.catalogue()
        : instance.listModels()).catch(() => null);
      const allowed = await allowedModels(env);
      const models = Array.isArray(catalogue) ? await restrictModels(catalogue, env) : catalogue;
      const gateCorrupt = await modelGateCorrupt(env);
      // Plain data only: an `enabled(id)` function here would break the IPC
      // structured clone and leave the window with no snapshot at all. Keys
      // are `provider:id` for new entries; a legacy bare id matches both
      // providers until that row is changed.
      const enabledKeys = [...allowed];
      const enabledIds = Array.isArray(catalogue)
        ? catalogue
          .filter((model) => {
            const id = String(model?.id || "");
            const provider = String(model?.owned_by || model?.provider || "workbuddy");
            return id && (allowed.has(id) || allowed.has(`${provider}:${id}`));
          })
          .map((model) => String(model.id))
        : [];
      // A truncated wiring.json is one agent-wiring file gone wrong; the
      // accounts, activity and models it must not take down with it.
      let state = {};
      try {
        state = await readState(env);
      } catch {}
      // Both clients keep the catalogue in a file of their own, so both are
      // refreshed from the account the gateway is actually routing to: a
      // switch between sites changes the list behind an unchanged URL. An
      // empty list is a real state once every model has been removed, so it
      // must clear the files too; only a failed catalogue (null) is skipped.
      if (Array.isArray(models)) {
        await syncCodexCatalog({ env, models }).catch(() => {});
        await syncZcodeCatalog({ env, models }).catch(() => {});
      }
      let signedIn = false;
      try {
        signedIn = await instance.signedIn();
      } catch {}
      const account = await activeAccount(instance);
      const accountList = await instance.accounts().catch(() => []);
      // The model page needs the free-allowance state of the account that
      // actually carries the requests: an exhausted free model names its real
      // reset time there, and the state follows the route account instead of
      // always reading one global overseas account. Trae accounts have no
      // free-model allowance, so that report is null for them.
      const freeReport = await freeReportFor(instance, journal.list(), accountList, account?.id);
      let usage = null;
      if (signedIn) {
        try {
          usage = await cachedUsage(instance);
        } catch {
          usage = { error: "usage is unknown" };
        }
      }
      let autostart = false;
      try {
        const startup = startupDir(env);
        await Promise.any([
          fs.access(path.join(startup, "Lane Gateway.lnk")),
          fs.access(path.join(startup, "Lane.lnk"))
        ]);
        autostart = true;
      } catch {}
      return {
        gateway,
        dataDir: root,
        signedIn,
        account: account?.label || "",
        accountId: account?.id || "",
        domain: account?.domain || "",
        expiresAt: account?.expiresAt || null,
        accounts: await withCredits(instance, accountList),
        activeId: await instance.activeId(),
        checkin: await checkinOverview(instance, env).catch(() => null),
        usage,
        freeAllowance: freeReport,
        // `models` is the agent-facing list (added models only); `catalogue`
        // is the full upstream list the page draws its 添加 switches from, and
        // `modelGate.enabledIds` says which of those the user has added. No
        // functions cross the IPC boundary: structuredClone would reject them
        // and the whole status call would fail.
        models,
        catalogue: Array.isArray(catalogue) ? catalogue : [],
        modelGate: { gated: true, enabledIds, enabledKeys, corrupt: gateCorrupt },
        agents: {
          codex: {
            connected: Boolean(state.lane?.connected),
            configPath: codexConfigPath(env)
          },
          claudeDesktop: {
            connected: Boolean(state["claude-desktop"]?.connected),
            modeConfig: claudePaths(env).modeConfig
          },
          zcode: {
            connected: Boolean(state.zcode?.connected),
            configPath: zcodePaths(env).config
          },
          dsh: await dshStatus({ env }).catch(() => ({
            connected: false,
            configPath: dshPatchPath(env),
            installed: false
          }))
        },
        autostart,
        signInPending: signInPending.size > 0,
        signInError,
        recent: journal.recent(),
        // Counted over the whole journal: the recent window alone hides old
        // history behind a busy day's traffic.
        clearableHistory: journal.countBeforeToday()
      };
    },

    async accounts() {
      const instance = await getProvider();
      return {
        accounts: await instance.accounts(),
        activeId: await instance.activeId()
      };
    },

    /**
     * Signing in always adds an account: an existing one is refreshed, a new
     * one joins the list. It becomes the route only when nothing else is.
     */
    async signIn(options = {}) {
      const site = ["workbuddy-ai", "trae-cn", "trae-global"].includes(options.site)
        ? options.site
        : "workbuddy";
      // One sign-in per build. A pending domestic sign-in used to swallow an
      // overseas request and hand back its own URL, so choosing WorkBuddy AI
      // opened the domestic page and no overseas account was ever written.
      const pending = signInPending.get(site);
      if (pending) return { pending: true, url: pending.url, site };
      const instance = await getProvider();
      const result = await instance.authorize(site);
      signInPending.set(site, result);
      signInError = "";
      // The plugin polls for at most five minutes; a user who never finishes
      // the browser round trip would otherwise leave this site's sign-in
      // slot occupied until Lane restarts.
      const pendingTimeout = setTimeout(() => signInPending.delete(site), 6 * 60 * 1000);
      pendingTimeout.unref?.();
      // No event is sent for the start: the window that asked for the sign-in
      // already opens the URL from this call's return value, and an event
      // here would read as "signed in" before the browser is even open.
      result.callback()
        .then(async (auth) => {
          if (auth?.type !== "success") throw new Error(auth?.error || "sign-in failed");
          // The outcome is handed over rather than waited for again inside
          // finishSignIn: the plugin's callback polls a token endpoint that
          // a second call with the same state need not answer.
          return instance.finishSignIn(result, site, auth);
        })
        // A fresh sign-in makes yesterday's "expired" check-in record wrong:
        // clear it and try today's claim once, so the account does not sit on
        // a 30-minute retry timer with a token that has just been replaced.
        .then(async (account) => {
          if (account?.id) {
            await forgetCheckinAccount(account.id, env).catch(() => {});
            await runCheckins({ provider: instance, env, only: [account.id] }).catch(() => {});
          }
        })
        // The window refreshes its status on this second call; the account
        // itself is read from that status, so only clear the error here.
        .then(() => { onSignIn(null, null); })
        .catch((error) => {
          signInError = error?.message || "sign-in failed";
          // Both the window and the log get it: a sign-in that never lands
          // is otherwise a toast nobody can read afterwards.
          console.error(`sign-in (${site}) failed: ${signInError}`);
          onSignIn(null, error);
        })
        .finally(() => {
          clearTimeout(pendingTimeout);
          signInPending.delete(site);
        });
      return { pending: true, url: result.url, site, instructions: result.instructions || "" };
    },

    async activate(id) {
      const instance = await getProvider();
      const account = await instance.activate(id);
      forgetUsage();
      // The catalogue belongs to the account now in force, and both clients
      // keep a copy in files of their own: refresh them at the switch, not
      // whenever the window next polls. allSettled rather than all - one
      // client's write failing must not cancel the other's, and neither may
      // fail the switch itself. listModels() is already the allowed subset.
      await this.syncCatalogs(instance);
      return account;
    },

    /** Rewrites the Codex and ZCode catalogues from the allowed model list. */
    async syncCatalogs(instance = null) {
      const target = instance || (await getProvider());
      await target.listModels()
        .then((models) => (Array.isArray(models)
          ? Promise.allSettled([
            syncCodexCatalog({ env, models }),
            syncZcodeCatalog({ env, models })
          ])
          : null))
        .catch(() => {});
    },    /**
     * The per-model 添加/移除 switch. Nothing is served until the user adds
     * it, so this is the only way a model becomes visible to an agent.
     */
    async setModelEnabled(id, enabled, provider = "") {
      const instance = await getProvider();
      await setModelEnabled(id, enabled, env, provider);
      // No account switch here: rewriting the two catalogue files is enough,
      // and activate() would also move the route's last-used stamp.
      await this.syncCatalogs(instance);
      return { ok: true, id, provider, enabled: Boolean(enabled) };
    },

    async setEnabled(id, enabled) {
      const instance = await getProvider();
      const account = await instance.setEnabled(id, enabled);
      forgetUsage();
      return account;
    },

    async removeAccount(id) {
      const instance = await getProvider();
      const result = await instance.forget(id);
      forgetUsage();
      return result;
    },

    // Kept for the old single-account UI: it removes whichever account the
    // route points at.
    async signOut() {
      const instance = await getProvider();
      const id = await instance.activeId();
      if (!id) return { ok: true, removed: false };
      await instance.forget(id);
      return { ok: true, removed: true, activeId: await instance.activeId() };
    },

    async checkin(id = "") {
      const instance = await getProvider();
      const run = await runCheckins({
        provider: instance,
        env,
        force: true,
        only: id ? [id] : null
      });
      // A check-in tops the balance up, so the old figure must not linger.
      // A single account's run invalidates just that account; a run over
      // every account (no id) drops all of them.
      invalidateUsage(id);
      return { ...run, overview: await checkinOverview(instance, env) };
    },

    async checkinSettings(patch) {
      const settings = await updateSettings(patch, env);
      return { settings };
    },

    async checkinOverview() {
      const instance = await getProvider();
      return checkinOverview(instance, env);
    },

    // `options.gateway` overrides the address this control center was built
    // with: the settings page saves a new port while the running gateway
    // still owns the old one, and the wirings it rewrites must carry the
    // address the gateway will listen on after the restart, not the one it
    // listens on now.
    async connect(agent, options = {}) {
      return serializeWiring(() => applyConnect(agent, options));
    },

    async disconnect(agent) {
      return serializeWiring(() => applyDisconnect(agent));
    },

    async autostart(enabled, options = {}) {
      if (!enabled) return uninstallWindowsTask({ env });
      // Even callers inside Lane only get to change the pieces the UI owns;
      // node/script/env are not part of the public option shape.
      const safe = {};
      if (typeof options.desktopExe === "string" && options.desktopExe) safe.desktopExe = options.desktopExe;
      if (Number.isInteger(options.port) && options.port >= 1 && options.port <= 65535) safe.port = options.port;
      await installWindowsTask({ env, port, ...safe });
      return { enabled };
    },

    activity() {
      return journal.list();
    },

    // Only the owner's journal may be rewritten; a shared window's clear
    // request reaches the owner's gateway over the loopback, so this is
    // simply refused on a reader.
    clearHistory(ids = null) {
      if (journal.shared) throw new Error("只读窗口不能清除历史记录");
      return Array.isArray(ids) ? journal.removeByIds(ids) : journal.clearBeforeToday();
    },

    // The models table is an aggregate over the selected range, so deleting
    // one row deletes that model's rows from that range only. The range key
    // is validated against the same list `usage` uses, so an unknown value
    // cannot widen the deletion to the whole journal.
    clearModel(model, range = "today") {
      if (journal.shared) throw new Error("只读窗口不能清除历史记录");
      const wanted = String(model || "").trim();
      const key = RANGES.some((item) => item.key === range) ? range : "today";
      if (!wanted) return { removed: 0, model: wanted, range: key };
      const removed = journal.removeByModel(wanted, { since: rangeStart(key), until: rangeEnd() });
      return { removed, model: wanted, range: key };
    },

    // ---- MCP & skills -------------------------------------------------------
    // Writes reach the user's own client configurations, so a read-only
    // follower refuses them the same way it refuses journal writes.
    mcpServers() {
      return mcpServers.readServers(env);
    },

    async mcpUpsert(server) {
      if (journal.shared) throw new Error("只读窗口不能管理 MCP");
      const saved = await mcpServers.upsertServer(server, env);
      const report = await mcpDeploy.deploy(await mcpServers.readServers(env), env);
      return { server: saved, report };
    },

    // Tests the server as the registry holds it — the entry the clients were
    // given, not a hypothetical one — so what passes here is what they run.
    async mcpTest(name) {
      if (journal.shared) throw new Error("只读窗口不能管理 MCP");
      const server = (await mcpServers.readServers(env)).find((s) => s.name === name);
      if (!server) throw Object.assign(new Error("没有这个 MCP 服务"), { status: 404 });
      return testMcpServer(server);
    },

    async mcpRemove(name) {
      if (journal.shared) throw new Error("只读窗口不能管理 MCP");
      const had = await mcpServers.removeServer(name, env);
      const report = await mcpDeploy.deploy(await mcpServers.readServers(env), env);
      return { removed: Boolean(had), report };
    },

    async mcpToggle(name, off) {
      if (journal.shared) throw new Error("只读窗口不能管理 MCP");
      const row = await mcpServers.setServerEnabled(name, off, env);
      const report = await mcpDeploy.deploy(await mcpServers.readServers(env), env);
      return { server: row, report };
    },

    async mcpSetAgents(name, agents) {
      if (journal.shared) throw new Error("只读窗口不能管理 MCP");
      const row = await mcpServers.setServerAgents(name, agents, env);
      const report = await mcpDeploy.deploy(await mcpServers.readServers(env), env);
      return { server: row, report };
    },

    mcpTargets() {
      return mcpDeploy.targets(env);
    },

    async skillsList() {
      // The built-in skills are copied into the library on first read, so the
      // page shows them exactly like imported ones (with a green "builtin"
      // marker added here; the skill folder itself stays a normal folder).
      await skills.ensureBuiltins(env);
      const rows = await skills.listLibrary(env);
      return rows
        .map((row) => ({ ...row, builtin: skills.isBuiltinSkill(row.name) }))
        .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
    },

    async skillsImport(sourceDir) {
      if (journal.shared) throw new Error("只读窗口不能管理技能");
      return skills.importFrom(sourceDir, env);
    },

    async skillsRemove(name) {
      if (journal.shared) throw new Error("只读窗口不能管理技能");
      if (skills.isBuiltinSkill(name)) {
        throw Object.assign(new Error("内置技能不能删除"), { status: 400 });
      }
      return skills.removeFromLibrary(name, env);
    },

    async skillsInstall(name, agent) {
      if (journal.shared) throw new Error("只读窗口不能管理技能");
      await skills.ensureBuiltins(env);
      return skills.installTo(name, agent, env);
    },

    async skillsUninstall(name, agent) {
      if (journal.shared) throw new Error("只读窗口不能管理技能");
      return skills.uninstallFrom(name, agent, env);
    },


    /**
     * Token and credit totals for the usage view. Billed credits come from
     * the upstream's own `credit` report; the token formula costs only the
     * rows that predate it, as clearly separate estimates. The account's own
     * credits, as WorkBuddy reports them, are a separate figure (`quota`) and
     * are not mixed in.
     */
    async usage(range = "today") {
      const instance = await getProvider();
      // Estimates are priced from what the upstream itself charged for each
      // model, read out of the journal — the catalogue's `rate` is a
      // relative multiple (×0.08), not a credits-per-million price, and
      // costing with it understated real charges by two orders of magnitude.
      // One read, used for both the prices and the rows: a shared window's
      // list() re-reads the file per call, and two calls could straddle the
      // owner's write between them.
      const rows = journal.list();
      const rates = billedRates(rows);
      const report = usageSummary(rows, {
        range: RANGES.some((item) => item.key === range) ? range : "today",
        rateFor: (id) => (rates.has(id) ? rates.get(id) : null)
      });
      report.ranges = RANGES.map(({ key, label, days }) => ({ key, label, days }));
      report.at = Date.now();
      // The account's own credits ride along as `quota`, so the page never
      // has to merge two payloads to draw one card.
      report.quota = await cachedUsage(instance).catch(() => null);
      // The free-model card and the model list share one report, and it is
      // bound to the account carrying the requests: switching accounts
      // switches which free models are exhausted.
      const routeAccount = await activeAccount(instance).catch(() => null);
      report.freeAllowance = await freeReportFor(instance, rows, null, routeAccount?.id);
      return report;
    },

    async stop() {
      disposed = true;
      // The scheduler may still be mounting its provider; wait for that to
      // settle, then stop what actually mounted. Stopping an already-stopped
      // control is a no-op on every line.
      await mounting?.catch(() => {});
      scheduler?.stop();
      scheduler = null;
      // The journal's writes are debounced; a shutdown that skips the flush
      // loses the tail of the day's requests. Awaited so the CLI and the
      // desktop can let it land before the process goes.
      await journal.flush?.();
    }
  };
}
