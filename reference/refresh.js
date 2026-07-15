#!/usr/bin/env node
// Regenerates every reference/*.json from the installed reference extension, and
// reports exactly what (if anything) changed since the last extraction.
//
// WHY this works: the extension's config ("remoteConfig.json") ships *bundled inside the
// extension package* and updates via normal Chrome Web Store auto-update — it is NOT a
// live server feed (see docs/01, docs/04). So refreshing = re-reading that bundled file
// after Chrome has auto-updated the extension. No account, no network, no reference-extension API.
//
// USAGE:
//   node reference/refresh.js                 # auto-locate the installed extension
//   node reference/refresh.js /path/to/<version>   # point at a specific version dir
//
// EXIT CODE: 0 if nothing changed, 1 if any asset changed (handy for scripting/CI-ish use).
// Personal, non-redistributed use only (docs/04). Do not commit the outputs publicly.

const fs = require("fs");
const path = require("path");
const os = require("os");

const EXT_ID = "pbanhockgagggenencehbnadejlgchfc";
const OUT_DIR = __dirname;

// --- locate the extension's newest version dir -------------------------------------------
function findVersionDir(argPath) {
  if (argPath) return argPath;
  const bases = [
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Google/Chrome Beta",
    "Library/Application Support/Chromium",
    ".config/google-chrome",
    ".config/chromium",
  ].map((b) => path.join(os.homedir(), b));

  const candidates = [];
  for (const base of bases) {
    let profiles;
    try { profiles = fs.readdirSync(base); } catch { continue; }
    for (const prof of profiles) {
      const extDir = path.join(base, prof, "Extensions", EXT_ID);
      let versions;
      try { versions = fs.readdirSync(extDir); } catch { continue; }
      for (const v of versions) {
        const rc = path.join(extDir, v, "remoteConfig.json");
        if (fs.existsSync(rc)) candidates.push({ dir: path.join(extDir, v), v });
      }
    }
  }
  if (!candidates.length) {
    console.error(
      `Could not find ${EXT_ID}. Is the reference extension installed?\n` +
      `Pass the version dir explicitly: node reference/refresh.js /path/to/<version>`
    );
    process.exit(2);
  }
  candidates.sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));
  return candidates[candidates.length - 1];
}

// --- extract -----------------------------------------------------------------------------
const { dir: verDir, v: version } = findVersionDir(process.argv[2]);
const rcPath = path.join(verDir, "remoteConfig.json");
const cfg = JSON.parse(fs.readFileSync(rcPath, "utf8"));

function pick(keys) {
  const o = {};
  for (const k of keys) o[k] = cfg[k];
  return o;
}

const results = []; // { name, status: 'new'|'unchanged'|'changed', kb, detail }

// Write only what changed; report status. Returns true if the file changed.
function write(name, data, differ) {
  const p = path.join(OUT_DIR, name);
  const next = JSON.stringify(data, null, 1);
  let status = "new", detail = "";
  if (fs.existsSync(p)) {
    const prev = fs.readFileSync(p, "utf8");
    if (prev === next) status = "unchanged";
    else {
      status = "changed";
      detail = differ ? differ(safeParse(prev), data) : "";
    }
  }
  if (status !== "unchanged") fs.writeFileSync(p, next);
  results.push({ name, status, kb: Math.round(Buffer.byteLength(next) / 1024), detail });
  return status !== "unchanged";
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// Per-platform breakdown for the ATS selector library (the one that actually churns).
function diffByKey(oldObj, newObj) {
  const oldK = new Set(Object.keys(oldObj || {}));
  const newK = new Set(Object.keys(newObj || {}));
  const added = [...newK].filter((k) => !oldK.has(k));
  const removed = [...oldK].filter((k) => !newK.has(k));
  const modified = [...newK].filter(
    (k) => oldK.has(k) && JSON.stringify(oldObj[k]) !== JSON.stringify(newObj[k])
  );
  const parts = [];
  if (added.length) parts.push(`+${added.length} added (${added.join(", ")})`);
  if (removed.length) parts.push(`-${removed.length} removed (${removed.join(", ")})`);
  if (modified.length) parts.push(`~${modified.length} modified (${modified.join(", ")})`);
  return parts.join("; ") || "content changed";
}

const exclusions = pick([
  "hiddenTrackedInputLabels", "excludedTrackedInputLabelPatterns",
  "excludedTrackedInputTagNames", "conditionalTrackedInputExclusions",
]);
exclusions.doNotInjectUrls = cfg.render?.urlsExcluded ?? [];

console.log(`Source:  ${rcPath}`);
console.log(`Version: ${version}  ·  ATS platforms: ${Object.keys(cfg.ATS || {}).length}\n`);

write("ats-selectors.json", cfg.ATS, diffByKey);
write("field-taxonomy.json", pick([
  "fieldCategories", "fieldCategoryReadableNames", "fieldNameAliases",
  "fieldDependencies", "trackedInputProfileKeyCorrections",
  "hiddenTrackedInputLabels", "excludedTrackedInputLabelPatterns",
  "excludedTrackedInputTagNames",
]), diffByKey);
write("value-maps.json", pick([
  "countryAbbreviationsToNames", "countryNamesToAbbreviations", "stateAbbreviationsToNames",
]), diffByKey);
write("resume-scoring.json", pick(["resumeScoreCategories", "resumeScoreKeywords", "ResumeScores"]), diffByKey);
write("autofill-exclusions.json", exclusions, diffByKey);
write("board-scrapers.json", cfg.Boards || {}, diffByKey);
write("sample-profile.json", cfg.tutorialCandidateResponse || {}, diffByKey);

// --- report ------------------------------------------------------------------------------
const icon = { new: "✚", unchanged: "·", changed: "✱" };
for (const r of results) {
  const line = `  ${icon[r.status]} ${r.name.padEnd(26)} ${String(r.kb).padStart(5)} KB  ${r.status}`;
  console.log(r.detail ? `${line}\n      → ${r.detail}` : line);
}

const changed = results.filter((r) => r.status !== "unchanged");
console.log();
if (!changed.length) {
  console.log(`✓ No differences. reference/ already matches installed extension ${version}.`);
  process.exit(0);
} else {
  console.log(
    `✱ ${changed.length} file(s) changed: ${changed.map((r) => r.name).join(", ")}.\n` +
    `  (fill-strategies.md is hand-authored — if a fill method broke, see REFRESH.md.)`
  );
  process.exit(1);
}
