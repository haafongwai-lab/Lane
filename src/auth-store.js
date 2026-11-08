import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { protectText, unprotectText } from "./secure-auth.js";
import { writeTextAtomic } from "./agents/store.js";

const authFile = (env) => path.join(dataDir(env), "workbuddy-auth.json");

export async function readAuth(env = process.env) {
  try {
    const text = await unprotectText(await fs.readFile(authFile(env), "utf8"));
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    // The mirror is regenerated from accounts.json on the next change; an
    // empty, truncated or undecryptable copy must not keep the gateway from
    // starting.
    if (error instanceof SyntaxError || !error?.code) return null;
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
  const stored = await protectText(`${JSON.stringify(auth, null, 2)}\n`);
  await writeTextAtomic(target, stored);
}

export async function clearAuth(env = process.env) {
  await fs.rm(authFile(env), { force: true });
}
