import { dataDir, gatewayBase } from "./config.js";
import { clearAuth, readAuth } from "./auth-store.js";
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
import fs from "node:fs/promises";
import path from "node:path";

export function createControlCenter({
  env = process.env,
  port = 3426,
  host = "127.0.0.1",
  onSignIn = () => {}
} = {}) {
  const root = dataDir(env);
  const journal = new RequestJournal({ dir: root });
  const gateway = `http://${host}:${port}`;
  let provider;
  let signInPending = null;
  let signInError = "";

  const getProvider = async () => {
    if (!provider) {
      provider = await new WorkBuddyProvider({ env }).init();
    }
    return provider;
  };

  return {
    journal,

    async status() {
      const instance = await getProvider();
      const auth = await readAuth(env);
      const models = await instance.listModels();
      const state = await readState(env);
      await syncCodexCatalog({ env, models }).catch(() => {});
      let signedIn = false;
      try {
        signedIn = await instance.signedIn();
      } catch {}
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
        account: auth?.accountId || auth?.uid || "",
        domain: auth?.domain || "",
        expiresAt: auth?.expires || null,
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
        .then(() => { onSignIn(null, null); })
        .catch((error) => {
          signInError = error?.message || "WorkBuddy sign-in failed";
          onSignIn(null, error);
        })
        .finally(() => { signInPending = null; });
      return { pending: true, url: result.url, instructions: result.instructions || "" };
    },

    async signOut() {
      await clearAuth(env);
      if (provider) provider.auth = null;
      if (provider) provider.loader = null;
      return { ok: true };
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
    }
  };
}

export function gatewayURL(host = "127.0.0.1", port = 3426) {
  return gatewayBase(host, port);
}
