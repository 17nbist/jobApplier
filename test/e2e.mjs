// jobApplier autofill e2e: load the unpacked extension, drive a LIVE Greenhouse posting
// (fill-only — never submit), assert the hybrid routing (config-driven fill first, LLM
// only for the leftovers), real DOM fills incl. the résumé upload, React value
// retention, thinking stream, config disk-freshness (the refresh flow's premise), and
// the legal guard.
//
//   npx playwright install chromium   (once)
//   node test/e2e.mjs                 (headed, mock model; HEADLESS=1 for new-headless)
//   OPENROUTER_API_KEY=sk-or-… LIVE=1 node test/e2e.mjs   (real GLM 5.2)
import { createMockServer, PORT, MOCK_VALUES } from "./mock-openrouter.mjs";
import { ART, EXT, makeChecker, launchExtension, openPanel, finish } from "./harness.mjs";
import path from "node:path";
import fs from "node:fs";

// Tiny but valid one-page PDF so the résumé upload has real bytes to inject.
const FAKE_PDF_B64 = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF",
).toString("base64");

// Public Greenhouse boards to try until one yields a posting with an application form.
const BOARDS = ["gitlab", "duolingo", "discord", "brex", "figma", "greenhouse"];

const LIVE = !!process.env.LIVE && !!process.env.OPENROUTER_API_KEY;
const { results, check } = makeChecker();

const server = await createMockServer();
console.log(`mock OpenRouter on :${PORT} · live mode: ${LIVE}`);
let context;

