import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dataDir } from "./config.js";
import { restrictToOwner } from "./agents/store.js";

/**
 * The control plane's local credential.
 *
 * Loopback binding alone does not separate Windows user sessions: 127.0.0.1 is
 * machine-wide, so a process running as another local user could drive every
 * `/lane/*` operation — including registering an MCP server whose command this
 * user's agents would execute. A per-data-directory token closes that: the
 * gateway requires it on every control route, and only the desktop shell and
 * the CLI ever need to send it. They read it from the same file, which lives
 * in the user's own profile with an owner-only ACL — another local user can
 * reach neither the file nor the loopback port's meaning.
 *
 * The token is created by whoever gets there first (gateway or client) and
 * re-created if the file disappears, so there is no ordering constraint
 * between them. There is no rotation: the file is the single source, a
 * compromise of it already implies same-user access to everything else.
 */

const TOKEN_FILE = "control.token";
const TOKEN_BYTES = 32;

export function controlTokenPath(env = process.env) {
  return path.join(dataDir(env), TOKEN_FILE);
}

/** The current token, creating the file if no previous run left one. */
export async function ensureControlToken(env = process.env) {
  const file = controlTokenPath(env);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }).catch(() => {});
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const token = (await fs.readFile(file, "utf8")).trim();
      if (token) return token;
      // An empty file is not a token: fall through and create one.
    } catch {}
    try {
      const handle = await fs.open(file, "wx", 0o600);
      await handle.write(randomBytes(TOKEN_BYTES).toString("hex"), null, "utf8");
      await handle.close();
      await restrictToOwner(file).catch(() => {});
      return (await fs.readFile(file, "utf8")).trim();
    } catch (error) {
      // Another process created it first; read theirs on the next pass. A
      // different failure (permissions, disk) is not ours to paper over.
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("control token file exists but cannot be read");
}

/** Reads the token without creating one; null when none exists yet. */
export async function readControlToken(env = process.env) {
  try {
    return (await fs.readFile(controlTokenPath(env), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/** Constant-time comparison of a presented token against the expected one. */
export function tokenMatches(candidate, expected) {
  const a = createHash("sha256").update(String(candidate || "")).digest();
  const b = createHash("sha256").update(String(expected || "")).digest();
  return timingSafeEqual(a, b);
}

/** The header name the control plane expects the token in. */
export const CONTROL_TOKEN_HEADER = "x-lane-token";
