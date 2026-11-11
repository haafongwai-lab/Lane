import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The route card's client node grows with its marks. It used to hold a fixed
 * 166px floor and the canvas clipped whatever passed it, so with five clients
 * the "等待请求" line and the state row were cut off. The canvas also has to
 * grow: it keeps `overflow: hidden` to clip the dotted grid, which would cut
 * the node's own content just the same.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CSS = fs.readFileSync(path.join(ROOT, "desktop/styles.css"), "utf8");

test("the client node is a floor, not a fixed height", () => {
  const rule = CSS.slice(CSS.indexOf(".route-node {"), CSS.indexOf(".route-node strong"));
  assert.match(rule, /min-height:/, "the node has a minimum");
  assert.doesNotMatch(rule, /^\s*height:/m, "but no fixed height that would clip its content");
});

test("the canvas grows with the node instead of clipping it", () => {
  const rule = CSS.slice(CSS.indexOf(".route-canvas {"), CSS.indexOf(".canvas-grid {"));
  assert.match(rule, /min-height:/, "the canvas has a floor");
  assert.doesNotMatch(rule, /^\s*height:/m, "and no fixed height");
  assert.match(rule, /overflow: hidden/, "it still clips the dotted grid");
});

test("five marks fit one row at every breakpoint", () => {
  // 5 marks of 40px with 8px gaps is 232px; the narrowest client node has to
  // hold that, or the fifth wraps to a line of its own.
  const mark = CSS.slice(CSS.indexOf(".agent-mark {"), CSS.indexOf(".agent-mark span"));
  assert.match(mark, /width: 40px/);
  const logos = CSS.slice(CSS.indexOf(".agent-logos {"), CSS.indexOf(".agent-logos .node-logo"));
  assert.match(logos, /gap: 8px 8px/);
  // The lane square at the narrow breakpoint leaves the side columns enough
  // room for that row. The media blocks are not in source order, so the
  // value is read from the whole sheet rather than from a slice between two
  // breakpoints.
  assert.match(CSS, /@media \(max-width: 1150px\)[\s\S]{0,400}--lane-size: 168px/);
});

test("the DSH mark carries no extra bottom margin inside a row", () => {
  // A per-mark margin made one label sit higher than its neighbours once the
  // marks were laid out in a single row.
  assert.doesNotMatch(CSS, /\.route-canvas \.dsh-logo img \{[^}]*margin-bottom: [1-9]/);
});
