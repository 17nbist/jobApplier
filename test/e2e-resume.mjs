// Résumé→profile import e2e (docs/06): generate a text-layer résumé PDF, upload it in the
// Profile tab, and assert the editor is populated — with legal sections untouched even
// though the mock "model" adversarially emits them.
//
//   node test/e2e-resume.mjs                      (mock model)
//   OPENROUTER_API_KEY=… LIVE=1 node test/e2e-resume.mjs   (real GLM 5.2)
import { chromium } from "playwright";
import { createMockServer, PORT, PARSED_RESUME } from "./mock-openrouter.mjs";
import { ART, makeChecker, launchExtension, openPanel, finish } from "./harness.mjs";
import path from "node:path";
import fs from "node:fs";

const PDF_PATH = path.join(ART, "fixture-resume.pdf");
const LIVE = !!process.env.LIVE && !!process.env.OPENROUTER_API_KEY;
const { results, check } = makeChecker();

// ---- 1. Generate the fixture PDF (page.pdf needs headless; separate throwaway browser).
{
  const gen = await chromium.launch({ headless: true });
  const p = await gen.newPage();
  await p.setContent(`
    <h1>Ada Lovelace</h1>
    <p>London, United Kingdom · ada@example.com · +1 415 555 0123</p>
    <p>linkedin.com/in/adalovelace · github.com/ada</p>
    <h2>Experience</h2>
    <p><b>Analyst Engine Programmer — Babbage &amp; Co</b> (1842 – 1843, London)</p>
    <ul><li>Wrote the first published algorithm intended for a machine</li>
        <li>Documented the Analytical Engine's operation (Note G, Bernoulli numbers)</li></ul>
    <h2>Education</h2>
    <p>University of London — B.A. Mathematics (1833–1837)</p>
    <h2>Skills</h2>
    <p>Mathematics, Algorithms, Technical writing</p>`);
  await p.pdf({ path: PDF_PATH, format: "A4" });
  await gen.close();
  check("fixture résumé PDF generated", fs.existsSync(PDF_PATH), PDF_PATH);
}

const server = await createMockServer();
console.log(`mock OpenRouter on :${PORT} · live mode: ${LIVE}`);
let context;

try {
  const launched = await launchExtension();
  context = launched.context;
  const { sw, extId } = launched;

  // Seed storage from the SW before the panel opens (its init writes state on first load).
  // The profile carries Scranton-style dummy values (as if Load sample ran) in fields the
  // fixture CV never states — state / zip / portfolio / certifications. Import must CLEAR
  // those, not leave them to reach the real form (the bug this guards).
  await sw.evaluate(async ({ live, port, key }) => {
    await chrome.storage.local.set({
      state: { apiKey: live ? key : "test-key", model: "z-ai/glm-5.2", apiBase: live ? "" : `http://127.0.0.1:${port}/v1` },
      profile: {
        personal_information: {
          first_name: "Michael", last_name: "Scott", state: "Pennsylvania",
          zip_code: "18503", portfolio: "https://en.wikipedia.org/wiki/Dunder_Mifflin",
        },
        certifications: ["Dundie Award — Best Boss"],
      },
    });
  }, { live: LIVE, port: PORT, key: process.env.OPENROUTER_API_KEY || "" });

  const panel = await openPanel(context, extId);
  await panel.click('.tab[data-view="profile"]');
  await panel.setInputFiles("#resumeFile", PDF_PATH);

  await panel.waitForFunction(
    () => /Imported |Import failed/.test(document.getElementById("importStatus")?.innerText || ""),
    null,
    { timeout: 120000 },
  );
  const status = await panel.locator("#importStatus").innerText();
  check("import completes", /^Imported /.test(status), status);

  const editor = await panel.evaluate(() => {
    const get = (sec, key) =>
      document.querySelector(`[data-section="${sec}"][data-key="${key}"]`)?.value ?? null;
    const ta = (key) => document.querySelector(`[data-section-root="${key}"]`)?.value ?? "";
    return {
      first: get("personal_information", "first_name"),
      last: get("personal_information", "last_name"),
      email: get("personal_information", "email"),
      city: get("personal_information", "city"),
      country: get("personal_information", "country"),
      state: get("personal_information", "state"),
      zip: get("personal_information", "zip_code"),
      portfolio: get("personal_information", "portfolio"),
      workAuth: get("legal_authorization", "us_work_authorization"),
      sponsor: get("legal_authorization", "requires_us_sponsorship"),
      gender: get("self_identification", "gender"),
      experience: ta("experience_details"),
      certifications: ta("certifications"),
      resumeText: ta("resume_text"),
      skills: ta("skills"),
    };
  });

  check("first name imported", editor.first === "Ada", editor.first);
  check("last name imported", editor.last === "Lovelace", editor.last);
  check("email imported", editor.email === PARSED_RESUME.personal_information.email, editor.email);
  check("experience imported", /Babbage/i.test(editor.experience), editor.experience.slice(0, 60));
  check("skills imported", /algorithm/i.test(editor.skills), editor.skills);
  // UK résumé values flow through (no US assumption).
  check("UK city imported", editor.city === "London", editor.city);
  check("UK country imported", editor.country === "United Kingdom", editor.country);
  // The clear guard: fields the CV never states must NOT keep the Michael Scott dummies.
  check("stale state cleared on import", editor.state === "", `state="${editor.state}"`);
  check("stale zip cleared on import", editor.zip === "", `zip="${editor.zip}"`);
  check("stale portfolio cleared on import", editor.portfolio === "", `portfolio="${editor.portfolio}"`);
  check("stale certifications cleared on import", editor.certifications === "[]", editor.certifications);
  // But real CV names still replace the dummies (not just wiped).
  check("dummy first name replaced by CV", editor.first !== "Michael", editor.first);
  check("résumé text captured", /Analytical Engine|Bernoulli/i.test(editor.resumeText), `${editor.resumeText.length} chars`);
  // The guard: the mock model emitted legal_authorization + self_identification — the
  // editor's legal sections must still be empty.
  check("legal_authorization untouched by import", editor.workAuth === "" && editor.sponsor === "", `auth="${editor.workAuth}" sponsor="${editor.sponsor}"`);
  check("self_identification untouched by import", editor.gender === "", `gender="${editor.gender}"`);

  const think = await panel.evaluate(() => {
    const d = document.querySelector("#importOut details.thinking");
    return { text: d?.querySelector("pre")?.textContent || "", summary: d?.querySelector("summary")?.innerText || "" };
  });
  check("thinking rendered during parse", think.text.trim().length > 0 && /done/.test(think.summary), think.summary);
  check("usage line shown (cache visibility)", /\d.*(in|out)/.test(think.summary), think.summary);

  await panel.screenshot({ path: path.join(ART, "panel-resume-import.png"), fullPage: true });
} catch (e) {
  check("harness ran to completion", false, String(e).split("\n")[0]);
} finally {
  await finish(context, server, results);
}
