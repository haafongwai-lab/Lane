export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function dataURLOf(source) {
  if (!source || typeof source !== "object") return "";
  if (source.type === "base64" && source.data) {
    return `data:${source.media_type || "application/octet-stream"};base64,${source.data}`;
  }
  if (source.type === "url" && source.url) return source.url;
  return "";
}

export function contentParts(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

export function sseData(event) {
  return `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
}

// SSE frames one event per blank line, and consecutive data: lines of the
// same event concatenate with a newline — a payload wrapped across two
// data: lines is one JSON document, not two broken ones. Comments ("data"
// lines excluded, ": ping") and the [DONE] sentinel carry no payload.
//
// A data: line that is not JSON used to be swallowed here, which turned an
// upstream failure into a successful-looking answer with nothing in it —
// every protocol path downstream then assembles an empty message and
// reports complete. A payload the upstream did send but Lane cannot read
// is an upstream failure, raised as one (502-shaped, so the callers'
// existing error paths surface it). The cap bounds what a broken upstream
// can make Lane buffer for one event.
const MAX_SSE_PAYLOAD = 64 * 1024 * 1024;

export function parseSSEData(text) {
  const events = [];
  let data = null;
  const flush = () => {
    if (data == null) return;
    const payload = data;
    data = null;
    if (!payload || payload === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw Object.assign(
        new Error(`upstream sent a non-JSON SSE payload: ${payload.slice(0, 120)}`),
        { status: 502 }
      );
    }
    events.push(parsed);
  };
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.startsWith(":")) continue;
    if (raw.startsWith("data:")) {
      const line = raw.slice(5).replace(/^ /, "");
      data = data == null ? line : `${data}\n${line}`;
      if (data.length > MAX_SSE_PAYLOAD) {
        throw Object.assign(new Error("upstream SSE payload exceeds the size limit"), { status: 502 });
      }
      continue;
    }
    if (!raw.trim()) flush();
  }
  flush();
  return events;
}
