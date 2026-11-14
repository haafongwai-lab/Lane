import path from "node:path";
import { localAppData } from "./winenv.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3426;

/**
 * Lane is a loopback-only gateway. The control API additionally requires a
 * local token (see control-token.js) because a loopback bind alone does not
 * separate Windows user sessions; binding it to a LAN interface would expose
 * account and MCP operations to the network all the same. Keep the check
 * here so every caller of the address parser gets the same answer.
 */
export function isLoopbackHost(value) {
  const host = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^::ffff:127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (!/^127(?:\.\d{1,3}){3}$/.test(host)) return false;
  return host.split(".").slice(1).every((part) => Number(part) <= 255);
}

export function assertLoopbackHost(host, label = "address") {
  if (!isLoopbackHost(host)) {
    throw new Error(`Lane only binds loopback (${label}); use 127.0.0.1 or ::1`);
  }
  return host;
}

export function dataDir(env = process.env) {
  if (env.LANE_DATA_DIR) return path.resolve(env.LANE_DATA_DIR);
  return path.join(localAppData(env), "lane");
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
  const value = String(host);
  const bracketed = value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
  return `http://${bracketed}:${port}`;
}
