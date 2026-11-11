import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The WorkBuddy plugin is vendored so a fresh clone never needs the npm
 * registry. These tests pin that the copy is the real published source (not
 * an unexplained fork), that Lane actually loads it by path, and that the
 * original tarball is preserved as provenance.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const VENDOR = path.join(ROOT, "vendor/workbuddy-auth");
const TRAE_VENDOR = path.join(ROOT, "vendor/trae-auth");
const QODER_VENDOR = path.join(ROOT, "vendor/qoder-auth");
const ORIGINALS = path.join(ROOT, "vendor/originals");
const read = (p) => fs.readFileSync(p, "utf8");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const APP = read(path.join(ROOT, "src/workbuddy.js"));
const SANITIZE = read(path.join(ROOT, "src/sanitize.js"));
const TRAE = read(path.join(ROOT, "src/trae.js"));
const PKG = JSON.parse(read(path.join(ROOT, "package.json")));
const LOCK = JSON.parse(read(path.join(ROOT, "package-lock.json")));
const INTEGRITY = "sha512-Z9cLrnrok3CsW/c++s1GJRy6EYIgADf/PC0MbplCXa9/Hbh/U6HRqUW+E+Vgfw+cLCOmbWDINex6ahqBfSgGeA==";
const TRAE_INTEGRITY = "sha512-/qifTc/65BRpHqBNv0UwxM1AUBv01Ax9gQB5fyYd9FnSCtcTCSRzRlsCaogv/60GOXaazpEIDul1fIy31LqB/w==";
const QODER_INTEGRITY = "sha512-US/0HFWypXGHlLbtdgLpzLsxYe6aHhIUxU7w/neB2icYPUC2+4vvbBkfRrCGqb56n1Hsq/QMjbA0CKYoOfMg5w==";

