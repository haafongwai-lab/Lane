import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { credits, rmb } from "../desktop/format.js";

/**
 * The daily spend chart: a full-width smooth area instead of the old centred
 * bars that left most of the card blank. These drive the real renderer with
 * fixed series and pin the shape, the thinning of x labels, and the
 * single-day fallback.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(HERE, "..", "desktop", "app.js"), "utf8");
const CSS = fs.readFileSync(path.join(HERE, "..", "desktop", "styles.css"), "utf8");

const from = APP.indexOf("function niceCeil(");
const to = APP.indexOf("// The international Free plan", from);
const body = APP.slice(from, to);
const esc = (v) => String(v ?? "");
const make = (fnName) => new Function("$", "credits", "rmb", "esc", body + `\nreturn ${fnName};`)(
  null, credits, rmb, esc
);
const niceCeil = new Function(body + "\nreturn niceCeil;")();
const trendPath = new Function(body + "\nreturn trendPath;")();

const day = (d, c, r) => ({ date: `2026-11-${String(d).padStart(2, "0")}`, credits: c, requests: r });

function render(series) {
  const node = { innerHTML: "" };
  new Function("$", "credits", "rmb", "esc", body + "\nreturn renderUsageChart;")(
    () => node, credits, rmb, esc
  )(series);
  return node.innerHTML;
}

test("the scale rounds up to a tight, readable ceiling", () => {
  assert.equal(niceCeil(337.8), 400);
  assert.equal(niceCeil(120), 150);
  assert.equal(niceCeil(0), 1);
  assert.equal(niceCeil(-5), 1);
});

test("the curve touches every point without overshooting it", () => {
  const points = [{ x: 0, y: 100 }, { x: 10, y: 40 }, { x: 20, y: 80 }, { x: 30, y: 10 }];
  const d = trendPath(points);
  assert.match(d, /^M0\.00,100\.00/);
  assert.equal((d.match(/ C/g) || []).length, 3, "one cubic per segment");
  // Every segment's control points stay within the two endpoint values, so a
  // smooth curve can never invent a negative dip or a peak between days.
  const numbers = d.match(/-?\d+\.\d+/g).map(Number);
  assert.ok(numbers.every((value) => value >= 0 && value <= 100));
});

test("a week is drawn as one full-width area with a dot per spending day", () => {
  const series = [day(1, 128.4, 12), day(2, 86.2, 9), day(3, 0, 0), day(4, 242.8, 21), day(5, 164.5, 15), day(6, 58.3, 6), day(7, 301.6, 26)];
  const html = render(series);
  assert.match(html, /class="usage-trend"/);
  assert.match(html, /class="trend-line"/);
  assert.match(html, /class="trend-area"/);
  assert.equal((html.match(/class="usage-day"/g) || []).length, 7, "one hover column per day");
  assert.equal((html.match(/class="trend-dot"/g) || []).length, 6, "dots only on days that spent");
  assert.match(html, /class="trend-peak"[^>]*>301\.6</);
  assert.doesNotMatch(html, /usage-bars|usage-bar-track/, "the old bar markup is gone");
  // Every hover card has the full daily detail.
  assert.equal((html.match(/data-tip="/g) || []).length, 7);
  assert.match(html, /积分 301\.6/);
});

test("a 15-day range thins its x labels instead of crowding them", () => {
  const series = Array.from({ length: 15 }, (_, i) => day(i + 1, 10 + i, 1));
  const html = render(series);
  const labels = (html.match(/class="trend-axis trend-x"/g) || []).length;
  assert.ok(labels >= 5 && labels <= 8, `expected 5-8 x labels, got ${labels}`);
});

test("a single day becomes one centred column, not a broken line", () => {
  const html = render([day(7, 301.6, 26)]);
  assert.match(html, /class="trend-single"/);
  assert.doesNotMatch(html, /class="trend-line"/);
  assert.equal((html.match(/class="trend-dot"/g) || []).length, 1);
});

test("the chart styles own the width and animate without moving the layout", () => {
  assert.match(CSS, /\.usage-trend svg \{[^}]*width: 100%/);
  assert.match(CSS, /\.trend-line \{[^}]*stroke-dasharray: 1/);
  assert.match(CSS, /@keyframes trend-draw/);
  assert.match(CSS, /prefers-reduced-motion: reduce[\s\S]{0,160}trend-line/);
});
