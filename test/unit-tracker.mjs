// JA_TRACKER unit tests (node-only, no browser): per-field classification into the
// pathTaken taxonomy, application upsert + dedup, the multi-page final-page submit rule,
// break capture + auto-clear, per-ATS aggregates, filters, and fixture export.
//
//   node test/unit-tracker.mjs
import path from "node:path";
import { EXT, makeChecker, summarize } from "./harness.mjs";

const require2 = (await import("node:module")).createRequire(import.meta.url);
const JA_TRACKER = require2(path.join(EXT, "tracker.js"));
const { results, check } = makeChecker();

const T = 1_000_000; // fixed base ts (Date.now() is banned in workflow land; here just for determinism)

// ---- 1. classify: the pathTaken taxonomy
{
  const c = (f) => JA_TRACKER.classify(f);
  check("config filled → config-deterministic",
    c({ source: "config", status: "filled" }).pathTaken === "config-deterministic");
  check("config filled via actions → dsl-actions",
    c({ source: "config", status: "filled", viaActions: true }).pathTaken === "dsl-actions");
  check("legal filled → legal-verbatim",
    c({ source: "config", status: "filled", isLegalKey: true }).pathTaken === "legal-verbatim");
  check("llm filled → llm-fallback", c({ source: "llm", status: "filled" }).pathTaken === "llm-fallback");
  check("essay filled → llm-fallback (llm-essay source)",
    c({ source: "essay", status: "filled" }).valueSource === "llm-essay" && c({ source: "essay", status: "filled" }).pathTaken === "llm-fallback");
  check("config no-value → manual-null", c({ source: "config", status: "no-value" }).pathTaken === "manual-null");
  check("legal-manual → manual-null", c({ source: "legal", status: "legal-manual", isLegalKey: true }).pathTaken === "manual-null");
}

// ---- 2. break rules
{
  const c = (f) => JA_TRACKER.classify(f);
  const selMiss = c({ source: "config", status: "not-found", hadValue: true });
  check("config hadValue + not-found → selector-miss break", selMiss.isBreak && selMiss.breakKind === "selector-miss");
  check("config NO value + not-found → not a break (user left it blank)",
    !c({ source: "config", status: "not-found", hadValue: false }).isBreak);
  const legalMiss = c({ source: "config", status: "no-option-match", hadValue: true, isLegalKey: true });
  check("legal hadValue + no-option-match → legal-miss break", legalMiss.isBreak && legalMiss.breakKind === "legal-miss");
  const unimpl = c({ source: "config", status: "filled", note: "legacy-best-effort" });
  check("legacy-best-effort filled → unimplemented break", unimpl.isBreak && unimpl.breakKind === "unimplemented");
  const unimpl2 = c({ source: "config", status: "filled", note: "unknown-method:foo" });
  check("unknown-method note → unimplemented break", unimpl2.isBreak && unimpl2.breakKind === "unimplemented");
  const fb = c({ source: "llm", status: "filled", isConfigKey: true });
  check("llm filled a config-declared field → config-fallback break", fb.isBreak && fb.breakKind === "config-fallback");
  check("llm filled a non-config field → not a break", !c({ source: "llm", status: "filled", isConfigKey: false }).isBreak);
  // occurrence-duplicate keys (first_name_2, work_auth_3, veteran_v2_2) never raise a
  // selector-miss break — their absence is expected, not a rot.
  check("_2 occurrence-dup key does NOT raise a break", !c({ source: "config", key: "first_name_2", status: "not-found", hadValue: true }).isBreak);
  check("_v2_2 occurrence-dup key does NOT raise a break", !c({ source: "config", key: "veteran_v2_2", status: "not-found", hadValue: true, isLegalKey: true }).isBreak);
  check("primary _v2 key STILL raises a break", c({ source: "config", key: "veteran_v2", status: "not-found", hadValue: true, isLegalKey: true }).isBreak);
}

// ---- 3. trackingKey
{
  check("jobId is the key when present", JA_TRACKER.trackingKey("lever:acme/123", "https://x") === "lever:acme/123");
  check("no jobId → url origin+path, tracking params + hash stripped",
    JA_TRACKER.trackingKey(null, "https://jobs.x.com/apply/42?utm=a&gclid=z#frag") === "url:https://jobs.x.com/apply/42");
  check("no jobId → a meaningful query param (SPA job id) is KEPT so postings don't collapse",
    JA_TRACKER.trackingKey(null, "https://careers.x.com/apply?jobId=777&utm_source=li") === "url:https://careers.x.com/apply?jobId=777");
  check("no jobId → distinct SPA postings on one path stay distinct",
    JA_TRACKER.trackingKey(null, "https://careers.x.com/apply?jobId=1") !== JA_TRACKER.trackingKey(null, "https://careers.x.com/apply?jobId=2"));
}

