// Unit tests for ai.js validateMappings — the code-level guarantee behind the LLM field
// mapper, focused on the split-phone repair: a dial-code selector (+44 ▾) beside a
// national-number input must never end up with the full international number typed into
// the number box (the selector already supplies the prefix).
//
//   node test/unit-ai-map.mjs
import { loadAiSandbox, makeChecker, summarize } from "./harness.mjs";

const { JA_AI } = loadAiSandbox();
const { results, check } = makeChecker();

const PROFILE = { personal_information: { phone_country_code: "+44", phone: "+447448444192" } };

const phoneField = { ref: "f_phone", label: "Phone number", kind: "text", type: "tel", name: "phone", id: "phone" };
const dialSelect = {
  ref: "f_cc", label: "Country code", kind: "select", type: "select-one", name: "phone_country_code", id: "cc",
  options: ["+1", "+44", "+49", "+33"],
};
// Dial selector that scraped with NO useful label/name — detected purely by its options.
const anonDialSelect = { ref: "f_cc2", label: "", kind: "combobox", type: "text", name: "", id: "x1",
  options: ["US (+1)", "UK (+44)", "DE (+49)"] };
const residenceCountry = { ref: "f_country", label: "Country", kind: "select", type: "select-one", name: "country",
  id: "country", options: ["United Kingdom", "United States", "Germany", "France"] };
const extField = { ref: "f_ext", label: "Phone extension", kind: "text", type: "text", name: "phone_ext", id: "ext" };

const run = (fields, mappings, opts) => JA_AI.validateMappings(mappings, fields, opts);
const val = (clean, ref) => clean.find((m) => m.ref === ref)?.value;

// (a) the reported bug: +44 selected in a sibling selector AND stuffed into the number box.
{
  const clean = run([phoneField, dialSelect],
    [{ ref: "f_phone", value: "+44 7448 444192" }, { ref: "f_cc", value: "+44" }],
    { profile: PROFILE, allFields: [phoneField, dialSelect] });
  check("split widget: +44 prefix stripped from the number box", val(clean, "f_phone") === "7448444192", val(clean, "f_phone"));
  check("split widget: the dial selector's own +44 mapping is untouched", val(clean, "f_cc") === "+44");
}

// (b) 00-prefix and bare "44…" spellings strip too.
{
  const all = [phoneField, dialSelect];
  for (const spelled of ["00447448444192", "447448444192", "+447448444192"]) {
    const clean = run([phoneField], [{ ref: "f_phone", value: spelled }], { profile: PROFILE, allFields: all });
    check(`split widget: "${spelled}" → national digits`, val(clean, "f_phone") === "7448444192", val(clean, "f_phone"));
  }
}

// (c) dial selector detected by options alone (no label/name) — the screenshot case.
{
  const clean = run([phoneField], [{ ref: "f_phone", value: "+44 7448 444192" }],
    { profile: PROFILE, allFields: [phoneField, anonDialSelect] });
  check("optionless-label dial selector still triggers the strip", val(clean, "f_phone") === "7448444192", val(clean, "f_phone"));
}

// (d) NO dial sibling → the full international number is the right value; untouched.
{
  const clean = run([phoneField], [{ ref: "f_phone", value: "+44 7448 444192" }],
    { profile: PROFILE, allFields: [phoneField, residenceCountry] });
  check("no dial sibling: international number left alone", val(clean, "f_phone") === "+44 7448 444192", val(clean, "f_phone"));
  check("residence Country dropdown is NOT mistaken for a dial-code selector", true);
}

// (e) value that doesn't carry the profile cc (already national) is untouched.
{
  const clean = run([phoneField], [{ ref: "f_phone", value: "07448 444192" }],
    { profile: PROFILE, allFields: [phoneField, dialSelect] });
  check("already-national value untouched", val(clean, "f_phone") === "07448 444192", val(clean, "f_phone"));
}

// (f) different-country prefix (profile cc +44, value +1 …) is NOT blindly stripped.
{
  const clean = run([phoneField], [{ ref: "f_phone", value: "+1 570 555 8977" }],
    { profile: PROFILE, allFields: [phoneField, dialSelect] });
  check("mismatched cc: value untouched", val(clean, "f_phone") === "+1 570 555 8977", val(clean, "f_phone"));
}

// (g) extension field never gets phone-stripped; missing profile cc disables the repair.
{
  const clean = run([extField], [{ ref: "f_ext", value: "+44123" }],
    { profile: PROFILE, allFields: [extField, dialSelect] });
  check("extension field untouched", val(clean, "f_ext") === "+44123", val(clean, "f_ext"));
  const noCc = run([phoneField], [{ ref: "f_phone", value: "+44 7448 444192" }],
    { profile: { personal_information: {} }, allFields: [phoneField, dialSelect] });
  check("no profile country code: repair disabled", val(noCc, "f_phone") === "+44 7448 444192", val(noCc, "f_phone"));
}

// (h) the pre-existing guarantees still hold with the new signature (and without opts).
{
  const legal = { ref: "f_visa", label: "Will you require sponsorship?", kind: "select", options: ["Yes", "No"] };
  const clean = run([phoneField, legal],
    [{ ref: "f_visa", value: "No" }, { ref: "f_phone", value: "+44 7448 444192" }, { ref: "ghost", value: "x" }]);
  check("legal field still dropped no matter what", !clean.some((m) => m.ref === "f_visa"));
  check("unknown ref still dropped", !clean.some((m) => m.ref === "ghost"));
  check("opts omitted: legacy call shape works, value untouched", val(clean, "f_phone") === "+44 7448 444192");
}

summarize(results);
