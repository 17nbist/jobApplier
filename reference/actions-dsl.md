# The actions DSL — the interpreter behind the complex config

`fill-strategies.md` covers the low-level fill *methods* (how one element gets a value).
This doc specifies the layer above it: the **`actions` mini-DSL**, the **placeholder
substitution grammar**, **repeating-section** handling, and the **`trackedObjExtractors`
job-ID template engine**. These are what make typeaheads, react-selects, multi-entry
sections, and job identification work — the config has 610 `actions` blocks and 18,634
placeholder tokens, so an engine that ignores this layer only fills the trivial fields.

Reconstructed from beautifying `contentScriptMain.bundle.js` / `background.bundle.js`
(no source maps; semantics verified from the de-minified logic, written from scratch).

## 1. The `actions` array — a per-field step machine

A selector object can carry `actions: [ …step… ]`. Each step is executed in order, awaited,
and abort-aware. A step is an object with any of these keys (all optional):

| key | meaning |
|---|---|
| `delay` | `await setTimeout(delay)` before doing anything (abortable). |
| `valueRequired` | if the field has no value, wait ~200ms and **skip** this step (don't fill empties). |
| `condition` | XPath(s); the step runs only if the condition element(s) resolve. Used for "only click if the menu isn't already open". |
| `path` | element XPath to act on. The engine **polls every 50ms up to `time`** for it to appear. |
| `time` | max wait (ms) for `path` to appear (the poll budget). |
| `removed` | instead of waiting for `path` to appear, wait for it to **disappear** (poll 50ms). |
| `allowFailure` | if the element never appears/disappears, resolve instead of throwing. Without it, a missing element throws `Element not found` and fails the field. |
| `method` | the fill method to run on the resolved element (see `fill-strategies.md`: `click`, `defaultWithoutBlur`, etc.). |
| `event` | dispatch a raw event (`keydown`, etc.) instead of a fill method. |
| `eventOptions` | `{bubbles, cancelable, key, keyCode, noBlur, clickOnly, …}` passed to the event/method. |

Execution order **within one step**: `delay` → `valueRequired` gate → `condition` gate →
wait for `path` (appear, or `removed`=disappear) with the 50ms poll up to `time` →
run `event`/`method`. Every stage checks an abort signal and bails if the run was cancelled.

Canonical typeahead (react-select) as actions — the shape you'll implement most:
```
[ {method:"click", eventOptions:{bubbles:true, cancelable:true, noBlur:true}},   // open (use mousedown; see fill-strategies.md)
  {method:"clearValue"},
  {delay:200, event:"keydown", eventOptions:{bubbles:true, key:"a", code:"KeyA"}},
  {method:"defaultWithoutBlur", eventOptions:{bubbles:true, inputType:"insertText"}}, // type query
  {time:10000, path:[ …option XPaths using %LOWERVALUE%… ], method:"click"} ]        // wait ≤10s, click match
```

## 2. Placeholder substitution grammar

Before a step's `path`/`condition` XPath or option matcher is used, tokens are substituted.
Two groups:

**Value tokens** (substituted with the field's value; `%…UNMAPPED…%` = the raw value before
any `values`/`valueMap` mapping was applied):
- `%VALUE%` · `%UNMAPPEDVALUE%`
- `%UPPERVALUE%` · `%UPPERUNMAPPEDVALUE%` (uppercased)
- `%LOWERVALUE%` · `%LOWERUNMAPPEDVALUE%` (lowercased)
- `%INPUTPATH%` → the resolved XPath of the field's own matched input (so a step can say
  "find the option menu that is a sibling of `%INPUTPATH%`").

The case variants exist because XPath 1.0 has no `lower-case()`; option matchers lowercase
both sides to compare (pairs with the `translate()` idiom in `fill-strategies.md`).

