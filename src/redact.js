import { randomBytes } from "node:crypto";

/**
 * Reversible redaction for text Lane sends upstream.
 *
 * A secret is replaced with an opaque, typed placeholder such as
 * `{{secret:api_key:7f3a91c2}}`. The mapping lives only in this process's
 * memory: the cloud model sees the placeholder, and a response (including a
 * streaming one) is rewritten back before the client sees it. If Lane
 * restarts, old placeholders are left untouched — the raw value is never
 * recoverable from disk because it was never written there.
 *
 * Detection is conservative and individually configurable: known credential
 * shapes and key=value assignments are caught by default; emails, phones,
 * ID cards, bank cards and addresses are PII rules that can be switched off.
 * Users can also provide literal allow-list entries and custom sensitive terms.
 *
 * The line-local rules run through a windowed, span-collecting scan (see
 * `scanSpans`) whose cost is linear in the text length: every quantifier in
 * those patterns is bounded, so no crafted input can drive the matcher into
 * quadratic backtracking on the chat path.
 */

const PLACEHOLDER = /\{\{secret:([a-z_]+):([0-9a-f]{8})\}\}/g;
const LOG_MASK = "«redacted»";

/** The public rule vocabulary used by settings.json and the settings page. */
export const DEFAULT_RULES = {
  apiKey: true,
  password: true,
  bearer: true,
  jwt: true,
  privateKey: true,
  email: true,
  phone: true,
  idCard: true,
  bankCard: true,
  address: true,
  authHeader: true,
  cookie: true,
  queryToken: true
};

export const RULE_GROUPS = {
  credential: ["apiKey", "password", "bearer", "jwt", "privateKey", "authHeader", "cookie", "queryToken"],
  personal: ["email", "phone", "idCard", "bankCard", "address"]
};

export function resolveRules(rules = {}, { secrets = true, personal = true } = {}) {
  const out = { ...DEFAULT_RULES };
  for (const key of Object.keys(DEFAULT_RULES)) {
    if (typeof rules?.[key] === "boolean") out[key] = rules[key];
  }
  if (!secrets) for (const key of RULE_GROUPS.credential) out[key] = false;
  if (!personal) for (const key of RULE_GROUPS.personal) out[key] = false;
  return out;
}

