// jobApplier application tracker + fill telemetry + breaks backlog (step 3).
//
// PURE data logic — no chrome.* and no DOM. The sidepanel reads three keys from
// chrome.storage.local (applications / fillTelemetry / breaks), hands the current values
// plus one run descriptor to recordRun(), and writes the returned store back. Keeping
// this side-effect-free is what lets test/unit-tracker.mjs drive it in node.
//
// DOM snapshot CAPTURE and the privacy scrub live in config-engine.js (the content side,
// which has the live DOM and the resolved values). By the time a snapshot reaches this
// module it is ALREADY scrubbed — nothing here re-derives or stores raw user values.
// Related: docs/03 build order step 4; the coverageLog this replaces was per-run only.
"use strict";

var JA_TRACKER = (() => {
  const norm = (s) => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  const fold = (s) => norm(s).toLowerCase().replace(/[/:_\-,.;()?!*&'"’]+/g, " ").replace(/\s+/g, " ").trim();
  const round4 = (n) => Math.round((n || 0) * 1e4) / 1e4;

  // Storage caps. chrome.storage.local holds ~10MB; snapshots dominate, so breaks are
  // capped tightest. Telemetry is one small row per field per run.
  const MAX_TELEMETRY = 2000;
  const MAX_BREAKS = 60;
  const MAX_APPS = 500;

  // Outcome buckets shared by classification + the Breaks rule.
  const FAIL_STATUSES = new Set([
    "not-found", "no-option-match", "action-timeout", "error",
    "no-entry-container", "bad-array-value", "mismatch",
  ]);
  const OK_STATUSES = new Set(["filled", "already-set"]);

  // "Second/third occurrence" selector keys (first_name_2, work_auth_3, veteran_v2_2, …):
  // the resolver duplicates a value into them defensively, but these slots are ABSENT on
  // almost every form — a not-found there is expected, not a rotted selector. They'd swamp
  // the Breaks backlog with false positives, so they never raise a selector-miss break
  // (they still count in per-field telemetry). A primary variant like `veteran_v2` (no
  // trailing occurrence digit) is unaffected.
  const isOccurrenceDup = (key) => /_\d+$/.test(String(key || ""));

  // ------------------------------------------------------------------ tracking key
  // Marketing/tracking query params carry no job identity — dropping them prevents the
  // same posting reached via different campaign links from splitting into two records.
  const TRACKING_PARAMS = /^(utm|gh_|ref$|referrer$|source$|src$|fbclid$|gclid$|mc_|_hs|trk$|campaign)/i;

  // The canonical jobId (engine's extractJobId) is the key. LLM-only pages (no ATS
  // playbook, so no extractor) fall back to the URL: pathname PLUS any surviving query
  // params (many SPA career pages put the job id in ?jobId=…), with tracking params
  // stripped — so distinct postings on one static path stay distinct instead of collapsing.
  function trackingKey(jobId, url) {
    if (jobId) return String(jobId);
    try {
      const u = new URL(url);
      const kept = [...u.searchParams.entries()]
        .filter(([k]) => !TRACKING_PARAMS.test(k))
        .sort(([a], [b]) => a.localeCompare(b)); // order-independent
      const q = kept.length ? "?" + kept.map(([k, v]) => `${k}=${v}`).join("&") : "";
      return `url:${u.origin}${u.pathname.replace(/\/+$/, "")}${q}`;
    } catch {
      return `url:${norm(url)}`;
    }
  }

  // ------------------------------------------------------------------ classification
  // One field's fill outcome → the pathTaken taxonomy (docs step 3B):
  //   config-deterministic | dsl-actions | llm-fallback | legal-verbatim | failed | manual-null
  // `f` is the panel's raw per-field record:
  //   { source:"config"|"llm"|"essay"|"file"|"legal", status, method, note, viaActions,
  //     hadValue, isLegalKey, isConfigKey }
  function classify(f) {
    const st = f.status;
    const ok = OK_STATUSES.has(st);
    const failed = FAIL_STATUSES.has(st);
    const unimplemented = /unknown-method:|legacy-best-effort/.test(f.note || "");

    const outcome = ok
      ? (st === "already-set" ? "already-set" : "filled")
      : failed
        ? (st === "action-timeout" ? "timeout" : st)
        : "manual";

    let pathTaken;
    let valueSource;
    if (f.isLegalKey || f.source === "legal") {
      valueSource = "legal-profile";
      pathTaken = ok ? "legal-verbatim" : failed ? "failed" : "manual-null";
    } else if (f.source === "config") {
      valueSource = "profile";
      pathTaken = ok ? (f.viaActions ? "dsl-actions" : "config-deterministic") : failed ? "failed" : "manual-null";
    } else if (f.source === "llm") {
      valueSource = "llm";
      pathTaken = ok ? "llm-fallback" : failed ? "failed" : "manual-null";
    } else if (f.source === "essay") {
      valueSource = "llm-essay";
      pathTaken = ok ? "llm-fallback" : failed ? "failed" : "manual-null";
    } else if (f.source === "file") {
      valueSource = "file";
      pathTaken = ok ? "config-deterministic" : failed ? "failed" : "manual-null";
    } else {
      valueSource = "none";
      pathTaken = ok ? "config-deterministic" : "manual-null";
    }

    // Break rules — the backlog is "which ats-selectors.json entry rotted, per ATS":
    //  - selector-miss: a config key that HAD a profile value but couldn't be placed
    //    (the strong, reliable rot signal).
    //  - unimplemented: a method/path the engine only best-efforts (vocabulary gap).
    //  - config-fallback: a field the LLM path filled that the detected ATS entry ALSO
    //    declares as a config key (config should have covered it → its selector is stale).
    let isBreak = false;
    let breakKind = null;
    if (f.source === "config" && f.hadValue && failed && !isOccurrenceDup(f.key)) {
      isBreak = true;
      breakKind = (f.isLegalKey || f.source === "legal") ? "legal-miss" : "selector-miss";
    } else if (unimplemented && (ok || failed) && !isOccurrenceDup(f.key)) {
      // A "_2"/"_3" dup hitting an unimplemented method is already surfaced on its primary
      // key — don't double-log it to the backlog.
      isBreak = true;
      breakKind = "unimplemented";
    } else if ((f.source === "llm" || f.source === "essay") && ok && f.isConfigKey) {
      isBreak = true;
      breakKind = "config-fallback";
    }

    return { pathTaken, valueSource, outcome, ok, failed, isBreak, breakKind, unimplemented };
  }

  // ------------------------------------------------------------------ run → records
  // A run descriptor from the panel:
  //   { ts, jobId, ats, url, job:{title,company}, status:"started"|"submitted",
  //     resumeUsed, runCost, isContinuation, pages,
  //     fields:[ { source, key, label, status, method, note, viaActions, hadValue,
  //                isLegalKey, isConfigKey, selectorsTried, snapshot } ] }
  // Returns the shaped telemetry rows + break records for this run (no dedup/merge yet).
  function shapeRun(run) {
    const appKey = trackingKey(run.jobId, run.url);
    const telemetry = [];
    const breaks = [];
    const filledKeys = [];
    const summary = emptySummary();

    for (const f of run.fields || []) {
      const c = classify(f);
      const canonicalField = f.key || fold(f.label) || "(unlabeled)";
      summary.total += 1;
      summary.byPath[c.pathTaken] = (summary.byPath[c.pathTaken] || 0) + 1;
      if (c.ok) { summary.filled += 1; filledKeys.push(`${run.ats || null}::${canonicalField}`); }
      else if (c.failed) summary.failed += 1;
      else summary.manual += 1;

      telemetry.push({
        ts: run.ts, appKey, jobId: run.jobId || null, ats: run.ats || null,
        url: run.url || "", label: norm(f.label).slice(0, 120), canonicalField,
        pathTaken: c.pathTaken, method: f.method || null, valueSource: c.valueSource,
        outcome: c.outcome, breakKind: c.breakKind,
      });

      if (c.isBreak) {
        breaks.push({
          id: `${run.ats || "?"}::${canonicalField}::${c.breakKind}`,
          ts: run.ts, appKey, jobId: run.jobId || null, ats: run.ats || null, url: run.url || "",
          label: norm(f.label).slice(0, 120), canonicalField, breakKind: c.breakKind,
          pathTaken: c.pathTaken, outcome: c.outcome, method: f.method || null,
          selectorsTried: (f.selectorsTried || []).slice(0, 20),
          snapshot: f.snapshot && f.snapshot.scrubbed ? f.snapshot : null, // never store an unscrubbed snapshot
          jobContext: { title: norm(run.job?.title).slice(0, 160), company: norm(run.job?.company).slice(0, 120) },
        });
      }
    }
    return { appKey, telemetry, breaks, summary, filledKeys };
  }

  function emptySummary() {
    return { total: 0, filled: 0, failed: 0, manual: 0, byPath: {} };
  }

  // ------------------------------------------------------------------ upsert application
  function upsertApp(apps, run, summary) {
    const key = trackingKey(run.jobId, run.url);
    const prev = apps[key] || null;
    const rec = prev ? { ...prev } : {
      key, jobId: run.jobId || null, ats: run.ats || null,
      company: norm(run.job?.company), title: norm(run.job?.title), url: run.url || "",
      appliedAt: run.ts, status: "started", resumeUsed: null, cost: 0, runs: 0, pages: 0,
      submittedAt: null,
    };
    rec.updatedAt = run.ts;
    // Newer non-empty context wins; identity fields (jobId/ats) only get set, never cleared.
    if (run.jobId) rec.jobId = run.jobId;
    if (run.ats) rec.ats = run.ats;
    if (norm(run.job?.company)) rec.company = norm(run.job.company);
    if (norm(run.job?.title)) rec.title = norm(run.job.title);
    if (run.url) rec.url = run.url;
    if (run.resumeUsed) rec.resumeUsed = run.resumeUsed;
    // Step 4: which approved tailored résumé's bytes were uploaded (only set when tailored
    // bytes actually went to the form). Set-only, never cleared — a later original-résumé
    // run must not erase the record that this job once uploaded a tailored PDF.
    if (run.tailoredResumeId) rec.tailoredResumeId = run.tailoredResumeId;
    rec.cost = round4(rec.cost + (run.runCost || 0));
    rec.runs = (rec.runs || 0) + 1;
    rec.pages = Math.max(rec.pages || 0, run.pages || 0);
    // Status only advances (started → submitted); a later intermediate page never regresses
    // a submitted record. The panel only passes status:"submitted" on a final success node.
    if (run.status === "submitted" && rec.status !== "submitted") {
      rec.status = "submitted";
      rec.submittedAt = run.ts;
    }
    rec.fillSummary = summary; // latest run's shape (cost/runs accumulate; per-field truth is in telemetry)
    apps[key] = rec;
    return { key, rec, existedBefore: !!prev, prevAppliedAt: prev?.appliedAt || null };
  }

  // ------------------------------------------------------------------ recordRun (main)
  // store = { applications:{}, fillTelemetry:[], breaks:[] } (any may be absent).
  // Returns { store, appKey, appRecord, dedup:{warn,appliedAt}, newBreaks }.
  function recordRun(store, run) {
    const applications = { ...(store?.applications || {}) };
    let fillTelemetry = [...(store?.fillTelemetry || [])];
    let breaks = [...(store?.breaks || [])];

    const shaped = shapeRun(run);
    const { key, rec, existedBefore, prevAppliedAt } = upsertApp(applications, run, shaped.summary);

    // Telemetry: append, then trim oldest.
    fillTelemetry.push(...shaped.telemetry);
    if (fillTelemetry.length > MAX_TELEMETRY) fillTelemetry = fillTelemetry.slice(-MAX_TELEMETRY);

    // Breaks: a field that filled OK this run RESOLVES any matching stale break (clears
    // cross-page false positives — a page-2 field that read not-found on page 1). Then
    // upsert this run's breaks, newest wins per (ats+field+kind).
    const filledNow = new Set(shaped.filledKeys);
    breaks = breaks.filter((b) => !filledNow.has(`${b.ats}::${b.canonicalField}`));
    const byId = new Map(breaks.map((b) => [b.id, b]));
    for (const b of shaped.breaks) byId.set(b.id, b); // newer capture replaces older
    breaks = [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_BREAKS);

    // App cap: keep the most-recently-updated.
    let appMap = applications;
    const appList = Object.values(applications);
    if (appList.length > MAX_APPS) {
      appMap = {};
      for (const a of appList.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)).slice(0, MAX_APPS)) appMap[a.key] = a;
    }

    // Dedup: warn only when a DISTINCT prior Autofill already recorded this jobId (not a
    // multi-page continuation of the same application).
    const dedup = existedBefore && !run.isContinuation
      ? { warn: true, appliedAt: prevAppliedAt }
      : { warn: false, appliedAt: null };

    return {
      store: { applications: appMap, fillTelemetry, breaks },
      appKey: key, appRecord: rec, dedup, newBreaks: shaped.breaks,
    };
  }

  // ------------------------------------------------------------------ queries
  function listApplications(store, filters = {}) {
    let list = Object.values(store?.applications || {});
    const f = filters;
    if (f.ats) list = list.filter((a) => a.ats === f.ats);
    if (f.status) list = list.filter((a) => a.status === f.status);
    if (f.since) list = list.filter((a) => (a.appliedAt || 0) >= f.since);
    if (f.query) {
      const q = fold(f.query);
      list = list.filter((a) => fold(`${a.company} ${a.title} ${a.ats} ${a.jobId} ${a.url}`).includes(q));
    }
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function counts(store) {
    const list = Object.values(store?.applications || {});
    const byAts = {};
    let submitted = 0;
    for (const a of list) {
      byAts[a.ats || "—"] = (byAts[a.ats || "—"] || 0) + 1;
      if (a.status === "submitted") submitted += 1;
    }
    const totalCost = round4(list.reduce((s, a) => s + (a.cost || 0), 0));
    return { total: list.length, submitted, started: list.length - submitted, byAts, totalCost };
  }

  // Per-ATS fill health from telemetry: success rate + the fields that most often fail or
  // fall to the LLM (the "which entry rotted" signal, aggregated).
  function aggregateByAts(store) {
    const rows = {};
    for (const t of store?.fillTelemetry || []) {
      const ats = t.ats || "—";
      const r = rows[ats] || (rows[ats] = { ats, total: 0, filled: 0, failed: 0, fallback: 0, fields: {} });
      r.total += 1;
      const ok = t.outcome === "filled" || t.outcome === "already-set";
      const failed = FAIL_STATUSES.has(t.outcome) || t.outcome === "timeout";
      const fallback = t.pathTaken === "llm-fallback";
      if (ok) r.filled += 1;
      if (failed) r.failed += 1;
      if (fallback) r.fallback += 1;
      const fr = r.fields[t.canonicalField] || (r.fields[t.canonicalField] = { field: t.canonicalField, failCount: 0, fallbackCount: 0, total: 0 });
      fr.total += 1;
      if (failed) fr.failCount += 1;
      if (fallback) fr.fallbackCount += 1;
    }
    return Object.values(rows)
      .map((r) => ({
        ats: r.ats, total: r.total, filled: r.filled, failed: r.failed, fallback: r.fallback,
        successRate: r.total ? Math.round((r.filled / r.total) * 100) : 0,
        weakFields: Object.values(r.fields)
          .filter((fr) => fr.failCount || fr.fallbackCount)
          .sort((a, b) => (b.failCount + b.fallbackCount) - (a.failCount + a.fallbackCount))
          .slice(0, 8),
      }))
      .sort((a, b) => b.total - a.total);
  }

  function listBreaks(store, filters = {}) {
    let list = [...(store?.breaks || [])];
    if (filters.ats) list = list.filter((b) => b.ats === filters.ats);
    if (filters.kind) list = list.filter((b) => b.breakKind === filters.kind);
    return list.sort((a, b) => b.ts - a.ts);
  }

  // ------------------------------------------------------------------ fixture export
  // The Copy-JSON payload for one break: everything needed to patch offline WITHOUT the
  // live form — the attempted selectors, the ATS config entry for that key, and the
  // already-scrubbed DOM snapshot that becomes a test/fixtures/ regression pin.
  // `configEntry` is the panel-supplied atsConfig[ats] (may be null if unavailable).
  function exportBreak(breakRec, configEntry) {
    const key = breakRec.canonicalField;
    // repeating/grouping keys arrive as "experience[0].company" — also match the root key.
    const root = String(key).split(/[[.]/)[0];
    let selectorPair = null;
    for (const pair of configEntry?.inputSelectors || []) {
      if (Array.isArray(pair) && (pair[0] === key || pair[0] === root)) { selectorPair = pair; break; }
    }
    const fixtureName = `${(breakRec.ats || "ats").toLowerCase()}-${String(key).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "field"}.html`;
    return {
      _instructions:
        `Break captured locally (never uploaded). Paste this to Claude to patch ` +
        `reference/ats-selectors.json["${breakRec.ats}"] for key "${key}" (or config-engine.js). ` +
        `Save domSnapshot to test/fixtures/${fixtureName} so test/fixture-fill.mjs pins the fix.`,
      ats: breakRec.ats,
      canonicalField: key,
      breakKind: breakRec.breakKind,
      outcome: breakRec.outcome,
      method: breakRec.method,
      capturedAt: new Date(breakRec.ts).toISOString(),
      jobContext: breakRec.jobContext,
      attemptedSelectors: breakRec.selectorsTried || [],
      configEntrySelector: selectorPair,
      fixtureFileName: fixtureName,
      domSnapshotScrubbed: breakRec.snapshot?.html || null,
    };
  }

  return {
    trackingKey, classify, shapeRun, recordRun,
    listApplications, counts, aggregateByAts, listBreaks, exportBreak,
    MAX_TELEMETRY, MAX_BREAKS, MAX_APPS,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = JA_TRACKER;
