import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";

const file = (env) => path.join(dataDir(env), "wiring.json");

export async function readState(env = process.env) {
  try {
    return JSON.parse(await fs.readFile(file(env), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeState(state, env = process.env) {
  const target = file(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, target);
}

export async function readJSON(filePath) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    // `null` parses fine and is not a document; returning it used to move
    // the crash downstream to whoever first touched a property on it
    // ("Cannot read properties of null"), far from the file that caused it.
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not a JSON object");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (error?.message === "not a JSON object") {
      throw new Error(`${filePath}: not a JSON object`);
    }
    throw new Error(`cannot read ${filePath}: ${error.message}`);
  }
}

export async function writeJSON(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, filePath);
}

// The same temp-then-rename, for files that hold text rather than JSON —
// the user's Codex config.toml and ZCode provider_config.json among them.
// These files are not Lane's own: a crash mid-write must never leave the
// user's configuration truncated.
export async function writeTextAtomic(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, text, "utf8");
  await fs.rename(temp, filePath);
}
