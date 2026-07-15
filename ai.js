// jobApplier AI layer. These are the "server routes" as internal functions (docs/03):
// direct OpenRouter fetches from the sidepanel, request/stream shape copied from
// ../accountabilitymachine. Loaded as a plain script; exposes the JA_AI global.
"use strict";

const JA_AI = (() => {
  const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
  const DEFAULT_MODEL = "z-ai/glm-5.2";
  const STREAM_IDLE_MS = 45000;

  const norm = (s) => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  // Keep in sync with fold() in content-ats.js — same labelContains semantics,
  // duplicated on purpose across the two isolated JS contexts (no build step).
  const fold = (s) => norm(s).toLowerCase().replace(/[/:_\-,.;()?!*&'"’]+/g, " ").replace(/\s+/g, " ").trim();

  // ------------------------------------------------------------------ LEGAL_FIELDS guard
  // Non-negotiable rule #1: these answers come verbatim from the profile, never the LLM.
  // Over-matching is safe (field falls back to deterministic/manual); under-matching is not.
  const LEGAL_PATTERNS = [
    /work\s*authori[sz]/i, /authori[sz]ed\s+to\s+work/i, /legally\s+(authori[sz]ed|able|allowed|eligible)/i,
    /eligib(le|ility)\s+to\s+work/i, /work\s+eligib/i,
    /right\s+to\s+work/i, /work\s+permit/i, /citizen/i, /green\s*card/i, /permanent\s+resident/i,
    /immigration/i, /visa/i, /sponsor/i, /national\s+origin/i, /nationality/i,
    /security\s+clearance/i, /\bclearance\b/i, /crimin/i, /felony/i, /convict/i,
    /\bgender\b/i, /\bsex\b/i, /pronoun/i, /transgender/i, /ethnic/i, /\brace\b/i, /racial/i,
    /hispanic/i, /latin[oax]\b/i, /veteran/i, /armed\s+forces/i, /military\s+(service|status)/i,
    /disabilit/i, /\bdisabled\b/i, /lgbt/i, /sexual\s+orientation/i, /demographic/i,
    /self[- ]identif/i, /\beeo\b/i, /equal\s+employment/i,
  ];

  function isLegalField(field) {
    const hay = `${field.label || ""} ${field.name || ""} ${field.id || ""} ${field.description || ""} ` +
      (field.options || []).join(" ");
    return LEGAL_PATTERNS.some((re) => re.test(hay));
  }

  // Deterministic answer for a legal field: pick the profile value for its subtype.
  // Order matters (sponsorship before visa before authorization; transgender before
  // gender). Ambiguous or unrecognized phrasings return "" → the field goes to the
  // "legal — fill manually" chip; a wrong verbatim answer is worse than no answer.
  function subtypeAnswer(hay, la, si) {
    const pick = (v) => (v == null ? "" : String(v).trim());
    const AUTH = /authori|right to work|work permit|citizen|permanent resident|immigration|legally|eligib/;
    if (/sponsor/.test(hay)) return pick(la.requires_us_sponsorship);
    if (/visa/.test(hay)) {
      // "visa or authorization to work…" is ambiguous between two different profile
      // answers — refuse rather than guess.
      return AUTH.test(hay) ? "" : pick(la.requires_us_visa);
    }
    if (AUTH.test(hay)) return pick(la.us_work_authorization);
    if (/pronoun/.test(hay)) return pick(si.pronouns);
    if (/transgender/.test(hay)) return pick(si.transgender);
    if (/gender|\bsex\b/.test(hay)) return pick(si.gender);
    if (/hispanic|latin/.test(hay)) return pick(si.hispanic);
    if (/ethnic|race|racial/.test(hay)) return pick(si.ethnicity);
    if (/veteran|armed forces|military/.test(hay)) return pick(si.veteran);
    if (/disab/.test(hay)) return pick(si.disability);
    if (/lgbt|sexual orientation/.test(hay)) return pick(si.lgbtq);
    return "";
  }

  function legalAnswerFor(field, profile) {
    const la = profile?.legal_authorization || {};
    const si = profile?.self_identification || {};
    // Two-stage: label/name/id first; only if no subtype matches, retry with the
    // aria-describedby text (some EEO fields carry their only signal there, but
    // descriptions also cite other categories — e.g. veteran definitions mention
    // disability — so they must not outrank the label).
    return subtypeAnswer(fold(`${field.label} ${field.name} ${field.id}`), la, si)
      || subtypeAnswer(fold(field.description || ""), la, si);
  }

  // The profile as the LLM sees it: legal sections removed entirely — the model cannot
  // answer what it never sees. The section list is derived from the schema's legal flags
  // (so a future legal section is excluded automatically) with the two known names as a
  // hard-coded floor. resume_text excluded too (mapFields doesn't need it).
  function legalSectionKeys() {
    const fromSchema = typeof JA_PROFILE_SECTIONS !== "undefined"
      ? JA_PROFILE_SECTIONS.filter((s) => s.legal).map((s) => s.key) : [];
    return new Set([...fromSchema, "legal_authorization", "self_identification"]);
  }

  function sanitizeProfile(profile) {
    const clone = structuredClone(profile || {});
    for (const key of legalSectionKeys()) delete clone[key];
    delete clone.resume_text;
    return clone;
  }

  // ------------------------------------------------------------------ OpenRouter core

  // Thinking is ALWAYS on (user requirement): reasoning.enabled is hard-coded for every
  // request regardless of the pasted model — never a settings toggle. Verified against
  // OpenRouter's reasoning docs + the z-ai/glm-5.2 model page (supports high/xhigh).
  async function callGLM(settings, messages, { onDelta, task } = {}) {
    const apiKey = settings?.apiKey;
    if (!apiKey) throw new Error("No API key set — paste your OpenRouter key in Settings.");
    const base = (settings?.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");

    const controller = new AbortController();
    let stalled = false;
    let idleTimer = null;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { stalled = true; controller.abort(); }, STREAM_IDLE_MS);
    };
    resetIdle();

    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/namanbist/jobapplier",
          "X-Title": "jobApplier",
          // Task discriminator: OpenRouter ignores it; the e2e mock routes on it so
          // prompt wording stays freely editable without breaking tests.
          ...(task ? { "X-JA-Task": task } : {}),
        },
        body: JSON.stringify({
          model: settings?.model || DEFAULT_MODEL,
          messages,
          stream: true,
          reasoning: { enabled: true },
          usage: { include: true },
          // Z.AI caching is automatic (writes free, reads ~0.2x); session_id gives
          // OpenRouter a provider-affinity key so repeated calls land on the same node
          // and the static prefix (system + profile) actually cache-hits.
          ...(settings?.sessionId ? { session_id: settings.sessionId } : {}),
          // Same routing rationale as the accountability machine: throughput-first,
          // skip fp4-quantized providers ("unknown" keeps reputable non-declaring ones).
          provider: {
            sort: "throughput",
            quantizations: ["fp8", "fp16", "bf16", "unknown"],
          },
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errBody.slice(0, 200)}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let reasoning = "";
      let usage = null;
      let eventData = []; // SSE spec: an event's data may span multiple data: lines

      const handlePayload = (payload) => {
        if (payload === "[DONE]") return;
        let json;
        try { json = JSON.parse(payload); } catch { return; }
        if (json.error) throw new Error(json.error.message || JSON.stringify(json.error).slice(0, 200));
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta;
        if (!delta) return;
        let r = delta.reasoning ?? delta.reasoning_content;
        if (!r && Array.isArray(delta.reasoning_details)) {
          r = delta.reasoning_details.map((d) => d.text || d.summary || "").join("");
        }
        if (r) {
          reasoning += r;
          if (onDelta) onDelta(content, reasoning);
        }
        if (delta.content) {
          content += delta.content;
          if (onDelta) onDelta(content, reasoning);
        }
      };
      const dispatchEvent = () => {
        if (!eventData.length) return;
        const payload = eventData.join("\n");
        eventData = [];
        handlePayload(payload);
      };
      const takeLine = (line) => {
        if (line === "") { dispatchEvent(); return; } // blank line terminates the event
        if (line.startsWith(":")) return; // comment/keepalive (": OPENROUTER PROCESSING")
        if (line.startsWith("data:")) eventData.push(line.slice(5).trimStart());
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) takeLine(line);
      }
      // Flush a final event that arrived without a trailing newline (usage often rides
      // the last chunk).
      if (buffer) takeLine(buffer.replace(/\r$/, ""));
      dispatchEvent();
      return { content, reasoning, usage };
    } catch (error) {
      controller.abort(); // stop the HTTP stream on in-band errors (no-op if already aborted)
      if (stalled) throw new Error(`model stream stalled (${STREAM_IDLE_MS / 1000}s without data)`);
      throw error;
    } finally {
      clearTimeout(idleTimer);
    }
  }

  // callGLM + extractJson + one corrective retry, shared by every JSON-shaped call.
  // `validate` rejects parseable-but-wrong shapes (e.g. missing mappings array) so they
  // get the same single retry as a syntax error instead of silently becoming [].
  function addUsage(a, b) {
    if (!a) return b;
    if (!b) return a;
    const n = (x) => x || 0;
    return {
      ...b,
      prompt_tokens: n(a.prompt_tokens) + n(b.prompt_tokens),
      completion_tokens: n(a.completion_tokens) + n(b.completion_tokens),
      total_tokens: n(a.total_tokens) + n(b.total_tokens),
      cost: (a.cost == null && b.cost == null) ? undefined : n(a.cost) + n(b.cost),
      prompt_tokens_details: {
        ...b.prompt_tokens_details,
        cached_tokens: n(a.prompt_tokens_details?.cached_tokens) + n(b.prompt_tokens_details?.cached_tokens),
      },
    };
  }

  async function callGLMJson(settings, messages, { onDelta, task, validate } = {}) {
    let res = await callGLM(settings, messages, { onDelta, task });
    try {
      const parsed = extractJson(res.content);
      if (validate && !validate(parsed)) throw new Error("JSON shape mismatch");
      return { parsed, res };
    } catch (e) {
      const retry = [
        ...messages,
        { role: "assistant", content: res.content?.slice(0, 4000) || "(empty)" },
        { role: "user", content: `That was not usable (${String(e.message).slice(0, 100)}). Respond again with ONLY the JSON object described in the system message.` },
      ];
      const first = res;
      res = await callGLM(settings, retry, { onDelta, task });
      res.usage = addUsage(first.usage, res.usage); // the failed attempt was billed too
      const parsed = extractJson(res.content);
      if (validate && !validate(parsed)) throw new Error("model returned an unusable shape twice");
      return { parsed, res };
    }
  }

  // ------------------------------------------------------------------ mapFields

  const MAP_SYSTEM = [
    "You fill job-application forms using ONLY a fixed applicant profile. You are precise and never invent facts.",
    "Rules:",
    "1. A value must be clearly derivable from the profile. If it is not, use null. Never guess, never fabricate.",
    "2. If a field has an options list, the value MUST be one of the options, copied character-for-character (or null).",
    "3. Respect implied formats (placeholder/description), e.g. phone with or without country code.",
    "4. Open-ended essay questions (\"why do you want…\", \"describe a time…\") get null — they are handled separately.",
    "5. Fields about work authorization, visas, sponsorship, or demographics never appear in your input; if you believe you see one anyway, return null for it.",
    "6. Output ONLY a JSON object, no markdown fences, no commentary:",
    '{"mappings":[{"ref":"<ref from the field list>","value":"<string or null>","confidence":<0..1>}]}',
  ].join("\n");

  function compactField(f) {
    const out = { ref: f.ref, label: f.label, kind: f.kind };
    if (f.required) out.required = true;
    if (f.options?.length) out.options = f.options.slice(0, 60);
    if (f.optionsSource) out.optionsSource = f.optionsSource; // "harvested" = ground truth from the open widget
    if (f.autocomplete) out.autocomplete = f.autocomplete;
    if (f.placeholder) out.placeholder = f.placeholder;
    if (f.description) out.description = f.description.slice(0, 200);
    if (f.value) out.currentValue = f.value.slice(0, 80);
    return out;
  }

  function extractJson(text) {
    let t = (text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try { return JSON.parse(t); } catch { /* fall through */ }
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a !== -1 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("model returned no JSON object");
  }

  // fields must already be pre-filtered (no legal fields); validateMappings re-checks anyway.
  async function mapFields(settings, fields, job, profile, { onDelta } = {}) {
    // Static prefix (system + profile) first, volatile parts (job, fields) last — Z.AI's
    // automatic prompt cache works on prefix identity across calls.
    // Test-coupled framing: "FORM FIELDS:\n…\n\nReturn the JSON object" is greped by
    // test/mock-openrouter.mjs to echo per-field mappings — keep the layout in sync.
    const user = [
      `APPLICANT PROFILE (the only source of truth):\n${JSON.stringify(sanitizeProfile(profile), null, 1)}`,
      `JOB: ${norm(job?.title)} at ${norm(job?.company)}`,
      `FORM FIELDS:\n${JSON.stringify(fields.map(compactField), null, 1)}`,
      'Return the JSON object now: {"mappings":[...]} with one entry per field.',
    ].join("\n\n");

    const messages = [{ role: "system", content: MAP_SYSTEM }, { role: "user", content: user }];
    const { parsed, res } = await callGLMJson(settings, messages, {
      onDelta, task: "map-fields",
      validate: (p) => Array.isArray(p?.mappings),
    });
    return { mappings: parsed.mappings, reasoning: res.reasoning, usage: res.usage };
  }

  // Code-level guarantee behind the prompt: unknown refs, legal refs, files/passwords and
  // empty values are dropped no matter what the model returned. Returns fill-instruction
  // rows ready to send to the content script.
  function validateMappings(mappings, fields) {
    const byRef = new Map(fields.map((f) => [f.ref, f]));
    const clean = [];
    for (const m of mappings || []) {
      const f = byRef.get(m?.ref);
      if (!f) continue; // unknown ref
      if (isLegalField(f)) continue; // never from the model
      if (f.kind === "file" || f.type === "password") continue; // never filled
      const value = m?.value == null ? "" : String(m.value).trim();
      if (!value || fold(value) === "null") continue; // model declined — not an error
      if (f.options?.length && !f.options.some((o) => fold(o) === fold(value))) continue; // must pick a real option
      clean.push({ ref: f.ref, kind: f.kind, expectLabel: f.label, value });
    }
    return clean;
  }

  // Single owner of legal/AI/file routing (rule #1 lives here, not in UI set arithmetic).
  // Order matters: file-kind first — a "Veteran documentation" upload is a file, not a
  // text answer. Legal entries carry their deterministic verbatim value ("" = manual).
  function partitionFields(fields, profile) {
    const legal = [];
    const ai = [];
    const file = [];
    for (const f of fields || []) {
      if (f.kind === "file") file.push(f);
      else if (isLegalField(f)) legal.push({ field: f, value: legalAnswerFor(f, profile) });
      else ai.push(f);
    }
    return { legal, ai, file };
  }

  // ------------------------------------------------------------------ resolveConfigValues
  // Profile → the canonical field keys used by reference/ats-selectors.json
  // inputSelectors. This is the single place config-path values come from: legal keys
  // are copied VERBATIM from legal_authorization/self_identification (or omitted when
  // unset — an absent key means the engine leaves the field alone and it surfaces as
  // "legal — fill manually"). Nothing here guesses; everything is a deterministic
  // restatement of what the user typed into their profile.
  //
  // Value shapes (consumed by config-engine.js):
  //   values[key] = { v, alts?, legal? }        — alts are same-fact alternates only
  //   array keys  = { v: [ { subKey: {v, …} } ] }
  // Booleans use the config's canonical "true"/"" (its values-maps are keyed that
  // way). EEO answers are the user's RAW option text first; ethnicity additionally
  // carries the semantic canonical label as a trailing alternate (a 1:1 rename, never
  // a positional code — see the NOTE above ethnicityCanonical).

  const CONFIG_LEGAL_KEYS = new Set([
    "work_auth", "work_auth_2", "work_auth_3", "work_auth_us",
    "sponsorship", "sponsorship_2", "sponsorship_3", "visa",
    "gender", "gender_2", "gender_3", "gender_checkable",
    "ethnicity", "ethnicity_2", "ethnicity_3", "ethnicity_checkable", "multiple_ethnicities",
    "hispanic", "hispanic_2", "hispanic_3",
    "veteran", "veteran_v2", "veteran_v2_2", "veteran_v2_3", "armed_forces",
    "disability", "disability_v2", "disability_v2_2", "disability_v2_3", "disability_date", "disability_name",
    "lgbt", "lgbt_v2", "lgbt_v2_2", "lgbt_v2_3",
    "transgender", "pronouns",
  ]);

  const yesNoBool = (s) => {
    const f = fold(s || "");
    if (/^(yes|y|true)\b/.test(f)) return "true";
    if (/^(no|n|false)\b/.test(f)) return "";
    return undefined; // unset or a decline-style answer — never coerced
  };

  // NOTE deliberately absent: numeric-enum guessing for gender/veteran/disability.
  // Config values-maps for those are keyed by POSITIONAL codes ("1"/"2"/"3") whose
  // meaning differs per ATS — a guessed position can misfile an EEO answer (live-caught:
  // "Decline" → "Non-Binary" on Greenhouse). Raw profile text only: it matches option
  // labels conservatively or the field stays legal-manual. ethnicityCanonical below is
  // different — its keys are semantic text labels, a 1:1 rename, not positions.
  function ethnicityCanonical(s) {
    let f = fold(s || "");
    if (!f) return undefined;
    // EEO-1 compound answers carry a "(Not Hispanic or Latino)" qualifier — strip the
    // NEGATED mention before bucketing, and never classify a negation as Hispanic
    // (audit-caught: "Two or More Races (Not Hispanic or Latino)" must not invert).
    const negatedHispanic = /(not|non) hispanic|(not|non) latino/.test(f);
    if (negatedHispanic) f = f.replace(/(not|non) (hispanic|latino)( or (latino|hispanic))?/g, " ").replace(/\s+/g, " ").trim();
    if (/decline|prefer not|don t wish|do not wish/.test(f)) return "Decline to State";
    if (/two or more|multiple|multiracial/.test(f)) return "Multiple";
    if (/hawaiian|pacific islander/.test(f)) return "Native Hawaiian/Pacific Islander";
    if (/american indian|alaska|native american/.test(f)) return "Native American/Alaskan";
    if (/black|african american/.test(f)) return "African American";
    if (/middle eastern/.test(f)) return "Middle Eastern";
    if (/southeast asian/.test(f)) return "Southeast Asian";
    if (/south asian|indian\b/.test(f)) return "South Asian";
    if (/east asian/.test(f)) return "East Asian";
    if (/^white\b|caucasian/.test(f)) return "White";
    if (!negatedHispanic && /hispanic|latin/.test(f)) return "Hispanic/Latinx";
    return undefined; // bare "Asian" etc. — ambiguous between buckets, raw text only
  }

  // Loose date parsing for profile strings ("06/1990", "May 2024", "2002",
  // "2023-06-15"). Missing parts stay undefined — formats that need them are skipped
  // rather than fabricated (a made-up month changes the résumé's claim).
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  // Out-of-range parts must never crash a run: month>12 with a plausible day swaps
  // (DD/MM input), otherwise the unusable part is dropped (year survives).
  function validDate(y, mo, d) {
    if (mo != null && (mo < 1 || mo > 12) && d != null && d >= 1 && d <= 12) [mo, d] = [d, mo];
    if (mo != null && (mo < 1 || mo > 12)) mo = undefined;
    if (d != null && (d < 1 || d > 31)) d = undefined;
    const out = { y };
    if (mo != null) out.m = mo;
    if (mo != null && d != null) out.d = d;
    return out;
  }

  // "06/1990 - Present", "October 2019 – Present", "2023-06 - 2024-02", "2018-2022".
  // Separators require surrounding whitespace so "October"'s "to" and ISO dashes
  // survive (audit-caught); bare YYYY-YYYY is the one no-space form recognized.
  function splitPeriod(period) {
    const str = String(period ?? "");
    let parts = str.split(/\s+(?:[–—-]|to|until|through)\s+/i).map((x) => norm(x));
    if (parts.length === 1) {
      const yy = str.match(/^\s*(\d{4})\s*[–—-]\s*(\d{4})\s*$/);
      parts = yy ? [yy[1], yy[2]] : [str];
    }
    const isCurrent = /present|current|now|ongoing/i.test(str);
    return {
      start: parseLooseDate(parts[0]),
      end: isCurrent ? null : parseLooseDate(parts[1] || ""),
      isCurrent,
    };
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

  const pad2 = (n) => String(n).padStart(2, "0");
  const monthText = (m) => MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1);

  // Row-level date emission shared by the education/experience builders: full
  // dateVariants under `datePrefix` plus the bare year/month subkeys the config uses.
  function putRowDates(row, putRow, datePrefix, shortPrefix, parts) {
    if (!parts) return;
    dateVariants(datePrefix, parts, row);
    putRow(`${shortPrefix}_year`, parts.y);
    if (parts.m) {
      putRow(`${shortPrefix}_month`, pad2(parts.m));
      putRow(`${shortPrefix}_month_text`, monthText(parts.m));
    }
  }

  // date-format subkey variants ("start_date_MM", "grad_date_slashes_MMYYYY", …).
  // Day defaults to 01 when a full date is demanded but only month/year are known
  // (standard ATS convention); month is never invented.
  function dateVariants(prefix, parts, out) {
    if (!parts || !parts.y) return;
    const { y, m, d } = parts;
    const set = (k, v) => { if (v != null) out[`${prefix}${k}`] = { v: String(v) }; };
    set("_year", y);
    set("_YYYY", y);
    if (m) {
      set("_M", m);
      set("_MM", pad2(m));
      set("_month", pad2(m));
      set("_month_text", monthText(m));
      const monthName = monthText(m);
      set("_slashes_MMYYYY", `${pad2(m)}/${y}`);
      set("_MMYYYY", `${pad2(m)}/${y}`); // unslashed name, slashed value (mm/yyyy placeholder inputs)
      set("_dashes_YYYYMM", `${y}-${pad2(m)}`);
      set("_dashes_MMYYYY", `${pad2(m)}-${y}`);
      set("_dashes_MMMYYYY", `${monthName.slice(0, 3)}-${y}`);
      const dd = d || 1;
      set("_D", d ?? 1);
      set("_DD", pad2(dd));
      set("", `${pad2(m)}/${pad2(dd)}/${y}`);
      set("_slashes_MMDDYYYY", `${pad2(m)}/${pad2(dd)}/${y}`);
      set("_MMDDYYYY", `${pad2(m)}/${pad2(dd)}/${y}`); // ditto: mm/dd/yyyy placeholder inputs
      set("_slashes_MDYYYY", `${m}/${dd}/${y}`);
      set("_slashes_MDDYY", `${m}/${pad2(dd)}/${String(y).slice(2)}`);
      set("_dashes_YYYYMMDD", `${y}-${pad2(m)}-${pad2(dd)}`);
      set("_month_DD_comma_YYYY", `${monthName} ${pad2(dd)}, ${y}`);
    }
  }

  function resolveConfigValues(profile, opts = {}) {
    const p = profile || {};
    const pi = p.personal_information || {};
    const la = p.legal_authorization || {};
    const si = p.self_identification || {};
    const values = {};
    const put = (key, v, extra) => {
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return;
      values[key] = { v: typeof v === "string" ? v.trim() : v, ...(extra || {}) };
    };
    // Booleans: "" is a real value (the canonical No) — only undefined means unset.
    const putBool = (key, v, extra) => {
      if (v === undefined) return;
      values[key] = { v, ...(extra || {}) };
    };
    const legal = { legal: true };

    // ---- personal
    put("first_name", pi.first_name);
    put("first_name_2", pi.first_name);
    put("last_name", pi.last_name);
    put("last_name_2", pi.last_name);
    put("middle_name", pi.middle_name);
    const full = [pi.first_name, pi.last_name].filter(Boolean).join(" ");
    put("full_name", full);
    put("legal_name", full);
    put("preferred_first_name", pi.first_name);
    put("first_name_preferred", pi.first_name);
    put("preferred_name", pi.first_name);
    put("preferred_last_name", pi.last_name);
    put("email", pi.email);
    put("email_2", pi.email);
    put("email_confirm", pi.email);

    const cc = norm(pi.phone_country_code || "");
    let phone = norm(pi.phone || "");
    put("phone", phone);
    put("phone_2", phone);
    if (phone) {
      const digits = phone.replace(/\D+/g, "");
      const ccDigits = cc.replace(/\D+/g, "");
      let stripped = digits;
      if (ccDigits && digits.startsWith(ccDigits) && digits.length > 10) {
        stripped = digits.slice(ccDigits.length);
      } else if (phone.startsWith("+") && digits.length > 10) {
        stripped = digits.slice(-10); // "+1 570 555 8977" with a blank cc field
      }
      put("phone_stripped", stripped, { alts: [digits] });
    }
    if (cc) {
      const alts = [cc.replace(/\D+/g, "")];
      if (cc === "+1" || cc === "1") alts.push("United States", "US", "USA", "United States (+1)", "US +1");
      put("phone_country", cc, { alts });
      put("phone_country_2", cc, { alts });
    }
    put("phone_type", "Mobile", { alts: ["Cell", "Mobile Phone", "Cell Phone", "Personal"] });
    put("address_type", "Home");

    // ---- location
    const maps = opts.maps || {};
    put("address", pi.address);
    put("city", pi.city);
    put("city_2", pi.city);
    // Map values may be arrays ("GB" → ["United Kingdom","UK"]) — flatten everywhere.
    const asList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
    const stateAlts = [];
    if (pi.state) {
      const s2n = maps.stateAbbreviationsToNames || {};
      stateAlts.push(...asList(s2n[pi.state]));
      for (const [abbr, names] of Object.entries(s2n)) {
        if (asList(names).some((n) => fold(n) === fold(pi.state))) stateAlts.push(abbr);
      }
    }
    put("state", pi.state, { alts: stateAlts });
    put("state_2", pi.state, { alts: stateAlts });
    const countryAlts = [];
    if (pi.country) {
      const n2a = maps.countryNamesToAbbreviations || {};
      const a2n = maps.countryAbbreviationsToNames || {};
      countryAlts.push(...asList(n2a[pi.country]));
      countryAlts.push(...asList(a2n[pi.country]));
      if (/^(united states( of america)?|us|usa)$/i.test(norm(pi.country))) {
        countryAlts.push("United States", "US", "USA", "United States of America");
      }
    }
    const countryAltList = [...new Set(countryAlts)];
    put("country", pi.country, { alts: countryAltList });
    put("country_2", pi.country, { alts: countryAltList });
    put("country_location", pi.country, { alts: countryAltList });
    put("postal_code", pi.zip_code);
    const cityState = [pi.city, pi.state].filter(Boolean).join(", ");
    put("city_state", cityState);
    put("city_state_full", [pi.city, pi.state, pi.country].filter(Boolean).join(", "));
    put("location", pi.location || [pi.city, pi.state, pi.country].filter(Boolean).join(", "));
    // in_country (Uber): the config's paths substitute the value into an id like
    // "in-%LOWERVALUE%-true", with a STATIC "in-usa-false" fallback path — a boolean
    // here made the fallback claim "not in the USA" for US profiles (audit-caught).
    // Emit the slug for US only; non-US flows through the selector's valueKey:"country"
    // and correctly lands on the false branch.
    if (/^(united states( of america)?|us|usa)$/i.test(norm(pi.country))) put("in_country", "usa");

    // ---- links
    put("linkedin", pi.linkedin);
    put("linkedin_2", pi.linkedin);
    put("linkedin_3", pi.linkedin);
    put("github", pi.github);
    put("portfolio", pi.portfolio);
    const links = [...new Set([pi.portfolio, pi.github, pi.linkedin].filter(Boolean))];
    if (links[0]) put("additional_url", links[0], { alts: links.slice(1) });
    if (links[1]) put("additional_url_2", links[1]);
    if (links[2]) put("additional_url_3", links[2]);
    if (links.length) values.websites = { v: links.map((u) => ({ url: { v: u }, key: { v: "Other" }, save: {} })) };

    // ---- dates / age
    const now = opts.now ? new Date(opts.now) : new Date();
    const today = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
    dateVariants("current_date", today, values); // includes bare current_date = MM/DD/YYYY
    const dob = parseLooseDate(pi.date_of_birth);
    if (dob && dob.y && dob.m && dob.d) {
      dateVariants("birthday", dob, values); // includes birthday_M/_MM/_D/_DD/_YYYY/_slashes_MDYYYY
      const age = (now - new Date(dob.y, dob.m - 1, dob.d)) / (365.25 * 24 * 3600 * 1000);
      putBool("over18", age >= 18 ? "true" : "");
      putBool("over21", age >= 21 ? "true" : "");
    }

    // ---- legal: verbatim or absent. NEVER derived, never defaulted. (rule #1)
    for (const k of ["work_auth", "work_auth_2", "work_auth_3"]) {
      putBool(k, yesNoBool(la.us_work_authorization), legal);
    }
    putBool("visa", yesNoBool(la.requires_us_visa), legal);
    putBool("sponsorship", yesNoBool(la.requires_us_sponsorship), legal);
    putBool("sponsorship_2", yesNoBool(la.requires_us_sponsorship), legal);
    for (const k of ["gender", "gender_2", "gender_3", "gender_checkable"]) {
      put(k, norm(si.gender) || undefined, legal);
    }
    if (si.ethnicity) {
      // Verbatim-first: the user's exact text is the primary candidate; the semantic
      // canonical label (which unlocks the config's ethnicity values-maps) trails as an
      // alternate, so it can never beat an option that literally matches the answer.
      const raw = norm(si.ethnicity);
      const canon = ethnicityCanonical(si.ethnicity);
      const ethExtra = canon && canon !== raw ? { alts: [canon] } : {};
      for (const k of ["ethnicity", "ethnicity_2", "ethnicity_3", "ethnicity_checkable"]) {
        put(k, raw, { ...ethExtra, ...legal });
      }
      values.multiple_ethnicities = { v: [raw], ...(canon && canon !== raw ? { alts: [canon] } : {}), legal: true };
    }
    if (si.hispanic) {
      const hb = yesNoBool(si.hispanic);
      const hAlt = norm(si.hispanic) ? { alts: [norm(si.hispanic)] } : {};
      for (const k of ["hispanic", "hispanic_2", "hispanic_3"]) {
        if (hb !== undefined) putBool(k, hb, { ...hAlt, ...legal });
        else put(k, norm(si.hispanic), legal); // decline-style: raw text only
      }
    }
    for (const k of ["veteran", "veteran_v2", "veteran_v2_2", "veteran_v2_3"]) {
      put(k, norm(si.veteran) || undefined, legal);
    }
    for (const k of ["disability", "disability_v2", "disability_v2_2", "disability_v2_3"]) {
      put(k, norm(si.disability) || undefined, legal);
    }
    if (si.lgbtq) {
      for (const k of ["lgbt", "lgbt_v2", "lgbt_v2_2", "lgbt_v2_3"]) put(k, norm(si.lgbtq), legal);
    }
    put("transgender", norm(si.transgender) || undefined, legal);
    put("pronouns", norm(si.pronouns) || undefined, legal);
    // armed_forces / disability_date / disability_name: deliberately never resolved —
    // the profile has no verbatim answer for them ("not a protected veteran" does not
    // answer "have you served"). They surface as legal-manual.

    // ---- education
    const eduRows = (p.education_details || []).filter((e) => e && typeof e === "object");
    if (eduRows.length) {
      values.education = {
        v: eduRows.map((e) => {
          const row = {};
          const putRow = (k, v, extra) => {
            if (v != null && String(v).trim() !== "") row[k] = { v: String(v).trim(), ...(extra || {}) };
          };
          putRow("education", e.institution);
          putRow("school", e.institution);
          putRow("name", e.institution); // grouping selectors nest the typeahead under name/name_other
          const lvl = norm(e.education_level || "");
          if (lvl) {
            const alts = new Set([`${lvl} Degree`]);
            if (!/['’]s$/i.test(lvl)) { alts.add(`${lvl}'s`); alts.add(`${lvl}'s Degree`); }
            if (/^master/i.test(lvl)) alts.add("Master's Degree");
            if (/^bachelor/i.test(lvl)) alts.add("Bachelor's Degree");
            putRow("degree", lvl, { alts: [...alts] });
          }
          putRow("major", e.field_of_study);
          putRow("field_of_study", e.field_of_study);
          putRow("gpa", e.final_evaluation_grade);
          const start = parseLooseDate(e.start_date);
          const grad = parseLooseDate(e.year_of_completion || e.end_date);
          putRowDates(row, putRow, "start_date", "start", start);
          if (grad) {
            putRowDates(row, putRow, "grad_date", "grad", grad);
            dateVariants("end_date", grad, row);
            putRow("end_year", grad.y);
            const done = new Date(grad.y, (grad.m || 12) - 1, grad.d || 28) <= now;
            row.graduated = { v: done ? "true" : "" };
            row.did_graduate = { v: done ? "true" : "" };
          }
          row.save = {}; row.done = {};
          return row;
        }),
      };
      const RANK = ["high school", "associate", "bachelor", "master", "mba", "doctor", "phd"];
      const rank = (l) => RANK.findIndex((r) => fold(l).includes(r));
      const top = [...eduRows].sort((a, b) => rank(b.education_level || "") - rank(a.education_level || ""))[0];
      if (top?.education_level) {
        const lvl = norm(top.education_level);
        const alts = new Set([`${lvl} Degree`]);
        if (!/['’]s$/i.test(lvl)) alts.add(`${lvl}'s Degree`); // no "Master's's Degree"
        put("highestDegree", lvl, { alts: [...alts] });
      }
    }

    // ---- experience
    const expRows = (p.experience_details || []).filter((e) => e && typeof e === "object");
    if (expRows.length) {
      values.experience = {
        v: expRows.map((e) => {
          const row = {};
          const putRow = (k, v, extra) => {
            if (v != null && String(v).trim() !== "") row[k] = { v: String(v).trim(), ...(extra || {}) };
          };
          putRow("company", e.company);
          putRow("employer", e.company);
          putRow("name", e.company); // grouping selectors nest the typeahead under name/name_other
          putRow("title", e.position);
          const resp = Array.isArray(e.key_responsibilities) ? e.key_responsibilities.join("\n") : String(e.key_responsibilities || "");
          putRow("description", resp);
          putRow("description_stripped", resp.replace(/\s+/g, " "));
          putRow("location", e.location);
          const locParts = String(e.location || "").split(",").map(norm);
          putRow("city", locParts[0]);
          putRow("state", locParts[1]);
          putRow("country", locParts[2]);
          putRow("city_state", locParts.slice(0, 2).filter(Boolean).join(", "));
          const { start, end, isCurrent } = splitPeriod(e.employment_period);
          putRowDates(row, putRow, "start_date", "start", start);
          putRowDates(row, putRow, "end_date", "end", end);
          row.currently_working = { v: isCurrent ? "true" : "" };
          row.save = {}; row.done = {};
          return row;
        }),
      };
      // Top-level "current employment" facts come ONLY from a row that says so —
      // never from "the first row" (audit-caught fabrication between jobs).
      const current = expRows.find((e) => /present|current/i.test(String(e.employment_period || "")));
      put("current_company_name", current?.company);
      put("current_job_title", current?.position);
      putBool("currently_working", current ? "true" : "");
      // hasExperience deliberately NOT emitted from row presence: an empty section may
      // just be an unfilled profile, and the config's editorial `value:true` is blocked
      // engine-side (SENSITIVE_VALUE_KEYS) — the question stays manual.
    }

    // ---- skills / languages
    const skillList = String(p.skills || "").split(",").map(norm).filter(Boolean);
    if (skillList.length) {
      put("skills", skillList.join(", "));
      values.skill = { v: skillList.map((s) => ({ skill: { v: s }, save: {} })) };
    }
    const langRows = (p.languages || []).filter((l) => l && (typeof l === "string" || l.language));
    if (langRows.length) {
      const names = langRows.map((l) => (typeof l === "string" ? l : l.language)).filter(Boolean);
      put("language", names[0]);
      put("language_preferred", names[0]);
      put("languages_text", names.join(", "));
      values.languages = {
        v: langRows.map((l) => {
          const name = typeof l === "string" ? l : l.language;
          const prof = typeof l === "object" && l.proficiency ? String(l.proficiency) : "";
          return {
            language: { v: name },
            // per-skill selects restate the single proficiency answer (same fact)
            ...(prof ? { proficiency: { v: prof }, speak: { v: prof }, read: { v: prof }, write: { v: prof } } : {}),
            save: {},
          };
        }),
      };
    }

    // ---- salary (profile only — the config's editorial default is never used)
    const salary = norm(p.salary_expectations?.salary_range_usd || "");
    if (salary) {
      const firstNum = (salary.match(/\d[\d,]*/) || [])[0]?.replace(/,/g, "");
      for (const k of ["salary", "salary_requirements", "desired_salary", "expected_salary"]) {
        put(k, salary, firstNum && firstNum !== salary ? { alts: [firstNum] } : undefined);
      }
    }

    // ---- documents (content travels separately as bytes/text; the value marks presence)
    if (opts.resumeFileName) put("resume", opts.resumeFileName);
    if (opts.resumeFileName) putBool("confirm_resume", "true");
    if (opts.coverLetterName) { put("coverLetter", opts.coverLetterName); put("cover_letter", opts.coverLetterName); }

    return { values, legalKeys: [...CONFIG_LEGAL_KEYS] };
  }

  // ------------------------------------------------------------------ answerBatch
  // One batched call answers ALL freeform/essay questions on a page (docs/03: one
  // keyword-derivation + one answer call, not 15 round-trips). Fields must already be
  // partitioned — legal fields never reach this — but isLegalField re-checks anyway.

  const ANSWER_SYSTEM = [
    "You answer job-application questions for a software-engineering applicant, in their first-person voice.",
    "Hard rules:",
    "1. Ground every claim in the provided profile/résumé. NEVER invent employers, projects, titles, dates, metrics, or skills.",
    "2. Be specific and concrete; no clichés, no filler, no hedging. Write like a strong, honest candidate.",
    "3. Never use em dashes (—). Use commas, colons, or separate sentences instead. They are an AI-writing tell.",
    "4. Default 60–140 words per answer; respect any explicit word/character limit in the question. Single-line inputs get one sentence.",
    "5. If a question cannot be answered from the profile (missing fact, needs a personal anecdote you don't have), return null for it — never fabricate.",
    "6. Questions about work authorization, visas, sponsorship, or demographics never appear in your input; if you believe you see one anyway, return null for it.",
    "7. Output ONLY a JSON object, no markdown fences:",
    '{"answers":[{"ref":"<ref from the question list>","answer":"<string or null>"}]}',
  ].join("\n");

  async function answerBatch(settings, questions, job, profile, { onDelta } = {}) {
    const qs = questions.map((f) => ({
      ref: f.ref, question: f.label,
      ...(f.description ? { context: f.description.slice(0, 300) } : {}),
      ...(f.kind === "textarea" ? {} : { note: "single-line input — answer in one sentence" }),
    }));
    const resume = String(profile?.resume_text || "").slice(0, 6000);
    const user = [
      `APPLICANT PROFILE (the only source of truth):\n${JSON.stringify(sanitizeProfile(profile), null, 1)}`,
      resume ? `RÉSUMÉ (plain text):\n${resume}` : "",
      `JOB: ${norm(job?.title)} at ${norm(job?.company)}`,
      `JOB DESCRIPTION (for tailoring, not for inventing facts):\n${String(job?.description || "").slice(0, 6000)}`,
      `QUESTIONS:\n${JSON.stringify(qs, null, 1)}`,
      'Return the JSON object now: {"answers":[...]} with one entry per question.',
    ].filter(Boolean).join("\n\n");
    const messages = [{ role: "system", content: ANSWER_SYSTEM }, { role: "user", content: user }];
    const { parsed, res } = await callGLMJson(settings, messages, {
      onDelta, task: "answer-batch",
      validate: (x) => Array.isArray(x?.answers),
    });
    // Code-level guarantee: unknown refs, legal refs, and empty answers are dropped.
    const byRef = new Map(questions.map((f) => [f.ref, f]));
    const clean = [];
    for (const a of parsed.answers || []) {
      const f = byRef.get(a?.ref);
      if (!f || isLegalField(f)) continue;
      const answer = a?.answer == null ? "" : String(a.answer).trim();
      if (!answer || fold(answer) === "null") continue;
      clean.push({ ref: f.ref, kind: f.kind, expectLabel: f.label, value: answer });
    }
    return { instructions: clean, reasoning: res.reasoning, usage: res.usage };
  }

  // ------------------------------------------------------------------ coverLetter

  const COVER_SYSTEM = [
    "You are an experienced tech-industry cover-letter writer. You write honest, specific, ATS-friendly letters for a software-engineering applicant.",
    "Hard rules:",
    "1. Ground every claim in the provided profile/résumé. NEVER invent employers, projects, titles, dates, metrics, or skills.",
    "2. 250–350 words of plain text. No address block, no date line, no markdown.",
    "3. Open with \"Dear <Company> Hiring Team,\" unless a hiring manager's name is given.",
    "4. Structure: a specific hook about this role/company → one or two concrete, relevant experiences or projects from the résumé with real outcomes → why this company specifically → a short close.",
    "5. Mirror the job description's genuine keyword matches (languages, frameworks, domains the applicant actually has). Skip requirements the applicant doesn't meet — never claim them.",
    "6. No clichés or AI-writing tells. Avoid: \"I am writing to express…\", \"team player\", \"fast learner\", \"passionate\", \"results-driven\", \"proven track record\", \"leverage\", \"synergy\", \"in order to\", \"excited about the opportunity\". Confident, concrete, human — in the applicant's plain voice.",
    "7. Never use em dashes (—). Use commas, colons, or separate sentences instead. They are an AI-writing tell.",
    "8. End with \"Sincerely,\" then the applicant's name.",
  ].join("\n");

  async function coverLetter(settings, job, profile, { onDelta } = {}) {
    const resume = String(profile?.resume_text || "").slice(0, 6000);
    const user = [
      `APPLICANT PROFILE:\n${JSON.stringify(sanitizeProfile(profile), null, 1)}`,
      resume ? `RÉSUMÉ (plain text):\n${resume}` : "RÉSUMÉ: (none provided — rely on the profile only)",
      `JOB TITLE: ${norm(job?.title)}`,
      `COMPANY: ${norm(job?.company)}`,
      `JOB DESCRIPTION:\n${String(job?.description || "").slice(0, 8000)}`,
      "Write the cover letter now.",
    ].join("\n\n");
    return callGLM(settings, [
      { role: "system", content: COVER_SYSTEM },
      { role: "user", content: user },
    ], { onDelta, task: "cover-letter" });
  }

  // ------------------------------------------------------------------ parseResumeToProfile

  // personal_information keys come from the editor schema so a new profile field is
  // extracted automatically; PARSE_ALLOWED below stays a hard-coded literal on purpose
  // (a safety allowlist must not be derived from the structure it guards).
  function parsePersonalShape() {
    const section = typeof JA_PROFILE_SECTIONS !== "undefined"
      ? JA_PROFILE_SECTIONS.find((s) => s.key === "personal_information") : null;
    if (!section) {
      return { first_name: "", last_name: "", email: "", phone: "", phone_country_code: "", location: "", city: "", state: "", country: "", zip_code: "", linkedin: "", github: "", portfolio: "" };
    }
    return Object.fromEntries(section.fields.map(([k]) => [k, ""]));
  }

  const PARSE_SYSTEM = [
    "You extract structured data from résumés into JSON. You are precise and never invent facts.",
    "Rules:",
    "1. Use ONLY information present in the résumé text. Missing values are \"\" (or [] for lists). Never guess.",
    "2. Extract FAITHFULLY — preserve the résumé's original wording. Do NOT paraphrase, summarize, rewrite, embellish, upgrade verbs, or add any skill, tool, metric, or achievement that is not literally written in the résumé. This extracted text becomes the source of truth for later résumé tailoring, so faithful accuracy matters far more than polish.",
    "3. NEVER include work authorization, visa, sponsorship, citizenship, or demographic/EEO information, even if the résumé mentions it — those sections are user-managed and must not appear in your output.",
    "4. Output ONLY a JSON object (no markdown fences, no commentary) with exactly this shape:",
    JSON.stringify({
      personal_information: parsePersonalShape(),
      education_details: [{ education_level: "", institution: "", field_of_study: "", final_evaluation_grade: "", start_date: "", year_of_completion: "" }],
      experience_details: [{ position: "", company: "", employment_period: "", location: "", industry: "", key_responsibilities: [], skills_acquired: [] }],
      projects: [{ name: "", description: "", link: "" }],
      certifications: [],
      languages: [{ language: "", proficiency: "" }],
      skills: "comma-separated string",
    }),
  ].join("\n");

  // Allowlist: the résumé parse may only populate these sections. legal_authorization /
  // self_identification are stripped even if the model emits them (rule #1, docs/06).
  const PARSE_ALLOWED = [
    "personal_information", "education_details", "experience_details",
    "projects", "certifications", "languages", "skills",
  ];

  function sanitizeParsedProfile(parsed) {
    const out = {};
    if (!parsed || typeof parsed !== "object") return out;
    for (const key of PARSE_ALLOWED) {
      const v = parsed[key];
      if (v == null) continue;
      if (key === "personal_information") {
        if (typeof v === "object" && !Array.isArray(v)) {
          out[key] = {};
          for (const [k, val] of Object.entries(v)) {
            if (typeof val === "string" && val.trim()) out[key][k] = val.trim();
          }
        }
      } else if (key === "skills") {
        if (typeof v === "string" && v.trim()) out[key] = v.trim();
        else if (Array.isArray(v)) out[key] = v.filter((s) => typeof s === "string").join(", ");
      } else if (Array.isArray(v)) {
        // Models often emit bare strings for certifications/languages — keep them, the
        // editor's JSON textareas render strings fine.
        out[key] = v.filter((x) => x && (typeof x === "object" || typeof x === "string"));
      }
    }
    return out;
  }

  async function parseResumeToProfile(settings, resumeText, { onDelta } = {}) {
    const messages = [
      { role: "system", content: PARSE_SYSTEM },
      { role: "user", content: `RÉSUMÉ TEXT:\n${String(resumeText).slice(0, 20000)}\n\nReturn the JSON object now.` },
    ];
    const { parsed, res } = await callGLMJson(settings, messages, {
      onDelta, task: "parse-resume",
      validate: (p) => p && typeof p === "object" && !Array.isArray(p),
    });
    return { parsed: sanitizeParsedProfile(parsed), reasoning: res.reasoning, usage: res.usage };
  }

  // ------------------------------------------------------------------ tailor
  // Résumé tailoring (step 4): rephrase/reorder/emphasize REAL content to one posting.
  // Non-fabrication is the whole game — every identity fact is force-copied from the
  // source in sanitizeTailored, so the model can only touch bullets/skills/descriptions,
  // and every add-a-skill/metric must carry a verbatim `source` quote the downstream
  // audit re-checks. Legal/EEO never enters (source is a sanitizeProfile'd subset).

  const TAILOR_SYSTEM = [
    "You tailor a software-engineering applicant's résumé to ONE specific job posting. You reorder, rephrase, and re-emphasize REAL résumé content — you never invent. This is a LIGHT EDIT, not a rewrite.",
    "Hard rules:",
    "1. Ground every word in the provided source résumé. NEVER invent employers, projects, titles, dates, metrics, numbers, tools, or skills. If it is not in the source, it does not go in the output.",
    "2. Change as LITTLE as possible. Keep each bullet EXACTLY as written unless a specific edit measurably improves alignment with THIS job description. Most bullets should come through unchanged or barely touched; leave already-relevant ones alone. Prefer surfacing (reordering) the strongest existing bullets over rewording them. When in doubt, don't change it.",
    "3. Preserve the candidate's own voice. Keep their wording, tone, sentence rhythm, and level of formality; reuse THEIR verbs and terms rather than swapping in your own. The output must read like the same person wrote it, only sharpened — never homogenized into generic résumé-speak. Prefer the candidate's original word to a fancier synonym.",
    "4. No AI-résumé clichés or filler — they are a tell and they erase the candidate's voice. Banned words/phrases: spearheaded, leveraged, utilized, orchestrated, championed, pioneered, passionate, results-driven, detail-oriented, dynamic, robust, seamless(ly), cutting-edge, synergy, \"proven track record\", \"responsible for\", \"tasked with\", \"in order to\", \"wide range of\". Use plain, concrete language.",
    "4b. Never introduce em dashes (—) when rephrasing; use commas, colons, or separate sentences instead. (If the source résumé already uses one in a bullet you leave unchanged, that is fine — rule 2 wins.)",
    "5. Reorder, rephrase, and emphasize ONLY. Never upgrade responsibility, verbs, or scope: no intern→engineer, no \"assisted\"→\"led\", no individual→team or team→individual.",
    "6. Never add a skill, tool, or metric unless you also copy a `source` quote character-for-character from the source résumé proving it was already there. No verbatim quote → do not add it.",
    "7. Identity fields are frozen and copied UNCHANGED: company, position, employment_period, dates, location, institution, education_level. You may edit only bullets (key_responsibilities), skills_acquired, and project/other descriptions.",
    "8. Every item you emit MUST carry its `sourceIndex` — the 0-based index of the source item it came from. Items may be dropped or reordered, never altered into a different item.",
    "9. If you split one source bullet into two, report it as TWO changes that share the same `before` text.",
    "10. Work-authorization, visa, sponsorship, and demographic/EEO content never appears in your input; if you believe you see any, leave it out entirely.",
    "11. Output ONLY a JSON object, no markdown fences, no commentary:",
    '{"tailored":{ …the tailored résumé, SAME section shape as the source, every item carrying "sourceIndex"… },' +
      '"changes":[{"section":"experience_details","sourceIndex":0,"field":"key_responsibilities","kind":"rephrase|reorder|add|remove","before":"<original text>","after":"<tailored text>","source":"<verbatim quote copied from the source résumé>","reason":"<why>"}]}',
  ].join("\n");

  // Sections the tailor pass may return (mirror of PARSE_ALLOWED). Legal sections are
  // stripped even if the model emits them (rule #1). resume_text rides along verbatim.
  const TAILOR_ALLOWED = [
    "personal_information", "education_details", "experience_details",
    "projects", "certifications", "languages", "skills", "resume_text",
  ];
  const TAILOR_CHANGE_KINDS = new Set(["rephrase", "reorder", "add", "remove"]);

  // A sourceIndex is only usable if it's a real 0-based array index.
  function tailorIndex(v) {
    if (Number.isInteger(v)) return v >= 0 ? v : null;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v, 10);
    return null;
  }
  // Bullet/skill lists: keep the model's edited strings, but fall back to the source
  // list if the model returned garbage (never a fabricated empty).
  function tailorBullets(v, fallback) {
    if (Array.isArray(v)) {
      const clean = v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
      return clean.length ? clean : (Array.isArray(fallback) ? fallback : []);
    }
    if (typeof v === "string" && v.trim()) return [v.trim()];
    return Array.isArray(fallback) ? fallback : (fallback == null ? [] : [String(fallback)]);
  }

  // Pure function (no chrome/DOM/network) so unit-ai-tailor can call it directly.
  // Force-copies every identity fact from `source`; the model only supplies editable
  // bullet/skill/description text. Bad `changes` entries are DROPPED silently (they fall
  // to the unattributed path in the audit) — this must NEVER throw.
  function sanitizeTailored(source, parsed) {
    const src = source && typeof source === "object" ? source : {};
    const model = parsed && typeof parsed.tailored === "object" && parsed.tailored ? parsed.tailored : {};
    const out = {};

    // personal_information: force-copied wholesale — the model never touches identity.
    if (src.personal_information && typeof src.personal_information === "object") {
      out.personal_information = structuredClone(src.personal_information);
    }

    // experience_details: start from the SOURCE row (identity + dates verbatim), overlay
    // only the editable key_responsibilities / skills_acquired. An item whose sourceIndex
    // matches nothing is a fabricated row → dropped.
    // A second item claiming an already-used sourceIndex is a DUPLICATE — the same source
    // row emitted twice (which would let a borrowed bullet ride under a second identity and
    // dodge the identity audit). First copy wins; the rest are dropped and recorded so the
    // drop is visible (surfaced on the sanitize result, asserted by unit-ai-tailor).
    const dropped = [];
    const srcExp = Array.isArray(src.experience_details) ? src.experience_details : [];
    if (Array.isArray(model.experience_details)) {
      out.experience_details = [];
      const usedSi = new Set();
      for (const item of model.experience_details) {
        const si = tailorIndex(item?.sourceIndex);
        const base = si != null ? srcExp[si] : undefined;
        if (!base || typeof base !== "object") continue;
        if (usedSi.has(si)) { dropped.push({ section: "experience_details", sourceIndex: si }); continue; }
        usedSi.add(si);
        out.experience_details.push({
          ...structuredClone(base),
          key_responsibilities: tailorBullets(item.key_responsibilities, base.key_responsibilities),
          skills_acquired: tailorBullets(item.skills_acquired, base.skills_acquired),
          sourceIndex: si,
        });
      }
    } else {
      out.experience_details = structuredClone(srcExp);
    }

    // education_details: no free text to tailor — source rows verbatim, reorder honored.
    const srcEdu = Array.isArray(src.education_details) ? src.education_details : [];
    if (Array.isArray(model.education_details)) {
      out.education_details = [];
      const usedSi = new Set();
      for (const item of model.education_details) {
        const si = tailorIndex(item?.sourceIndex);
        const base = si != null ? srcEdu[si] : undefined;
        if (!base || typeof base !== "object") continue;
        if (usedSi.has(si)) { dropped.push({ section: "education_details", sourceIndex: si }); continue; }
        usedSi.add(si);
        out.education_details.push({ ...structuredClone(base), sourceIndex: si });
      }
    } else if (srcEdu.length) {
      out.education_details = structuredClone(srcEdu);
    }

    // projects: description is editable; name/link are identity, copied from source.
    const srcProj = Array.isArray(src.projects) ? src.projects : [];
    if (Array.isArray(model.projects)) {
      out.projects = [];
      const usedSi = new Set();
      for (const item of model.projects) {
        const si = tailorIndex(item?.sourceIndex);
        const base = si != null ? srcProj[si] : undefined;
        if (!base || typeof base !== "object") continue;
        if (usedSi.has(si)) { dropped.push({ section: "projects", sourceIndex: si }); continue; }
        usedSi.add(si);
        const desc = typeof item.description === "string" && item.description.trim()
          ? item.description.trim() : base.description;
        out.projects.push({ ...structuredClone(base), description: desc, sourceIndex: si });
      }
    } else if (srcProj.length) {
      out.projects = structuredClone(srcProj);
    }

    // certifications / languages: factual — force-copied from source (reorder only).
    if (Array.isArray(src.certifications)) out.certifications = structuredClone(src.certifications);
    if (Array.isArray(src.languages)) out.languages = structuredClone(src.languages);

    // skills: a comma string the model may reorder/emphasize; per-skill grounding is the
    // downstream audit's job. Fall back to the source string if the model dropped it.
    if (typeof model.skills === "string" && model.skills.trim()) out.skills = model.skills.trim();
    else if (typeof src.skills === "string") out.skills = src.skills;

    // resume_text: the raw text blob is never rewritten — carried over verbatim.
    if (typeof src.resume_text === "string") out.resume_text = src.resume_text;

    // Belt-and-suspenders allowlist + legal strip (a section outside TAILOR_ALLOWED, or a
    // legal section, can never survive even if a code path above let it through).
    for (const k of Object.keys(out)) {
      if (!TAILOR_ALLOWED.includes(k)) delete out[k];
    }
    for (const k of legalSectionKeys()) delete out[k];

    // changes: clamp to strings + enum-check; drop anything malformed or pointing at a
    // source item that doesn't exist. Never throws.
    const str = (x) => (x == null ? "" : String(x));
    const changes = [];
    for (const c of Array.isArray(parsed?.changes) ? parsed.changes : []) {
      if (!c || typeof c !== "object") continue;
      const kind = str(c.kind).trim();
      if (!TAILOR_CHANGE_KINDS.has(kind)) continue;              // bad enum → drop
      const section = str(c.section).trim();
      if (!section) continue;                                     // missing field → drop
      const idx = tailorIndex(c.sourceIndex);
      const arr = Array.isArray(src[section]) ? src[section] : null;
      if (arr && (idx == null || idx >= arr.length)) continue;    // no matching source item → drop
      changes.push({
        section, sourceIndex: idx, field: str(c.field), kind,
        before: str(c.before), after: str(c.after), source: str(c.source), reason: str(c.reason),
      });
    }

    return { tailored: out, changes, dropped };
  }

  async function tailor(settings, source, job, hints, { onDelta } = {}) {
    // ADJACENT keyword hints only (each {keyword, provenance}); capped so the volatile
    // tail stays small. Static prefix (system + source résumé) FIRST so Z.AI's automatic
    // prompt cache hits across every posting in a session; JD + hints LAST.
    const hintList = (Array.isArray(hints) ? hints : []).slice(0, 15);
    const user = [
      `SOURCE RÉSUMÉ (the only source of truth — every word of output must trace here):\n${JSON.stringify(source || {}, null, 1)}`,
      `JOB: ${norm(job?.title)} at ${norm(job?.company)}`,
      `JOB DESCRIPTION (for emphasis only, never for inventing facts):\n${String(job?.description || "").slice(0, 8000)}`,
      hintList.length
        ? `KEYWORDS ALREADY SUPPORTED BY THE RÉSUMÉ — emphasize where genuinely present, never a license to add what isn't there:\n${JSON.stringify(hintList, null, 1)}`
        : "",
      'Return the JSON object now: {"tailored":{…},"changes":[…]}.',
    ].filter(Boolean).join("\n\n");
    const messages = [{ role: "system", content: TAILOR_SYSTEM }, { role: "user", content: user }];
    const { parsed, res } = await callGLMJson(settings, messages, {
      onDelta, task: "tailor",
      // Shape-strict but repair-tolerant: a `tailored` object with an experience_details
      // array + a `changes` array. Drift gets the one corrective retry in callGLMJson.
      validate: (p) => p && typeof p === "object" && p.tailored && typeof p.tailored === "object"
        && Array.isArray(p.tailored.experience_details) && Array.isArray(p.changes),
    });
    const clean = sanitizeTailored(source, parsed);
    return { tailored: clean.tailored, changes: clean.changes, reasoning: res.reasoning, usage: res.usage };
  }

  // "12.3k in (4.1k cached) · 0.8k out · $0.0031" — cached comes from Z.AI's automatic
  // prompt cache; cost is OpenRouter's per-request USD figure (usage.include is always on).
  function usageLine(usage) {
    if (!usage) return "";
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
    const cached = usage.prompt_tokens_details?.cached_tokens || 0;
    const parts = [`${k(usage.prompt_tokens || 0)} in${cached ? ` (${k(cached)} cached)` : ""}`,
      `${k(usage.completion_tokens || 0)} out`];
    const cost = usageCost(usage);
    if (cost != null) parts.push(`$${cost.toFixed(4)}`);
    return parts.join(" · ");
  }

  // OpenRouter reports the request's USD cost in the final usage chunk. Never estimated:
  // absent cost = absent (the spend counter only sums what the API actually billed).
  function usageCost(usage) {
    const c = usage?.cost ?? usage?.total_cost;
    return typeof c === "number" && isFinite(c) ? c : null;
  }

  // Only the surface sidepanel.js actually calls — everything else stays module-private.
  return {
    DEFAULT_MODEL, CONFIG_LEGAL_KEYS,
    mapFields, coverLetter, parseResumeToProfile, answerBatch, resolveConfigValues,
    isLegalField, legalAnswerFor, partitionFields, validateMappings, usageLine, usageCost,
    tailor, sanitizeTailored,
  };
})();

// Node test reachability: the browser loads ai.js as a plain script and reads the JA_AI
// global (harness.mjs's new-Function sandbox does the same). Mirror that as a CommonJS
// export when a module system is present, without disturbing the plain-script path.
if (typeof module !== "undefined" && module.exports) module.exports = JA_AI;
