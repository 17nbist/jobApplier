# Fill-strategy internals — the interpreter behind the config

The [`ats-selectors.json`](ats-selectors.json) config is just *instructions*
(`method: "react"`, `method: "click"`, …). The content script is the *interpreter* that
executes them. This documents how each strategy actually works, so you can reimplement the
engine. Techniques verified present in the reference extension's `contentScriptMain.bundle.js` /
`pageScript.bundle.js`; the explanations here are standard DOM/React technique, written from
scratch (not copied from their minified code).

## Why you can't just set `input.value`

Modern ATS forms are React (Greenhouse, Workday, Uber, Workable all `defaultMethod: react`).
React keeps an internal `_valueTracker` on each input recording the last value it set. If you
do `input.value = "x"` directly, the tracker still holds the old value, so React's synthetic
`onChange` never fires and **your value gets wiped on the next render**. This is the single
reason naïve autofill fails on React forms.

### The fix: call the *native* setter, then dispatch input

```js
// The React-aware value set ("react" / "reactClick" methods)
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value").set;
  nativeSetter.call(el, value);                 // bypasses React's overridden setter
  el.dispatchEvent(new Event("input", { bubbles: true }));  // React sees the real change
}
```

The reference extension's minified code does exactly this (`Object.getOwnPropertyDescriptor(e.constructor.
prototype, "value")` + a `valueTracker` shim). This helper *is* the `react` method.

## The strategy vocabulary (how to implement each `method`)

| `method` | Implementation sketch |
|---|---|
| `default` | `setNativeValue` → dispatch `input` **and** `change` → `blur` (FocusEvent). Plain controlled inputs. |
| `defaultWithoutBlur` | Same but **skip blur** — typeaheads/autocompletes close their option list on blur, so you must stay focused to then click an option. |
| `react` | `setNativeValue` + `input` event only (table above). |
| `reactClick` | React-aware `click()` via a real `MouseEvent({bubbles, cancelable})`. |
| `click` | Full real-click sequence: `focus → mousedown → mouseup → click() → blur` (`eventOptions.clickOnly` collapses it to a bare click; `noBlur` keeps focus). The leading mousedown is load-bearing — react-selects open on mousedown and ignore bare click events. Used for dropdown options, radios, buttons. |
| `selectCheckboxOrRadio` | Find the input whose label/value matches, set `.checked = true`, dispatch `click` + `change`. |
| `clearValue` | `setNativeValue(el, "")` + `input`, before typing (some fields reject appended text). |
| `uploadResume` / `uploadCoverLetter` | The `DataTransfer` trick below. |
| `writeCoverLetter` / `tinyMCE` | Rich-text editors: set the editor body's `innerHTML`/iframe doc, dispatch `input`. TinyMCE needs `tinymce.get(id).setContent()`. |
| `dijit` / `ui5` / `jQuery` | Legacy widget frameworks (Oracle/Taleo/SuccessFactors). Set value through the widget's own API or trigger jQuery `.trigger("change")`. Rare; skip unless a target needs it. |
| `reactDatePickerMonth` | Open the picker (click), then click the month/year cell whose text matches. |

## File upload — injecting the résumé into a file input

You can't set `input.files` directly (read-only), but you can build a `DataTransfer`:

```js
// "uploadResume" / "uploadCoverLetter"
function setFileInput(input, file /* a File built from the resume blob */) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;                        // now populated
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
```

The résumé blob comes from your local profile (we store it locally — see doc 03). Build the
`File` with the right name+MIME: `new File([blob], "Resume.pdf", {type:"application/pdf"})`.

## Driving a typeahead (the multi-step `actions` case)

Location/school/company fields are async comboboxes. The sequence the config encodes:

```
1. mousedown the combobox        (react-select opens on MOUSEDOWN, not click — a bare
                                  click event does nothing; fire mousedown→mouseup, noBlur)
