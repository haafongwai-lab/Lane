import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertServer, readServers, removeServer, setServerEnabled, normalizeServer } from "../src/mcp-servers.js";
import { deploy, undeployAll } from "../src/mcp-deploy.js";
import { importFrom, installTo, uninstallFrom, removeFromLibrary, listLibrary } from "../src/skills.js";
import { readState, writeState } from "../src/agents/store.js";
import { claudePaths } from "../src/agents/paths.js";

function tempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    root: dir,
    env: {
      LANE_DATA_DIR: dir,
      USERPROFILE: dir,
      APPDATA: path.join(dir, "AppData", "Roaming"),
      // claudePaths() falls back to LOCALAPPDATA and, failing that, to a
      // PowerShell lookup of the REAL user profile — without this line the
      // suite writes into the developer's own Claude installation.
      LOCALAPPDATA: path.join(dir, "AppData", "Local"),
      LANE_CLAUDE_LOCALAPPDATA: path.join(dir, "AppData", "Local"),
      CODEX_HOME: path.join(dir, ".codex"),
      ZCODE_HOME: path.join(dir, ".zcode")
    }
  };
}

// A guard no test can forget: every path these modules derive must live
// under the temp root, never under the real profile.
function assertSandboxed(env) {
  for (const set of claudePaths(env).sets) {
    assert.ok(
      set.local.startsWith(env.LANE_DATA_DIR),
      `a Claude config path escaped the sandbox: ${set.local}`
    );
  }
}

test("normalizeServer rejects bad names and http without a url", () => {
  assert.ok(normalizeServer({ name: "bad name!", transport: "stdio", command: "x" }).error);
  assert.ok(normalizeServer({ name: "ok", transport: "http" }).error);
  const ok = normalizeServer({ name: "weather", transport: "stdio", command: "npx", args: ["-y", "w"], agents: ["codex"] });
  assert.equal(ok.server.name, "weather");
  assert.deepEqual(ok.server.args, ["-y", "w"]);
});

test("upsert adds then updates, remove takes the row out", async (t) => {
  const { env } = tempEnv(t);
  await upsertServer({ name: "a", transport: "stdio", command: "aa", agents: ["codex"] }, env);
  await upsertServer({ name: "a", transport: "stdio", command: "ab", agents: ["codex", "zcode"] }, env);
  const rows = await readServers(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].command, "ab");
  await removeServer("a", env);
  assert.equal((await readServers(env)).length, 0);
});

test("deploy writes stdio entries into every client in its own shape", async (t) => {
  const { env, root } = tempEnv(t);
  assertSandboxed(env);
  const servers = [
    { name: "weather", transport: "stdio", command: "npx", args: ["-y", "w"], env: { KEY: "v" }, agents: ["claude-desktop", "codex", "zcode"] }
  ];
  await deploy(servers, env);

  const claude = JSON.parse(fs.readFileSync(claudePaths(env).sets[0].modeConfig, "utf8"));
  assert.equal(claude.mcpServers.weather.command, "npx");
  assert.deepEqual(claude.mcpServers.weather.args, ["-y", "w"]);

  const toml = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
  assert.match(toml, /\[mcp_servers\."weather"\]/);
  assert.match(toml, /command = "npx"/);
  assert.match(toml, /\[mcp_servers\."weather"\.env\]/);

  const zcode = JSON.parse(fs.readFileSync(path.join(env.ZCODE_HOME, "v2", "config.json"), "utf8"));
  assert.equal(zcode.mcp.weather.type, "local");
  assert.deepEqual(zcode.mcp.weather.command, ["npx", "-y", "w"]);

  // The wiring records what was written per client.
  const state = await readState(env);
  assert.deepEqual(state.mcp.codex, ["weather"]);
});

test("an http server reaches ZCode and is reported unsupported for the others", async (t) => {
  const { env } = tempEnv(t);
  assertSandboxed(env);
  const servers = [{ name: "remote", transport: "http", url: "https://x.example/mcp", agents: ["claude-desktop", "codex", "zcode"] }];
  const report = await deploy(servers, env);
  const by = Object.fromEntries(report.map((r) => [r.agent, r]));
  assert.deepEqual(by.zcode.written, ["remote"]);
  assert.deepEqual(by["claude-desktop"].unsupported, ["remote"]);
  assert.deepEqual(by.codex.unsupported, ["remote"]);
  // The stdio-only clients must not have it.
  const claude = JSON.parse(fs.readFileSync(claudePaths(env).sets[0].modeConfig, "utf8"));
  assert.ok(!claude.mcpServers?.remote);
});