function validChineseId(value) {
  const text = String(value).toUpperCase();
  if (!/^\d{17}[\dX]$/.test(text)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = "10X98765432";
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(text[i]) * weights[i];
  return checks[sum % 11] === text[17];
}

function validBankCard(value) {
  const digits = String(value).replace(/[ -]/g, "");
  if (!/^\d{16,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

// ---- patterns --------------------------------------------------------------
//
// Every quantifier is bounded. An unbounded class inside a global regex
// rescans the whole run once per start position when the tail of the pattern
// fails to match, which turns a long crafted prompt into quadratic work on
// the request path. The caps are far above any real value (a JWT tops out
// around 2 KB, a URL credential at a couple hundred characters), so they
// cost nothing honest and starve the pathological case.

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/-]{20,2048}={0,2})/gi;
// `token` and the session spellings are assignments too — a bare `token=…`
// was exactly the blind spot; `code`/`auth`/`sig` stay query-only because as
// prose keys they would mask status codes and ordinary words.
const ASSIGNMENT = /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|id[_-]?token|refresh[_-]?token|session[_-]?id|sessionid|sid|token)\b(\s*[:=]\s*)(["']?)([^\s"'`,;&#)]{4,2048})\3/gi;
const KEYED_ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_]*(?:API_KEY|APIKEY|SECRET_KEY|SECRET|ACCESS_KEY|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|client[_-]?secret|password|passwd|pwd))\b(\s*[:=]\s*)(["']?)([^\s"'`,;&#)]{4,2048})\3/gi;
const CN_ASSIGNMENT = /(密码|口令|密钥|令牌)(\s*[：:=]\s*)(["']?)([^\s"'`,;&#)]{4,2048})\3/g;
const CONNECTION = /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s/@]{1,256}:)([^@\s/]{1,256})(@)/g;
// `Authorization:` with a scheme word (Basic, Digest, …) or a long unlabelled
// credential value. Short bare words after the header name stay untouched, so
// "authorization: required" in prose is not masked.
const AUTH_HEADER = /(\bauthorization\b(\s*[:=]\s*)(["']?))((?:basic|bearer|digest|token|apikey|hmac|negotiate|ntlm)\s+[A-Za-z0-9._~+/=-]{6,2048}|[A-Za-z0-9._~+/=-]{24,2048})\3/gi;
// The whole header value up to the end of the line: cookie pairs come in
// chains, and masking only the first pair would leave the rest in the clear.
const COOKIE_HEADER = /\b((?:set-)?cookie)\b(\s*[:=]\s*)(["']?)([^\r\n]{4,4096})/gi;
// Query-string credentials: OAuth `?code=`, signed URLs, `?token=` shapes the
// assignment rules cannot see because `?` is not a word boundary before them.
const QUERY_TOKEN = /([?&](?:code|auth|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|token|session|session[_-]?id|sid|sig|signature|apikey|api[_-]?key)=)([^&#\s"'`]{4,2048})/gi;
const LABELLED_ADDRESS = /(地址|住址|收货地址|家庭住址)(\s*[:：]\s*)([^\n，。；;]{5,80})/g;
const ADDRESS = /(?:[\u4e00-\u9fa5]{2,16}(?:市|自治州|地区))[\u4e00-\u9fa5]{1,32}(?:区|县)[\u4e00-\u9fa5\dA-Za-z-]{2,32}(?:路|街|道|巷|弄)[^\s，。；;]{0,40}/g;

// Whole-match rules that are line-local and run in the windowed scan. A PEM
// block is the one credential that spans lines, so it is applied to the whole
// text separately, before the windows are cut.
const SEGMENT_MATCH_RULES = [
  ["apiKey", "api_key", /\b(?:sk|sk-ant|sk-proj)-[A-Za-z0-9_-]{16,2048}\b/g],
  ["apiKey", "api_key", /\b(?:gh[pousr])_[A-Za-z0-9]{20,2048}\b/g],
  ["apiKey", "api_key", /\bgithub_pat_[A-Za-z0-9_]{20,2048}\b/g],
  ["apiKey", "api_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["apiKey", "api_key", /\bxox[baprs]-[A-Za-z0-9-]{10,2048}\b/g],
  ["apiKey", "api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", "jwt", /\beyJ[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,2048}\b/g],
  ["email", "email", /[A-Za-z0-9._%+-]{1,128}@[A-Za-z0-9.-]{1,128}\.[A-Za-z]{2,16}/g],
  ["phone", "phone", /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ["idCard", "id_card", /\b\d{17}[\dXx]\b/g, validChineseId],
  ["bankCard", "bank_card", /\b(?:\d[ -]?){15,18}\d\b/g, validBankCard],
  // A labelled address is the highest-confidence form. The bare pattern
  // below needs a city + district + street hierarchy, which keeps it from
  // swallowing ordinary prose that merely mentions a road.
  ["address", "address", ADDRESS]
];

// ---- the windowed scan -----------------------------------------------------

// One source window per scan, plus an overlap longer than any match the rules
// above can produce, so a secret straddling a window edge is still seen whole
// by the next window.
const SEGMENT_CHUNK = 16384;
const SEGMENT_OVERLAP = 4096;

/** The line-local rules in application order; earlier rules win a region. */
function lineRules(mark, effective) {
  const assignment = (type) => (match) => {
    const value = match[4];
    if (value.includes("{{secret:") || value === LOG_MASK) return null;
    return `${match[1]}${match[2]}${match[3]}${mark(value, type)}${match[3]}`;
  };
  const rules = [
    { pattern: KEYED_ASSIGNMENT, enabled: true, handler: assignment("password") },
    { pattern: ASSIGNMENT, enabled: true, handler: assignment("password") },
    { pattern: CN_ASSIGNMENT, enabled: true, handler: assignment("password") },
    { pattern: CONNECTION, enabled: true, handler: (match) => `${match[1]}${mark(match[2], "password")}${match[3]}` },
    { pattern: BEARER, enabled: effective.bearer !== false, handler: (match) => `${match[1]}${mark(match[2], "bearer")}` },
    {
      pattern: AUTH_HEADER,
      enabled: effective.authHeader !== false,
      handler: (match) => {
        // A bearer value keeps its own type: the BEARER rule above already
        // claimed the token, and this rule only covers the other schemes
        // (Basic, Digest, raw credentials) it cannot see.
        if (/^bearer\s/i.test(match[4]) || match[4].includes("{{secret:")) return null;
        return `${match[1]}${mark(match[4], "password")}${match[3]}`;
      }
    },
    { pattern: COOKIE_HEADER, enabled: effective.cookie !== false, handler: (match) => `${match[1]}${match[2]}${match[3]}${mark(match[4], "password")}` },
    { pattern: QUERY_TOKEN, enabled: effective.queryToken !== false, handler: (match) => `${match[1]}${mark(match[2], "password")}` }
  ];
  if (effective.address) {
    rules.push({
      pattern: LABELLED_ADDRESS,
      enabled: true,
      handler: (match) => `${match[1]}${match[2]}${mark(match[3], "address")}`
    });
  }
  for (const [rule, type, pattern, validate] of SEGMENT_MATCH_RULES) {
    rules.push({
      pattern,
      enabled: effective[rule] !== false,
      handler: (match) => (validate && !validate(match[0]) ? null : mark(match[0], type))
    });
  }
  return rules.filter((rule) => rule.enabled);
}

function collectSpans(window, base, rules, spans) {
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(window))) {
      if (!match[0].length) {
        rule.pattern.lastIndex += 1;
        continue;
      }
      const replacement = rule.handler(match);
      if (replacement != null && replacement !== match[0]) {
        spans.push({ start: base + match.index, end: base + match.index + match[0].length, text: replacement });
      }
    }
  }
}

/**
 * Collects every replacement as a span over the source text.
 *
 * The scan walks the text in `SEGMENT_CHUNK` windows, each extended by the
 * overlap; every quantifier in the rules is bounded, so the cost stays linear
 * in the text length no matter what a client puts in a prompt.
 */
function scanSpans(text, rules) {
  const spans = [];
  if (text.length <= SEGMENT_CHUNK + SEGMENT_OVERLAP) {
    collectSpans(text, 0, rules, spans);
    return spans;
  }
  for (let at = 0; at < text.length; at += SEGMENT_CHUNK) {
    const end = Math.min(text.length, at + SEGMENT_CHUNK + SEGMENT_OVERLAP);
    collectSpans(text.slice(at, end), at, rules, spans);
    if (end >= text.length) break;
  }
  return spans;
}

/**
 * Applies the collected spans once, over the original text.
 *
 * Longer spans are preferred: a token that straddles a window boundary is
 * reported truncated by one window and whole by the next, and the whole one
 * is the one that must survive. A span that merely overlaps an accepted one
 * (a different rule's region) is dropped — the earlier rule's replacement
 * already covers the text it saw.
 */
function applySpans(text, spans) {
  if (!spans.length) return text;
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const span of spans) {
    const previous = kept[kept.length - 1];
    if (previous && span.start < previous.end) {
      if (span.end <= previous.end) continue;
      if (span.start <= previous.start) {
        kept[kept.length - 1] = span;
        continue;
      }
      continue;
    }
    kept.push(span);
  }
  let out = "";
  let at = 0;
  for (const span of kept) {
    out += text.slice(at, span.start) + span.text;
    at = span.end;
  }
  return out + text.slice(at);
}

export class SecretVault {
  constructor({ max = 2000 } = {}) {
    this.max = max;
    this.byValue = new Map();
    this.byId = new Map();
  }

  placeholder(value, type = "secret") {
    const text = String(value);
    const key = `${type}\u0000${text}`;
    const known = this.byValue.get(key);
    if (known) {
      // Refresh LRU position; the same secret keeps one placeholder across
      // every turn of a conversation.
      this.byValue.delete(key);
      this.byValue.set(key, known);
      return known.token;
    }
    let id;
    do {
      id = randomBytes(4).toString("hex");
    } while (this.byId.has(id));
    const token = `{{secret:${type}:${id}}}`;
    const entry = { token, value: text, type };
    this.byValue.set(key, entry);
    this.byId.set(id, entry);
    while (this.byValue.size > this.max) {
      const oldestKey = this.byValue.keys().next().value;
      const oldest = this.byValue.get(oldestKey);
      this.byValue.delete(oldestKey);
      this.byId.delete(oldest.token.match(/:([0-9a-f]{8})/)[1]);
    }
    return token;
  }

  restore(text) {
    if (!text || !this.byId.size) return text;
    return String(text).replace(PLACEHOLDER, (match, type, id) => {
      const entry = this.byId.get(id);
      return entry && entry.type === type ? entry.value : match;
    });
  }
}

function replacementFor(vault) {
  return (value, type) => (vault ? vault.placeholder(value, type) : LOG_MASK);
}

function listOf(value, max = 200) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

export function redactText(text, { vault = null, personal = true, rules = DEFAULT_RULES, allowlist = [], custom = [] } = {}) {
  if (typeof text !== "string" || !text) return text;
  const mark = replacementFor(vault);
  const effective = resolveRules(rules, { personal });
  const saved = [];
  const sentinel = (value) => {
    saved.push(value);
    return `\u0001${saved.length - 1}\u0001`;
  };
  let out = text.replace(PLACEHOLDER, (match) => sentinel(match));

  // Literal allow-list entries win over every rule. Longest first so a
  // specific address/vendor value is protected before a common substring.
  for (const term of listOf(allowlist).sort((a, b) => b.length - a.length)) {
    out = out.split(term).join(sentinel(term));
  }

  // The PEM rule is the one credential that spans lines, so it runs on the
  // whole text, before the line-local rules cut it into windows. Lazy and
  // anchored on a literal header, so its cost stays linear.
  if (effective.privateKey !== false) {
    PRIVATE_KEY_PATTERN.lastIndex = 0;
    out = out.replace(PRIVATE_KEY_PATTERN, (match) => mark(match, "private_key"));
  }

  // User-supplied literal terms are a separate, explicit rule.
  for (const term of listOf(custom).sort((a, b) => b.length - a.length)) {
    out = out.split(term).join(mark(term, "custom"));
  }

  // The two passes above can have generated placeholders of their own; protect
  // them before the line-local rules run, exactly as the old rule-by-rule
  // loop did, so an assignment rule cannot re-mask the text inside one.
  out = out.replace(PLACEHOLDER, (match) => sentinel(match));

  // Line-local rules through the windowed scan, then one splice of the spans.
  out = applySpans(out, scanSpans(out, lineRules(mark, effective)));

  return out.replace(/\u0001(\d+)\u0001/g, (match, index) => saved[Number(index)] || match);
}

/** Redacts every string in a JSON-like request body. */
export function redactBody(body, { vault, personal = true, rules = DEFAULT_RULES, allowlist = [], custom = [] } = {}) {
  if (typeof body === "string") return redactText(body, { vault, personal, rules, allowlist, custom });
  if (Array.isArray(body)) return body.map((item) => redactBody(item, { vault, personal, rules, allowlist, custom }));
  if (body && typeof body === "object") {
    const out = {};
    for (const [key, value] of Object.entries(body)) {
      out[key] = redactBody(value, { vault, personal, rules, allowlist, custom });
    }
    return out;
  }
  return body;
}

function restoreJson(value, vault) {
  if (typeof value === "string") return vault.restore(value);
  if (Array.isArray(value)) return value.map((item) => restoreJson(item, vault));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = restoreJson(item, vault);
    return out;
  }
  return value;
}

/**
 * Rewrites a JSON or SSE Response so placeholders become the original values
 * before the client reads them. SSE is processed one complete line at a time,
 * which is exactly the framing the stream uses; a placeholder split across
 * network chunks is reassembled before it is matched.
 */
export function restoreResponse(response, vault) {
  if (!vault || !response) return response;
  if (response.status === 204) return response;
  const contentType = String(response.headers?.get?.("content-type") || "");
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  if (/application\/json/i.test(contentType) && !/event-stream/i.test(contentType)) {
    return response.text().then((text) => {
      let body = text;
      try {
        body = JSON.stringify(restoreJson(JSON.parse(text), vault));
      } catch {
        body = vault.restore(text);
      }
      return new Response(body, { status: response.status, statusText: response.statusText, headers });
    });
  }

  if (/text\/event-stream/i.test(contentType) && response.body) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at + 1);
          buffer = buffer.slice(at + 1);
          controller.enqueue(encoder.encode(vault.restore(line)));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(vault.restore(buffer)));
      }
    }));
    return new Response(stream, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}

/** A one-way mask for logs: no vault, so a secret can never be recovered. */
export function redactForLog(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return redactText(text, { vault: null, personal: true });
}

export const redactInternals = {
  WHOLE_MATCH_RULES: SEGMENT_MATCH_RULES,
  ASSIGNMENT,
  KEYED_ASSIGNMENT,
  CN_ASSIGNMENT,
  BEARER,
  CONNECTION,
  AUTH_HEADER,
  COOKIE_HEADER,
  QUERY_TOKEN,
  LABELLED_ADDRESS,
  PLACEHOLDER
};
