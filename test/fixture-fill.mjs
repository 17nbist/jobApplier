// Offline fixture regression suite: run the REAL reference playbooks (loaded from
// reference/ats-selectors.json — never inlined) against captured form DOMs in
// test/fixtures/*.html. Verifies selector RESOLUTION (the right elements get the right
// values) and the legal-verbatim rule on static snapshots; framework behavior (React
// retention etc.) is live-e2e territory.
//
//   node test/live-matrix.mjs     # captures/refreshes the fixtures (live network)
//   node test/fixture-fill.mjs    # this suite (fully offline)
//
// Fixtures double as step-3's regression net: when a live form breaks a selector,
// capture it here and the failure becomes reproducible.
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "test", "fixtures");
const { results, check } = makeChecker();

const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "reference/ats-selectors.json"), "utf8"));
const MAPS = JSON.parse(fs.readFileSync(path.join(ROOT, "reference/value-maps.json"), "utf8"));
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const sandbox = {};
(new Function("globalThis", `${src("profile-schema.js")}\n${src("ai.js")}\nglobalThis.JA_AI=JA_AI;globalThis.JA_SAMPLE_PROFILE=JA_SAMPLE_PROFILE;`))(sandbox);
const { JA_AI, JA_SAMPLE_PROFILE } = sandbox;
const RESOLVED = JA_AI.resolveConfigValues(JA_SAMPLE_PROFILE, { maps: MAPS, resumeFileName: "resume.pdf" });

// The verbatim set every filled LEGAL result must draw from: the resolved value, its
// alts, or a values-map translation of them — all deterministic derivatives of what
// the user typed. Anything outside this set = the engine invented a legal answer.
function verbatimSetFor(key) {
  const spec = RESOLVED.values[key];
  if (!spec) return null;
  const out = new Set([String(spec.v)]);
  for (const a of spec.alts || []) out.add(String(a));
  return out;
}

// Expected per-fixture anchors: fields that MUST resolve when the fixture exists, and
// where they must land. Kept minimal — fixtures vary by company/posting.
const EXPECTATIONS = {
  greenhouse: {
    anchors: [
      { key: "first_name", el: "#first_name" },
      { key: "last_name", el: "#last_name" },
      { key: "email", el: "#email" },
    ],
    minFilled: 4,
  },
  lever: {
    anchors: [{ key: "full_name", el: 'input[name="name"]' }, { key: "email", el: 'input[name="email"]' }],
    minFilled: 3,
  },
  ashbyhq: { anchors: [], minFilled: 2 },
  workable: { anchors: [], minFilled: 2 },
  jobvite: { anchors: [], minFilled: 2 },
  breezyhr: { anchors: [], minFilled: 2 },
  recruitee: { anchors: [], minFilled: 2 },
  teamtailor: { anchors: [], minFilled: 2 },
  smartrecruiters: { anchors: [], minFilled: 2 },
  workday: { anchors: [], minFilled: 0 }, // posting page only (application is login-walled)
};

