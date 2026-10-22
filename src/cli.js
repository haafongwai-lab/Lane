import { createServer } from "./server.js";
import { DEFAULT_HOST, DEFAULT_PORT, parseAddress } from "./config.js";
import { connectClaudeDesktop, disconnectClaudeDesktop } from "./agents/claude-desktop.js";
import { connectCodex, disconnectCodex } from "./agents/codex.js";
import { WorkBuddyProvider } from "./workbuddy.js";
import { connectZcode, disconnectZcode } from "./agents/zcode.js";
import { codexConfigPath } from "./agents/paths.js";
import { claudePaths } from "./agents/paths.js";
import { installWindowsTask, uninstallWindowsTask } from "./windows-task.js";
import { createControlCenter } from "./control-center.js";
import { checkinOverview, readCheckin, runCheckins, updateSettings } from "./checkin.js";

function usage() {
  console.log(`Usage:
  lane serve [--addr 127.0.0.1:3426]
  lane doctor
  lane connect claude-desktop [--addr 127.0.0.1:3426]
  lane disconnect claude-desktop
  lane connect codex [--addr 127.0.0.1:3426]
  lane disconnect codex
  lane connect zcode [--addr 127.0.0.1:3426]
  lane disconnect zcode
  lane autostart install [--addr 127.0.0.1:3426]
  lane autostart uninstall
  lane login [--site workbuddy|workbuddy-ai]
  lane logout
  lane accounts
  lane use <account>
  lane enable <account> | lane disable <account>
  lane forget <account>
  lane checkin [--all]
  lane checkin on | off
  lane checkin at <HH:MM>`);
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : "";
}

async function serve(args) {
  const { host, port } = parseAddress(argValue(args, "--addr") || `${DEFAULT_HOST}:${DEFAULT_PORT}`);
  const provider = new WorkBuddyProvider();
  await provider.init();
  const control = createControlCenter({ port, host, checkins: true });
  const server = createServer({ provider, control });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`lane listening on http://${host}:${port}`);
  console.log("provider: workbuddy");
  const stop = () => {
    control.stop();
    server.close(() => process.exit(0));
  };
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
    activeId: await provider.activeId(),
    accounts: await provider.accounts(),
    checkin: await checkinOverview(provider),
    claudeDesktop: {
      modeConfig: claude.modeConfig,
      profileConfig: claude.library
    },
    codex: {
      config: codexConfigPath()
    }
  }, null, 2));
}

async function login(options = {}) {
  const site = options.site === "workbuddy-ai" ? "workbuddy-ai" : "workbuddy";
  const provider = new WorkBuddyProvider();
  await provider.init();
  const result = await provider.authorize(site);
  console.log(`Open this URL and sign in:\n${result.url}\n`);
  console.log(result.instructions || "Waiting for sign-in...");
  const auth = await provider.finishSignIn(result, site);
  console.log(JSON.stringify({
    ok: true,
    account: auth.accountId,
    uid: auth.uid,
    id: auth.id,
    activeId: await provider.activeId()
  }, null, 2));
}

async function logout() {
  const provider = await new WorkBuddyProvider().init();
  const id = await provider.activeId();
  if (!id) {
    console.log(JSON.stringify({ ok: true, signedOut: false, reason: "no account" }, null, 2));
    return;
  }
  await provider.forget(id);
  console.log(JSON.stringify({
    ok: true,
    signedOut: true,
    removed: id,
    activeId: await provider.activeId()
  }, null, 2));
}

async function accounts() {
  const provider = await new WorkBuddyProvider().init();
  const list = await provider.accounts();
  const activeId = await provider.activeId();
  const checkin = await checkinOverview(provider);
  console.log(JSON.stringify({
    activeId,
    accounts: list.map((account) => ({
      ...account,
      active: account.id === activeId,
      checkin: checkin.accounts.find((item) => item.id === account.id) || null
    }))
  }, null, 2));
}

async function use(id) {
  if (!id) throw new Error("lane use <account>");
  const provider = await new WorkBuddyProvider().init();
  const account = await provider.activate(matchAccount(await provider.accounts(), id));
  console.log(JSON.stringify({ ok: true, activeId: account.id, label: account.label }, null, 2));
}

async function toggle(id, enabled) {
  if (!id) throw new Error(`lane ${enabled ? "enable" : "disable"} <account>`);
  const provider = await new WorkBuddyProvider().init();
  const account = await provider.setEnabled(matchAccount(await provider.accounts(), id), enabled);
  console.log(JSON.stringify({
    ok: true,
    account: account.id,
    label: account.label,
    enabled: account.enabled,
    activeId: await provider.activeId()
  }, null, 2));
}

async function forget(id) {
  if (!id) throw new Error("lane forget <account>");
  const provider = await new WorkBuddyProvider().init();
  const result = await provider.forget(matchAccount(await provider.accounts(), id));
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

// An account can be named by its full id, its label, or a unique prefix.
function matchAccount(list, needle) {
  const wanted = String(needle).toLowerCase();
  const exact = list.find((account) => account.id.toLowerCase() === wanted);
  if (exact) return exact.id;
  const byLabel = list.filter((account) => account.label.toLowerCase() === wanted);
  if (byLabel.length === 1) return byLabel[0].id;
  const prefix = list.filter((account) => account.id.toLowerCase().startsWith(wanted));
  if (prefix.length === 1) return prefix[0].id;
  throw new Error(
    prefix.length > 1
      ? `account "${needle}" is ambiguous: ${prefix.map((item) => item.id).join(", ")}`
      : `unknown account: ${needle}`
  );
}

async function checkin(args) {
  const provider = await new WorkBuddyProvider().init();
  const [action, value] = args;
  if (action === "on" || action === "off") {
    console.log(JSON.stringify(await updateSettings({ enabled: action === "on" }), null, 2));
    return;
  }
  if (action === "at") {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value || "");
    if (!match) throw new Error("lane checkin at <HH:MM>");
    console.log(JSON.stringify(await updateSettings({
      hour: Number(match[1]),
      minute: Number(match[2])
    }), null, 2));
    return;
  }
  const run = await runCheckins({ provider, force: true });
  console.log(JSON.stringify({
    settings: (await readCheckin()).settings,
    results: run.results
  }, null, 2));
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
  if (command === "connect" && target === "zcode") {
    const provider = await new WorkBuddyProvider().init();
    const result = await connectZcode({
      gateway: `http://${gateway.host}:${gateway.port}`,
      providerModels: () => provider.listModels()
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === "disconnect" && target === "zcode") return disconnectZcode();
  if (command === "autostart" && target === "install") {
    return installWindowsTask({ port: gateway.port });
  }
  if (command === "autostart" && target === "uninstall") {
    return uninstallWindowsTask();
  }
  if (command === "login") return login({ site: argValue(args, "--site") });
  if (command === "logout") return logout();
  if (command === "accounts") return accounts();
  if (command === "use") return use(target);
  if (command === "enable") return toggle(target, true);
  if (command === "disable") return toggle(target, false);
  if (command === "forget") return forget(target);
  if (command === "checkin") return checkin(args.slice(1));
  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
