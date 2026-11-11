import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The route canvas's agent marks. Claude's asterisk is transparent artwork,
 * so it must not sit on a white circle; Codex's white rounded-square plate
 * was removed so it reads as a bare mark like the others. Both are pinned
 * here because a white plate is easy to reintroduce in a later theme pass.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, "..", "desktop", "styles.css"), "utf8");
const SVG = fs.readFileSync(path.join(HERE, "..", "desktop", "assets", "codex-official.svg"), "utf8");

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

test("the route canvas's Codex mark is a bare transparent mark", () => {
  const codex = rule(".codex-logo");
  assert.match(codex, /background:\s*transparent/);
  // No rounded-square clip: the white tile it was shaped around is gone, and
  // clipping the bare mark would just round off its own transparent corners.
  assert.doesNotMatch(codex, /border-radius/);
  // The generic .node-logo circle must not win over this more specific rule.
  assert.ok(CSS.indexOf(".codex-logo {") > CSS.indexOf(".node-logo {"));
});

test("the Codex asset has no white rounded-square plate", () => {
  // The old plate was a full-canvas rounded rect drawn before the mark. With
  // it gone, there is exactly one path and no opaque white fill anywhere.
  assert.equal((SVG.match(/<path\b/g) || []).length, 1, "only the mark's path remains");
  assert.doesNotMatch(SVG, /fill="#fff(?:fff)?"/, "no white fill in the asset");
  assert.doesNotMatch(SVG, /<rect\b/, "no background rect in the asset");
});
