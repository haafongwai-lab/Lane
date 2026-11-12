import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How a multi-round question is billed and how it ends.
 *
 * The context is re-sent every round, so summing each round's `total_tokens`
 * billed the same prompt again and again: one real question measured 49922
 * against a 32000 budget while the new content was only ~26877, so the loop
 * stopped a round early with nothing to show. Three fixes are pinned here:
 *
 *   the budget counts only what a round ADDED (input delta + output)
 *   the last non-empty text survives a round that only asked for a tool
 *   every budget ends with one tool-less round, so the model answers from the
 *   results it already has instead of the panel showing "no text"
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(HERE, "..", "desktop", "main.js"), "utf8");
const APP = fs.readFileSync(path.join(HERE, "..", "desktop", "app.js"), "utf8");

test("the token budget counts growth, not each round's re-sent context", () => {
  // The delta is taken against the previous round's prompt size.
  assert.match(MAIN, /const added = Math\.max\(0, input - prevInput\)/);
  assert.match(MAIN, /prevInput = input/);
  assert.match(MAIN, /return added \+ \(Number\.isFinite\(output\) \? output : roughTokens\(said\)\)/);
  assert.match(MAIN, /totalTokens \+= growth\(out\.usage, out\.text\)/);
  // The old, double-counting line is gone.
  assert.equal(
    /totalTokens \+= out\.usage\?\.total_tokens != null \? Number\(out\.usage\.total_tokens\)/.test(MAIN),
    false,
    "each round's full total is no longer summed"
  );
});

test("a round that only asks for a tool does not erase what was already said", () => {
  assert.match(MAIN, /if \(out\.text\) text = out\.text;/);
  assert.equal(/^\s*text = out\.text;$/m.test(MAIN), false, "the unconditional overwrite is gone");
});

test("every budget ends with one tool-less wrap-up round", () => {
  assert.match(MAIN, /if \(!stop\) stop = "rounds";/);
  // The wrap-up offers no tools, so the model must answer in words.
  assert.match(MAIN, /const response = await send\(true, \{ messages: convo \}\)/);
  assert.match(MAIN, /if \(final\.text\) text = final\.text;/);
  // A failed wrap-up must not throw away the text already gathered.
  assert.match(MAIN, /The wrap-up is a courtesy/);
});

test("the panel says an answer was produced from what was already found", () => {
  assert.match(APP, /const wrapped = final \? "，已用已查到的结果作答" : ""/);
  for (const kind of ["rounds", "tokens", "time"]) {
    assert.ok(
      APP.includes(`result.stopped === "${kind}"`) && APP.includes("${wrapped}"),
      `${kind} stop names the wrap-up`
    );
  }
});
