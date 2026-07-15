// Live verification matrix (step-2 requirement): drive the config engine against REAL
// postings across as many ATSes as are publicly reachable. Fill-only — NEVER submits
// (no submit/continue button is ever clicked here). Also captures each reached form's
// static DOM to test/fixtures/<ats>.html for the offline regression suite.
//
//   node test/live-matrix.mjs             (all targets)
//   ONLY=Lever,AshbyHQ node test/live-matrix.mjs
//
// Engine + values are injected directly into the page (no extension needed): this
// verifies exactly the stack the extension runs — detectAts → resolveConfigValues →
// runConfigFill — against live DOMs.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "test", "fixtures");
const ART = path.join(ROOT, "test", "artifacts");
fs.mkdirSync(FIX, { recursive: true });
fs.mkdirSync(ART, { recursive: true });

const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "reference/ats-selectors.json"), "utf8"));
const MAPS = JSON.parse(fs.readFileSync(path.join(ROOT, "reference/value-maps.json"), "utf8"));
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, "config-engine.js"), "utf8");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const sandbox = {};
(new Function("globalThis", `${src("profile-schema.js")}\n${src("ai.js")}\nglobalThis.JA_AI=JA_AI;globalThis.JA_SAMPLE_PROFILE=JA_SAMPLE_PROFILE;`))(sandbox);
const RESOLVED = sandbox.JA_AI.resolveConfigValues(sandbox.JA_SAMPLE_PROFILE, {
  maps: MAPS, resumeFileName: "resume.pdf",
});

