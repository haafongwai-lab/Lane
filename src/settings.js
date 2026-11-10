import fs from "node:fs/promises";
import path from "node:path";
import { dataDir, DEFAULT_PORT } from "./config.js";
import { DEFAULT_RULES } from "./redact.js";
import { DEFAULT_EGRESS_MODE, normalizeEgressMode } from "./egress.js";
import { writeJSON } from "./agents/store.js";

// Gateway settings the desktop app can change at runtime: the port, the DSH
// name switch, and the request-redaction switches. The host stays loopback —
// exposing the gateway to the network would broadcast the account's API
// credentials with it.
const file = (env) => path.join(dataDir(env), "settings.json");

export function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 0;
  return port;
}

function normalizeRules(value) {
  const out = {};
  for (const key of Object.keys(DEFAULT_RULES)) {
    if (typeof value?.[key] === "boolean") out[key] = value[key];
  }
  return out;
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 200);
}

export async function readSettings(env = process.env) {
  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(file(env), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) stored = {};
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
  // Request redaction is on unless explicitly turned off: the feature exists
  // to keep credentials away from the cloud, so the safe default is on.
  // Personal-data rules (email, phone, ID card, bank card, address) are in
  // the same family but can be switched off on their own when a task
  // legitimately handles personal data.
  const redactSecrets = stored.redactSecrets !== false;
  const redactPersonal = stored.redactPersonal !== false;
  const redactRules = { ...DEFAULT_RULES, ...normalizeRules(stored.redactRules) };
  const redactAllowlist = normalizeList(stored.redactAllowlist);
  const redactCustom = normalizeList(stored.redactCustom);
  // The outbound guard starts in "monitor": it records every host the vendored
  // plugins reach but blocks nothing, so a provider that moved an endpoint is
  // visible in the log instead of breaking a chat on first run. "enforce" is
  // an explicit choice once the recorded list has been reviewed.
  const egressMode = normalizeEgressMode(stored.egressMode || DEFAULT_EGRESS_MODE);
  return {
    port: fromEnv || saved,
    source,
    hideDsh,
    redactSecrets,
    redactPersonal,
    redactRules,
    redactAllowlist,
    redactCustom,
    egressMode
  };
}

// Applies only the keys present in a patch, leaving every other stored
// privacy choice alone.
function applyRedactPatch(next, patch = {}) {
  if (typeof patch.hideDsh === "boolean") next.hideDsh = patch.hideDsh;
  if (typeof patch.redactSecrets === "boolean") next.redactSecrets = patch.redactSecrets;
  if (typeof patch.redactPersonal === "boolean") next.redactPersonal = patch.redactPersonal;
  if (patch.redactRules && typeof patch.redactRules === "object") {
    next.redactRules = { ...(next.redactRules || {}), ...normalizeRules(patch.redactRules) };
  }
  if (Array.isArray(patch.redactAllowlist)) next.redactAllowlist = normalizeList(patch.redactAllowlist);
  if (Array.isArray(patch.redactCustom)) next.redactCustom = normalizeList(patch.redactCustom);
  if (typeof patch.egressMode === "string") next.egressMode = normalizeEgressMode(patch.egressMode);
}

export async function writeSettings(patch, env = process.env) {
  const port = normalizePort(patch?.port);
  if (!port) throw new Error("端口需为 1024–65535 之间的整数");
  const next = await mergeSettings({ port }, env);
  applyRedactPatch(next, patch);
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
  applyRedactPatch(next, patch);
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
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) stored = {};
  delete stored.source;
  return { ...stored, ...patch };
}
