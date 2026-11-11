/**
 * Which external URLs the desktop shell may open.
 *
 * The renderer is CSP-restricted, but a compromised renderer could otherwise
 * ask the main process to open any HTTPS page it likes. The only pages Lane
 * itself ever opens are the upstream sign-in hosts — measured from each
 * plugin's own authorize(): WorkBuddy hands back
 * `https://www.workbuddy.cn/login?...` and `https://www.workbuddy.ai/login?...`,
 * Trae `https://www.trae.cn/authorization?...` and its global twin, and Qoder
 * `https://qoder.com/device/selectAccounts?...` and `https://qoder.cn/...`.
 * API traffic goes to the providers' own gateways. The check-in card links
 * the project's own repository, so github.com is openable too. Anything else
 * is refused.
 *
 * Kept out of main.js so it can be tested without an Electron runtime: this
 * is the one security decision in the desktop shell that a unit test can
 * hold, and it is exactly the kind that decays silently.
 */
const OPENABLE_HOSTS = new Set([
  "www.workbuddy.cn",
  "www.workbuddy.ai",
  "copilot.tencent.com",
  "www.trae.cn",
  "www.trae.ai",
  // Qoder hands its device sign-in pages back on these two hosts.
  "qoder.com",
  "qoder.cn",
  "github.com"
]);

export function openableUrl(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (!OPENABLE_HOSTS.has(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export const openableHosts = [...OPENABLE_HOSTS];
