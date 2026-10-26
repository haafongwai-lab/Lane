#!/usr/bin/env node
/**
 * Lane's quality gate, dependency-free.
 *
 * `node --test` is the real gate, but it only exercises what the tests
 * import: a file nobody imports (a new agent, a dead module) can carry a
 * syntax error to a release unnoticed, and a lockfile edited by hand can
 * drift from package.json without any test noticing. This runs the checks
 * that need no tooling beyond Node itself, so it works on a fresh clone and
 * in CI with no install step beyond dependencies.
 *
 * Exits non-zero on the first category that fails, printing every finding.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(category, message) {
  failures.push(`[${category}] ${message}`);
}

// ---- 1. Syntax: every JavaScript file parses -------------------------------
// node --check parses without executing, so an Electron-only file is fine.
async function jsFiles(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (["node_modules", "dist", "deliver", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await jsFiles(full, out);
    else if (/\.(c?js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const syntaxTargets = [
  ...(await jsFiles(path.join(ROOT, "src"))),
  ...(await jsFiles(path.join(ROOT, "desktop"))),
  ...(await jsFiles(path.join(ROOT, "test"))),
  path.join(ROOT, "scripts", "check.mjs")
].filter((file) => !file.endsWith(".py"));

for (const file of syntaxTargets) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().split("\n").slice(0, 4).join(" ");
    fail("syntax", `${path.relative(ROOT, file)}: ${detail}`);
  }
}

// ---- 2. Loading: the modules the gateway needs actually import ------------
// A syntax check does not catch a bad named import or a missing file, and
// those surface at the first request instead of at build time. Only modules
// with no side effects are imported: cli.js prints usage and exits when it
// is loaded, so it is covered by the syntax pass above and by the CLI tests.
try {
  execFileSync(
    process.execPath,
    ["-e", "await import('./src/server.js'); await import('./src/control-center.js'); await import('./src/workbuddy.js');"],
    { cwd: ROOT, stdio: "pipe", timeout: 60_000 }
  );
} catch (error) {
  const detail = String(error.stderr || error.message).trim().split("\n").slice(0, 6).join(" ");
  fail("import", `src entry points do not load: ${detail}`);
}

// ---- 3. Dependencies: package.json and the lockfile agree ------------------
// A range in the lockfile that does not match the pin in package.json is how
// a reinstall silently drifts to a version nobody reviewed — the exact
// failure that broke the gateway when the auth plugin moved to 0.1.34.
try {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(await fs.readFile(path.join(ROOT, "package-lock.json"), "utf8"));
  const rootDeps = lock.packages?.[""]?.dependencies || {};
  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    if (rootDeps[name] === undefined) {
      fail("deps", `${name} is in package.json but not in the lockfile root`);
      continue;
    }
    if (rootDeps[name] !== spec) {
      fail("deps", `${name}: package.json says ${spec}, lockfile root says ${rootDeps[name]}`);
    }
    const resolved = lock.packages?.[`node_modules/${name}`]?.version;
    if (resolved && /^\d/.test(spec) && resolved !== spec) {
      fail("deps", `${name}: pinned ${spec} but the lockfile installed ${resolved}`);
    }
  }
  for (const name of Object.keys(rootDeps)) {
    if (!(name in (pkg.dependencies || {}))) {
      fail("deps", `${name} is in the lockfile root but not in package.json`);
    }
  }
} catch (error) {
  fail("deps", `cannot compare manifests: ${error.message}`);
}

// ---- 4. Hygiene: no conflict markers, no stray debug output --------------
for (const file of syntaxTargets) {
  const text = await fs.readFile(file, "utf8");
  const relative = path.relative(ROOT, file);
  if (/^<{7} |^={7}$|^>{7} /m.test(text)) fail("hygiene", `${relative}: merge conflict markers`);
  // console.log in shipped source is noise in the packaged app's log. The
  // CLI is the exception: printing usage is its whole job.
  const isCli = relative === path.join("src", "cli.js");
  if (!isCli && relative.startsWith(`src${path.sep}`) && /^\s*console\.log\(/m.test(text)) {
    fail("hygiene", `${relative}: console.log in src`);
  }
}

// ---- report ---------------------------------------------------------------
if (failures.length) {
  console.error(`check failed with ${failures.length} finding(s):\n`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`check passed: ${syntaxTargets.length} files parsed, imports load, manifests agree`);
