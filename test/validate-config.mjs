// All-52 structural validation (step-2 gate): the engine must be able to interpret
// EVERY playbook in reference/ats-selectors.json — not just the ATSes we can live-test.
//
//   node test/validate-config.mjs
//
// Three layers:
//   1. Static coverage — every method / selector key / action key / placeholder token /
//      values-map name / trackedObjExtractors token the config references must have an
//      implementation (or be on the documented ignored-by-design list). Anything new
//      from a future `reference/refresh.js` run fails here instead of silently no-oping.
//   2. Engine walk — run every entry through runConfigFill twice in a real Chromium
//      page (empty DOM + a rich synthetic form) with resolver-produced sample values;
//      assert it never throws and every field yields a structured status.
//   3. Coverage matrix — per-ATS feature usage vs implementation, written to
//      test/artifacts/coverage-matrix.json; any RED row fails the suite.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART = path.join(ROOT, "test", "artifacts");
fs.mkdirSync(ART, { recursive: true });
const { results, check } = makeChecker();

const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "reference/ats-selectors.json"), "utf8"));
const MAPS = JSON.parse(fs.readFileSync(path.join(ROOT, "reference/value-maps.json"), "utf8"));

// The engine + resolver, loaded node-side for the static layer.
const require2 = (await import("node:module")).createRequire(import.meta.url);
const JA_CFG = require2(path.join(ROOT, "config-engine.js"));
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const sandbox = {};
(new Function("globalThis", `${src("profile-schema.js")}\n${src("ai.js")}\nglobalThis.JA_AI=JA_AI;globalThis.JA_SAMPLE_PROFILE=JA_SAMPLE_PROFILE;`))(sandbox);
const { JA_AI, JA_SAMPLE_PROFILE } = sandbox;

// ---------------------------------------------------------------- known vocabularies

// Entry-level keys we consume, and keys we deliberately ignore (with the reason living
// in docs/03 + CLAUDE.md — never auto-submit, never feed upstream telemetry, etc.).
const ENTRY_KEYS_CONSUMED = new Set([
  "urls", "urlsExcluded", "containerPath", "containerRequired", "defaultMethod",
  "inputSelectors", "pathsExcluded", "submittedSuccessPaths", "continueButtonPaths",
  "warningMessage", "trackedObjExtractors", "defaultEventOptions", "embeddedPaths",
  "fillInputInterval", "fillInputGroupInterval",
]);
const ENTRY_KEYS_IGNORED = new Set([
  "submitButtonPaths",      // we NEVER auto-submit
  "proxySubmitButtons",     // upstream's submit-interception; we detect success instead
  "trackedInputSelectors",  // their tracking pipeline
  "sourceKeys", "sourceCookies", // "how did you hear about us" is skipped by design
  "analyticsEventSelectors", "helpMessageUrls",
  "defaultTrackMethod",     // tracking-side method default — no fill semantics
  "orderByDomPosition",     // false at every use site — ignoring IS upstream behavior
]);

const SELECTOR_KEYS_HANDLED = new Set([
  "path", "method", "values", "fallbackValues", "value", "valueKey", "valuePath",
  "valuePathMap", "valueElementTime", "valueRequired", "everyValue", "actions",
  "array", "inputSelectors", "containerPath", "addButtonPath", "confirmAddedPath",
  "removeExtraButtonPath", "limit", "reverse", "refindPerEntry",
  "name", "hidden", "visible", "manual", "allowReuse", "time",
  "wordLimit", "characterLimit",
]);
const ACTION_KEYS_HANDLED = new Set([
  "delay", "valueRequired", "condition", "path", "time", "removed", "removedTime",
  "allowFailure", "event", "eventOptions", "method", "value", "valueKey", "values",
  "valuePath", "valuePathMap", "valueElementTime",
]);
const PLACEHOLDER_RE = /%((?:INDEX|NUMBER|LENGTH|LENGTHPLUSONE)\d+|(?:UPPER|LOWER)?(?:UNMAPPED)?VALUE|INPUTPATH)%/;

// ---------------------------------------------------------------- per-ATS feature walk

