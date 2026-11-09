import test from "node:test";
import assert from "node:assert/strict";
import { assertLoopbackHost, gatewayBase, isLoopbackHost } from "../src/config.js";
import { protectText, unprotectText } from "../src/secure-auth.js";

test("only loopback addresses are accepted", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.equal(assertLoopbackHost(host), host);
  }
  for (const host of ["0.0.0.0", "192.168.1.2", "10.0.0.1", "example.com", "", null]) {
    assert.equal(isLoopbackHost(host), false, String(host));
    assert.throws(() => assertLoopbackHost(host), /only binds loopback/);
  }
});

test("IPv6 gateway URLs are bracketed", () => {
  assert.equal(gatewayBase("::1", 3426), "http://[::1]:3426");
  assert.equal(gatewayBase("127.0.0.1", 3426), "http://127.0.0.1:3426");
});

test("encrypted auth files round-trip a Chinese display name", async () => {
  const value = "眼中尽繁星、";
  assert.equal(await unprotectText(await protectText(value)), value);
});
