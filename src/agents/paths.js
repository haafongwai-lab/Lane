import path from "node:path";
import { readdirSync } from "node:fs";
import { localAppData, userProfile } from "../winenv.js";

function claudeLocalAppData(env = process.env) {
  if (env.LANE_CLAUDE_LOCALAPPDATA) return path.resolve(env.LANE_CLAUDE_LOCALAPPDATA);
  return localAppData(env);
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
    : path.join(userProfile(env), ".codex");
  return path.join(home, "config.toml");
}
