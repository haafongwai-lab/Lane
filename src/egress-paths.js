/**
 * The request paths the vendored plugins are known to call.
 *
 * The host allowlist answers "which server"; this answers "which door on that
 * server". A plugin that starts posting to a path no upstream uses is the case
 * worth seeing: it is how an exfiltration endpoint would look when it rides a
 * host that is already trusted.
 *
 * Every entry names what the plugin uses it for, so a review can tell a new
 * endpoint from an unexpected one. test/egress.test.js fails when a plugin
 * names a path that is neither here nor matched by a prefix rule.
 */

// Exact paths, as the plugins spell them.
export const KNOWN_PATHS = new Map([
  // ---- Trae CN / Global ----
  ["/trae/api/v2/ug/checkin_credits/status", "daily check-in status"],
  ["/trae/api/v2/ug/checkin_credits/claim", "daily check-in claim"],
  ["/trae/api/v2/pay/ide_user_ent_usage", "credits usage"],
  ["/trae/api/v1/pay/user_current_entitlement_list", "entitlement packs"],
  ["/trae/api/v3/oauth/ExchangeToken", "token exchange"],
  ["/api/agent/v3/llm_utils_chat", "chat completion"],
  ["/api/ide/v1/batch_get_detail_param", "model catalogue (batch)"],
  ["/api/ide/v1/get_detail_param", "model catalogue"],
  ["/cloudide/api/v3/trae/oauth/ExchangeToken", "token exchange"],
  // ---- WorkBuddy ----
  ["/v2/billing/meter/checkin-activity-status", "check-in status"],
  ["/v2/billing/meter/daily-checkin", "check-in claim"],
  ["/v2/billing/meter/get-user-resource-summary", "credits summary"],
  ["/v2/billing/meter/get-user-resource-free-packages", "free credit packs"],
  ["/v2/billing/meter/get-user-resource-paid-packages", "paid credit packs"],
  ["/v2/billing/meter/get-enterprise-user-usage", "enterprise usage"],
  ["/billing/meter/get-enterprise-user-usage", "enterprise usage (bare host)"],
  ["/billing/meter/get-user-resource-free-packages", "free packs (bare host)"],
  ["/billing/meter/get-user-resource-paid-packages", "paid packs (bare host)"],
  ["/billing/meter/get-user-resource-summary", "credits summary (bare host)"],
  ["/v2/plugin/accounts", "account labels"],
  ["/v2/plugin/login/account", "sign-in account lookup"],
  ["/v2/plugin/auth/state", "sign-in state"],
  ["/v2/plugin/auth/token", "token endpoint"],
  ["/v2/plugin/auth/token/refresh", "token refresh"],
  ["/v2/chat/completions", "chat completion on the domestic v2 surface"],
  ["/plugin/accounts", "account labels (bare host)"],
  ["/v3/config", "model catalogue"],
  // ---- Qoder ----
  ["/algo/api/v2/service/pro/sse/agent_chat_generation", "chat completion (SSE)"],
  ["/algo/api/v2/model/list", "model catalogue"],
  ["/algo/api/v1/version", "client version probe"],
  ["/algo/api/v2/service/ask/queue/status", "queue status"],
  ["/sash/api/v2/me/usage", "credits usage"],
  ["/sash/api/v1/me/campaigns", "daily check-in campaigns"],
  ["/api/v1/deviceToken/poll", "device sign-in poll"],
  ["/api/v1/deviceToken/refresh", "device token refresh"],
  ["/api/v1/jobToken/exchange", "PAT for a job token"],
  ["/api/v1/jobToken/refresh", "job token refresh"],
  ["/api/v1/me/jobToken", "job token read"],
  ["/api/v1/userinfo", "account profile"],
  ["/api/v1/adapter/user/wallets", "QwenWork wallets (bundle only)"],
  // ---- OpenAI-shaped loader surface ----
  ["/v1/chat/completions", "chat completion through the plugin loader"],
  ["/v1/models", "model list through the plugin loader"]
]);

