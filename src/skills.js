import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dataDir } from "./config.js";

/**
 * The skills library: folders with a SKILL.md kept in Lane's data directory
 * and installed into clients by a directory junction (Windows) so that
 * editing the library folder IS editing the skill the client runs. Removal
 * is un-linking; nothing of the client's own is ever touched.
 *
 * Install targets, mirroring where each client looks for skills:
 *   Codex           ~/.codex/skills/<name>
 *   ZCode           ~/.zcode/skills/<name>
 *   Claude Desktop  Claude's skills folder per installation (the desktop
 *                   app's own path), plus the shared ~/.agents/skills/<name>
 *                   convention several agents adopted.
 */

const AGENTS = ["codex", "zcode", "claude-desktop"];
const SKILL_MARK = "SKILL.md";

// Skills Lane ships with. They are copied into the library on first use so
// they behave like any other skill (installable by junction, editable), and
// they cannot be removed from the library. The content lives under
// src/builtin-skills/<name>/SKILL.md and is packaged with the app.
export const BUILTIN_SKILLS = ["find-skills"];

export function isBuiltinSkill(name) {
  return BUILTIN_SKILLS.includes(String(name ?? ""));
}

/**
 * Materialises the built-in skills in the user's library when missing. A
 * SKILL.md that already exists is left alone: the user may have edited it,
 * and a later app update must not overwrite their copy.
 */
export async function ensureBuiltins(env = process.env) {
  const root = libraryRoot(env);
  for (const name of BUILTIN_SKILLS) {
    const dir = path.join(root, name);
    const marker = path.join(dir, SKILL_MARK);
    if (await exists(marker)) continue;
    await fs.mkdir(dir, { recursive: true });
    // Read then write, with a plain string path: inside the packaged app the
    // source lives in app.asar, and Electron's fs patch reads a string path
    // there reliably (a file:// URL through copyFile is the shakier path).
    const source = fileURLToPath(new URL(`./builtin-skills/${name}/${SKILL_MARK}`, import.meta.url));
    const content = await fs.readFile(source, "utf8");
    await fs.writeFile(marker, content, "utf8");
  }
}