2. clearValue                    (setNativeValue "", input)
3. keydown a real key            (KeyboardEvent — some widgets only fetch on keystroke)
4. defaultWithoutBlur the query  (setNativeValue text, input; DO NOT blur)
5. wait (poll up to ~10s) for the options menu to render
6. click the option whose text matches   (MouseEvent on the <li role=option>)
```

Note on step 1: the production `click` method is itself a full
`focus → mousedown → mouseup → click() → (blur unless noBlur)` sequence — so a config
step that says `method: "click"` on a combobox *does* open it, because the mousedown is
part of the method. Any engine that implements `click` as a bare `MouseEvent("click")`
will silently fail on react-selects. The step machinery around these sequences
(`actions`, placeholders, repeating sections) is specified in
[`actions-dsl.md`](actions-dsl.md).

Event ctors the reference extension uses for this: `MouseEvent`, `FocusEvent`, `InputEvent`,
`KeyboardEvent` — the full set, because different widgets listen for different ones. When in
doubt, fire `input` + `change` + `keydown`/`keyup` and give the menu a poll-with-timeout.

## The label-matching helper (reused everywhere)

XPath 1.0 has no `lower-case()`, so matching a field by its visible label text uses a
`translate()` sandwich for case-folding + punctuation-stripping. Wrap it once:

```js
// case-insensitive, punctuation-insensitive "does this element's text contain `needle`"
const FOLD_FROM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", FOLD_TO = "abcdefghijklmnopqrstuvwxyz";
function labelXPath(needle) {
  return `.//label[contains(concat(' ', normalize-space(translate(translate(.,` +
    `"${FOLD_FROM}","${FOLD_TO}"), "/:_-,.;()?!*& ", "              ")), ' '), ` +
    `' ${needle} ')]`;
}
```

This one idiom is what makes the label-fallback selectors resilient across ATS theme changes.

## Engine skeleton (put it together)

```js
async function fillField(container, canonicalField, selectorList, profile) {
  const value = profile[canonicalField];
  if (LEGAL_FIELDS.has(canonicalField) && value == null) return; // never guess legal fields
  for (const sel of selectorList) {
    const el = resolveXPath(container, sel.path ?? sel);          // try ranked paths
    if (!el) continue;
    const method = sel.method ?? atsDefaultMethod;
    if (sel.actions) { await runActions(el, sel.actions, value); return; }
    dispatchFill(el, method, value);                             // table above
    return;
  }
}
```

That's the whole trick: config picks *what* and *where*; this engine handles *how*.

## Verified event sequences (from beautifying their `pageScript.bundle.js`)

No source maps ship, so names stay mangled — but the structure de-minifies cleanly, and
the exact event choreography is worth copying verbatim because it's the product of lots of
trial-and-error against real forms:

- **`default` is polymorphic.** It inspects the element and routes: `<select>` → select
  handler, `<button>`/`role=button` → click, checkbox/radio → check handler, input/textarea
  → native-value set. One `default` covers every widget type; you don't pick per field.
- **`<select>` full fire sequence** (order matters):
  `focus → click → setValue → CustomEvent("textInput") → InputEvent("input") →
  change → click → blur`. The double click (before *and* after) and the legacy
  `textInput` event are what make stubborn custom-styled selects register.
- **Checkbox/radio**: skip if already in the desired state; else
  `focus → (checkbox ? el.click() : MouseEvent click + set el.checked) → textInput →
  input → change → blur`.
- **`default` blurs on a delay**: it fills, then `await setTimeout(10ms)`, then `blur()`.
  The tick lets React flush its onChange before focus leaves — blurring synchronously can
  drop the value. (`defaultWithoutBlur` is the same router *without* that trailing blur,
  for typeaheads.)
- **Event options** carry `{bubbles, cancelable}` and sometimes a real `key`/`keyCode`, so
  widgets listening on `keydown` fire. When an `event` name is given with a key, they use
  `KeyboardEvent`; otherwise a plain `Event`.

Reproducing these four sequences (input, select, checkbox, typeahead) covers ~95% of real
fields. The beautified reference lives in your scratchpad, not committed here.
