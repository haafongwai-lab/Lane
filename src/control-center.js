import { dataDir } from "./config.js";
import { WorkBuddyProvider } from "./workbuddy.js";
import { readState } from "./agents/store.js";
import { codexConfigPath, claudePaths } from "./agents/paths.js";
import { RequestJournal } from "./request-journal.js";
import { connectCodex, disconnectCodex, syncCodexCatalog } from "./agents/codex.js";
import {
  connectClaudeDesktop,
  disconnectClaudeDesktop
} from "./agents/claude-desktop.js";
import { connectZcode, disconnectZcode, syncZcodeCatalog, zcodePaths } from "./agents/zcode.js";
import { installWindowsTask, uninstallWindowsTask, startupDir } from "./windows-task.js";
import { checkinOverview, runCheckins, startCheckinScheduler, updateSettings } from "./checkin.js";
import { summary as usageSummary, RANGES, billedRates } from "./usage.js";
import * as mcpServers from "./mcp-servers.js";
import * as mcpDeploy from "./mcp-deploy.js";
import * as skills from "./skills.js";
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
  const root = dataDir(env);
  const journal = new RequestJournal({ dir: root, shared });
  const gateway = `http://${host}:${port}`;
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
    providerLoading ??= new WorkBuddyProvider({ env }).init()
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
      value = await instance.usage();
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
  // A finished request has just spent credits upstream, so the cached figure
  // is stale the moment it lands; dropping it here makes the next status
  // poll read the balance as it is now, not up to a minute late.
  const invalidateUsage = () => usageCache.clear();
  // Switching, switching off or removing the route invalidates every entry:
  // the figure that matters is always the current account's.
  const forgetUsage = () => usageCache.clear();

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
    throw new Error(`unknown agent: ${agent}`);
  };

  const applyDisconnect = async (agent) => {
    if (agent === "codex") return disconnectCodex({ env });
    if (agent === "claude-desktop") return disconnectClaudeDesktop({ env });
    if (agent === "zcode") return disconnectZcode({ env });
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
      const models = await instance.listModels().catch(() => null);
      // A truncated wiring.json is one agent-wiring file gone wrong; the
      // accounts, activity and models it must not take down with it.
      let state = {};
      try {
        state = await readState(env);
      } catch {}
      // Both clients keep the catalogue in a file of their own, so both are
      // refreshed from the account the gateway is actually routing to: a
      // switch between sites changes the list behind an unchanged URL.
      if (models?.length) {
        await syncCodexCatalog({ env, models }).catch(() => {});
        await syncZcodeCatalog({ env, models }).catch(() => {});
      }
      let signedIn = false;
      try {
        signedIn = await instance.signedIn();
      } catch {}
      const account = await activeAccount(instance);
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
        accounts: await instance.accounts(),
        activeId: await instance.activeId(),
        checkin: await checkinOverview(instance, env).catch(() => null),
        usage,
        models,
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
          }
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
      const site = options.site === "workbuddy-ai" ? "workbuddy-ai" : "workbuddy";
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
          if (auth?.type !== "success") throw new Error(auth?.error || "WorkBuddy sign-in failed");
          // The outcome is handed over rather than waited for again inside
          // finishSignIn: the plugin's callback polls a token endpoint that
          // a second call with the same state need not answer.
          return instance.finishSignIn(result, site, auth);
        })
        // The window refreshes its status on this second call; the account
        // itself is read from that status, so only clear the error here.
        .then(() => { onSignIn(null, null); })
        .catch((error) => {
          signInError = error?.message || "WorkBuddy sign-in failed";
          // Both the window and the log get it: a sign-in that never lands
          // is otherwise a toast nobody can read afterwards.
          console.error(`WorkBuddy sign-in (${site}) failed: ${signInError}`);
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
      // The catalogue belongs to the account now in force, and ZCode keeps
      // its copy in its own file: refresh it at the switch, not whenever the
      // window next polls. A failure here must not fail the switch itself.
      await instance.listModels().then(
        (models) => models?.length
          ? Promise.all([
            syncCodexCatalog({ env, models }),
            syncZcodeCatalog({ env, models })
          ]).catch(() => {})
          : null
      ).catch(() => {});
      return account;
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
      invalidateUsage();
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
      if (enabled) await installWindowsTask({ env, port, ...options });
      else await uninstallWindowsTask({ env });
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

    clearProject(projectId) {
      if (journal.shared) throw new Error("只读窗口不能清除历史记录");
      return journal.removeByProject(projectId);
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
      return skills.listLibrary(env);
    },

    async skillsImport(sourceDir) {
      if (journal.shared) throw new Error("只读窗口不能管理技能");
      return skills.importFrom(sourceDir, env);
    },

    async skillsRemove(name) {
      if (journal.shared) throw new Error("只读窗口不能管理技能");
      return skills.removeFromLibrary(name, env);
    },

    async skillsInstall(name, agent) {
      if (journal.shared) throw new Error("只读窗口不能管理技能");
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