// Windows refuses these as file or directory names (with or without an
// extension), so a folder by such a name cannot exist in the library —
// better refused here than failed strangely at mkdir time.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// Names Windows cannot store at all. The separators are handled separately
// above, where they also mean traversal; these five cannot name a folder on
// any Windows volume, so a request carrying one is malformed rather than a
// skill Lane merely cannot find.
const WINDOWS_FORBIDDEN = /[:*?"<>|]/;

/**
 * The one gate every skill name passes. A skill name is a single path
 * segment — never a path. The old check was a character blacklist that let
 * ".." through, and path.join(libraryRoot, "..") is the data directory
 * itself, so removeFromLibrary("..") from the HTTP control plane deleted
 * the whole data directory. Anything that is not plainly a folder name is
 * refused here rather than survived by luck.
 */
export function checkSkillName(name) {
  const value = String(name ?? "");
  if (!value || value !== value.trim()) {
    throw Object.assign(new Error("技能名不合法"), { status: 400 });
  }
  // Separators cover "../x", "..\x", absolute paths and any multi-segment
  // name; "." and ".." are traversal on their own.
  if (/[/\\]/.test(value) || value === "." || value === "..") {
    throw Object.assign(new Error("技能名不合法"), { status: 400 });
  }
  // Windows strips trailing dots (a folder created as "demo." *is* "demo"),
  // so a trailing dot would alias Lane's own library entries; a trailing
  // `~<digit>` would alias the 8.3 short name of an earlier entry. Both are
  // refused as malformed rather than survived by luck.
  if (/\.$/.test(value) || /~\d$/.test(value) || value.length > 255) {
    throw Object.assign(new Error("技能名不合法"), { status: 400 });
  }
  if (/[\x00-\x1f]/.test(value) || WINDOWS_RESERVED.test(value) || WINDOWS_FORBIDDEN.test(value)) {
    throw Object.assign(new Error("技能名不合法"), { status: 400 });
  }
  return value;
}

// Belt and braces for the two places a name becomes a filesystem path: the
// resolved target must be a direct child of the root, not just a join that
// happens to look like one.
function contained(root, dir) {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// True when `a` equals `b`, sits inside `b`, or is an ancestor of `b`.
function overlaps(a, b) {
  const inside = path.relative(b, a);
  const ancestor = path.relative(a, b);
  const isPath = (rel) => rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  return isPath(inside) || isPath(ancestor);
}

function libraryRoot(env) {
  return path.join(dataDir(env), "skills");
}

function skillDir(env, name) {
  return path.join(libraryRoot(env), name);
}

function windowsHome(env) {
  return env.USERPROFILE || os.homedir();
}

/** The folders each agent looks for skills in. */
export function installTargets(agent, env = process.env) {
  const home = windowsHome(env);
  if (agent === "codex") {
    const base = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex");
    return [path.join(base, "skills")];
  }
  if (agent === "zcode") {
    const home2 = env.ZCODE_HOME ? path.resolve(env.ZCODE_HOME) : path.join(home, ".zcode");
    return [path.join(home2, "skills")];
  }
  if (agent === "claude-desktop") {
    const local = env.APPDATA || path.join(home, "AppData", "Roaming");
    return [path.join(local, "Claude", "skills"), path.join(home, ".agents", "skills")];
  }
  return [];
}

export function listAgents() {
  return AGENTS;
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function isSkillFolder(dir) {
  try {
    const st = await fs.stat(path.join(dir, SKILL_MARK));
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Whether a link at `link` resolves to `source`.
 *
 * A junction's readlink is the target path as it was written, so a case
 * difference or a trailing separator would make two names for one folder look
 * different. realpath resolves both sides to the same canonical path; when a
 * link is dangling realpath fails, and that link is not pointing at anything
 * Lane can own.
 */
async function pointsAt(link, source) {
  try {
    const [from, to] = await Promise.all([fs.realpath(link), fs.realpath(source)]);
    return path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase();
  } catch {
    return false;
  }
}

/** The library: one row per skill folder, with its description if any. */
export async function listLibrary(env = process.env) {
  const root = libraryRoot(env);
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!(await isSkillFolder(dir))) continue;
    let description = "";
    try {
      const md = await fs.readFile(path.join(dir, SKILL_MARK), "utf8");
      const m = md.match(/^description:\s*(.+)$/m) || md.match(/^#\s+(.+)$/m);
      if (m) description = m[1].trim().slice(0, 120);
    } catch {}
    const installs = [];
    const source = path.join(root, entry.name);
    for (const agent of AGENTS) {
      let linked = false;
      let present = false;
      // A link that is there but is not Lane's: another tool's junction in a
      // shared folder, or a folder the user made by hand. It counts as
      // "occupied" rather than "installed", so the pip can say so instead of
      // reading as Lane's own install that a click cannot remove.
      let foreign = false;
      for (const target of installTargets(agent, env)) {
        const link = path.join(target, entry.name);
        try {
          const st = await fs.lstat(link);
          present = true;
          // A junction counts as Lane's install only when it points at this
          // library copy. `~/.agents/skills` is a shared convention folder:
          // another tool's link there (magpie's own library, a hand-made one)
          // made Lane show every skill as installed to Claude on every start,
          // which read as Lane installing them by itself.
          if (st.isSymbolicLink() && (await pointsAt(link, source))) linked = true;
          else foreign = true;
        } catch {}
      }
      // One row per agent, not per target. Claude Desktop has two skill
      // folders, and the renderer folds installs into a map keyed by agent:
      // two rows meant the last one won, so a real folder of the user's in
      // the second path could hide a live junction in the first.
      //
      // `linked` is what the pip toggles; `foreign` says the name is taken by
      // something Lane did not create, which the page shows separately.
      if (present) installs.push({ agent, linked, foreign: !linked && foreign });
    }
    out.push({ name: entry.name, description, installs });
  }
  return out;
}

/** Imports a folder (with a SKILL.md inside) into the library by copy. */
export async function importFrom(sourceDir, env = process.env) {
  const source = path.resolve(sourceDir);
  // A skill import is a local folder picker operation. Never let the HTTP
  // control plane turn it into an SMB request or a copy of Lane's own data
  // directory (which contains tokens and the journal).
  if (/^[\\/]{2}/.test(String(sourceDir)) || /^[\\/]{2}/.test(source)) {
    throw Object.assign(new Error("技能来源必须是本地文件夹，不能是网络路径"), { status: 400 });
  }
  const name = checkSkillName(path.basename(source));
  if (!(await isSkillFolder(source))) {
    throw Object.assign(new Error("所选文件夹里没有 SKILL.md，不是技能"), { status: 400 });
  }
  const target = skillDir(env, name);
  // Copying a folder that is already the library copy (or sits inside it)
  // would recurse into itself; that is a no-op, not an import. Ancestors are
  // rejected too, so pointing at the data directory cannot copy tokens in.
  const root = path.resolve(libraryRoot(env));
  if (overlaps(source, root)) {
    throw Object.assign(new Error(`技能「${name}」已在库中或位于 Lane 数据目录内`), { status: 400 });
  }
  if (await exists(target)) {
    throw Object.assign(new Error(`技能「${name}」已在库中`), { status: 400 });
  }
  // Resolve symlinks too: a shortcut to the data directory is still the data
  // directory when fs.cp starts walking it.
  try {
    const [realSource, realRoot] = await Promise.all([fs.realpath(source), fs.realpath(root)]);
    if (overlaps(realSource, realRoot)) {
      throw Object.assign(new Error(`技能「${name}」位于 Lane 数据目录内`), { status: 400 });
    }
  } catch (error) {
    if (error?.status) throw error;
    // The source disappeared or cannot be resolved; let isSkillFolder's
    // earlier check own the user-facing error if it is about content.
  }
  await fs.cp(source, target, { recursive: true, dereference: false });
  return { name, imported: true };
}

/**
 * Removes a skill from the library, un-linking it from every client.
 *
 * Only links Lane made are taken away. A real folder that happens to share
 * the name — something the user installed by hand, or another tool's skill
 * — is left alone: deleting it would destroy work Lane never created.
 */
export async function removeFromLibrary(name, env = process.env) {
  checkSkillName(name);
  const source = path.join(libraryRoot(env), name);
  let removed = 0;
  for (const agent of AGENTS) {
    for (const target of installTargets(agent, env)) {
      const p = path.join(target, name);
      // A validated name is one segment, but the containment check is what
      // actually proves the link sits inside the client's skills folder.
      if (!contained(target, p)) continue;
      try {
        const st = await fs.lstat(p);
        // Only a link Lane made is removed: `~/.agents/skills` is shared, and
        // another tool's junction there is not Lane's to delete.
        if (!st.isSymbolicLink() || !(await pointsAt(p, source))) continue;
        await fs.unlink(p);
        removed++;
      } catch {}
    }
  }
  const root = libraryRoot(env);
  const dir = skillDir(env, name);
  // The guard that turns ".." from a data-directory deletion into a refusal:
  // only a direct child of the library is ever removed.
  if (contained(root, dir) && await exists(dir)) {
    await fs.rm(dir, { recursive: true, force: true });
    return { removed, library: true };
  }
  return { removed };
}

/** Installs (junctions) one library skill into one client. */
export async function installTo(name, agent, env = process.env) {
  checkSkillName(name);
  const root = libraryRoot(env);
  const source = path.resolve(skillDir(env, name));
  // The junction's target is the library copy; if the name somehow resolved
  // outside it, nothing downstream is safe to create.
  if (!contained(root, source)) {
    throw Object.assign(new Error("库中没有这个技能"), { status: 404 });
  }
  if (!(await isSkillFolder(source))) {
    throw Object.assign(new Error("库中没有这个技能"), { status: 404 });
  }
  if (!AGENTS.includes(agent)) throw Object.assign(new Error("未知客户端"), { status: 400 });
  const results = [];
  for (const target of installTargets(agent, env)) {
    const link = path.join(target, name);
    if (!contained(target, link)) continue;
    // lstat, not access: a dangling junction still owns the name, while
    // access() follows the link and would call it absent — then symlink()
    // failed with EEXIST on a link Lane itself had made.
    let occupied = null;
    try { occupied = await fs.lstat(link); } catch {}
    if (occupied) {
      // A junction already pointing at this library copy is Lane's own
      // install (the user clicked twice, or the renderer was stale): report
      // it as installed instead of "occupied by someone else's folder".
      if (occupied.isSymbolicLink() && (await pointsAt(link, source))) {
        results.push({ target, linked: true, existed: true, ours: true });
        continue;
      }
      results.push({ target, linked: false, existed: true });
      continue;
    }
    await ensureDir(target);
    // ntfs junctions require an absolute target, which path.resolve gives.
    await fs.symlink(source, link, "junction");
    results.push({ target, linked: true });
  }
  // The renderer needs to know whether anything was actually installed:
  // "已安装到 Claude" beside a pip that never lights up reads as a broken
  // button when every target already holds a folder of the user's own.
  return {
    name,
    agent,
    results,
    linked: results.some((r) => r.linked),
    occupied: results.filter((r) => r.existed && !r.ours).map((r) => r.target)
  };
}

/** Removes the installed links of one skill from one client. */
export async function uninstallFrom(name, agent, env = process.env) {
  checkSkillName(name);
  const source = path.join(libraryRoot(env), name);
  let removed = 0;
  for (const target of installTargets(agent, env)) {
    const link = path.join(target, name);
    if (!contained(target, link)) continue;
    try {
      const st = await fs.lstat(link);
      // Only Lane's own junction goes: `~/.agents/skills` is a shared folder,
      // and unlinking another tool's link would break that tool's install.
      if (!st.isSymbolicLink() || !(await pointsAt(link, source))) continue;
      await fs.unlink(link);
      removed++;
    } catch {}
  }
  return { name, agent, removed };
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

/** True when the folder is inside Lane's own skill library. */
export function inLibrary(p, env = process.env) {
  // A relative-path check, not a prefix compare: `startsWith` reads a
  // sibling folder (`…\skills-evil`) as inside `…\skills`.
  const root = path.resolve(libraryRoot(env));
  const rel = path.relative(root, path.resolve(p));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
