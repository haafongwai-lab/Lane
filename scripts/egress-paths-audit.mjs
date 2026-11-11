#!/usr/bin/env node
/**
 * Lists every request path the vendored plugins can reach, and compares it
 * with the baseline Lane ships.
 *
 * The host audit (`egress-audit.mjs`) answers "which server". This answers
 * "which door": a plugin that starts posting to a path no upstream uses is how
 * an exfiltration endpoint looks when it rides a host that is already trusted.
 *
 *   node scripts/egress-paths-audit.mjs            # report
 *   node scripts/egress-paths-audit.mjs --write    # update the baseline
 *
 * Exit code 1 means the plugin names a path the baseline does not, which is the
 * moment to look at what changed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathsInSource } from "../src/plugin-source.js";

export { pathsInSource };

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "docs/egress-paths-baseline.txt");
const PLUGINS = [
  path.join(ROOT, "vendor/workbuddy-auth/index.mjs"),
  path.join(ROOT, "vendor/trae-auth/index.mjs"),
  path.join(ROOT, "vendor/qoder-auth/index.mjs")
];

export function pluginPaths(files = PLUGINS) {
  const paths = new Set();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const value of pathsInSource(text)) paths.add(value);
  }
  return paths;
}

export function readBaseline(file = BASELINE) {
  try {
    return new Set(
      fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

export function newPaths(paths, baseline) {
  return [...paths].filter((value) => !baseline.has(value)).sort();
}

function writeBaseline(paths) {
  const lines = [
    "# Endpoint paths the vendored plugins name, as recorded from their source.",
    "# Regenerate with: node scripts/egress-paths-audit.mjs --write",
    "# Review every addition: a path no upstream uses is the shape of a leak.",
    ""
  ];
  for (const value of [...paths].sort()) lines.push(value);
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, `${lines.join("\n")}\n`, "utf8");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const paths = pluginPaths();
  if (process.argv.includes("--write")) {
    writeBaseline(paths);
    console.log(`baseline written: ${paths.size} path(s) -> ${path.relative(ROOT, BASELINE)}`);
  } else {
    const baseline = readBaseline();
    const added = newPaths(paths, baseline);
    console.log(`plugin paths: ${paths.size}, baseline: ${baseline.size}`);
    if (!added.length) {
      console.log("no path outside the baseline");
    } else {
      console.log("\npaths NOT in the baseline:");
      for (const value of added) console.log(`  ${value}`);
      console.log("\nReview each one, then rerun with --write.");
      process.exitCode = 1;
    }
  }
}
