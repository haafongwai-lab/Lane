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
import { installWindowsTask, uninstallWindowsTask } from "./windows-task.js";
import { checkinOverview, runCheckins, startCheckinScheduler, updateSettings } from "./checkin.js";
import fs from "node:fs/promises";
import path from "node:path";

export function createControlCenter({
  env = process.env,
  port = 3426,
  host = "127.0.0.1",
  onSignIn = () => {},
  checkins = false
} = {}) {
  const root = dataDir(env);
  const journal = new RequestJournal({ dir: root });
  const gateway = `http://${host}:${port}`;
  let provider;
  let signInPending = null;
  let signInError = "";
  let scheduler = null;

  const getProvider = async () => {
    if (!provider) {
      provider = await new WorkBuddyProvider({ env }).init();
    }
    return provider;
  };

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

  return {
    journal,

    async status() {
      const instance = await getProvider();
      const models = await instance.listModels();
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
          usage = await instance.usage();
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
          }
        },
        autostart,
        signInPending: Boolean(signInPending),
        signInError,
        recent: journal.list()
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
    async signIn() {
      if (signInPending) return { pending: true, url: signInPending.url };
      const instance = await getProvider();
      const result = await instance.authorize();
      signInPending = result;
      signInError = "";
      onSignIn(result);
      result.callback()
        .then(async (auth) => {
          if (auth?.type !== "success") throw new Error(auth?.error || "WorkBuddy sign-in failed");
          return instance.finishSignIn(result);
        })
        // The window refreshes its status on this second call; the account
        // itself is read from that status, so only clear the error here.
        .then(() => { onSignIn(null, null); })
        .catch((error) => {
          signInError = error?.message || "WorkBuddy sign-in failed";
          onSignIn(null, error);
        })
        .finally(() => { signInPending = null; });
      return { pending: true, url: result.url, instructions: result.instructions || "" };
    },

    async activate(id) {
      const instance = await getProvider();
      return instance.activate(id);
    },

    async setEnabled(id, enabled) {
      const instance = await getProvider();
      return instance.setEnabled(id, enabled);
    },

    async removeAccount(id) {
      const instance = await getProvider();
      return instance.forget(id);
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

    async connect(agent) {
      if (agent === "codex") {
        const instance = await getProvider();
        return connectCodex({
          env,
          gateway,
          providerModels: () => instance.listModels()
        });
      }
      if (agent === "claude-desktop") {
        return connectClaudeDesktop({ env, gateway });
      }
      throw new Error(`unknown agent: ${agent}`);
    },

    async disconnect(agent) {
      if (agent === "codex") return disconnectCodex({ env });
      if (agent === "claude-desktop") return disconnectClaudeDesktop({ env });
      throw new Error(`unknown agent: ${agent}`);
    },

    async autostart(enabled, options = {}) {
      if (enabled) await installWindowsTask({ env, port, ...options });
      else await uninstallWindowsTask({ env });
      return { enabled };
    },

    activity() {
      return journal.list();
    },

    stop() {
      scheduler?.stop();
    }
  };
}
