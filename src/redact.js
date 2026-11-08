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
  address: true
};

export const RULE_GROUPS = {
  credential: ["apiKey", "password", "bearer", "jwt", "privateKey"],
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

// Order matters: a PEM block must be caught before its header line could be
// mistaken for a keyword assignment. [rule, placeholder type, regex, validator]
const WHOLE_MATCH_RULES = [
  ["privateKey", "private_key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["apiKey", "api_key", /\b(?:sk|sk-ant|sk-proj)-[A-Za-z0-9_-]{16,}\b/g],
  ["apiKey", "api_key", /\b(?:gh[pousr])_[A-Za-z0-9]{20,}\b/g],
  ["apiKey", "api_key", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["apiKey", "api_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["apiKey", "api_key", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["apiKey", "api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", "jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["email", "email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["phone", "phone", /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ["idCard", "id_card", /\b\d{17}[\dXx]\b/g, validChineseId],
  ["bankCard", "bank_card", /\b(?:\d[ -]?){15,18}\d\b/g, validBankCard],
  // A labelled address is the highest-confidence form. The bare pattern
  // below needs a city + district + street hierarchy, which keeps it from
  // swallowing ordinary prose that merely mentions a road.
  ["address", "address", /(?:[\u4e00-\u9fa5]{2,}(?:市|自治州|地区))[\u4e00-\u9fa5]{1,}(?:区|县)[\u4e00-\u9fa5\dA-Za-z-]{2,}(?:路|街|道|巷|弄)[^\s，。；;]{0,40}/g]
];

const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/-]{20,}={0,2})/gi;
const ASSIGNMENT = /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?token)\b(\s*[:=]\s*)(["']?)([^\s"'`,;&#)]{4,})\3/gi;
const KEYED_ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_]*(?:API_KEY|APIKEY|SECRET_KEY|SECRET|ACCESS_KEY|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|client[_-]?secret|password|passwd|pwd))\b(\s*[:=]\s*)(["']?)([^\s"'`,;&#)]{4,})\3/gi;
const CN_ASSIGNMENT = /(密码|口令|密钥|令牌)(\s*[：:=]\s*)(["']?)([^\s"'`,;&#)]{4,})\3/g;
const CONNECTION = /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/g;
const LABELLED_ADDRESS = /(地址|住址|收货地址|家庭住址)(\s*[:：]\s*)([^\n，。；;]{5,80})/g;

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

  const apply = (rule) => {
    out = rule(out);
    // Protect placeholders generated by this rule before the next rule
    // mistakes the `secret:` inside one for another assignment.
    out = out.replace(PLACEHOLDER, (match) => sentinel(match));
  };

  // User-supplied literal terms are a separate, explicit rule.
  for (const term of listOf(custom).sort((a, b) => b.length - a.length)) {
    apply((value) => value.split(term).join(mark(term, "custom")));
  }

  // Assignments first: they consume a value and can otherwise mistake the
  // generated placeholder's `secret:...` for another assignment.
  apply((value) => value.replace(KEYED_ASSIGNMENT, (match, key, sep, quote, secret) => {
    if (secret.includes("{{secret:") || secret === LOG_MASK) return match;
    return `${key}${sep}${quote}${mark(secret, "password")}${quote}`;
  }));
  apply((value) => value.replace(ASSIGNMENT, (match, key, sep, quote, secret) => {
    if (secret.includes("{{secret:") || secret === LOG_MASK) return match;
    return `${key}${sep}${quote}${mark(secret, "password")}${quote}`;
  }));
  apply((value) => value.replace(CN_ASSIGNMENT, (match, key, sep, quote, secret) => {
    if (secret.includes("{{secret:") || secret === LOG_MASK) return match;
    return `${key}${sep}${quote}${mark(secret, "password")}${quote}`;
  }));
  apply((value) => value.replace(CONNECTION, (match, prefix, password, at) =>
    `${prefix}${mark(password, "password")}${at}`));
  apply((value) => value.replace(BEARER, (match, prefix, token) => `${prefix}${mark(token, "bearer")}`));
  if (effective.address) {
    apply((value) => value.replace(LABELLED_ADDRESS, (match, label, sep, address) =>
      `${label}${sep}${mark(address, "address")}`));
  }

  for (const [rule, type, pattern, validate] of WHOLE_MATCH_RULES) {
    if (!effective[rule]) continue;
    // Reset lastIndex for global regexes reused across calls.
    pattern.lastIndex = 0;
    apply((value) => value.replace(pattern, (match) => {
      if (validate && !validate(match)) return match;
      return mark(match, type);
    }));
  }
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

export const redactInternals = { WHOLE_MATCH_RULES, ASSIGNMENT, KEYED_ASSIGNMENT, CN_ASSIGNMENT, BEARER, CONNECTION, LABELLED_ADDRESS, PLACEHOLDER };
