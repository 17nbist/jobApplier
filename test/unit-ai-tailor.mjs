// Unit tests for ai.js sanitizeTailored — the non-fabrication firewall on the résumé
// tailor path (step 4). Legal sections stripped, malformed changes dropped (never
// thrown), and every identity fact force-copied from the source so the model can only
// touch editable bullet/skill/description text.
//
//   node test/unit-ai-tailor.mjs
import { loadAiSandbox, makeChecker, summarize } from "./harness.mjs";

const { JA_AI } = loadAiSandbox();
const { results, check } = makeChecker();

const SOURCE = {
  personal_information: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
  experience_details: [
    {
      position: "Analyst", company: "Babbage & Co", employment_period: "1842 - 1843",
      location: "London", industry: "Computing",
      key_responsibilities: ["Wrote the first published algorithm"], skills_acquired: ["Algorithms"],
    },
  ],
  education_details: [
    { education_level: "Bachelor's", institution: "University of London", field_of_study: "Mathematics", start_date: "1833", year_of_completion: "1837" },
  ],
  skills: "Mathematics, Algorithms",
};

// (a) legal sections in parsed.tailored are STRIPPED.
{
  const parsed = {
    tailored: {
      ...structuredClone(SOURCE),
      legal_authorization: { us_work_authorization: "Yes", requires_us_sponsorship: "No" },
      self_identification: { gender: "Female" },
    },
    changes: [],
  };
  const out = JA_AI.sanitizeTailored(SOURCE, parsed);
  check("(a) legal_authorization stripped", !("legal_authorization" in out.tailored));
  check("(a) self_identification stripped", !("self_identification" in out.tailored));
}

// (b) a change with a bad `kind` enum or a missing field is DROPPED, not thrown.
{
  const parsed = {
    tailored: structuredClone(SOURCE),
    changes: [
      { section: "experience_details", sourceIndex: 0, field: "key_responsibilities", kind: "franken", before: "x", after: "y", source: "z", reason: "" },
      { sourceIndex: 0, kind: "rephrase", before: "x", after: "y" }, // no section
      { section: "experience_details", sourceIndex: 0, field: "key_responsibilities", kind: "rephrase", before: "Wrote the first published algorithm", after: "Authored the first published algorithm", source: "Wrote the first published algorithm", reason: "" },
    ],
  };
  let out, threw = false;
  try { out = JA_AI.sanitizeTailored(SOURCE, parsed); } catch { threw = true; }
  check("(b) does not throw on malformed changes", !threw);
  check("(b) bad-enum change dropped", !!out && out.changes.every((c) => c.kind !== "franken"));
  check("(b) missing-section change dropped", !!out && out.changes.length === 1);
  check("(b) valid change survives", !!out && out.changes[0]?.kind === "rephrase");
}

// (c) personal_information is force-copied from source even if the model tries to change it.
{
  const parsed = {
    tailored: {
      ...structuredClone(SOURCE),
      personal_information: { first_name: "HACKED", last_name: "HACKED", email: "evil@attacker.test" },
    },
    changes: [],
  };
  const out = JA_AI.sanitizeTailored(SOURCE, parsed);
  check("(c) personal first_name force-copied", out.tailored.personal_information.first_name === "Ada");
  check("(c) personal last_name force-copied", out.tailored.personal_information.last_name === "Lovelace");
  check("(c) personal email force-copied", out.tailored.personal_information.email === "ada@example.com");
}

