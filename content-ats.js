// jobApplier content script: scrape the application form to a schema, and apply
// field→value instructions using the event sequences documented in
// reference/fill-strategies.md. Runs on declared ATS hosts (manifest) and is injected
// on demand elsewhere (activeTab), so everything is wrapped in a re-injection guard.
(() => {
  if (window.__jobApplierLoaded) return;
  window.__jobApplierLoaded = true;

  // Never operate inside captcha/consumer frames (from reference/autofill-exclusions.json).
  const NEVER_INJECT = [
    /\.google\.com\/recaptcha\//, /\.recaptcha\.net\/recaptcha\//, /\.hcaptcha\.com\/captcha\//,
    /\.youtube\.com\//, /\.amazon\.(com|co\.uk|de|fr|it|es|ca|co\.jp|co\.in)\//,
    /\.live\.com\//, /teams\.microsoft\.com\//,
  ];
  if (NEVER_INJECT.some((re) => re.test(location.href))) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  // Case-insensitive, punctuation-insensitive comparison key (the labelContains idiom).
  // Keep in sync with fold() in ai.js — same semantics, duplicated on purpose across
  // the two isolated JS contexts (no shared-module mechanism without a build step).
  const fold = (s) => norm(s).toLowerCase().replace(/[/:_\-,.;()?!*&'"’]+/g, " ").replace(/\s+/g, " ").trim();
  const stripLabelNoise = (s) =>
    norm(s).replace(/\s*\*+\s*$/, "").replace(/\s*\((optional|required)\)\s*$/i, "").trim();

  const GROUP_SEL = "fieldset, [role='radiogroup'], [role='group']";
  const MAX_FIELDS = 200;

  // Fill instructions for this page are only valid against this scrape session; other
  // frames (and stale scrapes) must not answer them.
  const FRAME_TOKEN = `ja-${Math.random().toString(36).slice(2)}`;

  // ---------------------------------------------------------------- visibility & labels

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    if (el.offsetParent === null && st.position !== "fixed") return false;
    return true;
  }

  // Fillable check for inputs. display is not inherited, so a control inside a
  // display:none section keeps its own computed display — offsetParent goes null though,
  // which catches hidden wizard steps/conditional sections. Radios/checkboxes are often
  // display:none themselves with a styled visible label, so they pass if any associated
  // label is rendered.
  function isFillable(el) {
    if (!el.isConnected) return false;
    const st = getComputedStyle(el);
    const type = (el.type || "").toLowerCase();
    if (type === "radio" || type === "checkbox") {
      if (el.offsetParent !== null || st.position === "fixed") return true;
      return [...(el.labels || [])].some((l) => l.offsetParent !== null);
    }
    if (st.display === "none" || st.visibility === "hidden") return false;
    return el.offsetParent !== null || st.position === "fixed";
  }

  function textOfIds(idList) {
    return norm(
      (idList || "").split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || "").join(" ")
    );
  }

  // labelIndex: one document pass instead of one attribute-selector scan per control.
  function buildLabelIndex() {
    const m = new Map();
    for (const l of document.querySelectorAll("label[for]")) {
      if (!m.has(l.htmlFor)) m.set(l.htmlFor, l);
    }
    return m;
  }

  function labelFor(el, labelIndex = null) {
    if (el.id) {
      const l = labelIndex
        ? labelIndex.get(el.id)
        : document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && norm(l.textContent)) return stripLabelNoise(l.textContent);
    }
    const alb = el.getAttribute("aria-labelledby");
    if (alb) {
      const t = textOfIds(alb);
      if (t) return stripLabelNoise(t);
    }
    const al = el.getAttribute("aria-label");
    if (al) return stripLabelNoise(al);
    const wrap = el.closest("label");
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll("input, textarea, select").forEach((n) => n.remove());
      const t = norm(clone.textContent);
      if (t) return stripLabelNoise(t);
    }
    return "";
  }

  // Last-resort label: nearest preceding text within the field's row container.
  function precedingText(el) {
    let node = el;
    for (let hop = 0; hop < 4 && node && node !== document.body; hop++) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (/^(LABEL|LEGEND|P|SPAN|DIV|STRONG|H1|H2|H3|H4|H5|H6)$/.test(sib.tagName)) {
          const t = norm(sib.textContent);
          if (t && t.length >= 2 && t.length <= 300) return stripLabelNoise(t);
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }

  function groupLabel(container, firstInput) {
    const legend = container.querySelector?.("legend");
    if (legend && norm(legend.textContent)) return stripLabelNoise(legend.textContent);
    const alb = container.getAttribute?.("aria-labelledby");
    if (alb && textOfIds(alb)) return stripLabelNoise(textOfIds(alb));
    const al = container.getAttribute?.("aria-label");
    if (al) return stripLabelNoise(al);
    return precedingText(container) || precedingText(firstInput);
  }

  function describedBy(el) {
    const t = textOfIds(el.getAttribute("aria-describedby"));
    return t ? t.slice(0, 300) : "";
  }

  // ---------------------------------------------------------------- refs

  const escAttr = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  function cssPath(el, maxDepth = 12) {
    const parts = [];
    let node = el;
    while (node && node !== document.body && parts.length < maxDepth) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function rawRefFor(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${escAttr(el.name)}"]`;
    return cssPath(el);
  }

  function queryAll(sel) {
    try { return [...document.querySelectorAll(sel)]; } catch { return []; }
  }

  // Refs must round-trip to exactly the scraped element (duplicate names, hidden Rails
  // twins, and truncated paths can otherwise hijack the fill onto a different element).
  function makeStableRef(el, usedRefs) {
    let ref = rawRefFor(el);
    const ok = (r) => !usedRefs.has(r) && queryAll(r)[0] === el && queryAll(r).length >= 1;
    if (!ok(ref)) ref = cssPath(el);
    if (!ok(ref)) ref = cssPath(el, 64);
    usedRefs.add(ref);
    return ref;
  }

  // Group refs resolve to ALL member inputs. Scope by container when the name is absent
  // or already claimed by another group.
  function makeGroupRef(els, containerEl, type, usedRefs) {
    const name = els[0].name;
    let ref = name ? `input[name="${escAttr(name)}"]` : "";
    const members = (r) => queryAll(r);
    const okGroup = (r) => r && !usedRefs.has(r) && els.every((e) => members(r).includes(e));
    if (!okGroup(ref)) ref = `${cssPath(containerEl)} input[type="${type}"]`;
    if (!okGroup(ref)) ref = `${cssPath(containerEl, 64)} input[type="${type}"]`;
    usedRefs.add(ref);
    return ref;
  }

  // Fill-time resolution: drop hidden inputs (Rails emits hidden twins sharing the
  // checkbox's name), enforce the expected control type, and require fillability.
  function resolveRef(ref, kind) {
    let els = queryAll(ref);
    const t = (el) => (el.type || "").toLowerCase();
    els = els.filter((el) => t(el) !== "hidden");
    if (kind === "radio-group") els = els.filter((el) => t(el) === "radio");
    else if (kind === "checkbox-group" || kind === "checkbox") els = els.filter((el) => t(el) === "checkbox");
    return els.filter(isFillable);
  }

  // ---------------------------------------------------------------- ATS identity

  // Single owner of "which ATS is this" — step 2's config engine swaps this body for
  // reference/ats-selectors.json urls matching without touching callers.
  function detectATS(host = location.hostname) {
    if (/greenhouse\.io$/.test(host)) return "greenhouse";
    if (/lever\.co$/.test(host)) return "lever";
    if (/ashbyhq\.com$/.test(host)) return "ashby";
    if (/myworkday(jobs|site)\.com$/.test(host)) return "workday";
    return null;
  }

  // ---------------------------------------------------------------- schema scrape

  // Ordered known-container fast paths (step 2 replaces this array with the detected
  // ATS's containerPath list from the reference config).
  const KNOWN_CONTAINERS = ["form#application-form"];

  function findFormContainer() {
    for (const sel of KNOWN_CONTAINERS) {
      const el = document.querySelector(sel);
      if (el) return { container: el, kind: "form" };
    }
    const forms = [...document.querySelectorAll("form")]
      .filter(isVisible)
      .map((f) => ({ f, n: f.querySelectorAll("input, textarea, select").length }))
      .filter((x) => x.n >= 3)
      .sort((a, b) => b.n - a.n);
    if (forms.length) return { container: forms[0].f, kind: "form" };
    return { container: document.body, kind: "fallback" };
  }

  function isCombobox(el) {
    if (el.tagName !== "INPUT") return false;
    return el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-autocomplete") === "list" ||
      /select__input|autocomplete|combobox/i.test(el.className || "") ||
      el.getAttribute("aria-haspopup") === "listbox";
  }

  // ref → member elements of the LAST scrape — lets the config-fill pass report which
  // scraped fields it touched (element identity), so the panel can skip them in the
  // LLM pass. Rebuilt on every scrape; elements may go stale after re-renders (checked
  // with isConnected at use time).
  let lastRefEls = new Map();

  function scrapeSchema(jdConfig) {
    const { container, kind: containerKind } = findFormContainer();
    const labelIndex = buildLabelIndex();
    const usedRefs = new Set();
    const refEls = new Map();
    const singles = [];
    const groups = new Map(); // radio/checkbox groups

    for (const el of container.querySelectorAll("input, textarea, select")) {
      const type = (el.type || "text").toLowerCase();
      if (["hidden", "password", "submit", "button", "image", "reset"].includes(type)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if (type === "radio" || type === "checkbox") {
        if (!isFillable(el)) continue;
        // Unnamed radios/checkboxes group by their visual container, not per-element.
        const key = el.name
          ? `name:${el.name}`
          : `grp:${cssPath(el.closest(GROUP_SEL) || el.parentElement)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
        continue;
      }
      if (type !== "file" && !isFillable(el)) continue;
      singles.push(el);
    }

    const fields = [];
    let truncated = false;
    const push = (field) => {
      if (fields.length >= MAX_FIELDS) { truncated = true; return false; }
      fields.push(field);
      return true;
    };

    // Groups first: they're few and include the EEO/legal radios that must never be
    // the victims of the field cap.
    for (const els of groups.values()) {
      const first = els[0];
      const type = first.type.toLowerCase();
      const containerEl = first.closest(GROUP_SEL) || first.parentElement;
      const solo = els.length === 1 && type === "checkbox";
      const groupRef = solo ? makeStableRef(first, usedRefs) : makeGroupRef(els, containerEl, type, usedRefs);
      refEls.set(groupRef, els);
      push({
        ref: groupRef,
        label: solo ? (labelFor(first, labelIndex) || precedingText(first)) : groupLabel(containerEl, first),
        kind: solo ? "checkbox" : `${type}-group`,
        type,
        name: first.name || "",
        id: first.id || "",
        required: els.some((el) => el.required || el.getAttribute("aria-required") === "true"),
        autocomplete: "",
        description: describedBy(first),
        placeholder: "",
        value: "",
        options: solo ? null
          : els.map((el) => labelFor(el, labelIndex) || norm(el.value)).filter(Boolean).slice(0, 100),
        optionsSource: solo ? null : "static",
      });
    }

    for (const el of singles) {
      const type = (el.type || "text").toLowerCase();
      const kind =
        type === "file" ? "file" :
        el.tagName === "SELECT" ? "select" :
        el.tagName === "TEXTAREA" ? "textarea" :
        isCombobox(el) ? "combobox" : "text";
      const singleRef = makeStableRef(el, usedRefs);
      refEls.set(singleRef, [el]);
      const field = {
        ref: singleRef,
        label: labelFor(el, labelIndex) || precedingText(el),
        kind,
        type,
        name: el.name || "",
        id: el.id || "",
        required: el.required || el.getAttribute("aria-required") === "true",
        autocomplete: el.getAttribute("autocomplete") || "",
        description: describedBy(el),
        placeholder: el.getAttribute("placeholder") || "",
        value: (el.value || "").slice(0, 200),
        options: null,
        optionsSource: null,
      };
      if (kind === "select") {
        field.options = [...el.options].map((o) => norm(o.textContent)).filter(Boolean).slice(0, 100);
        field.optionsSource = "static";
      } else if (kind === "combobox") {
        field.optionsSource = "dynamic"; // options render only when opened; harvested at fill time
      }
      if (!push(field)) break;
    }

    lastRefEls = refEls;
    return {
      fields, truncated, containerKind,
      job: scrapeJobContext(jdConfig), frameToken: FRAME_TOKEN, url: location.href,
    };
  }

  // Config-first job-context extraction. `jdConfig` = the matched ResumeScores entry from
  // reference/resume-scoring.json ({jobDescriptionPath, jobTitlePath, jobCompanyNamePath}).
  // Each path may be one XPath string or an array; a path may return a node-set (take the
  // first non-empty node's text) OR a string (substring-before/after/concat/etc.). The
  // first path that yields a non-empty trimmed string wins. Any XPath failure is swallowed
  // and we fall back to the UNCHANGED heuristic chain — a bad path must never break scrape.
  function firstXPathString(paths, minLen = 0) {
    const list = Array.isArray(paths) ? paths : (paths ? [paths] : []);
    for (const raw of list) {
      const xp = typeof raw === "string" ? raw.trim() : "";
      if (!xp) continue;
      try {
        // String-returning expressions: literal strings and the XPath 1.0 string
        // functions the config uses (e.g. `substring-before(.//img/@alt, " Logo")`).
        const stringy = /^"[^"]*"$/.test(xp) ||
          /^(substring|substring-before|substring-after|concat|normalize-space|string|translate)\s*\(/i.test(xp);
        if (stringy) {
          const r = document.evaluate(xp, document, null, XPathResult.STRING_TYPE, null);
          const s = norm(r.stringValue || "");
          if (s && s.length > minLen) return s;
          continue;
        }
        const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const node = r.singleNodeValue;
        if (node) {
          // innerText for rendered containers; textContent/nodeValue for attribute nodes
          // (@alt, @content) and detached text.
          const t = norm(node.innerText || node.textContent || node.nodeValue || "");
          if (t && t.length > minLen) return t;
        }
      } catch { /* bad XPath — ignore, try the next / fall back to heuristics */ }
    }
    return "";
  }

  function scrapeJobContext(jdConfig) {
    let title = "", company = "", description = "";

    // Config-first: the detected ATS's XPath playbook. Description keeps the same >200-char
    // gate the heuristic path uses.
    if (jdConfig) {
      title = firstXPathString(jdConfig.jobTitlePath);
      company = firstXPathString(jdConfig.jobCompanyNamePath);
      description = firstXPathString(jdConfig.jobDescriptionPath, 200);
    }

    // Heuristic fallback (unchanged) — only fills what config-first left empty.
    const og = (p) => document.querySelector(`meta[property="og:${p}"]`)?.content || "";
    if (!title) title = norm(og("title") || document.querySelector("h1")?.textContent || document.title || "");
    if (!company) company = og("site_name") || "";
    // Greenhouse og:title convention: "Job Application for X at Y"
    const m = title.match(/^Job Application for (.+) at (.+)$/i);
    if (m) { title = m[1]; company = company || m[2]; }
    if (!company) {
      const path = location.pathname.split("/").filter(Boolean);
      company = (detectATS() && path[0]) ? path[0] : location.hostname.replace(/^www\./, "");
    }
    if (!description) {
      for (const sel of ['[class*="job__description"]', "#content", '[data-qa="job-description"]', "main", "body"]) {
        const el = document.querySelector(sel);
        const t = norm(el?.innerText || "");
        if (t.length > 200) { description = t; break; }
      }
    }
    return { title: norm(title), company: norm(company), description: description.slice(0, 15000), url: location.href };
  }

  // ---------------------------------------------------------------- fill primitives
  // Faithful implementations of the verified sequences in reference/fill-strategies.md.

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      el instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
      HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const mouse = (type) => new MouseEvent(type, { bubbles: true, cancelable: true, view: window });

  // Legacy widgets (jQuery-UI/dijit autocompletes) gate on e.keyCode/e.which, which the
  // KeyboardEvent constructor leaves 0 — shim them (fill-strategies.md: "sometimes a
  // real key/keyCode, so widgets listening on keydown fire").
  function key(type, k) {
    const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, key: k, view: window });
    const code = k === "Escape" ? 27 : (k && k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
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

  // default (text branch): set → input+change → 10ms tick → blur. The tick lets React
  // flush onChange before focus leaves; blurring synchronously can drop the value.
  async function fillText(el, value) {
    fireFocus(el);
    setNativeValue(el, value);
    fireChange(el);
    await sleep(10);
    fireBlur(el);
  }

  // <select> full fire sequence — order matters; the double click (before AND after) and
  // the legacy textInput event make stubborn custom-styled selects register.
  async function fillSelect(el, value) {
    const options = [...el.options].map((o) => ({ label: norm(o.textContent), value: o.value }));
    const match = bestOptionMatch(options, value);
    if (!match) return { status: "no-option-match", optionsSeen: options.map((o) => o.label).slice(0, 50) };
    fireFocus(el);
    el.dispatchEvent(mouse("click"));
    setNativeValue(el, options[match.index].value);
    fireTextInput(el);
    fireInput(el);
    fireChange(el);
    el.dispatchEvent(mouse("click"));
    await sleep(10);
    fireBlur(el);
    return { status: "filled", chose: match.label };
  }

  // checkbox/radio: skip if already in the desired state; else focus → (checkbox:
  // el.click() / radio: MouseEvent click + set checked) → textInput → input → change → blur.
  async function checkBoxOrRadio(el, desired = true) {
    if (el.checked === desired) return { status: "already-set" };
    fireFocus(el);
    if (el.type === "checkbox") {
      el.click();
    } else {
      el.dispatchEvent(mouse("click"));
      el.checked = desired;
    }
    fireTextInput(el);
    fireInput(el);
    fireChange(el);
    await sleep(10);
    fireBlur(el);
    return { status: "filled" };
  }

  // react-select style combobox, two-phase: mousedown opens (click alone does nothing on
  // react-select), static menus render options immediately, async typeaheads need typing.
  async function fillCombobox(el, value) {
    const matchIn = (opts) => bestOptionMatch(opts.map((o) => ({ label: norm(o.textContent) })), value);
    const seen = (opts) => opts.map((o) => norm(o.textContent)).filter(Boolean).slice(0, 50);

    const control = el.closest('[class*="control"]') || el.parentElement || el;
    control.dispatchEvent(mouse("mousedown"));
    control.dispatchEvent(mouse("mouseup"));
    fireFocus(el);

    // Static menus render within a frame or two; async typeaheads show nothing until
    // typed at — don't burn the long budget before typing.
    let options = await pollOptions(el, 250);
    let match = matchIn(options);

    if (!match) {
      // Type the query (defaultWithoutBlur: stay focused or the menu closes).
      setNativeValue(el, "");
      el.dispatchEvent(key("keydown", value[0] || "a"));
      setNativeValue(el, value);
      options = await pollOptions(el, 5000);
      match = matchIn(options);
      if (!match && value.length > 4) {
        // Async typeaheads over-filter on exact strings; retry with a short prefix.
        setNativeValue(el, value.slice(0, 4));
        options = await pollOptions(el, 4000);
        match = matchIn(options);
      }
    }

    if (!match) {
      const optionsSeen = seen(options);
      setNativeValue(el, ""); // don't leave typed junk behind — it can get submitted
      el.dispatchEvent(key("keydown", "Escape"));
      fireBlur(el);
      return { status: "no-option-match", optionsSeen };
    }
    const optionEl = options[match.index];
    optionEl.dispatchEvent(mouse("mousedown"));
    optionEl.dispatchEvent(mouse("mouseup"));
    optionEl.dispatchEvent(mouse("click"));
    await sleep(10);
    return { status: "filled", chose: norm(optionEl.textContent) };
  }

  async function pollOptions(el, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const opts = findOptions(el);
      if (opts.length) return opts;
      await sleep(150);
    }
    return [];
  }

  // Menu notices ("No options", "Loading…") and placeholders must not count as options —
  // they'd satisfy the poll instantly and poison the harvested-options retry pass.
  const OPTION_NOISE = /^(no (options|results|matches)( found)?|loading|searching|start typing|type to search|please select|select( one)?|choose( one)?)(\.{3}|…)?$/;
  function realOption(el) {
    if (/menu-notice|loading|placeholder/i.test(el.className || "")) return false;
    const t = fold(el.textContent);
    return !!t && !OPTION_NOISE.test(t);
  }

  function findOptions(el) {
    const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    let root = id ? document.getElementById(id) : null;
    if (!root) root = document.querySelector('[class*="select__menu"], [role="listbox"]');
    if (!root) return [];
    const opts = [...root.querySelectorAll('[role="option"]')].filter(isVisible).filter(realOption);
    if (opts.length) return opts;
    return [...root.querySelectorAll('[class*="option"], li')].filter(isVisible).filter(realOption);
  }

  // exact fold match → token containment (whole words, either direction) → 4-char prefix.
  // Conservative: ambiguous = no match. Substrings inside words never match ("no" must
  // not match "Unknown").
  function bestOptionMatch(options, value) {
    const v = fold(String(value));
    if (!v) return null;
    const withIdx = options.map((o, index) => ({ ...o, index, f: fold(o.label || o.value || "") }));

    let hits = withIdx.filter((o) => o.f === v || (o.value != null && fold(String(o.value)) === v));
    if (hits.length) return hits[0]; // exact ties: first wins (duplicated option text)

    const vTok = new Set(v.split(" "));
    const subset = (a, b) => [...a].every((t) => b.has(t));
    hits = withIdx.filter((o) => {
      const oTok = new Set(o.f.split(" ").filter(Boolean));
      if (!oTok.size) return false;
      return subset(oTok, vTok) || subset(vTok, oTok);
    });
    if (hits.length === 1) return hits[0];

    if (v.length >= 4) {
      hits = withIdx.filter((o) => o.f.startsWith(v.slice(0, 4)));
      if (hits.length === 1) return hits[0];
    }
    return null;
  }

  // Multi-word affirmatives ("Yes, I agree") must still check the box; unrecognizable
  // values must NOT silently report success on an untouched checkbox.
  const TRUTHY_RE = /^(yes|y|true|1|on|checked|agreed?|accept(ed)?|i agree|i accept|confirm(ed)?)\b/;
  const FALSY_RE = /^(no|n|false|0|off|unchecked|declined?|disagree|do not|don t)\b/;

  // ---------------------------------------------------------------- fill executor

  function progress(ref, status, extra) {
    try {
      chrome.runtime.sendMessage({ type: "JA_FILL_PROGRESS", ref, status, ...extra }).catch(() => {});
    } catch { /* panel closed / extension reloaded */ }
  }

  async function fillOne(inst) {
    const els = resolveRef(inst.ref, inst.kind);
    if (!els.length) return { ref: inst.ref, status: "not-found" };
    const el = els[0];

    // Label guard: never fill an element whose label no longer matches what was mapped
    // (React re-renders can shuffle anonymous nth-of-type refs).
    if (inst.expectLabel) {
      const seenLabel = inst.kind?.endsWith("-group")
        ? groupLabel(el.closest(GROUP_SEL) || el.parentElement, el)
        : (labelFor(el) || precedingText(el));
      const a = fold(seenLabel), b = fold(inst.expectLabel);
      if (a && b && a !== b && !a.includes(b) && !b.includes(a)) {
        return { ref: inst.ref, status: "mismatch", found: seenLabel };
      }
    }

    const value = String(inst.value ?? "");
    if (!value) return { ref: inst.ref, status: "empty-value" };

    switch (inst.kind) {
      case "file": {
        // Step 2: DataTransfer upload from the stored résumé bytes (fill-strategies.md).
        if (!inst.file?.b64) return { ref: inst.ref, status: "file-skipped" };
        const file = new File([b64ToBytes(inst.file.b64)], inst.file.name || "resume.pdf",
          { type: inst.file.type || "application/pdf" });
        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        fireChange(el);
        return { ref: inst.ref, status: "filled", chose: file.name };
      }
      case "select":
        return { ref: inst.ref, ...(await fillSelect(el, value)) };
      case "combobox":
        return { ref: inst.ref, ...(await fillCombobox(el, value)) };
      case "checkbox": {
        const f = fold(value);
        if (TRUTHY_RE.test(f)) return { ref: inst.ref, ...(await checkBoxOrRadio(el, true)) };
        if (FALSY_RE.test(f)) return { ref: inst.ref, ...(await checkBoxOrRadio(el, false)) };
        return { ref: inst.ref, status: "ambiguous-value", value };
      }
      case "radio-group":
      case "checkbox-group": {
        const opts = els.map((e, index) => ({ label: labelFor(e) || norm(e.value), value: e.value, index }));
        const match = bestOptionMatch(opts, value);
        if (!match) {
          return { ref: inst.ref, status: "no-option-match", optionsSeen: opts.map((o) => o.label).slice(0, 50) };
        }
        return { ref: inst.ref, ...(await checkBoxOrRadio(els[match.index], true)), chose: match.label };
      }
      default:
        await fillText(el, value);
        return { ref: inst.ref, status: "filled" };
    }
  }

  async function runFill(instructions) {
    const results = [];
    for (const inst of instructions) {
      progress(inst.ref, "filling");
      let res;
      try {
        res = await fillOne(inst);
      } catch (e) {
        res = { ref: inst.ref, status: "error", error: String(e).slice(0, 200) };
      }
      progress(inst.ref, res.status, res.chose ? { chose: res.chose } : undefined);
      results.push(res);
    }
    return results;
  }

  // ---------------------------------------------------------------- messaging
  // Sync listener returning literal true (an async listener's Promise is ignored by
  // Chrome). Every held channel gets a response on every path.
  //
  // Frame arbitration: tabs.sendMessage without frameId resolves with the FIRST
  // sendResponse, and with allFrames injection a form-less top frame could beat the
  // iframe that owns the application form. Frames with a real form (or ≥3 fields)
  // answer immediately; a weak TOP frame answers on a delay so a strong frame wins the
  // race when one exists; weak/broken subframes stay silent.

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "JA_SCRAPE") {
      let schema;
      try {
        // msg.jdConfig (the matched ResumeScores entry) enables config-first job-context
        // extraction; undefined when the panel doesn't send one → identical old behavior.
        schema = scrapeSchema(msg.jdConfig);
      } catch (e) {
        if (window !== window.top) return undefined; // broken subframe: stay out of the race
        sendResponse({ ok: false, error: String(e).slice(0, 300) });
        return true;
      }
      const strong = schema.containerKind === "form" || schema.fields.length >= 3;
      if (strong) {
        sendResponse({ ok: true, schema });
        return true;
      }
      if (window !== window.top) return undefined; // weak subframe: stay silent
      setTimeout(() => { try { sendResponse({ ok: true, schema }); } catch { /* channel gone */ } }, 400);
      return true;
    }
    if (msg?.type === "JA_FILL") {
      // Only the frame that produced the scrape may execute its refs.
      if (msg.frameToken !== FRAME_TOKEN) return undefined;
      runFill(msg.instructions || [])
        .then((results) => sendResponse({ ok: true, results }))
        .catch((e) => sendResponse({ ok: false, error: String(e).slice(0, 300) }));
      return true;
    }
    if (msg?.type === "JA_CONFIG_FILL") {
      if (msg.frameToken !== FRAME_TOKEN) return undefined;
      if (typeof JA_CFG === "undefined") {
        sendResponse({ ok: false, error: "config engine not loaded in this frame" });
        return true;
      }
      runConfigFillMsg(msg)
        .then((out) => sendResponse(out))
        .catch((e) => sendResponse({ ok: false, error: String(e).slice(0, 300) }));
      return true;
    }
    if (msg?.type === "JA_TOUCHED") {
      // Post-rescan: which of the FRESH scrape's refs did the config pass fill?
      if (msg.frameToken !== FRAME_TOKEN) return undefined;
      const refs = [...new Set(lastConfigTouched.map(refForElement).filter(Boolean))];
      sendResponse({ ok: true, refs });
      return true;
    }
    if (msg?.type === "JA_PROBE_ATS") {
      if (msg.frameToken !== FRAME_TOKEN) return undefined;
      if (typeof JA_CFG === "undefined") { sendResponse({ ok: false }); return true; }
      sendResponse({ ok: true, name: JA_CFG.probeContainers(msg.candidates || []) });
      return true;
    }
    if (msg?.type === "JA_EXTRACT_JOBID") {
      // Canonical, content-side jobId: extractJobId runs against the REAL page DOM +
      // this frame's location. Only the FORM frame (the one that produced the scrape,
      // matching schema.url) answers, so the panel's tailor/upload/tracker keys all agree.
      if (msg.frameToken !== FRAME_TOKEN) return undefined;
      if (typeof JA_CFG === "undefined") {
        sendResponse({ ok: false, error: "config engine not loaded in this frame" });
        return true;
      }
      let jobId = null;
      try { jobId = JA_CFG.extractJobId(msg.entry || {}, location, msg.atsName || ""); } catch { jobId = null; }
      sendResponse({ ok: true, jobId, url: location.href });
      return true;
    }
    if (msg?.type === "JA_FLOW") {
      if (msg.frameToken !== FRAME_TOKEN) return undefined;
      if (typeof JA_CFG === "undefined") {
        sendResponse({ ok: false, error: "config engine not loaded in this frame" });
        return true;
      }
      runFlowMsg(msg)
        .then((out) => sendResponse(out))
        .catch((e) => sendResponse({ ok: false, error: String(e).slice(0, 300) }));
      return true;
    }
    return undefined;
  });

  // ---------------------------------------------------------------- config-fill bridge

  function b64ToBytes(b64) {
    const bin = atob(b64 || "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function fileFromSpec(spec) {
    if (!spec?.b64) return null;
    return { name: spec.name || "file", type: spec.type || "application/octet-stream", bytes: b64ToBytes(spec.b64) };
  }

  // Map a config-fill result element back to the last scrape's refs so the panel can
  // exclude already-filled fields from the LLM pass. Radios match their group ref.
  // Containment is tight on purpose: a container-sized element must never blanket-claim
  // the first group inside it (audit-caught false exclusions).
  function refForElement(el) {
    if (!el || !el.isConnected || el === document.body || el === document.documentElement) return null;
    const isControl = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName) || el.isContentEditable;
    for (const [ref, els] of lastRefEls) {
      for (const member of els) {
        if (member === el || member.contains(el)) return ref;
        if (!isControl && el.contains?.(member) && el.querySelectorAll("input, textarea, select").length <= 3) return ref;
      }
    }
    return null;
  }

  // Elements the last config pass filled — re-mapped to refs on demand (JA_TOUCHED),
  // AFTER the panel's rescan, so the refs are in the fresh scrape's space.
  let lastConfigTouched = [];

  async function runConfigFillMsg(msg) {
    const files = {
      resume: fileFromSpec(msg.files?.resume),
      coverLetter: fileFromSpec(msg.files?.coverLetter),
    };
    const out = await JA_CFG.runConfigFill(msg.entry, msg.values || {}, {
      atsName: msg.atsName || "",
      maps: msg.maps || {},
      legalKeys: msg.legalKeys || [],
      files,
      coverLetterText: msg.coverLetterText || "",
      dryRun: !!msg.dryRun,
      // step 3C: capture scrubbed break snapshots. scrubExtra carries raw profile/legal
      // strings the resolver may drop (e.g. blanked personal_information) so the redactor
      // covers them too. Never enabled in dry-run (engine guards that).
      captureBreaks: !!msg.captureBreaks,
      scrubExtra: msg.scrubExtra || [],
      onProgress: (key, status, r) => {
        progress(`cfg:${key}`, status, r?.chose ? { chose: r.chose } : (r?.value ? { chose: r.value } : undefined));
      },
    });
    if (!out.ok) return { ok: true, ran: false, reason: out.reason, jobId: out.jobId || null };
    // Serialize: strip elements, attach the matching scraped ref where we have one.
    lastConfigTouched = (out.results || [])
      .filter((r) => (r.status === "filled" || r.status === "already-set") && r.el)
      .map((r) => r.el);
    const results = (out.results || []).map(({ el, rows, ...rest }) => ({
      ...rest,
      touchedRef: rest.status === "filled" || rest.status === "already-set" ? refForElement(el) : null,
      ...(rows ? { rows: rows.map(({ el: _e, ...rr }) => rr) } : {}),
    }));
    return { ok: true, ran: true, results, success: out.success, hasContinue: out.hasContinue, jobId: out.jobId };
  }

  async function runFlowMsg(msg) {
    if (msg.action === "continue") {
      // Respond IMMEDIATELY after the click: a full page load right after Continue
      // destroys this document and the channel with it — the panel treats a dead
      // channel as "probably navigated" and rescans, so a held response only loses.
      const r = await JA_CFG.clickContinue(msg.entry);
      return { ok: true, ...r, success: JA_CFG.checkSuccess(msg.entry) };
    }
    if (msg.action === "status") {
      return {
        ok: true,
        success: JA_CFG.checkSuccess(msg.entry),
        hasContinue: !!JA_CFG.findContinueButton(msg.entry),
        jobId: JA_CFG.extractJobId(msg.entry, location, msg.atsName || ""),
      };
    }
    return { ok: false, error: `unknown flow action: ${msg.action}` };
  }
})();
