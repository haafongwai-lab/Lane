/**
 * The hosts Lane's upstream plugins are allowed to reach.
 *
 * Two tiers, because they answer two different questions:
 *
 *   ALLOW_HOSTS     — the exact hosts the vendored plugins name today.
 *   VENDOR_FAMILIES — the providers' own domain families. A plugin may build
 *                     a host from a server response (Trae's `info.Host`), so
 *                     an exact list alone would break the day the provider
 *                     moves an endpoint to a new subdomain.
 *
 * Anything outside both is a third party: that is the case worth blocking,
 * because neither provider needs it to answer a chat.
 *
 * test/egress.test.js fails when a vendored plugin names a host that is in
 * neither list, so upgrading a plugin forces a look at this file.
 */

// Exact hosts, per provider. Keep the comment on each line: it says what the
// plugin uses that host for, which is what makes a review possible later.
export const ALLOW_HOSTS = new Map([
  // ---- WorkBuddy ----
  ["www.workbuddy.cn", "sign-in page and token endpoint (domestic)"],
  ["www.workbuddy.ai", "sign-in page and token endpoint (international)"],
  ["copilot.tencent.com", "chat, models and usage (domestic)"],
  ["workbuddy.cn", "bare host used by the domestic build"],
  ["workbuddy.ai", "bare host used by the international build"],
  // ---- Qoder (qoder.com, qoder.cn) ----
  ["qoder.com", "sign-in page (international)"],
  ["qoder.cn", "sign-in page (CN)"],
  ["openapi.qoder.sh", "sign-in, token and usage (international)"],
  ["api3.qoder.sh", "chat and model catalogue (international)"],
  ["openapi.qoder.com.cn", "sign-in, token and usage (CN)"],
  ["gateway.qoder.com.cn", "chat and model catalogue (CN)"],
  // The vendored file also carries QwenWork's two sites. Lane does not
  // register them (src/qoder.js exports only the two Qoder factories), so
  // these hosts are named by the bundle but never reached; listing them keeps
  // the audit honest about what the file contains.
  ["gateway.qwenwork.cn", "QwenWork public cloud (present in the bundle, not wired)"],
  ["your-company.vpc.qwenwork.cn", "QwenWork VPC placeholder (not wired)"],
  ["your-corp.rdc.aliyuncs.com", "QwenWork dedicated-domain placeholder (not wired)"],
  // ---- Trae CN ----
  ["www.trae.cn", "authorization page"],
  ["api.trae.cn", "tokens, account, credits"],
  ["trae-api-cn.mchost.guru", "models and chat (CN)"],
  ["api.trae.com.cn", "legacy CN API host named by the official client"],
  // ---- Trae Global ----
  ["www.trae.ai", "authorization page"],
  ["growsg-normal.trae.ai", "tokens and account (SG)"],
  ["coresg-normal.trae.ai", "models (SG)"],
  ["coreva-normal.trae.ai", "models (US)"],
  ["api-sg-central.trae.ai", "usage (SG)"],
  ["api-us-east.trae.ai", "usage (US)"],
  // ---- Trae sign-in callback ----
  ["127.0.0.1", "loopback callback for the browser sign-in"],
  ["localhost", "loopback callback for the browser sign-in"]
]);

// Domain families each provider owns. A host under one of these is treated as
// the provider's own, and recorded for review rather than blocked: providers
// do move endpoints, and a stale exact list would otherwise look like an
// outage.
export const VENDOR_FAMILIES = [
  // Qoder's own domains. The CN enterprise VPC builds <instance>.vpc.qoder.com.cn
  // and its -openapi/-gateway siblings from a sign-in answer, so the family is
  // what keeps a valid instance from reading as a third party.
  "qoder.com",
  "qoder.sh",
  "qoder.cn",
  "qoder.com.cn",
  "trae.cn",
  "trae.ai",
  "mchost.guru",
  "traecontent.cn",
  "byteintl.net",
  "bytedance.net",
  "bytedance.com",
  "zijieapi.com",
  "zijiecdn.cn",
  "workbuddy.cn",
  "workbuddy.ai",
  "tencent.com",
  "tencentcloudapi.com"
];

/** True when `host` equals, or is a subdomain of, one of `families`. */
export function underFamily(host, families = VENDOR_FAMILIES) {
  const name = String(host || "").toLowerCase();
  if (!name) return false;
  return families.some((family) => name === family || name.endsWith(`.${family}`));
}
