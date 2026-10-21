import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { dataDir } from "./config.js";

const SHORTCUT_NAME = "Lane Gateway.lnk";

export async function installWindowsTask({
  env = process.env,
  port = 3426,
  node = resolveNode(env),
  script = path.resolve("src/cli.js"),
  desktopExe = "",
  runTask = run
} = {}) {
  assertWindows();
  const root = dataDir(env);
  const startup = startupDir(env);
  const shortcut = path.join(startup, SHORTCUT_NAME);
  const runner = path.join(root, "lane-start.ps1");
  const installedShortcut = path.join(startup, "Lane.lnk");
  const projectRoot = path.dirname(path.dirname(script));
  const desktopCandidates = desktopCandidatesFor(env, projectRoot, desktopExe);
  const installedDesktop = desktopCandidates.find((candidate) => existsSync(candidate));
  let desktopPath = desktopExe && !installedDesktop ? desktopExe : installedDesktop || desktopCandidates[0];
  if (/[\\/]dist[\\/]win-unpacked[\\/]Lane\.exe$/i.test(desktopPath)) {
    desktopPath = desktopExe || desktopPath;
  }
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(startup, { recursive: true });
  await fs.writeFile(
    runner,
    [
      "$env:LANE_DATA_DIR = " + quotePowerShell(root),
      "$root = " + quotePowerShell(path.dirname(path.dirname(script))),
      "Set-Location -LiteralPath $root",
      "$arguments = " + quotePowerShell(`"${script}" serve --addr 127.0.0.1:${port}`),
      "$desktop = " + quotePowerShell(desktopPath),
      "$node = " + quotePowerShell(node),
      "$log = " + quotePowerShell(path.join(root, "lane.log")),
      "$errorLog = " + quotePowerShell(path.join(root, "lane-error.log")),
      "if (Test-Path -LiteralPath $desktop) {",
      "  $process = Start-Process -FilePath $desktop -ArgumentList '--hidden' -WorkingDirectory (Split-Path -Parent $desktop) -WindowStyle Hidden -PassThru",
      "} else {",
      "  $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errorLog -PassThru",
      "}",
      "$process.Id | Set-Content -LiteralPath " + quotePowerShell(path.join(root, "lane.pid")),
      ""
    ].join("\r\n")
  );
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
  if (desktopExe && existsSync(desktopExe)) {
    await runTask(
      "powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" +
          quotePowerShell(installedShortcut) + ");" +
          "$s.TargetPath=" + quotePowerShell(desktopExe) + ";" +
          "$s.Arguments='--hidden';" +
          "$s.WorkingDirectory=" + quotePowerShell(path.dirname(desktopExe)) + ";" +
          "$s.WindowStyle=7;$s.Save()"
      ]
    );
  }
  return { installed: true, shortcut, runner, port };
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
  return candidates.find((candidate) => existsSync(candidate)) || process.execPath;
}

export async function uninstallWindowsTask({ env = process.env } = {}) {
  assertWindows();
  await fs.rm(path.join(startupDir(env), SHORTCUT_NAME), { force: true });
  await fs.rm(path.join(startupDir(env), "Lane.lnk"), { force: true });
  return { installed: false };
}

function assertWindows() {
  if (process.platform !== "win32") {
    throw new Error("autostart is available on Windows only");
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
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

