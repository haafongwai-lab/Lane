#!/usr/bin/env node
/**
 * Lists every host the vendored plugins can reach, and compares it with the
 * baseline Lane ships.
 *
 * The point is to answer "what did an upgrade add" without reading 4000 lines
 * of plugin source: this walks the plugin files for URL literals and for the
 * site tables that build a host at runtime, then diffs the result against
 * `docs/egress-baseline.txt`.
 *
 *   node scripts/egress-audit.mjs            # report
 *   node scripts/egress-audit.mjs --write    # update the baseline
 *
 * Exit code 1 means the plugin names a host the baseline does not, which is
 * the moment to look at what changed. test/egress.test.js runs the same check
 * so a silent vendor swap cannot land.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "docs/egress-baseline.txt");
const PLUGINS = [
  path.join(ROOT, "vendor/workbuddy-auth/index.mjs"),
  path.join(ROOT, "vendor/trae-auth/index.mjs"),
  path.join(ROOT, "vendor/qoder-auth/index.mjs")
];

const URL_RE = /https?:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z]{2,}[a-zA-Z0-9._/-]*/g;

/** Every hostname a plugin's source names as an absolute URL. */
export function hostsInSource(text) {
  const hosts = new Set();
  for (const match of String(text).matchAll(URL_RE)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase();
      // The plugin READMEs and comments link to GitHub for documentation;
      // that is not traffic the plugin makes.
      if (host === "github.com" || host.endsWith(".github.com")) continue;
      if (host === "registry.npmjs.org" || host === "www.npmjs.com") continue;
      hosts.add(host);
    } catch {}
  }
  return hosts;
}

/** Reads every vendored plugin and returns the union of hosts. */
export function pluginHosts(files = PLUGINS) {
  const hosts = new Set();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const host of hostsInSource(text)) hosts.add(host);
  }
  return hosts;
}

export function readBaseline(file = BASELINE) {
  try {
    return new Set(
      fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter(Boolean)
        .map((line) => line.toLowerCase())
    );
  } catch {
    return new Set();
  }
}

/** Hosts the plugins name that the baseline does not record. */
export function newHosts(hosts, baseline) {
  return [...hosts].filter((host) => !baseline.has(host)).sort();
}

function writeBaseline(hosts) {
  const lines = [
    "# Hosts the vendored plugins can reach, as recorded from their source.",
    "# Regenerate with: node scripts/egress-audit.mjs --write",
    "# Review every addition before committing: a new host is either a provider",
    "# endpoint (add it to src/egress-hosts.js) or a third party (investigate).",
    ""
  ];
  for (const host of [...hosts].sort()) lines.push(host);
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, `${lines.join("\n")}\n`, "utf8");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const hosts = pluginHosts();
  if (process.argv.includes("--write")) {
    writeBaseline(hosts);
    console.log(`baseline written: ${hosts.size} host(s) -> ${path.relative(ROOT, BASELINE)}`);
  } else {
    const baseline = readBaseline();
    const added = newHosts(hosts, baseline);
    console.log(`plugin hosts: ${hosts.size}, baseline: ${baseline.size}`);
    if (!added.length) {
      console.log("no host outside the baseline");
    } else {
      console.log("\nhosts NOT in the baseline:");
      for (const host of added) console.log(`  ${host}`);
      console.log("\nReview each one, then rerun with --write.");
      process.exitCode = 1;
    }
  }
}
