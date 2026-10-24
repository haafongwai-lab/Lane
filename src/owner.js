import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";

// EPERM says the pid exists but belongs to someone else; only ESRCH says it
// is gone. pid 0 never names another process — kill(0) targets the caller's
// own process group and Windows reports pid 0 as EPERM — so it and every
// non-pid read as "nobody home": a missing, empty, or half-written seat file
// must never block a fresh install (a released build once refused to start
// with "pid 0 owns the data directory" for exactly that reason).
function processAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Anything that is not a positive integer — an absent file, an empty line,
// trailing whitespace — is no owner at all, not pid 0.
function parsePid(text) {
  const value = Number(String(text ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : NaN;
}

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