try {
  const launched = await launchExtension();
  context = launched.context;
  const { sw, extId } = launched;
  check("extension loaded (service worker up)", !!extId, extId);

  // ---- find a live posting with an application form
  const jobPage = await context.newPage();
  jobPage.setDefaultTimeout(30000);
  let jobUrl = null;
  for (const board of BOARDS) {
    try {
      await jobPage.goto(`https://job-boards.greenhouse.io/${board}`, { waitUntil: "domcontentloaded" });
      const href = await jobPage
        .locator(`a[href*="/${board}/jobs/"]`).first()
        .getAttribute("href", { timeout: 8000 });
      if (!href) continue;
      const url = new URL(href, jobPage.url()).toString();
      await jobPage.goto(url, { waitUntil: "domcontentloaded" });
      if (await jobPage.locator("form#application-form input").count() > 0) { jobUrl = url; break; }
      await jobPage.locator("text=/apply/i").first().click({ timeout: 3000 }).catch(() => {});
      if (await jobPage.locator("form#application-form input").count() > 0) { jobUrl = jobPage.url(); break; }
    } catch { /* next board */ }
  }
  check("found live Greenhouse posting with form", !!jobUrl, jobUrl || "none of the candidate boards worked");
  if (!jobUrl) throw new Error("no live posting found — cannot continue");

  // ---- seed extension storage from the SW (before any panel page runs its init — the
  // panel writes state on first load and would race a page-side seed)
  const jobTabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "*://job-boards.greenhouse.io/*" });
    return tabs[0]?.id;
  });
  check("job tab id resolved", !!jobTabId, String(jobTabId));

  await sw.evaluate(async ({ live, port, mock, key, pdfB64 }) => {
    const profile = {
      personal_information: {
        first_name: mock.first, last_name: mock.last, email: mock.email,
        phone: mock.phone, phone_country_code: "+1", location: "San Francisco, CA, USA",
        city: "San Francisco", state: "California", country: "United States", zip_code: "94103",
        linkedin: mock.linkedin, github: mock.github, portfolio: mock.site,
      },
      legal_authorization: { us_work_authorization: "Yes", requires_us_visa: "No", requires_us_sponsorship: "No" },
      self_identification: {
        gender: "Decline To Self Identify", pronouns: "", transgender: "",
        ethnicity: "Decline To Self Identify", hispanic: "Decline To Self Identify",
        veteran: "I don't wish to answer", disability: "I don't want to answer", lgbtq: "",
      },
      work_preferences: { remote_work: "Yes", open_to_relocation: "Yes" },
      availability: { notice_period: "June 2027" }, salary_expectations: { salary_range_usd: "" },
      education_details: [], experience_details: [], projects: [], certifications: [], languages: [],
      skills: "JavaScript, Python", resume_text: "Testy McTestface — SWE. Built things.",
    };
    await chrome.storage.local.set({
      profile,
      resumeFile: { name: "resume.pdf", type: "application/pdf", b64: pdfB64 },
      state: {
        apiKey: live ? key : "test-key",
        model: "z-ai/glm-5.2",
        apiBase: live ? "" : `http://127.0.0.1:${port}/v1`,
      },
    });
  }, { live: LIVE, port: PORT, mock: MOCK_VALUES, key: process.env.OPENROUTER_API_KEY || "", pdfB64: FAKE_PDF_B64 });

  const panel = await openPanel(context, extId, `?tab=${jobTabId}`);

  // ---- scan
  await panel.click("#scanBtn");
  await panel.waitForSelector(".bubble.note-msg", { timeout: 20000 });
  const scanText = await panel.locator(".bubble.note-msg").first().innerText();
  check("scan finds fields", /Scanned: [1-9]\d* fields/.test(scanText), scanText.split("\n")[0]);
  check("scan flags legal fields", /\([1-9]\d* legal/.test(scanText), scanText);

  // ---- autofill (scan → legal deterministic → LLM map → fill with real events)
  await panel.click("#autofillBtn");
  await panel.waitForFunction(
    () => [...document.querySelectorAll(".bubble")].some((b) => /^Done: /.test(b.innerText) || /^Autofill failed/.test(b.innerText)),
    null,
    { timeout: 180000 },
  );
  const doneText = await panel.evaluate(
    () => [...document.querySelectorAll(".bubble")].map((b) => b.innerText).filter((t) => /^Done: |^Autofill failed/.test(t)).pop(),
  );
  check("autofill completes", /^Done: /.test(doneText || ""), doneText);

  // ---- hybrid routing: config pass ran first and covered the basics; the LLM only
  // got the leftovers (step-2 core assertion).
  const notes = await panel.evaluate(() => [...document.querySelectorAll(".bubble")].map((b) => b.innerText));
  const cfgNote = notes.find((t) => /^Config pass: /.test(t)) || "";
  const cfgFilled = Number((cfgNote.match(/Config pass: (\d+) filled/) || [])[1] || 0);
  check("config-driven pass ran (ATS detected)", notes.some((t) => /^ATS detected: Greenhouse/.test(t)), notes.find((t) => /^ATS detected/.test(t)));
  check("config pass filled core fields deterministically", cfgFilled >= 4, cfgNote);
  const scanned = Number(((notes.find((t) => /fields ·/.test(t)) || (await panel.locator("#targetInfo").innerText())).match(/(\d+) fields/) || [])[1] || 0);
  const mappedN = Number(((notes.find((t) => /^Mapping \d+ remaining/.test(t)) || "").match(/Mapping (\d+)/) || [])[1] || NaN);
  check("LLM only mapped the leftovers (fewer than scanned fields)",
    Number.isNaN(mappedN) ? cfgFilled > 0 : mappedN < scanned, `scanned≈${scanned}, LLM-mapped=${Number.isNaN(mappedN) ? "0 (all covered)" : mappedN}`);
  const cfgChips = await panel.evaluate(() =>
    [...document.querySelectorAll("table.report.config .chip")].filter((c) => ["filled", "already-set"].includes(c.dataset.status)).length);
  check("config report table shows filled rows", cfgChips >= 4, `${cfgChips} config chips filled`);

  // ---- résumé upload accepted by the real form. Greenhouse's attach widget consumes
  // the change event, stores the file in its own state (rendering a filename chip),
  // and clears the input for re-selection — so assert the chip OR a still-populated
  // input, not input.files alone.
  const uploadedSignal = await jobPage.evaluate(() => {
    const inputPopulated = [...document.querySelectorAll('input[type="file"]')].some((i) => i.files?.length > 0);
    const chip = /resume\.pdf/i.test(document.body.innerText);
    return { inputPopulated, chip };
  });
  check("résumé PDF accepted by the form (chip or populated input)",
    uploadedSignal.chip || uploadedSignal.inputPopulated, JSON.stringify(uploadedSignal));

  const viaConfig = Number((doneText?.match(/(\d+) via config/) || [])[1] || 0);
  const viaAi = Number((doneText?.match(/(\d+) via AI\/profile/) || [])[1] || 0);
  check("autofill filled fields overall", viaConfig + viaAi >= 3, `${viaConfig} config + ${viaAi} AI/profile`);

  // ---- essay pass (soft: only when the form actually had open-ended questions).
  // Answered chips legitimately transition answered→filled, so the count rides the
  // Done note.
  const essayNote = notes.find((t) => /^Answering \d+ open-ended/.test(t));
  if (essayNote) {
    // The pipeline must COMPLETE; the count may legitimately be 0 when the model
    // (correctly) declines questions not derivable from the profile (live behavior).
    const essayN = (doneText?.match(/(\d+) essay answer\(s\)/) || [])[1];
    check("essay batch pipeline completed", essayN !== undefined, `${essayNote} → ${essayN} answered`);
    if (!LIVE) check("essay batch produced answers (mock)", Number(essayN) > 0, `${essayN} answered`);
  } else {
    console.log("(no open-ended questions on this posting — essay pass not exercised here; covered by unit/mock paths)");
  }

  // Per-field outcome dump (diagnostic) — machine-readable via chip dataset.status.
  const rows = await panel.evaluate(() =>
    [...document.querySelectorAll(".report tr")].map((r) => ({
      label: (r.cells[0]?.innerText || "").slice(0, 48),
      value: (r.cells[1]?.innerText || "").slice(0, 32),
      status: r.cells[2]?.querySelector(".chip")?.dataset.status || "",
    })));
  console.log("--- field report ---\n" +
    rows.map((r) => `${r.label} | ${r.value} | ${r.status}`).join("\n") + "\n--------------------");

  // ---- assert on the real page DOM
  const domValue = (v) => jobPage.evaluate(
    (val) => [...document.querySelectorAll("input, textarea")].some((el) => el.value === val), v);
  check("first name landed in real form", await domValue(MOCK_VALUES.first));
  check("last name landed in real form", await domValue(MOCK_VALUES.last));
  check("email landed in real form", await domValue(MOCK_VALUES.email));

  // React retention: blur everything, give React a tick, re-check (the _valueTracker trap).
  await jobPage.click("body").catch(() => {});
  await jobPage.waitForTimeout(500);
  check("value survives blur/re-render (React retention)", await domValue(MOCK_VALUES.first));

  await jobPage.screenshot({ path: path.join(ART, "job-page-after-fill.png"), fullPage: true });
  await panel.screenshot({ path: path.join(ART, "panel-after-fill.png"), fullPage: true });

  // ---- thinking visible (collapsed details → read textContent)
  const thinking = await panel.evaluate(() => {
    const d = document.querySelector("details.thinking");
    return { text: d?.querySelector("pre")?.textContent || "", summary: d?.querySelector("summary")?.innerText || "" };
  });
  check("thinking stream rendered", thinking.text.trim().length > 0 && /done/.test(thinking.summary),
    `${thinking.text.trim().length} chars · "${thinking.summary}"`);

  // ---- cover letter
  await panel.click("#coverBtn");
  await panel.waitForFunction(
    () => [...document.querySelectorAll(".bubble")].some((b) => /Sincerely,/.test(b.innerText)) ||
          [...document.querySelectorAll(".bubble.error-msg")].some((b) => /Cover letter failed/.test(b.innerText)),
    null,
    { timeout: 180000 },
  );
  const gotLetter = await panel.evaluate(
    () => [...document.querySelectorAll(".bubble")].some((b) => /Sincerely,/.test(b.innerText)));
  check("cover letter streamed into panel", gotLetter);
  await panel.screenshot({ path: path.join(ART, "panel-cover-letter.png"), fullPage: true });

  // ---- cover letter with PASTED job details (override path): the paste must replace the
  // scraped JD in the request (mock echoes the JA-TEST-PASTED-JD marker back into the
  // letter) and the panel must announce it's using the paste.
  await panel.evaluate(() => {
    document.getElementById("coverJdWrap").open = true;
    document.getElementById("coverJdInput").value =
      "JA-TEST-PASTED-JD: senior backend role, Ruby, payments infrastructure.";
  });
  await panel.click("#coverBtn");
  await panel.waitForFunction(
    () => [...document.querySelectorAll(".bubble")].some((b) => /JA-TEST-PASTED-JD echo/.test(b.innerText)) ||
          [...document.querySelectorAll(".bubble.error-msg")].some((b) => /Cover letter failed/.test(b.innerText)),
    null,
    { timeout: 180000 },
  );
  const pasteEchoed = await panel.evaluate(
    () => [...document.querySelectorAll(".bubble")].some((b) => /JA-TEST-PASTED-JD echo/.test(b.innerText)));
  check("pasted job details reached the model request (override path)", pasteEchoed);
  const saidUsingPaste = await panel.evaluate(
    () => [...document.querySelectorAll(".bubble")].some((b) => /Using your pasted job details/.test(b.innerText)));
  check("panel announced the paste override", saidUsingPaste);

  // ---- spend counter visible and accumulating (user requirement)
  const spendText = await panel.locator("#spendLine").innerText();
  const spendSession = Number((spendText.match(/\$([\d.]+) session/) || [])[1] || 0);
  check("spend counter visible and accumulating", spendSession > 0, spendText);

  // ---- Part A3: config disk-freshness. The refresh flow's premise is that an unpacked
  // extension's fetch() reads resource files from disk, so a config refresh needs no
  // extension reload. Prove it: write a probe file inside the extension dir, fetch it
  // from the panel, change it on disk, fetch again — the second read must see v2.
  {
    const probeAbs = path.join(EXT, "test", "artifacts", "freshness-probe.json");
    const probeRel = "test/artifacts/freshness-probe.json";
    const fetchProbe = () => panel.evaluate(async (rel) => {
      const r = await fetch(chrome.runtime.getURL(rel) + `?t=${Date.now()}`, { cache: "no-store" });
      return r.ok ? (await r.json()).v : `HTTP ${r.status}`;
    }, probeRel);
    fs.writeFileSync(probeAbs, JSON.stringify({ v: 1 }));
    const v1 = await fetchProbe();
    fs.writeFileSync(probeAbs, JSON.stringify({ v: 2 }));
    const v2 = await fetchProbe();
    fs.unlinkSync(probeAbs);
    check("config refresh premise: unpacked fetch reads fresh bytes from disk (no reload)", v1 === 1 && v2 === 2, `first=${v1} second=${v2}`);
  }

  // ---- refresh loop END-TO-END: reference/ is the single source of truth — a changed
  // ATS entry on disk must change engine behavior after a re-fetch, with no code edits
  // and no extension reload. Simulates what reference/refresh.js does when upstream
  // ships a selector update: mutate Greenhouse.urls, re-load, detect; then restore.
  {
    const cfgPath = path.join(EXT, "reference", "ats-selectors.json");
    const original = fs.readFileSync(cfgPath, "utf8");
    try {
      const mutated = JSON.parse(original);
      mutated.Greenhouse.urls = [...mutated.Greenhouse.urls, "*://config-loop-probe.example/*"];
      fs.writeFileSync(cfgPath, JSON.stringify(mutated));
      const detected = await panel.evaluate(async () => {
        const { atsConfig } = await loadAtsConfig(true); // the panel's own loader, forced re-fetch
        return JA_CFG.detectAts(atsConfig, "https://config-loop-probe.example/jobs/1")?.name || null;
      });
      check("refresh loop e2e: changed reference entry picked up via re-fetch (no reload, no code edits)",
        detected === "Greenhouse", `detectAts on probe URL → ${detected}`);
    } finally {
      fs.writeFileSync(cfgPath, original); // byte-identical restore
    }
    const restored = await panel.evaluate(async () => {
      const { atsConfig } = await loadAtsConfig(true);
      return JA_CFG.detectAts(atsConfig, "https://config-loop-probe.example/jobs/1")?.name || null;
    });
    check("refresh loop e2e: restore also picked up (loader holds no stale cache)", restored === null, String(restored));
  }

  // ---- legal guard: no legal-looking row may carry an AI-produced status. The legalish
  // regex is deliberately independent of ai.js's LEGAL_PATTERNS (a guard test should be
  // its own oracle). "mapped" is the only AI-value status; legal rows must show
  // legal-profile / legal-manual / fill outcomes only.
  const legalLeak = await panel.evaluate(() => {
    const legalish = /(gender|veteran|disab|ethnic|hispanic|sponsor|authoriz|eligib|lgbt|transgender|pronoun|visa|citizen)/i;
    return [...document.querySelectorAll(".report tr")]
      .filter((r) => legalish.test(r.cells[0]?.innerText || ""))
      .some((r) => (r.cells[2]?.querySelector(".chip")?.dataset.status || "") === "mapped");
  });
  check("no legal field was AI-mapped (guard held)", !legalLeak);

  // ---- step 3: tracker recorded the application + telemetry (+ breaks if any)
  const tracked = await panel.evaluate(() => chrome.storage.local.get(["applications", "fillTelemetry", "breaks"]));
  const apps = Object.values(tracked.applications || {});
  check("tracker recorded exactly one application", apps.length === 1, `${apps.length} apps`);
  const app = apps[0] || {};
  check("application keyed by a canonical jobId", !!app.jobId, app.jobId || "(none)");
  check("application: ATS = Greenhouse", app.ats === "Greenhouse", app.ats);
  check("application: status started (never submitted — we don't submit)", app.status === "started", app.status);
  check("application: per-app cost recorded (>0)", (app.cost || 0) > 0, `$${app.cost}`);
  check("application: résumé filename recorded", app.resumeUsed === "resume.pdf", app.resumeUsed);
  check("application: title/company captured", !!(app.title || app.company), `${app.title} @ ${app.company}`);
  check("fill telemetry: one row per field, persisted", (tracked.fillTelemetry || []).length >= 4, `${(tracked.fillTelemetry || []).length} rows`);
  // Any captured break snapshot must be scrubbed of the mock PII (privacy hard rule).
  const dirtyBreak = (tracked.breaks || []).find((b) => b.snapshot && (b.snapshot.html.includes(MOCK_VALUES.first) || b.snapshot.html.includes(MOCK_VALUES.email)));
  check("break snapshots (if any) carry no PII", !dirtyBreak, dirtyBreak ? `leaked in ${dirtyBreak.canonicalField}` : `${(tracked.breaks || []).length} breaks, all scrubbed`);

  // ---- step 3: Applications tab renders the record with its cost
  await panel.click('.tab[data-view="applications"]');
  await panel.waitForSelector("#appsList .app-card, #appsList .hint", { timeout: 10000 });
  const appsUi = await panel.evaluate(() => ({
    cards: document.querySelectorAll("#appsList .app-card").length,
    counts: document.getElementById("appsCounts")?.innerText || "",
    firstCost: document.querySelector("#appsList .app-card .cost")?.innerText || "",
  }));
  check("Applications tab lists the recorded application", appsUi.cards === 1, `${appsUi.cards} cards`);
  check("Applications tab shows counts + per-app cost", /application/.test(appsUi.counts) && /^\$/.test(appsUi.firstCost), `${appsUi.counts.split("\n")[0]} · card cost ${appsUi.firstCost}`);

  // ---- step 3: live scrub — capture the first_name field region on the REAL posting with
  // the mock PII seeded, and prove the scrub strips it (fixture-ready, PII-free).
  const liveScrub = await jobPage.evaluate((mockFirst) => {
    if (typeof JA_CFG === "undefined") return { skipped: true };
    const fn = document.querySelector("#first_name, input[name='first_name']");
    if (fn) fn.setAttribute("value", mockFirst);
    const scrubSet = JA_CFG.collectScrubStrings({ first_name: { v: mockFirst } }, [mockFirst]);
    const snap = JA_CFG.captureSnapshot(fn, document.querySelector("form") || document.body, scrubSet);
    return { html: snap?.html || "", scrubbed: !!snap?.scrubbed };
  }, MOCK_VALUES.first);
  if (!liveScrub.skipped) {
    check("live posting: capture+scrub removes the seeded PII", liveScrub.scrubbed && !liveScrub.html.includes(MOCK_VALUES.first), liveScrub.scrubbed ? "scrubbed" : "no capture");
  }

  // ---- step 3: dedup — a second autofill of the same posting warns "already applied".
  await panel.click('.tab[data-view="apply"]');
  const warnsBefore = await panel.evaluate(() => document.querySelectorAll(".bubble.warn-msg").length);
  await panel.click("#autofillBtn");
  await panel.waitForFunction(
    (n) => document.querySelectorAll(".bubble.warn-msg").length > n ||
           [...document.querySelectorAll(".bubble")].some((b) => /^Autofill failed/.test(b.innerText)),
    warnsBefore,
    { timeout: 180000 },
  );
  const dedupWarned = await panel.evaluate(() =>
    [...document.querySelectorAll(".bubble.warn-msg")].some((b) => /already applied/i.test(b.innerText)));
  check("dedup: re-visiting the same posting warns 'already applied'", dedupWarned);
  const appsAfter = await panel.evaluate(async () => Object.keys((await chrome.storage.local.get("applications")).applications || {}).length);
  check("dedup: re-visit does NOT create a second application record", appsAfter === 1, `${appsAfter} apps`);

  console.log("\nNEVER submitting — closing without touching the submit button.");
} catch (e) {
  check("harness ran to completion", false, String(e).split("\n")[0]);
} finally {
  await finish(context, server, results);
}
