// JA_TAILOR unit tests (node-only, no browser): keyword compilation/scoring against the
// REAL reference/resume-scoring.json, the fabrication-audit gates (every planted
// fabrication MUST go RED; clean/rename/reformat tailorings must NOT cry wolf), word diff,
// resume-diff item pairing under reorder, doc-definition header allowlist, upload
// selection, and filename shaping.
//
//   node test/unit-tailor.mjs
import fs from "node:fs";
import path from "node:path";
import { EXT, makeChecker, summarize } from "./harness.mjs";

const require2 = (await import("node:module")).createRequire(import.meta.url);
const JA = require2(path.join(EXT, "tailor-core.js"));
const SCORING = JSON.parse(fs.readFileSync(path.join(EXT, "reference/resume-scoring.json"), "utf8"));
const { results, check } = makeChecker();

const vocab = JA.compileVocabulary(SCORING);

// group lookup by a representative keyword, for asserting matcher behaviour directly
const groupFor = (kw) => vocab.groups.find((g) => g.keyword === kw || g.variants.some((v) => v === kw));

// ---- 1. vocabulary compilation + matcher semantics -----------------------------------
{
  check("compileVocabulary covers all 1454 keyword groups", vocab.groups.length === SCORING.resumeScoreKeywords.length,
    String(vocab.groups.length));
  check("compileVocabulary is memoized (same object returned)", JA.compileVocabulary(SCORING) === vocab);

  const gR = groupFor("(^|\\W)R($|\\W)") || vocab.groups.find((g) => g.variants.some((v) => v && v.match === "(^|\\W)R($|\\W)"));
  check("regex-object variant R matches bare 'R' token", !!gR && JA.groupMatches(gR, "Proficient in R and Python"));
  check("regex-object variant R is CASE-SENSITIVE (does NOT match 'toys r us')", gR && !JA.groupMatches(gR, "worked at toys r us"));
  check("regex-object variant R does NOT substring-match 'React'/'Rust'", gR && !JA.groupMatches(gR, "React and Rust developer"));

  const gSIEM = vocab.groups.find((g) => g.variants.some((v) => v && v.match === "(^|\\W)SIEM($|\\W)"));
  check("SIEM regex-object matches 'SIEM'", !!gSIEM && JA.groupMatches(gSIEM, "deployed a SIEM platform"));
  check("SIEM is case-sensitive (no match for 'siem')", gSIEM && !JA.groupMatches(gSIEM, "siemens turbines"));

  const gCpp = groupFor("C++");
  check("C++ matches via boundary regex, not bad substring", !!gCpp && JA.groupMatches(gCpp, "C++ and Java") && !JA.groupMatches(gCpp, "a C developer"));
  const gCs = groupFor("C#");
  check("C# matches 'C#' but not bare 'C'", !!gCs && JA.groupMatches(gCs, "C# on .NET") && !JA.groupMatches(gCs, "plain C code"));

  const gGo = vocab.groups.find((g) => g.variants.includes("Go."));
  check("bare capitalized 'Go' matches via the added matcher", !!gGo && JA.groupMatches(gGo, "I write Go daily"));
  check("'Go' matcher does not fire on 'Google' or 'goes'", gGo && !JA.groupMatches(gGo, "at Google") && !JA.groupMatches(gGo, "he goes home"));
  check("'Golang' still matches via its own string variant", gGo && JA.groupMatches(gGo, "experienced Golang engineer"));

  const gNode = groupFor("Node");
  check("'Node' boundary matches 'Node' but not 'anode'", !!gNode && JA.groupMatches(gNode, "Node backend") && !JA.groupMatches(gNode, "the anode wire"));
  check("'Node.js' variant matches", gNode && JA.groupMatches(gNode, "built with Node.js"));

  const gPy = groupFor("Python");
  check("plain string variant Python is case-insensitive substring", !!gPy && JA.groupMatches(gPy, "PYTHON scripting"));

  // group carries its category from resumeScoreCategories
  check("group carries category (Python → languages)", gPy && gPy.category === "languages");
  check("group carries category (Kubernetes → toolsAndFrameworks)", groupFor("Kubernetes")?.category === "toolsAndFrameworks");
}

