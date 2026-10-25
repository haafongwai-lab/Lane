import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";

/**
 * The registry of MCP servers the user manages once and Lane deploys into
 * every client that can take it. One JSON file in the data directory:
 *
 *   [{ name, transport, command, args, env, url, headers, agents, off }]
 *
 * transport is "stdio" (a local command) or "http" (a streamable-HTTP URL).
 * agents names the clients the entry is deployed to; off marks an entry the
 * user paused without deleting.
 */

const file = (env) => path.join(dataDir(env), "mcp.json");

export const TRANSPORTS = ["stdio", "http"];
export const AGENTS = ["claude-desktop", "codex", "zcode"];

export function normalizeServer(raw = {}) {
  const name = String(raw.name || "").trim();
  if (!name || !/^[\w][\w.-]*$/.test(name)) return { error: "名称需为字母、数字、点、连字符或下划线" };
  const transport = raw.transport === "http" ? "http" : "stdio";
  const out = { name, transport, agents: [], off: Boolean(raw.off) };

  if (transport === "stdio") {
    const command = String(raw.command || "").trim();
    if (!command) return { error: "stdio 服务需要一个启动命令" };
    out.command = command;
    if (Array.isArray(raw.args)) out.args = raw.args.map(String).filter(Boolean);
    if (raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)) {
      const env = {};
      for (const [k, v] of Object.entries(raw.env)) {
        if (String(k).trim() && v != null) env[String(k).trim()] = String(v);
      }
      if (Object.keys(env).length) out.env = env;
    }
  } else {
    const url = String(raw.url || "").trim();
    if (!/^https?:\/\//.test(url)) return { error: "http 服务需要一个 http(s) 地址" };
    out.url = url;
    if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
      const headers = {};
      for (const [k, v] of Object.entries(raw.headers)) {
        if (String(k).trim() && v != null) headers[String(k).trim()] = String(v);
      }
      if (Object.keys(headers).length) out.headers = headers;
    }
  }

  const agents = Array.isArray(raw.agents) ? raw.agents.filter((a) => AGENTS.includes(a)) : [];
  out.agents = [...new Set(agents)];
  return { server: out };
}

export async function readServers(env = process.env) {
  try {
    const rows = JSON.parse(await fs.readFile(file(env), "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return [];
  }
}

async function writeServers(rows, env) {
  const target = file(env);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, target);
}

export async function upsertServer(raw, env = process.env) {
  const { server, error } = normalizeServer(raw);
  if (error) throw Object.assign(new Error(error), { status: 400 });
  const rows = await readServers(env);
  const at = rows.findIndex((row) => row.name === server.name);
  if (at >= 0) rows[at] = { ...rows[at], ...server };
  else rows.push(server);
  await writeServers(rows, env);
  return server;
}

export async function removeServer(name, env = process.env) {
  const rows = await readServers(env);
  const next = rows.filter((row) => row.name !== name);
  await writeServers(next, env);
  return rows.length - next.length;
}

export async function setServerEnabled(name, off, env = process.env) {
  const rows = await readServers(env);
  const row = rows.find((entry) => entry.name === name);
  if (!row) throw Object.assign(new Error("没有这个 MCP 服务"), { status: 404 });
  row.off = Boolean(off);
  await writeServers(rows, env);
  return row;
}

export async function setServerAgents(name, agents, env = process.env) {
  const rows = await readServers(env);
  const row = rows.find((entry) => entry.name === name);
  if (!row) throw Object.assign(new Error("没有这个 MCP 服务"), { status: 404 });
  const list = (Array.isArray(agents) ? agents : []).filter((a) => AGENTS.includes(a));
  row.agents = [...new Set(list)];
  await writeServers(rows, env);
  return row;
}