test("a redeploy removes Lane's old entries and keeps the user's own", async (t) => {
  const { env } = tempEnv(t);
  assertSandboxed(env);
  // The user had their own server before Lane ever wrote.
  const cfg = claudePaths(env).sets[0].modeConfig;
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { mine: { command: "mine.exe" } } }));

  await deploy(
    [{ name: "lane-a", transport: "stdio", command: "a.exe", agents: ["claude-desktop"] },
     { name: "lane-b", transport: "stdio", command: "b.exe", agents: ["claude-desktop"] }],
    env
  );
  // The registry changes: lane-a goes away, lane-c arrives.
  await deploy(
    [{ name: "lane-b", transport: "stdio", command: "b.exe", agents: ["claude-desktop"] },
     { name: "lane-c", transport: "stdio", command: "c.exe", agents: ["claude-desktop"] }],
    env
  );

  const doc = JSON.parse(fs.readFileSync(cfg, "utf8"));
  assert.ok(doc.mcpServers.mine, "the user's own server survives");
  assert.ok(!doc.mcpServers["lane-a"], "the removed entry went");
  assert.ok(doc.mcpServers["lane-b"] && doc.mcpServers["lane-c"], "the active ones stay");
});

test("undeployAll clears every client of Lane's entries", async (t) => {
  const { env } = tempEnv(t);
  assertSandboxed(env);
  await deploy(
    [{ name: "w", transport: "stdio", command: "w.exe", agents: ["claude-desktop", "codex", "zcode"] }],
    env
  );
  const n = await undeployAll(env);
  assert.equal(n, 1);
  const claude = JSON.parse(fs.readFileSync(claudePaths(env).sets[0].modeConfig, "utf8"));
  assert.ok(!claude.mcpServers?.w);
  const toml = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
  assert.doesNotMatch(toml, /mcp_servers/);
  const zcode = JSON.parse(fs.readFileSync(path.join(env.ZCODE_HOME, "v2", "config.json"), "utf8"));
  assert.ok(!zcode.mcp?.w);
});

test("a broken client config is skipped, not rewritten", async (t) => {
  const { env } = tempEnv(t);
  assertSandboxed(env);
  const cfg = claudePaths(env).sets[0].modeConfig;
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, "{not json");
  const report = await deploy(
    [{ name: "w", transport: "stdio", command: "w.exe", agents: ["claude-desktop"] }],
    env
  );
  assert.ok(report.find((r) => r.agent === "claude-desktop" && r.error));
  assert.equal(fs.readFileSync(cfg, "utf8"), "{not json", "the user's file is untouched");
});

test("skills: import, install by junction, uninstall, remove", async (t) => {
  const { env, root } = tempEnv(t);
  const source = path.join(root, "my-skill");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), "# my-skill\n");
  fs.writeFileSync(path.join(source, "helper.txt"), "v1");

  // Import by copy: the library folder is Lane's own.
  await importFrom(source, env);
  const lib = await listLibrary(env);
  assert.equal(lib.length, 1);
  assert.equal(lib[0].name, "my-skill");

  // Install into Codex: a junction whose target is the library folder.
  await installTo("my-skill", "codex", env);
  const link = path.join(env.CODEX_HOME, "skills", "my-skill");
  const st = fs.lstatSync(link);
  assert.ok(st.isSymbolicLink(), "the install is a junction");

  // Editing the LIBRARY copy is what the client sees, because the install
  // is a junction into the library (the import source is a separate copy).
  fs.writeFileSync(path.join(root, "skills", "my-skill", "helper.txt"), "v2");
  assert.equal(fs.readFileSync(path.join(link, "helper.txt"), "utf8"), "v2");

  // Uninstall removes only the link.
  await uninstallFrom("my-skill", "codex", env);
  assert.ok(!fs.existsSync(link));
  assert.ok(fs.existsSync(path.join(root, "skills", "my-skill", "SKILL.md")), "the library keeps the skill");

  // Remove takes the skill out of the library and every install.
  await installTo("my-skill", "zcode", env);
  await removeFromLibrary("my-skill", env);
  assert.ok(!fs.existsSync(path.join(env.ZCODE_HOME, "skills", "my-skill")));
  assert.equal((await listLibrary(env)).length, 0);
});

test("install refuses a folder without SKILL.md", async (t) => {
  const { env, root } = tempEnv(t);
  const notASkill = path.join(root, "not-a-skill");
  fs.mkdirSync(notASkill, { recursive: true });
  await assert.rejects(() => importFrom(notASkill, env), /SKILL.md/);
});
