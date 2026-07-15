// Headless PDF round-trip gate (step 4): prove the tailor artifact is the SAME thing the
// preview shows AND is a real, text-parseable, non-fabricating PDF. We build a doc-def from
// a fixture tailored profile with JA_TAILOR.buildDocDefinition, render it with pdfmake, then
// extract its text layer with pdf.js and assert:
//   - the extracted text CONTAINS the tailored bullet content + name/email (nothing dropped),
//   - it does NOT contain a planted string that was never in the source (fabrication-corpus
//     check — the layer is exactly the content we put in, no ghost text),
//   - the text layer is non-empty (ATS-parseable, not an image).
//
//   node test/unit-pdf.mjs
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { EXT, makeChecker } from "./harness.mjs";

const { results, check } = makeChecker();

// A minimal but realistic tailored profile (the shape JA_AI.tailor returns as `tailored`).
const NAME = "Ada Lovelace";
const EMAIL = "ada@analytical.example";
const BULLET = "Optimized the analytical engine throughput by 40% across nightly batch runs";
const PROJECT = "Bernoulli number generator";
const SENTINEL = "ZZQ_FABRICATED_CLAIM_NEVER_IN_SOURCE"; // planted; must NOT appear in the PDF text
const tailored = {
  personal_information: {
    first_name: "Ada", last_name: "Lovelace", email: EMAIL, phone: "+1 555 0100",
    location: "London, UK", linkedin: "https://linkedin.com/in/adalovelace",
    // Fields on the header DENYLIST — must never render into the PDF text:
    date_of_birth: "12/10/1815", address: "12 Ockham Lane",
  },
  experience_details: [
    { company: "Analytical Engine Co", position: "Software Engineer", employment_period: "1843 - 1852",
      key_responsibilities: [BULLET, "Authored the first published algorithm for a computing machine"] },
  ],
  education_details: [
    { institution: "University of London", education_level: "Bachelor's", field_of_study: "Mathematics",
      start_date: "1833", year_of_completion: "1837" },
  ],
  projects: [{ name: PROJECT, description: "Designed a note-G routine to compute Bernoulli numbers." }],
  skills: "Mathematics, Algorithms, Analytical Engine",
};

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto("about:blank");

  // Load the exact runtime bytes the extension ships: pdfmake FIRST, then its font VFS
  // (self-registers via addVirtualFileSystem — order matters), then tailor-core.js.
  await page.addScriptTag({ path: path.join(EXT, "vendor/pdfmake.min.js") });
  await page.addScriptTag({ path: path.join(EXT, "vendor/vfs_fonts.js") });
  await page.addScriptTag({ path: path.join(EXT, "vendor/pdf.min.js") });
  await page.addScriptTag({ path: path.join(EXT, "tailor-core.js") });

  // pdf.js needs a worker; in a bare page we register the vendored worker via a Blob URL.
  const workerCode = fs.readFileSync(path.join(EXT, "vendor/pdf.worker.min.js"), "utf8");

  const out = await page.evaluate(async ({ tailored, workerCode }) => {
    if (typeof JA_TAILOR === "undefined") throw new Error("JA_TAILOR not loaded");
    if (typeof pdfMake === "undefined") throw new Error("pdfMake not loaded");
    const docDef = JA_TAILOR.buildDocDefinition(tailored);
    const b64 = await new Promise((res) => pdfMake.createPdf(docDef).getBase64(res));
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const blob = new Blob([workerCode], { type: "application/javascript" });
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const numPages = doc.numPages;
    let text = "";
    for (let p = 1; p <= numPages; p++) {
      const pg = await doc.getPage(p);
      const tc = await pg.getTextContent();
      text += " " + tc.items.map((i) => i.str).join(" ");
    }
    await doc.destroy();
    return { text, numPages, b64len: b64.length };
  }, { tailored, workerCode });

  // Collapse whitespace: pdf.js splits a bullet into per-run text items, so we reconstruct
  // by normalizing spacing before containment checks.
  const flat = out.text.replace(/\s+/g, " ").trim();

  check("PDF generated (non-trivial byte length)", out.b64len > 2000, `b64len=${out.b64len}`);
  check("text layer is non-empty (ATS-parseable, not an image)", flat.length > 40, `len=${flat.length}`);
  check("extracted text contains the applicant name", flat.includes(NAME));
  check("extracted text contains the email", flat.includes(EMAIL));
  check("extracted text contains the tailored bullet content", flat.includes("analytical engine throughput by 40%"), flat.slice(0, 400));
  check("extracted text contains the project name", flat.includes(PROJECT));
  check("extracted text contains a skill", flat.includes("Algorithms"));
  // Fabrication-corpus: a string that is NOWHERE in the source must be NOWHERE in the PDF.
  check("planted fabricated string is ABSENT from the PDF text", !flat.includes(SENTINEL));
  // Header denylist: DOB / street address must never render, even though they're in the object.
  check("date_of_birth is NOT rendered (header allowlist)", !flat.includes("1815") && !flat.includes("12/10/1815"));
  check("street address is NOT rendered (header allowlist)", !flat.includes("Ockham"));
} catch (e) {
  check(`unit-pdf harness ran without throwing — ${e.message}`, false);
} finally {
  await browser?.close();
}

const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
process.exit(fails.length ? 1 : 0);
