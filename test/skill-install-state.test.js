import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listLibrary, installTo, uninstallFrom, importFrom } from "../src/skills.js";

/**
 * A skill's pip in one client.
 *
 * Lane only removes a junction it made itself — `~/.agents/skills` is a shared
 * folder and another tool's link there is not Lane's to delete. That rule is
 * right, but folding "something is there" into "installed" made 卸载 look
 * broken: the junction went away and the pip stayed lit on the foreign one.
 * The two states are now reported apart, so a click either removes Lane's
 * junction or says why it cannot.
 */

async function tempEnv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-skill-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const env = {
    ...process.env,
    LANE_DATA_DIR: path.join(root, "lane"),
    USERPROFILE: home,
    APPDATA: path.join(root, "appdata")
  };
  return { root, home, env };
}

async function seedSkill(env, root, name) {
  const src = path.join(root, "incoming", name);
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, "SKILL.md"), `# ${name}\n\ndescription: ${name}\n`);
  await importFrom(src, env);
}

const claudeState = async (env, name) => {
  const row = (await listLibrary(env)).find((s) => s.name === name);
  return row.installs.find((i) => i.agent === "claude-desktop");
};

test("a foreign junction in the shared folder reads as occupied, not installed", async (t) => {
  const { root, home, env } = await tempEnv(t);
  await seedSkill(env, root, "find-skills");

  // Another tool's junction, as magpie leaves behind.
  const foreign = path.join(root, "magpie-lib", "find-skills");
  await fs.mkdir(foreign, { recursive: true });
  await fs.writeFile(path.join(foreign, "SKILL.md"), "# find-skills\n");
  const shared = path.join(home, ".agents", "skills");
  await fs.mkdir(shared, { recursive: true });
  await fs.symlink(foreign, path.join(shared, "find-skills"), "junction");

  const state = await claudeState(env, "find-skills");
  assert.equal(state.linked, false, "Lane did not create that junction");
  assert.equal(state.foreign, true, "but the name is taken, and the page must say so");
});

test("uninstalling Lane's junction leaves the foreign one reported apart", async (t) => {
  const { root, home, env } = await tempEnv(t);
  await seedSkill(env, root, "find-skills");
  const foreign = path.join(root, "magpie-lib", "find-skills");
  await fs.mkdir(foreign, { recursive: true });
  await fs.writeFile(path.join(foreign, "SKILL.md"), "# find-skills\n");
  const shared = path.join(home, ".agents", "skills");
  await fs.mkdir(shared, { recursive: true });
  await fs.symlink(foreign, path.join(shared, "find-skills"), "junction");

  // Lane installs its own junction in Claude's folder.
  await installTo("find-skills", "claude-desktop", env);
  let state = await claudeState(env, "find-skills");
  assert.equal(state.linked, true, "the pip lights up once Lane has its own link");
  assert.equal(state.foreign, false, "a live link of Lane's wins over the foreign slot");

  // The user clicks 卸载: Lane's junction goes, the foreign one stays.
  const removed = await uninstallFrom("find-skills", "claude-desktop", env);
  assert.equal(removed.removed, 1, "exactly Lane's junction was removed");
  state = await claudeState(env, "find-skills");
  assert.equal(state.linked, false, "the pip goes dark, which it never used to");
  assert.equal(state.foreign, true, "the remaining foreign slot is reported, not hidden");
  // The foreign junction is untouched: removing it would break that tool.
  await fs.lstat(path.join(shared, "find-skills"));
});

test("with no foreign copy, uninstall leaves nothing behind", async (t) => {
  const { root, env } = await tempEnv(t);
  await seedSkill(env, root, "plain");
  await installTo("plain", "claude-desktop", env);
  assert.equal((await claudeState(env, "plain")).linked, true);

  await uninstallFrom("plain", "claude-desktop", env);
  const row = (await listLibrary(env)).find((s) => s.name === "plain");
  assert.equal(row.installs.length, 0, "no entry at all once every link is gone");
});