// ---- 2. analyzeKeywords: present / adjacent / absent, scores, guards -----------------
{
  const jd = "We want Python, Kubernetes, React and Rust experience.";
  const source = {
    personal_information: { first_name: "Ada", last_name: "Lovelace" },
    skills: "Python, React",
    projects: [{ name: "Orchestrator", description: "Deployed services on Kubernetes clusters." }],
  };
  // the current PDF has Python + React but NOT Kubernetes (adjacent) and NOT Rust (absent)
  const pdf = "Skills: Python, React. Built web apps.";
  const a = JA.analyzeKeywords(vocab, jd, source, pdf);

  const kws = (arr) => arr.map((x) => x.keyword).sort();
  check("present includes Python, React, Kubernetes", kws(a.present).join(",").includes("Kubernetes") && kws(a.present).includes("Python"));
  check("score = present/jdRelevant (all 3 present of 3 relevant)", a.score === a.present.length / a.jdGroupCount && a.present.length === 3);
  check("Rust (in JD, nowhere in profile) is ABSENT", a.missing.absent.some((x) => x.keyword === "Rust"));
  check("Kubernetes is ADJACENT (in project, not on PDF) with provenance", a.missing.adjacent.some((x) => x.keyword === "Kubernetes" && /project:/.test(x.provenance)));
  check("Kubernetes NOT double-counted as absent", !a.missing.absent.some((x) => x.keyword === "Kubernetes"));
  // pdfScore and score share the SAME denominator (jdGroupCount) — both numerators are whole.
  check("score & pdfScore share the jdGroupCount denominator", a.jdGroupCount > 0
    && Number.isInteger(Math.round(a.score * a.jdGroupCount)) && Number.isInteger(Math.round(a.pdfScore * a.jdGroupCount)));
  // Kubernetes is in the structured profile but not on the PDF, and nothing is on the PDF
  // yet missing from the profile → pdfScore is strictly below score.
  check("pdfScore < score (Kubernetes present in profile, absent from PDF)", a.pdfScore < a.score);
  check("truncated passthrough defaults false", a.truncated === false);
  check("truncated passthrough honored when passed", JA.analyzeKeywords(vocab, jd, source, pdf, true).truncated === true);

  // determinism: identical inputs → identical ordering
  const b = JA.analyzeKeywords(vocab, jd, source, pdf);
  check("analyzeKeywords deterministic (same keyword ordering across runs)",
    JSON.stringify(a.present) === JSON.stringify(b.present) && JSON.stringify(a.missing) === JSON.stringify(b.missing));

  // score guard: a JD with no scoreable keywords → null sentinel
  const none = JA.analyzeKeywords(vocab, "!!! ... ???", source, pdf);
  check("jdRelevant=0 → score null sentinel", none.score === null && none.pdfScore === null && none.jdGroupCount === 0);
}