// ---- 4. recordRun: create + dedup + cost
{
  const run = (over = {}) => ({
    ts: T, jobId: "gh:acme/1", ats: "Greenhouse", url: "https://boards.greenhouse.io/acme/jobs/1",
    job: { title: "SWE", company: "Acme" }, status: "started", resumeUsed: "cv.pdf", runCost: 0.0021, pages: 0,
    isContinuation: false,
    fields: [
      { source: "config", key: "email", status: "filled", hadValue: true },
      { source: "config", key: "phone", status: "not-found", hadValue: true, selectorsTried: ["//x"], snapshot: { html: "<div>░</div>", scrubbed: true } },
      { source: "legal", key: "gender", status: "filled", isLegalKey: true, hadValue: true },
    ],
    ...over,
  });
  let store = { applications: {}, fillTelemetry: [], breaks: [] };
  let out = JA_TRACKER.recordRun(store, run());
  store = out.store;
  const rec = store.applications["gh:acme/1"];
  check("application created keyed by jobId", !!rec && rec.jobId === "gh:acme/1");
  check("record carries ats/company/title/url/resume", rec.ats === "Greenhouse" && rec.company === "Acme" && rec.title === "SWE" && rec.resumeUsed === "cv.pdf");
  check("first run: no dedup warning", out.dedup.warn === false);
  check("cost recorded", rec.cost === 0.0021);
  check("telemetry: one row per field", store.fillTelemetry.length === 3);
  check("break captured for the failed config field with a snapshot",
    store.breaks.length === 1 && store.breaks[0].canonicalField === "phone" && store.breaks[0].snapshot?.scrubbed === true);

  // second run, same jobId, NOT a continuation → dedup warn + cost accumulates
  out = JA_TRACKER.recordRun(store, run({ ts: T + 5000, runCost: 0.001 }));
  store = out.store;
  check("re-visit (non-continuation) → dedup warns with prior date", out.dedup.warn === true && out.dedup.appliedAt === T);
  check("cost accumulates across runs", Math.abs(store.applications["gh:acme/1"].cost - 0.0031) < 1e-9);
  check("runs counter increments", store.applications["gh:acme/1"].runs === 2);

  // continuation run → no dedup warning
  out = JA_TRACKER.recordRun(store, run({ ts: T + 9000, isContinuation: true }));
  check("continuation run → no dedup warning", out.dedup.warn === false);
}

// ---- 5. multi-page final-page submit rule
{
  const base = { jobId: "wd:co/9", ats: "Workday", url: "https://x.myworkdayjobs.com/9", job: { title: "T", company: "C" }, runCost: 0, fields: [] };
  let store = { applications: {}, fillTelemetry: [], breaks: [] };
  // page 1: has a Continue, no success node → started
  store = JA_TRACKER.recordRun(store, { ...base, ts: T, status: "started", pages: 1, isContinuation: false }).store;
  check("page 1 (intermediate Continue) → status started", store.applications["wd:co/9"].status === "started");
  // page 2: still intermediate → started, must NOT flip to submitted
  store = JA_TRACKER.recordRun(store, { ...base, ts: T + 1000, status: "started", pages: 2, isContinuation: true }).store;
  check("page 2 intermediate → still started (no false submit)", store.applications["wd:co/9"].status === "started");
  // final page: success node visible → submitted
  store = JA_TRACKER.recordRun(store, { ...base, ts: T + 2000, status: "submitted", pages: 3, isContinuation: true }).store;
  const rec = store.applications["wd:co/9"];
  check("final page (success node) → submitted", rec.status === "submitted" && rec.submittedAt === T + 2000);
  check("pages counter reflects the deepest page", rec.pages === 3);
  // a later stray started run must NOT regress a submitted record
  store = JA_TRACKER.recordRun(store, { ...base, ts: T + 3000, status: "started", pages: 1, isContinuation: true }).store;
  check("submitted never regresses to started", store.applications["wd:co/9"].status === "submitted");
}

// ---- 6. break auto-clear when the field later fills (cross-page false positive)
{
  let store = { applications: {}, fillTelemetry: [], breaks: [] };
  // page 1: EEO not on this page yet → selector-miss break
  store = JA_TRACKER.recordRun(store, {
    ts: T, jobId: "wd:co/1", ats: "Workday", url: "u", job: {}, status: "started", runCost: 0, isContinuation: false,
    fields: [{ source: "config", key: "gender", status: "not-found", hadValue: true, isLegalKey: true }],
  }).store;
  check("page-1 missing field logs a break", store.breaks.length === 1);
  // page 2: same field fills → break clears
  store = JA_TRACKER.recordRun(store, {
    ts: T + 1000, jobId: "wd:co/1", ats: "Workday", url: "u", job: {}, status: "started", runCost: 0, isContinuation: true,
    fields: [{ source: "config", key: "gender", status: "filled", hadValue: true, isLegalKey: true }],
  }).store;
  check("field fills on a later page → its stale break auto-clears", store.breaks.length === 0);
}

