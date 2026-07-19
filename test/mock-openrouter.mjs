// Localhost OpenRouter mock for e2e runs: same SSE wire format (reasoning deltas,
// content deltas, usage chunk, [DONE]), deterministic outputs. The extension points at
// it via the Settings "API base URL" — Playwright route() can't reliably intercept
// extension-page fetches, so this is the stable seam.
import http from "node:http";

export const PORT = 8787;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Private-Network": "true",
};

export const MOCK_VALUES = {
  first: "Testy", last: "McTestface", email: "testy@example.com",
  phone: "5555550100", linkedin: "https://www.linkedin.com/in/testy",
  github: "https://github.com/testy", site: "https://example.com",
  city: "San Francisco",
};

// Rough stand-in for the LLM's mapping judgment, keyed on label/autocomplete.
function mapValue(field) {
  const hay = `${field.label || ""} ${field.autocomplete || ""}`.toLowerCase();
  const has = (re) => re.test(hay);
  if (has(/preferred/) ) return null;
  if (has(/first name|given-name/)) return MOCK_VALUES.first;
  if (has(/last name|family-name|surname/)) return MOCK_VALUES.last;
  if (has(/full name/)) return `${MOCK_VALUES.first} ${MOCK_VALUES.last}`;
  if (has(/e-?mail/)) return MOCK_VALUES.email;
  if (has(/phone|tel\b/)) return MOCK_VALUES.phone;
  if (has(/linkedin/)) return MOCK_VALUES.linkedin;
  if (has(/github/)) return MOCK_VALUES.github;
  if (has(/portfolio|website/)) return MOCK_VALUES.site;
  if (has(/location|city/) && field.kind === "text") return MOCK_VALUES.city;
  if (field.options?.length) {
    // Harvested-options retry pass: pick a real option so the second fill succeeds.
    if (field.optionsSource === "harvested") return field.options[0];
    return null;
  }
  return null;
}

