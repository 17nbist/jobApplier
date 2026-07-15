// resolveConfigValues regressions (node-only, no browser) — every class of resolver
// bug the audits caught: date crashes, period splitting, current-role fabrication,
// residency slugs, EEO negation ordering, phone stripping, absent-legal discipline.
//
//   node test/unit-resolver.mjs
import fs from "node:fs";
import path from "node:path";
import { EXT, makeChecker, loadAiSandbox, summarize } from "./harness.mjs";

const { results, check } = makeChecker();
const { JA_AI } = loadAiSandbox();
const MAPS = JSON.parse(fs.readFileSync(path.join(EXT, "reference/value-maps.json"), "utf8"));

const NOW = "2026-07-15";
const resolve = (profile) => JA_AI.resolveConfigValues(profile, { maps: MAPS, now: NOW }).values;

// ---- 1. European-format dates must not crash the run (MONTHS[14] class)
{
  let crashed = null;
  let v = null;
  try {
    v = resolve({ personal_information: { first_name: "A", date_of_birth: "25/12/1999" },
      education_details: [{ institution: "X", start_date: "15/06/2019", year_of_completion: "13/07/2023" }] });
  } catch (e) { crashed = String(e); }
  check("month>12 dates never crash (DD/MM swaps)", crashed === null, crashed || "ok");
  check("25/12/1999 DOB read as Dec 25 (swap)", v?.birthday_MM?.v === "12" && v?.birthday_DD?.v === "25",
    JSON.stringify({ mm: v?.birthday_MM, dd: v?.birthday_DD }));
  const eduRow = v?.education?.v?.[0] || {};
  check("15/06/2019 start read as Jun 15", eduRow.start_month?.v === "06", JSON.stringify(eduRow.start_month));
}

// ---- 2. employment_period splitting ("October" contains "to"; ISO dashes)
{
  const v = resolve({ experience_details: [
    { company: "NowCo", position: "SWE", employment_period: "October 2019 - Present" },
    { company: "IsoCo", position: "SWE II", employment_period: "2023-06 - 2024-02" },
    { company: "YearCo", position: "Intern", employment_period: "2018-2022" },
  ] });
  const rows = v.experience.v;
  check("'October 2019 - Present': start survives, no false end",
    rows[0].start_year?.v === "2019" && rows[0].start_month?.v === "10" && !rows[0].end_year && rows[0].currently_working.v === "true",
    JSON.stringify({ sy: rows[0].start_year, sm: rows[0].start_month, ey: rows[0].end_year, cw: rows[0].currently_working }));
  check("ISO '2023-06 - 2024-02' parses both ends",
    rows[1].start_month?.v === "06" && rows[1].end_year?.v === "2024" && rows[1].currently_working.v === "",
    JSON.stringify({ sm: rows[1].start_month, ey: rows[1].end_year }));
  check("bare year-range '2018-2022' parses", rows[2].start_year?.v === "2018" && rows[2].end_year?.v === "2022",
    JSON.stringify({ sy: rows[2].start_year, ey: rows[2].end_year }));
  check("currently_working reflects the ACTUAL current row (not row 0)",
    v.currently_working?.v === "true" && v.current_company_name?.v === "NowCo", JSON.stringify(v.current_company_name));
}

// ---- 3. no current employer fabricated when nothing is current
{
  const v = resolve({ experience_details: [
    { company: "OldCo", position: "Intern A", employment_period: "02/2018 - 04/2019" },
    { company: "OlderCo", position: "Intern B", employment_period: "05/2016 - 01/2017" },
  ] });
  check("between jobs: current_company/title absent, currently_working explicit No",
    v.current_company_name === undefined && v.current_job_title === undefined && v.currently_working?.v === "",
    JSON.stringify({ c: v.current_company_name, w: v.currently_working }));
}

