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

export function parseSSEData(text) {
  const events = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.startsWith("data:")) continue;
    const data = raw.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {}
  }
  return events;
}