// ---- 7. aggregates, filters, counts
{
  let store = { applications: {}, fillTelemetry: [], breaks: [] };
  store = JA_TRACKER.recordRun(store, {
    ts: T, jobId: "gh:a/1", ats: "Greenhouse", url: "https://g/a/1", job: { title: "Backend Eng", company: "Alpha" }, status: "submitted", runCost: 0.002, isContinuation: false,
    fields: [{ source: "config", key: "email", status: "filled", hadValue: true }, { source: "config", key: "phone", status: "not-found", hadValue: true }, { source: "llm", key: null, label: "why us", status: "filled" }],
  }).store;
  store = JA_TRACKER.recordRun(store, {
    ts: T + 1000, jobId: "lv:b/2", ats: "Lever", url: "https://l/b/2", job: { title: "Frontend", company: "Beta" }, status: "started", runCost: 0.001, isContinuation: false,
    fields: [{ source: "config", key: "email", status: "filled", hadValue: true }],
  }).store;

  const counts = JA_TRACKER.counts(store);
  check("counts: total/submitted/started", counts.total === 2 && counts.submitted === 1 && counts.started === 1);
  check("counts: totalCost sums per-app cost", Math.abs(counts.totalCost - 0.003) < 1e-9);

  const byAts = JA_TRACKER.aggregateByAts(store);
  const gh = byAts.find((r) => r.ats === "Greenhouse");
  check("aggregate: Greenhouse success rate reflects 1 failed of 3", gh && gh.failed === 1 && gh.fallback === 1 && gh.successRate === Math.round((2 / 3) * 100));
  check("aggregate: weak fields surface the failing key", gh.weakFields.some((f) => f.field === "phone" && f.failCount === 1));

  check("filter by ats", JA_TRACKER.listApplications(store, { ats: "Lever" }).length === 1);
  check("filter by status", JA_TRACKER.listApplications(store, { status: "submitted" }).length === 1);
  check("filter by query (company/title)", JA_TRACKER.listApplications(store, { query: "frontend" }).length === 1);
  check("list sorted by updatedAt desc", JA_TRACKER.listApplications(store)[0].jobId === "lv:b/2");
}

// ---- 8. exportBreak payload
{
  const brk = {
    ats: "Greenhouse", canonicalField: "phone", breakKind: "selector-miss", outcome: "not-found",
    method: "default", ts: T, jobContext: { title: "SWE", company: "Acme" },
    selectorsTried: ["//input[@id='phone']"], snapshot: { html: "<div>░</div>", scrubbed: true },
  };
  const entry = { inputSelectors: [["phone", [{ path: "//input[@id='phone']" }]], ["email", []]] };
  const p = JA_TRACKER.exportBreak(brk, entry);
  check("export: carries ats + canonicalField + kind", p.ats === "Greenhouse" && p.canonicalField === "phone" && p.breakKind === "selector-miss");
  check("export: includes the config entry selector for the key", Array.isArray(p.configEntrySelector) && p.configEntrySelector[0] === "phone");
  check("export: includes attempted selectors + scrubbed snapshot", p.attemptedSelectors.length === 1 && p.domSnapshotScrubbed === "<div>░</div>");
  check("export: suggests a fixture filename that fixture-fill can match", /^greenhouse-phone\.html$/.test(p.fixtureFileName));
}

// ---- 9. tailoredResumeId pass-through (step 4)
{
  const base = {
    jobId: "gh:t/1", ats: "Greenhouse", url: "https://boards.greenhouse.io/t/jobs/1",
    job: { title: "SWE", company: "Tcorp" }, status: "started", runCost: 0, isContinuation: false, pages: 0,
    fields: [{ source: "config", key: "email", status: "filled", hadValue: true }],
  };
  let store = { applications: {}, fillTelemetry: [], breaks: [] };
  // run WITH tailoredResumeId → it's stored on the record
  store = JA_TRACKER.recordRun(store, { ...base, ts: T, tailoredResumeId: "res-abc" }).store;
  check("run with tailoredResumeId sets it on the record", store.applications["gh:t/1"].tailoredResumeId === "res-abc");

  // a later run WITHOUT tailoredResumeId must NOT clobber the set value (uploaded original this time)
  store = JA_TRACKER.recordRun(store, { ...base, ts: T + 1000, isContinuation: true }).store;
  check("later run without tailoredResumeId does NOT clobber the set one", store.applications["gh:t/1"].tailoredResumeId === "res-abc");

  // a fresh job with NO tailoredResumeId leaves the field undefined (no 📎tailored chip)
  let store2 = { applications: {}, fillTelemetry: [], breaks: [] };
  store2 = JA_TRACKER.recordRun(store2, { ...base, jobId: "gh:t/2", ts: T }).store;
  check("run without tailoredResumeId leaves it undefined", store2.applications["gh:t/2"].tailoredResumeId === undefined);
}

summarize(results);
