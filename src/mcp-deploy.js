import fs from "node:fs/promises";
import path from "node:path";
import { codexConfigPath } from "./agents/paths.js";
import { claudePaths } from "./agents/paths.js";
import { zcodePaths } from "./agents/zcode.js";
import { readState, writeState, writeTextAtomic } from "./agents/store.js";

/**
 * Deploying the registry into each client's own MCP configuration.
 *
 * Three clients, three shapes:
 *   Claude Desktop  claude_desktop_config.json (both the regular and the
 *                     Claude-3p installation) → mcpServers.<name>:
 *                     { command, args, env } — stdio only; the desktop
 *                     build has no remote-MCP entry to write, so an http
 *                     server is reported as unsupported there.
 *   Codex           config.toml → [mcp_servers.<name>] tables with an env
 *                     sub-table — stdio only, the shape `codex mcp add`
 *                     writes.
 *   ZCode           v2 config.json → mcp.<name>: { type: "local",
 *                     command: [..], environment } or { type: "remote",
 *                     url, headers } — both transports, OpenCode's schema.
 *
 * The deploy state lives in wiring.json next to the agents' wiring: per
 * client, the names Lane wrote last time, so a later deploy only touches
 * Lane's own entries and a disconnect removes exactly those.
 */

async function ensureDir(p) {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

async function readMaybe(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readConfig(p) {
  const text = await readMaybe(p);
  if (text == null) return { doc: {}, existed: false };
  try {
    return { doc: JSON.parse(text), existed: true };
  } catch {
    return { doc: null, existed: true };
  }
}

function sanitizeName(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- Codex: [mcp_servers."<name>"] tables in config.toml -------------------

function codexEntryText(server) {
  const lines = [`[mcp_servers."${server.name}"]`, `command = ${JSON.stringify(server.command)}`];
  if (server.args?.length) lines.push(`args = [${server.args.map((a) => JSON.stringify(a)).join(", ")}]`);
  if (server.env && Object.keys(server.env).length) {
    lines.push("");
    lines.push(`[mcp_servers."${server.name}".env]`);
    for (const [k, v] of Object.entries(server.env)) lines.push(`${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  }
  return lines.join("\n");
}

function stripCodexEntry(text, name) {
  const safe = sanitizeName(name);
  const own = new RegExp(`^\\s*\\[mcp_servers\\.(?"?${safe}"?)\\]$`.replace("(?", "(?:"));
  const sub = new RegExp(`^\\s*\\[mcp_servers\\.(?:\"?${safe}\"?)\\.`);
  const out = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (!skipping && own.test(line)) { skipping = true; continue; }
    if (skipping) {
      // A header that is neither the entry nor one of its sub-tables ends it.
      if (/^\s*\[/.test(line) && !sub.test(line)) { skipping = false; out.push(line); }
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// ---- entries per client ----------------------------------------------------

function codexEntry(server) {
  return codexEntryText(server);
}

function claudeEntry(server) {
  const entry = { command: server.command };
  if (server.args?.length) entry.args = server.args;
  if (server.env && Object.keys(server.env).length) entry.env = server.env;
  return entry;
}

function zcodeEntry(server) {
  if (server.transport === "http") {
    const entry = { type: "remote", url: server.url, enabled: true };
    if (server.headers && Object.keys(server.headers).length) entry.headers = server.headers;
    return entry;
  }
  const entry = { type: "local", enabled: true, command: [server.command, ...(server.args || [])] };
  if (server.env && Object.keys(server.env).length) entry.environment = server.env;
  return entry;
}

function claudeConfigs(env) {
  const out = [];
  for (const set of claudePaths(env).sets) {
    out.push({ root: set.local, file: set.modeConfig });
    out.push({ root: set.local, file: set.threePConfig });
  }
  return out;
}

function zcodeConfigPath(env = process.env) {
  return path.join(zcodePaths(env).dir, "config.json");
}

function zcodeConfigs(env) {
  return [{ file: zcodeConfigPath(env) }];
}

function codexConfigs(env) {
  return [{ file: codexConfigPath(env) }];
}

function clientConfigs(agent, env) {
  if (agent === "claude-desktop") return claudeConfigs(env);
  if (agent === "codex") return codexConfigs(env);
  if (agent === "zcode") return zcodeConfigs(env);
  return [];
}

/** Split the registry: what a client takes, and what it cannot. */
function forClient(servers, agent, stdioOnly) {
  const mine = servers.filter((s) => s.agents.includes(agent) && !s.off);
  return {
    active: mine.filter((s) => !(stdioOnly && s.transport === "http")),
    unsupported: mine.filter((s) => stdioOnly && s.transport === "http").map((s) => s.name),
  };
}

async function writeIfChanged(file, text) {
  const before = await readMaybe(file);
  if (before === text) return false;
  await ensureDir(file);
  await writeTextAtomic(file, text);
  return true;
}

async function writeIfChangedJSON(file, doc) {
  const before = await readMaybe(file);
  if (before != null && before === JSON.stringify(doc)) return false;
  if (before === JSON.stringify(doc, null, 2)) return false;
  await ensureDir(file);
  await writeTextAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  return true;
}

/**
 * Writes (or removes) every registry entry in the clients the user named
 * them for, and records the names written per client so a later deploy only
 * touches Lane's own entries. Returns a per-client report.
 */
export async function deploy(servers, env = process.env) {
  const state = await readState(env);
  state.mcp = state.mcp || {};
  const report = [];

  // -- Claude Desktop: every installation's mode + 3p configs, stdio only --
  const claude = forClient(servers, "claude-desktop", true);
  const claudeState = state.mcp["claude-desktop"] || { roots: {} };
  const claudeRoots = claudeState.roots || {};
  const claudeWritten = [];
  for (const set of claudeConfigs(env)) {
    const prev = claudeRoots[set.root] || [];
    const { doc, existed } = await readConfig(set.file);
    if (!doc) {
      report.push({ agent: "claude-desktop", error: `配置无法解析，已跳过：${path.basename(set.file)}` });
      continue;
    }
    const bag = doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {};
    for (const name of prev) delete bag[name];
    for (const s of claude.active) bag[s.name] = claudeEntry(s);
    if (Object.keys(bag).length) doc.mcpServers = bag;
    else delete doc.mcpServers;
    if (await writeIfChangedJSON(set.file, doc)) claudeWritten.push(path.basename(set.file));
    claudeRoots[set.root] = claude.active.map((s) => s.name);
  }
  state.mcp["claude-desktop"] = { roots: claudeRoots };
  report.push({
    agent: "claude-desktop",
    written: [...new Set(claude.active.map((s) => s.name))],
    unsupported: claude.unsupported,
    files: claudeWritten,
  });

  // -- Codex: config.toml tables, stdio only -------------------------------
  const codex = forClient(servers, "codex", true);
  const codexPrev = state.mcp.codex || [];
  let toml = (await readMaybe(codexConfigPath(env))) ?? "";
  const tomlBefore = toml;
  for (const name of codexPrev) toml = stripCodexEntry(toml, name);
  const codexBlocks = codex.active.map((s) => codexEntryText(s));
  if (codexBlocks.length) {
    toml = toml.trimEnd() ? `${toml.replace(/\s+$/, "")}\n\n${codexBlocks.join("\n\n")}\n` : `${codexBlocks.join("\n\n")}\n`;
  }
  if (toml !== tomlBefore) await writeTextAtomic(codexConfigPath(env), toml);
  state.mcp.codex = codex.active.map((s) => s.name);
  report.push({ agent: "codex", written: codex.active.map((s) => s.name), unsupported: codex.unsupported });

  // -- ZCode: mcp.<name> in config.json, both transports --------------------
  const zcode = forClient(servers, "zcode", false);
  const zc = zcodeConfigs(env)[0];
  const { doc: zdoc, existed: zExisted } = await readConfig(zc.file);
  if (zdoc) {
    const bag = zdoc.mcp && typeof zdoc.mcp === "object" ? zdoc.mcp : {};
    for (const name of state.mcp.zcode || []) delete bag[name];
    for (const s of zcode.active) bag[s.name] = zcodeEntry(s);
    if (Object.keys(bag).length) zdoc.mcp = bag;
    else delete zdoc.mcp;
    await writeIfChangedJSON(zc.file, zdoc);
    state.mcp.zcode = zcode.active.map((s) => s.name);
    report.push({ agent: "zcode", written: zcode.active.map((s) => s.name), unsupported: [] });
  } else if (zExisted) {
    report.push({ agent: "zcode", error: "配置无法解析，已跳过" });
  }

  await writeState(state, env);
  return report;
}

/** Removes every MCP entry Lane wrote, across all clients. */
export async function undeployAll(env = process.env) {
  const state = await readState(env);
  if (!state.mcp) return 0;
  const names = new Set();
  for (const entry of Object.values(state.mcp)) {
    if (Array.isArray(entry)) entry.forEach((name) => names.add(name));
    else if (entry.roots) Object.values(entry.roots).forEach((list) => list.forEach((name) => names.add(name)));
  }
  await deploy([], env);
  delete state.mcp;
  await writeState(state, env);
  return names.size;
}