const fixtures = fs.existsSync(FIX) ? fs.readdirSync(FIX).filter((f) => f.endsWith(".html")) : [];
if (!fixtures.length) {
  console.log("No fixtures captured yet — run `node test/live-matrix.mjs` first.");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const bctx = await browser.newContext({ bypassCSP: true }); // captured pages may embed CSP metas
const page = await bctx.newPage();
await page.route("**/*", (route) => { // fully offline: nothing leaves the machine
  const u = route.request().url();
  if (u.startsWith("file://") || u.startsWith("data:")) return route.continue();
  return route.abort();
});

for (const file of fixtures) {
  const name = file.replace(/\.html$/, "");
  // Break-derived fixtures land as "<ats>-<field>.html" (see JA_TRACKER.exportBreak's
  // fixtureFileName) — match the base ATS before the first dash so the step-3 patchability
  // loop's captured snapshots are pinned here automatically.
  const base = name.split("-")[0];
  const suffixed = base !== name;
  const atsName = Object.keys(CFG).find((k) => k.toLowerCase() === name || k.toLowerCase() === base) || null;
  if (!atsName) { check(`${name}: matching ATS entry exists`, false, "no config entry for fixture name"); continue; }
  // A break fixture is a single field region — relax the whole-form expectations.
  const exp = suffixed ? { anchors: [], minFilled: 1 } : (EXPECTATIONS[name] || { anchors: [], minFilled: 1 });
  if (atsName === "Workday" && exp.minFilled === 0) {
    // Application form is login-walled; the fixture is the posting page. Detection and
    // job-id extraction are covered by live-matrix; nothing to fill offline.
    console.log(`(workday fixture is a posting page — fill skipped by design)`);
    continue;
  }

  await page.goto("file://" + path.join(FIX, file), { waitUntil: "domcontentloaded" });
  // Static snapshots strip scripts, so anchor-style "Add row" buttons that a live form
  // handles in JS become plain links; the engine's clicks must not navigate away from
  // the fixture (in the real extension these buttons are JS-handled, never links).
  await page.evaluate(() => {
    addEventListener("click", (e) => { if (e.target.closest?.("a")) e.preventDefault(); }, true);
    for (const f of document.forms) f.addEventListener("submit", (e) => e.preventDefault(), true);
  });
  await page.addScriptTag({ path: path.join(ROOT, "config-engine.js") });

  const out = await page.evaluate(async ({ entry, atsName, values, maps, anchors }) => {
    JA_CFG.setTimeScale(0.01); // static DOM — waits can't help
    const r = await JA_CFG.runConfigFill(entry, values, {
      atsName, maps,
      files: { resume: { name: "resume.pdf", type: "application/pdf", bytes: [37, 80, 68, 70] } },
    });
    const filled = (r.results || []).filter((x) => x.status === "filled" || x.status === "already-set");
    const anchorChecks = anchors.map(({ key, el }) => {
      const target = document.querySelector(el);
      const res = (r.results || []).find((x) => x.key === key);
      return {
        key, el,
        found: !!target,
        value: target ? (target.value ?? "") : null,
        status: res?.status || "missing",
      };
    });
    return {
      ok: r.ok, reason: r.reason || null,
      filled: filled.map((x) => ({ key: x.key, method: x.method, value: x.value ?? null, chose: x.chose ?? null })),
      anchorChecks,
    };
  }, {
    entry: CFG[atsName], atsName, values: RESOLVED.values, maps: MAPS,
    anchors: exp.anchors,
  });

  check(`${name}: engine ran on fixture`, out.ok === true, out.reason || `${out.filled.length} filled`);
  check(`${name}: ≥${exp.minFilled} fields resolved+filled on static DOM`, out.filled.length >= exp.minFilled,
    out.filled.map((f) => f.key).join(",") || "none");
  for (const a of out.anchorChecks) {
    const gotValue = a.value != null && a.value !== "";
    check(`${name}: ${a.key} → ${a.el} got a value`, a.found && gotValue && a.status === "filled",
      `found=${a.found} status=${a.status} value="${(a.value || "").slice(0, 30)}"`);
  }

  // Legal-verbatim rule on real playbooks: any filled legal key's written value must
  // come from the profile-verbatim set (value, alts, or their values-map translations —
  // checked via `chose` being a real option the conservative matcher accepted).
  const legalKeys = [...JA_AI.CONFIG_LEGAL_KEYS];
  const legalFilled = out.filled.filter((f) => legalKeys.includes(f.key));
  const badLegal = legalFilled.filter((f) => {
    const set = verbatimSetFor(f.key);
    if (!set) return true; // filled a legal key we never resolved a value for → invented
    const written = f.chose ?? f.value;
    // The conservative matcher only clicks options matching a candidate string; accept
    // v/alts or an option label that fold-matches one of them.
    const fold = (s) => String(s || "").toLowerCase().replace(/[/:_\-,.;()?!*&'"’]+/g, " ").replace(/\s+/g, " ").trim();
    return ![...set].some((s) => fold(written) === fold(s) || fold(written).includes(fold(s)) || fold(s).includes(fold(written)));
  });
  check(`${name}: every filled legal field is profile-verbatim`, badLegal.length === 0,
    badLegal.map((f) => `${f.key}="${f.chose ?? f.value}"`).join("; ") || `${legalFilled.length} legal fills, all verbatim`);
}

// ---------------------------------------------------------------- patchability loop proof
// The step-3 loop: hit a break live → capture a SCRUBBED snapshot → it becomes a
// test/fixtures/ pin → the fix is verified offline without the live form. Prove the whole
// round-trip end to end: capture the first_name field region from the greenhouse fixture
// with the sample profile pre-filled, assert the scrub removed the PII, write the snapshot
// to a temp fixtures dir, reload it fresh, and confirm the engine re-resolves + fills it.
if (fixtures.includes("greenhouse.html")) {
  const rawStrings = [];
  for (const sec of ["personal_information", "self_identification"]) {
    for (const v of Object.values(JA_SAMPLE_PROFILE[sec] || {})) if (typeof v === "string" && v.trim()) rawStrings.push(v.trim());
  }
  await page.goto("file://" + path.join(FIX, "greenhouse.html"), { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ path: path.join(ROOT, "config-engine.js") });
  const cap = await page.evaluate(({ values, extra }) => {
    // Simulate a filled form: seed the first_name input with the user's PII, then capture.
    const fn = document.querySelector("#first_name");
    if (fn) fn.setAttribute("value", "Michael");
    const scrubSet = JA_CFG.collectScrubStrings(values, extra);
    const snap = JA_CFG.captureSnapshot(fn, document.querySelector("form, body"), scrubSet);
    return { html: snap?.html || "", scrubbed: snap?.scrubbed || false };
  }, { values: RESOLVED.values, extra: rawStrings });

  check("patchability: capture produced a scrubbed snapshot", cap.scrubbed && cap.html.length > 0, `${cap.html.length} chars`);
  check("patchability: snapshot carries no sample PII", !cap.html.includes("Michael") && !cap.html.includes("mscott@dundermifflin.com"), "clean");

  if (cap.html && !cap.html.includes("Michael")) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ja-fixture-"));
    const tmpFile = path.join(tmpDir, "greenhouse-first-name.html");
    fs.writeFileSync(tmpFile, `<!doctype html><html><body><form id="application-form">${cap.html}</form></body></html>`);
    await page.goto("file://" + tmpFile, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ path: path.join(ROOT, "config-engine.js") });
    const refill = await page.evaluate(async ({ entry, values, maps }) => {
      JA_CFG.setTimeScale(0.01);
      const r = await JA_CFG.runConfigFill(entry, values, { atsName: "Greenhouse", maps });
      const fn = (r.results || []).find((x) => x.key === "first_name");
      return { status: fn?.status || "missing", value: document.querySelector("#first_name")?.value || "" };
    }, { entry: CFG.Greenhouse, values: RESOLVED.values, maps: MAPS });
    check("patchability: the scrubbed snapshot re-loads as a fixture the engine fills",
      refill.status === "filled" && refill.value === "Michael", `status=${refill.status} value="${refill.value}"`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

await browser.close();
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
process.exit(fails.length ? 1 : 0);
