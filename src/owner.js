import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";

// EPERM says the pid exists but belongs to someone else; only ESRCH says it
// is gone. Anything unknown reads as alive, so a live owner's seat is never
// quietly taken over.
function processAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * The gateway seat of a data directory, held in lane.pid. Both owners — the
 * desktop app and `lane serve` — claim through here: the health probe can
 * only see a gateway on the same address, so without this check a second
 * owner on another port would race the first for the journal, each save
 * overwriting the other's rows.
 *
 * Returns `{ claimed: false, owner }` when a live process holds the seat;
 * a dead owner's stale file is simply taken over.
 */
export async function claimOwnership(env = process.env) {
  const root = dataDir(env);
  const file = path.join(root, "lane.pid");
  let current = 0;
  try {
    current = Number(await fs.readFile(file, "utf8"));
  } catch {}
  if (Number.isFinite(current) && current !== process.pid && processAlive(current)) {
    return { claimed: false, owner: current };
  }
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, String(process.pid));
  return { claimed: true, owner: 0 };
}

/** Hands the seat back — only if it is still ours to give. */
export async function releaseOwnership(env = process.env) {
  const file = path.join(dataDir(env), "lane.pid");
  try {
    const current = Number(await fs.readFile(file, "utf8"));
    if (current === process.pid) await fs.rm(file, { force: true });
  } catch {}
}
