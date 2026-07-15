// jobApplier sidepanel. Vanilla JS, no build. Talks to content-ats.js over
// tabs.sendMessage, calls OpenRouter via JA_AI (ai.js), persists everything in
// chrome.storage.local. Streaming/paint patterns copied from ../accountabilitymachine.
"use strict";

const RENDER_THROTTLE_MS = 70;
const NATIVE_HOST = "com.nbist.jobapplier";

// labelContains fold — same semantics as content-ats.js/ai.js (isolated JS contexts, no
// shared module without a build step). Used for the cover-letter job-binding check and the
// tracker's config-fallback label correlation.
const norm = (s) => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
const fold = (s) => norm(s).toLowerCase().replace(/[/:_\-,.;()?!*&'"’]+/g, " ").replace(/\s+/g, " ").trim();

let state = { apiKey: "", model: JA_AI.DEFAULT_MODEL, apiBase: "", lastRefresh: null };
let profile = jaEmptyProfile();
let inFlight = false;
let lastCoverLetter = null; // { text, company, url } — job-bound; never crosses postings
let flowState = null; // { tabId, atsName, entry, pages } while a multi-page flow is active
const els = {};
const reportRows = new Map(); // ref -> {chipEl, valEl}

// ---------------------------------------------------------------- ATS config (step 2)
// reference/*.json are read fresh from disk on every load — for an unpacked extension
// a fetch of chrome.runtime.getURL hits the file on disk, so a config refresh needs no
// extension reload, just a cache-buster re-fetch (verified in test/e2e.mjs).
let atsConfig = null;
let valueMaps = null;

async function loadAtsConfig(force = false) {
  if (atsConfig && valueMaps && !force) return { atsConfig, valueMaps };
  const bust = `?t=${Date.now()}`;
  const [cfgRes, mapRes] = await Promise.all([
    fetch(chrome.runtime.getURL("reference/ats-selectors.json") + bust, { cache: "no-store" }),
    fetch(chrome.runtime.getURL("reference/value-maps.json") + bust, { cache: "no-store" }),
  ]);
  if (!cfgRes.ok || !mapRes.ok) throw new Error("could not load reference config");
  atsConfig = await cfgRes.json();
  valueMaps = await mapRes.json();
  return { atsConfig, valueMaps };
}

// resume-scoring.json (the keyword vocabulary + the per-ATS JD XPath playbooks) — loaded
// on demand by the Tailor tab only, same fresh-from-disk pattern as loadAtsConfig.
let resumeScoring = null;
async function loadResumeScoring(force = false) {
  if (resumeScoring && !force) return resumeScoring;
  const res = await fetch(chrome.runtime.getURL("reference/resume-scoring.json") + `?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("could not load reference/resume-scoring.json");
  resumeScoring = await res.json();
  return resumeScoring;
}

const b64FromBytes = (bytes) => {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 0x8000) {
    bin += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};
const b64FromText = (text) => b64FromBytes(new TextEncoder().encode(text));
const bytesFromB64 = (b64) => {
  const bin = atob(b64 || "");
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
};

// ---------------------------------------------------------------- storage

const save = () => chrome.storage.local.set({ state });
const saveProfile = () => chrome.storage.local.set({ profile });

// ---------------------------------------------------------------- output helpers

function bubble(text, cls = "", parent = null) {
  const container = parent || els.applyOut;
  const p = document.createElement("div");
  p.className = `bubble ${cls}`.trim();
  p.innerText = text;
  container.appendChild(p);
  container.scrollTop = container.scrollHeight;
  return p;
}
const note = (t, parent = null) => bubble(t, "note-msg", parent);
const errNote = (t, parent = null) => bubble(t, "error-msg", parent);
const warn = (t, parent = null) => bubble(t, "warn-msg", parent);

// Throttled stream painter: per-token innerText writes are O(n²) on long outputs.
function makePainter(applyFn, container = null) {
  let pending = null;
  let timer = null;
  return (...args) => {
    pending = args;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        applyFn(...pending);
        const c = container || els.applyOut;
        c.scrollTop = c.scrollHeight;
      }, RENDER_THROTTLE_MS);
    }
  };
}

// ---------------------------------------------------------------- spend counter
// Every model call's OpenRouter-billed cost accumulates here: all-time total persists
// in state.spendTotal, the session figure resets with the panel. Visible at all times
// in the Apply header (user requirement — a heavy cycle must show what it costs).
let sessionSpend = 0;
let runCost = 0; // cost of the CURRENT autofill run only — attributed to its application

function renderSpend() {
  const total = state.spendTotal || 0;
  els.spendLine.innerText = `Spend: $${sessionSpend.toFixed(4)} session · $${total.toFixed(4)} total`;
  els.spendLine.title = "OpenRouter-billed cost (usage.cost), summed per call. Reset the total in Settings.";
}

function trackSpend(usage) {
  const cost = JA_AI.usageCost(usage);
  if (cost == null) return;
  sessionSpend += cost;
  runCost += cost; // per-application attribution (reset at the start of each autofill run)
  state.spendTotal = (state.spendTotal || 0) + cost;
  save().catch?.(() => {});
  renderSpend();
}

// One thinking block per model call: collapsible reasoning stream + a summary line that
// carries the usage/cache stats when done, + the no-thinking warning (thinking is a hard
// requirement — a silent provider regression must be visible).
function startThinking(container = null, { onContent = null } = {}) {
  const parent = container || els.applyOut;
  const d = document.createElement("details");
  d.className = "thinking";
  d.innerHTML = "<summary>thinking…</summary><pre></pre>";
  parent.appendChild(d);
  parent.scrollTop = parent.scrollHeight;
  const pre = d.querySelector("pre");
  const paint = makePainter((content, reasoning) => {
    pre.innerText = reasoning || "";
    if (onContent) onContent(content);
  }, parent);
  return {
    el: d,
    onDelta: paint,
    done(res) {
      trackSpend(res?.usage); // every model call runs through a thinking block
      if (res === null || res === undefined) {
        d.querySelector("summary").innerText = "thinking (call failed)";
        return; // the caller reports the error — a no-thinking warning here would mislead
      }
      const extra = JA_AI.usageLine(res.usage);
      d.querySelector("summary").innerText = res.reasoning
        ? `thinking (done${extra ? " · " + extra : ""})`
        : `thinking — none returned${extra ? " · " + extra : ""}`;
      if (!res.reasoning) {
        bubble("⚠ Model returned no thinking — check the model supports reasoning (it is requested on every call).", "warn-msg", parent);
      }
    },
  };
}

// ---------------------------------------------------------------- report table

const CHIPS = {
  "filled":            ["ok", "filled"],
  "already-set":       ["ok", "already set"],
  "filling":           ["pending", "filling…"],
  "mapped":            ["pending", "mapped"],
  "answered":          ["ok", "AI answer"],
  "no-option-match":   ["warn", "no option match"],
  "ambiguous-value":   ["warn", "ambiguous value"],
  "file-skipped":      ["warn", "no stored résumé"],
  "empty-value":       ["pending", "no value"],
  "no-value":          ["pending", "no value"],
  "not-found":         ["muted", "not on this page"], // overridden per-path in setRow
  "no-entry-container":["warn", "row not added"],
  "skipped-by-design": ["muted", "skipped by design"],
  "manual-by-config":  ["warn", "manual (config)"],
  "action-timeout":    ["warn", "widget timeout"],
  "no-file":           ["warn", "no stored file"],
  "needs-file":        ["warn", "no stored file"],
  "bad-array-value":   ["warn", "bad list value"],
  "legal-profile":     ["legal", "legal · from profile"],
  "legal-manual":      ["legal", "legal · fill manually"],
  "mismatch":          ["bad", "label mismatch"],
  "error":             ["bad", "error"],
  "dry-run":           ["pending", "dry run"],
};

// Refs whose value came verbatim from the profile's legal sections — their chips keep
// the legal provenance even after fill progress overwrites the status, so the user can
// see exactly which auto-filled answers are work-auth/EEO ones to double-check.
let legalRefs = new Set();

function renderReport(fields) {
  // Keep cfg: rows — the config table renders separately and stays on screen.
  for (const key of [...reportRows.keys()]) if (!key.startsWith("cfg:")) reportRows.delete(key);
  const table = document.createElement("table");
  table.className = "report";
  for (const f of fields) {
    const tr = table.insertRow();
    const name = tr.insertCell();
    name.innerText = f.label || f.name || f.ref;
    name.title = f.ref;
    const val = tr.insertCell();
    val.className = "val";
    const chipCell = tr.insertCell();
    const chip = document.createElement("span");
    chip.className = "chip pending";
    chip.innerText = "…";
    chipCell.appendChild(chip);
    reportRows.set(f.ref, { chipEl: chip, valEl: val });
  }
  els.applyOut.appendChild(table);
  els.applyOut.scrollTop = els.applyOut.scrollHeight;
}

// Config-pass rows (cfg:key) are created on first progress event — the panel doesn't
// know the entry's key list ahead of the run.
function ensureConfigRow(ref) {
  if (reportRows.has(ref)) return;
  let table = els.applyOut.querySelector("table.report.config");
  if (!table) {
    const head = document.createElement("div");
    head.className = "hint";
    head.innerText = "Config-driven fill (deterministic, no AI):";
    els.applyOut.appendChild(head);
    table = document.createElement("table");
    table.className = "report config";
    els.applyOut.appendChild(table);
  }
  const tr = table.insertRow();
  const name = tr.insertCell();
  name.innerText = ref.slice(4).replace(/_/g, " ");
  name.title = ref;
  const val = tr.insertCell();
  val.className = "val";
  const chipCell = tr.insertCell();
  const chip = document.createElement("span");
  chip.className = "chip pending";
  chip.innerText = "…";
  chipCell.appendChild(chip);
  reportRows.set(ref, { chipEl: chip, valEl: val });
}

function setRow(ref, status, value) {
  if (ref?.startsWith("cfg:")) ensureConfigRow(ref);
  const row = reportRows.get(ref);
  if (!row) return;
  // Unknown statuses render loudly (warn style, raw name) — a silently grey chip would
  // hide emitter/CHIPS drift when new statuses appear.
  let [cls, label] = CHIPS[status] || ["warn", status];
  // On a config row "not found" usually means "field lives on another page/step" —
  // informational, not a failure. On the LLM path it's a real miss.
  if (ref?.startsWith("cfg:") && status === "not-found") {
    [cls, label] = ["muted", "not on this page"]; // config keys often live on another page/step
  } else if (!ref?.startsWith("cfg:") && status === "not-found") {
    [cls, label] = ["bad", "not found"]; // an LLM-path miss is a real failure
  }
  if (legalRefs.has(ref)) {
    if (status === "filled" || status === "already-set") label += " · legal, from profile";
    else if (status === "dry-run") label += " · legal";
    if (status !== "filling") cls = "legal";
  }
  row.chipEl.className = `chip ${cls}`;
  row.chipEl.innerText = label;
  row.chipEl.dataset.status = status; // machine-readable for tests; labels stay cosmetic
  if (value !== undefined) {
    row.valEl.innerText = value;
    row.valEl.title = value;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "JA_FILL_PROGRESS") setRow(msg.ref, msg.status, msg.chose);
});

// ---------------------------------------------------------------- tab targeting & messaging

async function getTargetTabId() {
  const forced = new URLSearchParams(location.search).get("tab");
  if (forced) return Number(forced);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) {
    throw new Error("No scrapeable tab — open the job posting in this window first.");
  }
  return tab.id;
}

async function callContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(e))) throw e;
    // Page loaded before the extension, or a career page outside the declared ATS hosts.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["config-engine.js", "content-ats.js"], // order matters: engine first
      });
    } catch (injectErr) {
      throw new Error(
        `Can't reach this page (${String(injectErr.message).slice(0, 120)}). ` +
        "If it's not a Greenhouse/Lever/Ashby/Workday page, click the jobApplier toolbar icon on that tab first, then retry."
      );
    }
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function updateTargetLine(tabId, schema) {
  let title = "";
  try { title = (await chrome.tabs.get(tabId)).title || ""; } catch { /* tab gone */ }
  const j = schema?.job;
  els.targetInfo.innerText = schema
    ? `${schema.fields.length} fields · ${j.title || title}${j.company ? " @ " + j.company : ""}`
    : title;
}

// ---------------------------------------------------------------- scan / autofill / cover

// `jdConfig` (the matched resume-scoring ResumeScores entry) is forwarded to the content
// script for config-first job-context extraction; undefined = old behavior unchanged.
async function doScan({ quiet = false } = {}, jdConfig) {
  const tabId = await getTargetTabId();
  const resp = await callContent(tabId, { type: "JA_SCRAPE", jdConfig });
  if (!resp?.ok) throw new Error(resp?.error || "scrape failed");
  const scan = { schema: resp.schema, tabId };
  await updateTargetLine(tabId, resp.schema);
  if (!quiet) {
    const legalCount = resp.schema.fields.filter((f) => JA_AI.isLegalField(f)).length;
    note(`Scanned: ${resp.schema.fields.length} fields (${legalCount} legal — will be answered from your profile only). Job: ${resp.schema.job.title || "?"} @ ${resp.schema.job.company || "?"}`);
  }
  return scan;
}

function requireKey() {
  if (!state.apiKey) {
    errNote("No API key set — open Settings and paste your OpenRouter key.");
    return false;
  }
  return true;
}

// Every JA_FILL goes through here so no call site can forget the frame token.
async function sendFill(tabId, schema, instructions) {
  const resp = await callContent(tabId, { type: "JA_FILL", frameToken: schema.frameToken, instructions });
  if (!resp?.ok) throw new Error(resp?.error || "fill failed (page may have re-rendered — rescan)");
  return resp.results;
}

// ---- single source of truth for ATS detection + the canonical job key ---------------
// The jobId is the tracker's primary key AND the tailored-résumé upload key. It MUST be
// computed the SAME way everywhere or the tailor flow keys tailoredResumes[K1] while the
// autofill upload path looks up tailoredResumes[K2] and never finds the approved PDF.
// Two failure modes these helpers close:
//   1. detection drift — doTailor used to detect on tabUrl only (no embedded-ATS probe),
//      doAutofill on schema.url + probe; an embedded (urls:null) Greenhouse would resolve
//      to different ATS entries → different extractors → different jobIds.
//   2. frame/DOM blindness — extractJobId was run PANEL-side against `new URL(schema.url)`,
//      which has no DOM, so any path-based (XPath) extractor silently produced no id, and a
//      top-frame JD swap could feed the wrong frame's URL in. Running it CONTENT-side in the
//      FORM frame (JA_EXTRACT_JOBID) fixes both. Both doTailor and doAutofill now call these.

async function detectAtsForPage(tabId, schema, tabUrl) {
  let detected = null;
  try {
    await loadAtsConfig();
    detected = JA_CFG.detectAts(atsConfig, schema.url) || JA_CFG.detectAts(atsConfig, tabUrl);
    if (!detected) {
      // Embedded-only playbooks (urls: null) detect by container probing on the page.
      const candidates = JA_CFG.buildProbeCandidates(atsConfig);
      const probe = await callContent(tabId, { type: "JA_PROBE_ATS", frameToken: schema.frameToken, candidates });
      if (probe?.name) detected = { name: probe.name, entry: atsConfig[probe.name] };
    }
  } catch (e) {
    warn(`Reference config unavailable (${e.message}) — using the AI path only.`);
  }
  return detected;
}

// Ask the FORM frame (the one that owns schema.url) to compute the canonical jobId against
// its live DOM, then key it with the tracker's trackingKey. Any messaging/DOM error →
// jobId null → a URL-derived key (identical to what the tracker would compute).
async function resolveJobKey(tabId, schema, detected) {
  let jobId = null;
  try {
    const resp = await callContent(tabId, {
      type: "JA_EXTRACT_JOBID", frameToken: schema.frameToken,
      entry: detected?.entry, atsName: detected?.name,
    });
    if (resp?.ok) jobId = resp.jobId ?? null;
  } catch { jobId = null; }
  return { jobId, jobKey: JA_TRACKER.trackingKey(jobId, schema.url) };
}

// Hybrid autofill (docs/03): config-driven fill FIRST for everything the detected
// ATS playbook covers (deterministic, no model call, no cost), then the LLM mapper
// for whatever is left, then one batched answer call for essay questions. Legal
// fields ride the deterministic path in BOTH passes and never reach the model.
async function doAutofill(opts = {}) {
  if (inFlight) return;
  if (!requireKey()) return;
  if (!profile.personal_information?.first_name && !profile.personal_information?.email) {
    errNote("Profile is empty — fill in the Profile tab first (or Load sample to test).");
    return;
  }
  // A doNextPage continuation is the SAME application (no dedup warning, keep appliedAt).
  const isContinuation = opts?.continuation === true;
  runCost = 0; // attribute only this run's model spend to this application
  inFlight = true;
  setBusy(true);
  els.nextPageBtn.hidden = true;
  // Fresh run: retire the previous run's config rows (their table stays visible as
  // history, but new progress must land in a new table).
  legalRefs = new Set();
  for (const k of [...reportRows.keys()]) if (k.startsWith("cfg:")) reportRows.delete(k);
  els.applyOut.querySelectorAll("table.report.config").forEach((t) => t.classList.remove("config"));
  try {
    const { schema, tabId } = await doScan({ quiet: true });
    const dryRun = els.dryRun.checked;

    // Rule #2: career pages only — LinkedIn is never automated, by either path.
    let tabUrl = "";
    try { tabUrl = (await chrome.tabs.get(tabId)).url || ""; } catch { /* tab gone */ }
    if (/linkedin\.com/i.test(schema.url) || /linkedin\.com/i.test(tabUrl)) {
      errNote("LinkedIn is excluded by design (career pages only — Easy-Apply automation is the account-ban vector).");
      return;
    }

    // ---- pass 1: config-driven fill (when this page matches an ATS playbook)
    // Detection + the canonical job key both go through the shared helpers so the tailor
    // flow and this upload path derive the IDENTICAL jobKey for the same posting.
    const detected = await detectAtsForPage(tabId, schema, tabUrl);
    if (detected?.blocked) {
      errNote(`${detected.name} is excluded by design — not filling.`);
      return;
    }
    // Canonical, content-side jobId (form frame, real DOM) — the single source of truth for
    // this run's upload key AND the tracker record key. resp.jobId (below) is only a fallback.
    const { jobId: canonicalJobId, jobKey: uploadJobKey } = await resolveJobKey(tabId, schema, detected);

    const touched = new Set();
    let cfgRan = false;
    let hasContinue = false;
    let successDetected = false;
    let resumeUploaded = false; // an actual résumé file landed on the form (telemetry gate)
    let jobId = canonicalJobId;
    let cfgResults = []; // the config pass's per-field results (tracker telemetry + breaks)
    const cfgCounts = { filled: 0, noValue: 0, notOnPage: 0, other: 0, legalManual: 0 };

    // The generated letter is job-bound: it only rides along when THIS posting is the
    // one it was written for (a "Dear Company A" letter must never reach Company B).
    const letterFor = lastCoverLetter && (
      lastCoverLetter.url === schema.job?.url ||
      (lastCoverLetter.company && fold(lastCoverLetter.company) === fold(schema.job?.company || "")))
      ? lastCoverLetter.text : "";
    const storedResume = (await chrome.storage.local.get("resumeFile")).resumeFile || null;

    // Résumé to UPLOAD for this exact job — an approved tailored PDF (step 4) or the
    // original. Keyed by uploadJobKey (the SAME content-side extractJobId + trackingKey the
    // Tailor tab used via resolveJobKey, so the keys match) and reused at every upload site.
    // Never cross-job (pickUploadResume).
    const tailoredResumes = (await chrome.storage.local.get("tailoredResumes")).tailoredResumes || {};
    const forceOriginal = tailorUseOriginal.has(uploadJobKey);
    const uploadResume = forceOriginal ? storedResume : JA_TAILOR.pickUploadResume(uploadJobKey, tailoredResumes, storedResume);
    const tailoredRec = tailoredResumes[uploadJobKey] || null;
    const usingTailored = !forceOriginal && !!(tailoredRec && tailoredRec.approvedAt) && !!uploadResume && uploadResume.name === tailoredRec.pdfName;
    if (!dryRun && uploadResume) {
      const chip = bubble("", "note-msg");
      chip.textContent = usingTailored ? "résumé: tailored ✓ (approved for this job)" : "résumé: original";
      if (usingTailored) {
        const swap = document.createElement("button");
        swap.className = "copy-btn";
        swap.textContent = "use original instead";
        swap.addEventListener("click", () => {
          tailorUseOriginal.add(uploadJobKey);
          swap.disabled = true;
          warn("Will upload your original PDF for this job — click Autofill again to apply.");
        });
        chip.appendChild(swap);
      }
    }

    if (detected?.entry) {
      note(`ATS detected: ${detected.name} — config-driven fill (${(detected.entry.inputSelectors || []).length} field playbooks)…`);
      if (detected.entry.warningMessage) warn(detected.entry.warningMessage);
      const resolved = JA_AI.resolveConfigValues(profile, {
        maps: valueMaps,
        resumeFileName: storedResume?.name,
        coverLetterName: letterFor ? "cover-letter.txt" : undefined,
      });
      // Legal provenance on config rows: every legal key renders with legal styling,
      // valued or not ("legal — fill manually" must never look like a plain miss).
      for (const k of JA_AI.CONFIG_LEGAL_KEYS) legalRefs.add(`cfg:${k}`);

      const files = {};
      if (uploadResume && !dryRun) files.resume = uploadResume; // {name, type, b64} — tailored (if approved) or the original
      if (letterFor && !dryRun) files.coverLetter = { name: "cover-letter.txt", type: "text/plain", b64: b64FromText(letterFor) };

      const resp = await callContent(tabId, {
        type: "JA_CONFIG_FILL", frameToken: schema.frameToken,
        entry: detected.entry, atsName: detected.name,
        values: resolved.values, maps: valueMaps, files,
        legalKeys: [...JA_AI.CONFIG_LEGAL_KEYS],
        coverLetterText: letterFor, dryRun,
        // step 3C: capture scrubbed break snapshots (never in dry-run). scrubExtra covers
        // raw profile/legal strings the resolver may not emit as config values.
        captureBreaks: !dryRun,
        scrubExtra: profileScrubStrings(profile),
      });
      if (!resp?.ok) {
        warn(`Config fill failed (${resp?.error || "no response"}) — continuing with the AI path.`);
      } else if (!resp.ran) {
        note(`Config fill skipped: ${resp.reason}.`);
        if (jobId == null) jobId = resp.jobId; // canonical is authoritative; resp.jobId only fills a null
      } else {
        cfgRan = true;
        hasContinue = resp.hasContinue;
        successDetected = resp.success;
        if (jobId == null) jobId = resp.jobId; // canonical is authoritative; resp.jobId only fills a null
        cfgResults = resp.results || [];
        for (const r of resp.results || []) {
          const ref = `cfg:${r.key}`;
          if (r.touchedRef) touched.add(r.touchedRef);
          // A real résumé file actually landed on the form (not merely resolved) — gates
          // the resumeUsed/tailoredResumeId telemetry below.
          if ((r.status === "filled" || r.status === "already-set") && r.method === "uploadResume") resumeUploaded = true;
          if (r.status === "filled" || r.status === "already-set") cfgCounts.filled += 1;
          else if (r.status === "no-value") {
            if (legalRefs.has(ref)) { cfgCounts.legalManual += 1; setRow(ref, "legal-manual"); }
            else cfgCounts.noValue += 1;
          } else if (r.status === "not-found") cfgCounts.notOnPage += 1;
          else if (r.status !== "skipped-by-design" && r.status !== "dry-run") cfgCounts.other += 1;
        }
        note(`Config pass: ${cfgCounts.filled} filled · ${cfgCounts.noValue} lacked a profile value · ${cfgCounts.notOnPage} not on this page${cfgCounts.other ? ` · ${cfgCounts.other} failed` : ""}.`);
      }
    } else if (detected === null) {
      note("No ATS playbook matches this page — using the AI field mapper for everything.");
    }

    // ---- pass 2: rescan (config may have opened sections / added rows), then the
    // step-1 LLM path for whatever the config pass didn't land.
    let schema2 = schema;
    if (cfgRan && !dryRun) {
      try {
        ({ schema: schema2 } = await doScan({ quiet: true }));
        // Refs shift when the config pass mutates the DOM (added rows renumber
        // nth-of-type paths) — ask the content script which of the FRESH scrape's refs
        // the config pass touched, instead of trusting scrape-1 ref strings.
        const t2 = await callContent(tabId, { type: "JA_TOUCHED", frameToken: schema2.frameToken });
        if (t2?.ok && Array.isArray(t2.refs)) {
          touched.clear();
          for (const ref of t2.refs) touched.add(ref);
        }
      } catch { /* keep first scrape + scrape-1 refs */ }
    }
    const remaining = schema2.fields.filter((f) => !touched.has(f.ref));
    if (schema2.truncated) warn("Form has more controls than the scrape cap — the rest were skipped.");

    // Single owner of the legal/AI/file routing (rule #1) — no set arithmetic here.
    const parts = JA_AI.partitionFields(remaining, profile);
    renderReport(remaining);
    for (const { field } of parts.legal) legalRefs.add(field.ref);

    const instructions = [];
    for (const { field, value } of parts.legal) {
      if (value) {
        instructions.push({ ref: field.ref, kind: field.kind, expectLabel: field.label, value });
        setRow(field.ref, "legal-profile", value);
      } else {
        setRow(field.ref, "legal-manual");
      }
    }

    // Files the config pass didn't upload: résumé via the resolved upload bytes, if any.
    const uploadResumeLate = uploadResume;
    const resumeFileRefs = new Set(); // AI-path résumé uploads — confirmed filled after sendFill
    for (const f of parts.file) {
      if (uploadResumeLate && /resume|cv\b/i.test(`${f.label} ${f.name} ${f.id}`) && !dryRun) {
        instructions.push({ ref: f.ref, kind: "file", expectLabel: f.label, value: uploadResumeLate.name, file: uploadResumeLate });
        resumeFileRefs.add(f.ref);
        setRow(f.ref, "mapped", uploadResumeLate.name);
      } else {
        setRow(f.ref, "file-skipped");
      }
    }

    let clean = [];
    if (parts.ai.length) {
      note(`Mapping ${parts.ai.length} remaining field(s) with ${state.model || JA_AI.DEFAULT_MODEL}…`);
      const think = startThinking();
      const mapRes = await JA_AI.mapFields(state, parts.ai, schema2.job, profile, { onDelta: think.onDelta });
      think.done(mapRes);
      clean = JA_AI.validateMappings(mapRes.mappings, parts.ai);
      for (const m of clean) setRow(m.ref, "mapped", m.value);
      for (const f of parts.ai) if (!clean.some((m) => m.ref === f.ref)) setRow(f.ref, "empty-value");
      instructions.push(...clean);
    } else if (cfgRan) {
      note("Nothing left for the AI mapper — config covered all mappable fields.");
    }

    if (dryRun) {
      for (const inst of instructions) setRow(inst.ref, "dry-run", inst.value);
      note("Dry run — mapped but nothing filled; not recorded as an application.");
      return;
    }

    let results = instructions.length ? await sendFill(tabId, schema2, instructions) : [];

    // Retry pass: dynamic dropdowns that reported their real options. The miss set goes
    // back through the same partition, so legal fields still never reach the model.
    const misses = results.filter((r) => r.status === "no-option-match" && r.optionsSeen?.length);
    const missFields = misses
      .map((r) => {
        const f = remaining.find((x) => x.ref === r.ref);
        return f ? { ...f, options: r.optionsSeen, optionsSource: "harvested" } : null;
      })
      .filter(Boolean);
    const retryParts = JA_AI.partitionFields(missFields, profile);
    for (const { field } of retryParts.legal) setRow(field.ref, "legal-manual");
    if (retryParts.ai.length) {
      note(`Retrying ${retryParts.ai.length} dropdown(s) with their real option lists…`);
      const retryMap = await JA_AI.mapFields(state, retryParts.ai, schema2.job, profile, {});
      trackSpend(retryMap.usage); // no thinking block on the retry pass
      const retryClean = JA_AI.validateMappings(retryMap.mappings, retryParts.ai);
      if (retryClean.length) results = results.concat(await sendFill(tabId, schema2, retryClean));
    }

    // ---- pass 3: essays. One batched call for open-ended questions the mapper
    // (correctly) declined. Answers land on the form for review — never auto-submitted.
    const answeredRefs = new Set();
    let essayInstructions = [];
    const mappedRefs = new Set(clean.map((m) => m.ref));
    const essayCandidates = parts.ai.filter((f) =>
      !mappedRefs.has(f.ref) && !f.options && !(f.value || "").trim() && // never overwrite user-typed text
      (f.kind === "textarea" ||
        (f.kind === "text" && (/\?\s*$/.test(f.label) || /\b(why|describe|tell us|what interests|how did|explain|anything else|share)\b/i.test(f.label)))));
    const essayish = essayCandidates.slice(0, 12);
    if (essayCandidates.length > essayish.length) {
      warn(`${essayCandidates.length - essayish.length} open-ended question(s) beyond the 12-per-run cap stay manual.`);
    }
    if (essayish.length) {
      note(`Answering ${essayish.length} open-ended question(s) in one batched call…`);
      const think2 = startThinking();
      try {
        const ans = await JA_AI.answerBatch(state, essayish, schema2.job, profile, { onDelta: think2.onDelta });
        think2.done(ans);
        essayInstructions = ans.instructions;
        if (ans.instructions.length) {
          for (const inst of ans.instructions) { setRow(inst.ref, "answered", inst.value); answeredRefs.add(inst.ref); }
          results = results.concat(await sendFill(tabId, schema2, ans.instructions));
        } else {
          note("No answerable open-ended questions (not derivable from your profile).");
        }
      } catch (e) {
        think2.done(null);
        warn(`Essay pass failed: ${e.message} — those fields stay manual.`);
      }
    }

    // ---- flow + summary
    // The page number to record: the success page is the (prior count + 1)th page of the
    // flow; a single-page app is 1. Captured before the success branch clears flowState.
    const priorFlowPages = flowState?.key === (jobId || tabUrl) ? flowState.pages : 0;
    let recordPages = successDetected ? priorFlowPages + 1 : 0;
    if (successDetected) {
      note("🎉 Confirmation page detected — this application appears submitted.");
      flowState = null;
    } else if (hasContinue) {
      // The page counter is per application (keyed by jobId/tab URL) — back-to-back
      // multi-page applications each get a fresh runaway guard.
      const flowKey = jobId || tabUrl;
      const pages = flowState?.key === flowKey ? flowState.pages + 1 : 1;
      recordPages = pages;
      flowState = { tabId, atsName: detected?.name, entry: detected?.entry, key: flowKey, pages };
      if (pages < 10) {
        els.nextPageBtn.hidden = false;
        note("Multi-page application: review this page, then click “Fill next page ▸” to continue.");
      } else {
        warn("Page-flow guard: 10 pages filled for this application — continue manually (rescan to reset).");
        flowState = null;
      }
    } else {
      flowState = null;
    }

    const okStates = new Set(["filled", "already-set"]);
    const filledRefs = new Set(results.filter((r) => okStates.has(r.status)).map((r) => r.ref));
    const attempted = new Set(results.map((r) => r.ref));
    // AI-path résumé upload actually landed → same telemetry gate as the config path.
    for (const ref of resumeFileRefs) if (filledRefs.has(ref)) resumeUploaded = true;
    // Count from the scraped partition only — config legal-manual rows usually ARE
    // these same physical fields (adding cfgCounts.legalManual double-counted them);
    // per-field truth lives in the chips either way.
    const legalManual = parts.legal.filter(
      ({ field, value }) => !value || (attempted.has(field.ref) && !filledRefs.has(field.ref)),
    ).length;
    note(`Done: ${cfgCounts.filled} via config · ${filledRefs.size} via AI/profile · ${answeredRefs.size} essay answer(s) · ${attempted.size - filledRefs.size} skipped/failed · ${legalManual} legal field(s) need manual review. Always review before submitting.`);

    // The tailored bytes counted as "used" ONLY if a résumé file actually uploaded this run.
    const tailoredUploaded = usingTailored && resumeUploaded;
    // Tailored PDF was uploaded → bump its lastUsedAt (LRU) in the same read-modify-write.
    if (tailoredUploaded && !dryRun) {
      try {
        const s = (await chrome.storage.local.get("tailoredResumes")).tailoredResumes || {};
        if (s[uploadJobKey]) { s[uploadJobKey].lastUsedAt = Date.now(); await chrome.storage.local.set({ tailoredResumes: s }); }
      } catch { /* non-fatal: telemetry, not the résumé itself */ }
    }

    // ---- record this application + fill telemetry + breaks (step 3)
    const trackerFields = assembleTrackerFields({
      cfgResults, parts, mappedInstr: clean, essayInstructions,
      results, remaining,
    });
    await recordApplication({
      jobId, ats: detected?.name || null, url: schema2.url || schema.url,
      job: schema2.job, status: successDetected ? "submitted" : "started",
      // resumeUsed/tailoredResumeId only when a résumé file ACTUALLY uploaded (a form with no
      // file field must not claim a résumé was sent) — telemetry accuracy, not upload logic.
      resumeUsed: resumeUploaded ? (uploadResume?.name || null) : null, runCost, pages: recordPages,
      tailoredResumeId: tailoredUploaded ? tailoredRec.id : undefined,
      isContinuation, fields: trackerFields,
    });
  } catch (e) {
    errNote(`Autofill failed: ${e.message}`);
  } finally {
    inFlight = false;
    setBusy(false);
  }
}

// Multi-page flows (Workday, Taleo, …): user-triggered page advance — we never click
// Continue (let alone Submit) without an explicit click here.
async function doNextPage() {
  if (inFlight || !flowState) return;
  inFlight = true;
  setBusy(true);
  els.nextPageBtn.hidden = true;
  let advanced = false;
  try {
    // The flow is pinned to ITS tab — never the currently-active one (the user may be
    // reading another posting; clicking Continue there would advance an unreviewed form).
    let flowTab = null;
    try { flowTab = await chrome.tabs.get(flowState.tabId); } catch { /* closed */ }
    if (!flowTab) { errNote("The application's tab is gone — flow cancelled."); flowState = null; return; }
    const active = await getTargetTabId().catch(() => null);
    if (active !== flowState.tabId) {
      errNote("The multi-page application lives in another tab — switch back to it, then click again.");
      els.nextPageBtn.hidden = false;
      return;
    }
    // Fresh scan: navigation may have re-injected the content script (new frame token).
    const { schema } = await doScan({ quiet: true });
    try {
      const resp = await callContent(flowState.tabId, {
        type: "JA_FLOW", frameToken: schema.frameToken, action: "continue",
        entry: flowState.entry, atsName: flowState.atsName,
      });
      if (!resp?.ok) { errNote(`Continue failed: ${resp?.error || resp?.reason || "?"}`); els.nextPageBtn.hidden = false; return; }
    } catch (e) {
      // A full page load right after the click tears down the message channel — the
      // click itself succeeded. Treat as advanced and let the rescan sort it out.
      if (!/message channel|Receiving end|context invalidated/i.test(String(e))) throw e;
    }
    advanced = true;
    note("Advanced to the next page — filling…");
  } catch (e) {
    errNote(`Continue failed: ${e.message}`);
    els.nextPageBtn.hidden = false;
    return;
  } finally {
    inFlight = false;
    setBusy(false);
  }
  if (advanced) await doAutofill({ continuation: true });
}

// ---------------------------------------------------------------- tracker (step 3)
// Elevates the old per-run coverageLog into persistent, per-FIELD fill telemetry + an
// application record + a Breaks backlog. JA_TRACKER owns the (pure) record shaping; this
// layer reads/writes chrome.storage.local and surfaces the dedup warning.

// Every string the user ever typed into their profile — the DOM-snapshot scrubber must
// redact all of it even when resolveConfigValues didn't emit it as a config value
// (resume_text, salary, notice period, education/experience/project detail, EEO answers).
// Belt-and-suspenders on top of the resolved-values scrub set: walk the WHOLE profile.
function profileScrubStrings(p) {
  const out = [];
  const walk = (node) => {
    if (node == null) return;
    if (typeof node === "string") { if (node.trim()) out.push(node.trim()); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === "object") { for (const v of Object.values(node)) walk(v); }
  };
  walk(p);
  return out;
}

// One classified per-field record per JA_TRACKER field shape, from every fill path in a
// run: the config pass results, plus the LLM/legal/file/essay instructions and their fill
// outcomes. Legal fields are tagged so the tracker never mislabels their provenance.
function assembleTrackerFields({ cfgResults, parts, mappedInstr, essayInstructions, results, remaining }) {
  const fields = [];
  const LEGAL = JA_AI.CONFIG_LEGAL_KEYS;
  const rootKey = (k) => String(k).split(/[[.]/)[0];

  // A config key is "legal" if it's in the canonical set OR its key/label matches the AI
  // legal-refusal patterns (citizenship/clearance/criminal/EEO/… — keys the resolver still
  // fills verbatim but that aren't in CONFIG_LEGAL_KEYS). Keeps telemetry/breaks provenance
  // correct without weakening Rule #1 (the value already came verbatim from the profile).
  const legalConfigKey = (key, label) =>
    LEGAL.has(key) || LEGAL.has(rootKey(key)) ||
    JA_AI.isLegalField({ label: String(label || "").replace(/_/g, " "), name: key, id: "" });

  // Config pass: forward the engine's rich per-field result verbatim (status/method/
  // note/viaActions/hadValue/selectorsTried/snapshot already attached in the engine).
  for (const r of cfgResults) {
    fields.push({
      source: "config", key: r.key, label: r.name || r.key,
      status: r.status, method: r.method || null, note: r.note || null,
      viaActions: !!r.viaActions, hadValue: !!r.hadValue,
      isLegalKey: legalConfigKey(r.key, r.name || r.key),
      selectorsTried: r.selectorsTried || null, snapshot: r.snapshot || null,
    });
  }

  // LLM path (scraped leftovers). Config keys that MISSED with a value this run — used to
  // flag an LLM fill of the same field as a config-fallback break ("config should have
  // covered it").
  const CONFIG_FAIL = new Set(["not-found", "no-option-match", "action-timeout", "error", "no-entry-container", "bad-array-value"]);
  const missedConfigLabels = new Set(
    cfgResults
      .filter((r) => r.hadValue && CONFIG_FAIL.has(r.status))
      .map((r) => fold(String(r.name || r.key).replace(/_/g, " "))),
  );
  const labelByRef = new Map((remaining || []).map((f) => [f.ref, f.label || f.name || f.ref]));
  const statusByRef = new Map((results || []).map((r) => [r.ref, r]));
  const isLegalScrapedRef = new Set((parts?.legal || []).map(({ field }) => field.ref));

  const pushLLM = (ref, source, fallbackStatus, isLegal = false) => {
    const res = statusByRef.get(ref);
    const label = labelByRef.get(ref) || ref;
    const status = res?.status || fallbackStatus;
    const filledOk = status === "filled" || status === "already-set";
    fields.push({
      source, key: null, label,
      status, method: res?.method || null, note: null, viaActions: false,
      hadValue: source !== "file", isLegalKey: isLegal,
      isConfigKey: !isLegal && filledOk && missedConfigLabels.has(fold(String(label).replace(/_/g, " "))),
      selectorsTried: null, snapshot: null,
    });
  };

  const recordedRefs = new Set();
  const pushOnce = (ref, source, fallbackStatus, isLegal = false) => {
    if (recordedRefs.has(ref)) return;
    recordedRefs.add(ref);
    pushLLM(ref, source, fallbackStatus, isLegal);
  };
  for (const { field, value } of parts?.legal || []) pushOnce(field.ref, "legal", value ? "filled" : "legal-manual", true);
  for (const inst of mappedInstr || []) pushOnce(inst.ref, "llm", "empty-value");
  for (const inst of essayInstructions || []) pushOnce(inst.ref, "essay", "empty-value");
  for (const f of parts?.file || []) {
    if (isLegalScrapedRef.has(f.ref)) continue; // a legal upload is already recorded via legal
    pushOnce(f.ref, "file", "file-skipped");
  }
  // AI candidates the mapper/essay pass declined (no mapping, not an essay) are manual-null
  // fields — record them so per-ATS aggregates see the whole scraped surface, not just wins.
  for (const f of parts?.ai || []) pushOnce(f.ref, "llm", "empty-value");
  return fields;
}

async function recordApplication(run) {
  try {
    run.ts = Date.now();
    const store = await chrome.storage.local.get(["applications", "fillTelemetry", "breaks"]);
    const { store: next, dedup, appRecord, newBreaks } = JA_TRACKER.recordRun(store, run);
    await chrome.storage.local.set(next);
    if (dedup.warn) {
      const when = dedup.appliedAt ? new Date(dedup.appliedAt).toLocaleDateString() : "earlier";
      warn(`Heads up: you already applied to this posting (${when}). This is a re-visit — review before submitting again.`);
    }
    if (newBreaks.length) {
      note(`${newBreaks.length} fill break(s) logged to the Breaks backlog (Applications ▸ Breaks) — patch offline, no live form needed.`);
    }
    // If the Applications tab is open, refresh it from the store we just wrote (no re-read).
    if (!document.getElementById("view-applications").hidden) renderApplications(next).catch(() => {});
  } catch (e) {
    warn(`Tracker: could not record this application (${e.message}).`);
  }
}

// ---------------------------------------------------------------- Applications tab UI

let appsSubtab = "list"; // "list" | "breaks"
let appsRenderGen = 0; // bumped each render so an async breaks-render can bail if superseded

// Tiny DOM builder (textContent everywhere — company/title/URL are untrusted page data).
function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue; // never render "undefined"/"null" into an attribute or tooltip
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "title") node.title = v;
    else if (k === "href") { if (/^https?:\/\//i.test(v)) node.setAttribute("href", v); } // no javascript:/data: in the privileged panel
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

const fmtCost = (c) => `$${(c || 0).toFixed(4)}`;
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—");

async function loadTrackerStore() {
  return chrome.storage.local.get(["applications", "fillTelemetry", "breaks"]);
}

async function renderApplications(prefetched) {
  const gen = ++appsRenderGen;
  const store = prefetched || await loadTrackerStore();
  const counts = JA_TRACKER.counts(store);

  // Header counts.
  const atsBits = Object.entries(counts.byAts).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n}`).join(" · ");
  els.appsCounts.innerHTML = "";
  els.appsCounts.append(
    h("div", { class: "apps-count-line" },
      h("strong", { text: `${counts.total}` }), " applications · ",
      h("span", { class: "ok-text", text: `${counts.submitted} submitted` }), " · ",
      `${counts.started} started · `,
      h("span", { title: "Total OpenRouter-billed cost across all recorded applications", text: `${fmtCost(counts.totalCost)} total` })),
    atsBits ? h("div", { class: "hint", text: atsBits }) : null,
  );

  // Populate the ATS filter (preserve current selection).
  const atsSel = els.appsAtsFilter;
  const cur = atsSel.value;
  atsSel.innerHTML = "";
  atsSel.append(h("option", { value: "", text: "All ATSes" }));
  for (const a of Object.keys(counts.byAts).sort()) if (a !== "—") atsSel.append(h("option", { value: a, text: a }));
  atsSel.append(h("option", { value: "—", text: "(no ATS)" }));
  atsSel.value = cur;

  els.appsListPane.hidden = appsSubtab !== "list";
  els.appsBreaksPane.hidden = appsSubtab !== "breaks";
  els.appsListTab.classList.toggle("active", appsSubtab === "list");
  els.appsBreaksTab.classList.toggle("active", appsSubtab === "breaks");

  if (appsSubtab === "list") renderAppList(store);
  else await renderBreaks(store, gen);
}

function renderAppList(store) {
  const sinceDays = Number(els.appsSinceFilter.value) || 0;
  const filters = {
    ats: els.appsAtsFilter.value || "",
    status: els.appsStatusFilter.value || "",
    query: els.appsSearch.value || "",
    since: sinceDays ? Date.now() - sinceDays * 864e5 : 0,
  };
  const list = JA_TRACKER.listApplications(store, filters);
  els.appsList.innerHTML = "";
  if (!list.length) {
    els.appsList.append(h("div", { class: "hint", text: "No applications match — autofill a posting to start your season dashboard." }));
    return;
  }
  for (const a of list) {
    const s = a.fillSummary || {};
    const summaryLine = `${s.filled || 0} filled · ${s.failed || 0} failed · ${s.manual || 0} manual`;
    els.appsList.append(h("div", { class: "app-card" },
      h("div", { class: "app-card-top" },
        h("span", { class: `chip ${a.status === "submitted" ? "ok" : "pending"}`, text: a.status }),
        h("span", { class: "app-title", title: a.title, text: a.title || "(untitled role)" }),
      ),
      h("div", { class: "app-meta" },
        h("span", { text: a.company || "—" }),
        h("span", { class: "sep", text: "·" }),
        h("span", { text: a.ats || "no ATS" }),
        h("span", { class: "sep", text: "·" }),
        h("span", { title: "First recorded", text: fmtDate(a.appliedAt) }),
        a.pages ? h("span", { class: "sep", text: "·" }) : null,
        a.pages ? h("span", { text: `${a.pages}p` }) : null,
      ),
      h("div", { class: "app-meta" },
        h("span", { class: "cost", title: "OpenRouter cost for this application", text: fmtCost(a.cost) }),
        h("span", { class: "sep", text: "·" }),
        h("span", { title: summaryLine, text: summaryLine }),
        a.resumeUsed ? h("span", { class: "sep", text: "·" }) : null,
        a.resumeUsed ? h("span", { class: "muted-text", title: a.resumeUsed, text: "📎 résumé" }) : null,
        a.tailoredResumeId ? h("span", { class: "sep", text: "·" }) : null,
        a.tailoredResumeId ? h("span", { class: "chip ok", title: "A tailored résumé was uploaded for this job", text: "tailored" }) : null,
      ),
      a.url ? h("a", { class: "app-url", href: a.url, target: "_blank", rel: "noreferrer", text: a.url.replace(/^https?:\/\//, "").slice(0, 60) }) : null,
    ));
  }
}

async function renderBreaks(store, gen) {
  const agg = JA_TRACKER.aggregateByAts(store);
  els.breaksAgg.innerHTML = "";
  if (agg.length) {
    for (const r of agg) {
      const weak = r.weakFields.map((f) => `${f.field}${f.failCount ? ` ✗${f.failCount}` : ""}${f.fallbackCount ? ` ↝${f.fallbackCount}` : ""}`).join(", ");
      els.breaksAgg.append(h("div", { class: "agg-row" },
        h("span", { class: "agg-ats", text: r.ats }),
        h("span", { class: `chip ${r.successRate >= 90 ? "ok" : r.successRate >= 70 ? "warn" : "bad"}`, text: `${r.successRate}%` }),
        h("span", { class: "hint", title: `${r.filled}/${r.total} fields filled · ${r.failed} failed · ${r.fallback} to LLM`, text: `${r.total} fields · ${r.failed} failed · ${r.fallback}↝LLM` }),
        weak ? h("div", { class: "agg-weak hint", text: `weak: ${weak}` }) : null,
      ));
    }
  }

  // The breaks list is intentionally NOT filtered by the ATS <select> — that control lives
  // in the (hidden) Applications sub-pane. Per-ATS grouping is the aggregate above.
  const breaks = JA_TRACKER.listBreaks(store);
  els.breaksList.innerHTML = "";
  if (!breaks.length) {
    els.breaksList.append(h("div", { class: "hint", text: "No breaks logged — every field the config was asked to fill landed. 🎉" }));
    return;
  }
  // atsConfig is needed to attach the config entry to the export payload.
  let cfg = null;
  try { ({ atsConfig: cfg } = await loadAtsConfig()); } catch { /* export still works without the entry */ }
  if (gen !== appsRenderGen) return; // a newer render superseded us during the await — don't double-append
  const KIND_LABEL = {
    "selector-miss": ["bad", "selector miss"], "legal-miss": ["legal", "legal miss"],
    "unimplemented": ["warn", "unimplemented"], "config-fallback": ["warn", "config→LLM"],
  };
  for (const b of breaks) {
    const [cls, lbl] = KIND_LABEL[b.breakKind] || ["warn", b.breakKind];
    const copyBtn = h("button", { class: "copy-btn", text: "Copy fix JSON" });
    copyBtn.addEventListener("click", async () => {
      const payload = JA_TRACKER.exportBreak(b, cfg?.[b.ats] || null);
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        copyBtn.textContent = "Copied ✓";
      } catch {
        copyBtn.textContent = "Copy failed — see console";
        console.log("jobApplier break export JSON:\n" + JSON.stringify(payload, null, 2));
      }
      setTimeout(() => (copyBtn.textContent = "Copy fix JSON"), 1500);
    });
    els.breaksList.append(h("div", { class: "break-card" },
      h("div", { class: "app-card-top" },
        h("span", { class: `chip ${cls}`, text: lbl }),
        h("span", { class: "app-title", text: `${b.ats || "?"} · ${b.canonicalField}` }),
      ),
      h("div", { class: "app-meta" },
        h("span", { title: b.label, text: b.label || b.canonicalField }),
        h("span", { class: "sep", text: "·" }),
        h("span", { text: b.outcome }),
        b.method ? h("span", { class: "sep", text: "·" }) : null,
        b.method ? h("span", { text: b.method }) : null,
        h("span", { class: "sep", text: "·" }),
        h("span", { text: fmtDate(b.ts) }),
      ),
      b.selectorsTried?.length ? h("div", { class: "break-sel hint", title: b.selectorsTried.join("\n"), text: `${b.selectorsTried.length} selector(s) tried` }) : null,
      h("div", { class: "app-meta" },
        h("span", { class: b.snapshot ? "ok-text" : "muted-text", text: b.snapshot ? `📄 scrubbed snapshot (${Math.round((b.snapshot.html || "").length / 1024)}KB)` : "no snapshot" }),
        copyBtn,
      ),
    ));
  }
}

async function doCoverLetter() {
  if (inFlight) return;
  if (!requireKey()) return;
  inFlight = true;
  setBusy(true);
  try {
    // Always rescan: a stale scrape would draft the letter for the PREVIOUS job
    // after the tab navigates to a new posting.
    const { schema } = await doScan({ quiet: true });
    const job = schema.job;
    if (!job.description) warn("No job description found on the page — the letter will lean on the title only.");
    note(`Drafting cover letter for ${job.title || "this role"} @ ${job.company || "?"}…`);
    const out = bubble("");
    const think = startThinking(null, { onContent: (c) => { out.innerText = c || ""; } });
    const res = await JA_AI.coverLetter(state, job, profile, { onDelta: think.onDelta });
    think.done(res);
    out.innerText = res.content;
    // Job-bound: doAutofill only uploads/writes this letter on the posting it was
    // drafted for (company/url match) — never onto a different application.
    lastCoverLetter = { text: res.content, company: job.company || "", url: job.url || "" };
    const copy = document.createElement("button");
    copy.className = "copy-btn";
    copy.innerText = "Copy letter";
    copy.onclick = async () => {
      await navigator.clipboard.writeText(res.content);
      copy.innerText = "Copied ✓";
      setTimeout(() => (copy.innerText = "Copy letter"), 1500);
    };
    els.applyOut.appendChild(copy);
  } catch (e) {
    errNote(`Cover letter failed: ${e.message}`);
  } finally {
    inFlight = false;
    setBusy(false);
  }
}

// ---------------------------------------------------------------- Tailor tab (step 4)
// A tailored résumé is a defense-in-depth trust surface, not a magic upgrade: the two
// panes make the "we can't reproduce your layout" cost visible, the diff + audit flags
// make possible fabrication visible, and NOTHING reaches an employer until the user
// approves (pickUploadResume gates the upload on approvedAt). Panel memory only until then.
let tailorPending = null; // { jobKey, jobId, ats, company, title, url, tailored, changes, audit, diff, before, after, pdfB64, pdfName, resumeFile, approved }
const tailorUseOriginal = new Set(); // jobKeys the user forced back to the original PDF this session
let tailorRedConfirmStep = 0; // 0 = idle, 1 = red-flag confirm shown (two-step, no window.confirm)
// Bumped on every new tailor run / UI reset. renderPdfToCanvas captures it and refuses to
// write a canvas (or set data-rendered) once superseded — an in-flight render from a prior
// Tailor/Discard must not repaint the stale PDF over the current one (fire-and-forget races).
let tailorRenderGen = 0;

// Local mirror of ai.js's (module-private) sanitizeProfile: the tailor model must never
// see legal/EEO sections or the raw résumé text — only the structured CV it may reorder.
function sanitizeSourceForTailor(p) {
  const clone = JSON.parse(JSON.stringify(p || {}));
  const legal = typeof JA_PROFILE_SECTIONS !== "undefined"
    ? JA_PROFILE_SECTIONS.filter((s) => s.legal).map((s) => s.key) : [];
  for (const k of [...legal, "legal_authorization", "self_identification"]) delete clone[k];
  delete clone.resume_text;
  return clone;
}

function resetTailorUi() {
  tailorRenderGen += 1; // supersede any fire-and-forget renders still in flight
  for (const id of ["tailorCompare", "tailorDiff", "tailorMeter", "tailorKeywords", "tailorFlags", "tailorConfirm", "tailorActions"]) els[id].hidden = true;
  els.tailorDiffToggle.hidden = true;
  els.tailorDiffToggle.textContent = "Show diff";
  els.tailorDownloadBtn.disabled = true;
  for (const c of [els.tailorCanvasLeft, els.tailorCanvasRight]) {
    c.width = c.width; // clear
    delete c.dataset.rendered;
  }
  tailorRedConfirmStep = 0;
}

async function doTailor() {
  if (inFlight) return;
  if (!requireKey()) return;
  const hasCv = (profile.experience_details?.length || profile.education_details?.length ||
    (profile.resume_text || "").trim() || (profile.skills || "").trim());
  if (!hasCv) {
    tailorSetStatus("Your profile has no résumé content yet — import a PDF or fill the Profile tab first.", true);
    return;
  }
  inFlight = true;
  setBusy(true);
  tailorPending = null;
  resetTailorUi();
  els.tailorOut.innerHTML = "";
  runCost = 0;
  try {
    tailorSetStatus("Scanning the job posting…");
    await loadAtsConfig();
    const scoring = await loadResumeScoring();

    const tabId = await getTargetTabId();
    let tabUrl = "";
    try { tabUrl = (await chrome.tabs.get(tabId)).url || ""; } catch { /* tab gone */ }
    if (/linkedin\.com/i.test(tabUrl)) {
      tailorSetStatus("LinkedIn is excluded by design (career pages only).", true);
      return;
    }

    // Pre-scan URL detect only picks the JD XPath playbook for the scan; the authoritative
    // ATS + job key come from detectAtsForPage/resolveJobKey below (shared with doAutofill).
    const preDetected = JA_CFG.detectAts(atsConfig, tabUrl);
    const jdConfig = preDetected?.name ? scoring.ResumeScores?.[preDetected.name] : undefined;

    let { schema } = await doScan({ quiet: true }, jdConfig);

    // Capture the FORM-frame schema NOW and derive the canonical jobKey from it, BEFORE any
    // top-frame JD swap below. The swap only borrows the top frame's JD *text*; it must never
    // move the key onto the wrong frame's URL. detectAtsForPage + resolveJobKey are the exact
    // helpers doAutofill uses, so for the same posting both flows produce the identical jobKey
    // (single source of truth — see the helpers' header comment).
    const formSchema = schema;
    const detected = await detectAtsForPage(tabId, formSchema, tabUrl);
    const atsName = detected?.name || null;
    const { jobId, jobKey } = await resolveJobKey(tabId, formSchema, detected);

    let jdText = schema.job.description || "";

    // The JD often lives on the TOP frame while the form is in an iframe — retry frame 0
    // before falling back to a paste box. (JD text only; the key stays pinned to formSchema.)
    if (jdText.length < 200) {
      try {
        const top = await chrome.tabs.sendMessage(tabId, { type: "JA_SCRAPE", jdConfig }, { frameId: 0 });
        if (top?.ok && (top.schema?.job?.description || "").length >= 200) { schema = top.schema; jdText = schema.job.description; }
      } catch { /* no top-frame content script — fall through to paste */ }
    }
    if (jdText.length < 200) {
      const pasted = (els.tailorJdInput.value || "").trim();
      if (pasted.length >= 100) { jdText = pasted; }
      else {
        els.tailorJdWrap.hidden = false;
        tailorSetStatus("Couldn't read a job description from the page — paste it below, then Tailor again.", true);
        return;
      }
    }

    // Keyword analysis BEFORE: profile vs JD (scoring caps the JD at 15k so pathological
    // postings don't dominate the match cost; the flag surfaces the truncation).
    const vocab = JA_TAILOR.compileVocabulary(scoring);
    let analyzeJd = jdText, jdTruncated = false;
    if (analyzeJd.length > 15000) { analyzeJd = analyzeJd.slice(0, 15000); jdTruncated = true; }
    const before = JA_TAILOR.analyzeKeywords(vocab, analyzeJd, profile, profile.resume_text || "", jdTruncated);
    const adjacentHints = (before.missing.adjacent || []).slice(0, 15).map((a) => ({ keyword: a.keyword, provenance: a.provenance }));

    tailorSetStatus(`Tailoring for ${schema.job.title || "this role"} @ ${schema.job.company || "?"}…`);
    const think = startThinking(els.tailorOut);
    let res;
    try {
      res = await JA_AI.tailor(state, sanitizeSourceForTailor(profile), { ...schema.job, description: jdText }, adjacentHints, { onDelta: think.onDelta });
    } catch (e) {
      think.done(null);
      throw e;
    }
    think.done(res);

    // Anti-fabrication audit + diff use the FULL profile (auditTailored reads resume_text
    // as part of the source corpus); the AFTER score reuses the same (truncated) JD.
    const audit = JA_TAILOR.auditTailored(profile, res.tailored, res.changes, vocab);
    const diff = JA_TAILOR.buildResumeDiff(profile, res.tailored, res.changes);
    const after = JA_TAILOR.analyzeKeywords(vocab, analyzeJd, res.tailored, profile.resume_text || "");

    // Generate the exact PDF the employer would receive (byte-accurate preview). getBase64's
    // callback can silently never fire (font VFS not ready, worker wedged) — a bare Promise
    // would hang here and leave inFlight/setBusy stuck forever. Reject on a 15s timeout too so
    // the finally below always releases the interlock.
    tailorSetStatus("Rendering the tailored PDF…");
    await loadPdfMake();
    const pdfB64 = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PDF generation timed out")), 15000);
      try {
        pdfMake.createPdf(JA_TAILOR.buildDocDefinition(res.tailored)).getBase64((b64) => { clearTimeout(timer); resolve(b64); });
      } catch (e) { clearTimeout(timer); reject(e); }
    });
    const pdfName = JA_TAILOR.tailoredPdfName(profile.personal_information, schema.job.company);
    const { resumeFile } = await chrome.storage.local.get("resumeFile");

    tailorPending = {
      // url is the FORM frame's URL (formSchema) — the same frame the autofill upload path
      // records — not the post-swap top-frame JD URL.
      jobKey, jobId: jobId || null, ats: atsName, company: schema.job.company || "", title: schema.job.title || "",
      url: formSchema.url || "", tailored: res.tailored, changes: res.changes, audit, diff, before, after,
      pdfB64, pdfName, resumeFile: resumeFile || null, approved: false,
    };
    await renderTailorResult();
    const redN = audit.flags.filter((f) => f.severity === "red").length;
    tailorSetStatus(redN ? `Ready — ${redN} red flag(s) to verify before approving.` : "Ready — review, then Approve.");
  } catch (e) {
    tailorSetStatus(`Tailor failed: ${e.message}`, true);
    errNote(`Tailor failed: ${e.message}`, els.tailorOut);
  } finally {
    inFlight = false;
    setBusy(false);
  }
}

function tailorSetStatus(text, isErr = false) {
  els.tailorStatus.textContent = text;
  els.tailorStatus.classList.toggle("err", isErr);
}

async function renderTailorResult() {
  const t = tailorPending;
  els.tailorCompare.hidden = false;
  els.tailorActions.hidden = false;
  els.tailorDiffToggle.hidden = false;
  els.tailorDiff.hidden = true;
  els.tailorDiffToggle.textContent = "Show diff";

  renderCoverageMeter(t.before, t.after);
  renderKeywordPanel(t.before);
  renderFlagStrip(t.audit);
  renderDiff(t.diff, t.audit); // built now; stays hidden until the toggle
  els.tailorConfirm.hidden = true;

  // RIGHT: the generated tailored PDF (always present). LEFT: the stored original, or a
  // single-pane degrade notice when there's no stored PDF.
  renderPdfToCanvas(t.pdfB64, els.tailorCanvasRight).catch((e) => errNote(`Preview render failed: ${e.message}`, els.tailorOut));
  if (t.resumeFile && t.resumeFile.b64) {
    els.tailorPaneLeft.hidden = false;
    renderPdfToCanvas(t.resumeFile.b64, els.tailorCanvasLeft).catch((e) => errNote(`Original render failed: ${e.message}`, els.tailorOut));
  } else {
    els.tailorPaneLeft.hidden = true;
    note("No original PDF is stored — showing the tailored PDF only. Import a résumé in the Profile tab to compare side-by-side.", els.tailorOut);
  }
}

async function renderPdfToCanvas(b64, canvas, scale = 1.4) {
  const myGen = tailorRenderGen; // this render belongs to the tailor run active right now
  await loadPdfJs();
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  const doc = await pdfjsLib.getDocument({ data: bytesFromB64(b64) }).promise;
  try {
    if (myGen !== tailorRenderGen) return; // a newer Tailor/Discard superseded us — don't touch the canvas
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    if (myGen !== tailorRenderGen) return;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    if (myGen !== tailorRenderGen) return; // never re-set data-rendered for a stale paint
    canvas.dataset.rendered = "1"; // e2e hook: render resolved
  } finally {
    await doc.destroy();
  }
}

// Coverage meter (dataviz): labeled bars, the % is ALWAYS printed (identity never rides on
// color alone), one hue per state. Current PDF (blue), profile baseline (grey), tailored
// (green) so the "after" reads as the win. score/pdfScore are null when nothing in the JD
// is scoreable — we say so rather than draw a misleading 0%.
function renderCoverageMeter(before, after) {
  const box = els.tailorMeter;
  box.innerHTML = "";
  box.hidden = false;
  if (before.jdGroupCount === 0) {
    box.append(h("div", { class: "meter-head", text: "No scoreable keywords in this job description — coverage isn't meaningful here." }));
    return;
  }
  box.append(h("div", { class: "meter-head",
    text: `${before.jdGroupCount} scoreable keyword${before.jdGroupCount === 1 ? "" : "s"} in this JD${before.truncated ? " · JD truncated at 15k for scoring" : ""}` }));
  const pct = (v) => (v == null ? 0 : Math.round(v * 100));
  const row = (label, val, cls) => {
    const p = pct(val);
    const fill = h("div", { class: `meter-fill ${cls}` });
    fill.style.width = `${p}%`;
    box.append(h("div", { class: "meter-row" },
      h("span", { class: "meter-label", text: label }),
      h("div", { class: "meter-track" }, fill),
      h("span", { class: "meter-val", text: val == null ? "n/a" : `${p}%` }),
    ));
  };
  row("Current PDF", before.pdfScore, "pdf");
  row("Profile (before)", before.score, "before");
  row("Tailored (after)", after.score, "after");
  const delta = pct(after.score) - pct(before.score);
  box.append(h("div", { class: "meter-head" },
    "Tailoring coverage vs your profile baseline: ",
    h("span", { class: `meter-delta ${delta > 0 ? "up" : "flat"}`, text: delta > 0 ? `+${delta}%` : "no change" }),
  ));
}

// Keyword buckets — each is LABELED (present / consider-adding / don't-claim); color is
// secondary to the words, adjacent carries provenance so "add" is grounded in the profile.
function renderKeywordPanel(a) {
  const box = els.tailorKeywords;
  box.innerHTML = "";
  if (a.jdGroupCount === 0) { box.hidden = true; return; }
  box.hidden = false;
  const bucket = (title, items, cls, withProv) => {
    if (!items.length) return;
    const wrap = h("div", { class: "kw-bucket" }, h("div", { class: "kw-bucket-head", text: `${title} (${items.length})` }));
    const byCat = new Map();
    for (const it of items) { const c = it.category || "other"; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(it); }
    for (const [cat, list] of byCat) {
      const catRow = h("div", { class: "kw-cat" }, h("span", { class: "kw-cat-name", text: cat }));
      for (const it of list) {
        const chip = h("span", { class: `kw-chip ${cls}`, text: it.keyword });
        if (withProv && it.provenance) chip.title = `you have this — from ${it.provenance}`;
        catRow.append(chip);
      }
      wrap.append(catRow);
    }
    box.append(wrap);
  };
  bucket("Present — already in your profile", a.present, "present", false);
  bucket("Consider adding — you have this, but it's not on your current PDF", a.missing.adjacent, "adjacent", true);
  bucket("Not in your background — don't claim these", a.missing.absent, "absent", false);
}

// Fabrication flags are the trust surface — reds are NEVER collapsed behind the diff toggle;
// they list in full here regardless. The inline badges in the diff are an addition, not the
// only place they show.
function renderFlagStrip(audit) {
  const box = els.tailorFlags;
  box.innerHTML = "";
  box.hidden = false;
  const reds = audit.flags.filter((f) => f.severity === "red");
  const yellows = audit.flags.filter((f) => f.severity === "yellow");
  const strip = h("div", { class: `flag-strip${reds.length ? " has-red" : ""}` });
  if (!audit.flags.length) {
    strip.append(h("div", { class: "flag-line" },
      h("span", { class: "chip ok", text: "0 flags" }),
      h("span", { class: "flag-msg", text: "No fabrication flags — every claim traced to your profile. Still verify: the audit is a fabrication check, not an honesty proof." })));
  } else {
    strip.append(h("div", { class: "flag-line" },
      reds.length ? h("span", { class: "flag-badge red", text: `${reds.length} red` }) : null,
      yellows.length ? h("span", { class: "flag-badge yellow", text: `${yellows.length} yellow` }) : null,
      h("span", { class: "flag-msg", text: "Red = possible fabrication. The audit is a fabrication check, not an honesty proof — verify every flagged line." })));
    for (const f of [...reds, ...yellows]) {
      strip.append(h("div", { class: "flag-line" },
        h("span", { class: `flag-badge ${f.severity}`, text: f.gate }),
        h("span", { class: "flag-msg", text: f.message })));
    }
  }
  box.append(strip);
}

const flagMatchesRow = (flag, row) => {
  const d = norm(flag.detail || "").toLowerCase();
  if (!d) return false;
  const a = norm(row.after || "").toLowerCase();
  const b = norm(row.before || "").toLowerCase();
  return (a && (a.includes(d) || d.includes(a))) || (b && (b.includes(d) || d.includes(b)));
};

function renderDiff(diff, audit) {
  const box = els.tailorDiff;
  box.innerHTML = "";
  box.append(h("div", { class: "diff-note", text: "The audit is a fabrication check, not an honesty proof — read every change." }));
  const matched = new Set();
  for (const section of diff.sections || []) {
    const rows = section.items.reduce((n, it) => n + it.rows.length, 0);
    if (!rows) continue;
    box.append(h("div", { class: "diff-section-head", text: section.section }));
    for (const item of section.items) {
      if (!item.rows.length) continue;
      const head = item.after || item.before || {};
      const headText = Object.values(head).filter(Boolean).join(" — ") || "(new item)";
      const itemEl = h("div", { class: "diff-item" }, h("div", { class: "diff-item-head", text: headText }));
      for (const row of item.rows) {
        const rowEl = h("div", { class: `diff-row ${row.kind}` });
        rowEl.append(h("span", { class: "diff-kind", text: row.kind }));
        for (const op of row.diffOps) {
          if (op.op === "eq") rowEl.append(document.createTextNode(op.text + " "));
          else rowEl.append(h("span", { class: op.op === "add" ? "wd-add" : "wd-del", text: op.text + " " }));
        }
        (audit.flags || []).forEach((f, i) => {
          if (flagMatchesRow(f, row)) {
            matched.add(i);
            rowEl.append(h("span", { class: `flag-badge ${f.severity}`, title: f.message, text: f.gate }));
          }
        });
        itemEl.append(rowEl);
      }
      box.append(itemEl);
    }
  }
  const unmatched = (audit.flags || []).filter((_, i) => !matched.has(i));
  if (unmatched.length) {
    box.append(h("div", { class: "diff-section-head", text: "Other flags (not tied to a specific bullet)" }));
    for (const f of unmatched) {
      box.append(h("div", { class: "flag-line" },
        h("span", { class: `flag-badge ${f.severity}`, text: f.gate }),
        h("span", { class: "flag-msg", text: f.message })));
    }
  }
}

function toggleTailorDiff() {
  els.tailorDiff.hidden = !els.tailorDiff.hidden;
  els.tailorDiffToggle.textContent = els.tailorDiff.hidden ? "Show diff" : "Hide diff";
}

// Compact analysis for storage: keyword + category + status rows only (never the per-variant
// match internals, never the reasoning stream).
function compactAnalysis(a) {
  const rows = [];
  for (const it of a.present || []) rows.push({ keyword: it.keyword, category: it.category, status: "present" });
  for (const it of a.missing?.adjacent || []) rows.push({ keyword: it.keyword, category: it.category, status: "adjacent" });
  for (const it of a.missing?.absent || []) rows.push({ keyword: it.keyword, category: it.category, status: "absent" });
  return { rows, score: a.score, pdfScore: a.pdfScore, jdGroupCount: a.jdGroupCount, truncated: !!a.truncated };
}

async function tailorApprove() {
  const t = tailorPending;
  if (!t || inFlight) return;
  const redN = t.audit.flags.filter((f) => f.severity === "red").length;
  // Two-step in-DOM confirm for red flags (window.confirm flakes under Playwright). Reds
  // don't block, but must be explicitly acknowledged.
  if (redN > 0 && tailorRedConfirmStep === 0) {
    tailorRedConfirmStep = 1;
    const box = els.tailorConfirm;
    box.innerHTML = "";
    box.hidden = false;
    // Disable the other mutating actions (incl. Autofill) while the confirm is pending so a
    // concurrent run can't slip in and swap tailorPending under us. inFlight stays FALSE here
    // because the Yes button re-enters tailorApprove — the `if (inFlight) return` guard above
    // must not block that second call.
    setBusy(true);
    const yes = h("button", { class: "primary", text: `Yes — approve with ${redN} red flag(s)` });
    yes.addEventListener("click", () => tailorApprove());
    const cancel = h("button", { text: "Cancel" });
    cancel.addEventListener("click", () => { tailorRedConfirmStep = 0; box.hidden = true; setBusy(false); });
    box.append(
      h("div", { class: "warn-line", text: `${redN} line(s) are flagged as possible fabrication. Approving uploads this regenerated PDF for this job — confirm you have verified each red flag above.` }),
      h("div", { class: "btn-row" }, yes, cancel),
    );
    return;
  }

  // Interlock (H1): hold inFlight across the whole write so recordApplication (Autofill)
  // — which does its OWN read-modify-write of `applications` — can't interleave with ours
  // and clobber a row. We commit the CAPTURED `t`, so even a mid-run pending swap can't
  // retarget the write. Both stores are read once and written in ONE set (no second get→set).
  inFlight = true;
  setBusy(true);
  try {
    const rec = {
      id: crypto.randomUUID(), jobKey: t.jobKey, jobId: t.jobId, ats: t.ats, company: t.company,
      title: t.title, url: t.url, createdAt: Date.now(), approvedAt: Date.now(), lastUsedAt: null,
      tailored: t.tailored, changes: t.changes,
      analysisBefore: compactAnalysis(t.before), analysisAfter: compactAnalysis(t.after),
      flags: t.audit.flags, pdfB64: t.pdfB64, pdfName: t.pdfName,
    };
    const stored = await chrome.storage.local.get(["tailoredResumes", "applications"]);
    const store = stored.tailoredResumes || {};
    store[t.jobKey] = rec;
    // LRU cap ~20 on lastUsedAt||approvedAt, never evicting the one we just wrote.
    const keys = Object.keys(store);
    if (keys.length > 20) {
      keys.sort((a, b) => ((store[a].lastUsedAt || store[a].approvedAt || 0) - (store[b].lastUsedAt || store[b].approvedAt || 0)));
      for (const k of keys) {
        if (Object.keys(store).length <= 20) break;
        if (k !== t.jobKey) delete store[k];
      }
    }
    // Link the tracker: if this job already has an application record, tie the approved
    // résumé to it (future autofills carry tailoredResumeId through recordApplication too).
    const apps = stored.applications || {};
    const patch = { tailoredResumes: store };
    if (apps[t.jobKey]) { apps[t.jobKey].tailoredResumeId = rec.id; patch.applications = apps; }
    await chrome.storage.local.set(patch);

    tailorUseOriginal.delete(t.jobKey); // a fresh approval opts this job back into the tailored upload
    t.approved = true;
    tailorRedConfirmStep = 0;
    els.tailorConfirm.hidden = true;
    tailorSetStatus("Approved ✓ — this regenerated PDF becomes the résumé uploaded for this job's application.");
    note("Approved: the tailored PDF will upload for this job on your next Autofill. Every other job still uploads your original.", els.tailorOut);
  } catch (e) {
    tailorSetStatus(`Couldn't save — storage may be full (delete old tailored résumés). ${e.message}`, true);
  } finally {
    // setBusy(false) re-enables the download button iff tailorPending is approved.
    inFlight = false;
    setBusy(false);
  }
}

function tailorDiscard() {
  tailorPending = null;
  resetTailorUi();
  els.tailorOut.innerHTML = "";
  tailorSetStatus("Discarded — nothing saved; storage untouched.");
}

function tailorDownload() {
  const t = tailorPending;
  if (!t || !t.pdfB64) return;
  const blob = new Blob([bytesFromB64(t.pdfB64)], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = t.pdfName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Interlock: while any model/fill/import flow runs, everything that could mutate its
// inputs mid-run is disabled — profile edits (a "Load sample" mid-autofill would feed
// sample data into the retry pass on a real form) and the config refresh (its
// runtime.reload() would tear down a half-filled form).
function setBusy(busy) {
  for (const b of [
    els.scanBtn, els.autofillBtn, els.coverBtn, els.nextPageBtn,
    els.saveProfileBtn, els.loadSampleBtn, els.importResumeBtn, els.refreshCfgBtn,
    els.resetSpendBtn,
    els.tailorBtn, els.tailorApproveBtn, els.tailorDiscardBtn, els.tailorDiffToggle,
  ]) b.disabled = busy;
  // Download stays disabled until this pending result is approved (and re-disabled while busy).
  els.tailorDownloadBtn.disabled = busy || !(tailorPending && tailorPending.approved);
}

// ---------------------------------------------------------------- profile editor

function renderProfileForm() {
  const root = els.profileForm;
  root.innerHTML = "";
  for (const section of JA_PROFILE_SECTIONS) {
    const d = document.createElement("details");
    d.className = `section${section.legal ? " legal" : ""}`;
    if (section.key === "personal_information") d.open = true;
    const summary = document.createElement("summary");
    summary.innerText = section.label;
    d.appendChild(summary);

    if (section.type === "object") {
      const grid = document.createElement("div");
      grid.className = "grid2";
      for (const [key, label, type, ph] of section.fields) {
        const wrap = document.createElement("div");
        const lab = document.createElement("label");
        lab.innerText = label;
        wrap.appendChild(lab);
        let input;
        if (type === "select") {
          input = document.createElement("select");
          for (const opt of ph) {
            const o = document.createElement("option");
            o.value = opt;
            o.innerText = opt === "" ? "— unset (never auto-filled)" : opt;
            input.appendChild(o);
          }
        } else {
          input = document.createElement("input");
          input.type = type;
          input.placeholder = ph || "";
        }
        input.dataset.section = section.key;
        input.dataset.key = key;
        input.value = profile[section.key]?.[key] ?? "";
        wrap.appendChild(input);
        grid.appendChild(wrap);
      }
      d.appendChild(grid);
    } else {
      const ta = document.createElement("textarea");
      ta.dataset.sectionRoot = section.key;
      ta.dataset.kind = section.type;
      ta.spellcheck = false;
      ta.value = section.type === "json"
        ? JSON.stringify(profile[section.key] ?? [], null, 1)
        : (profile[section.key] ?? "");
      d.appendChild(ta);
    }
    root.appendChild(d);
  }
}

function collectProfileForm() {
  const next = jaEmptyProfile();
  for (const input of els.profileForm.querySelectorAll("[data-section]")) {
    next[input.dataset.section][input.dataset.key] = input.value.trim();
  }
  for (const ta of els.profileForm.querySelectorAll("[data-section-root]")) {
    const key = ta.dataset.sectionRoot;
    if (ta.dataset.kind === "json") {
      try {
        next[key] = JSON.parse(ta.value || "[]");
        ta.classList.remove("invalid");
      } catch {
        ta.classList.add("invalid");
        throw new Error(`"${key}" is not valid JSON`);
      }
    } else {
      next[key] = ta.value;
    }
  }
  return next;
}

// ---------------------------------------------------------------- résumé import (docs/06)

function setImportStatus(text, isErr = false) {
  els.importStatus.innerText = text;
  els.importStatus.classList.toggle("err", isErr);
}

async function renderResumeFileLine() {
  const { resumeFile } = await chrome.storage.local.get("resumeFile");
  els.resumeFileLine.innerText = resumeFile
    ? `Stored résumé for uploads: ${resumeFile.name} (${Math.round((resumeFile.b64?.length || 0) * 3 / 4 / 1024)} KB)`
    : "No résumé PDF stored yet — import one to enable file-upload autofill.";
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// pdf.js is 320KB of parse on panel open if loaded eagerly — load it on the first
// import/tailor action instead (the only flows that need it).
function loadPdfJs() {
  if (typeof pdfjsLib !== "undefined") return Promise.resolve();
  return injectScript("vendor/pdf.min.js");
}

// pdfmake (+ its font VFS) is another ~2MB of parse — lazy-loaded by the Tailor tab only.
// Order matters: pdfmake FIRST, then vfs_fonts (which self-registers via addVirtualFileSystem).
// Each script is guarded independently so a vfs failure on one attempt doesn't re-inject (and
// re-parse/redefine) pdfmake on the retry — only the piece that hasn't loaded yet is injected.
let pdfMakeVfsLoaded = false;
async function loadPdfMake() {
  if (typeof pdfMake === "undefined") await injectScript("vendor/pdfmake.min.js");
  if (!pdfMakeVfsLoaded) { await injectScript("vendor/vfs_fonts.js"); pdfMakeVfsLoaded = true; }
}

// pdf.js text extraction — the same client-side technique the upstream extension uses (docs/06).
async function extractPdfText(file) {
  await loadPdfJs();
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data }).promise;
  try {
    const pages = [];
    for (let r = 1; r <= doc.numPages; r++) {
      const page = await doc.getPage(r);
      const text = (await page.getTextContent()).items.map((i) => i.str).filter(Boolean).join(" ");
      pages.push(text);
    }
    return { text: pages.join("\n\n").replace(/[ \t]+/g, " ").trim(), pages: doc.numPages };
  } finally {
    await doc.destroy(); // otherwise the worker + PDF bytes stay alive for the panel's lifetime
  }
}

// Parsed values go into the EDITOR for review — never straight to storage (docs/06:
// "populate + review, never blind-trust"). Legal sections are structurally untouched:
// only personal_information inputs and the non-legal textareas are addressed.
function applyParsedToEditor(parsed, extractedText) {
  // Import REPLACES the CV-managed sections — a field the résumé omits is cleared,
  // not left as-is. Otherwise stale values (e.g. from Load sample) survive the import
  // and silently reach the real form. Legal sections are never in these selectors, so
  // work-auth / EEO answers are untouched (docs/06).
  for (const input of els.profileForm.querySelectorAll('[data-section="personal_information"]')) {
    input.value = parsed.personal_information?.[input.dataset.key] ?? "";
  }
  for (const ta of els.profileForm.querySelectorAll("[data-section-root]")) {
    const key = ta.dataset.sectionRoot;
    if (key === "resume_text") ta.value = extractedText;
    else if (key === "skills") ta.value = parsed.skills || "";
    else if (ta.dataset.kind === "json") {
      ta.value = Array.isArray(parsed[key]) && parsed[key].length ? JSON.stringify(parsed[key], null, 1) : "[]";
    }
  }
}

async function runResumeImport(file) {
  if (inFlight) return;
  inFlight = true; // claimed before the first await — no window for a concurrent run
  setBusy(true);
  // Store the raw PDF bytes FIRST, before any parsing: the autofill upload path
  // (uploadResume / file inputs) needs the original file, and storing it must not
  // depend on the API key or on the parse succeeding.
  try {
    if (file.size > 6 * 1024 * 1024) {
      throw new Error("PDF over 6MB — chrome.storage.local holds ~10MB total; use a smaller export");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await chrome.storage.local.set({
      resumeFile: { name: file.name, type: file.type || "application/pdf", b64: b64FromBytes(bytes) },
    });
    renderResumeFileLine();
  } catch (e) {
    setImportStatus(`Could not store the PDF (${e.message})`, true);
    inFlight = false;
    setBusy(false);
    return;
  }
  if (!state.apiKey) {
    setImportStatus("PDF stored for uploads ✓ — paste an API key in Settings to also parse it into the profile.", false);
    els.resumeFile.value = "";
    inFlight = false;
    setBusy(false);
    return;
  }
  els.importOut.innerHTML = "";
  try {
    setImportStatus("Extracting text…");
    const { text, pages } = await extractPdfText(file);
    if (text.length < 200) {
      throw new Error("no text layer found (scanned PDF?) — paste the text into the Résumé box instead");
    }
    setImportStatus(`Extracted ${pages} page(s), ${text.length} chars — parsing…`);
    const think = startThinking(els.importOut);
    const parseRes = await JA_AI.parseResumeToProfile(state, text, { onDelta: think.onDelta });
    think.done(parseRes);
    const { parsed } = parseRes;
    applyParsedToEditor(parsed, text);
    const nExp = parsed.experience_details?.length || 0;
    const nEdu = parsed.education_details?.length || 0;
    const nPers = Object.keys(parsed.personal_information || {}).length;
    setImportStatus(`Imported ${nPers} personal fields, ${nExp} roles, ${nEdu} schools — review below, then Save profile.`);
  } catch (e) {
    setImportStatus(`Import failed: ${e.message}`, true);
  } finally {
    inFlight = false;
    setBusy(false);
    els.resumeFile.value = "";
  }
}

// ---------------------------------------------------------------- refresh (native host)

function renderLastRefresh() {
  const lr = state.lastRefresh;
  els.lastRefresh.innerText = lr
    ? `Last refresh: ${new Date(lr.when).toLocaleString()} — ${lr.changed ? lr.summary || "changed" : "no changes"}`
    : "";
}

async function doRefreshConfig() {
  // Never mid-run: swapping the config under a half-finished fill wastes the
  // in-flight model call and can mix two config versions in one run.
  if (inFlight) { els.refreshOut.hidden = false; els.refreshOut.innerText = "Autofill/import is running — wait for it to finish, then refresh."; return; }
  inFlight = true; // a fill started mid-rewrite could read a torn config pair
  setBusy(true);
  els.refreshOut.hidden = false;
  els.refreshOut.innerText = "Running node reference/refresh.js via native host…";
  try {
    const resp = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: "refresh" });
    if (!resp) throw new Error("host returned no response");
    if (resp.ok === false) {
      // exit 2 = source extension not installed etc. — the real explanation is in the script's
      // own output, so show it rather than a generic failure.
      els.refreshOut.innerText =
        `${resp.output || resp.error || "(no output)"}\n\nrefresh.js exited with code ${resp.exitCode ?? "?"} — nothing was changed.`;
      return;
    }
    els.refreshOut.innerText = resp.output || "(no output)";
    const changed = resp.exitCode === 1;
    const summary = (resp.output || "").split("\n").filter((l) => l.includes("✱")).join(" · ")
      || (changed ? "files changed" : "no changes");
    state.lastRefresh = { when: Date.now(), changed, summary };
    await save();
    renderLastRefresh();
    if (changed) {
      // No extension reload needed: unpacked-extension fetches read the files from
      // disk, so a forced re-fetch picks up the new JSON immediately (verified by the
      // e2e config-freshness check). runtime.reload() also kills sideloaded test runs,
      // so the fetch path is both sufficient and safer.
      const { atsConfig: cfg } = await loadAtsConfig(true);
      els.refreshOut.innerText +=
        `\n\nReloaded config from disk: ${Object.keys(cfg).length} ATS playbooks now active (no extension reload needed).` +
        "\nIf a change doesn't seem active, click ↻ on jobApplier in chrome://extensions.";
    } else {
      els.refreshOut.innerText += "\n\nNo differences — nothing to reload.";
    }
  } catch (e) {
    const m = String(e.message || e);
    els.refreshOut.innerText = /Specified native messaging host not found|not found/i.test(m)
      ? `Native host not installed. Run once in a terminal:\n  bash scripts/native-host/install.sh\nthen reload the extension and retry.\n\n(${m})`
      : `Refresh failed: ${m}`;
  } finally {
    inFlight = false;
    setBusy(false);
  }
}

// ---------------------------------------------------------------- init

document.addEventListener("DOMContentLoaded", async () => {
  for (const id of [
    "targetInfo", "spendLine", "scanBtn", "autofillBtn", "coverBtn", "nextPageBtn", "dryRun", "applyOut",
    "appsCounts", "appsListTab", "appsBreaksTab", "appsListPane", "appsBreaksPane",
    "appsSearch", "appsAtsFilter", "appsStatusFilter", "appsSinceFilter", "appsList",
    "breaksAgg", "breaksList",
    "tailorBtn", "tailorDiffToggle", "tailorStatus", "tailorJdWrap", "tailorJdInput", "tailorOut",
    "tailorCompare", "tailorCanvasLeft", "tailorCanvasRight", "tailorPaneLeft",
    "tailorDiff", "tailorMeter", "tailorKeywords", "tailorFlags", "tailorConfirm",
    "tailorActions", "tailorApproveBtn", "tailorDiscardBtn", "tailorDownloadBtn",
    "profileForm", "saveProfileBtn", "loadSampleBtn", "profileStatus",
    "importResumeBtn", "resumeFile", "importStatus", "importOut", "resumeFileLine",
    "apiKey", "model", "apiBase", "refreshCfgBtn", "refreshOut", "lastRefresh",
    "spendSettingsLine", "resetSpendBtn",
  ]) els[id] = document.getElementById(id);

  const stored = await chrome.storage.local.get(["state", "profile"]);
  if (stored.state) state = { ...state, ...stored.state };
  if (stored.profile) profile = { ...jaEmptyProfile(), ...stored.profile };
  if (!state.sessionId) { state.sessionId = crypto.randomUUID(); await save(); } // cache affinity

  els.apiKey.value = state.apiKey || "";
  els.model.value = state.model || JA_AI.DEFAULT_MODEL;
  els.apiBase.value = state.apiBase || "";
  renderProfileForm();
  renderLastRefresh();

  // Keys get pasted as whole .env lines ("openrouter_key=sk-…"), curl snippets
  // ("Bearer sk-…"), or quoted — a prefixed token makes OpenRouter 401 with
  // "Missing Authentication header", so keep only the key itself.
  const cleanApiKey = (raw) => raw
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^[A-Za-z_][\w.-]*\s*=\s*/, "")
    .trim();

  for (const id of ["apiKey", "model", "apiBase"]) {
    els[id].addEventListener("change", async (e) => {
      const value = e.target.value.trim();
      state[id] = id === "apiKey" ? cleanApiKey(value) : value;
      e.target.value = state[id];
      await save();
    });
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      for (const view of ["apply", "applications", "tailor", "profile", "settings"]) {
        document.getElementById(`view-${view}`).hidden = view !== tab.dataset.view;
      }
      if (tab.dataset.view === "applications") renderApplications().catch((e) => warn(`Applications: ${e.message}`));
    });
  });

  // Applications tab: subtab toggle + live filters.
  const rerenderApps = () => renderApplications().catch((e) => warn(`Applications: ${e.message}`));
  els.appsListTab.addEventListener("click", () => { appsSubtab = "list"; rerenderApps(); });
  els.appsBreaksTab.addEventListener("click", () => { appsSubtab = "breaks"; rerenderApps(); });
  for (const id of ["appsSearch", "appsAtsFilter", "appsStatusFilter", "appsSinceFilter"]) {
    els[id].addEventListener("input", rerenderApps);
  }

  els.scanBtn.addEventListener("click", () => doScan().catch((e) => errNote(e.message)));
  els.autofillBtn.addEventListener("click", doAutofill);
  els.coverBtn.addEventListener("click", doCoverLetter);
  els.nextPageBtn.addEventListener("click", doNextPage);
  els.tailorBtn.addEventListener("click", doTailor);
  els.tailorDiffToggle.addEventListener("click", toggleTailorDiff);
  els.tailorApproveBtn.addEventListener("click", tailorApprove);
  els.tailorDiscardBtn.addEventListener("click", tailorDiscard);
  els.tailorDownloadBtn.addEventListener("click", tailorDownload);
  renderResumeFileLine().catch(() => {});
  renderSpend();
  els.spendSettingsLine.innerText =
    "Per-call costs come from OpenRouter's usage accounting (never estimated). The session figure resets when the panel reopens.";
  els.resetSpendBtn.addEventListener("click", async () => {
    state.spendTotal = 0;
    sessionSpend = 0;
    await save();
    renderSpend();
  });
  els.saveProfileBtn.addEventListener("click", async () => {
    try {
      profile = collectProfileForm();
      await saveProfile();
      els.profileStatus.innerText = "Saved ✓";
      setTimeout(() => (els.profileStatus.innerText = ""), 1500);
    } catch (e) {
      els.profileStatus.innerText = e.message;
    }
  });
  els.loadSampleBtn.addEventListener("click", async () => {
    profile = JSON.parse(JSON.stringify(JA_SAMPLE_PROFILE));
    await saveProfile();
    renderProfileForm();
    els.profileStatus.innerText = "Sample loaded (Michael Scott)";
    setTimeout(() => (els.profileStatus.innerText = ""), 2500);
  });
  els.refreshCfgBtn.addEventListener("click", doRefreshConfig);
  els.importResumeBtn.addEventListener("click", () => els.resumeFile.click());
  els.resumeFile.addEventListener("change", () => {
    if (els.resumeFile.files?.[0]) runResumeImport(els.resumeFile.files[0]);
  });

  // Show something useful about the target tab on open.
  try { await updateTargetLine(await getTargetTabId(), null); } catch { /* no http tab */ }
});
