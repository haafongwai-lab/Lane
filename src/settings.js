import fs from "node:fs/promises";
import path from "node:path";
import { dataDir, DEFAULT_PORT } from "./config.js";
import { writeJSON } from "./agents/store.js";

// Gateway settings the desktop app can change at runtime. Only the port
// lives here for now; the host stays loopback — exposing the gateway to
// the network would broadcast the account's API credentials with it.
const file = (env) => path.join(dataDir(env), "settings.json");

export function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 0;
  return port;
}

export async function readSettings(env = process.env) {
  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(file(env), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  // A saved port wins; an env override wins over both, as it always has.
  // Both are normalized here so an out-of-range value never travels all the
  // way to listen() before failing — and "saved" means a valid port was
  // actually read back, not merely that the key existed.
  const fromEnv = normalizePort(env.LANE_PORT) || 0;
  const savedValid = normalizePort(stored.port);
  const saved = savedValid || DEFAULT_PORT;
  const source = fromEnv ? "env" : savedValid ? "saved" : "default";
  // Hiding DeepSeek Harness's name from what it sends is on unless the user
  // turned it off: the name reaching WorkBuddy is what got an account banned.
  // Only an explicit false turns it off — a missing key, a legacy file or a
  // junk value all read as on.
  const hideDsh = stored.hideDsh !== false;
  return { port: fromEnv || saved, source, hideDsh };
}

export async function writeSettings(patch, env = process.env) {
  const port = normalizePort(patch?.port);
  if (!port) throw new Error("端口需为 1024–65535 之间的整数");
  const next = await mergeSettings({ port }, env);
  // A patch that names the switch sets it; one that does not leaves the
  // stored answer alone, so saving a port never resets a privacy choice.
  if (typeof patch?.hideDsh === "boolean") next.hideDsh = patch.hideDsh;
  const target = file(env);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeJSON(target, next);
  return next;
}

/**
 * Sets flags that do not depend on the port. Kept separate from
 * `writeSettings` because that one validates a port for the gateway address:
 * flipping the DSH switch must not fail on a machine whose stored port is
 * somehow unusable.
 */
export async function writeSetting(patch, env = process.env) {
  const next = await mergeSettings({}, env);
  if (typeof patch?.hideDsh === "boolean") next.hideDsh = patch.hideDsh;
  const target = file(env);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeJSON(target, next);
  return next;
}

// Reads the stored file and drops the read-side answers an older write left
// in it, so the next write does not carry them forward.
async function mergeSettings(patch, env) {
  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(file(env), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  delete stored.source;
  return { ...stored, ...patch };
}
