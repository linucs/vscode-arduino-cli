#!/usr/bin/env node
/**
 * Build-time guard for localization integrity. Catches the failure classes that
 * the type-checker and bundler cannot see:
 *
 *  1. Invalid JSON in package.json / NLS files / l10n bundles (e.g. smart quotes
 *     used as delimiters — which silently breaks ALL runtime translations).
 *  2. Duplicate keys in an l10n bundle (JSON.parse keeps only the last).
 *  3. Runtime strings — every `vscode.l10n.t("…")` key in src/ must exist in
 *     l10n/bundle.l10n.it.json.
 *  4. Manifest strings — every `%key%` in package.json must exist in both
 *     package.nls.json and package.nls.it.json.
 *
 * Exits non-zero with a clear report on any violation.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const errors = [];

/** Parse JSON, recording a fatal error (and returning undefined) on failure. */
function readJson(rel) {
  const abs = path.join(ROOT, rel);
  const raw = fs.readFileSync(abs, "utf8");
  try {
    return { raw, data: JSON.parse(raw) };
  } catch (e) {
    errors.push(`${rel}: invalid JSON — ${e.message}`);
    return undefined;
  }
}

/** Find duplicate top-level-ish keys by scanning raw text (one key per line). */
function findDuplicateKeys(rel, raw) {
  const seen = new Set();
  const re = /^\s*"((?:\\.|[^"\\])*)"\s*:/gm;
  let m;
  while ((m = re.exec(raw))) {
    const key = m[1];
    if (seen.has(key)) {
      errors.push(`${rel}: duplicate key "${key}"`);
    }
    seen.add(key);
  }
}

/** Recursively list .ts files under a directory. */
function listTs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTs(p));
    } else if (entry.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Extract the first-argument string literals of every vscode.l10n.t(...) call. */
function extractL10nKeys(src) {
  const keys = [];
  const re = /l10n\.t\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(src))) {
    keys.push(m[2].replace(/\\(["'])/g, "$1"));
  }
  return keys;
}

// 1 + 2: JSON validity (+ duplicate keys for the l10n bundles).
const jsonFiles = [
  "package.json",
  "package.nls.json",
  "package.nls.it.json",
];
for (const f of fs.readdirSync(path.join(ROOT, "l10n"))) {
  if (f.endsWith(".json")) {
    jsonFiles.push(path.join("l10n", f));
  }
}
const parsed = {};
for (const rel of jsonFiles) {
  const r = readJson(rel);
  if (r) {
    parsed[rel] = r.data;
    if (rel.startsWith("l10n")) {
      findDuplicateKeys(rel, r.raw);
    }
  }
}

// 3: runtime l10n coverage against the Italian bundle.
const bundle = parsed[path.join("l10n", "bundle.l10n.it.json")] || {};
for (const file of listTs(path.join(ROOT, "src"))) {
  for (const key of extractL10nKeys(fs.readFileSync(file, "utf8"))) {
    if (!(key in bundle)) {
      errors.push(
        `${path.relative(ROOT, file)}: missing IT translation for "${key}"`,
      );
    }
  }
}

// 4: manifest %key% references must resolve in both NLS files.
const pkgRaw = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
const nlsEn = parsed["package.nls.json"] || {};
const nlsIt = parsed["package.nls.it.json"] || {};
const refSeen = new Set();
for (const m of pkgRaw.matchAll(/%([\w.]+)%/g)) {
  const key = m[1];
  if (refSeen.has(key)) {
    continue;
  }
  refSeen.add(key);
  if (!(key in nlsEn)) {
    errors.push(`package.json: %${key}% missing from package.nls.json`);
  }
  if (!(key in nlsIt)) {
    errors.push(`package.json: %${key}% missing from package.nls.it.json`);
  }
}

if (errors.length) {
  console.error(`l10n check failed (${errors.length}):`);
  for (const e of errors) {
    console.error(`  ✗ ${e}`);
  }
  process.exit(1);
}
console.log("l10n check passed");
