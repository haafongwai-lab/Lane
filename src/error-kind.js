/**
 * Why a request stopped, in terms a person reading the activity list can act
 * on.
 *
 * Every failure used to reach the journal as whatever text the runtime
 * happened to produce. A client closing its window, an upstream that never
 * answered, and an upstream that answered with an error all arrived as
 * "This operation was aborted" or a wall of JSON, which reads the same on
 * screen and says nothing about whose problem it is. During one real outage
 * the activity list showed fifteen identical failures and the only way to
 * tell the upstream had stopped responding was to read the gateway's log by
 * hand.
 *
 * The kind is decided where the abort is raised, because that is the only
 * place that knows: the relay aborts on the client's close, workbuddy.js
 * aborts on its own header timeout, and the provider returns a non-ok
 * Response for a refusal.
 */

export const ERROR_KIND = {
  // The client hung up (window closed, request cancelled). Not a fault.
  clientClosed: "client-closed",
  // The upstream accepted the request and never sent a response head.
  upstreamTimeout: "upstream-timeout",
  // The upstream answered, with a refusal or an error body.
  upstreamError: "upstream-error",
  // The upstream's stream broke mid-answer.
  upstreamStream: "upstream-stream",
  // Lane could not read what the upstream sent.
  upstreamUnreadable: "upstream-unreadable",
  // No usable account, or the plugin refused to route.
  notSignedIn: "not-signed-in",
  // Anything else: a bug in Lane, or a failure nobody classified.
  unknown: "unknown"
};

// What each kind shows next to the request in the window. Kept short: the
// activity list has one line, and the reason column carries the detail.
export const ERROR_LABEL = {
  [ERROR_KIND.clientClosed]: "客户端已断开",
  [ERROR_KIND.upstreamTimeout]: "上游未响应",
  [ERROR_KIND.upstreamError]: "上游拒绝",
  [ERROR_KIND.upstreamStream]: "上游中断",
  [ERROR_KIND.upstreamUnreadable]: "上游响应无法解析",
  [ERROR_KIND.notSignedIn]: "未登录",
  [ERROR_KIND.unknown]: "失败"
};

/**
 * Marks an error with the kind of failure it is. The reason travels with it
 * so a caller that only sees the rejection (the relay's catch) can still
 * report the right thing.
 */
export function withKind(error, kind, message) {
  const target = error instanceof Error ? error : new Error(String(error ?? ""));
  target.kind ??= kind;
  if (message) target.message = message;
  return target;
}

/** The kind of a caught failure. */
export function kindOf(error) {
  if (error?.kind) return error.kind;
  const message = String(error?.message || "");
  if (/did not answer within/i.test(message)) return ERROR_KIND.upstreamTimeout;
  if (error?.name === "AbortError" || /aborted|abort|client closed/i.test(message)) {
    return ERROR_KIND.clientClosed;
  }
  if (error?.name === "ProviderUnavailable" || /not signed in|signed out|sign in again/i.test(message)) {
    return ERROR_KIND.notSignedIn;
  }
  if (Number(error?.status) === 502) {
    if (/invalid JSON|without choices|no usable events|non-JSON/i.test(message)) {
      return ERROR_KIND.upstreamUnreadable;
    }
    return ERROR_KIND.upstreamError;
  }
  return ERROR_KIND.unknown;
}

/**
 * The kind of a failure known only by the text the journal kept. The journal
 * stores a plain string, so a row read back from disk has no error object to
 * inspect; this applies the same reading to the message alone. The abort
 * check is repeated here because kindOf() relies on `name` for it, and a
 * reloaded row has no name.
 */
export function kindFromText(text) {
  const message = String(text ?? "");
  if (!message) return ERROR_KIND.unknown;
  if (/did not answer within/i.test(message)) return ERROR_KIND.upstreamTimeout;
  // Both the runtime's own "aborted" and the message the relay now raises
  // when it aborts on the client's close.
  if (/aborted|abort|client closed/i.test(message)) return ERROR_KIND.clientClosed;
  if (/not signed in|signed out|sign in again/i.test(message)) return ERROR_KIND.notSignedIn;
  // The text alone has to identify the unreadable cases: a reloaded row
  // carries no status, and kindOf() keys that group off `status === 502`.
  if (/invalid JSON|without choices|no usable events|non-JSON/i.test(message)) {
    return ERROR_KIND.upstreamUnreadable;
  }
  return kindOf({ message });
}

/** The one-line label for a request's error kind. */
export function labelOf(error) {
  return ERROR_LABEL[kindOf(error)] || ERROR_LABEL[ERROR_KIND.unknown];
}
