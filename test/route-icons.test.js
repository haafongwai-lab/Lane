import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The route canvas's four agent marks. Claude's asterisk is transparent
 * artwork, so it must not sit on a white circle; Codex ships its own rounded
 * square and must not be clipped into a puck. Both are pinned here because
 * the two rules are easy to lose in a later theme pass.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, "..", "desktop", "styles.css"), "utf8");

function rule(selector) {
  const from = CSS.indexOf(`${selector} {`);
  assert.ok(from >= 0, `${selector} exists`);
  return CSS.slice(from, CSS.indexOf("}", from));
}

test("the route canvas's Claude mark has no white plate", () => {
  const claude = rule(".claude-logo");
  assert.match(claude, /background:\s*transparent/);
  assert.doesNotMatch(claude, /#fff|#ffffff|var\(--logo-plate\)/);
});

test("the route canvas's Codex mark keeps a rounded square", () => {
  const codex = rule(".codex-logo");
  assert.match(codex, /border-radius:\s*10px/);
  assert.match(codex, /background:\s*transparent/);
  // The generic .node-logo circle must not win over this more specific rule.
  assert.ok(CSS.indexOf(".codex-logo {") > CSS.indexOf(".node-logo {"));
});
