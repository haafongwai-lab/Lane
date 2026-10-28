/**
 * Splits a byte stream into whole SSE lines, holding back the incomplete tail
 * until more arrives.
 *
 * The buffer is bounded. `take()` only ever emits complete lines, so a
 * single line that never ends — an upstream stuck mid-write, a proxy feeding
 * garbage — would otherwise grow the buffer for as long as the stream lasts.
 * A probe pushed 40 MB with no newline and the heap grew by 155 MB: nothing
 * stopped it, and parseSSEData's own size guard could not help because it
 * only ever sees a finished payload. The cap is generous enough for any real
 * event (a whole chat completion is kilobytes) and turns the pathological
 * case into the same 502 an unreadable payload produces.
 */
const MAX_BUFFER_CHARS = 8 * 1024 * 1024;

export class SSEDecoder {
  constructor(limit = MAX_BUFFER_CHARS) {
    this.buffer = "";
    this.decoder = new TextDecoder();
    this.limit = limit;
  }

  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.guard();
    return this.take();
  }

  finish() {
    this.buffer += this.decoder.decode();
    this.guard();
    const out = this.take();
    if (this.buffer.trim()) {
      const rest = this.buffer;
      this.buffer = "";
      return `${out}${rest}\n`;
    }
    return out;
  }

  guard() {
    if (this.buffer.length <= this.limit) return;
    // A payload this large is not an event any client can use, and holding it
    // is what turns a broken upstream into a memory leak.
    throw Object.assign(
      new Error(`upstream sent an event longer than ${Math.round(this.limit / 1024 / 1024)} MB`),
      { status: 502, kind: "upstream-unreadable" }
    );
  }

  take() {
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    return lines.length ? `${lines.join("\n")}\n` : "";
  }
}
