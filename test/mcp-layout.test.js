import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A long MCP test verdict (eight tool names) used to knock the row's lamps
 * and buttons out of place: the verdict was rendered inside .mcp-item-main,
 * so the flex row grew and `align-items: center` dropped the right-hand side
 * into the middle of the taller block. See desktop/styles.css.
 *
 * renderMcp() lives in app.js, which touches window.lane and the DOM the
 * moment it loads, so the function is lifted out of the source and driven
 * with stubs — the generated HTML is the real renderer's output.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(HERE, "..", "desktop", "app.js"), "utf8");
const CSS = fs.readFileSync(path.join(HERE, "..", "desktop", "styles.css"), "utf8");

const esc = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const AGENT_SHORT = { "claude-desktop": "Claude", codex: "Codex", zcode: "ZCode" };
const transportLabel = (server) => server.transport === "http" ? "http" : "stdio";
const commandLine = (server) => [server.command].concat(server.args || []).join(" ");

function render(extData) {
  const from = APP.indexOf("function renderMcp()");
  const to = APP.indexOf("function renderSkills");
  assert.ok(from >= 0 && to > from, "renderMcp is still in app.js");
  const body = APP.slice(from, to);
  const list = { innerHTML: "", hidden: false };
  const legend = { innerHTML: "", hidden: false };
  const doc = { getElementById: (id) => (id === "mcp-list" ? list : legend) };
  const make = new Function(
    "document", "extData", "esc", "transportLabel", "commandLine", "AGENT_SHORT",
    body + "\nreturn renderMcp;"
  );
  make(doc, extData, esc, transportLabel, commandLine, AGENT_SHORT)();
  return list.innerHTML;
}

const TOOLS = [
  "get-current-date", "get-stations-code-in-city", "get-station-code-of-citys",
  "get-station-code-by-names", "get-station-by-telecode", "get-tickets",
  "get-interline-tickets", "get-train-route-stations"
];

function data(testState) {
  return {
    servers: [{
      name: "12306-mcp", transport: "stdio", command: "npx", args: ["-y", "12306-mcp"],
      agents: ["claude-desktop", "codex", "zcode"], off: false
    }],
    targets: [
      { agent: "claude-desktop", stdioOnly: false },
      { agent: "codex", stdioOnly: false },
      { agent: "zcode", stdioOnly: false }
    ],
    mcpTest: testState ? { "12306-mcp": testState } : {}
  };
}

const VERDICT = /<div class="mcp-test[^>]*>[\s\S]*?<\/div>/;

test("a test verdict does not change a single character of the row above it", () => {
  // The strongest form of the invariant: removing the verdict from the
  // rendered row must give back exactly the untested row. If the verdict
  // were inline again, the surrounding markup would have to change too.
  const plain = render(data(null));
  const tested = render(data({
    running: false, ok: true,
    phases: ["直接启动失败（cmd 垫片需经 shell），改经 shell 启动"],
    tools: TOOLS
  }));
  const verdict = tested.match(VERDICT);
  assert.ok(verdict, "the verdict is rendered");
  assert.equal(tested.replace(verdict[0], ""), plain);

  // The verdict is a sibling of the three columns, after them — not a
  // child of .mcp-item-main where it would stretch the centred flex row.
  assert.ok(tested.indexOf(verdict[0]) > tested.indexOf('class="mcp-item-actions"'));
  const main = tested.slice(tested.indexOf('class="mcp-item-main"'), tested.indexOf('class="mcp-lamps"'));
  assert.doesNotMatch(main, /mcp-test/);
});

test("every verdict shape is a full-width wrapped row, not an inline block", () => {
  for (const state of [
    { running: true },
    { running: false, ok: true, phases: ["连接成功"], tools: TOOLS },
    { running: false, ok: false, error: "连接失败" }
  ]) {
    const html = render(data(state));
    assert.match(html, VERDICT, JSON.stringify(state));
  }
  // flex-wrap makes room for a second line; flex-basis:100% puts the verdict
  // on it, so the lamps and buttons stay on the first with the title.
  assert.match(CSS, /\.mcp-item\s*\{[^}]*flex-wrap:\s*wrap/);
  const rule = CSS.slice(CSS.indexOf(".mcp-test {"), CSS.indexOf(".mcp-test.running"));
  assert.match(rule, /flex:\s*0 0 100%/);
  // A tool name like get-interline-tickets has no break opportunity: without
  // this it can push the box (and everything after it) out of the panel.
  assert.match(rule, /overflow-wrap:\s*anywhere/);
});
