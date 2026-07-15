// jobApplier config-driven fill engine (step 2, docs/03 "hybrid fill" primary path).
// Interprets reference/ats-selectors.json entries per reference/fill-strategies.md (the
// per-element fill methods) and reference/actions-dsl.md (the actions step machine,
// placeholder grammar, repeating sections, and trackedObjExtractors) — semantics
// reconciled against the de-minified upstream interpreter, reimplemented from scratch.
//
// Values are RESOLVED ELSEWHERE (ai.js resolveConfigValues, verbatim-from-profile for
// legal keys) — this engine never invents, derives, or guesses a value. A key absent
// from `values` is reported "no-value" and the field is left alone, EVEN for keys the
// upstream engine would fill with an implicit empty (sponsorship/over18/…): an unset
// legal answer must stay unset (rule #1), so undefined always means "don't touch".
//
// Standalone on purpose: no chrome.* APIs, no dependency on content-ats.js — fixture
// unit tests load this file into a bare page and drive it directly. In the extension it
// runs as a content script before content-ats.js (which owns messaging).
"use strict";

// `var` (not `const`) so on-demand injection (activeTab) landing on top of the declared
// content script re-declares without a SyntaxError. The IIFE re-runs harmlessly — the
// engine is stateless pure functions over the live `document`, so a fresh instance per
// injection is equivalent (and, unlike caching `globalThis.JA_CFG`, stays correct when
// the same realm is reused across documents).
var JA_CFG = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  // Same labelContains fold semantics as content-ats.js/ai.js (duplicated on purpose —
  // isolated JS contexts, no build step).
  const fold = (s) => norm(s).toLowerCase().replace(/[/:_\-,.;()?!*&'"’]+/g, " ").replace(/\s+/g, " ").trim();
  const toArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

  // Default poll budgets (upstream: ep/tp = 4000, np = 3000).
  const STEP_WAIT_MS = 4000;
  const POLL_MS = 50;
  // Test hook: the all-52 structural walk runs against empty DOMs where every wait
  // would otherwise burn its full budget. 1 = production.
  let TIME_SCALE = 1;
  const scaled = (ms) => Math.max(1, Math.round((ms ?? 0) * TIME_SCALE));

  // Rule #2 (career pages only): LinkedIn is the account-ban vector — its playbook is
  // never executed even though the reference config ships one.
  const BLOCKED_ATS = new Set(["LinkedIn"]);

  // Keys refused by design:
  //  - clear_profile / delete_extra can WIPE data the user already saved in the ATS
  //    account (upstream clears before refilling; we never destroy user state).
  //  - the source family is "how did you hear about us" — the upstream config injects
  //    its own product name here; answering it mechanically (let alone with someone
  //    else's product name) would be dishonest. User/LLM-with-review territory.
  const SKIP_KEYS = new Set([
    "clear_profile", "delete_extra",
    "source", "source_other", "source_description", "referred_by",
  ]);

  // Keys whose value must come from the RESOLVER only — a config-editorial sel.value
  // (upstream hardcodes transgender="No", salary=100000) must never fill them.
  const SENSITIVE_VALUE_KEYS = new Set([
    "salary", "salary_requirements", "desired_salary", "expected_salary", "compensation",
    "hasExperience", // editorial value:true would claim work history an empty profile never stated
  ]);

  // ------------------------------------------------------------------ URL matching

  // Config url patterns are chrome-match-pattern-ish globs. * and ** both cross "/"
  // (chrome path-wildcard semantics); regex specials are escaped.
  const rxCache = new Map();
  function patternToRegex(pattern) {
    let rx = rxCache.get(pattern);
    if (!rx) {
      const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
      rx = new RegExp(`^${esc}$`, "i");
      rxCache.set(pattern, rx);
    }
    return rx;
  }
  const urlMatchesAny = (patterns, url) => toArray(patterns).some((p) => patternToRegex(p).test(url));

  // First config entry whose urls match (and urlsExcluded don't); JSON insertion order
  // is the upstream precedence.
  function detectAts(atsConfig, url) {
    if (!url || !/^https?:/i.test(url)) return null;
    for (const [name, entry] of Object.entries(atsConfig || {})) {
      if (!entry || !entry.urls) continue;
      if (!urlMatchesAny(entry.urls, url)) continue;
      if (entry.urlsExcluded && urlMatchesAny(entry.urlsExcluded, url)) continue;
      if (BLOCKED_ATS.has(name)) return { name, entry: null, blocked: true };
      return { name, entry };
    }
    return null;
  }

  // ------------------------------------------------------------------ placeholders (DSL §2)

  // XPath string literals can't contain the quote that delimits them; substituted
  // values drop double quotes (never present in real option labels worth matching).
  const xpathSafe = (s) => String(s ?? "").replace(/"/g, "");

  // Ordered passes: numbered index tokens (with provided values) → unresolved-defaults
  // cleanup (INDEX→0, NUMBER→1, LENGTH→0, LENGTHPLUSONE→1) → value tokens → %INPUTPATH%.
  function subPlaceholders(template, subs = {}) {
    let e = template;
    if (!/%[A-Za-z0-9[\]]+%/.test(e)) return e;
    const indexes = toArray(subs.indexes);
    const lengths = toArray(subs.lengths);
    for (let n = 0; n < indexes.length; n++) {
      e = e.replace(new RegExp(`%INDEX${n}%`, "g"), String(indexes[n]))
        .replace(new RegExp(`%NUMBER${n}%`, "g"), String(indexes[n] + 1));
    }
    for (let n = 0; n < lengths.length; n++) {
      e = e.replace(new RegExp(`%LENGTH${n}%`, "g"), String(lengths[n]))
        .replace(new RegExp(`%LENGTHPLUSONE${n}%`, "g"), String(lengths[n] + 1));
    }
    e = e.replace(/%INDEX[0-9]+%/g, "0").replace(/%NUMBER[0-9]+%/g, "1")
      .replace(/%LENGTH[0-9]+%/g, "0").replace(/%LENGTHPLUSONE[0-9]+%/g, "1");

    const v = xpathSafe(subs.value ?? "");
    const u = xpathSafe(subs.unmapped ?? subs.value ?? "");
    // Function replacements: a value containing $&/$'/$` must never rewrite the template.
    e = e.replace(/%VALUE%/g, () => v).replace(/%UNMAPPEDVALUE%/g, () => u)
      .replace(/%UPPERVALUE%/g, () => v.toUpperCase()).replace(/%UPPERUNMAPPEDVALUE%/g, () => u.toUpperCase())
      .replace(/%LOWERVALUE%/g, () => v.toLowerCase()).replace(/%LOWERUNMAPPEDVALUE%/g, () => u.toLowerCase())
      .replace(/%value%/g, () => v.toLowerCase()); // 38 config sites use the lowercase token
    return e.replace(/%INPUTPATH%/g, () => subs.inputPath || "");
  }

  // ------------------------------------------------------------------ XPath (+ shadow DOM, DSL §5)

  const SHADOW_TOKEN = "/shadow-root/";

  function evalPlain(xpath, ctxNode, out) {
    try {
      const snap = document.evaluate(xpath, ctxNode || document, null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < snap.snapshotLength; i++) {
        const n = snap.snapshotItem(i);
        if (n.nodeType === 1) out.push(n);
      }
    } catch { /* malformed config XPath: skip, never throw */ }
    return out;
  }

  // Native XPath can't cross shadow roots: split on "/shadow-root/", evaluate the
  // prefix, then recurse with "." + suffix against each shadow child (elements inside
  // a shadow tree are valid XPath context nodes; the fragment itself is not).
  function xEval(xpath, ctxNode, out = []) {
    if (typeof xpath !== "string" || !xpath) return out;
    const cut = xpath.indexOf(SHADOW_TOKEN);
    if (cut === -1) return evalPlain(xpath, ctxNode, out);
    const prefix = xpath.slice(0, cut);
    const suffix = "." + xpath.slice(cut + SHADOW_TOKEN.length - 1); // "./…" or ".//…"
    const hosts = [];
    evalPlain(prefix, ctxNode, hosts);
    // ".//x" from a child never matches the child itself — union in a self:: variant
    // so direct shadow-root children (ADP/SF web components render inputs there) hit.
    const selfSuffix = suffix.startsWith(".//") ? `self::${suffix.slice(3)}` : null;
    const combined = selfSuffix ? `${suffix} | ${selfSuffix}` : suffix;
    for (const host of hosts) {
      if (!host.shadowRoot) continue;
      for (const child of host.shadowRoot.children) xEval(combined, child, out);
    }
    return out;
  }

  // Upstream visibility test (Gf): has a client rect and visibility ≠ hidden. File
  // inputs pass regardless — upload widgets conventionally hide them.
  function isVisible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    if ((el.type || "").toLowerCase() === "file") return true;
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  }

  function firstX(paths, ctxNode, subs) {
    for (const p of toArray(paths)) {
      if (typeof p !== "string") continue;
      let els = xEval(subPlaceholders(p, subs), ctxNode)
        .filter((el) => (el.type || "").toLowerCase() !== "hidden"); // Rails hidden-twin guard
      if (els.length) return els.find(isVisible) || els[0];
    }
    return null;
  }
  const xExists = (paths, ctxNode, subs) => !!firstX(paths, ctxNode, subs);

  async function waitFor(paths, timeoutMs, ctxNode, subs, { removed = false, signal } = {}) {
    const deadline = Date.now() + scaled(Math.min(Math.max(timeoutMs || STEP_WAIT_MS, POLL_MS), 120000)); // config max is 75s
    for (;;) {
      if (signal?.aborted) return null;
      const el = firstX(paths, ctxNode, subs);
      if (removed ? !el : el) return removed ? true : el;
      if (Date.now() >= deadline) return null;
      await sleep(POLL_MS);
    }
  }

  // ------------------------------------------------------------------ event primitives
  // Verified sequences from reference/fill-strategies.md.

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      el instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
      el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
    try {
      if (setter) setter.call(el, value); else el.value = value;
    } catch { /* file inputs reject programmatic non-empty values */ }
  }

  const evOpts = (extra) => ({ bubbles: true, cancelable: true, view: window, ...(extra || {}) });
  const mouse = (type, o) => new MouseEvent(type, evOpts(o));

  // Legacy widgets gate on e.keyCode/e.which, which the constructor leaves 0 — shim.
  function keyEvent(type, o = {}) {
    const k = o.key || "";
    const ev = new KeyboardEvent(type, evOpts(o));
    const code = o.keyCode ?? (k === "Escape" ? 27 : k === "Enter" ? 13 : k === "Tab" ? 9 :
      (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0));
    if (code) {
      Object.defineProperty(ev, "keyCode", { get: () => code });
      Object.defineProperty(ev, "which", { get: () => code });
    }
    return ev;
  }

  function fireFocus(el) {
    el.focus?.();
    el.dispatchEvent(new FocusEvent("focus"));
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  }
  function fireBlur(el) {
    el.dispatchEvent(new FocusEvent("blur"));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    el.blur?.();
  }
  const fireTextInput = (el) => el.dispatchEvent(new CustomEvent("textInput", { bubbles: true, cancelable: true }));
  const fireInput = (el, data) =>
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: data ?? null }));
  const fireChange = (el) => el.dispatchEvent(new Event("change", { bubbles: true }));

  // The production `click`: focus → mousedown → mouseup → click() → blur. mousedown is
  // what opens react-selects (they ignore bare click events) — the step-1 review
  // finding, now the engine default. eventOptions: {clickOnly} = bare click,
  // {noBlur} = keep focus (menus close on blur).
  function methodClick(el, o = {}) {
    if (o.clickOnly) {
      if (typeof el.click === "function") el.click(); else el.dispatchEvent(mouse("click", o));
      return;
    }
    el.dispatchEvent(new FocusEvent("focus"));
    el.dispatchEvent(mouse("mousedown", o));
    el.dispatchEvent(mouse("mouseup", o));
    if (typeof el.click === "function") el.click(); else el.dispatchEvent(mouse("click", o));
    if (!o.noBlur) el.dispatchEvent(new FocusEvent("blur"));
  }

  function dispatchNamedEvent(el, name, options) {
    const o = evOpts(options);
    if (/^key(down|up|press)$/.test(name)) { el.dispatchEvent(keyEvent(name, o)); return; }
    if (/^(mouse|pointer)|^(click|dblclick|contextmenu)$/.test(name)) {
      try { el.dispatchEvent(name.startsWith("pointer") ? new PointerEvent(name, o) : new MouseEvent(name, o)); }
      catch { el.dispatchEvent(new Event(name, o)); }
      return;
    }
    if (/^(focus|blur|focusin|focusout)$/.test(name)) { el.dispatchEvent(new FocusEvent(name, o)); return; }
    if (name === "input") { el.dispatchEvent(new InputEvent("input", o)); return; }
    el.dispatchEvent(new Event(name, o));
  }

  // ------------------------------------------------------------------ option matching

  // exact fold → token containment (unique) → 4-char prefix (unique); ambiguity = no
  // match (same conservative tiers as the step-1 LLM path).
  function bestMatch(labels, wantedList) {
    const cand = labels.map((label, index) => ({ index, f: fold(label) })).filter((c) => c.f);
    for (const want of wantedList) {
      const w = fold(String(want));
      if (!w) continue;
      let hits = cand.filter((c) => c.f === w);
      if (hits.length) return hits[0].index;
      const wTok = new Set(w.split(" "));
      const subset = (a, b) => [...a].every((t) => b.has(t));
      hits = cand.filter((c) => {
        const cTok = new Set(c.f.split(" ").filter(Boolean));
        return cTok.size && (subset(cTok, wTok) || subset(wTok, cTok));
      });
      if (hits.length === 1) return hits[0].index;
      if (w.length >= 4) {
        hits = cand.filter((c) => c.f.startsWith(w.slice(0, 4)));
        if (hits.length === 1) return hits[0].index;
      }
    }
    return -1;
  }

  // ------------------------------------------------------------------ value candidates

  // Builds the ranked [{value, unmapped}] candidate list for one selector (upstream Jf):
  //  - `values` as a STRING names a global map in ctx.maps (value-maps.json), e.g.
  //    "countryNamesToAbbreviations".
  //  - `values` as an object maps canonical→widget strings; {valueMap:"name", …} merges
  //    the named global map under the inline entries.
  //  - A map hit REPLACES the raw value (the raw survives as `unmapped` for
  //    %UNMAPPEDVALUE%); values[""] is the fallback branch for falsy/unmatched values.
  //  - spec.alts (our extension: same-fact alternates like state abbreviation↔name)
  //    append after, never before, the canonical candidates.
  function buildCandidates(selValues, rawVal, spec, maps) {
    const raws = Array.isArray(rawVal) ? [...rawVal] : [rawVal];
    let out = raws.map((r) => ({ value: r, unmapped: r }));
    let vmap = selValues;
    if (typeof vmap === "string") vmap = maps?.[vmap] || null;
    else if (vmap && typeof vmap === "object" && typeof vmap.valueMap === "string") {
      vmap = { ...(maps?.[vmap.valueMap] || {}), ...vmap };
      delete vmap.valueMap;
    }
    if (vmap && typeof vmap === "object") {
      const mapped = [];
      for (const r of raws) {
        if (r == null) continue; // absent is never a value — rule #1
        const hit = vmap[String(r)];
        if (hit !== undefined) for (const m of toArray(hit)) mapped.push({ value: m, unmapped: r });
        else if ((r === "" || r === false) && vmap[""] !== undefined) {
          for (const m of toArray(vmap[""])) mapped.push({ value: m, unmapped: "" });
        }
      }
      // Upstream falls back to the "" branch for ANY unmatched value (safe there — its
      // profile values are pre-normalized). We only allow it for explicit falsy values:
      // an unmatched truthy answer, and especially an ABSENT one, must never silently
      // become the "No" branch of a work-auth/EEO map (rule #1).
      if (!mapped.length && vmap[""] !== undefined && raws.length &&
          raws.every((r) => r === "" || r === false)) {
        for (const m of toArray(vmap[""])) mapped.push({ value: m, unmapped: "" });
      }
      if (mapped.length) out = mapped;
      else if (raws.every((r) => r == null)) return [];
    }
    for (const alt of toArray(spec?.alts)) out.push({ value: alt, unmapped: rawVal });
    const seen = new Set();
    return out.filter((c) => {
      const k = String(c.value);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  const specVal = (spec) => (spec && typeof spec === "object" && "v" in spec ? spec.v : spec);

  function truncate(value, sel) {
    let v = String(value ?? "");
    if (sel.characterLimit && v.length > sel.characterLimit) v = v.slice(0, sel.characterLimit);
    if (sel.wordLimit) {
      const words = v.split(/\s+/);
      if (words.length > sel.wordLimit) v = words.slice(0, sel.wordLimit).join(" ");
    }
    return v;
  }

  // ------------------------------------------------------------------ upload (DataTransfer)

  function makeFile(fileSpec) {
    if (!fileSpec) return null;
    if (typeof File !== "undefined" && fileSpec instanceof File) return fileSpec;
    const bytes = fileSpec.bytes instanceof Uint8Array ? fileSpec.bytes : new Uint8Array(fileSpec.bytes || []);
    return new File([bytes], fileSpec.name || "file", { type: fileSpec.type || "application/octet-stream" });
  }

  function uploadFile(el, file) {
    let input = el;
    if (!(input instanceof HTMLInputElement) || input.type !== "file") {
      input = el.querySelector?.('input[type="file"]') ||
        el.closest?.("form, div, section")?.querySelector('input[type="file"]');
    }
    if (!input) return { status: "no-file-input" };
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    fireInput(input);
    fireChange(input);
    return { status: "filled", chose: file.name };
  }

  // ------------------------------------------------------------------ widget handlers

  async function fillTextLike(el, value, { blur = true, vanilla = false, change = true } = {}) {
    fireFocus(el);
    if (vanilla) el.value = value; else setNativeValue(el, value);
    fireInput(el, value);
    if (change) fireChange(el);
    if (blur) { await sleep(10); fireBlur(el); } // 10ms tick: let React flush before focus leaves
    return { status: "filled" };
  }

  // react: focus → keydown/keypress → native set → input → keyup → change (no blur —
  // the framework variant of the text fill; blur is the `default` router's job).
  // react: setNativeValue + input, per fill-strategies.md — no fabricated key events
  // (widgets that read e.key can misbehave on them) and no change/blur (that is the
  // `default` router's job).
  async function fillReact(el, value) {
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
      return polymorphicFill(el, value, [String(value)], null, {}, { blur: false });
    }
    fireFocus(el);
    setNativeValue(el, value);
    fireInput(el, value);
    return { status: "filled" };
  }

  // <select>: focus → click → set → textInput → input → change → click → blur (the
  // double click + legacy textInput make stubborn custom-styled selects register).
  // valuePath templates (substituted with %INPUTPATH%/%VALUE%) pick the <option> when
  // the config provides them; otherwise options match by text then by value.
  async function fillSelectEl(el, candidates, sel, subs) {
    let idx = -1;
    if (sel?.valuePath && subs?.inputPath) {
      const budget = scaled(sel.valueElementTime || 0);
      const deadline = Date.now() + budget;
      do {
        for (const cand of candidates) {
          const opt = firstX(sel.valuePath, el.ownerDocument, { ...subs, value: cand.value, unmapped: cand.unmapped });
          if (opt && opt.tagName === "OPTION") { idx = [...el.options].indexOf(opt); if (idx >= 0) break; }
        }
        if (idx >= 0 || Date.now() >= deadline) break;
        await sleep(POLL_MS * 2);
      } while (idx < 0);
    }
    const wanted = candidates.map((c) => c.value);
    if (idx < 0) idx = bestMatch([...el.options].map((o) => norm(o.textContent)), wanted);
    if (idx < 0) idx = bestMatch([...el.options].map((o) => o.value), wanted);
    if (idx < 0) {
      return { status: "no-option-match", optionsSeen: [...el.options].map((o) => norm(o.textContent)).slice(0, 50) };
    }
    fireFocus(el);
    el.dispatchEvent(mouse("click"));
    setNativeValue(el, el.options[idx].value);
    fireTextInput(el);
    fireInput(el);
    fireChange(el);
    el.dispatchEvent(mouse("click"));
    await sleep(10);
    fireBlur(el);
    return { status: "filled", chose: norm(el.options[idx].textContent) };
  }

  // checkbox/radio: skip if already in the desired state; else focus → (checkbox:
  // el.click() / radio: click event + set checked) → textInput → input → change → blur.
  async function fillCheckable(el, desired) {
    if (!(el instanceof HTMLInputElement) || (el.type !== "checkbox" && el.type !== "radio")) {
      const inner = el.querySelector?.('input[type="checkbox"], input[type="radio"]');
      if (!inner) return { status: "no-option-match", note: "no checkable control here" };
      el = inner;
    }
    if (el.checked === desired) return { status: "already-set" };
    fireFocus(el);
    if (el.type === "checkbox") el.click();
    else { el.dispatchEvent(mouse("click")); el.checked = desired; }
    fireTextInput(el);
    fireInput(el);
    fireChange(el);
    await sleep(10);
    fireBlur(el);
    return { status: "filled" };
  }

  const TRUTHY_RE = /^(yes|y|true|1|on|checked|agreed?|accept(ed)?|i agree|i accept|confirm(ed)?)\b/;
  const FALSY_RE = /^(no|n|false|0|off|unchecked|declined?|disagree|do not|don t)\b/;
  const isTruthy = (v) => {
    if (v == null || v === "" || v === false) return false;
    if (typeof v !== "string") return true;
    const f = fold(v);
    return !FALSY_RE.test(f);
  };

  const isComboInput = (el) =>
    el.tagName === "INPUT" && (
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-autocomplete") === "list" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      /select__input|autocomplete|combobox/i.test(el.className || ""));

  function findMenuOptions(el) {
    const doc = el.ownerDocument;
    const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    let root = id ? doc.getElementById(id) : null;
    if (!root) root = doc.querySelector('[class*="select__menu"], [role="listbox"]');
    if (!root) return [];
    const noise = /^(no (options|results|matches)( found)?|loading|searching|start typing|type to search|please select|select( one)?|choose( one)?)(\.{3}|…)?$/;
    const ok = (n) => isVisible(n) && !!fold(n.textContent) && !noise.test(fold(n.textContent)) &&
      !/menu-notice|loading|placeholder/i.test(n.className || "");
    const opts = [...root.querySelectorAll('[role="option"]')].filter(ok);
    return opts.length ? opts : [...root.querySelectorAll('[class*="option"], li')].filter(ok);
  }

  // Engine-level combobox fallback for selectors that land on a react-select input with
  // a plain text method (no explicit actions choreography in the config): mousedown
  // opens, type the query, poll the menu, real-click the match. Mirrors the verified
  // step-1 LLM-path sequence.
  async function fillComboInput(el, candidates) {
    const wanted = candidates.map((c) => c.value);
    const control = el.closest('[class*="control"]') || el.parentElement || el;
    control.dispatchEvent(mouse("mousedown"));
    control.dispatchEvent(mouse("mouseup"));
    fireFocus(el);
    const query = String(wanted[0] ?? "");
    let opts = [];
    const dl0 = Date.now() + scaled(250); // static menus render immediately
    while (Date.now() < dl0 && !(opts = findMenuOptions(el)).length) await sleep(60);
    let idx = bestMatch(opts.map((o) => norm(o.textContent)), wanted);
    if (idx < 0) {
      setNativeValue(el, "");
      fireInput(el);
      el.dispatchEvent(keyEvent("keydown", { key: query[0] || "a" }));
      setNativeValue(el, query);
      fireInput(el, query);
      let deadline = Date.now() + scaled(5000);
      while (Date.now() < deadline) {
        opts = findMenuOptions(el);
        idx = bestMatch(opts.map((o) => norm(o.textContent)), wanted);
        if (idx >= 0) break;
        await sleep(150);
      }
      if (idx < 0 && query.length > 4) { // over-filtering typeaheads: retry with a prefix
        setNativeValue(el, query.slice(0, 4));
        fireInput(el);
        deadline = Date.now() + scaled(4000);
        while (Date.now() < deadline) {
          opts = findMenuOptions(el);
          idx = bestMatch(opts.map((o) => norm(o.textContent)), wanted);
          if (idx >= 0) break;
          await sleep(150);
        }
      }
    }
    if (idx < 0) {
      const optionsSeen = opts.map((o) => norm(o.textContent)).slice(0, 50);
      setNativeValue(el, ""); // never leave typed junk behind — it can get submitted
      fireInput(el);
      el.dispatchEvent(keyEvent("keydown", { key: "Escape" }));
      fireBlur(el);
      return { status: "no-option-match", optionsSeen };
    }
    methodClick(opts[idx], { noBlur: true });
    await sleep(10);
    return { status: "filled", chose: norm(opts[idx].textContent) };
  }

  // Rich-text editors. tinyMCE's page API is unreachable from an isolated world;
  // setting the editable body + input events covers the DOM side (best-effort).
  function fillRichText(el, value) {
    let target = el;
    if (el.tagName === "IFRAME") target = el.contentDocument?.body;
    if (target && !target.isContentEditable && target.getAttribute?.("contenteditable") !== "true") {
      target = target.querySelector?.('[contenteditable="true"]') || target;
    }
    if (!target) return { status: "not-found" };
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
      setNativeValue(target, value);
      fireInput(target, value);
      fireChange(target);
      return { status: "filled" };
    }
    target.innerHTML = "";
    for (const line of String(value).split("\n")) {
      const p = target.ownerDocument.createElement("p");
      p.textContent = line;
      target.appendChild(p);
    }
    fireInput(target, value);
    fireChange(target);
    return { status: "filled" };
  }

  // Legacy widget frameworks (dijit/ADP, ui5/SuccessFactors, jQuery-triggered). Their
  // real APIs live in the page world; from the isolated world we set the value
  // natively and fire the volley these frameworks poll on. Flagged legacy-best-effort
  // so coverage reporting stays honest.
  async function fillLegacy(el, value, candidates, sel, ctx, subs) {
    if (el.tagName === "SELECT") return fillSelectEl(el, candidates, sel, subs);
    if (el.type === "checkbox" || el.type === "radio") {
      return { ...(await fillCheckable(el, el.type === "radio" ? true : isTruthy(value))), note: "legacy-best-effort" };
    }
    fireFocus(el);
    el.dispatchEvent(keyEvent("keydown", { key: String(value).slice(-1) || "a" }));
    setNativeValue(el, value);
    fireTextInput(el);
    fireInput(el, value);
    el.dispatchEvent(keyEvent("keyup", { key: String(value).slice(-1) || "a" }));
    fireChange(el);
    await sleep(10);
    fireBlur(el);
    return { status: "filled", note: "legacy-best-effort" };
  }

  // Workable-style react date picker: click opens the calendar, click the month cell
  // matching "MM/YYYY"; falls back to typing (many pickers accept keyboard input).
  async function fillReactDatePickerMonth(el, value) {
    methodClick(el, { noBlur: true });
    fireFocus(el);
    const doc = el.ownerDocument;
    let picker = null;
    const dl = Date.now() + scaled(2000);
    while (Date.now() < dl && !picker) {
      picker = [...doc.querySelectorAll('[class*="datepicker"], [class*="DatePicker"], [class*="calendar"]')].find(isVisible) || null;
      if (!picker) await sleep(100);
    }
    const m = String(value).match(/^(\d{1,2})[/\-. ](\d{4})$/);
    if (picker && m) {
      const monthName = new Date(2000, Number(m[1]) - 1, 1).toLocaleString("en-US", { month: "long" });
      const short = monthName.slice(0, 3);
      const cells = [...picker.querySelectorAll("button, [role='option'], td, div")]
        .filter((c) => isVisible(c) && c.children.length === 0);
      const hit = cells.find((c) => {
        const t = fold(c.textContent);
        return t === fold(monthName) || t === fold(short) || t === fold(`${short} ${m[2]}`) || t === fold(`${monthName} ${m[2]}`);
      });
      if (hit) { methodClick(hit, { noBlur: true }); await sleep(10); return { status: "filled", chose: norm(hit.textContent) }; }
    }
    return fillTextLike(el, value, { blur: false });
  }

  // The polymorphic `default` router (fill-strategies.md: "one default covers every
  // widget type"): select → select handler, button → click, checkbox/radio → check
  // handler, combobox → typeahead flow, input/textarea → native-value set.
  async function polymorphicFill(el, value, wantedList, sel, subs, { blur = true, ctx = null, plainText = false } = {}) {
    const candidates = wantedList.map((w) => ({ value: w, unmapped: value }));
    if (el.tagName === "SELECT") return fillSelectEl(el, candidates, sel, subs);
    if (el.tagName === "BUTTON" || el.getAttribute?.("role") === "button") {
      methodClick(el, { noBlur: !blur });
      return { status: "filled" };
    }
    if (el.type === "checkbox") return fillCheckable(el, isTruthy(value));
    if (el.type === "radio") return fillCheckable(el, true);
    if (el.type === "file") return { status: "needs-file" };
    // Engine-level typeahead auto-flow is for BARE selectors only: inside an actions
    // choreography the config drives the menu itself (plainText = just set the text).
    if (!plainText && isComboInput(el)) return fillComboInput(el, candidates);
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
      if (el.isContentEditable) return fillRichText(el, value);
      const inner = el.querySelector?.("input, textarea, select");
      if (inner) return polymorphicFill(inner, value, wantedList, sel, subs, { blur, ctx });
      methodClick(el, { noBlur: !blur });
      return { status: "filled", note: "clicked-non-input" };
    }
    return fillTextLike(el, value, { blur });
  }

  // Methods that act without a profile value (navigation clicks, blurs, uploads, …).
  const NO_VALUE_METHODS = new Set([
    "click", "reactClick", "blur", "clearValue", "tptEnableResume", "uploadResume", "uploadCoverLetter",
  ]);

  async function applyMethod(method, el, rawValue, candidates, sel, subs, ctx, eventOptions, inActions = false) {
    const value = truncate(rawValue, sel || {});
    const wanted = candidates.map((c) => String(c.value));
    // entry.defaultEventOptions (SmartRecruiters/Workable) is the base for every call.
    const o = { ...(ctx?.entry?.defaultEventOptions || {}), ...(eventOptions || {}) };
    switch (method) {
      case "default": return polymorphicFill(el, value, wanted, sel, subs, { blur: !o.noBlur, ctx, plainText: inActions });
      case "defaultWithoutBlur": return polymorphicFill(el, value, wanted, sel, subs, { blur: false, ctx, plainText: inActions });
      case "vanillaWithBlur":
        if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "radio") {
          return polymorphicFill(el, value, wanted, sel, subs, { blur: true, ctx });
        }
        return fillTextLike(el, value, { blur: true, vanilla: true });
      case "react": return fillReact(el, value);
      case "reactClick": methodClick(el, { ...o, noBlur: true }); return { status: "filled" };
      case "click": case "tptEnableResume":
        methodClick(el, o);
        return { status: "filled" };
      case "selectCheckboxOrRadio": {
        // Spec: find the matching control and CHECK it — never uncheck. A falsy value
        // means the values/valuePath machinery picks the "No" element, which still gets
        // checked; with no such mapping and a falsy value there is nothing to select.
        if (el.type === "checkbox" && !sel?.values && !sel?.valuePathMap && !sel?.valuePath &&
            !isTruthy(specToBool(value, candidates))) {
          return { status: "no-value" };
        }
        return fillCheckable(el, true);
      }
      case "clearValue": setNativeValue(el, ""); fireInput(el); return { status: "filled" };
      case "blur": fireBlur(el); return { status: "filled" };
      case "setValueOnly": setNativeValue(el, value); return { status: "filled" };
      case "setValue": setNativeValue(el, value); fireInput(el, value); return { status: "filled" };
      case "uploadResume": {
        const f = makeFile(ctx?.files?.resume);
        return f ? uploadFile(el, f) : { status: "no-file" };
      }
      case "uploadCoverLetter": {
        const f = makeFile(ctx?.files?.coverLetter);
        return f ? uploadFile(el, f) : { status: "no-file" };
      }
      case "writeCoverLetter": {
        const text = ctx?.coverLetterText || value;
        return text ? fillRichText(el, text) : { status: "no-value" };
      }
      case "tinyMCE": return fillRichText(el, value);
      case "reactDatePickerMonth": return fillReactDatePickerMonth(el, value);
      case "dijit": case "ui5": case "jQuery": return fillLegacy(el, value, candidates, sel, ctx, subs);
      default:
        // Unknown method from a future config refresh: run the polymorphic default but
        // note the vocabulary gap so coverage reports show it.
        return { ...(await polymorphicFill(el, value, wanted, sel, subs, { blur: true, ctx })), note: `unknown-method:${method}` };
    }
  }

  // selectCheckboxOrRadio on a single checkbox: the candidate list (post values-map) is
  // the desired state when it looks boolean; otherwise the raw value decides.
  function specToBool(value, candidates) {
    for (const c of candidates) {
      const f = fold(String(c.value));
      if (TRUTHY_RE.test(f)) return true;
      if (FALSY_RE.test(f) || c.value === "") return false;
    }
    return value;
  }

  // ------------------------------------------------------------------ element claims

  // One element belongs to one field per run (upstream foundInputsByInput): stops
  // full_name/first_name-style double claims. Action steps always reuse.
  function claimElement(ctx, el, key, allowReuse) {
    const scopedKey = `${ctx.claimScope || ""}${key}`; // rows never share claims across entries
    const owner = ctx.usedEls.get(el);
    if (owner !== undefined && owner !== scopedKey && !allowReuse) return false;
    ctx.usedEls.set(el, scopedKey);
    return true;
  }

  // ------------------------------------------------------------------ actions runner (DSL §1)

  // Per-step order: delay → valueRequired gate → condition gate → wait for path
  // (appear / removed) → event/method. allowFailure skips a failed step; a failed step
  // without it fails the whole field.
  async function runActions(sel, mainEl, mainCandidates, ctx, subs) {
    let last = { status: "filled" };
    for (let i = 0; i < sel.actions.length; i++) {
      const step = sel.actions[i];
      if (ctx.signal?.aborted) return { status: "aborted" };
      if (step.delay) await sleep(scaled(Math.min(step.delay, 10000)));

      // Step value: explicit → other key's value → the field's own candidate.
      // Guarded fields never take config-authored step values OR valueKey redirects —
      // a step that insists on one is skipped outright.
      if (ctx.guardedField && (step.value !== undefined || step.valueKey)) continue;
      let stepRaw = step.value !== undefined ? step.value :
        step.valueKey ? specVal(lookupValues(ctx.values, step.valueKey)) :
        mainCandidates[0]?.unmapped;
      const stepCandidates = (step.values || step.value !== undefined || step.valueKey)
        ? buildCandidates(step.values, stepRaw, null, ctx.maps)
        : mainCandidates;
      if (step.valueRequired === true && (stepRaw == null || stepRaw === "")) {
        await sleep(scaled(200));
        continue; // DSL §1: an empty value skips THIS step; the rest still run
      }

      if (step.condition) {
        const condSubs = { ...subs, value: "", unmapped: "", inputPath: toArray(subs.inputPath)[0] || subs.inputPath };
        if (!toArray(step.condition).some((c) => xExists(c, ctx.container, condSubs))) continue;
      }

      let target = mainEl;
      if (step.path) {
        // "." (and self::*) means the field's own element — the config uses it for
        // "click save, wait until this thing leaves the DOM" choreography.
        const selfPath = toArray(step.path).every((x) => x === "." || x === "self::*");
        const cands = stepCandidates.length ? stepCandidates : [{ value: "", unmapped: "" }];
        const hasValueToken = /%[A-Z]*VALUE%/.test(toArray(step.path).join(" "));

        if (step.removed) {
          // DSL §1: wait for DISAPPEARANCE — no appear phase first. Already-absent
          // resolves immediately.
          const deadline = Date.now() + scaled(Math.min(Math.max(step.removedTime || step.time || STEP_WAIT_MS, POLL_MS), 120000));
          let gone = false;
          for (;;) {
            if (ctx.signal?.aborted) return { status: "aborted" };
            gone = selfPath
              ? !mainEl.isConnected
              : !cands.some((cand) => firstX(step.path, ctx.container, { ...subs, value: cand.value, unmapped: cand.unmapped }));
            if (gone || Date.now() >= deadline) break;
            await sleep(POLL_MS);
          }
          if (!gone && !step.allowFailure) return { status: "action-timeout", step: i, detail: "not-removed" };
          continue;
        }

        let found = selfPath ? mainEl : null;
        if (!found) {
          // One shared budget across candidates — alias lists must not multiply waits.
          const deadline = Date.now() + scaled(Math.min(Math.max(step.time || STEP_WAIT_MS, POLL_MS), 120000));
          for (;;) {
            if (ctx.signal?.aborted) return { status: "aborted" };
            for (const cand of cands) {
              found = firstX(step.path, ctx.container, { ...subs, value: cand.value, unmapped: cand.unmapped });
              if (found) break;
              if (!hasValueToken) break;
            }
            if (found || Date.now() >= deadline) break;
            await sleep(POLL_MS);
          }
        }
        if (!found) {
          if (step.allowFailure) continue;
          return { status: "action-timeout", step: i };
        }
        target = found;
      }

      if (step.event) {
        dispatchNamedEvent(target, step.event, { ...(ctx.entry?.defaultEventOptions || {}), ...(step.eventOptions || {}) });
        continue;
      }
      if (step.method) {
        const v = stepCandidates[0]?.value ?? stepRaw;
        // A step may override the selector's valuePath/valuePathMap/valueElementTime
        // (3 config sites do); merge shallowly for the method application.
        const stepSel = ("valuePath" in step || "valuePathMap" in step || "valueElementTime" in step)
          ? { ...sel, ...("valuePath" in step ? { valuePath: step.valuePath } : {}),
              ...("valuePathMap" in step ? { valuePathMap: step.valuePathMap } : {}),
              ...("valueElementTime" in step ? { valueElementTime: step.valueElementTime } : {}) }
          : sel;
        const r = await applyMethod(step.method, target, v, stepCandidates, stepSel, subs, ctx, step.eventOptions, true);
        if (r.status !== "filled" && r.status !== "already-set") {
          if (step.allowFailure) continue;
          return { ...r, step: i };
        }
        last = r;
      }
      // A bare {path, time} step is a pure wait — satisfied above.
    }
    return last;
  }

  // valueKey lookup. The dotted-path walk is speculative — no valueKey in the current
  // config contains a dot — kept only as a cheap net for future refreshes.
  function lookupValues(values, keyPath) {
    if (!values || !keyPath) return undefined;
    if (values[keyPath] !== undefined) return values[keyPath];
    if (!String(keyPath).includes(".")) return undefined;
    let cur = values;
    for (const part of String(keyPath).split(".")) {
      cur = cur == null ? undefined : (specVal(cur) ?? cur)[part];
      if (cur === undefined) return undefined;
    }
    return cur;
  }

  // ------------------------------------------------------------------ repeating sections (DSL §3)

  // Per entry i: substitute %INDEX0%=i / %NUMBER0%=i+1 into containerPath to scope the
  // row; if missing, click addButtonPath and wait for confirmAddedPath. We never click
  // removeExtraButtonPath — trimming rows the user may have hand-entered is destructive.
  async function fillArraySection(key, sel, entries, ctx, extraSubs) {
    let items = sel.limit ? entries.slice(0, sel.limit) : entries;
    if (sel.reverse) items = [...items].reverse();
    const out = [];
    for (let i = 0; i < items.length; i++) {
      if (ctx.signal?.aborted) break;
      const subs = { ...extraSubs, indexes: [...toArray(extraSubs.indexes), i], lengths: [...toArray(extraSubs.lengths), items.length] };
      // Row existence: containerPath when the config has one, else confirmAddedPath
      // (Rippling-style sections identify rows only by their confirm marker). The
      // confirm element is NEVER the fill container — sub-selectors scope by %INDEX0%
      // ids under the outer container when containerPath is absent.
      const probe = sel.containerPath || sel.confirmAddedPath;
      let cont = firstX(sel.containerPath, ctx.container, subs);
      let exists = cont || (sel.containerPath ? null : firstX(probe, ctx.container, subs));
      if (!exists && sel.addButtonPath) {
        if (ctx.dryRun) {
          out.push({ key: `${key}[${i}]`, status: "dry-run", note: "row would be added" });
          continue; // dry run must not mutate the form (audit-caught Add clicks)
        }
        const add = firstX(sel.addButtonPath, ctx.container, subs);
        if (add) {
          methodClick(add, { noBlur: true });
          exists = await waitFor(probe, 5000, ctx.container, subs, { signal: ctx.signal });
          if (sel.containerPath) cont = firstX(sel.containerPath, ctx.container, subs);
        }
      }
      if (!exists) {
        out.push({ key: `${key}[${i}]`, status: "no-entry-container" });
        continue;
      }
      if (i > 0 && ctx.entry?.fillInputGroupInterval && !ctx.dryRun) {
        await sleep(scaled(ctx.entry.fillInputGroupInterval));
      }
      const entryValues = items[i] && typeof items[i] === "object" ? items[i] : {};
      const entryCtx = {
        ...ctx,
        container: cont && !sel.refindPerEntry ? cont : ctx.container,
        values: entryValues,
        claimScope: `${ctx.claimScope || ""}${key}[${i}].`, // row-scoped element claims
      };
      for (const pair of toArray(sel.inputSelectors)) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const [subKey, subSelectors] = pair;
        const r = await fillOneField(subKey, subSelectors, entryCtx, subs);
        r.key = `${key}[${i}].${subKey}`;
        ctx.onProgress?.(r.key, r.status, r);
        out.push(r);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ single field

  async function fillOneField(key, selectorList, ctx, extraSubs = {}) {
    if (SKIP_KEYS.has(key)) return { key, status: "skipped-by-design" };
    const spec = ctx.values ? ctx.values[key] : undefined;
    const raw = specVal(spec);
    let sawValueless = false;
    let lastMiss = null;

    for (const rawSel of toArray(selectorList)) {
      const sel = typeof rawSel === "string" ? { path: rawSel } : rawSel && typeof rawSel === "object" ? { ...rawSel } : null;
      if (!sel) continue;
      if (sel.manual) return { key, status: "manual-by-config" };

      // Grouping selector (nested inputSelectors, not a repeating section): descend
      // into the nested pairs against the same container. Values scope down when the
      // key's value is itself a map of sub-specs; otherwise the current map stays.
      if (!sel.array && Array.isArray(sel.inputSelectors)) {
        const groupVal = specVal(spec);
        const subValues = groupVal && typeof groupVal === "object" && !Array.isArray(groupVal) ? groupVal : ctx.values;
        const subCtx = { ...ctx, values: subValues };
        const rows = [];
        let groupFilled = 0;
        for (const pair of sel.inputSelectors) {
          if (!Array.isArray(pair) || pair.length < 2) continue;
          const r = await fillOneField(pair[0], pair[1], subCtx, extraSubs);
          r.key = `${key}.${pair[0]}`;
          ctx.onProgress?.(r.key, r.status, r);
          if (r.status === "filled" || r.status === "already-set") groupFilled += 1;
          rows.push(r);
        }
        if (groupFilled) return { key, status: "filled", group: true, rows, filledRows: groupFilled };
        lastMiss = { key, status: rows[0]?.status || "not-found", group: true, rows };
        continue; // a later ranked selector may still handle the whole group
      }
      if (sel.path == null && !sel.array && !sel.actions && !sel.valuePathMap) continue;

      // Repeating section (array:true, nested inputSelectors).
      if (sel.array) {
        if (!Array.isArray(raw) || !raw.length) {
          return { key, status: raw == null ? "no-value" : "bad-array-value", array: true };
        }
        const rows = await fillArraySection(key, sel, raw, ctx, extraSubs);
        const filled = rows.filter((r) => r.status === "filled" || r.status === "already-set").length;
        return { key, status: filled ? "filled" : (rows[0]?.status || "not-found"), array: true, rows, filledRows: filled };
      }

      const method = sel.method || ctx.entry?.defaultMethod || "default";
      // Value precedence: resolver value (the user's profile, restated) → valueKey
      // redirect → config-editorial sel.value as LAST resort. Legal and sensitive keys
      // never take sel.value: the upstream config hardcodes answers there
      // (transgender="No", salary=100000) that must not be written for this user.
      const guarded = ctx.legalKeys?.has(key) || SENSITIVE_VALUE_KEYS.has(key);
      // Guarded keys consume ONLY their own resolved value: no valueKey redirects (the
      // config auto-signs Lever's CC-305 block from full_name/current_date, answers
      // "have you served" from protected-veteran status, pronouns from gender — all
      // cross-fact derivations rule #1 forbids) and no editorial sel.value literals.
      let selRaw = raw !== undefined && raw !== null ? raw :
        (!guarded && sel.valueKey) ? specVal(lookupValues(ctx.values, sel.valueKey)) : undefined;
      if (selRaw == null && sel.value !== undefined && !guarded) selRaw = sel.value;
      // No value → skip, unless the selector explicitly opts out (valueRequired:false),
      // the method acts valuelessly, or every value-consuming action step brings its
      // own value/valueKey. An unset profile answer must never turn into a fill.
      if (selRaw == null && sel.valueRequired !== false) {
        const actionsSelfSufficient = sel.actions?.length &&
          toArray(sel.actions).every((s) =>
            !s.method || NO_VALUE_METHODS.has(s.method) || s.value !== undefined || s.valueKey);
        // A values map / valuePathMap makes even a click selector value-dependent
        // (the value picks WHICH element to click) — absent value = don't touch.
        const valueDependent = sel.values != null || sel.valuePathMap != null;
        if ((valueDependent || !NO_VALUE_METHODS.has(method)) && !actionsSelfSufficient) {
          sawValueless = true;
          continue;
        }
      }

      // everyValue: run the selector once per value in a list (multi-check groups).
      const runs = sel.everyValue && Array.isArray(selRaw) ? selRaw : [selRaw];
      let allRunsOk = true;
      let runResult = null;

      for (const oneRaw of runs) {
        let candidates = buildCandidates(sel.values, oneRaw, spec && typeof spec === "object" ? spec : null, ctx.maps);
        if (!candidates.length) candidates = [{ value: oneRaw == null ? "" : oneRaw, unmapped: oneRaw == null ? "" : oneRaw }];

        // Resolve the element: value-major (each candidate across the path ladder),
        // honoring valuePathMap (value-keyed full paths) and the element claim map.
        let el = null, matchedPath = null, usedCand = candidates[0];
        const resolveWith = (pathList) => {
          for (const cand of candidates) {
            for (const p of toArray(pathList)) {
              const subs1 = { ...extraSubs, value: cand.value, unmapped: cand.unmapped };
              const substituted = subPlaceholders(p, subs1);
              let els = xEval(substituted, ctx.container)
                .filter((n) => (n.type || "").toLowerCase() !== "hidden"); // Rails hidden-twin guard
              if (sel.visible) els = els.filter(isVisible);
              else els = [...els.filter(isVisible), ...els.filter((n) => !isVisible(n))]; // prefer visible
              const pick = els.find((n) => claimElement(ctx, n, key, sel.allowReuse === true));
              if (pick) return { el: pick, matchedPath: substituted, cand };
            }
            if (!toArray(pathList).some((p) => /%[A-Z]*VALUE%/.test(p))) break; // more candidates can't change the result
          }
          return null;
        };

        let hit = null;
        if (sel.valuePathMap && typeof sel.valuePathMap === "object") {
          for (const cand of candidates) {
            const mapped = sel.valuePathMap[String(cand.unmapped)] ?? sel.valuePathMap[String(cand.value)];
            if (mapped === undefined) continue;
            hit = resolveWith(mapped);
            if (hit) break;
          }
          if (!hit && sel.valuePathMap[""] !== undefined) hit = resolveWith(sel.valuePathMap[""]);
        }
        if (!hit && sel.path != null) {
          hit = resolveWith(sel.path);
          if (!hit && sel.time) { // selector-level wait budget (config max is 75s)
            const deadline = Date.now() + scaled(Math.min(sel.time, 120000));
            while (!hit && Date.now() < deadline) {
              await sleep(POLL_MS);
              hit = resolveWith(sel.path);
            }
          }
          if (!hit && sel.fallbackValues) {
            const fb = buildCandidates(sel.fallbackValues, oneRaw, null, ctx.maps);
            if (fb.length) { candidates = fb; hit = resolveWith(sel.path); }
          }
        }
        if (!hit && sel.actions?.length && sel.path == null) {
          hit = { el: ctx.container, matchedPath: "", cand: candidates[0] }; // actions drive their own paths
        }
        if (!hit) { lastMiss = { key, status: "not-found" }; allRunsOk = false; continue; }
        ({ el, matchedPath } = hit);
        usedCand = hit.cand;

        const subs = {
          ...extraSubs,
          value: usedCand.value, unmapped: usedCand.unmapped, inputPath: matchedPath,
        };
        // valuePath on a non-<select>: the matched path found the QUESTION container;
        // valuePath locates the actual value control (radio/checkbox/option) inside it.
        // 260 config sites — incl. Greenhouse work_auth/EEO and Workday disability —
        // depend on this; failing to resolve must NOT fall through to filling the
        // container (a fabricated "filled" on a legal field).
        if (sel.valuePath && el.tagName !== "SELECT" && !sel.actions?.length) {
          const deadline = Date.now() + scaled(sel.valueElementTime || 1500);
          let target = null;
          for (;;) {
            for (const cand of candidates) {
              target = firstX(sel.valuePath, ctx.container, { ...subs, value: cand.value, unmapped: cand.unmapped });
              if (target) { subs.value = cand.value; subs.unmapped = cand.unmapped; break; }
            }
            if (target || Date.now() >= deadline) break;
            await sleep(POLL_MS * 2);
          }
          if (!target) {
            lastMiss = { key, name: sel.name, status: "no-option-match", method };
            allRunsOk = false;
            continue;
          }
          el = target;
        }
        // A text method landing on a file input is an upload in disguise (e.g. the
        // Greenhouse resume selector inherits defaultMethod:react but targets
        // input[type=file]) — route by the field's document, not the method.
        let effMethod = method;
        if (el instanceof HTMLInputElement && el.type === "file" &&
            !/^upload/.test(method) && !NO_VALUE_METHODS.has(method)) {
          effMethod = /cover/i.test(key) ? "uploadCoverLetter" : "uploadResume";
        }
        let res;
        if (ctx.dryRun) {
          res = { status: "dry-run", would: effMethod };
        } else if (sel.actions?.length) {
          const ordered = [usedCand, ...candidates.filter((c) => c !== usedCand)];
          res = await runActions(sel, el, ordered, { ...ctx, guardedField: guarded }, subs);
        } else {
          res = await applyMethod(effMethod, el, usedCand.value, candidates, sel, subs, ctx, sel.eventOptions);
        }
        res.method = effMethod;
        res.el = el;
        if (sel.actions?.length) res.viaActions = true; // dsl-actions path (telemetry)
        if (res.status === "filled" || res.status === "already-set" || res.status === "dry-run") {
          runResult = { key, name: sel.name, hidden: !!sel.hidden, value: String(usedCand.value ?? ""), ...res };
        } else {
          lastMiss = { key, name: sel.name, ...res };
          allRunsOk = false;
        }
      }
      if (runResult) {
        // everyValue with a partial miss: keep the successes (re-running the whole
        // list through a lower-ranked selector would double-fill the ones that landed).
        if (sel.everyValue && !allRunsOk) runResult.note = "partial (some values had no match)";
        return runResult;
      }
      if (lastMiss && lastMiss.status !== "not-found") return lastMiss;
      // not-found → try the next ranked selector
    }
    // Every lastMiss with a real status already returned inside the loop; here it is
    // null or "not-found".
    return { key, status: sawValueless ? "no-value" : "not-found" };
  }

  // ------------------------------------------------------------------ container & flow

  function resolveContainer(entry) {
    for (const p of toArray(entry.containerPath)) {
      // iframe containerPaths are the upstream same-frame piercing; with all_frames
      // injection the framed document runs its own engine, so skip iframe matches.
      const el = xEval(p, document).find((n) => n.tagName !== "IFRAME");
      if (el) return el;
    }
    return null;
  }

  const checkSuccess = (entry) =>
    toArray(entry?.submittedSuccessPaths).some((p) => xEval(p, document).some(isVisible));

  // ------------------------------------------------------------------ DOM settle
  // Lever/Jobvite/iCIMS do async round-trips (résumé parse repopulates the form; page
  // POSTs between steps). Upstream watches webRequest; we deliberately skip that
  // permission and wait for the DOM to go quiet instead: resolve after `quietMs` with
  // no mutations under `root` (capped at `maxMs`).
  function settleDom(root, { quietMs = 500, maxMs = 6000 } = {}) {
    quietMs = scaled(quietMs); maxMs = scaled(maxMs);
    return new Promise((resolve) => {
      const target = root && root.nodeType === 1 ? root : document.body;
      if (!target) return resolve(false);
      let quietTimer = null;
      const done = (changed) => { obs.disconnect(); clearTimeout(quietTimer); clearTimeout(cap); resolve(changed); };
      const obs = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => done(true), quietMs);
      });
      obs.observe(target, { childList: true, subtree: true, attributes: true });
      quietTimer = setTimeout(() => done(false), quietMs); // already quiet
      const cap = setTimeout(() => done(true), maxMs);
    });
  }

  // ATSes whose own async machinery (résumé parse / step POSTs) can clobber values
  // filled too early: upload first, settle, fill, then re-assert anything overwritten.
  const SETTLE_ATS = new Set(["Lever", "Jobvite", "ICIMS"]);
  const TEXT_METHODS = new Set(["default", "defaultWithoutBlur", "react", "vanillaWithBlur", "setValue", "setValueOnly"]);

  const findContinueButton = (entry) => {
    for (const p of toArray(entry?.continueButtonPaths)) {
      const el = xEval(p, document).find(isVisible);
      if (el) return el;
    }
    return null;
  };

  async function clickContinue(entry) {
    const btn = findContinueButton(entry);
    if (!btn) return { ok: false, reason: "no-continue-button" };
    methodClick(btn, { noBlur: true });
    return { ok: true };
  }

  // Build probe candidates for embedded-only playbooks (urls: null — Teamtailor/
  // Homerun/PhenomPeople live on customer domains): embeddedPaths (the upstream
  // identity markers), containerPath, plus DISTINCTIVE core-field selector paths
  // (attribute-equality only — label-text fallback paths would match any form).
  function buildProbeCandidates(atsConfig) {
    const out = [];
    for (const [name, e] of Object.entries(atsConfig || {})) {
      if (!e || e.urls) continue;
      const paths = [...toArray(e.embeddedPaths).flat(), ...toArray(e.containerPath)];
      for (const key of ["first_name", "email", "full_name", "resume"]) {
        const pair = (e.inputSelectors || []).find((x) => Array.isArray(x) && x[0] === key);
        for (const sel of toArray(pair?.[1]).slice(0, 2)) {
          for (const p of toArray(typeof sel === "string" ? sel : sel?.path)) {
            if (typeof p === "string" && /@(name|id|data-[\w-]+)="[^"%]+"/.test(p)) paths.push(p);
          }
        }
      }
      if (paths.length) out.push({ name, paths });
    }
    return out;
  }

  // candidates: [{name, paths}] — first candidate with a resolving path wins.
  function probeContainers(candidates) {
    for (const c of toArray(candidates)) {
      if (!c || BLOCKED_ATS.has(c.name)) continue;
      for (const p of toArray(c.paths)) {
        const el = xEval(p, document).find((n) => n.tagName !== "IFRAME");
        if (el) return c.name;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ trackedObjExtractors (DSL §4)

  // Minimal path-to-regexp: "/:name/cx/*" → named segment captures + wildcards.
  function urlPatternMatch(pattern, pathname) {
    const names = [];
    // path-to-regexp-lite: "(...)" is an OPTIONAL group (≈40 of the 57 config patterns
    // end in "(/*)"), ":name" a segment capture, "*" a wildcard.
    const rx = "^" + pattern
      .replace(/[.+?^${}|[\]\\]/g, "\\$&")
      .replace(/\(([^)]*)\)/g, (_, inner) => `@OPT_OPEN@${inner}@OPT_CLOSE@`)
      .replace(/:(\w+)/g, (_, n) => { names.push(n); return "([^/]+)"; })
      .replace(/\*+/g, ".*")
      .replace(/@OPT_OPEN@/g, "(?:").replace(/@OPT_CLOSE@/g, ")?") + "/?$";
    let m = null;
    try { m = pathname.match(new RegExp(rx, "i")); } catch { return null; }
    if (!m) return null;
    const out = {};
    names.forEach((n, i) => { out[n] = decodeURIComponent(m[i + 1] || ""); });
    return out;
  }

  function textOfNode(node) {
    if (!node) return "";
    if (node.nodeType === 1) return norm(node.textContent || "");
    return norm(node.nodeValue || "");
  }

  // Lever and iCIMS derive their canonical id in code upstream, not via extractors.
  const HARDCODED_JOB_IDS = {
    Lever: (loc) => {
      if (!/(^|\.)lever\.co$/i.test(loc.hostname || "")) return null; // embeds: config extractors
      const seg = loc.pathname.split("/").filter(Boolean);
      return seg.length >= 2 ? `lever:${seg[0]}/${seg[1]}` : null;
    },
    ICIMS: (loc) => {
      if (!/(^|\.)icims\.com$/i.test(loc.hostname || "")) return null; // embeds: config extractors
      const seg = loc.pathname.split("/").filter(Boolean);
      const company = loc.hostname.split(".")[0];
      return company && seg[1] ? `icims:${company}/${seg[1]}` : null;
    },
  };

  function xPathText(p) {
    const nodes = [];
    try {
      const snap = document.evaluate(p, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < snap.snapshotLength; i++) nodes.push(snap.snapshotItem(i));
    } catch { /* bad path */ }
    return nodes.map(textOfNode).find(Boolean) ||
      nodes.map((n) => n.nodeType === 1 ? (n.getAttribute?.("action") || n.getAttribute?.("src") || n.getAttribute?.("href") || "") : "").find(Boolean) || "";
  }

  // First extractor whose template fully resolves wins ("{{" no longer present).
  // Substitution map (upstream E()): every string property of the URL (href, origin,
  // pathname, …), hostnameSplit[n], searchParams[k]; urlPattern named params; and
  // path(+match) captures — {{1}}… from regex groups, pairwise when path/match are
  // parallel arrays (Polymer), or {{path}} = the node text when there is no match.
  function extractJobId(entry, loc = location, atsName = "") {
    const hard = HARDCODED_JOB_IDS[atsName]?.(loc);
    if (hard) return hard;
    for (const ex of toArray(entry?.trackedObjExtractors)) {
      if (!ex || !ex.template) continue;
      const s = {};
      try {
        const u = new URL(loc.href);
        u.hostname.split(".").forEach((part, i) => { s[`hostnameSplit[${i}]`] = part; });
        for (const [k, v] of u.searchParams) s[`searchParams[${k}]`] = v;
        for (const k of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"]) {
          s[k] = u[k] ?? "";
        }
        if (ex.urlPattern) {
          const named = urlPatternMatch(ex.urlPattern, u.pathname);
          if (!named) continue;
          Object.assign(s, named);
        }
        if (!ex.path && ex.match) {
          // match with no path: the regex runs against the URL itself — and gates the
          // extractor (no match → try the next one).
          const m = loc.href.match(new RegExp(toArray(ex.match)[0]));
          if (!m) continue;
          if (m.length > 1) m.slice(1).forEach((g, i) => { s[String(i + 1)] = g ?? ""; });
          else s["1"] = m[0];
        }
        if (ex.path) {
          const paths = toArray(ex.path);
          const matches = toArray(ex.match);
          if (matches.length > 1 && paths.length === matches.length) {
            // Pairwise arrays: pair i's first capture group becomes {{i+1}}.
            let allHit = true;
            for (let i = 0; i < paths.length; i++) {
              const m = xPathText(paths[i]).match(new RegExp(matches[i]));
              if (!m) { allHit = false; break; }
              s[String(i + 1)] = m[1] ?? m[0];
            }
            if (!allHit) continue;
          } else {
            let text = "";
            for (const p of paths) { text = xPathText(p); if (text) break; }
            if (ex.match) {
              const m = text.match(new RegExp(toArray(ex.match)[0]));
              if (!m) continue;
              if (m.length > 1) m.slice(1).forEach((g, i) => { s[String(i + 1)] = g ?? ""; });
              else s["1"] = m[0];
            } else if (text) {
              s.path = text; // {{path}} = the looked-up text itself (Indeed h1 titles)
            } else {
              continue;
            }
          }
        }
        const resolved = Object.keys(s).reduce((acc, k) => acc.split(`{{${k}}}`).join(s[k]), ex.template);
        if (!resolved.includes("{{")) return resolved;
      } catch { /* try next extractor */ }
    }
    return null;
  }

  // ------------------------------------------------------------------ break snapshots (step 3C)
  // On a genuine fill break (a config key that HAD a value but couldn't be placed, or an
  // unimplemented-path best-effort) we capture the field's DOM so the break is
  // reproducible offline as a test/fixtures/ pin — WITHOUT ever revisiting the live form.
  //
  // PRIVACY (hard rule): the snapshot is scrubbed BEFORE it leaves this function. Control
  // values/checked/selected state is blanked (removes anything the user entered or picked,
  // including which EEO option), and every known profile/PII/legal string is redacted from
  // the serialized markup. Selectors match on STRUCTURE (ids/names/classes/roles), which
  // survives — the user's data does not. test/validate-config.mjs re-asserts this on every
  // refresh so the scrub can't silently rot.

  const MAX_SNAP_FIELD = 40000;
  const SNAP_STRIP_TAGS = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "IMG", "IFRAME", "LINK", "PICTURE", "VIDEO", "AUDIO", "CANVAS", "TEMPLATE"]);
  // react-select / choices.js style displays render the user's CHOSEN value as text — a
  // non-profile selection would otherwise survive the denylist redaction, so blank them
  // structurally.
  const WIDGET_VALUE_SEL = '[class*="single-value"],[class*="singleValue"],[class*="multi-value"],[class*="multiValue"],[class*="-selected-value"],[class*="selectedValue"]';
  const BREAK_FAIL = new Set(["not-found", "no-option-match", "action-timeout", "error", "no-entry-container", "bad-array-value"]);

  // Every distinctive string derived from the user's profile — the resolved config values
  // (each spec's `v` + `alts`, recursively through array/group rows) plus any raw extras
  // the panel supplies (personal_information / legal answers). Short tokens (<3 chars, e.g.
  // a "No" yes/no answer) are excluded: redacting them would mangle unrelated markup and
  // they aren't identifying — the control-state blanking de-identifies those instead.
  function collectScrubStrings(values, extra) {
    const set = new Set();
    const addStr = (s) => {
      if (s == null) return;
      const v = String(s).trim();
      if (!v) return;
      if (v.length >= 3 || /@/.test(v) || /\d{4,}/.test(v)) set.add(v);
    };
    const walk = (node) => {
      if (node == null) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node === "object") {
        if ("v" in node) walk(node.v);
        for (const alt of toArray(node.alts)) addStr(alt);
        for (const [k, val] of Object.entries(node)) {
          if (k === "v" || k === "alts" || k === "legal") continue;
          walk(val);
        }
        return;
      }
      addStr(node);
    };
    walk(values);
    for (const s of toArray(extra)) addStr(s);
    return set;
  }

  function redactStrings(html, scrubSet) {
    if (!scrubSet || !scrubSet.size) return html;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const htmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    // Longest-first so a value isn't left half-masked by one of its own substrings.
    for (const v of [...scrubSet].sort((a, b) => b.length - a.length)) {
      for (const form of new Set([v, htmlEscape(v)])) {
        if (!form) continue;
        try { html = html.replace(new RegExp(esc(form), "gi"), "░"); } catch { /* skip pathological */ }
      }
    }
    return html;
  }

  // Blank everything a user could have ENTERED/SELECTED on a CLONED subtree (operates on a
  // clone — the live form is never mutated). Structural clearing, not just denylist
  // redaction, so a value the user typed that ISN'T a known profile string (a free-text
  // answer, a picked non-profile option) can't survive. Kept in sync with the scrub gate in
  // test/validate-config.mjs.
  function blankUserData(clone) {
    const nodes = clone.querySelectorAll ? [clone, ...clone.querySelectorAll("*")] : [clone];
    for (const el of nodes) {
      if (!el || el.nodeType !== 1) continue;
      if (SNAP_STRIP_TAGS.has(el.tagName)) { el.remove?.(); continue; } // <template> included: its content isn't walked but IS serialized
      if (el.tagName === "INPUT") { el.setAttribute("value", ""); el.removeAttribute("checked"); }
      else if (el.tagName === "TEXTAREA") { el.textContent = ""; }
      else if (el.tagName === "OPTION") { el.removeAttribute("selected"); }
      // Rich-text / role=textbox editors keep the typed answer as child text nodes.
      if (el.isContentEditable || el.getAttribute?.("contenteditable") === "true" || el.getAttribute?.("role") === "textbox") {
        el.textContent = "";
      }
      // Attributes that carry an entered/derived value or a free-text tooltip (data-value,
      // data-*-value, title). Structural attributes (id/name/class/role/data-automation-id/
      // data-qa) are kept so selectors still resolve.
      for (const attr of el.getAttributeNames?.() || []) {
        if (attr === "value" || attr === "title" || /(^|-)val(ue)?$/i.test(attr)) el.setAttribute(attr, "");
      }
    }
    // react-select / choices.js CHOSEN-value displays render the selection as visible text.
    for (const disp of clone.querySelectorAll?.(WIDGET_VALUE_SEL) || []) disp.textContent = "";
  }

  // Climb to the field's row/question container so the snapshot is a self-contained,
  // fixture-loadable region (label + control), not the whole form.
  function fieldRowAncestor(el) {
    let node = el;
    for (let hop = 0; hop < 5 && node && node.parentElement && node.parentElement !== document.body; hop++) {
      const p = node.parentElement;
      if (/^(FIELDSET|LI|TR)$/.test(p.tagName) || p.getAttribute?.("role") === "group" ||
          /form-group|field|question|application-question|form-field|input-wrapper/i.test(p.className || "")) return p;
      node = p;
    }
    return el.closest?.("fieldset, [role='group'], li, tr, .form-group, div") || el;
  }

  // Capture the FIELD's own row region (never the whole form). runConfigFill only calls this
  // with a resolved element; the container-fallback (el=null) is a bounded belt-and-suspenders
  // path exercised by the scrub gate — capturing an entire form would sweep other fields'
  // entered data into one snapshot, so production never does it.
  function captureSnapshot(el, container, scrubSet) {
    try {
      const targeted = el && el.nodeType === 1 && el.isConnected;
      const node = targeted ? fieldRowAncestor(el) : container;
      if (!node || node.nodeType !== 1) return null;
      const clone = node.cloneNode(true);
      blankUserData(clone);
      let html = clone.outerHTML || "";
      if (html.length > MAX_SNAP_FIELD) html = html.slice(0, MAX_SNAP_FIELD) + "<!-- …truncated… -->"; // cap before redaction
      html = redactStrings(html, scrubSet);
      return { html, scrubbed: true, capturedFrom: targeted ? "field" : "container" };
    } catch { return null; }
  }

  // The RAW (pre-substitution) selector paths a key's playbook tried — what a patcher edits
  // in reference/ats-selectors.json. Recurses grouping/array sub-selectors.
  function collectSelectorPaths(selectorList, depth = 0) {
    if (depth > 3) return [];
    const out = [];
    const add = (x) => { for (const p of toArray(x)) if (typeof p === "string") out.push(p); };
    for (const rawSel of toArray(selectorList)) {
      if (typeof rawSel === "string") { out.push(rawSel); continue; }
      if (!rawSel || typeof rawSel !== "object") continue;
      add(rawSel.path); add(rawSel.valuePath);
      if (rawSel.valuePathMap) for (const v of Object.values(rawSel.valuePathMap)) add(v);
      for (const step of toArray(rawSel.actions)) { add(step?.path); add(step?.valuePath); }
      for (const pair of toArray(rawSel.inputSelectors)) {
        if (Array.isArray(pair) && pair.length >= 2) add(collectSelectorPaths(pair[1], depth + 1));
      }
    }
    return [...new Set(out)].slice(0, 20);
  }

  // ------------------------------------------------------------------ main entry point

  // values: { key: {v, alts?, legal?} } — array-section keys carry v: [ {subKey: {v}} ].
  // opts: { atsName, maps, files:{resume,coverLetter}, coverLetterText, dryRun, signal,
  //         onProgress(key, status, result) }
  async function runConfigFill(entry, values, opts = {}) {
    if (!entry) return { ok: false, reason: "no-entry" };
    if (toArray(entry.pathsExcluded).some((p) => xExists(p, document))) {
      return { ok: false, reason: "excluded-page" };
    }
    const atsName = opts.atsName || "";
    let container = resolveContainer(entry);
    if (!container) {
      if (entry.containerRequired) return { ok: false, reason: "no-container", jobId: extractJobId(entry, location, atsName) };
      container = document.body || document.documentElement;
    }
    const ctx = {
      entry, container, values: values || {},
      maps: opts.maps || {},
      legalKeys: new Set(opts.legalKeys || []),
      files: opts.files || {}, coverLetterText: opts.coverLetterText || "",
      dryRun: !!opts.dryRun, onProgress: opts.onProgress, signal: opts.signal,
      usedEls: new Map(),
    };
    // Break capture (step 3C): opt-in from the extension (never in dry-run or the node
    // walk). scrubSet is built ONCE from the resolved values + panel-supplied raw profile
    // strings, then applied to every captured snapshot.
    const captureBreaks = !!opts.captureBreaks && !ctx.dryRun;
    const scrubSet = captureBreaks ? collectScrubStrings(ctx.values, opts.scrubExtra) : null;
    let snapsCaptured = 0;

    // Lever/Jobvite/iCIMS: the ATS parses the uploaded résumé asynchronously and
    // repopulates fields, clobbering anything filled during the round-trip. Order the
    // walk résumé-first, wait for the DOM to settle after the upload, and re-assert
    // clobbered text values at the end (reference: actions-dsl footnote — upstream
    // uses webRequest timing; we use a DOM-settle heuristic to avoid the permission).
    const settleMode = SETTLE_ATS.has(atsName);
    let pairs = toArray(entry.inputSelectors).filter((p) => Array.isArray(p) && p.length >= 2);
    if (settleMode) {
      const isResume = (p) => p[0] === "resume" || p[0] === "confirm_resume";
      pairs = [...pairs.filter(isResume), ...pairs.filter((p) => !isResume(p))];
    }

    const results = [];
    for (const pair of pairs) {
      if (ctx.signal?.aborted) break;
      const [key, selectorList] = pair;
      opts.onProgress?.(key, "filling");
      let r;
      try {
        r = await fillOneField(key, selectorList, ctx);
      } catch (e) {
        r = { key, status: "error", error: String(e).slice(0, 200) };
      }
      // hadValue: did the resolver produce a value for this key? A break only matters when
      // the config was ASKED to fill something — a key with no profile value that reports
      // not-found is just "user left it blank", not a rotted selector.
      r.hadValue = Object.prototype.hasOwnProperty.call(ctx.values, key);
      // Capture a scrubbed snapshot for genuine breaks (bounded per run so a big form with
      // many off-page keys can't dump the whole DOM repeatedly).
      if (captureBreaks && snapsCaptured < 8) {
        const unimpl = /unknown-method:|legacy-best-effort/.test(r.note || "");
        // Skip "_2"/"_3" occurrence-duplicate keys: their absence is expected, not a rot
        // (mirrors JA_TRACKER.isOccurrenceDup — keeps the snapshot budget for real breaks).
        const occurrenceDup = /_\d+$/.test(String(key || ""));
        if ((r.hadValue && BREAK_FAIL.has(r.status) && !occurrenceDup) || unimpl) {
          r.selectorsTried = collectSelectorPaths(selectorList);
          // Snapshot ONLY when the field's own element was resolved (no-option-match /
          // action-timeout / valuePath-miss). A pure not-found has no element to localize;
          // capturing the whole form there would sweep other fields' entered data into the
          // snapshot — the attempted selectors + config entry are enough to patch a rot that
          // matched nothing. Field-localized snapshots keep exposure to one row.
          if (r.el) {
            const snap = captureSnapshot(r.el, null, scrubSet);
            if (snap) { r.snapshot = snap; snapsCaptured += 1; }
          }
        }
      }
      opts.onProgress?.(r.key || key, r.status, r);
      results.push(r);
      // Slow ATSes (Avature/PhenomPeople) declare a breathing-room delay between fills.
      if (entry.fillInputInterval && !ctx.dryRun) await sleep(scaled(entry.fillInputInterval));
      if (settleMode && !ctx.dryRun && r.status === "filled" &&
          (key === "resume" || r.method === "uploadResume")) {
        await settleDom(ctx.container, { quietMs: 700, maxMs: 8000 });
      }
    }

    // Re-assert pass: the ATS's own résumé-parse autofill may have overwritten values
    // we set. Profile values are canonical (the parse is a lossy derivative of the
    // same résumé), so ours win — same outcome as upstream's refill-after-roundtrip.
    if (settleMode && !ctx.dryRun) {
      await settleDom(ctx.container, { quietMs: 500, maxMs: 5000 });
      for (const r of results) {
        if (r.status !== "filled" || !TEXT_METHODS.has(r.method) || !r.el?.isConnected) continue;
        if (typeof r.el.value !== "string" || r.value == null) continue;
        if (r.el.value.trim() === String(r.value).trim()) continue;
        const again = await applyMethod(r.method, r.el, r.value, [{ value: r.value, unmapped: r.value }], null, {}, ctx, null);
        if (again.status === "filled") { r.reasserted = true; opts.onProgress?.(r.key, "filled", r); }
      }
    }

    return {
      ok: true,
      results, // result.el is kept for in-process callers; messaging layers must strip it
      success: checkSuccess(entry),
      hasContinue: !!findContinueButton(entry),
      jobId: extractJobId(entry, location, atsName),
    };
  }

  // Every method name applyMethod dispatches (coverage gate: test/validate-config.mjs
  // asserts each method the config references appears here).
  const IMPLEMENTED_METHODS = new Set([
    "default", "defaultWithoutBlur", "vanillaWithBlur", "react", "reactClick", "click",
    "tptEnableResume", "selectCheckboxOrRadio", "clearValue", "blur", "setValueOnly",
    "setValue", "uploadResume", "uploadCoverLetter", "writeCoverLetter", "tinyMCE",
    "reactDatePickerMonth", "dijit", "ui5", "jQuery",
  ]);

  return {
    detectAts, runConfigFill, checkSuccess, clickContinue, findContinueButton,
    extractJobId, settleDom, IMPLEMENTED_METHODS, probeContainers, buildProbeCandidates,
    // step 3C snapshot scrub — the capture runs inside runConfigFill; these are exposed for
    // the validate-config.mjs privacy gate and fixture-fill.mjs's patchability round-trip.
    captureSnapshot, collectScrubStrings, collectSelectorPaths,
    setTimeScale: (x) => { TIME_SCALE = x; },
    // exposed for unit tests (kept to what the suites actually call)
    _internal: { subPlaceholders, applyMethod, xEval, urlPatternMatch, buildCandidates },
  };
})();

// Loadable as a content script, via <script>, or require()d by node-side helpers.
if (typeof module !== "undefined" && module.exports) module.exports = JA_CFG;
