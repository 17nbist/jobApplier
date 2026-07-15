// Engine behavior unit tests against synthetic DOM fixtures — proves the handlers and
// the DSL machinery do the right thing (not just that they exist). Each numbered block
// pins one behavior class; audit-caught bugs get a regression here before the fix.
//
//   node test/unit-engine.mjs
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { results, check } = makeChecker();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Fresh realm per test: the real extension loads config-engine.js once into each
// document's fresh isolated world. Playwright's setContent reuses one realm across
// calls, which accumulates globals (pending timers, a prior JA_CFG) and diverges from
// production — about:blank forces the clean per-document context the engine assumes.
async function run(html, fn, arg) {
  await page.goto("about:blank");
  await page.setContent(html);
  await page.addScriptTag({ path: path.join(ROOT, "config-engine.js") });
  return page.evaluate(fn, arg);
}

try {
  // ---- 1. `click` method: full focus→mousedown→mouseup→click sequence (A1: react-select
  // opens on mousedown; a bare click event must NOT be the default behavior).
  {
    const r = await run(`<button id="b">Open</button>`, async () => {
      const seen = [];
      const b = document.getElementById("b");
      for (const t of ["focus", "mousedown", "mouseup", "click", "blur"]) b.addEventListener(t, () => seen.push(t));
      await JA_CFG._internal.applyMethod("click", b, null, [], {}, {}, {}, null);
      return seen;
    });
    check("click method leads with mousedown (focus,mousedown,mouseup,click,blur)",
      JSON.stringify(r) === JSON.stringify(["focus", "mousedown", "mouseup", "click", "blur"]), r.join("→"));
    const r2 = await run(`<button id="b">Open</button>`, async () => {
      const seen = [];
      const b = document.getElementById("b");
      for (const t of ["mousedown", "click", "blur"]) b.addEventListener(t, () => seen.push(t));
      await JA_CFG._internal.applyMethod("click", b, null, [], {}, {}, {}, { clickOnly: true });
      return seen;
    });
    check("eventOptions.clickOnly collapses to a bare click", JSON.stringify(r2) === JSON.stringify(["click"]), r2.join("→"));
  }

  // ---- 2. react-select combobox: mousedown opens the menu, option gets real-clicked.
  {
    const r = await run(`
      <div class="select__control"><input id="combo" role="combobox" aria-expanded="false"></div>
      <div id="menu" class="select__menu" style="display:none">
        <div class="select__option" role="option">Alpha Corp</div>
        <div class="select__option" role="option">United States</div>
      </div>
      <script>
        const ctl = document.querySelector(".select__control");
        ctl.addEventListener("mousedown", () => { document.getElementById("menu").style.display = "block"; });
        ctl.addEventListener("click", () => { /* click alone must NOT be required */ });
      </script>`, async () => {
      const el = document.getElementById("combo");
      const opt = [...document.querySelectorAll('[role="option"]')][1];
      let picked = false;
      opt.addEventListener("mousedown", () => { picked = true; });
      const res = await JA_CFG._internal.applyMethod("default", el, "United States",
        [{ value: "United States", unmapped: "United States" }], null, {}, {});
      return { status: res.status, chose: res.chose, picked, menuShown: document.getElementById("menu").style.display };
    });
    check("combobox opens via mousedown and clicks the matching option",
      r.status === "filled" && r.chose === "United States" && r.picked && r.menuShown === "block", JSON.stringify(r));
  }

  // ---- 3. values-map translation + the legal-safety fallback rule.
  {
    const html = `
      <label>Sponsorship?</label>
      <input type="radio" name="sp" id="spYes" value="Yes"><label for="spYes">Yes</label>
      <input type="radio" name="sp" id="spNo" value="No"><label for="spNo">No</label>`;
    const mk = (val) => async ({ v }) => {
      const entry = {
        inputSelectors: [["sponsorship", [{
          path: './/input[@name="sp"][@value="%VALUE%"]',
          method: "click",
          values: { "true": "Yes", "": "No" },
        }]]],
      };
      const r = await JA_CFG.runConfigFill(entry, { sponsorship: { v } }, {});
      return {
        status: r.results[0].status,
        yesClicked: window.__yesClicked || false, noClicked: window.__noClicked || false,
      };
    };
    const arm = `<script>
      window.__yesClicked = false; window.__noClicked = false;
      document.getElementById("spYes").addEventListener("click", () => window.__yesClicked = true);
      document.getElementById("spNo").addEventListener("click", () => window.__noClicked = true);
    </script>`;
    const rTrue = await run(html + arm, mk(), { v: "true" });
    check("values map: canonical 'true' clicks the Yes radio", rTrue.yesClicked && !rTrue.noClicked && rTrue.status === "filled", JSON.stringify(rTrue));
    const rNo = await run(html + arm, mk(), { v: "" });
    check("values map: canonical '' (explicit No) clicks the No radio", rNo.noClicked && !rNo.yesClicked, JSON.stringify(rNo));
    // The safety deviation: an unmatched TRUTHY answer must not fall into the "" branch.
    const rWeird = await run(html + arm, mk(), { v: "Prefer not to say" });
    check("values map: unmatched truthy answer never falls back to the No branch",
      !rWeird.noClicked && !rWeird.yesClicked && rWeird.status === "not-found", JSON.stringify(rWeird));
    // Absent value → untouched entirely.
    const rAbsent = await run(html + arm, async () => {
      const entry = { inputSelectors: [["sponsorship", [{ path: './/input[@name="sp"][@value="%VALUE%"]', method: "click", values: { "true": "Yes", "": "No" } }]]] };
      const r = await JA_CFG.runConfigFill(entry, {}, {});
      return { status: r.results[0].status, yesClicked: window.__yesClicked, noClicked: window.__noClicked };
    });
    check("absent legal value → no-value, nothing clicked (rule #1)",
      rAbsent.status === "no-value" && !rAbsent.yesClicked && !rAbsent.noClicked, JSON.stringify(rAbsent));
  }

  // ---- 4. valuePathMap: per-value element paths.
  {
    const r = await run(`
      <div class="questionRow"><label>Legally authorized?</label>
        <label><span>Yes</span><input type="radio" name="auth" id="aY"></label>
        <label><span>No</span><input type="radio" name="auth" id="aN"></label></div>
      <script>window.__c=[];document.getElementById("aY").addEventListener("click",()=>window.__c.push("Y"));
      document.getElementById("aN").addEventListener("click",()=>window.__c.push("N"));</script>`, async () => {
      const entry = {
        inputSelectors: [["work_auth", [{
          method: "click",
          valuePathMap: {
            "true": './/span[text()="Yes"]/parent::label//input',
            "": './/span[text()="No"]/parent::label//input',
          },
        }]]],
      };
      const r = await JA_CFG.runConfigFill(entry, { work_auth: { v: "true" } }, {});
      return { status: r.results[0].status, clicks: window.__c };
    });
    check("valuePathMap picks the value-keyed path", r.status === "filled" && r.clicks.join() === "Y", JSON.stringify(r));
  }

  // ---- 5. repeating section: row 1 exists, row 2 needs the Add button (%NUMBER0% 1-based).
  {
    const r = await run(`
      <form id="f">
        <div data-automation-id="education-1"><input class="school"></div>
        <button id="add" type="button">Add Education</button>
      </form>
      <script>
        let n = 1;
        document.getElementById("add").addEventListener("click", () => {
          n += 1;
          const d = document.createElement("div");
          d.setAttribute("data-automation-id", "education-" + n);
          d.innerHTML = '<input class="school">';
          document.getElementById("f").insertBefore(d, document.getElementById("add"));
        });
      </script>`, async () => {
      const entry = {
        inputSelectors: [["education", [{
          array: true,
          containerPath: './/div[@data-automation-id="education-%NUMBER0%"]',
          addButtonPath: './/button[contains(., "Add Education")]',
          confirmAddedPath: './/div[@data-automation-id="education-%NUMBER0%"]',
          inputSelectors: [["education", [{ path: './/input[@class="school"]', method: "setValue" }]]],
        }]]],
      };
      const values = { education: { v: [
        { education: { v: "Stanford University" } },
        { education: { v: "University of Scranton" } },
      ] } };
      const r = await JA_CFG.runConfigFill(entry, values, {});
      const schools = [...document.querySelectorAll(".school")].map((i) => i.value);
      return { status: r.results[0].status, rows: r.results[0].rows?.map((x) => x.status), schools };
    });
    check("array section fills row 1 and add-buttons row 2 (1-based %NUMBER0%)",
      r.schools.join("|") === "Stanford University|University of Scranton", JSON.stringify(r));
  }

  // ---- 6. everyValue: one selector run per value (multi-check ethnicity).
  {
    const r = await run(`
      <input type="checkbox" name="eth" value="asian" id="c1">
      <input type="checkbox" name="eth" value="white" id="c2">
      <input type="checkbox" name="eth" value="other" id="c3">`, async () => {
      const entry = {
        inputSelectors: [["multiple_ethnicities", [{
          path: './/input[@type="checkbox"][@value="%LOWERVALUE%"]',
          method: "selectCheckboxOrRadio",
          everyValue: true,
          valueRequired: false,
        }]]],
      };
      const r = await JA_CFG.runConfigFill(entry, { multiple_ethnicities: { v: ["Asian", "White"] } }, {});
      return {
        status: r.results[0].status,
        checked: [...document.querySelectorAll("input")].map((c) => c.checked),
      };
    });
    check("everyValue checks one box per value", JSON.stringify(r.checked) === JSON.stringify([true, true, false]), JSON.stringify(r));
  }

  // ---- 7. element-claim dedup: two fields matching the same input → second one skips.
  {
    const r = await run(`<input id="one" name="name">`, async () => {
      const entry = {
        inputSelectors: [
          ["full_name", [{ path: './/input[@name="name"]', method: "setValue" }]],
          ["first_name", [{ path: './/input[@name="name"]', method: "setValue" }]],
        ],
      };
      const out = await JA_CFG.runConfigFill(entry, { full_name: { v: "Michael Scott" }, first_name: { v: "Michael" } }, {});
      return { statuses: out.results.map((x) => x.status), value: document.getElementById("one").value };
    });
    check("claimed element is not reused by a second field",
      r.statuses[0] === "filled" && r.statuses[1] === "not-found" && r.value === "Michael Scott", JSON.stringify(r));
  }

  // ---- 8. uploadResume via DataTransfer + writeCoverLetter into contenteditable.
  {
    const r = await run(`
      <input type="file" id="fi" style="display:none">
      <div id="rte" contenteditable="true"></div>`, async () => {
      const entry = {
        inputSelectors: [
          ["resume", [{ path: './/input[@type="file"]', method: "uploadResume" }]],
          ["coverLetter", [{ path: './/div[@id="rte"]', method: "writeCoverLetter", valueRequired: false }]],
        ],
      };
      let changed = false;
      document.getElementById("fi").addEventListener("change", () => { changed = true; });
      const out = await JA_CFG.runConfigFill(entry, { resume: { v: "resume.pdf" } }, {
        files: { resume: { name: "resume.pdf", type: "application/pdf", bytes: [37, 80, 68, 70] } },
        coverLetterText: "Dear Team,\nSecond line.",
      });
      const fi = document.getElementById("fi");
      return {
        statuses: out.results.map((x) => x.status),
        files: fi.files.length, fname: fi.files[0]?.name, changed,
        rte: document.getElementById("rte").innerText,
      };
    });
    check("uploadResume injects the File and fires change",
      r.files === 1 && r.fname === "resume.pdf" && r.changed, JSON.stringify(r));
    check("writeCoverLetter fills the rich-text editor", /Dear Team/.test(r.rte) && /Second line/.test(r.rte), r.rte.slice(0, 40));
  }

  // ---- 9. legacy method volley is flagged best-effort.
  {
    const r = await run(`<input id="l">`, async () => {
      const seen = [];
      const el = document.getElementById("l");
      for (const t of ["keydown", "input", "keyup", "change", "blur"]) el.addEventListener(t, () => seen.push(t));
      const res = await JA_CFG._internal.applyMethod("ui5", el, "test", [{ value: "test", unmapped: "test" }], {}, {}, {});
      return { note: res.note, value: el.value, seen };
    });
    check("legacy (ui5) fill sets value, fires the volley, and is flagged",
      r.note === "legacy-best-effort" && r.value === "test" && r.seen.includes("keyup") && r.seen.includes("change"), JSON.stringify(r));
  }

  // ---- 10. actions runner: condition-gated open, wait for menu, click option (typeahead DSL).
  {
    const r = await run(`
      <input id="ta" role="combobox" aria-expanded="false">
      <ul id="menu" style="display:none"><li role="option">Scranton</li><li role="option">Stamford</li></ul>
      <script>
        const i = document.getElementById("ta");
        i.addEventListener("mousedown", () => {
          setTimeout(() => { document.getElementById("menu").style.display = "block"; i.setAttribute("aria-expanded","true"); }, 120);
        });
      </script>`, async () => {
      const entry = {
        inputSelectors: [["city", [{
          path: './/input[@id="ta"]',
          actions: [
            { condition: './/input[@id="ta" and @aria-expanded="false"]', method: "click", eventOptions: { noBlur: true } },
            { method: "clearValue" },
            { method: "defaultWithoutBlur" },
            { time: 3000, path: './/li[@role="option" and contains(translate(., "SCRANTON", "scranton"), "%LOWERVALUE%")]', method: "click" },
          ],
        }]]],
      };
      let optClicked = "";
      document.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => { optClicked = li.textContent; }));
      const out = await JA_CFG.runConfigFill(entry, { city: { v: "Scranton" } }, {});
      return { status: out.results[0].status, optClicked, typed: document.getElementById("ta").value };
    });
    check("actions DSL: condition→open→type→wait→click-option lands the typeahead",
      r.status === "filled" && r.optClicked === "Scranton", JSON.stringify(r));
  }

  // ---- 11. Lever-style clobber → reassert (SETTLE_ATS path).
  {
    const r = await run(`
      <form>
        <input type="file" id="fi">
        <input id="fn" name="name">
      </form>
      <script>
        // Simulates Lever's async résumé parser overwriting the name field with its
        // own parsed (lossier) value AFTER our fill landed — the reassert pass must
        // put the profile value back.
        document.getElementById("fi").addEventListener("change", () => {
          setTimeout(() => { document.getElementById("fn").value = "PARSED NAME"; }, 400);
        });
      </script>`, async () => {
      JA_CFG.setTimeScale(0.4); // keep the settle windows short but > the 150ms clobber
      const entry = {
        inputSelectors: [
          ["resume", [{ path: './/input[@type="file"]', method: "uploadResume" }]],
          ["full_name", [{ path: './/input[@name="name"]', method: "setValue" }]],
        ],
      };
      const out = await JA_CFG.runConfigFill(entry, { resume: { v: "r.pdf" }, full_name: { v: "Michael Scott" } }, {
        atsName: "Lever",
        files: { resume: { name: "r.pdf", type: "application/pdf", bytes: [1] } },
      });
      JA_CFG.setTimeScale(1);
      return {
        value: document.getElementById("fn").value,
        reasserted: out.results.find((x) => x.key === "full_name")?.reasserted || false,
      };
    });
    check("Lever clobber: profile value re-asserted after the parse round-trip",
      r.value === "Michael Scott" && r.reasserted === true, JSON.stringify(r));
  }

  // ---- 12. job-ID extraction: hardcoded lever/icims + template extractors.
  {
    const r = await run(`<div><script id="mosaic-data">var x = {"jk":"abcdef1234"};</script></div>`, async () => {
      const lever = JA_CFG.extractJobId({}, { href: "https://jobs.lever.co/acme/e5f6", pathname: "/acme/e5f6", hostname: "jobs.lever.co" }, "Lever");
      const icims = JA_CFG.extractJobId({}, { href: "https://corp.icims.com/jobs/1234/x", pathname: "/jobs/1234/x", hostname: "corp.icims.com" }, "ICIMS");
      const search = JA_CFG.extractJobId(
        { trackedObjExtractors: [{ template: "indeed:{{searchParams[jk]}}" }] },
        { href: "https://smartapply.indeed.com/x?jk=99aa" }, "Indeed");
      const pathMatch = JA_CFG.extractJobId(
        { trackedObjExtractors: [{ path: './/script[@id="mosaic-data"]/text()', match: '"jk":"([0-9a-f]{8,})"', template: "indeed:{{1}}" }] },
        { href: "https://smartapply.indeed.com/x" }, "Indeed");
      const host = JA_CFG.extractJobId(
        { trackedObjExtractors: [{ template: "bamboo:{{hostnameSplit[0]}}{{pathname}}" }] },
        { href: "https://acme.bamboohr.com/jobs/view/12" }, "BambooHR");
      return { lever, icims, search, pathMatch, host };
    });
    check("job-ID: hardcoded lever format", r.lever === "lever:acme/e5f6", r.lever);
    check("job-ID: hardcoded icims format", r.icims === "icims:corp/1234", r.icims);
    check("job-ID: searchParams template", r.search === "indeed:99aa", r.search);
    check("job-ID: path+match capture template", r.pathMatch === "indeed:abcdef1234", r.pathMatch);
    check("job-ID: hostnameSplit + URL-prop tokens", r.host === "bamboo:acme/jobs/view/12", r.host);
  }

  // ---- 13. shadow-root piercing.
  {
    const r = await run(`<div id="host"></div>
      <script>
        const root = document.getElementById("host").attachShadow({ mode: "open" });
        root.innerHTML = '<div class="inner"><input id="shin"></div>';
      </script>`, async () => {
      const els = JA_CFG._internal.xEval('.//div[@id="host"]/shadow-root//input', document);
      if (!els.length) return { found: false };
      await JA_CFG._internal.applyMethod("setValue", els[0], "pierced", [{ value: "pierced", unmapped: "pierced" }], {}, {}, {});
      return { found: true, value: document.getElementById("host").shadowRoot.querySelector("input").value };
    });
    check("shadow-root paths pierce into shadow DOM", r.found && r.value === "pierced", JSON.stringify(r));
  }

  // ---- 13b. config-editorial values are guarded: the upstream config hardcodes
  // transgender="No" and salary=100000 — those literals must never fill for a user who
  // hasn't answered; profile values win when present; the source family always skips.
  {
    const html = `
      <select id="tg"><option value=""></option><option>Yes</option><option>No</option><option>Decline</option></select>
      <input id="sal" type="text">
      <input id="src" type="text">`;
    const entryArg = {
      inputSelectors: [
        ["transgender", [{ path: './/select[@id="tg"]', method: "default", value: "No" }]],
        ["salary_requirements", [{ path: './/input[@id="sal"]', method: "setValue", value: "100000" }]],
        ["source_other", [{ path: './/input[@id="src"]', method: "setValue", value: "some-vendor.example" }]],
      ],
    };
    const r1 = await run(html, async ({ entry }) => {
      const out = await JA_CFG.runConfigFill(entry, {}, { legalKeys: ["transgender"] });
      return {
        statuses: Object.fromEntries(out.results.map((x) => [x.key, x.status])),
        tg: document.getElementById("tg").value,
        sal: document.getElementById("sal").value,
        src: document.getElementById("src").value,
      };
    }, { entry: entryArg });
    check("hardcoded transgender/salary literals never fill without a profile value",
      r1.tg === "" && r1.sal === "" && r1.statuses.transgender === "no-value" && r1.statuses.salary_requirements === "no-value",
      JSON.stringify(r1));
    check("source_other (vendor self-attribution) is skipped by design",
      r1.src === "" && r1.statuses.source_other === "skipped-by-design", JSON.stringify(r1));

    const r2 = await run(html, async ({ entry }) => {
      const out = await JA_CFG.runConfigFill(entry, {
        transgender: { v: "Decline", legal: true },
        salary_requirements: { v: "120000-140000", alts: ["120000"] },
      }, { legalKeys: ["transgender"] });
      return {
        tg: document.getElementById("tg").value,
        sal: document.getElementById("sal").value,
        statuses: Object.fromEntries(out.results.map((x) => [x.key, x.status])),
      };
    }, { entry: entryArg });
    check("profile values win over config literals (transgender=Decline, salary from profile)",
      r2.tg === "Decline" && r2.sal === "120000-140000", JSON.stringify(r2));
  }

  // ---- 13c. guarded keys refuse valueKey redirects (the config auto-signs Lever's
  // CC-305 disability block from full_name/current_date; armed_forces from veteran).
  {
    const r = await run(`
      <input id="sig" name="eeo[disabilitySignature]">
      <input id="sigDate" name="eeo[disabilitySignatureDate]">`, async () => {
      const entry = {
        inputSelectors: [
          ["disability_name", [{ path: './/input[@name="eeo[disabilitySignature]"]', valueKey: "full_name", method: "setValue" }]],
          ["disability_date", [{ path: './/input[@name="eeo[disabilitySignatureDate]"]', valueKey: "current_date", method: "setValue" }]],
        ],
      };
      const out = await JA_CFG.runConfigFill(entry,
        { full_name: { v: "Michael Scott" }, current_date: { v: "07/15/2026" } },
        { legalKeys: ["disability_name", "disability_date"] });
      return {
        statuses: out.results.map((x) => x.status),
        sig: document.getElementById("sig").value,
        sigDate: document.getElementById("sigDate").value,
      };
    });
    check("guarded keys refuse valueKey redirects (CC-305 stays unsigned)",
      r.sig === "" && r.sigDate === "" && r.statuses.every((x) => x === "no-value"), JSON.stringify(r));
  }

  // ---- 15. valuePath retargets to the value control; no hit = no fabricated fill.
  {
    const html = `
      <div class="demographic_question" id="q">
        <label>Are you legally authorized to work?</label>
        <label><input type="checkbox" id="yes"> Yes</label>
        <label><input type="checkbox" id="no"> No</label>
      </div>`;
    const entryArg = {
      inputSelectors: [["work_auth", [{
        path: './/div[@class="demographic_question"]',
        method: "selectCheckboxOrRadio",
        values: { "true": "Yes", "": "No" },
        valuePath: '%INPUTPATH%//label[contains(., "%VALUE%")]//input',
      }]]],
    };
    const rYes = await run(html, async ({ entry }) => {
      JA_CFG.setTimeScale(0.05);
      const out = await JA_CFG.runConfigFill(entry, { work_auth: { v: "true" } }, { legalKeys: ["work_auth"] });
      JA_CFG.setTimeScale(1);
      return { status: out.results[0].status, yes: document.getElementById("yes").checked, no: document.getElementById("no").checked };
    }, { entry: entryArg });
    check("valuePath finds and checks the matching control inside the question container",
      rYes.status === "filled" && rYes.yes === true && rYes.no === false, JSON.stringify(rYes));
    const rMiss = await run(`<div class="demographic_question"><label>Authorized?</label></div>`, async ({ entry }) => {
      JA_CFG.setTimeScale(0.05);
      const out = await JA_CFG.runConfigFill(entry, { work_auth: { v: "true" } }, { legalKeys: ["work_auth"] });
      JA_CFG.setTimeScale(1);
      return out.results[0].status;
    }, { entry: entryArg });
    check("valuePath with no resolvable control reports no-option-match, never a fake fill",
      rMiss === "no-option-match", rMiss);
  }

  // ---- 16. grouping selectors (nested inputSelectors, no array) recurse.
  {
    const r = await run(`
      <div data-automation-id="education-1">
        <input id="school" name="school-name">
        <input id="deg" name="degree">
      </div>`, async () => {
      const entry = {
        inputSelectors: [["education", [{
          array: true,
          containerPath: './/div[@data-automation-id="education-%NUMBER0%"]',
          inputSelectors: [
            ["education", [{ inputSelectors: [ // grouping level (SuccessFactors shape)
              ["name", [{ path: './/input[@name="school-name"]', method: "setValue" }]],
            ] }]],
            ["degree", [{ path: './/input[@name="degree"]', method: "setValue" }]],
          ],
        }]]],
      };
      const out = await JA_CFG.runConfigFill(entry, {
        education: { v: [{ education: { v: "Stanford University" }, name: { v: "Stanford University" }, degree: { v: "Master's" } }] },
      }, {});
      return {
        school: document.getElementById("school").value,
        deg: document.getElementById("deg").value,
        statuses: out.results[0].rows?.map((x) => `${x.key}:${x.status}`),
      };
    });
    check("grouping selector recurses into nested pairs (school name fills)",
      r.school === "Stanford University" && r.deg === "Master's", JSON.stringify(r));
  }

  // ---- 17. step machine: "." removed-steps watch the field element; removed skips
  // the appear phase entirely (already-absent resolves fast).
  {
    const r = await run(`
      <div id="row"><button id="save">Save</button></div>
      <script>
        document.getElementById("save").addEventListener("click", () => {
          setTimeout(() => document.getElementById("row").remove(), 80);
        });
      </script>`, async () => {
      const entry = {
        inputSelectors: [["save", [{
          path: './/button[@id="save"]',
          valueRequired: false,
          actions: [{ method: "click" }, { path: ".", removed: true, time: 2000 }],
        }]]],
      };
      const t0 = performance.now();
      const out = await JA_CFG.runConfigFill(entry, {}, {});
      return { status: out.results[0].status, ms: Math.round(performance.now() - t0), rowGone: !document.getElementById("row") };
    });
    check("'.' removed-step: click save, await the element's own removal",
      r.status === "filled" && r.rowGone && r.ms < 1500, JSON.stringify(r));
    const r2 = await run(`<input id="x">`, async () => {
      const entry = {
        inputSelectors: [["f", [{
          path: './/input[@id="x"]', valueRequired: false,
          actions: [{ path: './/div[@class="spinner"]', removed: true, time: 3000 }, { method: "setValue", value: "done" }],
        }]]],
      };
      const t0 = performance.now();
      await JA_CFG.runConfigFill(entry, {}, {});
      return { ms: Math.round(performance.now() - t0), v: document.getElementById("x").value };
    });
    check("removed-step with already-absent target resolves immediately (no appear wait)",
      r2.v === "done" && r2.ms < 1000, JSON.stringify(r2));
  }

  // ---- 18. step-level valueRequired skips the STEP, not the field.
  {
    const r = await run(`<input id="a"><input id="b">`, async () => {
      const entry = {
        inputSelectors: [["f", [{
          path: './/input[@id="a"]', valueRequired: false,
          actions: [
            { method: "setValue", value: "first" },
            { valueRequired: true, method: "setValue", valueKey: "missing_key" },
            { path: './/input[@id="b"]', method: "setValue", value: "third" },
          ],
        }]]],
      };
      const out = await JA_CFG.runConfigFill(entry, {}, {});
      return { status: out.results[0].status, a: document.getElementById("a").value, b: document.getElementById("b").value };
    });
    check("step valueRequired gate skips that step; later steps still run",
      r.a === "first" && r.b === "third" && r.status === "filled", JSON.stringify(r));
  }

  // ---- 19. everyValue partial: successes stick, partial notes, no double-fill via
  // lower-ranked selectors.
  {
    const r = await run(`
      <input type="checkbox" value="asian" id="c1">
      <input type="checkbox" value="white" id="c2">`, async () => {
      const entry = {
        inputSelectors: [["multiple_ethnicities", [
          { path: './/input[@type="checkbox"][@value="%LOWERVALUE%"]', method: "selectCheckboxOrRadio", everyValue: true, valueRequired: false },
          { path: './/input[@type="checkbox"]', method: "selectCheckboxOrRadio", valueRequired: false }, // would blanket-check
        ]]],
      };
      const out = await JA_CFG.runConfigFill(entry, { multiple_ethnicities: { v: ["Asian", "Nonexistent"] } }, {});
      return {
        status: out.results[0].status, note: out.results[0].note || "",
        checked: [...document.querySelectorAll("input")].map((c) => c.checked),
      };
    });
    check("everyValue partial keeps successes and never falls through to a blanket selector",
      r.status === "filled" && /partial/.test(r.note) && JSON.stringify(r.checked) === JSON.stringify([true, false]),
      JSON.stringify(r));
  }

  // ---- 20. extractor upgrades: optional urlPattern groups, match-only-vs-href, host
  // gates on the hardcoded ids, $-injection safety, lowercase %value%.
  {
    const r = await run(`<div></div>`, async () => {
      const I = JA_CFG._internal;
      return {
        opt: I.urlPatternMatch("/:companySlug/jobs/:jobId(/*)", "/acme/jobs/123"),
        optDeep: I.urlPatternMatch("/:companySlug/jobs/:jobId(/*)", "/acme/jobs/123/apply"),
        matchOnly: JA_CFG.extractJobId(
          { trackedObjExtractors: [{ match: "^https?://jobs\\.ashbyhq\\.com/([^/?#]+)/([^/?#]+)", template: "ashbyhq:{{1}}/{{2}}" }] },
          { href: "https://jobs.ashbyhq.com/acme/f0a1-22" }, "AshbyHQ"),
        matchGate: JA_CFG.extractJobId(
          { trackedObjExtractors: [{ match: "^https?://jobs\\.ashbyhq\\.com/([^/?#]+)/([^/?#]+)", template: "ashbyhq:{{1}}/{{2}}" }] },
          { href: "https://careers.other.com/x" }, "AshbyHQ"),
        icimsEmbed: JA_CFG.extractJobId({}, { href: "https://jobs.acme.com/careers/senior-eng", pathname: "/careers/senior-eng", hostname: "jobs.acme.com" }, "ICIMS"),
        dollar: I.subPlaceholders('x[@v="%VALUE%"]', { value: "A$&B" }),
        lower: I.subPlaceholders('starts-with(., "%value%,")', { value: "1, Male" }),
      };
    });
    check("urlPattern optional group matches with and without the suffix",
      r.opt?.companySlug === "acme" && r.opt?.jobId === "123" && r.optDeep?.jobId === "123", JSON.stringify({ o: r.opt, d: r.optDeep }));
    check("match-only extractor resolves against the URL and gates on it",
      r.matchOnly === "ashbyhq:acme/f0a1-22" && r.matchGate === null, JSON.stringify({ m: r.matchOnly, g: r.matchGate }));
    check("hardcoded icims id refuses non-icims hosts (embeds use config extractors)",
      r.icimsEmbed === null, String(r.icimsEmbed));
    check("$-patterns in values never rewrite the template", r.dollar === 'x[@v="A$&B"]', r.dollar);
    check("lowercase %value% token substitutes", r.lower === 'starts-with(., "1, male,")', r.lower);
  }

  // ---- 21. shadow DOM: direct children of the shadow root are reachable.
  {
    const r = await run(`<div id="host"></div>
      <script>
        const root = document.getElementById("host").attachShadow({ mode: "open" });
        root.innerHTML = '<input id="direct">';
      </script>`, async () => {
      const els = JA_CFG._internal.xEval('.//div[@id="host"]/shadow-root//input', document);
      return { n: els.length, id: els[0]?.id || null };
    });
    check("shadow-root piercing reaches root-level children", r.n === 1 && r.id === "direct", JSON.stringify(r));
  }

  // ---- 14. wordLimit/characterLimit truncation.
  {
    const r = await run(`<textarea id="t"></textarea>`, async () => {
      const entry = { inputSelectors: [["description", [{ path: './/textarea', method: "setValue", wordLimit: 3 }]]] };
      await JA_CFG.runConfigFill(entry, { description: { v: "one two three four five" } }, {});
      return document.getElementById("t").value;
    });
    check("wordLimit truncates the value", r === "one two three", r);
  }
} catch (e) {
  check("unit suite ran to completion", false, String(e).split("\n")[0]);
} finally {
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
  process.exit(fails.length ? 1 : 0);
}
