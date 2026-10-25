import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
    for (const agent of AGENTS) {
      for (const target of installTargets(agent, env)) {
        try {
          const st = await fs.lstat(path.join(target, entry.name));
          installs.push({ agent, linked: st.isSymbolicLink() });
        } catch {}
      }
    }
    out.push({ name: entry.name, description, installs });
  }
  return out;
}

/** Imports a folder (with a SKILL.md inside) into the library by copy. */
export async function importFrom(sourceDir, env = process.env) {
  const name = path.basename(sourceDir);
  if (!name || /[\\/:*?"<>|]/.test(name)) {
    throw Object.assign(new Error("文件夹名不能包含 \\ / : * ? \" < > |"), { status: 400 });
  }
  if (!(await isSkillFolder(sourceDir))) {
    throw Object.assign(new Error("所选文件夹里没有 SKILL.md，不是技能"), { status: 400 });
  }
  const target = skillDir(env, name);
  if (await exists(target)) {
    throw Object.assign(new Error(`技能「${name}」已在库中`), { status: 400 });
  }
  await fs.cp(sourceDir, target, { recursive: true });
  return { name, imported: true };
}

/** Removes a skill from the library, un-linking it from every client. */
export async function removeFromLibrary(name, env = process.env) {
  if (!name || /[\\/:*?"<>|]/.test(name)) {
    throw Object.assign(new Error("技能名不合法"), { status: 400 });
  }
  let removed = 0;
  for (const agent of AGENTS) {
    for (const target of installTargets(agent, env)) {
      const p = path.join(target, name);
      try {
        const st = await fs.lstat(p);
        await fs.rm(p, { recursive: st.isDirectory() && !st.isSymbolicLink(), force: true });
        removed++;
      } catch {}
    }
  }
  const dir = skillDir(env, name);
  if (await exists(dir)) {
    await fs.rm(dir, { recursive: true, force: true });
    return { removed, library: true };
  }
  return { removed };
}

/** Installs (junctions) one library skill into one client. */
export async function installTo(name, agent, env = process.env) {
  const source = skillDir(env, name);
  if (!(await isSkillFolder(source))) {
    throw Object.assign(new Error("库中没有这个技能"), { status: 404 });
  }
  if (!AGENTS.includes(agent)) throw Object.assign(new Error("未知客户端"), { status: 400 });
  const results = [];
  for (const target of installTargets(agent, env)) {
    const link = path.join(target, name);
    if (await exists(link)) { results.push({ target, linked: false, existed: true }); continue; }
    await ensureDir(target);
    await fs.symlink(source, link, "junction");
    results.push({ target, linked: true });
  }
  return { name, agent, results };
}

/** Removes the installed links of one skill from one client. */
export async function uninstallFrom(name, agent, env = process.env) {
  let removed = 0;
  for (const target of installTargets(agent, env)) {
    const link = path.join(target, name);
    try {
      const st = await fs.lstat(link);
      if (st.isSymbolicLink()) { await fs.unlink(link); removed++; }
    } catch {}
  }
  return { name, agent, removed };
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

/** True when the folder is inside Lane's own data directory. */
export function inLibrary(p, env = process.env) {
  const root = path.resolve(libraryRoot(env));
  return path.resolve(p).startsWith(root);
}
