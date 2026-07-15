// jobApplier profile schema — AIHawk's plain_text_resume.yaml shape (docs/05), which
// separates legal_authorization and self_identification out as explicit pre-answered
// sections (the LEGAL_FIELDS rule depends on this separation). Loaded before sidepanel.js.
"use strict";

// Editor descriptors: flat sections render as inputs, arrays as JSON textareas.
// [key, label, type, placeholderOrOptions]
const JA_PROFILE_SECTIONS = [
  {
    key: "personal_information", label: "Personal information", type: "object", fields: [
      ["first_name", "First name", "text", "Jane"],
      ["last_name", "Last name", "text", "Doe"],
      ["email", "Email", "email", "you@example.com"],
      ["phone", "Phone", "tel", "+1 555 555 0100"],
      ["phone_country_code", "Phone country code", "text", "+1"],
      ["date_of_birth", "Date of birth (MM/DD/YYYY — only for age/over-18 questions)", "text", ""],
      ["address", "Street address", "text", "123 Main St"],
      ["location", "Location (City, ST, Country)", "text", "San Francisco, CA, USA"],
      ["city", "City", "text", ""],
      ["state", "State / Province", "text", ""],
      ["country", "Country", "text", "United States"],
      ["zip_code", "Postal code", "text", ""],
      ["linkedin", "LinkedIn URL", "url", "https://www.linkedin.com/in/…"],
      ["github", "GitHub URL", "url", "https://github.com/…"],
      ["portfolio", "Portfolio / website", "url", ""],
    ],
  },
  {
    key: "legal_authorization", legal: true, type: "object",
    label: "Work authorization — filled verbatim, never AI-generated", fields: [
      ["us_work_authorization", "Authorized to work in the US?", "select", ["", "Yes", "No"]],
      ["requires_us_visa", "Require a US visa?", "select", ["", "Yes", "No"]],
      ["requires_us_sponsorship", "Require sponsorship (now or in future)?", "select", ["", "Yes", "No"]],
    ],
  },
  {
    key: "self_identification", legal: true, type: "object",
    label: "Self-identification / EEO — filled verbatim, never AI-generated", fields: [
      ["gender", "Gender", "text", "exact option text, e.g. Male / Decline To Self Identify"],
      ["pronouns", "Pronouns", "text", "e.g. He/him — blank = never filled"],
      ["transgender", "Transgender", "text", "e.g. No / Decline to self identify"],
      ["ethnicity", "Ethnicity / race", "text", "exact option text, e.g. Asian"],
      ["hispanic", "Hispanic or Latino?", "text", "Yes / No / Decline"],
      ["veteran", "Veteran status", "text", "e.g. I am not a protected veteran"],
      ["disability", "Disability status", "text", "e.g. No, I do not have a disability"],
      ["lgbtq", "LGBTQ+", "text", "blank = never filled"],
    ],
  },
  {
    key: "work_preferences", label: "Work preferences", type: "object", fields: [
      ["remote_work", "Open to remote?", "select", ["", "Yes", "No"]],
      ["in_person_work", "Open to in-person?", "select", ["", "Yes", "No"]],
      ["open_to_relocation", "Open to relocation?", "select", ["", "Yes", "No"]],
      ["willing_to_complete_assessments", "Willing to complete assessments?", "select", ["", "Yes", "No"]],
      ["willing_to_undergo_background_checks", "OK with background checks?", "select", ["", "Yes", "No"]],
      ["willing_to_undergo_drug_tests", "OK with drug tests?", "select", ["", "Yes", "No"]],
    ],
  },
  {
    key: "availability", label: "Availability", type: "object", fields: [
      ["notice_period", "Notice period / start date", "text", "e.g. Available June 2027"],
    ],
  },
  {
    key: "salary_expectations", label: "Salary expectations", type: "object", fields: [
      ["salary_range_usd", "Salary expectation (USD)", "text", "e.g. 120000-140000"],
    ],
  },
  { key: "education_details", label: "Education (JSON array)", type: "json" },
  { key: "experience_details", label: "Experience (JSON array)", type: "json" },
  { key: "projects", label: "Projects (JSON array)", type: "json" },
  { key: "certifications", label: "Certifications (JSON array)", type: "json" },
  { key: "languages", label: "Languages (JSON array)", type: "json" },
  { key: "skills", label: "Skills (comma-separated)", type: "textarea" },
  { key: "resume_text", label: "Résumé (paste plain text — used for cover letters)", type: "textarea" },
];

