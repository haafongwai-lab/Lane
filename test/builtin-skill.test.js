import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuiltins, listLibrary, isBuiltinSkill } from "../src/skills.js";
import { createControlCenter } from "../src/control-center.js";

/**
 * find-skills ships with Lane: it is copied into the user's skill library on
 * first read, marked "builtin" (green in the UI), sorted first, and cannot be
 * deleted. The copy is ordinary files, so it can still be installed into a
 * client by junction like any imported skill.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CONTENT = fs.readFileSync(path.join(ROOT, "src/builtin-skills/find-skills/SKILL.md"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "desktop/app.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "desktop/styles.css"), "utf8");

function tempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-builtin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    env: {
      LANE_DATA_DIR: dir,
      USERPROFILE: dir,
      APPDATA: path.join(dir, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(dir, "AppData", "Local"),
      LANE_CLAUDE_LOCALAPPDATA: path.join(dir, "AppData", "Local"),
      CODEX_HOME: path.join(dir, ".codex"),
      ZCODE_HOME: path.join(dir, ".zcode")
    }
  };
}

test("the shipped find-skills content is the upstream skill", () => {
  assert.match(CONTENT, /^name:\s*find-skills$/m);
  assert.match(CONTENT, /^description:\s*Helps users discover and install agent skills/m);
  assert.match(CONTENT, /npx skills find/);
  assert.match(CONTENT, /https:\/\/skills\.sh\//);
  assert.equal(isBuiltinSkill("find-skills"), true);
  assert.equal(isBuiltinSkill("pdf-tools"), false);
});

test("ensureBuiltins seeds the library once and keeps user edits", async (t) => {
  const { dir, env } = tempEnv(t);
  await ensureBuiltins(env);
  const marker = path.join(dir, "skills", "find-skills", "SKILL.md");
  assert.ok(fs.existsSync(marker), "SKILL.md copied into the library");
  assert.equal(fs.readFileSync(marker, "utf8"), CONTENT);

  // Idempotent, and an edited copy is not overwritten by the next read.
  fs.writeFileSync(marker, "# my edited find-skills\n");
  await ensureBuiltins(env);
  assert.equal(fs.readFileSync(marker, "utf8"), "# my edited find-skills\n");

  const rows = await listLibrary(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "find-skills");
});

test("the control plane marks it builtin, sorts it first and refuses removal", async (t) => {
  const { env } = tempEnv(t);
  const control = createControlCenter({ env, checkins: false, port: 0, host: "127.0.0.1" });
  t.after(() => control.stop().catch(() => {}));

  const rows = await control.skillsList();
  assert.equal(rows[0].name, "find-skills");
  assert.equal(rows[0].builtin, true);
  assert.match(rows[0].description, /discover and install agent skills/);

  await assert.rejects(() => control.skillsRemove("find-skills"), /内置技能不能删除/);
  // The un-deletable skill is still installable into a client.
  const installed = await control.skillsInstall("find-skills", "codex");
  assert.equal(installed.linked, true);
});

test("the card is green-marked and has no delete button", () => {
  assert.match(APP, /skill\.builtin \? " builtin" : ""/);
  assert.match(APP, /<em class="skill-builtin">内置<\/em>/);
  assert.match(APP, /skill\.builtin \? "" : '<button class="mini quiet" data-skill-remove=/);
  assert.match(CSS, /\.skill-card\.builtin\s*\{[^}]*var\(--green-bg\)/);
  assert.match(CSS, /\.skill-builtin\s*\{[^}]*var\(--green\)/);
});
