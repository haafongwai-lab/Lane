import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createServer } from "../src/server.js";
import { createControlCenter } from "../src/control-center.js";

/**
 * End-to-end over HTTP: the /lane/mcp and /lane/skills routes through the
 * real control center, with every client path sandboxed into a temp home.
 * Guards against the wiring being right in modules but wrong over the wire
 * (route names, method, body shape, error status).
 */

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-ext-http-"));
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

// A provider that never reaches the network: these routes do not touch it.
const provider = {
  async listModels() { return [{ id: "auto", name: "Auto" }]; },
  async chat() { throw new Error("not used"); }
};

async function start(t) {
  const { dir, env } = sandbox(t);
  const control = createControlCenter({ env, checkins: false, port: 0, host: "127.0.0.1" });
  t.after(() => control.stop?.().catch(() => {}));
  const server = createServer({ provider, control });
  const base = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base, env, dir };
}

const post = (base, pathname, body) => fetch(`${base}${pathname}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body)
});

test("MCP routes: add, list with targets, toggle, set agents, remove", async (t) => {
  const { base, env } = await start(t);

  // Empty at first, and the client list is there for the lamps.
  const empty = await (await fetch(`${base}/lane/mcp`)).json();
  assert.deepEqual(empty.servers, []);
  assert.equal(empty.targets.length, 3);

  // Add one, deployed to two clients.
  const added = await post(base, "/lane/mcp", {
    name: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "fs-server"],
    agents: ["codex", "zcode"]
  });
  assert.equal(added.status, 200);
  const body = await added.json();
  assert.equal(body.server.name, "filesystem");
  assert.ok(body.report.some((r) => r.agent === "codex" && r.written.includes("filesystem")));

  // It really landed in the clients' own files.
  const toml = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
  assert.match(toml, /\[mcp_servers\."filesystem"\]/);
  const zcode = JSON.parse(fs.readFileSync(path.join(env.ZCODE_HOME, "v2", "config.json"), "utf8"));
  assert.deepEqual(zcode.mcp.filesystem.command, ["npx", "-y", "fs-server"]);

  // Toggle off: the entries are withdrawn from the configs.
  const off = await (await post(base, "/lane/mcp/toggle", { name: "filesystem", off: true })).json();
  assert.equal(off.server.off, true);
  const tomlAfter = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
  assert.doesNotMatch(tomlAfter, /mcp_servers\.\?"filesystem"/);

  // Back on, then narrow the clients to ZCode only.
  await post(base, "/lane/mcp/toggle", { name: "filesystem", off: false });
  const narrowed = await (await post(base, "/lane/mcp/agents", { name: "filesystem", agents: ["zcode"] })).json();
  assert.deepEqual(narrowed.server.agents, ["zcode"]);
  const tomlNarrow = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
  assert.doesNotMatch(tomlNarrow, /filesystem/, "codex lost the entry it no longer owns");

  // Remove: gone from the registry and from ZCode.
  const removed = await (await post(base, "/lane/mcp/remove", { name: "filesystem" })).json();
  assert.equal(removed.removed, true);
  const zcodeAfter = JSON.parse(fs.readFileSync(path.join(env.ZCODE_HOME, "v2", "config.json"), "utf8"));
  assert.ok(!zcodeAfter.mcp?.filesystem);
  const listed = await (await fetch(`${base}/lane/mcp`)).json();
  assert.deepEqual(listed.servers, []);
});

test("MCP routes reject a bad server with 400, not a crash", async (t) => {
  const { base } = await start(t);
  const res = await post(base, "/lane/mcp", { name: "bad name!", transport: "stdio", command: "x" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /名称/);
  // The gateway is still serving.
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("skills routes: import from a folder, install, list, uninstall, remove", async (t) => {
  const { base, env, dir } = await start(t);

  const source = path.join(dir, "pdf-tools");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\ndescription: PDF 工具\n---\n# pdf-tools\n");

  const imported = await (await post(base, "/lane/skills/import", { dir: source })).json();
  assert.equal(imported.name, "pdf-tools");

  let list = await (await fetch(`${base}/lane/skills`)).json();
  assert.equal(list.skills.length, 1);
  assert.equal(list.skills[0].name, "pdf-tools");
  assert.match(list.skills[0].description, /PDF/);
  assert.deepEqual(list.skills[0].installs, []);

  // Install into Codex: a junction appears, and the list reports it.
  await post(base, "/lane/skills/install", { name: "pdf-tools", agent: "codex" });
  const link = path.join(env.CODEX_HOME, "skills", "pdf-tools");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  list = await (await fetch(`${base}/lane/skills`)).json();
  assert.ok(list.skills[0].installs.some((i) => i.agent === "codex" && i.linked));

  // Uninstall leaves the library copy.
  await post(base, "/lane/skills/uninstall", { name: "pdf-tools", agent: "codex" });
  assert.ok(!fs.existsSync(link));
  assert.ok(fs.existsSync(path.join(dir, "skills", "pdf-tools", "SKILL.md")));

  // Remove clears the library too.
  await post(base, "/lane/skills/remove", { name: "pdf-tools" });
  list = await (await fetch(`${base}/lane/skills`)).json();
  assert.deepEqual(list.skills, []);
});

test("a skills import of something that is not a skill answers 400", async (t) => {
  const { base, dir } = await start(t);
  const notASkill = path.join(dir, "plain-folder");
  fs.mkdirSync(notASkill, { recursive: true });
  const res = await post(base, "/lane/skills/import", { dir: notASkill });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /SKILL\.md/);
});
