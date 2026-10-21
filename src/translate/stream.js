export class SSEDecoder {
  constructor() {
    this.buffer = "";
    this.decoder = new TextDecoder();
  }

  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.take();
  }

  finish() {
    this.buffer += this.decoder.decode();
    const out = this.take();
    if (this.buffer.trim()) {
      const rest = this.buffer;
      this.buffer = "";
      return `${out}${rest}\n`;
    }
    return out;
  }

  take() {
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    return lines.length ? `${lines.join("\n")}\n` : "";
  }
}
