import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { writeJSON } from "./agents/store.js";

const authFile = (env) => path.join(dataDir(env), "workbuddy-auth.json");

export async function readAuth(env = process.env) {
  try {
    return JSON.parse(await fs.readFile(authFile(env), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    // The mirror is regenerated from accounts.json on the next change; an
    // empty or truncated copy must not keep the gateway from starting.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeAuth(auth, env = process.env) {
  if (auth == null) {
    await clearAuth(env);
    return;
  }
  const target = authFile(env);
  // The directory's 0700 is set here rather than left to the shared writer:
  // this file holds tokens.
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeJSON(target, auth);
}

export async function clearAuth(env = process.env) {
  await fs.rm(authFile(env), { force: true });
}
