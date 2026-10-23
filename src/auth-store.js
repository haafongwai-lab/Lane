import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./config.js";

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
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, target);
}

export async function clearAuth(env = process.env) {
  await fs.rm(authFile(env), { force: true });
}