**Repeating-section index tokens** (per entry N, see §3):
- `%INDEX{n}%` → the 0-based index for loop level n.
- `%NUMBER{n}%` → `index+1` (1-based, for human-numbered fields).
- `%LENGTH{n}%` → total count at level n · `%LENGTHPLUSONE{n}%` → count+1.
- **Unresolved defaults** (critical): any leftover `%INDEX\d+%`→`0`, `%NUMBER\d+%`→`1`,
  `%LENGTH\d+%`→`0`, `%LENGTHPLUSONE\d+%`→`1`. So a template used outside a loop still resolves.

Implement substitution as ordered `String.replace(/token/g, …)` passes; do the numbered
tokens first, then the bare-default cleanup.

## 3. Repeating sections (multiple experiences / education / etc.)

Driven by `inputGroupSelector` + these templated paths on the field group:
`addButtonPath`, `removeExtraButtonPath`, `confirmAddedPath`, `containerPath` (153 uses).

Algorithm:
1. Partition the profile's array entries into **existing** groups already on the page and
   **new** ones that need a row added.
2. For each entry, at loop index `i`, substitute `%INDEX{i}%`/`%NUMBER{i}%`/`%LENGTH{i}%`
   into the group's `containerPath` etc. to scope selectors to *that row*.
3. If the row doesn't exist yet: resolve+click `addButtonPath`, then wait for
   `confirmAddedPath` to appear (proof the row was added) before filling into it.
4. Fill each field within the resolved group container (fields' own `inputSelectors`, with
   the same index tokens substituted).
5. `removeExtraButtonPath` trims rows the form pre-seeded beyond what the profile has.

The engine keeps `indexes` (per-level current index) and `lengths` (per-level counts) as it
recurses, feeding them to the substitutor. `fieldDependencies` (e.g. `birthday →
Over 18/Over 21`) can gate which sub-fields apply.

## 4. `trackedObjExtractors` — canonical job-ID template engine

Produces a stable id like `greenhouse:{company}/jobs/{id}` for tracking + as AI context
(217 `{{…}}` templates). You need this for the step-3 tracker. Each extractor:
`{urlPattern?, path?, match?, template}`.

Resolution builds a substitution map `s`, then
`Object.keys(s).reduce((acc,k)=>acc.replace("{{"+k+"}}", s[k]), template)`:

- **`searchParams[name]`** → the URL query param `name` (`?for=acme&token=123` →
  `{{searchParams[for]}}`=`acme`).
- **`urlPattern`** named params → matched with a path-to-regexp matcher against
  `location.pathname` (`/:companySlug/cx/*` → `{{companySlug}}`).
- **`path` + `match`** → run the `path` XPath to get text, apply the `match` regex; capture
  group 1 (or whole match) becomes `{{1}}`, group 2 → `{{2}}`, etc. (e.g. pull the numeric
  job id out of a form `action` URL).

First extractor whose substitution fully resolves (template no longer contains `{{`) wins;
they're ordered most-specific-first in the config.

## 5. Selector resolution notes

- **Shadow DOM** (162 paths, ADP/SuccessFactors): selectors contain `…/shadow-root//input`
  segments — your XPath/resolver must pierce shadow roots (query each host's `.shadowRoot`),
  since native XPath won't cross them.
- **iframes** (10): embedded ATS forms (Greenhouse `grnhse_iframe`, `srcdoc` frames) — resolve
  the container inside the frame; the content script already runs `all_frames`.
- **Ranked `path` arrays**: a `path` can be an array of XPaths — try each in order, first hit
  wins (the id → name → label-text fallback ladder from `fill-strategies.md`).

## What this unlocks for our build

With §1–§3 the config-driven engine faithfully executes typeaheads, react-selects, and
multi-entry sections deterministically (no LLM). With §4 the tracker (step 3) gets the reference extension's
exact job-identity scheme for free. Anything the DSL still can't resolve falls through to the
LLM mapper — but that fallback should now be rare on covered ATSes, not the common case.
