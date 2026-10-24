import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { parsePid, processAlive } from "./pid.js";

// The pid rules — pid 0 is nobody, an empty or half-written file names no
// owner — live in pid.js so the seat check and the file locks answer them the
// same way. A released build once refused to start with "pid 0 owns the data
// directory", and the same defect later wedged the accounts lock, because the
// two checks were two copies.

// The seat carries a heartbeat: the owner touches the file every minute, so a
// seat that names a live pid but has not been touched for this long belongs
// to no one. Windows recycles pids, and whatever process inherits a crashed
// owner's pid never heartbeats — without the freshness check it could hold
// the seat forever. Ten minutes tolerates a machine sleeping through beats.
const SEAT_STALE_MS = 10 * 60 * 1000;
const SEAT_HEARTBEAT_MS = 60 * 1000;

const heartbeats = new Map();

function startHeartbeat(file) {
  stopHeartbeat(file);
  // A touch, not a rewrite: the claim's content stays, only its freshness
  // moves. unref'd, so the timer never holds the process open.
  const timer = setInterval(() => {
    fs.utimes(file, new Date(), new Date()).catch(() => {});
  }, SEAT_HEARTBEAT_MS);
  timer.unref?.();
  heartbeats.set(file, timer);
}

function stopHeartbeat(file) {
  const timer = heartbeats.get(file);
  if (timer) clearInterval(timer);
  heartbeats.delete(file);
}

async function seatAgeMs(file) {
  try {
    const { mtimeMs } = await fs.stat(file);
    return Date.now() - mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The gateway seat of a data directory, held in lane.pid. Both owners — the
 * desktop app and `lane serve` — claim through here: the health probe can
 * only see a gateway on the same address, so without this check a second
 * owner on another port would race the first for the journal, each save
 * overwriting the other's rows.
 *
 * The claim itself is an atomic create: 'wx' makes the filesystem pick the
 * winner between processes starting in parallel, where the old
 * check-then-rename let both pass the alive check and the second rename
 * silently stole the seat. Returns `{ claimed: false, owner }` when a live,
 * heartbeating process holds the seat; a dead owner's stale file, a seat
 * gone quiet, an empty one, or no file at all are taken over.
 */
export async function claimOwnership(env = process.env) {
  const root = dataDir(env);
  const file = path.join(root, "lane.pid");
  await fs.mkdir(root, { recursive: true });
  try {
    const handle = await fs.open(file, "wx", 0o600);
    await handle.write(`${process.pid} ${Date.now()}`);
    await handle.close();
    startHeartbeat(file);
    return { claimed: true, owner: 0 };
  } catch (error) {
    // Any other failure — a locked directory, a full disk — is not ours to
    // paper over; only "someone else got there first" falls through to the
    // liveness check below.
    if (error?.code !== "EEXIST") throw error;
  }
  const current = parsePid(await fs.readFile(file, "utf8").catch(() => ""));
  const held = !Number.isNaN(current)
    && current !== process.pid
    && processAlive(current)
    && await seatAgeMs(file) < SEAT_STALE_MS;
  if (held) return { claimed: false, owner: current };
  // A dead owner, a seat gone quiet, or a file naming no owner is taken
  // over — by rename, so a parallel reader sees whole content, never a
  // truncated pid.
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${process.pid} ${Date.now()}`, "utf8");
  await fs.rename(temp, file);
  startHeartbeat(file);
  return { claimed: true, owner: Number.isNaN(current) ? 0 : current };
}

/** Hands the seat back — only if it is still ours to give. */
export async function releaseOwnership(env = process.env) {
  const file = path.join(dataDir(env), "lane.pid");
  stopHeartbeat(file);
  try {
    const current = parsePid(await fs.readFile(file, "utf8"));
    if (current === process.pid) await fs.rm(file, { force: true });
  } catch {}
}
