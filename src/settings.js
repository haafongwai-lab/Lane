import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, DEFAULT_PORT } from "./config.js";

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
  return { port: fromEnv || saved, source };
}

export async function writeSettings(patch, env = process.env) {
  const port = normalizePort(patch?.port);
  if (!port) throw new Error("端口需为 1024–65535 之间的整数");
  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(file(env), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  // The computed `source` is a read-side answer; a legacy copy of it from an
  // older write does not belong in the file either.
  delete stored.source;
  const next = { ...stored, port };
  const target = file(env);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, target);
  return next;
}