// ---- 4. in_country: US → slug "usa"; non-US/unset → absent (the config's static
// "in-usa-false" fallback must never be reachable via a mistyped boolean)
{
  const us = resolve({ personal_information: { country: "United States of America" } });
  const ca = resolve({ personal_information: { country: "Canada" } });
  const none = resolve({});
  check("in_country: US profile → 'usa' slug", us.in_country?.v === "usa", JSON.stringify(us.in_country));
  check("in_country: non-US/unset → absent", ca.in_country === undefined && none.in_country === undefined,
    JSON.stringify({ ca: ca.in_country, none: none.in_country }));
  check("USA long form recognized in country alts", (us.country?.alts || []).includes("US"), JSON.stringify(us.country));
}

// ---- 5. ethnicity: negated-Hispanic compounds never invert; raw text is primary
{
  const v = resolve({ self_identification: { ethnicity: "Two or More Races (Not Hispanic or Latino)" } });
  check("'(Not Hispanic or Latino)' compound → raw primary, Multiple canonical, never Hispanic",
    v.ethnicity?.v === "Two or More Races (Not Hispanic or Latino)" &&
    (v.ethnicity?.alts || []).includes("Multiple") &&
    !(JSON.stringify(v.ethnicity).includes("Hispanic/Latinx")),
    JSON.stringify(v.ethnicity));
  const plain = resolve({ self_identification: { ethnicity: "Hispanic or Latino" } });
  check("affirmative Hispanic still canonicalizes", (plain.ethnicity?.alts || []).includes("Hispanic/Latinx"),
    JSON.stringify(plain.ethnicity));
}

// ---- 6. phone_stripped with embedded +cc but blank cc field
{
  const v = resolve({ personal_information: { phone: "+1 570 555 8977" } });
  check("phone_stripped drops the embedded +1", v.phone_stripped?.v === "5705558977", JSON.stringify(v.phone_stripped));
}

// ---- 7. legal discipline: unset legal answers stay absent; booleans never coerce
{
  const v = resolve({ legal_authorization: { us_work_authorization: "" }, self_identification: {} });
  const legalKeys = ["work_auth", "work_auth_2", "sponsorship", "sponsorship_3", "visa", "gender", "transgender", "pronouns", "veteran_v2", "disability_v2", "armed_forces", "disability_name", "disability_date"];
  const leaked = legalKeys.filter((k) => v[k] !== undefined);
  check("unset legal profile → zero legal keys resolved", leaked.length === 0, leaked.join(",") || "none");
  const b = resolve({ legal_authorization: { us_work_authorization: true } }); // hand-edited JSON booleans
  check("boolean-typed profile values don't crash (norm coercion)", b.work_auth?.v === "true", JSON.stringify(b.work_auth));
}

// ---- 8. hasExperience is never emitted (engine blocks the editorial default instead)
{
  const some = resolve({ experience_details: [{ company: "X", position: "Y", employment_period: "01/2020 - Present" }] });
  const noneP = resolve({});
  check("hasExperience never resolver-emitted (manual unless real rows exist — engine guards the editorial literal)",
    some.hasExperience === undefined && noneP.hasExperience === undefined,
    JSON.stringify({ some: some.hasExperience, none: noneP.hasExperience }));
}

// ---- 9. grouping aliases exist for nested typeahead selectors
{
  const v = resolve({
    education_details: [{ institution: "Stanford University", education_level: "Master's" }],
    experience_details: [{ company: "Dunder Mifflin", position: "RM", employment_period: "06/1990 - Present" }],
  });
  check("education rows carry name alias for grouping selectors", v.education.v[0].name?.v === "Stanford University",
    JSON.stringify(v.education.v[0].name));
  check("experience rows carry name/employer aliases", v.experience.v[0].name?.v === "Dunder Mifflin" && v.experience.v[0].employer?.v === "Dunder Mifflin",
    JSON.stringify({ n: v.experience.v[0].name, e: v.experience.v[0].employer }));
}

summarize(results);
