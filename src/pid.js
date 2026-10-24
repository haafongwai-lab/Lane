/**
 * Liveness of the pid a lock or seat file names.
 *
 * Every place that guards a file against a second writer — the data-directory
 * seat, the accounts lock, the check-in lock, the request journal — has to
 * answer the same two questions about a pid it read back: does that process
 * still exist, and is a file that names none of them good enough to take over?
 * They answered it with three separate copies of this code, and a fix applied
 * to one of them did not reach the others: 0.2.7 fixed the seat check so an
 * empty `lane.pid` no longer blocks a fresh install, while the identical
 * defect kept the accounts lock wedged until the file was deleted by hand.
 * One copy, here.
 */

/**
 * EPERM says the pid exists but belongs to someone else; only ESRCH says it is
 * gone. Anything unknown reads as alive, so a live holder's lock is never
 * mistaken for a crashed one.
 *
 * pid 0 is not a process: `kill(0, 0)` targets the caller's own process group
 * and Windows reports it as success, so an empty or truncated file —
 * `Number("")` is 0 — would otherwise read as a live holder forever.
 */
export function processAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * The pid a lock or seat file names, or NaN when it names none. Anything that
 * is not a positive integer — an absent file, an empty line, trailing
 * whitespace, a half-written header — is no owner at all, not pid 0.
 *
 * The pid is the first whitespace-separated field because the accounts lock
 * writes `<pid> <timestamp>`; a seat file holds the bare pid.
 */
export function parsePid(text) {
  const first = String(text ?? "").trim().split(/\s+/)[0];
  const value = Number(first);
  return Number.isInteger(value) && value > 0 ? value : NaN;
}
