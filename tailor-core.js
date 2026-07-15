// jobApplier résumé-tailoring core (step 4) — PURE data logic. No chrome.*, no DOM,
// no fetch, no pdfmake call. Node-testable (test/unit-tailor.mjs drives it directly).
//
// This is the SAFETY layer for the tailor path, the analog of the legal-verbatim guard
// on the fill side: auditTailored() is a defense-in-depth fabrication check that refuses
// to let an AI-tailored résumé claim a skill, number, date, title, or scope the source
// profile never contained. A hallucinated metric or invented employer on a résumé is the
// same class of harm as a hallucinated sponsorship answer — it can void an offer — so the
// gates below are deliberately conservative (RED = block, YELLOW = human verify).
//
// linearizeResume() is the SINGLE canonical text rendering of a structured CV. It is used
// symmetrically for BEFORE/AFTER keyword scoring, source-tag resolution, and the audit
// corpus, so it must be stable and deterministic. buildDocDefinition() is the SINGLE
// layout source (sidepanel preview == uploaded artifact).
"use strict";

var JA_TAILOR = (() => {
  // ------------------------------------------------------------------ text helpers
  const norm = (s) => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  // Fold for containment/equality: lowercase, collapse punctuation to spaces.
  const fold = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  // Strip bullet markers + cosmetic whitespace so linearize/diff can't self-trigger on "•".
  const normBullet = (s) => norm(String(s ?? "").replace(/^[\s•\-*·▪◦‣●]+/, ""));
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normContains = (hay, needle) => {
    const n = fold(needle);
    return !!n && fold(hay).includes(n);
  };
  const normEq = (a, b) => fold(normBullet(a)) === fold(normBullet(b));

  // ------------------------------------------------------------------ minimal date parse
  // MINIMAL local copy of ai.js splitPeriod/parseLooseDate/validDate. KEEP IN SYNC WITH
  // ai.js (resolveConfigValues) — the audit's DATE gate must read periods the same way the
  // fill engine does, but this module can't import ai.js (plain script, no exports there we
  // want to couple to). Only the parsing is copied; no resolver/config concerns leak in.
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  function validDate(y, mo, d) {
    if (mo != null && (mo < 1 || mo > 12) && d != null && d >= 1 && d <= 12) [mo, d] = [d, mo];
    if (mo != null && (mo < 1 || mo > 12)) mo = undefined;
    if (d != null && (d < 1 || d > 31)) d = undefined;
    const out = { y };
    if (mo != null) out.m = mo;
    if (mo != null && d != null) out.d = d;
    return out;
  }
  function parseLooseDate(s) {
    const t = norm(s).toLowerCase().replace(/(present|current|now|ongoing)/g, "").trim();
    if (!t) return null;
    let m;
    if ((m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/))) return validDate(+m[3], +m[1], +m[2]);
    if ((m = t.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/))) return validDate(+m[1], +m[2], +m[3]);
    if ((m = t.match(/^(\d{1,2})[/\-.](\d{4})$/))) return validDate(+m[2], +m[1], undefined);
    if ((m = t.match(/^(\d{4})[/\-.](\d{1,2})$/))) return validDate(+m[1], +m[2], undefined);
    if ((m = t.match(/^([a-z]+)\.?,? ?(\d{4})$/))) {
      const mi = MONTHS.findIndex((x) => x.startsWith(m[1].slice(0, 3)));
      if (mi >= 0) return { m: mi + 1, y: +m[2] };
    }
    if ((m = t.match(/(\d{4})/))) return { y: +m[1] };
    return null;
  }
  function splitPeriod(period) {
    const str = String(period ?? "");
    let parts = str.split(/\s+(?:[–—-]|to|until|through)\s+/i).map((x) => norm(x));
    if (parts.length === 1) {
      const yy = str.match(/^\s*(\d{4})\s*[–—-]\s*(\d{4})\s*$/);
      parts = yy ? [yy[1], yy[2]] : [str];
    }
    const isCurrent = /present|current|now|ongoing/i.test(str);
    return { start: parseLooseDate(parts[0]), end: isCurrent ? null : parseLooseDate(parts[1] || ""), isCurrent };
  }

  // ------------------------------------------------------------------ linearize / segments
  // Canonical source segments, each tagged with a provenance string used by analyzeKeywords
  // to explain WHERE a claim lives. Deterministic ordering; linearizeResume just joins the
  // segment texts so the two can never drift.
  function sourceSegments(structured) {
    const s = structured || {};
    const segs = [];
    const push = (text, prov) => { const t = norm(text); if (t) segs.push({ text: t, provenance: prov }); };
    const pi = s.personal_information || {};
    push([pi.first_name, pi.last_name].filter(Boolean).join(" "), "personal");
    const loc = pi.location || [pi.city, pi.state].filter(Boolean).join(", ");
    push([pi.email, pi.phone, loc, pi.linkedin, pi.github, pi.portfolio].filter(Boolean).join(" · "), "personal");
    for (const ed of s.education_details || []) {
      const inst = ed.institution || "";
      push([ed.education_level, ed.field_of_study, inst, ed.start_date, ed.year_of_completion, ed.final_evaluation_grade].filter(Boolean).join(" "), `education: ${inst || "?"}`);
    }
    for (const ex of s.experience_details || []) {
      const co = ex.company || "";
      const prov = `experience: ${co || "?"}`;
      push([ex.position, co, ex.employment_period, ex.location, ex.industry].filter(Boolean).join(" "), prov);
      for (const r of ex.key_responsibilities || []) push(r, prov);
      if (Array.isArray(ex.skills_acquired) && ex.skills_acquired.length) push(ex.skills_acquired.join(", "), prov);
    }
    for (const pr of s.projects || []) {
      const nm = pr.name || "";
      push([nm, pr.description, pr.link].filter(Boolean).join(" — "), `project: ${nm || "?"}`);
    }
    for (const c of s.certifications || []) {
      const nm = typeof c === "string" ? c : [c.name, c.issuer, c.date].filter(Boolean).join(" ");
      push(nm, `certification: ${(typeof c === "string" ? c : c.name) || "?"}`);
    }
    for (const l of s.languages || []) {
      const nm = typeof l === "string" ? l : [l.language, l.proficiency].filter(Boolean).join(" ");
      push(nm, "languages");
    }
    if (s.skills) push(s.skills, "skills list");
    return segs;
  }

  function linearizeResume(structured) {
    return sourceSegments(structured).map((x) => x.text).join("\n");
  }

  // ------------------------------------------------------------------ vocabulary
  // Cache compiled matchers per json object (the reference/resume-scoring.json is loaded
  // once and reused for every analyze/audit call).
  const _vocabCache = new WeakMap();

  function compileVariant(v) {
    // {match} OBJECT → CASE-SENSITIVE regex (uppercase acronyms: R, SIEM, LISP — an `i`
    // flag would make bare "R" match "toys r us").
    if (v && typeof v === "object" && typeof v.match === "string") {
      return { type: "re", re: new RegExp(v.match) };
    }
    const str = String(v);
    const singleToken = !/\s/.test(str);
    // Single short token OR one containing +/#/&/. → word-boundary regex. NEVER \b — the
    // JS \b sits between two \w, so \bC\+\+\b can never match "C++" (+ is not \w).
    if ((singleToken && str.length <= 4) || /[+#&.]/.test(str)) {
      return { type: "re", re: new RegExp("(^|\\W)" + escapeRe(str) + "($|\\W)", "i") };
    }
    return { type: "sub", lc: str.toLowerCase() };
  }

  function compileGroup(rawGroup, category) {
    const variants = Array.isArray(rawGroup) ? rawGroup : [rawGroup];
    const matchers = variants.map(compileVariant);
    // The reference extension's JSON only ships "Go." (with the dot); add a bare capitalized-Go matcher,
    // CASE-SENSITIVE so it hits "Go" the language but not "goes"/"google"/"go to".
    if (variants.some((v) => v === "Go.")) matchers.push({ type: "re", re: new RegExp("(^|\\W)Go($|\\W)") });
    // Representative for display: first STRING variant, else the regex source.
    let keyword = null;
    for (const v of variants) { if (typeof v === "string") { keyword = v; break; } }
    if (keyword == null) keyword = variants[0] && variants[0].match ? variants[0].match : String(variants[0]);
    return { category: category || null, keyword, variants, matchers };
  }

  function compileVocabulary(json) {
    if (!json) return { groups: [], json };
    const cached = _vocabCache.get(json);
    if (cached) return cached;
    const catByGroup = new Map();
    for (const [cat, groups] of Object.entries(json.resumeScoreCategories || {})) {
      for (const g of groups) catByGroup.set(JSON.stringify(g), cat);
    }
    const groups = (json.resumeScoreKeywords || []).map((g) => compileGroup(g, catByGroup.get(JSON.stringify(g))));
    const vocab = { groups, json };
    _vocabCache.set(json, vocab);
    return vocab;
  }

  // Does any variant of this compiled group match `text`?
  function groupMatches(group, text) {
    if (!text) return false;
    let lc = null;
    for (const m of group.matchers) {
      if (m.type === "sub") {
        if (lc == null) lc = text.toLowerCase();
        if (lc.includes(m.lc)) return true;
      } else if (m.re.test(text)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ keyword analysis
  function analyzeKeywords(vocab, jdText, sourceStructured, resumeText, truncated = false) {
    const jd = jdText || "";
    const pdf = resumeText || "";
    const jdRelevant = (vocab.groups || []).filter((g) => groupMatches(g, jd));
    const jdGroupCount = jdRelevant.length;

    if (jdGroupCount === 0) {
      // Sentinel: nothing in this JD maps to a scoreable keyword group. UI says so instead
      // of showing a misleading 0% or NaN.
      return { present: [], missing: { adjacent: [], absent: [] }, score: null, pdfScore: null, jdGroupCount: 0, truncated };
    }

    const segs = sourceSegments(sourceStructured);
    const structuredText = segs.map((x) => x.text).join("\n");

    const present = [];
    const adjacent = [];
    const absent = [];
    let pdfHits = 0;

    for (const g of jdRelevant) {
      const inStructured = groupMatches(g, structuredText);
      const inPdf = groupMatches(g, pdf);
      if (inPdf) pdfHits += 1;
      if (inStructured) {
        present.push({ keyword: g.keyword, category: g.category });
        if (!inPdf) {
          // ADJACENT: you verifiably have it (in the structured profile) but it's not on the
          // current PDF. Provenance = the first source segment that carries it.
          const seg = segs.find((sg) => groupMatches(g, sg.text));
          adjacent.push({ keyword: g.keyword, category: g.category, provenance: seg ? seg.provenance : "profile" });
        }
      } else if (!inPdf) {
        // Neither structured profile nor PDF — genuinely not in your background. No
        // token-similarity "related" tier: related-but-unclaimed stays absent.
        absent.push({ keyword: g.keyword, category: g.category });
      }
      // (inPdf && !inStructured) → on the PDF but not the structured profile: counts toward
      // pdfScore, not a "missing" bucket.
    }

    return {
      present,
      missing: { adjacent, absent },
      score: present.length / jdGroupCount,
      pdfScore: pdfHits / jdGroupCount,
      jdGroupCount,
      truncated: !!truncated,
    };
  }

  // ------------------------------------------------------------------ word diff (LCS)
  const tokenizeWords = (s) => normBullet(s).split(/(\s+)/).filter((t) => t.length && !/^\s+$/.test(t));

  function diffWords(a, b) {
    const A = tokenizeWords(a);
    const B = tokenizeWords(b);
    const n = A.length, m = B.length;
    // LCS DP.
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    const pushOp = (op, text) => {
      const last = ops[ops.length - 1];
      if (last && last.op === op) last.text += " " + text;
      else ops.push({ op, text });
    };
    while (i < n && j < m) {
      if (A[i] === B[j]) { pushOp("eq", A[i]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { pushOp("del", A[i]); i++; }
      else { pushOp("add", B[j]); j++; }
    }
    while (i < n) { pushOp("del", A[i]); i++; }
    while (j < m) { pushOp("add", B[j]); j++; }
    return ops;
  }

  // ------------------------------------------------------------------ resume diff
  const sim = (a, b) => {
    const ta = new Set(fold(a).split(" ").filter(Boolean));
    const tb = new Set(fold(b).split(" ").filter(Boolean));
    if (!ta.size && !tb.size) return 1;
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter += 1;
    return inter / (ta.size + tb.size - inter);
  };
  const mkRow = (kind, before, after) => ({
    kind, before: before == null ? null : before, after: after == null ? null : after,
    diffOps: diffWords(before || "", after || ""), flags: [],
  });

  // Pair bullets within one matched item: validated changes first, then exact equals, then
  // greedy similarity with a deterministic tie-break (similarity, then source order).
  function pairBullets(srcB, tailB, changes) {
    const rows = [];
    const usedS = new Set(), usedT = new Set();
    const findS = (before) => srcB.findIndex((b, i) => !usedS.has(i) && normEq(b, before));
    const findT = (after) => tailB.findIndex((b, i) => !usedT.has(i) && normEq(b, after));

    for (const c of changes || []) {
      // ai.js emits `kind` (rephrase|reorder|add|remove); older callers/tests use `op`
      // (rephrase|add|del). Normalize both, and fold remove→del.
      let op = c && (c.op || c.kind);
      if (op === "remove") op = "del";
      if (op === "rephrase") {
        if (c.before == null || c.after == null) continue;
        const si = findS(c.before), ti = findT(c.after);
        if (si >= 0 && ti >= 0) { usedS.add(si); usedT.add(ti); rows.push(mkRow("rephrase", srcB[si], tailB[ti])); }
      } else if (op === "add") {
        if (c.after == null) continue;
        const ti = findT(c.after);
        if (ti >= 0) { usedT.add(ti); rows.push(mkRow("add", null, tailB[ti])); }
      } else if (op === "del") {
        if (c.before == null) continue;
        const si = findS(c.before);
        if (si >= 0) { usedS.add(si); rows.push(mkRow("del", srcB[si], null)); }
      }
    }
    // Exact-equal leftovers → unchanged.
    for (let i = 0; i < srcB.length; i++) {
      if (usedS.has(i)) continue;
      const j = findT(srcB[i]);
      if (j >= 0) { usedS.add(i); usedT.add(j); rows.push(mkRow("eq", srcB[i], tailB[j])); }
    }
    // Greedy similarity for the rest.
    const remS = srcB.map((_, i) => i).filter((i) => !usedS.has(i));
    const remT = tailB.map((_, j) => j).filter((j) => !usedT.has(j));
    const pairs = [];
    for (const i of remS) for (const j of remT) pairs.push([sim(srcB[i], tailB[j]), i, j]);
    pairs.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
    for (const [score, i, j] of pairs) {
      if (score <= 0) break;
      if (usedS.has(i) || usedT.has(j)) continue;
      usedS.add(i); usedT.add(j);
      rows.push(mkRow("rephrase", srcB[i], tailB[j]));
    }
    for (const i of remS) if (!usedS.has(i)) rows.push(mkRow("del", srcB[i], null));
    for (const j of remT) if (!usedT.has(j)) rows.push(mkRow("add", null, tailB[j]));
    return rows;
  }

  const expKey = (it) => `${fold(it.company)}|${fold(it.position)}`;
  const eduKey = (it) => `${fold(it.institution)}|${degreeCanonical(it.education_level)}`;

  // Pair items by normalized identity (company+position / institution+degree), NEVER raw
  // array position — a reordered tailored list must not cascade-mismatch every row.
  function buildResumeDiff(source, tailored, changes) {
    const chg = changes || [];
    const sectionDefs = [
      { section: "experience", src: source?.experience_details || [], tail: tailored?.experience_details || [], key: expKey, header: (it) => ({ company: it.company || "", position: it.position || "" }) },
      { section: "education", src: source?.education_details || [], tail: tailored?.education_details || [], key: eduKey, header: (it) => ({ institution: it.institution || "", education_level: it.education_level || "" }) },
    ];
    const sections = [];
    for (const def of sectionDefs) {
      const usedT = new Set();
      const items = [];
      // Loop-invariant: the changes relevant to THIS section are the same for every item in
      // it, so filter once. ai.js tags changes with the schema section ("experience_details");
      // the diff uses the short name ("experience"). Accept either (or an untagged change).
      const sectionChanges = chg.filter((c) => c.section == null || String(c.section).replace(/_details$/, "") === def.section);
      for (let i = 0; i < def.src.length; i++) {
        const srcItem = def.src[i];
        const k = def.key(srcItem);
        let ti = def.tail.findIndex((t, idx) => !usedT.has(idx) && def.key(t) === k);
        // Fall back to an explicit change-provided sourceIndex→tailoredIndex hint.
        if (ti < 0) {
          const hint = chg.find((c) => c.section === def.section && c.sourceIndex === i && typeof c.tailoredIndex === "number");
          if (hint && !usedT.has(hint.tailoredIndex)) ti = hint.tailoredIndex;
        }
        const tailItem = ti >= 0 ? def.tail[ti] : null;
        if (ti >= 0) usedT.add(ti);
        const rows = pairBullets(srcItem.key_responsibilities || [], (tailItem && tailItem.key_responsibilities) || [], sectionChanges);
        items.push({ sourceIndex: i, before: def.header(srcItem), after: tailItem ? def.header(tailItem) : null, matched: ti >= 0, rows });
      }
      // Tailored items with no source partner (net-new items surface as additions).
      def.tail.forEach((t, idx) => {
        if (usedT.has(idx)) return;
        items.push({ sourceIndex: -1, before: null, after: def.header(t), matched: false, rows: (t.key_responsibilities || []).map((b) => mkRow("add", null, b)) });
      });
      sections.push({ section: def.section, items });
    }
    return { sections };
  }

  // ------------------------------------------------------------------ audit (fabrication)
  const SCOPE_WORDS = ["intern", "junior", "associate", "co-op", "trainee", "senior", "staff", "lead", "principal", "head", "director"];
  const INFLATION_VERBS = ["led", "spearheaded", "architected", "managed", "owned"];
  const DIGITLESS_METRICS = ["doubled", "tripled", "halved", "x-fold", "millions", "billions"];
  const WORD_NUMBERS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    hundred: 100, thousand: 1000, million: 1e6, billion: 1e9,
    dozen: 12, double: 2, twice: 2, triple: 3, quadruple: 4, half: 0.5,
  };
  // Fraction NOUNS ("increased by a THIRD", "cut latency in HALF"). Scanned on the tailored
  // side so a word-fraction magnitude must be grounded in the source just like a digit is.
  const FRACTION_WORDS = {
    half: 1 / 2, halves: 1 / 2, third: 1 / 3, thirds: 1 / 3, quarter: 1 / 4, quarters: 1 / 4,
    fourth: 1 / 4, fourths: 1 / 4, fifth: 1 / 5, fifths: 1 / 5, sixth: 1 / 6, seventh: 1 / 7,
    eighth: 1 / 8, ninth: 1 / 9, tenth: 1 / 10,
  };
  // Word-numbers, word-fractions, and \w+-fold multipliers → the set of numeric magnitudes
  // a piece of prose asserts WITHOUT digits. Used symmetrically: to build the source
  // numeric whitelist and to scan the tailored side (bypass: the numeric gate previously
  // only whitelisted source word-numbers and never scanned the tailored side for them, so
  // "mentored fifty engineers" / "by a third" / "tenfold" walked straight through).
  function wordishMagnitudes(text) {
    const out = []; // [{ value, surface }]
    const low = String(text || "").normalize("NFKC").toLowerCase();
    let m;
    // multipliers: "tenfold", "two-fold" (base word-number × implicit "-fold")
    const foldRe = /\b([a-z]+)-?fold\b/g;
    while ((m = foldRe.exec(low)) !== null) { const n = WORD_NUMBERS[m[1]]; if (n != null) out.push({ value: n, surface: m[0] }); }
    // fractions: "(a|one|two|three|four|five) <fraction-noun>"
    const fracRe = /\b(a|one|two|three|four|five)\s+([a-z]+)\b/g;
    while ((m = fracRe.exec(low)) !== null) {
      const f = FRACTION_WORDS[m[2]];
      if (f != null) { const num = m[1] === "a" ? 1 : (WORD_NUMBERS[m[1]] ?? 1); out.push({ value: num * f, surface: m[0] }); }
    }
    // standalone word-numbers
    for (const t of low.split(/[^a-z]+/)) if (t && Object.prototype.hasOwnProperty.call(WORD_NUMBERS, t)) out.push({ value: WORD_NUMBERS[t], surface: t });
    return out;
  }
  const DEGREE_MAP = [
    [/^(b\.?s\.?c?|b\.?a|bachelors?|bachelorofscience|bachelorofarts|bachelor)$/, "bachelor"],
    [/^(m\.?s\.?c?|m\.?a|masters?|masterofscience|masterofarts|mba|master)$/, "master"],
    [/^(ph\.?d|doctorate|doctorofphilosophy|doctoral|doctor)$/, "phd"],
  ];
  function degreeCanonical(s) {
    const t = String(s || "").toLowerCase().replace(/[^a-z]/g, "");
    for (const [re, canon] of DEGREE_MAP) if (re.test(t)) return canon;
    return t;
  }
  const scopeSet = (title) => {
    const ft = " " + fold(title) + " ";
    const out = new Set();
    for (const w of SCOPE_WORDS) if (ft.includes(" " + fold(w) + " ")) out.add(w);
    return out;
  };

  // Numeric token → {value (magnitude for the RED test), repr (surface form for the YELLOW
  // "same value, different representation" test)}.
  const NUM_RE = /(\d[\d,]*(?:\.\d+)?)(\s*[%kKxX+])?/g;
  function numFacts(token, suffixRaw) {
    const base = parseFloat(String(token).replace(/,/g, ""));
    const suf = (suffixRaw || "").trim().toLowerCase();
    let value = base;
    if (suf === "k") value = base * 1000;
    const repr = (String(token).replace(/[,\s]/g, "") + suf).toLowerCase();
    return { value, repr };
  }
  function collectNums(text) {
    const values = new Set();
    const reprs = new Set();
    let m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(text)) !== null) {
      const f = numFacts(m[1], m[2]);
      values.add(f.value); reprs.add(f.repr);
    }
    return { values, reprs };
  }

  // Skill list = the comma-joined skills string plus every skills_acquired[] entry.
  function skillList(structured) {
    const out = [];
    const raw = structured?.skills;
    if (typeof raw === "string") for (const s of raw.split(",")) { const t = norm(s); if (t) out.push(t); }
    else if (Array.isArray(raw)) for (const s of raw) { const t = norm(s); if (t) out.push(t); }
    for (const ex of structured?.experience_details || []) for (const s of ex.skills_acquired || []) { const t = norm(s); if (t) out.push(t); }
    return out;
  }
  // Bullet + project prose — the shared spine of claimText and numericScanText. claimText
  // additionally folds in certifications; the NUMERIC gate deliberately does NOT (a cert's
  // issue date is not a fabricated metric).
  function bulletProjectParts(structured) {
    const parts = [];
    for (const ex of structured?.experience_details || []) for (const r of ex.key_responsibilities || []) parts.push(norm(r));
    for (const pr of structured?.projects || []) { parts.push(norm(pr.name)); parts.push(norm(pr.description)); }
    return parts;
  }
  // Free text where a fabricated CLAIM would live (bullets, project & cert prose) — excludes
  // the skills list (handled with rename tolerance) and identity/date fields.
  function claimText(structured) {
    const parts = bulletProjectParts(structured);
    for (const c of structured?.certifications || []) parts.push(typeof c === "string" ? norm(c) : norm([c.name, c.issuer].filter(Boolean).join(" ")));
    return parts.filter(Boolean).join("\n");
  }
  // Just the metric-bearing prose (bullets + project descriptions) for the NUMERIC gate;
  // deliberately excludes employment periods, personal_information numbers, and cert dates.
  function numericScanText(structured) {
    return bulletProjectParts(structured).filter(Boolean).join("\n");
  }
  const containsTol = (a, b) => {
    const x = fold(a).replace(/\s+/g, "").replace(/s$/, "");
    const y = fold(b).replace(/\s+/g, "").replace(/s$/, "");
    return !!x && !!y && (x.includes(y) || y.includes(x));
  };

  // ---- vocab-INDEPENDENT distinctive-claim-token grounding ------------------------------
  // The vocab gate only sees the 1454 scoring keywords; a fabricated proper noun / acronym /
  // credential that isn't a scoring keyword ("HIPAA", "FedRAMP", "Top Secret clearance") is
  // invisible to it. This structural gate flags any DISTINCTIVE claim token in tailored
  // `after` text that is not grounded in the source. Cry-wolf control: only proper nouns
  // (capitalized, mid-sentence, not a common word), acronyms, and digit+letter identifiers
  // qualify — common English verbs/adjectives a rephrase introduces never do.
  const CLAIM_STOP = new Set([
    "the", "a", "an", "and", "or", "but", "for", "to", "of", "in", "on", "at", "by", "with",
    "from", "as", "into", "over", "per", "via", "using", "used", "use", "new", "existing",
    "other", "all", "both", "each", "more", "most", "less", "many", "few", "several",
    "i", "we", "our", "my", "us", "it", "its", "their", "this", "that", "these", "those",
    "was", "were", "is", "are", "be", "been", "led", "built", "grew", "drove",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
  ]);
  const stripEdges = (t) => String(t).replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
  // A token worth grounding: acronym (2+ consecutive caps: HIPAA/AWS/FedRAMP), digit+letter
  // identifier (K8s/S3/EC2), or a capitalized proper noun that is NOT sentence-initial.
  function isDistinctiveClaim(rawTok, sentenceInitial) {
    const tok = stripEdges(rawTok);
    if (tok.length < 2) return false;
    if (/[A-Z]{2,}/.test(tok)) return true;
    const hasLetter = /[A-Za-z]/.test(tok), hasDigit = /[0-9]/.test(tok);
    if (hasLetter && hasDigit) return true;
    if (!sentenceInitial && /^[A-Z]/.test(tok) && hasLetter && !hasDigit && !CLAIM_STOP.has(tok.toLowerCase())) return true;
    return false;
  }
  // Distinctive claim tokens of a piece of text, with sentence-initial suppression (the
  // leading Capitalized word of a sentence is grammar, not a claim).
  function distinctiveClaimTokens(text) {
    const out = [];
    let atStart = true;
    for (const w of String(text || "").split(/\s+/)) {
      if (!w) continue;
      if (isDistinctiveClaim(w, atStart)) out.push(stripEdges(w));
      atStart = /[.!?]$/.test(w); // next word begins a new sentence
    }
    return out;
  }
  // Grounder over a folded corpus: a claim token is grounded if its alnum form equals,
  // prefixes, or is prefixed by a source token (trailing-s tolerant). Prefix tolerance is
  // what lets "Node.js" ground against source "Node" without a bare "R"→"React" over-ground
  // (min length 3 guards short tokens).
  function makeGrounder(groundFolded) {
    const toks = [];
    const set = new Set();
    for (const t of String(groundFolded).split(" ")) {
      if (!t) continue;
      const s = t.replace(/s$/, "");
      if (!set.has(s)) { set.add(s); toks.push(s); }
    }
    return (rawTok) => {
      const xs = fold(rawTok).replace(/\s+/g, "").replace(/s$/, "");
      if (!xs) return true;
      if (set.has(xs)) return true;
      for (const c of toks) {
        if (c.length >= 3 && xs.startsWith(c)) return true;               // "nodejs" ⊃ "node"
        if (xs.length >= 3 && c.startsWith(xs)) return true;              // "react"  ⊂ "reactjs"
      }
      return false;
    };
  }

  function auditTailored(source, tailored, changes, vocab) {
    const flags = [];
    const red = (gate, message, extra = {}) => flags.push({ severity: "red", gate, message, ...extra });
    const yellow = (gate, message, extra = {}) => flags.push({ severity: "yellow", gate, message, ...extra });
    const src = source || {};
    const tl = tailored || {};
    // Source corpus = canonical CV render ∪ the pasted resume_text (the "resumeText" of the
    // audit; analyzeKeywords takes the PDF text separately, the audit uses the profile's).
    const sourceCorpus = linearizeResume(src) + "\n" + (src.resume_text || "");

    // ---- Gate 1: IDENTITY belt + scope words --------------------------------------------
    const spi = src.personal_information || {}, tpi = tl.personal_information || {};
    for (const k of new Set([...Object.keys(spi), ...Object.keys(tpi)])) {
      if (norm(spi[k]) !== norm(tpi[k])) red("identity", `personal_information.${k} changed`, { section: "personal_information", field: k, detail: `${norm(spi[k])} → ${norm(tpi[k])}` });
    }
    const sExp = src.experience_details || [], tExp = tl.experience_details || [];
    // Reordering is an ALLOWED tailor op: ai.js sanitizeTailored stamps every tailored item
    // with the 0-based `sourceIndex` of the source row it came from. Pair source→tailored by
    // that, NOT by array position — otherwise a pure reorder reads as a wall of false
    // identity/scope/date changes. Falls back to positional when no sourceIndex is present
    // (e.g. hand-written unit fixtures that never reorder).
    const pairBySourceIndex = (tailArr) => {
      const m = new Map();
      for (const it of tailArr || []) {
        const si = Number(it && it.sourceIndex);
        if (Number.isInteger(si) && !m.has(si)) m.set(si, it);
      }
      return m;
    };
    const expPair = pairBySourceIndex(tExp);
    const expPartner = (i) => (expPair.size ? expPair.get(i) : tExp[i]);
    for (let i = 0; i < sExp.length; i++) {
      const a = sExp[i], b = expPartner(i);
      if (!a || !b) continue;
      for (const f of ["company", "position", "location"]) {
        if (norm(a[f]) !== norm(b[f])) red("identity", `experience[${i}].${f} changed`, { section: "experience", field: f, detail: `${norm(a[f])} → ${norm(b[f])}` });
      }
      const sa = scopeSet(a.position), sb = scopeSet(b.position);
      for (const w of new Set([...sa, ...sb])) {
        if (sa.has(w) !== sb.has(w)) red("scope", `title scope word "${w}" ${sb.has(w) ? "added to" : "removed from"} experience[${i}]`, { section: "experience", field: "position", detail: b.position });
      }
    }
    const sEdu = src.education_details || [], tEdu = tl.education_details || [];
    const eduPair = pairBySourceIndex(tEdu);
    const eduPartner = (i) => (eduPair.size ? eduPair.get(i) : tEdu[i]);
    for (let i = 0; i < sEdu.length; i++) {
      const a = sEdu[i], b = eduPartner(i);
      if (!a || !b) continue;
      if (norm(a.institution) !== norm(b.institution)) red("identity", `education[${i}].institution changed`, { section: "education", field: "institution" });
      if (degreeCanonical(a.education_level) !== degreeCanonical(b.education_level)) red("identity", `education[${i}].education_level changed`, { section: "education", field: "education_level", detail: `${norm(a.education_level)} → ${norm(b.education_level)}` });
    }

    // ---- Gate 2: NEW-SKILL / TOOL claim -------------------------------------------------
    const claims = claimText(tl);
    const claimTokens = claims.split(/\s+/).filter(Boolean);
    const tSkills = skillList(tl);
    const sSkills = skillList(src);
    const corpusGrounder = makeGrounder(fold(sourceCorpus));
    for (const g of vocab?.groups || []) {
      const inClaims = groupMatches(g, claims);
      const inTSkills = tSkills.some((s) => groupMatches(g, s));
      if (!inClaims && !inTSkills) continue;
      if (groupMatches(g, sourceCorpus)) continue; // grounded in the source
      if (inClaims) {
        // Rename tolerance (mirror the skills branch): a vocab group can fire on a PARTIAL
        // token — "Node.js" trips the JavaScript group via ".js" — so if every claims token
        // that triggered the group is itself grounded in the source by prefix/containment
        // (e.g. "Node.js" ⊃ source "Node"), it's a rename, not a fabricated skill.
        const hits = claimTokens.filter((tk) => groupMatches(g, tk));
        if (hits.length && hits.every((tk) => corpusGrounder(tk))) continue;
        red("new-skill", `tailored résumé claims "${g.keyword}" — absent from your source profile`, { section: "experience", field: "key_responsibilities", detail: g.keyword }); continue;
      }
      // Skills-list only: tolerate renames (Node→Node.js, containment either direction with
      // trailing-s tolerance, or same vocab group as an existing source skill).
      const skill = tSkills.find((s) => groupMatches(g, s)) || "";
      const grounded = sSkills.some((ss) => containsTol(ss, skill)) || sSkills.some((ss) => groupMatches(g, ss));
      if (!grounded) red("new-skill", `skills list adds "${g.keyword}" — absent from your source profile`, { section: "skills", field: "skills", detail: g.keyword });
    }

    // ---- Gate 3: NUMERIC ----------------------------------------------------------------
    // Source whitelist is built from the METRIC-BEARING prose ONLY (bullets + project
    // descriptions), never the whole corpus — else phone digits, GPA, and employment/
    // education YEARS pollute it and a fabricated metric that happens to collide with one
    // (e.g. "100 tickets" ⊂ a phone number, "2021 jobs" ⊂ an employment year) sails through.
    const srcScan = numericScanText(src).normalize("NFKC");
    const srcNums = collectNums(srcScan);
    for (const { value } of wordishMagnitudes(srcScan)) srcNums.values.add(value);
    const foldedCorpus = fold(sourceCorpus);
    // NFKC-fold the tailored side so fullwidth / non-ASCII digits ("３０％") can't evade \d.
    const scan = numericScanText(tl).normalize("NFKC");
    let mm;
    NUM_RE.lastIndex = 0;
    while ((mm = NUM_RE.exec(scan)) !== null) {
      const f = numFacts(mm[1], mm[2]);
      if (!srcNums.values.has(f.value)) red("numeric", `metric "${mm[0].trim()}" has no basis in your source profile`, { section: "experience", field: "key_responsibilities", detail: mm[0].trim() });
      else if (!srcNums.reprs.has(f.repr)) yellow("numeric", `metric "${mm[0].trim()}" restates a source number in a different form`, { section: "experience", field: "key_responsibilities", detail: mm[0].trim() });
    }
    // Word-numbers, word-fractions, and \w+-fold multipliers on the TAILORED side must be
    // grounded just like digits ("mentored fifty engineers", "increased by a third",
    // "improved throughput tenfold" all previously walked through the digit-only scan).
    for (const { value, surface } of wordishMagnitudes(scan)) {
      if (!srcNums.values.has(value)) red("numeric", `word-magnitude "${surface}" has no basis in your source profile`, { section: "experience", field: "key_responsibilities", detail: surface });
    }
    const foldedScan = fold(scan);
    for (const term of DIGITLESS_METRICS) {
      const ft = fold(term);
      if ((" " + foldedScan + " ").includes(" " + ft + " ") && !(" " + foldedCorpus + " ").includes(" " + ft + " ")) red("numeric", `claim "${term}" has no basis in your source profile`, { section: "experience", field: "key_responsibilities", detail: term });
    }

    // ---- Gate 4: DATES ------------------------------------------------------------------
    const samePart = (a, b) => (a == null || b == null) ? true : a === b;
    const cmpDate = (a, b, invented) => {
      if (!a && !b) return true;
      if (!a || !b) return false;
      // Year change → mismatch. Month change → mismatch. Invented month (tailored has one
      // the source lacked) → mismatch when `invented` guards it.
      if (a.y != null && b.y != null && a.y !== b.y) return false;
      if (a.m != null && b.m != null && a.m !== b.m) return false;
      if (invented && b.m != null && a.m == null) return false;
      return samePart(a.y, b.y);
    };
    const cmpPeriod = (as, bs, ctx) => {
      const a = splitPeriod(as), b = splitPeriod(bs);
      if (a.isCurrent !== b.isCurrent) return red("date", `${ctx} current-status changed`, { detail: `${norm(as)} → ${norm(bs)}` });
      if (!cmpDate(a.start, b.start, true)) return red("date", `${ctx} start date changed`, { detail: `${norm(as)} → ${norm(bs)}` });
      if (!cmpDate(a.end, b.end, true)) return red("date", `${ctx} end date changed`, { detail: `${norm(as)} → ${norm(bs)}` });
    };
    for (let i = 0; i < sExp.length; i++) { const b = expPartner(i); if (sExp[i] && b) cmpPeriod(sExp[i].employment_period, b.employment_period, `experience[${i}]`); }
    for (let i = 0; i < sEdu.length; i++) {
      const tb = eduPartner(i);
      if (!sEdu[i] || !tb) continue;
      const a = { start: parseLooseDate(sEdu[i].start_date), end: parseLooseDate(sEdu[i].year_of_completion) };
      const b = { start: parseLooseDate(tb.start_date), end: parseLooseDate(tb.year_of_completion) };
      if (!cmpDate(a.start, b.start, true)) red("date", `education[${i}] start date changed`, { detail: `${norm(sEdu[i].start_date)} → ${norm(tb.start_date)}` });
      if (!cmpDate(a.end, b.end, true)) red("date", `education[${i}] completion date changed`, { detail: `${norm(sEdu[i].year_of_completion)} → ${norm(tb.year_of_completion)}` });
    }

    // ---- Gate 5: SOURCE-TAG -------------------------------------------------------------
    for (const c of changes || []) {
      const op = c.op || c.kind; // ai.js emits `kind`; older callers/tests use `op`
      if (op !== "add" && op !== "rephrase") continue;
      const tagResolves = c.source && normContains(sourceCorpus, c.source);
      if (tagResolves) continue;
      if (op === "add") red("source-tag", `added bullet has no resolvable source tag`, { section: c.section, detail: norm(c.after) });
      else if (c.before && normContains(sourceCorpus, c.before)) yellow("source-tag", `rephrase lacks a source tag but its original bullet is grounded`, { section: c.section, detail: norm(c.after) });
      else red("source-tag", `rephrase resolves to no source bullet`, { section: c.section, detail: norm(c.after) });
    }

    // ---- Gate 5b: DISTINCTIVE-CLAIM GROUNDING (vocab-INDEPENDENT) ------------------------
    // The source-tag gate only checks the change.source STRING resolves — NOT that `after`
    // is actually supported by it — and the skill gate only sees scoring keywords. So an
    // added/rephrased bullet can smuggle a fabricated proper noun / acronym / credential
    // (clearance, "FedRAMP", "HIPAA") past both. Here every distinctive claim token of the
    // NOVEL text of `after` must be grounded: in the source corpus, in the change's own
    // `before` (rephrase), or in a VERBATIM source tag that itself resolves in the corpus.
    for (const c of changes || []) {
      const op = c.op || c.kind;
      if (op !== "add" && op !== "rephrase") continue;
      const after = c.after;
      if (!after) continue;
      const toks = distinctiveClaimTokens(after);
      if (!toks.length) continue;
      const srcTagOk = c.source && normContains(sourceCorpus, c.source);
      const grounded = makeGrounder(fold(sourceCorpus + " " + (c.before || "") + " " + (srcTagOk ? c.source : "")));
      for (const tk of toks) {
        if (!grounded(tk)) red("grounding", `tailored text claims "${tk}" with no basis in your source profile`, { section: c.section, field: "key_responsibilities", detail: norm(after) });
      }
    }

    // ---- Gate 6: DUPLICATE-SOURCE + UNATTRIBUTED / CROSS-ITEM ----------------------------
    // Duplicate sourceIndex → the same source row emitted twice (masks a borrow, and only
    // the first copy is identity-audited). sanitizeTailored drops the second in production;
    // flag it here too for hand-built inputs.
    const seenSi = new Set();
    for (const it of tExp) {
      const si = Number(it && it.sourceIndex);
      if (!Number.isInteger(si)) continue;
      if (seenSi.has(si)) red("duplicate-source", `experience sourceIndex ${si} emitted more than once`, { section: "experience", detail: `sourceIndex ${si}` });
      else seenSi.add(si);
    }
    const allSrcBullets = [];
    for (const ex of sExp) for (const r of ex.key_responsibilities || []) allSrcBullets.push(r);
    const coveredAfter = (changes || []).filter((c) => { const op = c.op || c.kind; return op === "add" || op === "rephrase"; }).map((c) => c.after).filter(Boolean);
    for (const ex of tExp) {
      // Validate each tailored bullet against ITS OWN source item (by sourceIndex) — NOT the
      // whole corpus — so a REAL bullet from job A re-attached under job B's (higher-status)
      // identity is caught as a cross-item borrow. Fall back to whole-corpus only when no
      // sourceIndex is present (hand-written fixtures that never reorder).
      const si = Number.isInteger(Number(ex && ex.sourceIndex)) ? Number(ex.sourceIndex) : null;
      const ownSrc = si != null && sExp[si] ? sExp[si] : null;
      const ownBullets = ownSrc ? (ownSrc.key_responsibilities || []) : allSrcBullets;
      for (const tb of ex.key_responsibilities || []) {
        if (coveredAfter.some((af) => normEq(af, tb))) continue;         // covered by a grounded change
        if (ownBullets.some((sb) => normEq(sb, tb))) continue;          // unchanged copy within its own item
        red("unattributed", ownSrc ? `tailored bullet matches no bullet in its own source item (cross-item borrow or invented)` : `tailored bullet has no covering change and matches no source bullet`, { section: "experience", detail: norm(tb) });
      }
    }

    // ---- Gate 7: VERB-INFLATION ---------------------------------------------------------
    for (const c of changes || []) {
      const op = c.op || c.kind; // ai.js emits `kind`; older callers/tests use `op`
      if (op !== "rephrase" || c.before == null || c.after == null) continue;
      const fb = " " + fold(c.before) + " ", fa = " " + fold(c.after) + " ";
      for (const v of INFLATION_VERBS) {
        const fv = " " + v + " ";
        if (fa.includes(fv) && !fb.includes(fv)) yellow("verb-inflation", `rephrase introduces "${v}" — verify it reflects your actual role`, { section: c.section, detail: norm(c.after) });
      }
    }

    // ---- Gate 8: LEGAL sections in the tailor path --------------------------------------
    const nonEmpty = (o) => o && typeof o === "object" && Object.values(o).some((v) => norm(v));
    if (nonEmpty(tl.legal_authorization)) red("legal", `legal_authorization must never enter the tailor path`, { section: "legal_authorization" });
    if (nonEmpty(tl.self_identification)) red("legal", `self_identification must never enter the tailor path`, { section: "self_identification" });

    return { flags };
  }

  // ------------------------------------------------------------------ pdfmake doc def
  // Single-column ATS-friendly template. Header renders an ALLOWLIST of personal fields
  // ONLY — never date_of_birth or street address. Text-based (no images) → ATS-parseable.
  function buildDocDefinition(tailored) {
    const t = tailored || {};
    const pi = t.personal_information || {};
    const name = [pi.first_name, pi.last_name].filter(Boolean).join(" ");
    const location = pi.location || [pi.city, pi.state].filter(Boolean).join(", ");
    // Allowlist ONLY — date_of_birth and address are deliberately excluded.
    const contact = [pi.email, pi.phone, location, pi.linkedin, pi.github, pi.portfolio].filter(Boolean);
    const content = [
      { text: name, style: "name" },
      { text: contact.join("   |   "), style: "contact" },
    ];
    const heading = (txt) => content.push({ text: txt.toUpperCase(), style: "heading" });
    const bullets = (arr) => (arr || []).filter(Boolean).map((b) => ({ text: normBullet(b), style: "bullet" }));

    if ((t.experience_details || []).length) {
      heading("Experience");
      for (const ex of t.experience_details) {
        content.push({
          unbreakable: true, // keep a role's header with its first bullets where possible
          stack: [
            { text: [ex.company, ex.position, ex.employment_period].filter(Boolean).join(" — "), style: "role" },
            { ul: bullets(ex.key_responsibilities), style: "bulletList" },
          ],
        });
      }
    }
    if ((t.education_details || []).length) {
      heading("Education");
      for (const ed of t.education_details) {
        content.push({ text: [ed.institution, [ed.education_level, ed.field_of_study].filter(Boolean).join(", "), [ed.start_date, ed.year_of_completion].filter(Boolean).join("–")].filter(Boolean).join(" — "), style: "role" });
      }
    }
    if ((t.projects || []).length) {
      heading("Projects");
      for (const pr of t.projects) content.push({ unbreakable: true, stack: [{ text: pr.name || "", style: "role" }, { text: normBullet(pr.description || ""), style: "bullet" }] });
    }
    if ((t.certifications || []).length) {
      heading("Certifications");
      content.push({ ul: (t.certifications).map((c) => (typeof c === "string" ? c : [c.name, c.issuer, c.date].filter(Boolean).join(", "))).filter(Boolean) });
    }
    if (t.skills) { heading("Skills"); content.push({ text: typeof t.skills === "string" ? t.skills : (Array.isArray(t.skills) ? t.skills.join(", ") : ""), style: "bullet" }); }
    if ((t.languages || []).length) {
      heading("Languages");
      content.push({ text: (t.languages).map((l) => (typeof l === "string" ? l : [l.language, l.proficiency].filter(Boolean).join(" — "))).filter(Boolean).join("   ·   "), style: "bullet" });
    }

    return {
      content,
      pageSize: "LETTER",
      pageMargins: [48, 44, 48, 44],
      defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.15 },
      styles: {
        name: { fontSize: 20, bold: true, margin: [0, 0, 0, 2] },
        contact: { fontSize: 9, color: "#555555", margin: [0, 0, 0, 6] },
        heading: { fontSize: 12, bold: true, margin: [0, 10, 0, 3] },
        role: { fontSize: 10.5, bold: true, margin: [0, 5, 0, 1] },
        bullet: { fontSize: 10, margin: [0, 0, 0, 2] },
        bulletList: { margin: [0, 0, 0, 3] },
      },
    };
  }

  // ------------------------------------------------------------------ upload selection
  // Return the résumé bytes to upload for THIS job — never cross-job. The tailored PDF is
  // used only once it's been human-approved (approvedAt); otherwise the original CV.
  function pickUploadResume(jobKey, tailoredStore, resumeFile) {
    const rec = jobKey && tailoredStore ? tailoredStore[jobKey] : null;
    if (rec && rec.approvedAt) return { name: rec.pdfName, type: "application/pdf", b64: rec.pdfB64 };
    return resumeFile || null;
  }

  // ------------------------------------------------------------------ filename
  const LEGAL_SUFFIXES = new Set(["inc", "llc", "ltd", "corp", "co", "gmbh"]);
  const capWord = (w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : "");
  // camelJoin("Naman", true) → "naman"; ("Van Der Berg", false) → "VanDerBerg".
  function camelJoin(str, firstLower) {
    const words = String(str || "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean).map(capWord);
    let out = words.join("");
    if (firstLower && out) out = out[0].toLowerCase() + out.slice(1);
    return out;
  }
  function tailoredPdfName(personal_information, company) {
    const pi = personal_information || {};
    const namePart = camelJoin(pi.first_name, true) + camelJoin(pi.last_name, false);
    // Strip trailing legal suffixes (Inc, LLC, …), then CamelCase the remaining words.
    const words = String(company || "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
    while (words.length && LEGAL_SUFFIXES.has(words[words.length - 1].toLowerCase())) words.pop();
    const companyPart = words.map(capWord).join("");
    let stem = (namePart + companyPart).slice(0, 80); // length-cap
    if (!stem) stem = "Resume";
    return `${stem} CV.pdf`;
  }

  return {
    linearizeResume, sourceSegments,
    compileVocabulary, groupMatches, analyzeKeywords,
    diffWords, buildResumeDiff, auditTailored,
    buildDocDefinition, pickUploadResume, tailoredPdfName,
    // exposed for tests / sibling modules
    splitPeriod, parseLooseDate, degreeCanonical,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = JA_TAILOR;
