import test from "node:test";
import assert from "node:assert/strict";
import { ERROR_KIND, kindOf, kindFromText, withKind, labelOf } from "../src/error-kind.js";

/**
 * Before this existed, every failure reached the activity list as "失败". A
 * real outage produced fifteen identical rows reading "This operation was
 * aborted", and the only way to learn the upstream had stopped answering was
 * to read the gateway log by hand.
 */

test("a client closing its window is not an upstream fault", () => {
  const closed = withKind(new Error("client closed the connection"), ERROR_KIND.clientClosed);
  assert.equal(kindOf(closed), ERROR_KIND.clientClosed);
  assert.equal(labelOf(closed), "客户端已断开");
});

test("the provider's own timeout is told apart from a client abort", () => {
  // Both arrive as AbortError; only the message separates them.
  const timeout = Object.assign(new Error("WorkBuddy did not answer within 120s"), {
    name: "AbortError",
    kind: ERROR_KIND.upstreamTimeout
  });
  assert.equal(kindOf(timeout), ERROR_KIND.upstreamTimeout);
  assert.equal(labelOf(timeout), "上游未响应");

  const bareAbort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  assert.equal(kindOf(bareAbort), ERROR_KIND.clientClosed,
    "an abort with no timeout message came from the client");
});

test("an explicit kind wins over what the message suggests", () => {
  const error = withKind(new Error("This operation was aborted"), ERROR_KIND.upstreamTimeout);
  assert.equal(kindOf(error), ERROR_KIND.upstreamTimeout);
});

test("upstream refusals and unreadable bodies are different kinds", () => {
  const refused = Object.assign(new Error('{"code":11158,"msg":"not allowed"}'), { status: 502 });
  assert.equal(kindOf(refused), ERROR_KIND.upstreamError);
  assert.equal(labelOf(refused), "上游拒绝");

  for (const message of [
    "upstream returned invalid JSON: <html>",
    "upstream returned a 200 without choices",
    "upstream returned no usable events",
    "upstream sent a non-JSON SSE payload: not-json"
  ]) {
    assert.equal(kindOf(Object.assign(new Error(message), { status: 502 })),
      ERROR_KIND.upstreamUnreadable, message);
  }
});

test("a provider that is not signed in says so", () => {
  const unavailable = Object.assign(new Error("WorkBuddy is not signed in"), {
    name: "ProviderUnavailable"
  });
  assert.equal(kindOf(unavailable), ERROR_KIND.notSignedIn);
  assert.equal(labelOf(unavailable), "未登录");
});

test("an unclassified failure stays unclassified rather than guessing", () => {
  assert.equal(kindOf(new Error("something odd")), ERROR_KIND.unknown);
  assert.equal(labelOf(new Error("something odd")), "失败");
});

test("a row read back from disk classifies from its message alone", () => {
  // The journal stores a string, so a reloaded row has no error object.
  assert.equal(kindFromText("WorkBuddy did not answer within 120s"), ERROR_KIND.upstreamTimeout);
  assert.equal(kindFromText("client closed the connection"), ERROR_KIND.clientClosed);
  assert.equal(kindFromText("upstream returned no usable events"), ERROR_KIND.upstreamUnreadable);
  assert.equal(kindFromText(""), ERROR_KIND.unknown);
  assert.equal(kindFromText(undefined), ERROR_KIND.unknown);
});

test("withKind accepts a non-Error and still marks it", () => {
  const marked = withKind("plain string", ERROR_KIND.upstreamError);
  assert.ok(marked instanceof Error);
  assert.equal(marked.kind, ERROR_KIND.upstreamError);
  assert.equal(marked.message, "plain string");
});
