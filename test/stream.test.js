import test from "node:test";
import assert from "node:assert/strict";
import { SSEDecoder } from "../src/translate/stream.js";

/**
 * take() only ever emits complete lines, so a single line that never ends
 * grows the buffer for as long as the stream lasts. A probe pushed 40 MB with
 * no newline and the heap grew 155 MB — parseSSEData's own guard could not
 * catch it, because that only sees a finished payload.
 */

test("a line that never ends is refused instead of buffered forever", () => {
  const decoder = new SSEDecoder(64 * 1024);
  const chunk = new TextEncoder().encode(`data: ${"x".repeat(8 * 1024)}`);
  let pushed = 0;
  assert.throws(() => {
    for (let i = 0; i < 100; i++) {
      decoder.push(chunk);
      pushed += chunk.length;
    }
  }, (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.kind, "upstream-unreadable");
    assert.match(error.message, /longer than/);
    // It fired near the cap, not after the whole input.
    assert.ok(pushed < 100 * chunk.length, `pushed ${pushed}`);
    return true;
  });
});

test("the cap does not touch a normal stream, even split mid-line", () => {
  const decoder = new SSEDecoder();
  const wire = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n\n';
  let out = "";
  // One byte at a time: the hardest case for a line splitter.
  for (const byte of new TextEncoder().encode(wire)) {
    out += decoder.push(new Uint8Array([byte]));
  }
  out += decoder.finish();
  const payloads = out.split("\n").filter(Boolean).map((line) => line.replace(/^data: /, ""));
  assert.deepEqual(payloads, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("an unterminated tail is flushed on finish", () => {
  const decoder = new SSEDecoder();
  const out = decoder.push(new TextEncoder().encode('data: {"a":1}\n\ndata: {"b":2}'));
  const tail = decoder.finish();
  assert.match(out, /"a":1/);
  assert.match(tail, /"b":2/);
  assert.equal(decoder.buffer, "", "the buffer is empty afterwards");
});

test("a multi-byte character split across chunks survives", () => {
  const decoder = new SSEDecoder();
  const wire = 'data: {"t":"汉字"}\n\n';
  const bytes = new TextEncoder().encode(wire);
  let out = "";
  for (const byte of bytes) out += decoder.push(new Uint8Array([byte]));
  out += decoder.finish();
  assert.match(out, /汉字/);
});