// (d) per-sourceIndex company/position/dates force-copied; a model attempt to alter them
// is overridden, but editable bullets from the model are kept.
{
  const parsed = {
    tailored: {
      experience_details: [
        {
          position: "Senior Engineer", company: "Evil Corp", employment_period: "2020 - 2024",
          location: "Mars", key_responsibilities: ["Reordered and rephrased bullet"],
          skills_acquired: ["Algorithms"], sourceIndex: 0,
        },
      ],
    },
    changes: [],
  };
  const out = JA_AI.sanitizeTailored(SOURCE, parsed);
  const it = out.tailored.experience_details[0];
  check("(d) company force-copied verbatim", it.company === "Babbage & Co");
  check("(d) position force-copied verbatim", it.position === "Analyst");
  check("(d) employment_period force-copied verbatim", it.employment_period === "1842 - 1843");
  check("(d) location force-copied verbatim", it.location === "London");
  check("(d) editable bullets kept from model", it.key_responsibilities.join("|") === "Reordered and rephrased bullet");
}

// (e) unknown keys inside items are stripped (output is built from the source shape).
{
  const parsed = {
    tailored: {
      experience_details: [
        { sourceIndex: 0, key_responsibilities: ["ok"], skills_acquired: ["Algorithms"], salary: "999999", secretFlag: true, __proto__pollution: 1 },
      ],
    },
    changes: [],
  };
  const out = JA_AI.sanitizeTailored(SOURCE, parsed);
  const it = out.tailored.experience_details[0];
  check("(e) unknown key `salary` stripped", !("salary" in it));
  check("(e) unknown key `secretFlag` stripped", !("secretFlag" in it));
  check("(e) known identity key retained", it.company === "Babbage & Co");
}

// (f) a change referencing a nonexistent sourceIndex is dropped.
{
  const parsed = {
    tailored: structuredClone(SOURCE),
    changes: [
      { section: "experience_details", sourceIndex: 99, field: "key_responsibilities", kind: "rephrase", before: "a", after: "b", source: "a", reason: "" },
      { section: "experience_details", sourceIndex: 0, field: "key_responsibilities", kind: "rephrase", before: "a", after: "b", source: "a", reason: "" },
    ],
  };
  const out = JA_AI.sanitizeTailored(SOURCE, parsed);
  check("(f) out-of-range sourceIndex change dropped", out.changes.length === 1);
  check("(f) in-range sourceIndex change kept", out.changes[0]?.sourceIndex === 0);
}

// Bonus: a fabricated experience item (sourceIndex with no matching source row) is dropped.
{
  const parsed = {
    tailored: {
      experience_details: [
        { position: "Ghost", company: "Nowhere Inc", employment_period: "2099", key_responsibilities: ["invented"], sourceIndex: 7 },
        { sourceIndex: 0, key_responsibilities: ["real"], skills_acquired: ["Algorithms"] },
      ],
    },
    changes: [],
  };
  const out = JA_AI.sanitizeTailored(SOURCE, parsed);
  check("(bonus) fabricated item (bad sourceIndex) dropped", out.tailored.experience_details.length === 1);
  check("(bonus) surviving item is the real source row", out.tailored.experience_details[0].company === "Babbage & Co");
}

// (g) a SECOND item claiming an already-used sourceIndex is DROPPED (first-wins), and the
// drop is recorded on `dropped` so it stays visible. Guards the cross-job-misattribution /
// duplicate-sourceIndex bypass: the same source row emitted twice would let a borrowed
// bullet ride under a second identity and dodge the identity audit.
{
  const parsed = {
    tailored: {
      experience_details: [
        { sourceIndex: 0, key_responsibilities: ["First copy — kept"], skills_acquired: ["Algorithms"] },
        { sourceIndex: 0, key_responsibilities: ["Second copy — must be dropped"], skills_acquired: ["Algorithms"] },
      ],
    },
    changes: [],
  };
  const out = JA_AI.sanitizeTailored(SOURCE, parsed);
  check("(g) duplicate sourceIndex → only one experience item survives", out.tailored.experience_details.length === 1);
  check("(g) first copy wins", out.tailored.experience_details[0].key_responsibilities.join("|") === "First copy — kept");
  check("(g) the drop is recorded on `dropped`", Array.isArray(out.dropped) && out.dropped.some((d) => d.section === "experience_details" && d.sourceIndex === 0));
}

summarize(results);