function jaEmptyProfile() {
  const p = {};
  for (const s of JA_PROFILE_SECTIONS) {
    if (s.type === "object") {
      p[s.key] = {};
      for (const [k] of s.fields) p[s.key][k] = "";
    } else if (s.type === "json") {
      p[s.key] = [];
    } else {
      p[s.key] = "";
    }
  }
  return p;
}

// Dev fixture derived from reference/sample-profile.json (the upstream Michael Scott
// tutorial profile), translated into the AIHawk shape. For testing only.
const JA_SAMPLE_PROFILE = {
  personal_information: {
    first_name: "Michael", last_name: "Scott", email: "mscott@dundermifflin.com",
    phone: "+15705558977", phone_country_code: "+1",
    date_of_birth: "03/15/1964", address: "1725 Slough Avenue",
    location: "Scranton, PA, USA", city: "Scranton", state: "Pennsylvania",
    country: "United States", zip_code: "18503",
    linkedin: "https://www.linkedin.com/in/mscott", github: "https://github.com/mscott",
    portfolio: "https://en.wikipedia.org/wiki/Michael_Scott_(The_Office)",
  },
  legal_authorization: {
    us_work_authorization: "Yes", requires_us_visa: "No", requires_us_sponsorship: "No",
  },
  self_identification: {
    gender: "Male", pronouns: "He/him", transgender: "No", ethnicity: "White",
    hispanic: "No", veteran: "I am not a protected veteran",
    disability: "No, I do not have a disability", lgbtq: "No",
  },
  work_preferences: {
    remote_work: "Yes", in_person_work: "Yes", open_to_relocation: "Yes",
    willing_to_complete_assessments: "Yes", willing_to_undergo_background_checks: "Yes",
    willing_to_undergo_drug_tests: "Yes",
  },
  availability: { notice_period: "2 weeks" },
  salary_expectations: { salary_range_usd: "" },
  education_details: [
    { education_level: "Master's", institution: "Stanford University", field_of_study: "Business",
      start_date: "2000", year_of_completion: "2002", final_evaluation_grade: "4.0" },
    { education_level: "Bachelor's", institution: "University of Scranton", field_of_study: "Business",
      start_date: "1995", year_of_completion: "1999", final_evaluation_grade: "4.0" },
  ],
  experience_details: [
    { position: "Regional Manager", company: "Dunder Mifflin", employment_period: "06/1990 - Present",
      location: "Scranton, PA, USA", industry: "Paper",
      key_responsibilities: [
        "Winner of 3 straight \"Best Salesman in Pennsylvania\" awards",
        "Increased glossy stock paper sales by 75% over a one month period",
        "Consistently outperformed other branches in revenue and total sales",
      ],
      skills_acquired: ["Sales", "Management"] },
    { position: "Software Engineer Intern", company: "MEDSmart", employment_period: "02/2018 - 04/2022",
      location: "Chicago, IL, USA", industry: "Health tech",
      key_responsibilities: [
        "Designed, developed and tested software solutions using HTML, CSS, JavaScript, and PHP",
        "Wrote technical documentation for new and existing applications",
      ],
      skills_acquired: ["JavaScript", "PHP"] },
  ],
  projects: [
    { name: "Michael Scott Paper Company", description: "Founded a paper company; acquired in a multi-million dollar deal after claiming 33% of the local incumbent's client base.", link: "" },
  ],
  certifications: [],
  languages: [{ language: "English", proficiency: "Native" }],
  skills: "JavaScript, PHP, HTML, CSS, Sales, Management, Adobe Photoshop, Excel",
  resume_text: [
    "MICHAEL SCOTT",
    "Scranton, PA · mscott@dundermifflin.com · +1 570 555 8977 · linkedin.com/in/mscott",
    "",
    "EXPERIENCE",
    "Regional Manager, Dunder Mifflin — Scranton, PA (1990–Present)",
    "· 3x Best Salesman in Pennsylvania; grew glossy stock sales 75% in one month",
    "· Managed a 15-person branch that consistently led the company in revenue",
    "Software Engineer Intern, MEDSmart — Chicago, IL (2018–2022)",
    "· Built and tested internal tools with HTML/CSS/JavaScript/PHP; wrote technical docs",
    "",
    "EDUCATION",
    "Stanford University — M.S. Business (2002) · University of Scranton — B.S. Business (1999)",
  ].join("\n"),
};