/** Pull one file out of a gzip tarball without a tar dependency. */
function untarOne(gz, wanted) {
  const buf = zlib.gunzipSync(gz);
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
    const data = buf.subarray(off + 512, off + 512 + size);
    if (name === wanted) return data;
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

test("the copy is traceable, and any local change is recorded", () => {
  const copy = fs.readFileSync(path.join(VENDOR, "index.mjs"));
  const tgz = fs.readFileSync(path.join(ORIGINALS, "opencode-workbuddy-auth-0.2.27.tgz"));
  assert.equal(
    "sha512-" + crypto.createHash("sha512").update(tgz).digest("base64"),
    INTEGRITY,
    "the archived tarball matches the integrity the lockfile once recorded"
  );
  const fromTarball = untarOne(tgz, "package/index.mjs");
  assert.ok(fromTarball, "package/index.mjs is in the tarball");
  assert.ok(copy.length > 100_000, "it is the full file, not a stub");

  // Byte-identity is only required while the copy is untouched. Once Lane
  // needs its own fix, the tarball stays as provenance and NOTICE.md becomes
  // the changelog: the guard flips from "unchanged" to "change recorded".
  const notice = read(path.join(VENDOR, "NOTICE.md"));
  const section = notice.slice(notice.indexOf("## Local modifications"));
  const unchanged = sha256(copy) === sha256(fromTarball);
  const saysNone = /^None\.\s*$/m.test(section);
  const bullets = section.split("\n").filter((line) => /^\s*-\s+\S/.test(line));
  if (unchanged) {
    assert.ok(saysNone, "an untouched copy must say 'None.' in NOTICE.md");
  } else {
    assert.ok(!saysNone, "a modified copy must remove the 'None.' line");
    assert.ok(bullets.length > 0, "a modified copy must list its changes as bullets in NOTICE.md");
  }
});

test("the Trae copy is traceable, and any local change is recorded", () => {
  const copy = fs.readFileSync(path.join(TRAE_VENDOR, "index.mjs"));
  const tgz = fs.readFileSync(path.join(ORIGINALS, "opencode-trae-auth-0.2.33.tgz"));
  assert.equal(
    "sha512-" + crypto.createHash("sha512").update(tgz).digest("base64"),
    TRAE_INTEGRITY,
    "the archived Trae tarball matches its npm integrity"
  );
  const fromTarball = untarOne(tgz, "package/index.mjs");
  assert.ok(fromTarball, "package/index.mjs is in the Trae tarball");
  assert.equal(sha256(copy), sha256(fromTarball), "the vendored Trae copy is byte-identical");
  const notice = read(path.join(TRAE_VENDOR, "NOTICE.md"));
  assert.match(notice, /Local modifications/);
  assert.match(notice, /None\./);
});


test("the Qoder copy is traceable, and any local change is recorded", async () => {
  const copy = fs.readFileSync(path.join(QODER_VENDOR, "index.mjs"));
  const tgz = fs.readFileSync(path.join(ORIGINALS, "opencode-qoder-auth-0.2.65.tgz"));
  assert.equal(
    "sha512-" + crypto.createHash("sha512").update(tgz).digest("base64"),
    QODER_INTEGRITY,
    "the archived Qoder tarball matches its npm integrity"
  );
  const fromTarball = untarOne(tgz, "package/index.mjs");
  assert.ok(fromTarball, "package/index.mjs is in the Qoder tarball");
  assert.equal(sha256(copy), sha256(fromTarball), "the vendored Qoder copy is byte-identical");
  const notice = read(path.join(QODER_VENDOR, "NOTICE.md"));
  assert.match(notice, /0\.2\.65/);
  assert.match(notice, /Local modifications/);
  assert.match(notice, /None\./);
});

test("the Qoder copy exports the two factories Lane registers", async () => {
  const mod = await import(pathToFileURL(path.join(QODER_VENDOR, "index.mjs")).href);
  for (const name of ["QoderAuthPlugin", "QoderCNAuthPlugin"]) {
    assert.equal(typeof mod[name], "function", name);
  }
  // QwenWork's factories are in the bundle but Lane must not register them.
  const qoder = read(path.join(ROOT, "src/qoder.js"));
  assert.doesNotMatch(qoder, /QwenWorkAuthPlugin|QwenWorkEnterpriseAuthPlugin/);
});

test("Lane loads the Qoder copy by path, not from node_modules", () => {
  const qoder = read(path.join(ROOT, "src/qoder.js"));
  assert.match(qoder, /pluginEntryUrl\("qoder-auth", this\.env\)/);
  assert.doesNotMatch(qoder, /node_modules/);
});

test("the vendored module still exposes what Lane consumes", async () => {
  const mod = await import(pathToFileURL(path.join(VENDOR, "index.mjs")).href);
  for (const name of ["WorkBuddyAuthPlugin", "WorkBuddyAIAuthPlugin", "_internal"]) {
    assert.equal(typeof mod[name], name === "_internal" ? "object" : "function", name);
  }
  for (const fn of ["withSystem", "fitted", "normalizeToolChoice", "renamed"]) {
    assert.equal(typeof mod._internal[fn], "function", fn);
  }
});

test("Lane loads the copy by path, with no npm package lookup", () => {
  assert.match(APP, /pluginEntryUrl\("workbuddy-auth", env\)/);
  assert.match(SANITIZE, /pluginEntryUrl\("workbuddy-auth", env\)/);
  for (const [name, source] of [["workbuddy.js", APP], ["sanitize.js", SANITIZE]]) {
    assert.doesNotMatch(source, /require\.resolve\(PACKAGE\)/, name);
    assert.doesNotMatch(source, /createRequire/, name);
    assert.doesNotMatch(source, /@magpie-community\/opencode-workbuddy-auth/, name);
  }
  assert.match(TRAE, /pluginEntryUrl\("trae-auth", this\.env\)/);
  assert.doesNotMatch(TRAE, /@magpie-community\/opencode-trae-auth/);
});

test("the package no longer depends on the registry copy", () => {
  assert.equal(PKG.dependencies?.["@magpie-community/opencode-workbuddy-auth"], undefined);
  assert.equal(LOCK.packages[""].dependencies?.["@magpie-community/opencode-workbuddy-auth"], undefined);
  assert.equal(LOCK.packages["node_modules/@magpie-community/opencode-workbuddy-auth"], undefined);
  const files = PKG.build.files;
  assert.ok(files.includes("vendor/**/*"), "the copy ships in the asar");
  assert.ok(files.includes("!vendor/originals/**"), "the archive is not shipped in the app");
  assert.ok(files.includes("LICENSE"), "the project license ships with the app");
  assert.ok(files.includes("THIRD_PARTY_NOTICES.md"), "the consolidated notice ships with the app");
  assert.ok(files.includes("DISCLAIMER.md"), "the release disclaimer ships with the app");
  assert.ok(!files.some((entry) => entry.includes("node_modules/@magpie-community")), "no node_modules path left");
});

test("MIT notice and provenance travel with the copy", () => {
  const license = read(path.join(VENDOR, "LICENSE"));
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 magpie-community contributors/);
  assert.match(license, /Permission is hereby granted/);
  assert.match(read(path.join(VENDOR, "NOTICE.md")), /Local modifications/);
  assert.ok(read(path.join(ORIGINALS, "README.md")).includes(INTEGRITY.slice(0, 24)));
  assert.match(read(path.join(TRAE_VENDOR, "LICENSE")), /MIT License/);
  assert.match(read(path.join(TRAE_VENDOR, "NOTICE.md")), /Local modifications/);
  assert.ok(read(path.join(ORIGINALS, "README.md")).includes(TRAE_INTEGRITY.slice(0, 24)));
  assert.match(read(path.join(ROOT, "THIRD_PARTY_NOTICES.md")), /vendored/);
  assert.match(read(path.join(ROOT, "README.md")), /vendored copy/);
  assert.match(read(path.join(ROOT, "LICENSE")), /MIT License/);
});
