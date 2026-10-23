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
import { connectZcode, disconnectZcode, zcodePaths } from "./agents/zcode.js";
import { installWindowsTask, uninstallWindowsTask } from "./windows-task.js";
import { checkinOverview, runCheckins, startCheckinScheduler, updateSettings } from "./checkin.js";
import { summary as usageSummary, RANGES } from "./usage.js";
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

  const getProvider = async () => {
    if (!provider) {
      provider = await new WorkBuddyProvider({ env }).init();
    }
    return provider;
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
    getProvider()
      .then((instance) => {
        scheduler = startCheckinScheduler({ provider: instance, env });
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
      // must not take those down with it.
      const models = await instance.listModels().catch(() => []);
      const state = await readState(env);
      await syncCodexCatalog({ env, models }).catch(() => {});
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
        const startup = path.join(
          env.APPDATA || process.env.APPDATA || "",
          "Microsoft", "Windows", "Start Menu", "Programs", "Startup"
        );
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
        checkin: await checkinOverview(instance, env),
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
        recent: journal.recent()
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

    /**
     * Token and credit totals for the usage view. The cost per request comes
     * from the model's credit multiple; the account's own credits, as
     * WorkBuddy reports them, are a separate figure and are not mixed in.
     */
    async usage(range = "today") {
      const instance = await getProvider();
      // The catalogue is needed to cost rows written before the journal kept
      // a multiple; the provider caches what its last listModels settled on,
      // so this does not ask WorkBuddy again.
      const models = instance.cachedModels();
      const rates = new Map((models || []).map((model) => [model.id, model.rate]));
      const report = usageSummary(journal.list(), {
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
      scheduler?.stop();
      // The journal's writes are debounced; a shutdown that skips the flush
      // loses the tail of the day's requests. Awaited so the CLI and the
      // desktop can let it land before the process goes.
      await journal.flush?.();
    }
  };
}
