import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dataDir } from "./config.js";

const SHORTCUT_NAME = "Lane Gateway.lnk";
const DIRECT_SHORTCUT_NAME = "Lane.lnk";

// Resolved from this module rather than the working directory: a task
// installed from anywhere else would point at a cli.js that does not exist
// and fail quietly at every logon.
const defaultScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

export async function installWindowsTask({
  env = process.env,
  port: requestedPort = 3426,
  node = resolveNode(env),
  script = defaultScript,
  desktopExe = "",
  runTask = run
} = {}) {
  assertWindows();
  // The port is written into a generated PowerShell script, so it is
  // reduced to a plain integer here, at the sink — no caller's validation
  // is load-bearing.
  const port = Math.trunc(Number(requestedPort));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${requestedPort}`);
  }
  const root = dataDir(env);
  const startup = startupDir(env);
  const shortcut = path.join(startup, SHORTCUT_NAME);
  const runner = path.join(root, "lane-start.ps1");
  const installedShortcut = path.join(startup, DIRECT_SHORTCUT_NAME);
  const projectRoot = path.dirname(path.dirname(script));
  const desktopCandidates = desktopCandidatesFor(env, projectRoot, desktopExe);
  const installedDesktop = desktopCandidates.find((candidate) => existsSync(candidate));
  let desktopPath = desktopExe && !installedDesktop ? desktopExe : installedDesktop || desktopCandidates[0];
  if (/[\\/]dist[\\/]win-unpacked[\\/]Lane\.exe$/i.test(desktopPath)) {
    desktopPath = desktopExe || desktopPath;
  }
  const desktopStart = existsSync(desktopPath);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(startup, { recursive: true });
  // The runner's node branch exists only when a real node is known: under
  // Electron process.execPath is the app binary, and a runner that falls
  // back to it as "node" would launch Lane.exe with node's arguments and
  // die quietly at every logon.
  const runnerLines = [
    "$env:LANE_DATA_DIR = " + quotePowerShell(root),
    "$root = " + quotePowerShell(path.dirname(path.dirname(script))),
    "Set-Location -LiteralPath $root",
    "$desktop = " + quotePowerShell(desktopPath),
    "$log = " + quotePowerShell(path.join(root, "lane.log")),
    "$errorLog = " + quotePowerShell(path.join(root, "lane-error.log"))
  ];
  if (node) {
    runnerLines.push(
      "$arguments = " + quotePowerShell(`"${script}" serve --addr 127.0.0.1:${port}`),
      "$node = " + quotePowerShell(node)
    );
  }
  runnerLines.push(
    "if (Test-Path -LiteralPath $desktop) {",
    "  $process = Start-Process -FilePath $desktop -ArgumentList '--hidden' -WorkingDirectory (Split-Path -Parent $desktop) -WindowStyle Hidden -PassThru"
  );
  if (node) {
    runnerLines.push(
      "} elseif ($node) {",
      "  $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errorLog -PassThru"
    );
  }
  runnerLines.push(
    "} else {",
    "  exit 0",
    "}",
    "if ($process) { $process.Id | Set-Content -LiteralPath " + quotePowerShell(path.join(root, "lane.pid")) + " }",
    ""
  );
  await fs.writeFile(runner, runnerLines.join("\r\n"));
  // Exactly one startup entry: a desktop build launches directly, a node
  // checkout through the runner. Two shortcuts would start Lane twice per
  // logon and race for the single-instance lock, so the unused one is
  // removed — including one an older Lane left behind.
  if (desktopStart) {
    await fs.rm(shortcut, { force: true }).catch(() => {});
    await runTask(
      "powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" +
          quotePowerShell(installedShortcut) + ");" +
          "$s.TargetPath=" + quotePowerShell(desktopPath) + ";" +
          "$s.Arguments='--hidden';" +
          "$s.WorkingDirectory=" + quotePowerShell(path.dirname(desktopPath)) + ";" +
          "$s.WindowStyle=7;$s.Save()"
      ]
    );
  } else {
    await fs.rm(installedShortcut, { force: true }).catch(() => {});
    await runTask(
      "powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" +
          quotePowerShell(shortcut) + ");" +
          "$s.TargetPath=" + quotePowerShell(
            path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
          ) + ";" +
          "$s.Arguments=" + quotePowerShell(
            `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${runner}"`
          ) + ";" +
          "$s.WorkingDirectory=" + quotePowerShell(root) + ";" +
          "$s.WindowStyle=7;$s.Save()"
      ]
    );
  }
  return { installed: true, shortcut: desktopStart ? installedShortcut : shortcut, runner, port };
}

function desktopCandidatesFor(env, projectRoot, desktopExe) {
  return [
    desktopExe,
    path.join(projectRoot, "dist", "win-unpacked", "Lane.exe"),
    path.join(path.dirname(process.execPath), "Lane.exe"),
    "C:\\Program Files\\Lane\\Lane.exe",
    path.join(env.LOCALAPPDATA || "", "Programs", "Lane", "Lane.exe")
  ].filter(Boolean);
}

function resolveNode(env) {
  const candidates = [
    "C:\\Program Files\\nodejs\\node.exe",
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "nodejs", "node.exe") : "",
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "bin", "node.exe")
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  // Under Electron process.execPath is the app binary, not node; handing it
  // to the runner as node produces an autostart that can only fail.
  return process.versions?.electron ? "" : process.execPath;
}

export async function uninstallWindowsTask({ env = process.env } = {}) {
  assertWindows();
  await fs.rm(path.join(startupDir(env), SHORTCUT_NAME), { force: true });
  await fs.rm(path.join(startupDir(env), DIRECT_SHORTCUT_NAME), { force: true });
  return { installed: false };
}

function assertWindows() {
  if (process.platform !== "win32") {
    throw new Error("autostart is available on Windows only");
  }
}

function run(command, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // A PowerShell that never comes back (a wedged COM call, say) must not
    // hang the install with it.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
    });
  });
}

function startupDir(env) {
  return path.join(
    env.APPDATA || path.join(env.USERPROFILE || process.env.USERPROFILE || "", "AppData", "Roaming"),
    "Microsoft", "Windows", "Start Menu", "Programs", "Startup"
  );
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

