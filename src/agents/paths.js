import os from "node:os";
import path from "node:path";
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function claudeLocalAppData(env = process.env) {
  if (env.LANE_CLAUDE_LOCALAPPDATA) return path.resolve(env.LANE_CLAUDE_LOCALAPPDATA);
  return (
    env.LOCALAPPDATA ||
    (process.platform === "win32"
      ? windowsLocalAppData()
      : path.join(os.homedir(), ".local", "share"))
  );
}

function windowsLocalAppData() {
  try {
    const known = execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('LOCALAPPDATA','User')"],
      { encoding: "utf8", windowsHide: true, timeout: 3000 }
    ).trim();
    if (known) return known;
  } catch {}
  return path.join(os.homedir(), "AppData", "Local");
}

export function claudePaths(env = process.env) {
  const local = claudeLocalAppData(env);
  const paths = (base) => ({
    local: base,
    modeDir: path.join(base, "Claude"),
    threePDir: path.join(base, "Claude-3p"),
    modeConfig: path.join(base, "Claude", "claude_desktop_config.json"),
    threePConfig: path.join(base, "Claude-3p", "claude_desktop_config.json"),
    library: path.join(base, "Claude-3p", "configLibrary")
  });
  const real = paths(local);
  const packageRoot = path.join(local, "Packages");
  let packageDirs = [];
  try {
    packageDirs = readdirSync(packageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => /^Claude_/i.test(entry.name))
      .map((entry) => path.join(packageRoot, entry.name, "LocalCache", "Local"));
  } catch {}
  return { ...real, sets: [real, ...packageDirs.map(paths)] };
}

export function codexConfigPath(env = process.env) {
  if (env.LANE_CODEX_CONFIG) return path.resolve(env.LANE_CODEX_CONFIG);
  const home = env.CODEX_HOME
    ? path.resolve(env.CODEX_HOME)
    : path.join(env.USERPROFILE || windowsUserProfile(), ".codex");
  return path.join(home, "config.toml");
}

function windowsUserProfile() {
  try {
    const known = execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('USERPROFILE','User')"],
      { encoding: "utf8", windowsHide: true, timeout: 3000 }
    ).trim();
    if (known) return known;
  } catch {}
  return os.homedir();
}
