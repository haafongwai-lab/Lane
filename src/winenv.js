import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * The Windows profile folders, resolved once per process.
 *
 * Two things were wrong with the way config.js and paths.js each answered
 * this. They carried the same PowerShell lookup twice, and that lookup
 * blocks the event loop for up to three seconds — on the gateway's main
 * thread, where every in-flight stream is waiting. It also ran on paths that
 * are asked for on every status poll, so a machine whose LOCALAPPDATA was
 * missing from the environment would stall the gateway repeatedly rather
 * than once.
 *
 * The standard layout answers it without a subprocess: os.homedir() already
 * follows a redirected profile because it reads USERPROFILE, so
 * `<home>\AppData\Local` is right wherever the profile actually lives. The
 * subprocess stays as a last resort for the case where that folder is not
 * there at all, and its answer is cached like any other.
 */

let cachedLocalAppData = "";

function askWindows(variable) {
  try {
    const known = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Environment]::GetEnvironmentVariable('${variable}','User')`
      ],
      { encoding: "utf8", windowsHide: true, timeout: 3000 }
    ).trim();
    return known || "";
  } catch {
    return "";
  }
}

/**
 * The per-user local application data folder: %LOCALAPPDATA%.
 *
 * A caller-supplied `env` wins, then the process environment, then the
 * standard location under the home folder — which covers every normal
 * Windows install without touching a subprocess.
 */
export function localAppData(env = process.env) {
  if (env.LOCALAPPDATA) return path.resolve(env.LOCALAPPDATA);
  if (process.platform !== "win32") {
    return path.join(os.homedir(), ".local", "share");
  }
  if (cachedLocalAppData) return cachedLocalAppData;
  const derived = path.join(os.homedir(), "AppData", "Local");
  // A profile on a redirected or unusual volume is the one case the standard
  // layout does not describe, and the only one worth spawning for.
  if (existsSync(derived)) {
    cachedLocalAppData = derived;
    return derived;
  }
  cachedLocalAppData = askWindows("LOCALAPPDATA") || derived;
  return cachedLocalAppData;
}

let cachedUserProfile = "";

/**
 * The user's home folder: %USERPROFILE%. os.homedir() reads exactly that,
 * so the subprocess is only reached when even the home folder cannot be
 * determined.
 */
export function userProfile(env = process.env) {
  if (env.USERPROFILE) return path.resolve(env.USERPROFILE);
  if (cachedUserProfile) return cachedUserProfile;
  cachedUserProfile = os.homedir() || askWindows("USERPROFILE");
  return cachedUserProfile;
}

/** Test seam: forget what was resolved, so a changed environment is re-read. */
export function forgetResolvedFolders() {
  cachedLocalAppData = "";
  cachedUserProfile = "";
}
