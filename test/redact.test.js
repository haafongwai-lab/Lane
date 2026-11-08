import test from "node:test";
import assert from "node:assert/strict";
import { SecretVault, redactText, redactBody, restoreResponse, redactForLog, DEFAULT_RULES } from "../src/redact.js";

/**
 * Reversible redaction: the model sees placeholders, the local client gets
 * the originals back, and the map lives only in memory. Tests drive the real
 * functions rather than a regex copy, so a change to detection or streaming
 * restoration cannot drift from what Lane sends.
 */

test("credentials are replaced with typed placeholders", () => {
  const vault = new SecretVault();
  const input = [
    "key sk-abcdefghijklmnopqrstuvwx",
    "github ghp_abcdefghijklmnopqrstuvwxyz012345",
    "password=Hunter2!",
    "密码：我的密码123",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    "https://user:hunter2@example.com/db"
  ].join("\n");
  const out = redactText(input, { vault, personal: false });
  assert.doesNotMatch(out, /sk-abc/);
  assert.doesNotMatch(out, /ghp_/);
  assert.doesNotMatch(out, /Hunter2/);
  assert.doesNotMatch(out, /我的密码123/);
  assert.doesNotMatch(out, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(out, /:hunter2@/);
  assert.match(out, /\{\{secret:api_key:[0-9a-f]{8}\}\}/);
  assert.match(out, /\{\{secret:password:[0-9a-f]{8}\}\}/);
  assert.match(out, /\{\{secret:bearer:[0-9a-f]{8}\}\}/);
  // Every placeholder round-trips back to its original.
  assert.equal(vault.restore(out), input);
});

test("environment-variable spellings are caught too", () => {
  const vault = new SecretVault();
  const input = [
    "OPENAI_API_KEY=abcdefghijklmnop123456",
    "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz123456",
    "MY_PASSWORD=Hunter2!",
    "database_password=Hunter2!",
    "secretary=NotASecret"
  ].join("\n");
  const out = redactText(input, { vault, personal: false });
  assert.doesNotMatch(out, /abcdefghijklmnop123456|abcdefghijklmnopqrstuvwxyz123456|Hunter2/);
  assert.match(out, /OPENAI_API_KEY=\{\{secret:password:[0-9a-f]{8}\}\}/);
  assert.match(out, /AWS_SECRET_ACCESS_KEY=\{\{secret:password:[0-9a-f]{8}\}\}/);
  assert.match(out, /secretary=NotASecret/, "a word merely starting with secret is not a key");
  assert.equal(vault.restore(out), input);
});

test("ID cards, bank cards and addresses are recognised as PII", () => {
  const vault = new SecretVault();
  const input = [
    "身份证 11010519491231002X",
    "银行卡 4111111111111111",
    "地址：北京市朝阳区建国路88号SOHO现代城",
    "北京市朝阳区建国路88号"
  ].join("\n");
  const out = redactText(input, { vault });
  assert.doesNotMatch(out, /11010519491231002X|4111111111111111|建国路88号/);
  assert.match(out, /id_card/);
  assert.match(out, /bank_card/);
  assert.match(out, /address/);
  assert.equal(vault.restore(out), input);
});

test("a rule can be switched off individually", () => {
  const vault = new SecretVault();
  const disabled = { ...DEFAULT_RULES, apiKey: 1 === 2, email: false };
  const input = "key {{secret:api_key:af074fcd}} mail {{secret:email:a87158d3}}";
  const out = redactText(input, { vault, rules: disabled });
  assert.match(out, /{{secret:api_key:af074fcd}}/, "apiKey is off");
  assert.match(out, /{{secret:email:a87158d3}}/, "email is off");
});

test("allowlist wins over detection and custom terms are redacted", () => {
  const vault = new SecretVault();
  const input = "{{secret:email:a87158d3}} Project-X {{secret:api_key:f6a71d33}}";
  const out = redactText(input, {
    vault,
    allowlist: ["{{secret:email:a87158d3}}"],
    custom: ["Project-X"]
  });
  assert.match(out, /{{secret:email:a87158d3}}/);
  assert.doesNotMatch(out, /Project-X/);
  assert.match(out, /custom/);
  assert.equal(vault.restore(out), input);
});

test("personal data is optional and off means untouched", () => {
  const vault = new SecretVault();
  const input = "mail me at alice@example.com or 13800138000";
  const personal = redactText(input, { vault, personal: true });
  assert.doesNotMatch(personal, /alice@example\.com|13800138000/);
  assert.equal(vault.restore(personal), input);
  assert.equal(redactText(input, { vault: new SecretVault(), personal: false }), input);
});

test("one secret keeps one placeholder across turns", () => {
  const vault = new SecretVault();
  const first = redactText("token ghp_abcdefghijklmnopqrstuvwxyz012345", { vault });
  const second = redactText("again ghp_abcdefghijklmnopqrstuvwxyz012345", { vault });
  const token = /\{\{secret:api_key:([0-9a-f]{8})\}\}/.exec(first)?.[0];
  assert.ok(token);
  assert.match(second, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(vault.restore(second), "again ghp_abcdefghijklmnopqrstuvwxyz012345");
});

test("restore leaves an unknown or evicted placeholder untouched, never guessing", () => {
  const vault = new SecretVault({ max: 1 });
  redactText("sk-abcdefghijklmnopqrstuvwx", { vault });
  redactText("sk-zyxwvutsrqponmlkjihgfedc", { vault }); // evicts the first
  assert.match(vault.restore("{{secret:api_key:deadbeef}}"), /\{\{secret:api_key:deadbeef\}\}/);
});

test("a nested body is redacted without changing its shape", () => {
  const vault = new SecretVault();
  const body = {
    model: "hy3",
    messages: [{ role: "user", content: [{ type: "text", text: "key sk-abcdefghijklmnopqrstuvwx" }] }],
    tools: [{ type: "function", function: { name: "x", description: "password: Hunter2!" } }]
  };
  const out = redactBody(body, { vault, personal: false });
  assert.equal(out.model, "hy3");
  assert.equal(out.messages[0].role, "user");
  assert.doesNotMatch(JSON.stringify(out), /sk-abc|Hunter2/);
  assert.equal(vault.restore(JSON.stringify(out)), JSON.stringify(body));
});

test("a streaming response restores a placeholder split across chunks", async () => {
  const vault = new SecretVault();
  const token = vault.placeholder("ghp_abcdefghijklmnopqrstuvwxyz012345", "api_key");
  const pieces = [`data: {"choices":[{"delta":{"content":"key `, `${token.slice(0, 8)}`, `${token.slice(8)}",`, `"finish_reason":null}}]}\n\n`];
  const body = new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
      controller.close();
    }
  });
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
  const restored = await restoreResponse(response, vault).text();
  assert.match(restored, /ghp_abcdefghijklmnopqrstuvwxyz012345/);
  assert.doesNotMatch(restored, /secret:api_key/);
});

test("a JSON response restores values in every nested string", async () => {
  const vault = new SecretVault();
  const token = vault.placeholder("Hunter2!", "password");
  const response = new Response(JSON.stringify({
    choices: [{ message: { content: `password ${token}` } }],
    usage: { prompt_tokens: 1 }
  }), { headers: { "content-type": "application/json" } });
  const json = await (await restoreResponse(response, vault)).json();
  assert.equal(json.choices[0].message.content, "password Hunter2!");
});

test("the log mask is one-way", () => {
  const input = "sk-abcdefghijklmnopqrstuvwx and alice@example.com";
  const masked = redactForLog(input);
  assert.doesNotMatch(masked, /sk-abc|alice@example\.com/);
  assert.match(masked, /«redacted»/);
});
