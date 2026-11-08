import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * "Imported successfully, but the library is empty": the desktop IPC handler
 * returned a bare array while the renderer read result.skills. The HTTP route
 * /lane/skills wraps its list, so the end-to-end HTTP suite never saw the
 * desktop path. These pin both halves of that contract, and drive the real
 * loadExtensions() with a stubbed window.lane to prove a list is rendered.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(HERE, "..", "desktop", "app.js"), "utf8");
const MAIN = fs.readFileSync(path.join(HERE, "..", "desktop", "main.js"), "utf8");

function liftLoadExtensions() {
  const from = APP.indexOf("async function loadExtensions()");
  const to = APP.indexOf("function transportLabel(", from);
  assert.ok(from >= 0 && to > from, "loadExtensions is still in app.js");
  return APP.slice(from, to);
}

function drive(skillsResult) {
  const seen = { rendered: null, errors: [], mcp: 0 };
  const body = liftLoadExtensions();
  const make = new Function("window", "extData", "renderMcp", "renderSkills", "extError",
    body + "\nreturn loadExtensions;");
  const run = make(
    { lane: {
      mcpList: async () => ({ servers: [], targets: [] }),
      skillsList: async () => {
        if (skillsResult instanceof Error) throw skillsResult;
        return skillsResult;
      }
    } },
    { servers: [], targets: [] },
    () => { seen.mcp += 1; },
    (list) => { seen.rendered = list; },
    (id, message) => { seen.errors.push([id, message]); }
  );
  return run().then(() => seen);
}

test("the desktop IPC handler wraps the skills list like the HTTP route", () => {
  const from = MAIN.indexOf('handleIpc("lane:skills"');
  const to = MAIN.indexOf('handleIpc("lane:skills-import"', from);
  assert.ok(from >= 0 && to > from, "lane:skills handler is still in main.js");
  const handler = MAIN.slice(from, to);
  assert.match(handler, /return \{\s*skills:\s*await control\.skillsList\(\)\s*\}/);
  assert.doesNotMatch(handler, /return control\.skillsList\(\);/);
});

test("a wrapped list renders the imported skills", async () => {
  const seen = await drive({ skills: [{ name: "pdf-tools", description: "PDF" }] });
  assert.equal(seen.rendered.length, 1);
  assert.equal(seen.rendered[0].name, "pdf-tools");
  assert.equal(seen.mcp, 1, "the MCP panel still renders");
  assert.deepEqual(seen.errors, [["mcp-error", ""], ["skill-error", ""]]);
});

test("a bare array no longer blanks the library", async () => {
  const seen = await drive([{ name: "bare" }]);
  assert.equal(seen.rendered.length, 1, "defensive shape handling");
});

test("a skills failure is shown in the skills panel, not the MCP one", async () => {
  const seen = await drive(new Error("skills read failed"));
  assert.equal(seen.rendered, null);
  assert.equal(seen.mcp, 1, "one bad read must not blank the other panel");
  assert.deepEqual(seen.errors.find(([id]) => id === "skill-error"), ["skill-error", "skills read failed"]);
  assert.ok(!seen.errors.some(([id, msg]) => id === "mcp-error" && msg), "no false MCP error");
});

test("the renderer and install handler agree about a partially installed skill", () => {
  const from = APP.indexOf("function renderSkills(");
  const end = APP.indexOf("\n}", from);
  const render = APP.slice(from, end + 2);
  // A client with two skill folders must read as installed if either is linked.
  assert.match(render, /installed\[item\.agent\]\s*=\s*installed\[item\.agent\]\s*\|\|/);
  const click = APP.slice(APP.indexOf('$("#skills-list")'));
  assert.match(click, /result\.linked === false/, "no false '已安装' toast");
  assert.match(click, /skillsBusy/, "no double-click against a stale pip");
});
