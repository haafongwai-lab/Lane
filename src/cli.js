import { createServer } from "./server.js";
import { DEFAULT_HOST, DEFAULT_PORT, parseAddress } from "./config.js";
import { FallbackProvider } from "./provider.js";
import { connectClaudeDesktop, disconnectClaudeDesktop } from "./agents/claude-desktop.js";
import { connectCodex, disconnectCodex } from "./agents/codex.js";
import { WorkBuddyProvider } from "./workbuddy.js";
import { writeAuth } from "./auth-store.js";
import { codexConfigPath } from "./agents/paths.js";
import { claudePaths } from "./agents/paths.js";

function usage() {
  console.log(`Usage:
  lane serve [--addr 127.0.0.1:3426]
  lane doctor
  lane connect claude-desktop
  lane disconnect claude-desktop
  lane connect codex
  lane disconnect codex
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
  console.log("provider: workbuddy (fallback until the plugin is wired)");
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
  await writeAuth(null);
  console.log(JSON.stringify({ ok: true, signedOut: true }, null, 2));
}

async function main() {
  const [command, target] = process.argv.slice(2);
  if (command === "serve") return serve(process.argv.slice(3));
  if (command === "doctor") return doctor();
  if (command === "connect" && target === "claude-desktop") return connectClaudeDesktop();
  if (command === "disconnect" && target === "claude-desktop") return disconnectClaudeDesktop();
  if (command === "connect" && target === "codex") {
    const provider = await new WorkBuddyProvider().init();
    return connectCodex({ providerModels: () => provider.listModels() });
  }
  if (command === "disconnect" && target === "codex") return disconnectCodex();
  if (command === "login") return login();
  if (command === "logout") return logout();
  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
