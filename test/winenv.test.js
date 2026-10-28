import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { localAppData, userProfile, forgetResolvedFolders } from "../src/winenv.js";
import { dataDir } from "../src/config.js";
import { claudePaths, codexConfigPath } from "../src/agents/paths.js";

/**
 * Resolving the Windows profile folders used to spawn PowerShell, blocking
 * the event loop for up to three seconds, from two separate copies of the
 * same code. Both were reached on every status poll. These tests pin that
 * the explicit environment wins, that the standard layout answers without a
 * subprocess, and that nothing throws when both are missing.
 */

test("an explicit LOCALAPPDATA wins and is resolved", () => {
  forgetResolvedFolders();
  const given = path.join(os.tmpdir(), "lane-env-explicit");
  assert.equal(localAppData({ LOCALAPPDATA: given }), path.resolve(given));
});

test("an explicit USERPROFILE wins and is resolved", () => {
  forgetResolvedFolders();
  const given = path.join(os.tmpdir(), "lane-home-explicit");
  assert.equal(userProfile({ USERPROFILE: given }), path.resolve(given));
});

test("dataDir follows the caller's environment, never the real profile", () => {
  forgetResolvedFolders();
  const env = { LOCALAPPDATA: path.join(os.tmpdir(), "lane-env-cfg") };
  assert.equal(dataDir(env), path.join(path.resolve(env.LOCALAPPDATA), "lane"));
  // LANE_DATA_DIR still outranks everything.
  assert.equal(dataDir({ ...env, LANE_DATA_DIR: "relative/dir" }), path.resolve("relative/dir"));
});

test("claudePaths and codexConfigPath stay inside the given home", () => {
  forgetResolvedFolders();
  const env = {
    LOCALAPPDATA: path.join(os.tmpdir(), "lane-env-claude"),
    LANE_CLAUDE_LOCALAPPDATA: path.join(os.tmpdir(), "lane-env-claude")
  };
  for (const set of claudePaths(env).sets) {
    assert.ok(set.local.startsWith(env.LOCALAPPDATA), set.local);
  }
  const home = path.join(os.tmpdir(), "lane-env-home");
  assert.equal(
    codexConfigPath({ USERPROFILE: home }),
    path.join(path.resolve(home), ".codex", "config.toml")
  );
});

test("a missing environment still yields absolute paths", () => {
  forgetResolvedFolders();
  // Nothing to fall back on: the answer must still be usable rather than
  // empty, and must not throw on the way there.
  const local = localAppData({});
  const home = userProfile({});
  assert.ok(path.isAbsolute(local), local);
  assert.ok(path.isAbsolute(home), home);
  assert.equal(dataDir({}), path.join(local, "lane"));
});
