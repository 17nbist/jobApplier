// Full-flow Tailor e2e (step 4): drive the Tailor tab end to end against an AshbyHQ-shaped
// job page, prove the config-first XPath JD path, the byte-accurate dual-canvas preview, the
// anti-fabrication audit (planted fabrications MUST go RED), keyword/coverage analysis, the
// approve/discard gates, storage persistence, and the CRITICAL upload-source routing
// (approved job → tailored PDF; every other job → the original).
//
//   node test/e2e-tailor.mjs                                  (mock model)
//   LIVE=1 OPENROUTER_API_KEY=… node test/e2e-tailor.mjs      (real GLM 5.2 — structural only)
//
// The fixture pages are served at REAL jobs.ashbyhq.com URLs via Playwright route() so the
// extension's declared content script matches, detectAts returns AshbyHQ, and the panel
// forwards ResumeScores.AshbyHQ as jdConfig — exercising the XPath job-context path (not the
// body-text fallback). Proof: company comes from an <img @alt> the fallback can't read.
import { chromium } from "playwright";
import { createMockServer, PORT, TAILORED_RESUME } from "./mock-openrouter.mjs";
import { ART, makeChecker, launchExtension, openPanel, finish, loadAiSandbox } from "./harness.mjs";
import path from "node:path";
import fs from "node:fs";

const PDF_PATH = path.join(ART, "fixture-tailor-original.pdf");
const LIVE = !!process.env.LIVE && !!process.env.OPENROUTER_API_KEY;
const { results, check } = makeChecker();

// Seeded source profile = the upstream Michael Scott sample the mock's TAILORED_RESUME is
// hardcoded against. Pull the real object so the audit's source corpus matches production.
const { JA_SAMPLE_PROFILE } = loadAiSandbox();

const APPROVED_URL = "https://jobs.ashbyhq.com/testry-robotics/eng-approved-001/application";
const OTHER_URL = "https://jobs.ashbyhq.com/other-co/eng-other-002/application";
const SENTINEL = "ASHBY_FIXTURE_DESCRIPTION";

// AshbyHQ-shaped page: the ResumeScores.AshbyHQ XPaths resolve here (h1 title, img@alt
// company, div#overview .descriptionText JD), AND it carries an application form whose file
// input matches the AshbyHQ resume playbook (div.fieldEntry > input[type=file][accept=pdf]).
const ASHBY_PAGE = `<!doctype html><html><head><title>Careers · Testry Robotics</title></head><body>
  <nav><img class="ashby-nav _navLogoWordmarkImage_9f2" alt="Testry Robotics" src="data:," /></nav>
  <h1 class="_title_h7x ashby-job-posting-heading">Senior Software Engineer</h1>
  <div id="overview">
    <div class="_descriptionText_1a2 descriptionText">
      <p>${SENTINEL} — Testry Robotics is hiring a Senior Software Engineer to build resilient
      distributed backends in TypeScript and Go. You will own services end to end, ship to
      production daily, mentor engineers, and partner with product to turn ambiguous problems
      into reliable systems that serve millions of requests per day.</p>
    </div>
  </div>
  <form id="application-form">
    <div class="fieldEntry"><label>First Name</label><input type="text" /></div>
    <div class="fieldEntry"><label>Last Name</label><input type="text" /></div>
    <div class="fieldEntry"><label>Email</label><input type="text" /></div>
    <div class="fieldEntry">
      <label>Resume / CV</label>
      <input id="resume" name="resume" type="file" accept="application/pdf" />
      <div class="_instructions_9f2"><button type="button">Replace</button></div>
    </div>
    <button type="submit">Submit application</button>
  </form>
</body></html>`;

// ---- 1. Generate a REAL text-layer PDF for the seeded original résumé (a stub/fake base64
// would never render to a pdf.js canvas, hanging the LEFT-pane assertion).
{
  const gen = await chromium.launch({ headless: true });
  const p = await gen.newPage();
  await p.setContent(`
    <h1>Michael Scott</h1>
    <p>Scranton, PA · mscott@dundermifflin.com</p>
    <h2>Experience</h2>
    <p>Regional Manager — Dunder Mifflin (1990–Present)</p>
    <p>Software Engineer Intern — MEDSmart (2018–2022)</p>
    <h2>Skills</h2><p>JavaScript, PHP, HTML, CSS, Sales, Management</p>`);
  await p.pdf({ path: PDF_PATH, format: "A4" });
  await gen.close();
  check("fixture original PDF generated", fs.existsSync(PDF_PATH), PDF_PATH);
}
const ORIGINAL_B64 = fs.readFileSync(PDF_PATH).toString("base64");
const ORIGINAL_NAME = "resume-original.pdf";
const ORIGINAL_SIZE = Buffer.from(ORIGINAL_B64, "base64").length;

