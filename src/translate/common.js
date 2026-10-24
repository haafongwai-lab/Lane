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
export function parseSSEData(text) {
  const events = [];
  let data = null;
  const flush = () => {
    if (data == null) return;
    const payload = data;
    data = null;
    if (!payload || payload === "[DONE]") return;
    try {
      events.push(JSON.parse(payload));
    } catch {}
  };
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.startsWith(":")) continue;
    if (raw.startsWith("data:")) {
      const line = raw.slice(5).replace(/^ /, "");
      data = data == null ? line : `${data}\n${line}`;
      continue;
    }
    if (!raw.trim()) flush();
  }
  flush();
  return events;
}
