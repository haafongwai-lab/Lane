import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installTo, listLibrary, removeFromLibrary, uninstallFrom } from "../src/skills.js";

/**
 * `~/.agents/skills` is a shared convention folder, not Lane's own. Another
 * tool's junction there (magpie's library, a hand-made link) used to read as
 * "installed to Claude" on every start, which looked like Lane installing
 * skills by itself.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

async function tempEnv(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "lane-skills-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const data = path.join(home, "lane");
  const env = {
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LANE_DATA_DIR: data
  };
  // One skill in Lane's library.
  const skill = path.join(data, "skills", "demo");
  await fsp.mkdir(skill, { recursive: true });
  await fsp.writeFile(path.join(skill, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n", "utf8");
  return { env, home, skill };
}

test("another tool's junction in the shared folder is not Lane's install", async (t) => {
  const { env, home } = await tempEnv(t);
  const foreign = path.join(home, "elsewhere", "demo");
  await fsp.mkdir(foreign, { recursive: true });
  await fsp.writeFile(path.join(foreign, "SKILL.md"), "# demo\n", "utf8");
  const shared = path.join(home, ".agents", "skills");
  await fsp.mkdir(shared, { recursive: true });
  await fsp.symlink(foreign, path.join(shared, "demo"), "junction");

  const [row] = await listLibrary(env);
  const claude = row.installs.find((item) => item.agent === "claude-desktop");
  assert.ok(claude, "the shared folder is still reported as present");
  assert.equal(claude.linked, false, "a foreign junction is not Lane's install");
});

test("Lane's own junction is reported as installed", async (t) => {
  const { env, skill } = await tempEnv(t);
  const shared = path.join(env.USERPROFILE, ".agents", "skills");
  await fsp.mkdir(shared, { recursive: true });
  await fsp.symlink(skill, path.join(shared, "demo"), "junction");

  const [row] = await listLibrary(env);
  const claude = row.installs.find((item) => item.agent === "claude-desktop");
  assert.equal(claude.linked, true);
});

test("uninstall leaves another tool's junction alone", async (t) => {
  const { env, home } = await tempEnv(t);
  const foreign = path.join(home, "elsewhere", "demo");
  await fsp.mkdir(foreign, { recursive: true });
  await fsp.writeFile(path.join(foreign, "SKILL.md"), "# demo\n", "utf8");
  const shared = path.join(home, ".agents", "skills");
  await fsp.mkdir(shared, { recursive: true });
  const link = path.join(shared, "demo");
  await fsp.symlink(foreign, link, "junction");

  const result = await uninstallFrom("demo", "claude-desktop", env);
  assert.equal(result.removed, 0);
  assert.ok(fs.existsSync(link), "the foreign junction survives");
});

test("installing over Lane's own junction reports it as installed, not occupied", async (t) => {
  const { env } = await tempEnv(t);
  const first = await installTo("demo", "claude-desktop", env);
  assert.equal(first.linked, true);
  const second = await installTo("demo", "claude-desktop", env);
  assert.equal(second.linked, true);
  assert.deepEqual(second.occupied, [], "Lane's own link is not someone else's folder");
});

test("removing a library skill takes only Lane's own links", async (t) => {
  const { env, home } = await tempEnv(t);
  const foreign = path.join(home, "elsewhere", "demo");
  await fsp.mkdir(foreign, { recursive: true });
  await fsp.writeFile(path.join(foreign, "SKILL.md"), "# demo\n", "utf8");
  const shared = path.join(home, ".agents", "skills");
  await fsp.mkdir(shared, { recursive: true });
  const foreignLink = path.join(shared, "demo");
  await fsp.symlink(foreign, foreignLink, "junction");

  const result = await removeFromLibrary("demo", env);
  assert.equal(result.library, true, "the library copy is removed");
  assert.ok(fs.existsSync(foreignLink), "another tool's link stays");
});

test("the renderer uses the shared hover popup, never a native title", () => {
  const app = fs.readFileSync(path.join(ROOT, "desktop/app.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "desktop/index.html"), "utf8");
  assert.doesNotMatch(app, /title="/, "no native title tooltip in the renderer");
  assert.doesNotMatch(html, /title="/, "no native title tooltip in the markup");
  assert.match(app, /data-tip=/);
});
