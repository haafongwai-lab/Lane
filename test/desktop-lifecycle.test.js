import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";
import { createControlCenter } from "../src/control-center.js";
import { readServers } from "../src/mcp-servers.js";

/**
 * The desktop main process cannot be imported into node:test (it needs a
 * live Electron app), so its contract is pinned two ways: source assertions
 * for the guards, and a real loopback round trip through the owner's HTTP
 * routes for the forwarded writes. The gateway here is the same createServer
 * the CLI runs, with a temporary data directory.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(HERE, "..", "desktop", "main.js"), "utf8");
const PRELOAD = fs.readFileSync(path.join(HERE, "..", "desktop", "preload.cjs"), "utf8");
const APP = fs.readFileSync(path.join(HERE, "..", "desktop", "app.js"), "utf8");
const SERVER = fs.readFileSync(path.join(HERE, "..", "src", "server.js"), "utf8");

// ---------------------------------------------------------------------------
// 1. follower lifecycle: one control across IPC calls, takeover when it dies
// ---------------------------------------------------------------------------

test("a follower reuses its control instead of rebuilding it per IPC call", () => {
  const from = MAIN.indexOf("async function startGateway()");
  const to = MAIN.indexOf("async function stopGateway()", from);
  const body = MAIN.slice(from, to);
  assert.match(body, /if \(attached\?\.port === PORT && control\) return/,
    "an attached follower short-circuits before createControlCenter");
  assert.match(body, /attached = \{ port: PORT \}/);
  assert.match(body, /attached = null;/,
    "the attachment clears when the external gateway disappears, so this window can take over");
  assert.match(MAIN, /attached = null;[\s\S]{0,200}if \(!gateway\) return/,
    "stopGateway clears it too");
});

// ---------------------------------------------------------------------------
// 2. follower writes reach the owner over loopback
// ---------------------------------------------------------------------------

test("every control-center shared-guard write has a matching forward route", () => {
  const cc = fs.readFileSync(path.join(HERE, "..", "src", "control-center.js"), "utf8");
  const guarded = [...cc.matchAll(/if \(journal\.shared\) throw new Error/g)].length;
  assert.ok(guarded >= 10, "the shared guards still exist");
  const forwarded = [...MAIN.matchAll(/controlWrite\("(\/lane\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(forwarded.length, 10, "one forward per refused write");
  for (const route of forwarded) {
    const literal = route.split("/").pop();
    assert.ok(SERVER.includes(`url.pathname === "${route}"`), `no owner route for ${route}`);
    assert.ok(literal);
  }
});

function liftWriters(base, ownsGateway, fetchImpl) {
  const from = MAIN.indexOf("async function ownerWrite(");
  const to = MAIN.indexOf("function showWindow(", from);
  assert.ok(from >= 0 && to > from, "ownerWrite is still in main.js");
  return new Function("GATEWAY", "ownsGateway", "fetch",
    MAIN.slice(from, to) + "\nreturn { ownerWrite, controlWrite };")(base, ownsGateway, fetchImpl);
}

test("a forwarded MCP write lands in the owner's registry", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-forward-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    LANE_DATA_DIR: dir,
    USERPROFILE: dir,
    APPDATA: path.join(dir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(dir, "AppData", "Local"),
    LANE_CLAUDE_LOCALAPPDATA: path.join(dir, "AppData", "Local"),
    CODEX_HOME: path.join(dir, ".codex"),
    ZCODE_HOME: path.join(dir, ".zcode")
  };
  const control = createControlCenter({ env, checkins: false, port: 0, host: "127.0.0.1" });
  t.after(() => control.stop?.().catch(() => {}));
  const server = createServer({ provider: { async listModels() { return []; } }, control });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const { controlWrite } = liftWriters(base, false, globalThis.fetch);
  const entry = { name: "forwarded", transport: "stdio", command: "npx", args: ["-y", "x"], agents: ["codex"] };
  const result = await controlWrite("/lane/mcp", entry, () => {
    throw new Error("a follower must not call its local control");
  });
  assert.equal(result.server.name, "forwarded");
  assert.equal((await readServers(env)).length, 1, "the owner's mcp.json was written");
});

test("a forwarded error keeps the owner's message", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-forward-err-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    LANE_DATA_DIR: dir, USERPROFILE: dir,
    APPDATA: path.join(dir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(dir, "AppData", "Local"),
    LANE_CLAUDE_LOCALAPPDATA: path.join(dir, "AppData", "Local"),
    CODEX_HOME: path.join(dir, ".codex"), ZCODE_HOME: path.join(dir, ".zcode")
  };
  const control = createControlCenter({ env, checkins: false, port: 0, host: "127.0.0.1" });
  t.after(() => control.stop?.().catch(() => {}));
  const server = createServer({ provider: { async listModels() { return []; } }, control });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { controlWrite } = liftWriters(base, false, globalThis.fetch);
  await assert.rejects(
    () => controlWrite("/lane/mcp", { name: "bad name!", transport: "stdio", command: "x" }, () => {}),
    /名称需为字母|name/i,
    "the 400 from the owner surfaces as the IPC error"
  );
});

test("an owned window still writes locally", async () => {
  const calls = [];
  const { controlWrite } = liftWriters("http://127.0.0.1:1", true, async () => {
    throw new Error("an owned window must not use loopback");
  });
  const value = await controlWrite("/lane/mcp", {}, () => { calls.push("local"); return { ok: true }; });
  assert.deepEqual(value, { ok: true });
  assert.deepEqual(calls, ["local"]);
});

// ---------------------------------------------------------------------------
// 3. port save reports failures instead of swallowing them
// ---------------------------------------------------------------------------

test("a failed client rewrite is reported, not swallowed", () => {
  const from = MAIN.indexOf('ipcMain.handle("lane:save-gateway-settings"');
  const to = MAIN.indexOf('ipcMain.handle("lane:open"', from);
  const handler = MAIN.slice(from, to);
  assert.match(handler, /failures\.push\(\{ agent, message:/);
  assert.match(handler, /autostartError = error\?\.message/);
  assert.match(handler, /^\s*failures,$/m);
  assert.match(handler, /^\s*autostartError,$/m);
  assert.doesNotMatch(handler, /\} catch \{\}/);
  const ui = APP.slice(APP.indexOf('$("#gateway-port-save")'), APP.indexOf('$("#refresh-route")'));
  assert.match(ui, /result\.failures/);
  assert.match(ui, /result\.autostartError/);
  assert.match(ui, /但有配置未同步/);
});

// ---------------------------------------------------------------------------
// 4. smoke test stays read-only against the live account
// ---------------------------------------------------------------------------

test("smoke mode mounts no check-in scheduler and sends no billable request", () => {
  assert.match(MAIN, /checkins: !isSmokeTest/);
  assert.match(MAIN, /checkins: false,\s*shared: true/, "a follower never claims check-ins");
  const testHandler = MAIN.slice(
    MAIN.indexOf('ipcMain.handle("lane:test"'),
    MAIN.indexOf('ipcMain.handle("lane:view"')
  );
  assert.match(testHandler, /if \(isSmokeTest\)/);
  assert.match(testHandler, /upstream skipped/);
  assert.doesNotMatch(testHandler, /if \(isSmokeTest\)[\s\S]{0,80}fetch\(/);
});

// ---------------------------------------------------------------------------
// 5. tray failure is visible and the window stays quittable
// ---------------------------------------------------------------------------

test("a failed tray is logged and a hidden window is not stranded", () => {
  assert.match(MAIN, /could not create the tray/);
  assert.match(MAIN, /tray = null;/);
  const close = MAIN.slice(MAIN.indexOf('window.on("close"'), MAIN.indexOf('window.once("ready-to-show"'));
  assert.match(close, /if \(!tray\)/);
  assert.match(close, /app\.quit\(\)/);
});

// ---------------------------------------------------------------------------
// 6. onSignIn dedupes and can be unsubscribed
// ---------------------------------------------------------------------------

test("onSignIn replaces its listener and can be removed", () => {
  assert.match(PRELOAD, /let signInListener = null/);
  assert.match(PRELOAD, /ipcRenderer\.removeListener\("lane:signin", signInListener\)/);
  assert.match(PRELOAD, /offSignIn: \(\) => \{/);
});
