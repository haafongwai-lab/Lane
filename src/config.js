import os from "node:os";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3426;

export function dataDir(env = process.env) {
  if (env.LANE_DATA_DIR) return path.resolve(env.LANE_DATA_DIR);
  const base =
    env.LOCALAPPDATA ||
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local")
      : path.join(os.homedir(), ".local", "share"));
  return path.join(base, "lane");
}

export function codexHome(env = process.env) {
  return env.CODEX_HOME
    ? path.resolve(env.CODEX_HOME)
    : path.join(env.USERPROFILE || os.homedir(), ".codex");
}

export function parseAddress(value) {
  const raw = value || `${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const match = /^(.+):(\d+)$/.exec(raw);
  if (!match) throw new Error(`invalid address: ${raw}`);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${match[2]}`);
  }
  return { host: match[1], port };
}

export function gatewayBase(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  return `http://${host}:${port}`;
}
