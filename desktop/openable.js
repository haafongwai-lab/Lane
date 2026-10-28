/**
 * Which external URLs the desktop shell may open.
 *
 * The renderer is CSP-restricted, but a compromised renderer could otherwise
 * ask the main process to open any HTTPS page it likes. The only pages Lane
 * itself ever opens are WorkBuddy's sign-in hosts — measured from the
 * plugin's own authorize(): the domestic build hands back
 * `https://www.workbuddy.cn/login?...` and the international build
 * `https://www.workbuddy.ai/login?...`, while API traffic goes to
 * copilot.tencent.com. Anything else is refused.
 *
 * Kept out of main.js so it can be tested without an Electron runtime: this
 * is the one security decision in the desktop shell that a unit test can
 * hold, and it is exactly the kind that decays silently.
 */
const OPENABLE_HOSTS = new Set(["www.workbuddy.cn", "www.workbuddy.ai", "copilot.tencent.com"]);

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
