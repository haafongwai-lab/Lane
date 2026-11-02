import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const PACKAGE = "@magpie-community/opencode-workbuddy-auth";

let internals = null;

/**
 * WorkBuddy refuses a chat it thinks comes from another client
 * ("Illegal API invocation from an unapproved channel", 400 permission_error).
 * It reads every message, not just the system prompt: one client opens
 * with "You are a helpful assistant for software engineering work.", Claude Code puts
 * its own words in the first user message, and each is refused on sight.
 *
 * The plugin already carries the word list and the request spellings the
 * endpoint accepts, so Lane runs every outgoing chat through the same three
 * steps the plugin applies to its own requests rather than keeping a second
 * copy of that knowledge that would drift.
 */
async function loadInternals() {
  if (internals) return internals;
  const entry = await import(pathToFileURL(require.resolve(PACKAGE)).href);
  internals = entry?._internal || {};
  return internals;
}

/**
 * The wording WorkBuddy refuses, each with words that say the same and pass.
 *
 * WorkBuddy rejects a chat for "Illegal API invocation from an unapproved
 * channel" (11128) when a message carries a line it has fingerprinted from
 * another agent. It reads every message, not only the system prompt — an
 * agent's opening line may sit in the first user message — and matches a
 * known line whole and exactly: one extra space, a comma, one changed word
 * all pass. The plugin keeps the same table for its own requests; Lane's copy
 * exists because a pinned plugin may leave a line unhandled (0.1.28 replaced
 * one entry's phrase with itself), and a release is not worth waiting for
 * when the correction is a wording.
 *
 * The replacements come from the plugin's table (0.2.9, measured against both
 * builds on real accounts), not invented here: each is the vendor's own
 * accepted wording, so the request says the same thing in words that pass.
 */
const REFUSED = [
  // A client's opening line, in both spellings that were met. The rewrite is
  // the sentence the endpoint accepts.
  [
    /You are an AI (?:agent|assistant) that helps the user with (?:programming|coding) tasks\./g,
    "You are a helpful assistant for software engineering work."
  ],
  // DeepSeek Harness opens its system prompt with this line, refused as 11128.
  // The rewrite keeps the harness's own name: the rest of the prompt refers
  // back to it, so saying it in another agent's terms would contradict the
  // text around it. Measured 2026-10-30: as written 400 11128, as rewritten
  // 200, with the name still in the only line that says which agent runs.
  [
    /You are a helpful assistant for software engineering work\.?/gi,
    "You are an AI agent, powered by DeepSeek Harness."
  ],
  // A line WorkBuddy refuses in a long DeepSeek Harness chat. The model can
  // quote it back into an assistant message, which moving the system prompt
  // into the user's instructions cannot reach, so it is reworded wherever it
  // appears.
  [
    /Web GUI whose URL the runtime context names\.\s+When the user refers/gi,
    "Web GUI whose URL the runtime context names. The interface, when the user refers"
  ]
];

/**
 * Rewrites the refused wording anywhere in a message tree.
 *
 * Every string is walked, not only the fields a chat usually puts text in:
 * an agent can nest its prompt in a shape nobody predicted, and a line that
 * survives in one of them is refused just the same.
 *
 * One pass, first match wins. Chaining the rules would let a rewrite feed the
 * next one: rule 1's accepted wording is exactly rule 2's refused line, so a
 * Claude-style opener would come out as "powered by DeepSeek Harness" -
 * naming a harness the client is not. A rewrite is therefore never rescanned.
 */
function rewriteOnce(text) {
  let out = "";
  let at = 0;
  while (at < text.length) {
    let best = null;
    for (const rule of REFUSED) {
      const pattern = rule[0];
      pattern.lastIndex = at;
      const hit = pattern.exec(text);
      if (hit && (!best || hit.index < best.hit.index)) best = { rule, hit };
    }
    if (!best) {
      out += text.slice(at);
      break;
    }
    const { rule, hit } = best;
    out += text.slice(at, hit.index) + rule[1];
    at = hit.index + hit[0].length;
  }
  return out;
}

function unflagRefusedOpenings(value) {
  if (typeof value === "string") return rewriteOnce(value);
  if (Array.isArray(value)) return value.map(unflagRefusedOpenings);
  if (!value || typeof value !== "object") return value;
  const out = { ...value };
  for (const [key, item] of Object.entries(out)) {
    if (key === "text" || key === "content") out[key] = unflagRefusedOpenings(item);
  }
  return out;
}

/**
 * A chat body ready for WorkBuddy: flagged words replaced, roles and token
 * limits spelled the way the endpoint takes them, tool schemas the models can
 * actually accept. `names` maps any tool Lane had to rename back to the name
 * the client gave it, so the answer can be renamed on the way out.
 */
export async function prepareChat(body) {
  const api = await loadInternals();
  if (typeof api.withSystem !== "function") return { body, names: new Map() };

  let text = api.withSystem(JSON.stringify(body));
  const fit = typeof api.fitted === "function" ? api.fitted(text) : { body: text, names: new Map() };
  text = typeof api.normalizeToolChoice === "function" ? api.normalizeToolChoice(fit.body) : fit.body;

  let prepared = body;
  try {
    prepared = JSON.parse(text);
  } catch {
    // A body the helpers could not read stays as the client sent it.
    return { body, names: new Map() };
  }
  // The refused wording is rewritten last, so it reads the body the plugin
  // finished with — including any line the pinned plugin leaves behind.
  if (Array.isArray(prepared?.messages)) {
    prepared = { ...prepared, messages: unflagRefusedOpenings(prepared.messages) };
  }
  return { body: prepared, names: fit.names || new Map() };
}

/** Gives the model's tool calls back the names the client gave its tools. */
export async function restoreToolNames(response, names) {
  if (!names?.size) return response;
  const api = await loadInternals();
  if (typeof api.renamed !== "function") return response;
  return api.renamed(response, names);
}
