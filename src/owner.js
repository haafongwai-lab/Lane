import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { parsePid, processAlive } from "./pid.js";

// The pid rules — pid 0 is nobody, an empty or half-written file names no
// owner — live in pid.js so the seat check and the file locks answer them the
// same way. A released build once refused to start with "pid 0 owns the data
// directory", and the same defect later wedged the accounts lock, because the
// two checks were two copies.

/**
 * The gateway seat of a data directory, held in lane.pid. Both owners — the
 * desktop app and `lane serve` — claim through here: the health probe can
 * only see a gateway on the same address, so without this check a second
 * owner on another port would race the first for the journal, each save
 * overwriting the other's rows.
 *
 * Returns `{ claimed: false, owner }` when a live process holds the seat;
 * a dead owner's stale file, an empty one, or no file at all are taken over.
 */
export async function claimOwnership(env = process.env) {
  const root = dataDir(env);
  const file = path.join(root, "lane.pid");
  let current = NaN;
  try {
    current = parsePid(await fs.readFile(file, "utf8"));
  } catch {}
  if (!Number.isNaN(current) && current !== process.pid && processAlive(current)) {
    return { claimed: false, owner: current };
  }
  // The seat lands atomically: a process starting in parallel reads either
  // the previous content or the full new one, never a truncated pid.
  await fs.mkdir(root, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, String(process.pid), "utf8");
  await fs.rename(temp, file);
  return { claimed: true, owner: 0 };
}

/** Hands the seat back — only if it is still ours to give. */
export async function releaseOwnership(env = process.env) {
  const file = path.join(dataDir(env), "lane.pid");
  try {
    const current = parsePid(await fs.readFile(file, "utf8"));
    if (current === process.pid) await fs.rm(file, { force: true });
  } catch {}
}