// ---- fixtures for the audit suite -----------------------------------------------------
const baseSource = {
  personal_information: {
    first_name: "Naman", last_name: "Bist", email: "n@x.com", phone: "+1 555 555 0100",
    date_of_birth: "03/15/1999", address: "123 Main St", location: "Boston, MA, USA",
    linkedin: "https://linkedin.com/in/naman", github: "https://github.com/naman",
  },
  education_details: [
    { education_level: "Bachelor of Science", institution: "MIT", field_of_study: "CS", start_date: "2019", year_of_completion: "2023" },
  ],
  experience_details: [
    {
      company: "Acme", position: "Software Engineer Intern", employment_period: "06/2021 - 08/2021", location: "Boston, MA",
      key_responsibilities: [
        "Built internal tools with Python and React over one summer",
        "Increased dashboard load speed by 30% through query tuning",
      ],
      skills_acquired: ["Python", "React"],
    },
  ],
  projects: [{ name: "Grapher", description: "Graph visualizer written in Node and TypeScript." }],
  skills: "Python, React, Node, TypeScript, SQL",
  resume_text: "Naman Bist — built tools in Python and React; grew dashboard speed 30%.",
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const reds = (r) => r.flags.filter((f) => f.severity === "red");
const hasRedGate = (r, gate) => reds(r).some((f) => f.gate === gate);

// ---- 3. audit: clean tailoring must NOT cry wolf -------------------------------------
{
  const tailored = clone(baseSource);
  tailored.experience_details[0].key_responsibilities[0] = "Built internal tools with Python and React in one summer";
  const changes = [{
    op: "rephrase", section: "experience",
    before: "Built internal tools with Python and React over one summer",
    after: "Built internal tools with Python and React in one summer",
    source: "Built internal tools with Python and React over one summer",
  }];
  const r = JA.auditTailored(baseSource, tailored, changes, vocab);
  check("clean grounded rephrase → NO red flags", reds(r).length === 0, JSON.stringify(reds(r)));
}

// ---- 4. audit: skill rename (Node → Node.js) must NOT cry wolf -----------------------
{
  const tailored = clone(baseSource);
  tailored.skills = "Python, React, Node.js, TypeScript, SQL"; // Node → Node.js
  const r = JA.auditTailored(baseSource, tailored, [], vocab);
  check("skills rename Node→Node.js → NO new-skill red", !hasRedGate(r, "new-skill"), JSON.stringify(reds(r)));
}

// ---- 5. audit: date reformat + degree alias must NOT cry wolf ------------------------
{
  const tailored = clone(baseSource);
  tailored.experience_details[0].employment_period = "June 2021 - August 2021"; // reformat, same months
  tailored.education_details[0].education_level = "B.S."; // alias of Bachelor of Science
  const r = JA.auditTailored(baseSource, tailored, [], vocab);
  check("date reformat (06/2021→June 2021) → NO date red", !hasRedGate(r, "date"), JSON.stringify(reds(r)));
  check("degree alias (Bachelor of Science→B.S.) → NO identity red", !hasRedGate(r, "identity"), JSON.stringify(reds(r)));
}

// ---- 6. audit: planted fabrications each MUST go RED ---------------------------------
{
  // (a) title inflation: add "Senior"
  let t = clone(baseSource);
  t.experience_details[0].position = "Senior Software Engineer Intern";
  let r = JA.auditTailored(baseSource, t, [], vocab);
  check("FAB title inflation ('Senior' added) → RED (scope/identity)", hasRedGate(r, "scope") || hasRedGate(r, "identity"), JSON.stringify(reds(r)));

  // (b) date shift 2021 → 2019
  t = clone(baseSource);
  t.experience_details[0].employment_period = "06/2019 - 08/2019";
  r = JA.auditTailored(baseSource, t, [], vocab);
  check("FAB date shift (2021→2019) → RED date", hasRedGate(r, "date"), JSON.stringify(reds(r)));

  // (c) invented metric: "increased sales 40%" with no source 40
  t = clone(baseSource);
  t.experience_details[0].key_responsibilities.push("Increased sales by 40% year over year");
  r = JA.auditTailored(baseSource, t, [{ op: "add", section: "experience", after: "Increased sales by 40% year over year", source: "Increased dashboard load speed by 30% through query tuning" }], vocab);
  check("FAB invented metric (40%, no source) → RED numeric", hasRedGate(r, "numeric"), JSON.stringify(reds(r)));

  // (d) invented skill claimed in a bullet: Kubernetes absent from source
  t = clone(baseSource);
  t.experience_details[0].key_responsibilities.push("Operated production Kubernetes clusters");
  r = JA.auditTailored(baseSource, t, [{ op: "add", section: "experience", after: "Operated production Kubernetes clusters", source: "Built internal tools with Python and React over one summer" }], vocab);
  check("FAB invented skill (Kubernetes in a bullet) → RED new-skill", hasRedGate(r, "new-skill"), JSON.stringify(reds(r)));

  // (e) bogus source tag: an add whose source is not anywhere in the résumé
  t = clone(baseSource);
  t.experience_details[0].key_responsibilities.push("Mentored two junior engineers");
  r = JA.auditTailored(baseSource, t, [{ op: "add", section: "experience", after: "Mentored two junior engineers", source: "Led a team of fifty at a Fortune 500 company" }], vocab);
  check("FAB bogus source-tag (add.source not in résumé) → RED source-tag", hasRedGate(r, "source-tag"), JSON.stringify(reds(r)));

  // (f) legal section leaking into the tailor path
  t = clone(baseSource);
  t.self_identification = { gender: "Male" };
  r = JA.auditTailored(baseSource, t, [], vocab);
  check("FAB legal section in tailored → RED legal", hasRedGate(r, "legal"), JSON.stringify(reds(r)));
}

// ---- 7. audit: verb-inflation → YELLOW (not red) ------------------------------------
{
  const tailored = clone(baseSource);
  tailored.experience_details[0].key_responsibilities[0] = "Led development of internal tools with Python and React over one summer";
  const changes = [{
    op: "rephrase", section: "experience",
    before: "Built internal tools with Python and React over one summer",
    after: "Led development of internal tools with Python and React over one summer",
    source: "Built internal tools with Python and React over one summer",
  }];
  const r = JA.auditTailored(baseSource, tailored, changes, vocab);
  check("verb inflation ('Led' introduced) → YELLOW, not RED", r.flags.some((f) => f.gate === "verb-inflation" && f.severity === "yellow") && !hasRedGate(r, "verb-inflation"), JSON.stringify(r.flags));
}

// ---- 6b. ADVERSARIAL: previously-proven audit bypasses each MUST now go RED -----------
// Each of these was reproduced against the pre-fix auditTailored and returned NO red flag.
// The new vocab-independent grounding gate, the word-magnitude numeric scan, the
// metric-only source whitelist, the NFKC fold, and the own-item bullet check close them.
{
  const grounded = "Built internal tools with Python and React over one summer"; // resolves in corpus
  const addFab = (bullet, source) => {
    const t = clone(baseSource);
    t.experience_details[0].key_responsibilities.push(bullet);
    return JA.auditTailored(baseSource, t, [{ op: "add", section: "experience", after: bullet, source }], vocab);
  };

  // (1a) fabricated CREDENTIAL smuggled behind a source tag that DOES resolve ("React" is a
  // real skill) — the weak source-tag gate passed it; grounding must catch "Top"/"Secret".
  let r = addFab("Held an active Top Secret security clearance", "React");
  check("BYPASS-1a Top-Secret clearance (bogus-but-resolving source tag) → RED grounding", hasRedGate(r, "grounding"), JSON.stringify(reds(r)));

  // (1b) fabricated mixed-case acronym introduced by a rephrase whose source tag resolves.
  {
    const t = clone(baseSource);
    t.experience_details[0].key_responsibilities[0] = "Built internal tools with Python and React under full FedRAMP authorization";
    r = JA.auditTailored(baseSource, t, [{ op: "rephrase", section: "experience", before: grounded, after: t.experience_details[0].key_responsibilities[0], source: grounded }], vocab);
    check("BYPASS-1b FedRAMP rephrase (grounded source tag) → RED grounding", hasRedGate(r, "grounding"), JSON.stringify(reds(r)));
  }

  // (1c) fabricated all-caps compliance claim not in the scoring vocab.
  r = addFab("Ensured HIPAA compliance across services", grounded);
  check("BYPASS-1c HIPAA claim (non-vocab acronym) → RED grounding", hasRedGate(r, "grounding"), JSON.stringify(reds(r)));

  // (2) word-number / fraction / multiplier magnitudes on the tailored side.
  r = addFab("Mentored fifty engineers across teams", grounded);
  check("BYPASS-2a 'fifty' word-number → RED numeric", hasRedGate(r, "numeric"), JSON.stringify(reds(r)));
  r = addFab("Increased throughput by a third after refactor", grounded);
  check("BYPASS-2b 'a third' fraction → RED numeric", hasRedGate(r, "numeric"), JSON.stringify(reds(r)));
  r = addFab("Improved query throughput tenfold", grounded);
  check("BYPASS-2c 'tenfold' multiplier → RED numeric", hasRedGate(r, "numeric"), JSON.stringify(reds(r)));

  // (3) source numeric whitelist must come from METRIC prose only — not phone / year digits.
  r = addFab("Resolved 100 customer support tickets", grounded); // 100 ⊂ phone "+1 555 555 0100"
  check("BYPASS-3a '100' colliding with a phone digit → RED numeric", hasRedGate(r, "numeric"), JSON.stringify(reds(r)));
  r = addFab("Handled over 2021 nightly batch jobs", grounded);   // 2021 ⊂ employment year 06/2021
  check("BYPASS-3b '2021' colliding with an employment year → RED numeric", hasRedGate(r, "numeric"), JSON.stringify(reds(r)));

  // (4) non-ASCII (fullwidth) digits must be NFKC-folded before the digit scan.
  r = addFab("Cut latency by ４０％ after tuning", grounded); // ４０％ → 40, absent from source
  check("BYPASS-4 fullwidth ４０％ digits → RED numeric", hasRedGate(r, "numeric"), JSON.stringify(reds(r)));

  // (5a) cross-item bullet borrow: a REAL bullet from job A re-attached under job B's identity.
  {
    const xSrc = {
      experience_details: [
        { company: "Alpha", position: "Senior Engineer", location: "NYC", key_responsibilities: ["Architected the Alpha billing platform"], skills_acquired: [] },
        { company: "Beta", position: "Junior Engineer", location: "SF", key_responsibilities: ["Fixed Beta UI defects"], skills_acquired: [] },
      ],
    };
    const xTail = {
      experience_details: [
        { company: "Alpha", position: "Senior Engineer", location: "NYC", key_responsibilities: ["Fixed Beta UI defects"], sourceIndex: 0 }, // borrowed from Beta
        { company: "Beta", position: "Junior Engineer", location: "SF", key_responsibilities: ["Fixed Beta UI defects"], sourceIndex: 1 },
      ],
    };
    r = JA.auditTailored(xSrc, xTail, [], vocab);
    check("BYPASS-5a cross-item bullet borrow (Beta bullet under Alpha) → RED unattributed", hasRedGate(r, "unattributed"), JSON.stringify(reds(r)));

    // (5b) duplicate sourceIndex: the same source row emitted twice.
    const dTail = {
      experience_details: [
        { company: "Alpha", position: "Senior Engineer", location: "NYC", key_responsibilities: ["Architected the Alpha billing platform"], sourceIndex: 0 },
        { company: "Alpha", position: "Senior Engineer", location: "NYC", key_responsibilities: ["Architected the Alpha billing platform"], sourceIndex: 0 },
      ],
    };
    r = JA.auditTailored(xSrc, dTail, [], vocab);
    check("BYPASS-5b duplicate sourceIndex → RED duplicate-source", hasRedGate(r, "duplicate-source"), JSON.stringify(reds(r)));
  }
}

// ---- 6c. CLEAN-REPHRASE regression: none of the fixes may cry wolf -------------------
// As important as 6b: proves the gates flag fabrication, not legitimate editing.
{
  const grounded = "Built internal tools with Python and React over one summer";

  // (a) rephrase introducing only common words + already-grounded proper nouns.
  let t = clone(baseSource);
  t.experience_details[0].key_responsibilities[0] = "Developed internal tooling with Python and React during a summer";
  let r = JA.auditTailored(baseSource, t, [{ op: "rephrase", section: "experience", before: grounded, after: t.experience_details[0].key_responsibilities[0], source: grounded }], vocab);
  check("CLEAN-a common-word rephrase → NO reds", reds(r).length === 0, JSON.stringify(reds(r)));

  // (b) Node → Node.js style rename (prefix-grounded, must not flag).
  t = clone(baseSource);
  t.projects[0].description = "Graph visualizer written in Node.js and TypeScript.";
  r = JA.auditTailored(baseSource, t, [{ op: "rephrase", section: "projects", before: "Graph visualizer written in Node and TypeScript.", after: t.projects[0].description, source: "Graph visualizer written in Node and TypeScript." }], vocab);
  check("CLEAN-b Node→Node.js rename → NO reds", reds(r).length === 0, JSON.stringify(reds(r)));

  // (c) date reformat + degree alias (already covered in §5; re-pinned in the clean block).
  t = clone(baseSource);
  t.experience_details[0].employment_period = "June 2021 - August 2021";
  t.education_details[0].education_level = "B.S.";
  r = JA.auditTailored(baseSource, t, [], vocab);
  check("CLEAN-c date reformat + degree alias → NO reds", reds(r).length === 0, JSON.stringify(reds(r)));

  // (d) grounded metric restatement (30% is a real source number).
  t = clone(baseSource);
  t.experience_details[0].key_responsibilities[1] = "Improved dashboard load time 30% via query tuning";
  r = JA.auditTailored(baseSource, t, [{ op: "rephrase", section: "experience", before: "Increased dashboard load speed by 30% through query tuning", after: t.experience_details[0].key_responsibilities[1], source: "Increased dashboard load speed by 30% through query tuning" }], vocab);
  check("CLEAN-d grounded 30% restatement → NO reds", reds(r).length === 0, JSON.stringify(reds(r)));
}

// ---- 8. diffWords correctness --------------------------------------------------------
{
  const ops = JA.diffWords("built tools with python", "built better tools with go");
  const opStr = ops.map((o) => `${o.op}:${o.text}`).join("|");
  check("diffWords keeps 'built' as eq", ops.some((o) => o.op === "eq" && /built/.test(o.text)), opStr);
  check("diffWords marks 'better' as add", ops.some((o) => o.op === "add" && /better/.test(o.text)), opStr);
  check("diffWords marks 'python' as del", ops.some((o) => o.op === "del" && /python/.test(o.text)), opStr);
  check("diffWords deterministic", JSON.stringify(JA.diffWords("a b c", "a x c")) === JSON.stringify(JA.diffWords("a b c", "a x c")));
}

// ---- 9. buildResumeDiff: item pairing survives a reorder -----------------------------
{
  const source = {
    experience_details: [
      { company: "Alpha", position: "Engineer", key_responsibilities: ["Alpha bullet one"] },
      { company: "Beta", position: "Engineer", key_responsibilities: ["Beta bullet one"] },
    ],
  };
  const tailored = {
    experience_details: [
      { company: "Beta", position: "Engineer", key_responsibilities: ["Beta bullet one improved"] },
      { company: "Alpha", position: "Engineer", key_responsibilities: ["Alpha bullet one"] },
    ],
  };
  const diff = JA.buildResumeDiff(source, tailored, []);
  const exp = diff.sections.find((s) => s.section === "experience");
  const alpha = exp.items.find((it) => it.before && it.before.company === "Alpha");
  const beta = exp.items.find((it) => it.before && it.before.company === "Beta");
  check("buildResumeDiff pairs items by identity, not array position (reorder-safe)",
    alpha.after.company === "Alpha" && beta.after.company === "Beta");
  check("buildResumeDiff preserves sourceIndex order", exp.items[0].sourceIndex === 0 && exp.items[1].sourceIndex === 1);
  check("Alpha's unchanged bullet pairs as eq", alpha.rows.some((r) => r.kind === "eq"));
  check("Beta's changed bullet pairs as rephrase (via similarity)", beta.rows.some((r) => r.kind === "rephrase"));
}

// ---- 10. buildDocDefinition: header allowlist ----------------------------------------
{
  const doc = JA.buildDocDefinition(baseSource);
  const s = JSON.stringify(doc);
  check("doc header includes name", s.includes("Naman Bist"));
  check("doc header includes email", s.includes("n@x.com"));
  check("doc NEVER leaks date_of_birth", !s.includes("03/15/1999"));
  check("doc NEVER leaks street address", !s.includes("123 Main St"));
  check("doc is a pure object with content array", Array.isArray(doc.content) && typeof doc.defaultStyle === "object");

  // Legal/EEO must NEVER reach the generated PDF doc-definition even if a model somehow
  // leaves it on the tailored object — the header allowlist excludes those sections. Pin it.
  const withLegal = clone(baseSource);
  withLegal.legal_authorization = { us_work_authorization: "AUTH_SENTINEL_YES", requires_us_sponsorship: "SPONSOR_SENTINEL_NO" };
  withLegal.self_identification = { gender: "GENDER_SENTINEL_MALE", veteran: "VET_SENTINEL", disability: "DISABILITY_SENTINEL" };
  const sLegal = JSON.stringify(JA.buildDocDefinition(withLegal));
  check("doc-def contains NONE of the legal_authorization/self_identification values",
    !["AUTH_SENTINEL_YES", "SPONSOR_SENTINEL_NO", "GENDER_SENTINEL_MALE", "VET_SENTINEL", "DISABILITY_SENTINEL"].some((v) => sLegal.includes(v)),
    sLegal.slice(0, 200));
}

// ---- 11. pickUploadResume ------------------------------------------------------------
{
  const original = { name: "cv.pdf", type: "application/pdf", b64: "AAAA" };
  const store = {
    "job-1": { approvedAt: 123, pdfName: "namanBistAcme CV.pdf", pdfB64: "BBBB" },
    "job-2": { pdfName: "draft.pdf", pdfB64: "CCCC" }, // not approved
  };
  check("approved tailored PDF returned for its own job", JA.pickUploadResume("job-1", store, original).b64 === "BBBB");
  check("unapproved job → original CV", JA.pickUploadResume("job-2", store, original).b64 === "AAAA");
  check("unknown job → original CV", JA.pickUploadResume("job-9", store, original).b64 === "AAAA");
  check("never cross-job: job-2 does not borrow job-1's approved PDF", JA.pickUploadResume("job-2", store, original).name === "cv.pdf");
  check("no original + unapproved → null", JA.pickUploadResume("job-2", store, null) === null);
}

// ---- 12. tailoredPdfName -------------------------------------------------------------
{
  check("name + company, legal suffix stripped, no space between name and company",
    JA.tailoredPdfName({ first_name: "Naman", last_name: "Bist" }, "Google, Inc.") === "namanBistGoogle CV.pdf",
    JA.tailoredPdfName({ first_name: "Naman", last_name: "Bist" }, "Google, Inc."));
  check("empty company → '<name> CV.pdf'",
    JA.tailoredPdfName({ first_name: "Naman", last_name: "Bist" }, "") === "namanBist CV.pdf");
  check("multiword company CamelCased", JA.tailoredPdfName({ first_name: "Ada", last_name: "Lovelace" }, "Big Data Co") === "adaLovelaceBigData CV.pdf");
  check("filesystem-unsafe chars stripped", !/[\\/:*?"<>|]/.test(JA.tailoredPdfName({ first_name: "A/B", last_name: "C:D" }, "E*F")));
}

summarize(results);
