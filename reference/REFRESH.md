# Refreshing the reference assets

The `reference/*.json` files are extracted from the reference extension's bundled config. When
the reference extension ships selector updates, you can re-pull them. Personal, non-redistributed use only
(see [`../docs/04-legal-and-scope.md`](../docs/04-legal-and-scope.md)).

## TL;DR

```bash
node reference/refresh.js
```

Regenerates all seven JSON assets from the installed extension's `remoteConfig.json` and
**reports exactly what changed**. Auto-locates the newest installed version across Chrome
profiles. No account, no network, no reference-extension API — it just re-reads a file already on disk.

## It tells you whether anything actually changed

The script never silently rewrites identical files. Each run prints a per-file status and a
one-line summary, and sets its **exit code** accordingly:

- `·  unchanged` — file was byte-identical; not rewritten.
- `✚  new` — asset didn't exist yet (first run, or you deleted it).
- `✱  changed` — content differs; the file is updated and, for the ATS selectors, the line
  below names exactly which platforms moved, e.g.
  `→ +1 added (Roblox); -1 removed (Homerun); ~2 modified (Greenhouse, Workday)`.

Final line + exit code:

- `✓ No differences. reference/ already matches installed extension <version>.` → **exit 0**
- `✱ N file(s) changed: …` → **exit 1**

So the answer to "did the reference extension actually change anything?" is the exit code: `0` = nothing
moved (their patch didn't touch what we extract, or the extension hasn't updated yet), `1` =
something moved and the summary says what. Example:

```bash
node reference/refresh.js && echo "nothing changed" || echo "selectors moved — check output above"
```

## Why this works (and its one failure mode)

The reference extension's config **ships inside the extension package** (`remoteConfig.json`, loaded via
`chrome.runtime.getURL`) and updates through normal **Chrome Web Store auto-update** — it is
*not* a live server feed (verified in `docs/01`). So "refetching patches" = letting Chrome
auto-update the extension, then re-running the script.

**Failure mode to watch for:** this relies on the config staying *bundled and plaintext*.
The extension already contains `signature`/`sha256`/`integrity` machinery, so the reference extension
*could* someday encrypt the bundled JSON or move it behind an authed server fetch. If
`refresh.js` starts failing to parse `remoteConfig.json`, or the file disappears, that's what
happened — don't try to defeat it (authed pulling would be ToS-crossing). Just fall back to
the LLM field-mapper, which is why we built it (`docs/03`).

## When to refresh

- A selector broke on a form you hit (an ATS changed its DOM; the reference extension likely already patched it).
- You want the newest ATS coverage before a heavy application push.
- Not on a schedule — one snapshot lasts a cycle, and the LLM fallback covers drift. Don't
  build an auto-harvest loop; it's unnecessary and tips into parasitic use (`docs/04`).

## Forcing / checking the extension update

Chrome auto-updates extensions every few hours. To force it now:

1. `chrome://extensions` → enable **Developer mode** → click **Update** (updates all extensions).
2. Confirm the version bumped (the on-disk path ends in the version, e.g. `.../2.6.11_0/`).

To see the installed version the script will read:

```bash
ls "$HOME/Library/Application Support/Google/Chrome/Profile 1/Extensions/pbanhockgagggenencehbnadejlgchfc/"
```

(Swap `Profile 1` for your Chrome profile dir if different; the script searches all profiles.)

## Inspecting a change in detail

The script's summary tells you *which* platforms changed; to see *how* a specific one
changed, snapshot before refreshing and diff the entry:

```bash
cp reference/ats-selectors.json /tmp/ats-old.json
node reference/refresh.js                       # summary says e.g. "~1 modified (Workday)"
diff <(jq -S '.Workday' /tmp/ats-old.json) <(jq -S '.Workday' reference/ats-selectors.json)
```

If you keep `reference/` under git (locally, not pushed), `git diff` after a refresh is the
easiest full view of what moved.

## Refreshing `fill-strategies.md` (manual — rarely needed)

`fill-strategies.md` is hand-authored analysis of the fill *engine*, not a config extract,
so `refresh.js` doesn't touch it. The engine changes far less often than the selectors. If
you suspect it changed (a fill method stopped working in a way the selectors don't explain),
re-beautify the relevant bundle and re-read the handlers:

1. The engine lives in `js/pageScript.bundle.js` and `js/contentScriptMain.bundle.js`
   (search them for `defaultWithoutBlur`/`selectCheckboxOrRadio` to find the method dispatcher).
2. There are no source maps, so names stay mangled — you only get structure. Beautify a slice
   around the dispatcher with any formatter, e.g. quick and dependency-free:

   ```bash
   npx --yes js-beautify js/pageScript.bundle.js > /tmp/pagescript.pretty.js   # if you allow npx
   ```

   then read the object mapping method-name → handler and update the verified event sequences
   in `fill-strategies.md` by hand.
3. This is a read-to-understand task, not a copy task — document the technique, don't paste
   their minified code.

## What each asset comes from (for maintenance)

| File | Source key in `remoteConfig.json` |
|---|---|
| `ats-selectors.json` | `ATS` |
| `field-taxonomy.json` | `fieldCategories`, `fieldCategoryReadableNames`, `fieldNameAliases`, `fieldDependencies`, … |
| `value-maps.json` | `countryAbbreviationsToNames`, `countryNamesToAbbreviations`, `stateAbbreviationsToNames` |
| `resume-scoring.json` | `resumeScoreCategories`, `resumeScoreKeywords`, `ResumeScores` |
| `autofill-exclusions.json` | `hiddenTrackedInputLabels`, `excluded…`, `conditionalTrackedInputExclusions`, `render.urlsExcluded` |
| `board-scrapers.json` | `Boards` |
| `sample-profile.json` | `tutorialCandidateResponse` |
| `fill-strategies.md` | hand-authored from `pageScript.bundle.js` (manual) |
