import { createServer } from "./server.js";
import { DEFAULT_HOST, DEFAULT_PORT, parseAddress } from "./config.js";
import { connectClaudeDesktop, disconnectClaudeDesktop } from "./agents/claude-desktop.js";
import { connectCodex, disconnectCodex } from "./agents/codex.js";
import { WorkBuddyProvider } from "./workbuddy.js";
import { clearAuth } from "./auth-store.js";
import { codexConfigPath } from "./agents/paths.js";
import { claudePaths } from "./agents/paths.js";
import { installWindowsTask, uninstallWindowsTask } from "./windows-task.js";

function usage() {
  console.log(`Usage:
  lane serve [--addr 127.0.0.1:3426]
  lane doctor
  lane connect claude-desktop [--addr 127.0.0.1:3426]
  lane disconnect claude-desktop
  lane connect codex [--addr 127.0.0.1:3426]
  lane disconnect codex
  lane autostart install [--addr 127.0.0.1:3426]
  lane autostart uninstall
  lane login
  lane logout`);
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : "";
}

async function serve(args) {
  const { host, port } = parseAddress(argValue(args, "--addr") || `${DEFAULT_HOST}:${DEFAULT_PORT}`);
  const provider = new WorkBuddyProvider();
  await provider.init();
  const server = createServer({ provider });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`lane listening on http://${host}:${port}`);
  console.log("provider: workbuddy");
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function doctor() {
  const provider = await new WorkBuddyProvider().init();
  const claude = claudePaths();
  console.log(JSON.stringify({
    ok: true,
    platform: process.platform,
    node: process.version,
    defaultAddress: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    signedIn: await provider.signedIn(),
    claudeDesktop: {
      modeConfig: claude.modeConfig,
      profileConfig: claude.library
    },
    codex: {
      config: codexConfigPath()
    }
  }, null, 2));
}

async function login() {
  const provider = new WorkBuddyProvider();
  const result = await provider.authorize();
  console.log(`Open this URL and sign in:\n${result.url}\n`);
  console.log(result.instructions || "Waiting for sign-in...");
  const auth = await provider.finishSignIn(result);
  console.log(JSON.stringify({ ok: true, account: auth.accountId, uid: auth.uid }, null, 2));
}

async function logout() {
  await clearAuth();
  console.log(JSON.stringify({ ok: true, signedOut: true }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const [command, target] = args;
  const address = argValue(args, "--addr") || `${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const gateway = parseAddress(address);
  if (command === "serve") return serve(args.slice(1));
  if (command === "doctor") return doctor();
  if (command === "connect" && target === "claude-desktop") {
    return connectClaudeDesktop({ gateway: `http://${gateway.host}:${gateway.port}` });
  }
  if (command === "disconnect" && target === "claude-desktop") return disconnectClaudeDesktop();
  if (command === "connect" && target === "codex") {
    const provider = await new WorkBuddyProvider().init();
    const result = await connectCodex({
      gateway: `http://${gateway.host}:${gateway.port}`,
      providerModels: () => provider.listModels()
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === "disconnect" && target === "codex") return disconnectCodex();
  if (command === "autostart" && target === "install") {
    return installWindowsTask({ port: gateway.port });
  }
  if (command === "autostart" && target === "uninstall") {
    return uninstallWindowsTask();
  }
  if (command === "login") return login();
  if (command === "logout") return logout();
  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
