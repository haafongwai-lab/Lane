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
 * WorkBuddy refuses a chat whose system prompt opens with a client's own
 * own line ("You are an AI agent that helps the user with programming
 * tasks.") as 11128. The plugin's list of refused wording is meant to rewrite
 * it, but in 0.1.28 that entry replaces the phrase with itself — its pattern
 * also lets the final "." match any character, so the replacement never
 * differs from the text it matched. Lane therefore closes the gap itself
 * instead of waiting for a plugin release: the sentence is reworded to the
 * same request, which the endpoint accepts.
 *
 * A plugin version that does change the text wins: this only rewrites the
 * exact sentence the plugin leaves behind.
 */
/**
 * A client's opening line comes in more than one wording, and the plugin's
 * rule for it replaces the phrase with itself. Both spellings are refused just
 * the same, so both are rewritten here.
 *
 * The rewritten wording has to differ from what WorkBuddy refuses: this is
 * the sentence a request is rejected for, not a fixed pattern to echo back.
 */
const REFUSED_OPENINGS = [
  /You are an AI (?:agent|assistant) that helps the user with (?:programming|coding) tasks\./g
];
const REFUSED_REWRITE = "You are a helpful assistant for software engineering work.";

function unflagRefusedOpenings(value) {
  if (typeof value === "string") {
    return REFUSED_OPENINGS.reduce((text, pattern) => text.replace(pattern, REFUSED_REWRITE), value);
  }
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
  // The wording the plugin leaves in place (see REFUSED_OPENINGS) is rewritten
  // last, so it reads the body the plugin finished with.
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
