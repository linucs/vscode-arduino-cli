#!/usr/bin/env node
/**
 * Build-time guard for localization integrity. Catches the failure classes that
 * the type-checker and bundler cannot see:
 *
 *  1. Invalid JSON in package.json / NLS files / l10n bundles (e.g. smart quotes
 *     used as delimiters — which silently breaks ALL runtime translations).
 *  2. Duplicate keys in any NLS file or l10n bundle (JSON.parse keeps only the last).
 *  3. Manifest strings — every `%key%` in package.json must exist in the English
 *     base package.nls.json.
 *  4. Manifest parity — every package.nls.<locale>.json must carry EXACTLY the
 *     English key set: no missing translation, no orphaned key. Adding a new
 *     `%key%` therefore fails the build until every language is translated.
 *  5. Runtime strings — every `vscode.l10n.t("…")` key in src/ must exist in
 *     l10n/bundle.l10n.it.json.
 *  6. Runtime parity — every l10n bundle must carry the same key set as the
 *     Italian reference bundle.
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

/** Keys present in `have` but missing from `want` (set difference want \ have). */
function missingFrom(want, have) {
  const has = new Set(Object.keys(have));
  return Object.keys(want).filter((k) => !has.has(k));
}

// Discover every localization file: the English NLS base, its per-locale
// siblings (package.nls.<loc>.json), and the runtime l10n bundles.
const nlsLocaleFiles = fs
  .readdirSync(ROOT)
  .filter((f) => /^package\.nls\..+\.json$/.test(f))
  .sort();
const bundleFiles = fs
  .readdirSync(path.join(ROOT, "l10n"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => path.join("l10n", f))
  .sort();

// 1 + 2: JSON validity, plus duplicate-key detection for every NLS / bundle.
const jsonFiles = ["package.json", "package.nls.json", ...nlsLocaleFiles, ...bundleFiles];
const parsed = {};
for (const rel of jsonFiles) {
  const r = readJson(rel);
  if (r) {
    parsed[rel] = r.data;
    if (rel !== "package.json") {
      findDuplicateKeys(rel, r.raw);
    }
  }
}

const nlsEn = parsed["package.nls.json"] || {};

// 3: manifest %key% references must all resolve in the English NLS base.
// (Locale parity below then guarantees they resolve in every language too.)
const pkgRaw = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
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
}

// 4: manifest NLS parity — every locale file must carry EXACTLY the English
// key set: no missing translations, no orphaned keys left behind.
for (const rel of nlsLocaleFiles) {
  const loc = parsed[rel];
  if (!loc) {
    continue;
  }
  for (const k of missingFrom(nlsEn, loc)) {
    errors.push(`${rel}: missing translation for "${k}"`);
  }
  for (const k of missingFrom(loc, nlsEn)) {
    errors.push(`${rel}: orphan key "${k}" not in package.nls.json`);
  }
}

// 5: runtime l10n coverage — every vscode.l10n.t("…") key in src/ must exist in
// the Italian bundle (the reference locale).
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

// 6: runtime bundle parity — every l10n bundle must carry the same key set as
// the Italian reference bundle (no language silently missing a runtime string).
for (const rel of bundleFiles) {
  const b = parsed[rel];
  if (!b || rel.endsWith("bundle.l10n.it.json")) {
    continue;
  }
  for (const k of missingFrom(bundle, b)) {
    errors.push(`${rel}: missing translation for "${k}"`);
  }
  for (const k of missingFrom(b, bundle)) {
    errors.push(`${rel}: orphan key "${k}" not in bundle.l10n.it.json`);
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
