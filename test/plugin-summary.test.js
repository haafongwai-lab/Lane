import test from "node:test";
import assert from "node:assert/strict";
import {
  exportsInSource,
  versionConstantsInSource,
  sizeOfSource,
  diffSets
} from "../src/plugin-source.js";

/**
 * The change summary a plugin update shows.
 *
 * The vendor ships no changelog — the published tarball holds only
 * index.mjs, the entry files and a README with no release history — so "what
 * changed" is read from the two copies of the source. These pin the pieces
 * that summary is built from.
 */

const BEFORE = `
export const TraeCNAuthPlugin = makePlugin(SITES.cn)
export const TraeGlobalAuthPlugin = makePlugin(SITES.global)
const SITE = { clientVersion: "0.1.68", ideVersion: "3.3.60", pluginVersion: "2.3.1" }
// a trailing comment
`;

const AFTER = `
export const TraeCNAuthPlugin = makePlugin(SITES.cn)
export const TraeGlobalAuthPlugin = makePlugin(SITES.global)
export const TraeEnterpriseAuthPlugin = makePlugin(SITES.ent)
const SITE = { clientVersion: "0.1.69", ideVersion: "3.3.60", pluginVersion: "2.3.2" }
// a trailing comment, and one more line
`;

test("a new factory export is what a summary reports as a new access point", () => {
  const d = diffSets(exportsInSource(BEFORE), exportsInSource(AFTER));
  assert.deepEqual(d.added, ["TraeEnterpriseAuthPlugin"]);
  assert.deepEqual(d.removed, []);
});

test("the protocol version pins a plugin declares are read", () => {
  const pins = versionConstantsInSource(AFTER);
  assert.equal(pins.clientVersion, "0.1.69");
  assert.equal(pins.ideVersion, "3.3.60");
  assert.equal(pins.pluginVersion, "2.3.2");
});

test("the size delta makes an otherwise-silent upgrade visible", () => {
  const from = sizeOfSource(BEFORE);
  const to = sizeOfSource(AFTER);
  assert.ok(from.lines > 0 && to.lines > from.lines, "the added export is one more line");
  assert.ok(to.bytes > from.bytes);
});

test("a numeric-only or unquoted pin is not mistaken for a version", () => {
  const src = "const x = { clientVersion: 3, ideVersion: someVar }";
  const pins = versionConstantsInSource(src);
  assert.equal(pins.clientVersion, undefined, "only quoted version strings count");
  assert.equal(pins.ideVersion, undefined);
});