// Per-ATS discovery: board URL(s) → a reachable application form. Kept honest: a
// target that can't be reached (login wall, dead slug) reports that, not a fake pass.
const TARGETS = [
  {
    ats: "Greenhouse",
    boards: ["https://job-boards.greenhouse.io/gitlab", "https://job-boards.greenhouse.io/figma"],
    async find(page, board) {
      await page.goto(board, { waitUntil: "domcontentloaded", timeout: 30000 });
      const href = await page.locator('a[href*="/jobs/"]').first().getAttribute("href", { timeout : 8000 });
      if (!href) return null;
      await page.goto(new URL(href, page.url()).toString(), { waitUntil: "domcontentloaded" });
      return (await page.locator("#application-form input").count()) > 0 ? page.url() : null;
    },
  },
  {
    ats: "Lever",
    boards: ["https://jobs.lever.co/plaid", "https://jobs.lever.co/attentive", "https://jobs.lever.co/highspot", "https://jobs.lever.co/zoox"],
    async find(page, board) {
      await page.goto(board, { waitUntil: "domcontentloaded", timeout: 30000 });
      const href = await page.locator("a.posting-title, a[href*='jobs.lever.co']:has(h5)").first().getAttribute("href", { timeout: 8000 }).catch(() => null);
      if (!href) return null;
      const applyUrl = href.replace(/\/?$/, "") + "/apply";
      await page.goto(applyUrl, { waitUntil: "domcontentloaded" });
      return (await page.locator("#application-form, .application-form, form[action*='lever']").count()) > 0 ? page.url() : null;
    },
  },
  {
    ats: "AshbyHQ",
    boards: ["https://jobs.ashbyhq.com/ramp", "https://jobs.ashbyhq.com/linear", "https://jobs.ashbyhq.com/replit", "https://jobs.ashbyhq.com/deel"],
    async find(page, board) {
      await page.goto(board, { waitUntil: "networkidle", timeout: 40000 }).catch(() => {});
      const href = await page.locator(`a[href^="${new URL(board).pathname}/"]`).first().getAttribute("href", { timeout: 8000 }).catch(() => null);
      if (!href) return null;
      await page.goto(new URL(href + "/application", page.url()).toString(), { waitUntil: "networkidle", timeout: 40000 }).catch(() => {});
      return (await page.locator("input").count()) > 2 ? page.url() : null;
    },
  },
  {
    ats: "Workable",
    boards: ["https://apply.workable.com/huble", "https://apply.workable.com/proxify", "https://apply.workable.com/turnitin"],
    async find(page, board) {
      await page.goto(board, { waitUntil: "networkidle", timeout: 40000 }).catch(() => {});
      const href = await page.locator('a[href*="/j/"]').first().getAttribute("href", { timeout: 8000 }).catch(() => null);
      if (!href) return null;
      const jobUrl = new URL(href, page.url()).toString().replace(/\/$/, "");
      await page.goto(jobUrl + "/apply/", { waitUntil: "networkidle", timeout: 40000 }).catch(() => {});
      return (await page.locator("form input").count()) > 2 ? page.url() : null;
    },
  },
  {
    ats: "SmartRecruiters",
    boards: ["https://careers.smartrecruiters.com/SmartRecruiters1", "https://careers.smartrecruiters.com/SmartRecruiters", "https://careers.smartrecruiters.com/Bosch", "https://careers.smartrecruiters.com/ServiceNow"],
    async find(page, board) {
      await page.goto(board, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
      const href = await page.locator('a[href*="jobs.smartrecruiters.com/"][href*="-"]').first().getAttribute("href", { timeout: 8000 }).catch(() => null);
      if (!href) return null;
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
      // The oneclick apply UI renders after clicking "I'm interested"/Apply
      await page.locator("a:has-text('Apply'), button:has-text('Apply'), a:has-text(\"I'm interested\")").first().click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(4000);
      return (await page.locator("input").count()) > 2 ? page.url() : null;
    },
  },
  {
    ats: "Recruitee",
    boards: ["https://sendcloud.recruitee.com", "https://usercentrics.recruitee.com", "https://onefootball.recruitee.com", "https://packhelp.recruitee.com", "https://gstore.recruitee.com"],
    async find(page, board) {
      await page.goto(board, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      const href = await page.locator('a[href*="/o/"]').first().getAttribute("href", { timeout: 8000 }).catch(() => null);
      if (!href) return null;
      const u = new URL(href, page.url()).toString().replace(/\/$/, "");
      await page.goto(u + "/c/new", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      if ((await page.locator("form input").count()) > 2) return page.url();
      await page.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {});
      return (await page.locator("form input").count()) > 2 ? page.url() : null;
    },
  },
  {
    ats: "BreezyHR",
    boards: ["https://breezy-hr.breezy.hr", "https://remotivate.breezy.hr", "https://get-beyond.breezy.hr", "https://joinhomebase.breezy.hr"],
    async find(page, board) {
      await page.goto(board, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      const href = await page.locator('a[href*="/p/"]').first().getAttribute("href", { timeout: 8000 }).catch(() => null);
      if (!href) return null;
      await page.goto(new URL(href, page.url()).toString(), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.locator("a:has-text('Apply'), button:has-text('Apply')").first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
      return (await page.locator("form input").count()) > 2 ? page.url() : null;
    },
  },
  {
    ats: "Jobvite",
    boards: ["https://jobs.jobvite.com/jobvite", "https://jobs.jobvite.com/scholastic", "https://jobs.jobvite.com/ringcentral/jobs", "https://jobs.jobvite.com/haemonetics"],
    async find(page, board) {
      await page.goto(board, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      const href = await page.locator('a[href*="/job/"]').first().getAttribute("href", { timeout: 8000 }).catch(() => null);
      if (!href) return null;
      const u = new URL(href, page.url()).toString();
      await page.goto(u.includes("/apply") ? u : u.replace(/\/?$/, "/apply"), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      return (await page.locator("form input").count()) > 2 ? page.url() : null;
    },
  },
  {
    ats: "Teamtailor",
    boards: ["https://career.oneflow.com", "https://jobs.mentimeter.com", "https://career.kry.se"],
    async find(page, board) {
      await page.goto(board, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      const href = await page.locator('a[href*="/jobs/"]').first().getAttribute("href", { timeout: 8000 }).catch(() => null);
      if (!href) return null;
      const u = new URL(href, page.url()).toString().replace(/\/$/, "");
      await page.goto(u + "/applications/new", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      if ((await page.locator("form input").count()) > 2) return page.url();
      await page.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.locator("a:has-text('Apply'), button:has-text('Apply')").first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
      return (await page.locator("form input").count()) > 2 ? page.url() : null;
    },
  },
  {
    ats: "Workday",
    boards: [
      "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite",
      "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site",
    ],
    loginWalled: true, // application form sits behind account creation; verify detect + posting page only
    async find(page, board) {
      await page.goto(board, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
      const href = await page.locator('a[data-automation-id="jobTitle"]').first().getAttribute("href", { timeout: 10000 }).catch(() => null);
      if (!href) return null;
      await page.goto(new URL(href, page.url()).toString(), { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
      return page.url();
    },
  },
];

const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const browser = await chromium.launch({ headless: true });
// bypassCSP: harness-only — page CSP blocks addScriptTag on some ATSes (Ashby); the
// real extension's isolated world is not subject to page CSP.
const bctx = await browser.newContext({ bypassCSP: true });
const report = [];

for (const target of TARGETS) {
  if (only && !only.has(target.ats)) continue;
  const page = await bctx.newPage();
  page.setDefaultTimeout(20000);
  let row = { ats: target.ats, status: "unreachable", url: null };
  try {
    let formUrl = null;
    for (const board of target.boards) {
      try { formUrl = await target.find(page, board); } catch { formUrl = null; }
      if (formUrl) break;
    }
    if (!formUrl) { row.status = "unreachable (no live posting found)"; report.push(row); await page.close(); continue; }
    row.url = formUrl;

    // Capture the pristine form DOM as an offline fixture (scripts stripped: fixtures
    // verify selector resolution, not framework behavior).
    const html = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll("script, link[rel='stylesheet'], iframe[src*='captcha'], noscript").forEach((n) => n.remove());
      return "<!doctype html>\n" + clone.outerHTML;
    });
    fs.writeFileSync(path.join(FIX, `${target.ats.toLowerCase()}.html`), html);
    row.fixture = `test/fixtures/${target.ats.toLowerCase()}.html`;

    // Detection + engine run on the live DOM (REAL fill, никогда not submitted).
    await page.addScriptTag({ content: ENGINE_SRC });
    const out = await page.evaluate(async ({ cfg, values, maps, loginWalled }) => {
      let det = JA_CFG.detectAts(cfg, location.href);
      if (!det) {
        // Embedded-only playbooks: container probe (same as the extension's fallback).
        const candidates = JA_CFG.buildProbeCandidates(cfg);
        const name = JA_CFG.probeContainers(candidates);
        if (name) det = { name, entry: cfg[name] };
      }
      if (!det) return { detected: null };
      if (det.blocked) return { detected: det.name, blocked: true };
      if (loginWalled) {
        return {
          detected: det.name,
          jobId: JA_CFG.extractJobId(det.entry, location, det.name),
          loginWalled: true,
        };
      }
      const r = await JA_CFG.runConfigFill(det.entry, values, {
        atsName: det.name, maps,
        files: { resume: { name: "resume.pdf", type: "application/pdf", bytes: [37, 80, 68, 70, 45] } },
      });
      const counts = {};
      for (const x of r.results || []) counts[x.status] = (counts[x.status] || 0) + 1;
      return {
        detected: det.name,
        ran: r.ok,
        reason: r.reason || null,
        jobId: r.jobId,
        counts,
        filledKeys: (r.results || []).filter((x) => x.status === "filled" || x.status === "already-set").map((x) => `${x.key}${x.method ? `(${x.method})` : ""}`),
        failures: (r.results || []).filter((x) => !["filled", "already-set", "no-value", "not-found", "not-visible", "skipped-by-design", "dry-run"].includes(x.status))
          .map((x) => `${x.key}:${x.status}`),
      };
    }, { cfg: CFG, values: RESOLVED.values, maps: MAPS, loginWalled: !!target.loginWalled });

    if (!out.detected) row.status = "reached form but detectAts MISSED";
    else if (out.detected !== target.ats) row.status = `detected as ${out.detected} (expected ${target.ats})`;
    else if (out.loginWalled) row.status = "detected + jobId OK (application login-walled — fill not reachable)";
    else if (out.ran === false) row.status = `engine skipped: ${out.reason}`;
    else {
      const filled = out.filledKeys?.length || 0;
      row.status = filled >= 3 ? `VERIFIED (${filled} fields filled live)` : `weak (${filled} filled)`;
    }
    Object.assign(row, out);
    await page.screenshot({ path: path.join(ART, `live-${target.ats.toLowerCase()}.png`), fullPage: false }).catch(() => {});
  } catch (e) {
    row.status = `error: ${String(e).slice(0, 140)}`;
  }
  report.push(row);
  console.log(`${target.ats.padEnd(16)} ${row.status}${row.url ? `\n${" ".repeat(17)}${row.url}` : ""}${row.filledKeys ? `\n${" ".repeat(17)}filled: ${row.filledKeys.join(", ").slice(0, 220)}` : ""}${row.failures?.length ? `\n${" ".repeat(17)}failures: ${row.failures.join(", ")}` : ""}`);
}

await browser.close();
// Merge with prior runs (subset re-runs must not erase other ATSes' results).
let merged = report;
try {
  const prev = JSON.parse(fs.readFileSync(path.join(ART, "live-matrix.json"), "utf8"));
  const ran = new Set(report.map((r) => r.ats));
  merged = [...prev.filter((r) => !ran.has(r.ats)), ...report];
} catch { /* first run */ }
fs.writeFileSync(path.join(ART, "live-matrix.json"), JSON.stringify(merged, null, 1));
const verified = merged.filter((r) => /^VERIFIED/.test(r.status)).length;
console.log(`\n${verified} ATSes live-verified · full report: test/artifacts/live-matrix.json`);
