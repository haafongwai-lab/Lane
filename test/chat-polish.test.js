import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Two small polish fixes on the 问答 page.
 *
 * The fine-print line under the composer is gone: it repeated what the page
 * already shows and read as clutter under a control the user is looking at.
 *
 * And the scrollbar no longer flashes away on entry. The chat view is exactly
 * one viewport tall, so the page stopped overflowing, the scrollbar vanished,
 * and every element shifted sideways by its width — a visible jolt. Reserving
 * the gutter keeps that width whether or not a bar is drawn.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const HTML = read("desktop/index.html");
const CSS = read("desktop/styles.css");

test("the fine print under the composer is gone", () => {
  assert.equal(/chat-note/.test(HTML), false, "no note in the markup");
  assert.equal(/一次只发一条/.test(HTML), false, "and none of its copy");
  assert.equal(/\.chat-note \{/.test(CSS), false, "nor an orphan rule");
});

test("the scrollbar gutter is reserved so entering 问答 cannot shift the page", () => {
  // No gutter to reserve any more: the window itself never scrolls, so there
  // is no page scrollbar to appear and shift the layout. The card carries its
  // own scrollbar inside its edge.
  assert.match(CSS, /html \{ scrollbar-gutter: auto; \}/);
});