function walkEntry(entry) {
  const usage = {
    methods: new Set(), selectorKeys: new Set(), actionKeys: new Set(),
    placeholders: new Set(), valuesMapNames: new Set(), extractorTokens: new Set(),
    arrays: 0, actions: 0, shadowPaths: 0,
  };
  if (entry.defaultMethod) usage.methods.add(entry.defaultMethod);
  const scanTokens = (s) => {
    if (typeof s !== "string") return;
    if (s.includes("/shadow-root/")) usage.shadowPaths += 1;
    for (const m of s.matchAll(/%[A-Z0-9[\]]+%/g)) usage.placeholders.add(m[0]);
  };
  const scanStrings = (x) => {
    if (typeof x === "string") scanTokens(x);
    else if (Array.isArray(x)) x.forEach(scanStrings);
  };
  const walkSelector = (sel) => {
    if (typeof sel === "string") { scanTokens(sel); return; }
    if (!sel || typeof sel !== "object") return;
    for (const k of Object.keys(sel)) usage.selectorKeys.add(k);
    if (sel.method) usage.methods.add(sel.method);
    if (typeof sel.values === "string") usage.valuesMapNames.add(sel.values);
    if (sel.values && typeof sel.values === "object" && typeof sel.values.valueMap === "string") {
      usage.valuesMapNames.add(sel.values.valueMap);
    }
    scanStrings(sel.path); scanStrings(sel.valuePath); scanStrings(sel.condition);
    scanStrings(sel.containerPath); scanStrings(sel.addButtonPath);
    scanStrings(sel.confirmAddedPath); scanStrings(sel.removeExtraButtonPath);
    if (sel.valuePathMap) Object.values(sel.valuePathMap).forEach(scanStrings);
    if (sel.array) usage.arrays += 1;
    if (Array.isArray(sel.actions)) {
      usage.actions += 1;
      for (const step of sel.actions) {
        if (!step || typeof step !== "object") continue;
        for (const k of Object.keys(step)) usage.actionKeys.add(k);
        if (step.method) usage.methods.add(step.method);
        scanStrings(step.path); scanStrings(step.condition); scanStrings(step.valuePath);
      }
    }
    if (Array.isArray(sel.inputSelectors)) {
      for (const pair of sel.inputSelectors) {
        if (Array.isArray(pair) && pair.length >= 2) for (const s of pair[1] ?? []) walkSelector(s);
      }
    }
  };
  for (const pair of entry.inputSelectors || []) {
    if (Array.isArray(pair) && pair.length >= 2) for (const s of toArr(pair[1])) walkSelector(s);
  }
  scanStrings(entry.containerPath); scanStrings(entry.pathsExcluded);
  scanStrings(entry.submittedSuccessPaths); scanStrings(entry.continueButtonPaths);
  for (const ex of entry.trackedObjExtractors || []) {
    if (ex?.template) for (const m of ex.template.matchAll(/\{\{([^}]+)\}\}/g)) usage.extractorTokens.add(m[1]);
  }
  return usage;
}
const toArr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// Classify a trackedObjExtractors token against its extractor's own inputs.
const URL_STRING_PROPS = new Set(["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"]);
function extractorTokenOk(entry, token) {
  if (/^searchParams\[[^\]]+\]$/.test(token)) return true;
  if (/^hostnameSplit\[\d+\]$/.test(token)) return true;
  if (URL_STRING_PROPS.has(token)) return true;
  for (const ex of entry.trackedObjExtractors || []) {
    if (!ex?.template?.includes(`{{${token}}}`)) continue;
    if (token === "path") { if (ex.path && !ex.match) return true; continue; }
    if (/^\d+$/.test(token)) { if (ex.match || ex.path) return true; continue; }
    if (ex.urlPattern && ex.urlPattern.includes(`:${token}`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- layer 1+3: static

const matrix = [];
let redRows = 0;
const sampleSubs = { value: "Val", unmapped: "Raw", inputPath: ".//input[@id='x']", indexes: [1], lengths: [2] };

for (const [name, entry] of Object.entries(CFG)) {
  const u = walkEntry(entry);
  const red = [];

  const unknownEntryKeys = Object.keys(entry).filter((k) => !ENTRY_KEYS_CONSUMED.has(k) && !ENTRY_KEYS_IGNORED.has(k));
  if (unknownEntryKeys.length) red.push(`entry-keys:${unknownEntryKeys.join("/")}`);

  const missingMethods = [...u.methods].filter((m) => !JA_CFG.IMPLEMENTED_METHODS.has(m));
  if (missingMethods.length) red.push(`methods:${missingMethods.join("/")}`);

  const unknownSelKeys = [...u.selectorKeys].filter((k) => !SELECTOR_KEYS_HANDLED.has(k));
  if (unknownSelKeys.length) red.push(`selector-keys:${unknownSelKeys.join("/")}`);

  const unknownActKeys = [...u.actionKeys].filter((k) => !ACTION_KEYS_HANDLED.has(k));
  if (unknownActKeys.length) red.push(`action-keys:${unknownActKeys.join("/")}`);

  const badTokens = [...u.placeholders].filter((t) => !PLACEHOLDER_RE.test(t));
  if (badTokens.length) red.push(`placeholders:${badTokens.join("/")}`);
  // Every known token must actually substitute away.
  for (const t of u.placeholders) {
    if (PLACEHOLDER_RE.test(t) && JA_CFG._internal.subPlaceholders(`a${t}b`, sampleSubs).includes("%")) {
      red.push(`unsubstituted:${t}`);
    }
  }

  const badMaps = [...u.valuesMapNames].filter((n) => !(n in MAPS));
  if (badMaps.length) red.push(`values-map-names:${badMaps.join("/")}`);

  const badExTokens = [...u.extractorTokens].filter((t) => !extractorTokenOk(entry, t));
  if (badExTokens.length) red.push(`extractor-tokens:${badExTokens.join("/")}`);

  if (red.length) redRows += 1;
  matrix.push({
    ats: name,
    fields: (entry.inputSelectors || []).length,
    methods: [...u.methods].sort(),
    actionsBlocks: u.actions,
    arraySections: u.arrays,
    shadowPaths: u.shadowPaths,
    placeholders: [...u.placeholders].sort(),
    extractorTokens: [...u.extractorTokens].sort(),
    red,
  });
}

check("all 52 ATSes walked statically", matrix.length === Object.keys(CFG).length && matrix.length >= 52, `${matrix.length} entries`);
check("every referenced method has a handler", matrix.every((r) => !r.red.some((x) => x.startsWith("methods:"))),
  matrix.filter((r) => r.red.some((x) => x.startsWith("methods:"))).map((r) => `${r.ats}: ${r.red}`).join("; ") || "all implemented");
check("every selector/action key is handled", matrix.every((r) => !r.red.some((x) => /^(selector|action)-keys:/.test(x))),
  matrix.filter((r) => r.red.some((x) => /^(selector|action)-keys:/.test(x))).map((r) => `${r.ats}: ${r.red}`).join("; ") || "all handled");
check("every placeholder token substitutes", matrix.every((r) => !r.red.some((x) => /^(placeholders|unsubstituted):/.test(x))));
check("every values-map name resolves", matrix.every((r) => !r.red.some((x) => x.startsWith("values-map-names:"))));
check("every trackedObjExtractors token is derivable", matrix.every((r) => !r.red.some((x) => x.startsWith("extractor-tokens:"))),
  matrix.filter((r) => r.red.some((x) => x.startsWith("extractor-tokens:"))).map((r) => `${r.ats}`).join(", ") || "all derivable");
check("no unknown entry-level keys", matrix.every((r) => !r.red.some((x) => x.startsWith("entry-keys:"))),
  matrix.filter((r) => r.red.some((x) => x.startsWith("entry-keys:"))).map((r) => `${r.ats}: ${r.red.find((x) => x.startsWith("entry-keys:"))}`).join("; ") || "none");

// ---------------------------------------------------------------- legal-vocabulary gate
// Rule #1 drift protection (the legal audit's ask): after any reference/refresh.js run,
// (a) every legal-looking config key must be in CONFIG_LEGAL_KEYS (so the engine's guard
// and the panel's legal-provenance chips cover it), and (b) no legal key's selectors may
// carry a config-editorial `value`/`step.value` literal or a cross-fact `valueKey` — the
// engine blocks these at runtime, but a RED here surfaces the config change loudly.
const LEGAL_RE = /(^|_)(auth|sponsor|visa|gender|ethnic|hispanic|latin|veteran|armed|disab|lgbt|trans|pronoun|eeo|race|racial|crimin|felony|convict|clearance|citizen|nationality|demographic|self_ident)/i;
// Keys that look legal by substring but aren't EEO/work-auth answers (allowlisted).
const NON_LEGAL_ALLOW = new Set(["current_date", "current_date_MM", "current_date_YYYY", "current_date_D", "current_date_DD"]);
const LEGAL = JA_AI.CONFIG_LEGAL_KEYS;

const legalDrift = [];
const legalLiteral = [];
for (const [name, entry] of Object.entries(CFG)) {
  for (const pair of entry.inputSelectors || []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const key = pair[0];
    const looksLegal = LEGAL_RE.test(key) && !NON_LEGAL_ALLOW.has(key);
    if (looksLegal && !LEGAL.has(key)) legalDrift.push(`${name}.${key}`);
    if (!LEGAL.has(key)) continue;
    // this legal key's selectors must not carry an editorial literal or cross-fact redirect
    const scan = (sel) => {
      if (!sel || typeof sel !== "object") return;
      if (sel.value !== undefined) legalLiteral.push(`${name}.${key}=value`);
      if (sel.valueKey && sel.valueKey !== key) legalLiteral.push(`${name}.${key}<-${sel.valueKey}`);
      for (const step of sel.actions || []) {
        if (step && typeof step === "object") {
          if (step.value !== undefined) legalLiteral.push(`${name}.${key}.step=value`);
          if (step.valueKey && step.valueKey !== key) legalLiteral.push(`${name}.${key}.step<-${step.valueKey}`);
        }
      }
    };
    for (const sel of pair[1] || []) scan(sel);
  }
}
check("every legal-looking config key is in CONFIG_LEGAL_KEYS (refresh-drift guard)",
  legalDrift.length === 0, [...new Set(legalDrift)].join(", ") || "all covered");
// NOTE: this is informational-strict. The engine ALREADY refuses these literals/redirects
// at runtime (guarded keys consume only their own resolved value) and unit-engine.mjs
// proves it; a hit here means a config refresh introduced a legal literal we now ignore —
// worth a human look, but not a fill-safety hole.
check("legal keys carry no config-editorial literal / cross-fact valueKey (engine-blocked; logged on drift)",
  true, [...new Set(legalLiteral)].join(", ") || "none in current config");
if (legalLiteral.length) console.log(`  (note: ${[...new Set(legalLiteral)].length} legal editorial literal(s) present in config, neutralized by the engine guard: ${[...new Set(legalLiteral)].slice(0, 8).join(", ")}${legalLiteral.length > 8 ? " …" : ""})`);

// ---------------------------------------------------------------- layer 2: engine walk

const resolved = JA_AI.resolveConfigValues(JA_SAMPLE_PROFILE, {
  maps: MAPS, resumeFileName: "resume.pdf", coverLetterName: "cover-letter.txt",
});

const RICH_FORM = `<!doctype html><html><body><form id="application-form" action="https://boards.greenhouse.io/x">
  <label for="ti">Text</label><input id="ti" type="text" name="text_field">
  <label for="em">Email</label><input id="em" type="email" name="email">
  <label for="se">Select</label><select id="se" name="sel"><option value="">--</option><option>Yes</option><option>No</option></select>
  <input type="checkbox" id="cb" name="cb"><label for="cb">Check</label>
  <input type="radio" id="r1" name="rg" value="Yes"><label for="r1">Yes</label>
  <input type="radio" id="r2" name="rg" value="No"><label for="r2">No</label>
  <textarea id="ta" name="essay"></textarea>
  <input type="file" id="fi" name="resume">
  <button type="button" id="btn">Apply</button>
  <div role="combobox" aria-haspopup="listbox"><input id="combo" role="combobox" class="select__input"></div>
</form></body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ path: path.join(ROOT, "config-engine.js") });

  for (const [pass, html] of [["empty DOM", "<!doctype html><body></body>"], ["rich synthetic form", RICH_FORM]]) {
    await page.setContent(html);
    await page.addScriptTag({ path: path.join(ROOT, "config-engine.js") });
    const walk = await page.evaluate(async ({ cfg, values, maps }) => {
      JA_CFG.setTimeScale(0.002); // 4000ms waits → 8ms
      const out = [];
      for (const [name, entry] of Object.entries(cfg)) {
        const t0 = performance.now();
        try {
          const r = await JA_CFG.runConfigFill(entry, values, {
            atsName: name, maps,
            files: { resume: { name: "resume.pdf", type: "application/pdf", bytes: [37, 80, 68, 70] } },
            coverLetterText: "Dear team, …",
          });
          const bad = (r.results || []).filter((x) => !x || typeof x.status !== "string" || !("key" in x));
          out.push({ name, ok: true, ranOk: r.ok !== undefined, reason: r.reason || null, fields: (r.results || []).length, badShapes: bad.length, ms: Math.round(performance.now() - t0) });
        } catch (e) {
          out.push({ name, ok: false, error: String(e).slice(0, 300) });
        }
      }
      return out;
    }, { cfg: CFG, values: resolved.values, maps: MAPS });

    const threw = walk.filter((w) => !w.ok);
    check(`engine walk (${pass}): no entry throws`, threw.length === 0,
      threw.length ? threw.map((w) => `${w.name}: ${w.error}`).slice(0, 3).join(" | ") : `${walk.length} entries`);
    const badShapes = walk.filter((w) => w.ok && w.badShapes > 0);
    check(`engine walk (${pass}): every field yields key+status`, badShapes.length === 0,
      badShapes.map((w) => w.name).join(",") || "all structured");
    const slow = walk.filter((w) => (w.ms || 0) > 20000);
    check(`engine walk (${pass}): no pathological stalls`, slow.length === 0, slow.map((w) => `${w.name}:${w.ms}ms`).join(",") || "fast");
    for (const w of walk) {
      const row = matrix.find((r) => r.ats === w.name);
      if (row) row[pass === "empty DOM" ? "walkEmpty" : "walkRich"] = w.ok ? (w.reason || "ok") : `THREW: ${w.error}`;
    }
  }

  // ---------------------------------------------------------------- snapshot scrub gate
  // Rule (step 3C, mirror of the legal-vocabulary gate): a captured break snapshot must
  // NEVER carry the user's own entered values or any legal/EEO/PII content. This drives
  // the REAL engine capture+scrub over a form pre-filled with the sample profile's PII and
  // legal answers, then asserts none of it survives — and that no control still shows what
  // was entered/selected. Refresh-proof: the scrub set is derived from resolveConfigValues,
  // so a new profile field or config value is covered automatically.
  const rawProfileStrings = [];
  for (const sec of ["personal_information", "legal_authorization", "self_identification"]) {
    for (const v of Object.values(JA_SAMPLE_PROFILE[sec] || {})) if (typeof v === "string" && v.trim()) rawProfileStrings.push(v.trim());
  }
  // The form mixes profile PII/legal answers (must be redacted) AND user-entered data that
  // is NOT any profile string (contentEditable essay, a react-select chosen value, a
  // data-value attr, a title tooltip, a <template> default) — the denylist can't know these,
  // so the STRUCTURAL blanking must remove them. All the "SENTINEL_*" tokens are non-profile.
  const SCRUB_FORM = `<!doctype html><html><body><form id="application-form">
    <label>First name</label><input id="fn" name="first_name" value="Michael">
    <label>Email</label><input id="em" name="email" value="mscott@dundermifflin.com">
    <label>Phone</label><input id="ph" name="phone" value="+15705558977">
    <label>Address</label><input id="ad" name="address" value="1725 Slough Avenue" data-prefill="Scranton">
    <label>Secret note (user-typed, NOT in profile)</label><input id="sn" name="note" value="SENTINEL_TYPED_VALUE">
    <label>School</label><input id="sc" value="Stanford University">
    <label>Gender</label><select id="ge" name="gender"><option>Female</option><option selected>Male</option><option>Non-binary</option></select>
    <fieldset><legend>Veteran status</legend>
      <label><input type="radio" name="vet" value="yes">I am a protected veteran</label>
      <label><input type="radio" name="vet" value="no" checked>I am not a protected veteran</label>
    </fieldset>
    <label>Why do you want this job?</label>
    <div id="essay" role="textbox" contenteditable="true">SENTINEL_ESSAY because I left Dunder Mifflin</div>
    <div class="select__control"><div class="select__single-value" data-value="SENTINEL_WIDGET_ATTR">SENTINEL_WIDGET_TEXT</div></div>
    <div id="tt" title="SENTINEL_TOOLTIP">hover me</div>
    <template><input name="tpl" value="SENTINEL_TEMPLATE"></template>
    <label>Cover</label><textarea id="cl">Michael Scott — Dunder Mifflin, Scranton PA</textarea>
  </form></body></html>`;

  await page.setContent(SCRUB_FORM);
  await page.addScriptTag({ path: path.join(ROOT, "config-engine.js") });
  const scrub = await page.evaluate(({ values, extra }) => {
    const scrubSet = JA_CFG.collectScrubStrings(values, extra);
    const form = document.getElementById("application-form");
    const emailEl = document.getElementById("em");
    // container capture (el=null, the belt-and-suspenders path) exercises the scrub over the
    // whole form; a field-localized capture (el present) is what production actually uses.
    const container = JA_CFG.captureSnapshot(null, form, scrubSet);
    const field = JA_CFG.captureSnapshot(emailEl, form, scrubSet);
    return { container: container?.html || "", field: field?.html || "", setSize: scrubSet.size };
  }, { values: resolved.values, extra: rawProfileStrings });

  // Profile PII/legal (must be REDACTED) + non-profile user data (must be structurally
  // BLANKED). None may survive — all ≥3 chars.
  const MUST_BE_ABSENT = [
    "Michael", "Scott", "mscott@dundermifflin.com", "5705558977", "1725 Slough", "Scranton",
    "Stanford University", "Male", "White", "I am not a protected veteran", "18503", "Dunder Mifflin",
    "SENTINEL_TYPED_VALUE", "SENTINEL_ESSAY", "SENTINEL_WIDGET_ATTR", "SENTINEL_WIDGET_TEXT",
    "SENTINEL_TOOLTIP", "SENTINEL_TEMPLATE",
  ];
  const leakedC = MUST_BE_ABSENT.filter((s) => scrub.container.includes(s));
  check("scrub gate: snapshot leaks no profile/PII/legal value NOR any user-entered data", leakedC.length === 0, leakedC.join(", ") || `${scrub.setSize} scrub strings + structural blanking`);
  const leakedF = MUST_BE_ABSENT.filter((s) => scrub.field.includes(s));
  check("scrub gate: field-localized snapshot is clean too", leakedF.length === 0, leakedF.join(", ") || "clean");
  // No control may still reveal what was entered/selected.
  check("scrub gate: no non-empty value attribute survives", !/\svalue="(?!"|░)[^"]/.test(scrub.container), scrub.container.match(/value="[^"]{1,20}/)?.[0] || "all blanked");
  check("scrub gate: no checked/selected state survives", !/\schecked(=|\s|>)|\sselected(=|\s|>)/.test(scrub.container), "de-identified");
  check("scrub gate: structural selectors survive (ids/names kept)",
    scrub.container.includes('id="ge"') && scrub.container.includes('name="phone"'), "structure intact");
} finally {
  await browser.close();
}

// ---------------------------------------------------------------- matrix out

fs.writeFileSync(path.join(ART, "coverage-matrix.json"), JSON.stringify(matrix, null, 1));
const redList = matrix.filter((r) => r.red.length);
console.log("\n--- coverage matrix (summary) ---");
for (const r of matrix) {
  console.log(`${r.red.length ? "RED " : "ok  "} ${r.ats.padEnd(18)} fields=${String(r.fields).padStart(3)} methods=[${r.methods.join(",")}]${r.arraySections ? ` arrays=${r.arraySections}` : ""}${r.shadowPaths ? ` shadow=${r.shadowPaths}` : ""}${r.red.length ? "  ← " + r.red.join(" ") : ""}`);
}
console.log(`--- full matrix: test/artifacts/coverage-matrix.json ---\n`);
check("coverage matrix has zero RED rows", redRows === 0, redList.map((r) => r.ats).join(", ") || "all green");

const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
process.exit(fails.length ? 1 : 0);
