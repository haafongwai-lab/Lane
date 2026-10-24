import path from "node:path";

/**
 * Which project (working directory) a request belongs to.
 *
 * The usage page answers "how much context did this conversation carry" and
 * "how much of it came from cache" — both only mean something per project:
 * one long-running repository and a one-shot question are not comparable, and
 * averaging them hides which of the two is filling the window.
 *
 * No client has a "project" field; each names its working directory
 * somewhere else in the request, so the place is read from where that client
 * actually puts it:
 *
 *   Codex          x-codex-turn-metadata → workspaces (a path → state map),
 *                  else the <environment_context><cwd> item it sends as input
 *   Claude Code    "Primary working directory: <path>" in its Environment block
 *   others         no signal — the request is grouped under its agent
 *
 * A name that cannot be read is not guessed: the row keeps an empty project
 * and the page shows it as unattributed rather than inventing a bucket.
 */

// The Environment block a Claude-shaped client prepends, when it prepends one.
const WORKING_DIRECTORY = /(?:^|\n)\s*[-*]?\s*Primary working directory:\s*([^\r\n]+)/i;
// Codex's environment item.
const ENV_CWD = /<cwd>\s*([^<]+?)\s*<\/cwd>/i;
const WORKSPACE_ROOT = /<workspace_roots>\s*<root>\s*([^<]+?)\s*<\/root>/i;

// Only the head of a body is searched: the Environment block and the
// environment item are both written before the conversation, and a 500 KB
// chat must not be regex-scanned on the request's critical path.
const HEAD_CHARS = 200_000;

export function projectOf(body, headers = {}) {
  const fromHeader = projectFromHeaders(headers);
  if (fromHeader) return fromHeader;
  const text = bodyText(body);
  if (!text) return null;
  const match = ENV_CWD.exec(text) || WORKSPACE_ROOT.exec(text) || WORKING_DIRECTORY.exec(text);
  return match ? projectFromRoot(match[1]) : null;
}

function projectFromHeaders(headers = {}) {
  const raw = headers["x-codex-turn-metadata"];
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw);
    const roots = Object.keys(meta?.workspaces || {});
    if (roots.length) return projectFromRoot(roots[0]);
  } catch {}
  return null;
}

// The body as searchable text: its system prompt and the first messages, in
// every shape the three protocols use for them.
function bodyText(body) {
  if (!body || typeof body !== "object") return "";
  const parts = [];
  const push = (value) => {
    if (parts.length > 8) return;
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(push);
    else if (value && typeof value === "object") push(value.text);
  };
  if (typeof body.system === "string") parts.push(body.system);
  else if (Array.isArray(body.system)) body.system.forEach((part) => push(part?.text));
  if (typeof body.instructions === "string") parts.push(body.instructions);
  // Codex puts its environment item inside `input`; Anthropic clients put the
  // Environment block in the first user message. Both are near the front.
  const list = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages) ? body.messages : [];
  for (const item of list.slice(0, 4)) {
    if (typeof item === "string") parts.push(item);
    else push(item?.content);
  }
  return parts.join("\n").slice(0, HEAD_CHARS);
}

/**
 * A root path as one project: the same directory spelled with either
 * separator, a different drive-letter case, or a trailing slash is one
 * project, not three.
 */
export function projectFromRoot(root) {
  const raw = String(root || "").trim().replace(/^["']|["']$/g, "");
  if (!raw) return null;
  // Windows paths are case-insensitive, and the same directory arrives
  // lowercase from one client and mixed-case from another; the identifier is
  // folded so the buckets hold. The display name keeps what was sent.
  const unified = raw.replace(/\//g, "\\").replace(/\\+$/, "");
  const id = unified.toLowerCase().replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
  return { id, name: projectName(unified), root: id };
}

// The last path segment, so a project reads as "lane" rather than as the
// whole home directory it happens to live under.
function projectName(id) {
  const base = path.win32.basename(id);
  return base || id;
}