function sseChunks(reasoningText, contentText) {
  const chunks = [`: OPENROUTER PROCESSING\n\n`];
  for (const piece of reasoningText.match(/.{1,40}/gs) || []) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: piece } }] })}\n\n`);
  }
  for (const piece of contentText.match(/.{1,60}/gs) || []) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  chunks.push(`data: ${JSON.stringify({
    usage: { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123, cost: 0.000123 },
    choices: [{ delta: {} }],
  })}\n\n`);
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

export const PARSED_RESUME = {
  personal_information: {
    first_name: "Ada", last_name: "Lovelace", email: "ada@example.com",
    phone: "+14155550123", city: "London", country: "United Kingdom",
    linkedin: "https://www.linkedin.com/in/adalovelace", github: "https://github.com/ada",
  },
  education_details: [{ education_level: "Bachelor's", institution: "University of London", field_of_study: "Mathematics", start_date: "1833", year_of_completion: "1837", final_evaluation_grade: "" }],
  experience_details: [{ position: "Analyst Engine Programmer", company: "Babbage & Co", employment_period: "1842 - 1843", location: "London", industry: "Computing", key_responsibilities: ["Wrote the first published algorithm"], skills_acquired: ["Algorithms"] }],
  projects: [{ name: "Note G", description: "Bernoulli number computation for the Analytical Engine", link: "" }],
  certifications: [],
  languages: [{ language: "English", proficiency: "Native" }],
  skills: "Mathematics, Algorithms, Technical writing",
  // Adversarial: the mock "model" disobeys and emits a legal section — the extension's
  // sanitizeParsedProfile must strip this before it ever reaches the editor.
  legal_authorization: { us_work_authorization: "Yes", requires_us_sponsorship: "No" },
  self_identification: { gender: "Female" },
};

// Hardcoded tailor output for the seeded e2e profile (JA_SAMPLE_PROFILE — Michael Scott).
// ADVERSARIAL BY DESIGN: this "model" plants fabrications so the downstream tailor audit
// (Agent C) can be proven to catch them. The rest of the tailoring is clean/grounded.
//
// Planted fabrications (Agent D should assert the audit flags these):
//   1. Invented METRIC — "Reduced deployment time by 60% …": the number 60% is NOT in the
//      source résumé.
//   2. Invented SKILL/TOOL — "Kubernetes": absent from the source (added to a bullet, to
//      skills_acquired, and to the skills string).
//   3. Unresolvable `source` quote — the `add` change's `source` ("Automated the build and
//      release pipeline for internal tools") is a PARAPHRASE that appears nowhere verbatim
//      in the source CV, so it can't resolve/attribute.
export const TAILORED_RESUME = {
  tailored: {
    // Identity is force-copied wholesale from the source in production (ai.js
    // sanitizeTailored never lets the model touch personal_information), so mirror the FULL
    // seeded JA_SAMPLE_PROFILE identity here — a partial copy would read as fabricated
    // identity to the audit even though production never omits these fields.
    personal_information: {
      first_name: "Michael", last_name: "Scott", email: "mscott@dundermifflin.com",
      phone: "+15705558977", phone_country_code: "+1",
      date_of_birth: "03/15/1964", address: "1725 Slough Avenue",
      location: "Scranton, PA, USA", city: "Scranton", state: "Pennsylvania",
      country: "United States", zip_code: "18503",
      linkedin: "https://www.linkedin.com/in/mscott", github: "https://github.com/mscott",
      portfolio: "https://en.wikipedia.org/wiki/Michael_Scott_(The_Office)",
    },
    experience_details: [
      {
        position: "Software Engineer Intern", company: "MEDSmart", employment_period: "02/2018 - 04/2022",
        location: "Chicago, IL, USA", industry: "Health tech",
        key_responsibilities: [
          "Built and tested software solutions in HTML, CSS, JavaScript, and PHP",
          "Reduced deployment time by 60% by containerizing services with Kubernetes",
          "Authored technical documentation for new and existing applications",
        ],
        skills_acquired: ["JavaScript", "PHP", "Kubernetes"],
        sourceIndex: 1,
      },
      {
        position: "Regional Manager", company: "Dunder Mifflin", employment_period: "06/1990 - Present",
        location: "Scranton, PA, USA", industry: "Paper",
        key_responsibilities: [
          "Three-time winner of \"Best Salesman in Pennsylvania\"",
          "Grew glossy stock paper sales 75% in a single month",
          "Consistently led all branches in revenue and total sales",
        ],
        skills_acquired: ["Sales", "Management"],
        sourceIndex: 0,
      },
    ],
    education_details: [
      { education_level: "Master's", institution: "Stanford University", field_of_study: "Business", start_date: "2000", year_of_completion: "2002", final_evaluation_grade: "4.0", sourceIndex: 0 },
      { education_level: "Bachelor's", institution: "University of Scranton", field_of_study: "Business", start_date: "1995", year_of_completion: "1999", final_evaluation_grade: "4.0", sourceIndex: 1 },
    ],
    skills: "JavaScript, PHP, HTML, CSS, Kubernetes, Sales, Management",
  },
  changes: [
    { section: "experience_details", sourceIndex: 1, field: "order", kind: "reorder", before: "Software Engineer Intern listed second", after: "Software Engineer Intern moved to the top", source: "", reason: "Lead with the engineering role for a software posting" },
    { section: "experience_details", sourceIndex: 1, field: "key_responsibilities", kind: "rephrase", before: "Designed, developed and tested software solutions using HTML, CSS, JavaScript, and PHP", after: "Built and tested software solutions in HTML, CSS, JavaScript, and PHP", source: "Designed, developed and tested software solutions using HTML, CSS, JavaScript, and PHP", reason: "Tighten wording" },
    { section: "experience_details", sourceIndex: 1, field: "key_responsibilities", kind: "add", before: "", after: "Reduced deployment time by 60% by containerizing services with Kubernetes", source: "Automated the build and release pipeline for internal tools", reason: "Surface DevOps impact" },
    { section: "experience_details", sourceIndex: 0, field: "key_responsibilities", kind: "rephrase", before: "Increased glossy stock paper sales by 75% over a one month period", after: "Grew glossy stock paper sales 75% in a single month", source: "Increased glossy stock paper sales by 75% over a one month period", reason: "Concision" },
    // Remaining rephrases declared with GROUNDED source tags so the audit sees a clean,
    // fully-attributed tailoring apart from the three planted fabrications above. (The last
    // one introduces "led" — a verb-inflation YELLOW, deliberately below the RED bar.)
    { section: "experience_details", sourceIndex: 1, field: "key_responsibilities", kind: "rephrase", before: "Wrote technical documentation for new and existing applications", after: "Authored technical documentation for new and existing applications", source: "Wrote technical documentation for new and existing applications", reason: "Stronger verb, same claim" },
    { section: "experience_details", sourceIndex: 0, field: "key_responsibilities", kind: "rephrase", before: "Winner of 3 straight \"Best Salesman in Pennsylvania\" awards", after: "Three-time winner of \"Best Salesman in Pennsylvania\"", source: "Winner of 3 straight \"Best Salesman in Pennsylvania\" awards", reason: "Tighten wording" },
    { section: "experience_details", sourceIndex: 0, field: "key_responsibilities", kind: "rephrase", before: "Consistently outperformed other branches in revenue and total sales", after: "Consistently led all branches in revenue and total sales", source: "Consistently outperformed other branches in revenue and total sales", reason: "Concision" },
  ],
};

function respond(req, res, body) {
  let reasoning = "Reading the form schema and matching profile facts to each field, skipping anything not derivable.";
  let content;
  const system = body.messages?.[0]?.content || "";
  const user = body.messages?.find((m) => m.role === "user")?.content || "";
  // Primary discriminator: the X-JA-Task header callGLM sends (prompt wording stays
  // freely editable). Prompt-substring fallback kept for robustness.
  const task = req.headers["x-ja-task"] || "";

  if (task === "parse-resume" || /extract structured data from résumés/i.test(system)) {
    reasoning = "Extracting the résumé into the profile schema, leaving legal sections out.";
    content = JSON.stringify(PARSED_RESUME);
  } else if (task === "answer-batch") {
    // Deterministic essay answers keyed by ref, echoing the question list.
    let qs = [];
    const m = user.match(/QUESTIONS:\n([\s\S]*?)\n\nReturn the JSON object/);
    try { qs = JSON.parse(m ? m[1] : "[]"); } catch { qs = []; }
    reasoning = "Answering open-ended questions from profile facts only.";
    content = JSON.stringify({
      answers: qs.map((q) => ({
        ref: q.ref,
        answer: /clearance|salary/i.test(q.question || "") ? null :
          `Mock grounded answer for "${(q.question || "").slice(0, 40)}" — built from the profile, no invented facts.`,
      })),
    });
  } else if (task === "tailor") {
    reasoning = "Leading with the engineering role for a software posting and tightening bullets; every claim traced to the source résumé.";
    content = JSON.stringify(TAILORED_RESUME);
  } else if (task === "map-fields" || /fill job-application forms/i.test(system)) {
    let fields = [];
    // Test-coupled framing: this regex must match the user-prompt layout in ai.js
    // mapFields (marked there with the same comment).
    const m = user.match(/FORM FIELDS:\n([\s\S]*?)\n\nReturn the JSON object/);
    try { fields = JSON.parse(m ? m[1] : "[]"); } catch { fields = []; }
    const mappings = fields
      .map((f) => ({ ref: f.ref, value: mapValue(f), confidence: 0.9 }))
      .filter((x) => x.value !== null);
    content = JSON.stringify({ mappings });
  } else {
    const company = (user.match(/COMPANY: (.*)/) || [])[1] || "the team";
    content = [
      `Dear ${company.trim()} Hiring Team,`,
      "",
      "This is a deterministic mock cover letter produced by the local test double so the",
      "streaming pipeline, thinking display, and copy button can be exercised offline.",
      // e2e hook: proves a panel-pasted JD actually landed in this request's prompt.
      ...(/JA-TEST-PASTED-JD/.test(user) ? ["", "Pasted job details reached the model (JA-TEST-PASTED-JD echo)."] : []),
      "",
      "Sincerely,",
      "Testy McTestface",
    ].join("\n");
    reasoning = "Drafting a short deterministic letter for the harness.";
  }

  res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunks = sseChunks(reasoning, content);
  let i = 0;
  const t = setInterval(() => {
    if (i < chunks.length) res.write(chunks[i++]);
    else { clearInterval(t); res.end(); }
  }, 20);
}

// Fixture pages served off the same mock server so Agent D's tailor e2e can drive the
// content-script's config-first job-context path and the résumé upload flow without a
// real ATS. Paths (GET):
//   /fixtures/jd-ashby   — a JD page whose DOM matches the AshbyHQ ResumeScores XPaths:
//       jobTitlePath        .//h1[contains(@class,"_title_") and contains(@class,"ashby-job-posting-heading")]
//       jobDescriptionPath  .//div[@id="overview"]/div[contains(@class,"descriptionText")]   (>200 chars)
//       jobCompanyNamePath  .//img[contains(@class,"_navLogoWordmarkImage_")]/@alt
//     Panel scrapes with jdConfig = ResumeScores.AshbyHQ → title "Senior Software Engineer",
//     company "Testry Robotics", description containing "ASHBY_FIXTURE_DESCRIPTION".
//   /fixtures/form-upload — an application form with a file input (id/name "resume") for
//     the upload-source e2e.
const JD_ASHBY_HTML = `<!doctype html><html><head><title>Careers · Testry Robotics</title></head><body>
  <nav><img class="ashby-nav _navLogoWordmarkImage_9f2" alt="Testry Robotics" src="data:," /></nav>
  <h1 class="_title_h7x ashby-job-posting-heading">Senior Software Engineer</h1>
  <div id="overview">
    <div class="_descriptionText_1a2 descriptionText">
      <p>ASHBY_FIXTURE_DESCRIPTION — Testry Robotics is hiring a Senior Software Engineer to
      build resilient distributed backends in TypeScript and Go. You will own services end
      to end, ship to production daily, mentor engineers, and partner with product to turn
      ambiguous problems into reliable systems that serve millions of requests per day.</p>
    </div>
  </div>
</body></html>`;
const FORM_UPLOAD_HTML = `<!doctype html><html><head><title>Apply · Testry Robotics</title></head><body>
  <form id="application-form">
    <label for="first_name">First name</label>
    <input id="first_name" name="first_name" type="text" />
    <label for="email">Email</label>
    <input id="email" name="email" type="email" />
    <label for="resume">Resume / CV</label>
    <input id="resume" name="resume" type="file" />
    <button type="submit">Submit application</button>
  </form>
</body></html>`;

function sendHtml(res, html) {
  res.writeHead(200, { ...CORS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(html);
}

export function createMockServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    if (req.method === "GET" && req.url.startsWith("/fixtures/jd-ashby")) { sendHtml(res, JD_ASHBY_HTML); return; }
    if (req.method === "GET" && req.url.startsWith("/fixtures/form-upload")) { sendHtml(res, FORM_UPLOAD_HTML); return; }
    if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* empty */ }
        respond(req, res, body);
      });
      return;
    }
    res.writeHead(404, CORS);
    res.end("not found");
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createMockServer().then(() => console.log(`mock OpenRouter on http://127.0.0.1:${PORT}/v1`));
}