const server = await createMockServer();
console.log(`mock OpenRouter on :${PORT} · live mode: ${LIVE}`);
let context;

// ---------------------------------------------------------------- helpers
const b64Len = (b64) => Buffer.from(b64 || "", "base64").length;
const isPdf = (b64) => Buffer.from(b64 || "", "base64").slice(0, 5).toString("latin1") === "%PDF-";

try {
  const launched = await launchExtension();
  context = launched.context;
  const { sw, extId } = launched;
  check("extension loaded (service worker up)", !!extId, extId);

  // Serve the AshbyHQ fixture at real jobs.ashbyhq.com URLs so the declared content script
  // matches and detectAts fires. Any ashby application URL returns the same combined page.
  await context.route("https://jobs.ashbyhq.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: ASHBY_PAGE }));

  // ---- seed storage from the SW (before the panel's init writes state)
  await sw.evaluate(async ({ live, port, key, profile, resumeFile }) => {
    await chrome.storage.local.set({
      profile,
      resumeFile,
      state: {
        apiKey: live ? key : "test-key",
        model: "z-ai/glm-5.2",
        apiBase: live ? "" : `http://127.0.0.1:${port}/v1`,
      },
    });
  }, {
    live: LIVE, port: PORT, key: process.env.OPENROUTER_API_KEY || "",
    profile: JA_SAMPLE_PROFILE,
    resumeFile: { name: ORIGINAL_NAME, type: "application/pdf", b64: ORIGINAL_B64 },
  });

  // ---- open the job tab on the APPROVED posting
  const jobPage = await context.newPage();
  jobPage.setDefaultTimeout(30000);
  await jobPage.goto(APPROVED_URL, { waitUntil: "domcontentloaded" });
  const jobTabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "*://jobs.ashbyhq.com/*" });
    return tabs[0]?.id;
  });
  check("job tab id resolved", !!jobTabId, String(jobTabId));

  const panel = await openPanel(context, extId, `?tab=${jobTabId}`);
  await panel.click('.tab[data-view="tailor"]');
  check("Tailor view visible", await panel.locator("#view-tailor").isVisible(), "");

  // ================================================================ PHASE A: tailor + discard
  await panel.click("#tailorBtn");
  await panel.waitForFunction(
    () => /Ready —|Tailor failed|Couldn't read|LinkedIn/.test(document.getElementById("tailorStatus")?.textContent || ""),
    null, { timeout: 180000 },
  );
  const statusA = await panel.locator("#tailorStatus").textContent();
  check("tailor run reached a terminal status", /Ready —/.test(statusA), statusA);

  // ---- (3) JD arrived via the config-first XPath path, not the body fallback. The company
  // is only obtainable from the nav <img @alt> (ResumeScores.AshbyHQ jobCompanyNamePath);
  // the body fallback would yield the hyphenated URL slug "other-co"/"testry-robotics".
  const jobFacts = await panel.evaluate(() => {
    // tailorPending is module-scoped; expose the few fields we assert on.
    const t = (typeof tailorPending !== "undefined" && tailorPending) || null;
    return t ? { company: t.company, title: t.title, url: t.url, jobKey: t.jobKey } : null;
  });
  check("XPath JD path: company from <img @alt> ('Testry Robotics', not the URL slug)",
    jobFacts && jobFacts.company === "Testry Robotics", jobFacts && jobFacts.company);
  check("XPath JD path: title from the AshbyHQ h1 playbook",
    jobFacts && jobFacts.title === "Senior Software Engineer", jobFacts && jobFacts.title);

  // Prove the description itself came through the XPath (sentinel-bearing) node.
  const descSentinel = await panel.evaluate(async () => {
    const scoring = await loadResumeScoring();
    const cfg = scoring.ResumeScores?.AshbyHQ;
    const tabId = Number(new URLSearchParams(location.search).get("tab"));
    const resp = await chrome.tabs.sendMessage(tabId, { type: "JA_SCRAPE", jdConfig: cfg });
    return resp?.schema?.job?.description || "";
  });
  check("XPath JD path: scraped description is the sentinel node (not body noise)",
    descSentinel.includes("ASHBY_FIXTURE_DESCRIPTION") && descSentinel.length > 200 && descSentinel.length < 1200,
    `${descSentinel.length} chars`);

  // ---- (4) both canvases reach data-rendered="1"
  await panel.waitForFunction(
    () => document.querySelectorAll('#tailorCompare canvas[data-rendered="1"]').length >= 2,
    null, { timeout: 60000 },
  );
  check("both PDF canvases rendered (byte-accurate dual preview)", true);

  // ---- (5) diff view shows add/rephrase rows
  await panel.click("#tailorDiffToggle");
  const diffKinds = await panel.evaluate(() =>
    [...document.querySelectorAll("#tailorDiff .diff-row")].map((r) => [...r.classList].find((c) => c !== "diff-row")));
  if (LIVE) {
    // Exact ops aren't stable live — just require the diff rendered real change rows.
    check("diff view shows change rows", diffKinds.some((k) => k && k !== "eq"), diffKinds.join(","));
  } else {
    check("diff view shows change rows (add + rephrase present)",
      diffKinds.includes("add") && diffKinds.includes("rephrase"), diffKinds.join(","));
  }

  // ---- (6) planted fabrications RED-flagged
  const flags = await panel.evaluate(() => ({
    reds: document.querySelectorAll("#tailorFlags .flag-badge.red").length,
    text: document.getElementById("tailorFlags")?.innerText || "",
  }));
  // The planted-fabrication RED flag is a MOCK-only deterministic guarantee. Live, the real
  // model does an honest tailoring, so 0 reds is the CORRECT result (proves no cry-wolf).
  if (!LIVE) {
    check("flag strip shows ≥1 RED flag", flags.reds >= 1, `${flags.reds} red badges`);
    check("planted invented metric '60%' is flagged", /60%/.test(flags.text), flags.text.slice(0, 200));
    check("planted invented tool 'Kubernetes' is flagged", /Kubernetes/.test(flags.text), flags.text.slice(0, 200));
    // The reorder-safety guarantee: a legitimate reorder must NOT masquerade as fabrication.
    const gates = await panel.evaluate(() =>
      (typeof tailorPending !== "undefined" && tailorPending ? tailorPending.audit.flags : [])
        .filter((f) => f.severity === "red").map((f) => f.gate));
    check("no false identity/scope/date reds from the reorder",
      !gates.some((g) => ["identity", "scope", "date"].includes(g)), gates.join(",") || "(none)");
  }

  // ---- (7) coverage meter + keyword panel render with real numbers
  const meter = await panel.evaluate(() => ({
    vals: [...document.querySelectorAll("#tailorMeter .meter-val")].map((e) => e.textContent),
    labels: [...document.querySelectorAll("#tailorMeter .meter-label")].map((e) => e.textContent),
    kwChips: document.querySelectorAll("#tailorKeywords .kw-chip").length,
    kwHidden: document.getElementById("tailorKeywords")?.hidden,
  }));
  const meterOk = meter.vals.length >= 3 &&
    meter.vals.every((v) => /^(\d+%|n\/a)$/.test(v)) &&
    !meter.vals.some((v) => /NaN|undefined/.test(v));
  check("coverage meter: before/after + current-PDF rows with numeric %", meterOk,
    `${meter.labels.join("|")} → ${meter.vals.join("|")}`);
  check("coverage meter includes a 'Current PDF' score row",
    meter.labels.some((l) => /Current PDF/.test(l)), meter.labels.join("|"));
  check("keyword panel rendered", !meter.kwHidden && meter.kwChips > 0, `${meter.kwChips} chips`);

  // ---- (8) PRE-APPROVAL: tailoredResumes + applications UNTOUCHED (spendTotal may move)
  const preApprove = await sw.evaluate(async () =>
    await chrome.storage.local.get(["tailoredResumes", "applications"]));
  check("pre-approval: tailoredResumes untouched",
    !preApprove.tailoredResumes || Object.keys(preApprove.tailoredResumes).length === 0, JSON.stringify(Object.keys(preApprove.tailoredResumes || {})));
  check("pre-approval: applications untouched",
    !preApprove.applications || Object.keys(preApprove.applications).length === 0, JSON.stringify(Object.keys(preApprove.applications || {})));

  // ---- (10) DISCARD leaves storage clean
  await panel.click("#tailorDiscardBtn");
  await panel.waitForFunction(() => /Discarded/.test(document.getElementById("tailorStatus")?.textContent || ""), null, { timeout: 5000 });
  const afterDiscard = await sw.evaluate(async () => await chrome.storage.local.get(["tailoredResumes", "applications"]));
  check("discard: nothing written to tailoredResumes/applications",
    (!afterDiscard.tailoredResumes || !Object.keys(afterDiscard.tailoredResumes).length) &&
    (!afterDiscard.applications || !Object.keys(afterDiscard.applications).length), "clean");
  check("discard: download button disabled again", await panel.locator("#tailorDownloadBtn").isDisabled());

  // ================================================================ PHASE B: tailor + approve
  await panel.click("#tailorBtn");
  await panel.waitForFunction(
    () => /Ready —/.test(document.getElementById("tailorStatus")?.textContent || ""),
    null, { timeout: 180000 },
  );
  await panel.waitForFunction(
    () => document.querySelectorAll('#tailorCompare canvas[data-rendered="1"]').length >= 2,
    null, { timeout: 60000 },
  );
  const jobKey = await panel.evaluate(() => (typeof tailorPending !== "undefined" && tailorPending) ? tailorPending.jobKey : null);
  check("jobKey computed for the approved posting", !!jobKey, jobKey);

  // Approve — the in-DOM two-step confirm (no window.confirm) appears ONLY when there are
  // RED flags. Mock mode has planted reds → confirm required; live's honest tailoring may
  // have 0 reds → approval proceeds directly. Wait a bounded time for the confirm button
  // rather than hard-clicking it (a 0-red run would otherwise hang on a button that never renders).
  await panel.click("#tailorApproveBtn");
  let hadConfirm = false;
  try {
    await panel.waitForSelector("#tailorConfirm button.primary", { state: "visible", timeout: 4000 });
    hadConfirm = true;
    await panel.click("#tailorConfirm button.primary");
  } catch { /* no red flags → no confirm step */ }
  await panel.waitForFunction(() => /Approved ✓/.test(document.getElementById("tailorStatus")?.textContent || ""), null, { timeout: 10000 });
  if (!LIVE) check("approve: red-flag confirm was required (two-step, in-DOM)", hadConfirm);
  check("approve: download button enabled post-approve", !(await panel.locator("#tailorDownloadBtn").isDisabled()));

  // ---- (9) tailoredResumes[jobKey] written with a real %PDF + expected filename shape
  const rec = await sw.evaluate(async (key) => {
    const s = (await chrome.storage.local.get("tailoredResumes")).tailoredResumes || {};
    return s[key] || null;
  }, jobKey);
  check("approve: tailoredResumes[jobKey] persisted", !!rec, rec ? rec.id : "(missing)");
  check("approve: pdfB64 decodes to a %PDF document", !!rec && isPdf(rec.pdfB64), rec && `${b64Len(rec.pdfB64)} bytes`);
  check("approve: pdfName shape '<camelName><Company> CV.pdf'",
    !!rec && / CV\.pdf$/.test(rec.pdfName) && /michaelScott/.test(rec.pdfName) && /Testry/i.test(rec.pdfName), rec && rec.pdfName);
  check("approve: record carries ats/company/title/analysis/flags",
    !!rec && rec.ats === "AshbyHQ" && rec.company === "Testry Robotics" && !!rec.approvedAt && Array.isArray(rec.flags) && !!rec.analysisAfter,
    rec && `${rec.ats} · ${rec.company} · ${(rec.flags || []).length} flags`);
  const PDF_NAME = rec?.pdfName;
  const TAILORED_SIZE = b64Len(rec?.pdfB64);

  // ================================================================ PHASE C: autofill approved
  // → the file input must receive the TAILORED PDF (name === pdfName, size === decoded bytes).
  await panel.click('.tab[data-view="apply"]');
  await panel.click("#autofillBtn");
  await panel.waitForFunction(
    () => [...document.querySelectorAll(".bubble")].some((b) => /^Done: |^Autofill failed/.test(b.innerText)),
    null, { timeout: 180000 },
  );
  const doneA = await panel.evaluate(() => [...document.querySelectorAll(".bubble")].map((b) => b.innerText).filter((t) => /^Done: |^Autofill failed/.test(t)).pop());
  check("approved-job autofill completed", /^Done: /.test(doneA || ""), doneA);
  const usedTailoredChip = await panel.evaluate(() =>
    [...document.querySelectorAll(".bubble.note-msg")].some((b) => /résumé: tailored/.test(b.innerText)));
  check("approved-job: panel reports uploading the TAILORED résumé", usedTailoredChip);

  const uploadedApproved = await jobPage.evaluate(() => {
    const inp = document.querySelector('#application-form input[type="file"]');
    const f = inp && inp.files && inp.files[0];
    return f ? { name: f.name, size: f.size } : null;
  });
  check("approved-job: file input received the TAILORED file (name)",
    uploadedApproved && uploadedApproved.name === PDF_NAME, uploadedApproved && `${uploadedApproved.name}`);
  check("approved-job: file input received the TAILORED file (size === decoded pdfB64)",
    uploadedApproved && uploadedApproved.size === TAILORED_SIZE, uploadedApproved && `${uploadedApproved.size} vs ${TAILORED_SIZE}`);

  // ---- tracker link: the application row for this job carries the tailored résumé id
  const linked = await sw.evaluate(async (key) => {
    const apps = (await chrome.storage.local.get("applications")).applications || {};
    const tr = (await chrome.storage.local.get("tailoredResumes")).tailoredResumes || {};
    const a = apps[key];
    return a ? { tailoredResumeId: a.tailoredResumeId, recId: tr[key]?.id, ats: a.ats } : null;
  }, jobKey);
  check("tracker link: application.tailoredResumeId === tailoredResumes[jobKey].id",
    linked && linked.tailoredResumeId && linked.tailoredResumeId === linked.recId, JSON.stringify(linked));

  // ---- jobKey identity (the C1/C2/C3 fix): the key the AUTOFILL upload path derived must
  // equal the key the TAILOR flow used. The autofill records its application under its own
  // canonical jobKey (resolveJobKey → JA_EXTRACT_JOBID, content-side, form frame). If that
  // key matches `jobKey` (captured from tailorPending in Phase B), the two flows agree — the
  // approved tailored PDF is found and uploaded (already proven above) BECAUSE the keys are one.
  const appKeysAfterApproved = await sw.evaluate(async () =>
    Object.keys((await chrome.storage.local.get("applications")).applications || {}));
  check("jobKey identity: autofill recorded the application under the SAME jobKey the tailor flow used",
    appKeysAfterApproved.includes(jobKey), `tailor jobKey=${jobKey} · app keys=[${appKeysAfterApproved.join(", ")}]`);

  // ================================================================ PHASE D: autofill OTHER job
  // → a DIFFERENT jobKey (no approved tailoring) must upload the ORIGINAL résumé.
  await jobPage.goto(OTHER_URL, { waitUntil: "domcontentloaded" });
  await panel.click("#autofillBtn");
  await panel.waitForFunction(
    (prev) => {
      const notes = [...document.querySelectorAll(".bubble")].map((b) => b.innerText).filter((t) => /^Done: |^Autofill failed/.test(t));
      return notes.length > prev;
    },
    // count of Done/failed notes BEFORE this run
    await panel.evaluate(() => [...document.querySelectorAll(".bubble")].filter((b) => /^Done: |^Autofill failed/.test(b.innerText)).length),
    { timeout: 180000 },
  );
  const doneB = await panel.evaluate(() => [...document.querySelectorAll(".bubble")].map((b) => b.innerText).filter((t) => /^Done: |^Autofill failed/.test(t)).pop());
  check("other-job autofill completed", /^Done: /.test(doneB || ""), doneB);
  const usedOriginalChip = await panel.evaluate(() =>
    [...document.querySelectorAll(".bubble.note-msg")].some((b) => /résumé: original/.test(b.innerText)));
  check("other-job: panel reports uploading the ORIGINAL résumé", usedOriginalChip);

  const uploadedOther = await jobPage.evaluate(() => {
    const inp = document.querySelector('#application-form input[type="file"]');
    const f = inp && inp.files && inp.files[0];
    return f ? { name: f.name, size: f.size } : null;
  });
  check("other-job: file input received the ORIGINAL file (name)",
    uploadedOther && uploadedOther.name === ORIGINAL_NAME, uploadedOther && uploadedOther.name);
  check("other-job: file input received the ORIGINAL file (size === decoded original b64)",
    uploadedOther && uploadedOther.size === ORIGINAL_SIZE, uploadedOther && `${uploadedOther.size} vs ${ORIGINAL_SIZE}`);
  check("upload routing: tailored and original are DISTINCT files",
    uploadedApproved && uploadedOther && (uploadedApproved.name !== uploadedOther.name || uploadedApproved.size !== uploadedOther.size),
    `${uploadedApproved?.name}/${uploadedApproved?.size} vs ${uploadedOther?.name}/${uploadedOther?.size}`);

  // ---- spend counter moved (real usage accounting flowed through every model call)
  const spendText = await panel.locator("#spendLine").innerText();
  const spendSession = Number((spendText.match(/\$([\d.]+) session/) || [])[1] || 0);
  check("spend counter accumulated across the flow", spendSession > 0, spendText);

  await panel.screenshot({ path: path.join(ART, "panel-tailor.png"), fullPage: true }).catch(() => {});
  console.log("\nNEVER submitting — closing without touching the submit button.");
} catch (e) {
  check("harness ran to completion", false, String(e).split("\n").slice(0, 3).join(" | "));
} finally {
  await finish(context, server, results);
}