// Prefix rules, for the endpoints whose tail is an id or a signed segment.
export const KNOWN_PREFIXES = [
  ["/trae/api/", "Trae API surface"],
  ["/billing/meter/", "WorkBuddy billing meters"],
  ["/v2/billing/", "WorkBuddy billing meters"],
  ["/v2/plugin/", "WorkBuddy plugin sign-in surface"],
  ["/plugin/", "WorkBuddy plugin surface"],
  ["/api/agent/", "Trae agent surface"],
  ["/algo/", "Qoder agent surface"],
  ["/sash/", "Qoder account surface"],
  ["/api/v1/", "Qoder token and account surface"],
  ["/api/ide/", "Trae IDE surface"],
  ["/cloudide/api/", "Trae cloud-IDE sign-in surface"],
  ["/v1/", "OpenAI-shaped loader surface"],
  ["/v2/", "WorkBuddy v2 surface"],
  ["/v3/", "WorkBuddy v3 surface"]
];

// The paths that legitimately carry a conversation. Every other path should
// see only short, structured bodies; a large natural-language payload sent
// somewhere else is the shape of a leak dressed as a normal call.
export const CHAT_PATHS = new Set([
  "/algo/api/v2/service/pro/sse/agent_chat_generation",
  "/api/agent/v3/llm_utils_chat",
  "/v2/chat/completions",
  "/v1/chat/completions"
]);

// A non-chat request body above this many bytes is reported. The real ones are
// small JSON documents (a check-in is `{}`, a usage read is a few hundred
// bytes), so the bound is generous but still far below a prompt.
export const NON_CHAT_BODY_LIMIT = 4096;

/** Classifies a pathname: "known" | "prefix" | "unknown". */
export function classifyPath(pathname) {
  const path = String(pathname || "");
  if (!path) return "unknown";
  if (KNOWN_PATHS.has(path)) return "known";
  if (KNOWN_PREFIXES.some(([prefix]) => path.startsWith(prefix))) return "prefix";
  return "unknown";
}

/**
 * What one outbound request looks like, for the audit trail.
 *
 * `suspicious` is the part a person reads: a body that is too big for a
 * non-chat path, a path nobody expects, or a chat body carrying fields the
 * protocol does not define. None of it blocks anything — this is a record, and
 * the guard's host check is what refuses traffic.
 */
export function inspectRequest({ pathname = "", body = null, method = "GET" } = {}) {
  const verdict = classifyPath(pathname);
  const chat = CHAT_PATHS.has(pathname);
  const text = typeof body === "string" ? body : "";
  const size = text ? Buffer.byteLength(text) : 0;
  const reasons = [];
  if (verdict === "unknown") reasons.push("unknown-path");
  if (!chat && size > NON_CHAT_BODY_LIMIT) reasons.push("large-body-outside-chat");
  if (chat && text) {
    const fields = chatFields(text);
    const extra = fields.filter((field) => !CHAT_FIELDS.has(field));
    if (extra.length) reasons.push(`unexpected-chat-fields:${extra.slice(0, 5).join(",")}`);
  }
  return {
    method: String(method || "GET").toUpperCase(),
    path: pathname,
    pathVerdict: verdict,
    bodySize: size,
    chat,
    suspicious: reasons
  };
}

// The fields a chat completion request is allowed to carry. Anything else is
// how a conversation could be smuggled beside the one being sent.
const CHAT_FIELDS = new Set([
  "model", "messages", "stream", "stream_options", "temperature", "top_p",
  "top_k", "max_tokens", "max_completion_tokens", "stop", "tools",
  "tool_choice", "parallel_tool_calls", "reasoning_effort", "reasoning",
  "response_format", "seed", "presence_penalty", "frequency_penalty",
  "logit_bias", "user", "metadata", "service_tier", "store", "n",
  "modalities", "prediction", "verbosity"
]);

function chatFields(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed)
      : [];
  } catch {
    return [];
  }
}
