import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3426;

export function dataDir(env = process.env) {
  if (env.LANE_DATA_DIR) return path.resolve(env.LANE_DATA_DIR);
  const base =
    env.LOCALAPPDATA ||
    (process.platform === "win32"
      ? windowsLocalAppData()
      : path.join(os.homedir(), ".local", "share"));
  return path.join(base, "lane");
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

export function parseAddress(value) {
  const raw = value || `${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const match = /^(.+):(\d+)$/.exec(raw);
  if (!match) throw new Error(`invalid address: ${raw}`);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${match[2]}`);
  }
    // "[::1]:3426" is how a URL writes an IPv6 literal; listen() wants the bare literal.
  const host = match[1].replace(/^\[(.+)\]$/, "$1");
  return { host, port };
}

export function gatewayBase(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  return `http://${host}:${port}`;
}
