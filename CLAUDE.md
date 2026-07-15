# CLAUDE.md — jobApplier

Guidance for Claude working in this repo.

## What this is

A personal, local-first job-application copilot: a single MV3 browser extension that extracts
job/form context and calls GLM 5.2 (via OpenRouter) directly for résumé tailoring, cover
letters, and application-question answers. **No server** — there's exactly one user, forever,
so the client/server split buys nothing. Built for the user's own 2026–2027 new-grad SWE
cycle. **Not a product, not distributed.**

Owner context: the user built `../accountabilitymachine` (an MV3 extension using OpenRouter
+ `z-ai/glm-5.2`), so reuse that stack and their known patterns. They prefer honest
trade-offs over hype.

## Repo layout

- `README.md` — vision, architecture diagram, thesis.
- `docs/01..06` — the reference extension teardown, ATS-extraction guide, our architecture, legal/scope,
  AIHawk comparison, CV→profile autofill. **Read the relevant doc before acting in its area.**
- `reference/` — assets extracted from the reference extension's freely-served config for personal
  reference (see constraint below): `ats-selectors.json` (52-ATS fill playbooks),
  `fill-strategies.md` (fill methods/event sequences), `actions-dsl.md` (the actions step
  machine, placeholder grammar, repeating sections, job-ID templates), `field-taxonomy.json`,
  `value-maps.json`, `board-scrapers.json`, `resume-scoring.json`, `autofill-exclusions.json`,
  `sample-profile.json`. Regenerate with `node reference/refresh.js` (reports what changed;
  exit 0 = nothing moved) — see `reference/REFRESH.md`. Do NOT hand-edit the generated JSON.
- No app code yet — this is design/reference phase.

## The thesis (why the design is what it is)

The reference extension's moat (52-ATS selector library) is **free-tier and client-side**; their **paid**
$90 tier is just AI generation (cover letters, answers) run server-side. So we reuse the
free config as a working fill engine and self-host the AI. See `docs/01`.

## Architecture decisions (don't relitigate)

- **All-in-one, no server**: everything is in the extension; the sidepanel calls OpenRouter
  (`https://openrouter.ai/api/v1/chat/completions`, `z-ai/glm-5.2`) directly. Single user =
  no multi-tenancy, no paywall, no key-protection reason to split. The "routes" are internal
  async functions in `ai.js`, not HTTP endpoints. `docs/03`.
- **Hybrid fill**: config-driven (`reference/ats-selectors.json`) as primary, LLM
  field-mapping as fallback for uncovered/stale forms. `docs/03`.
- **Profile schema**: adopt AIHawk's `plain_text_resume.yaml` shape (`docs/05`) — it
  separates `legal_authorization` and `self_identification` correctly.
- **Storage**: CV + profile + API key in `chrome.storage.local`. Only per-request context
  goes to OpenRouter; nothing else leaves the machine.

## Non-negotiable rules

1. **Legal fields are hard-coded, never LLM-generated.** Work authorization, sponsorship,
   visa, and EEO/`self_identification` answers come verbatim from the profile. Keep a
   `LEGAL_FIELDS` set the AI path refuses. A hallucinated sponsorship/auth answer can void
   an offer. This is the most important rule.
2. **Career pages only.** Greenhouse/Lever/Ashby/Workday application forms — what the reference extension
   itself automates. **Never** automate LinkedIn Easy-Apply or mass-apply (the AIHawk ban
   vector; `docs/05`).
3. **CV never leaves the machine** except as per-request context sent to OpenRouter.
4. **API key in `chrome.storage.local`** (fine — personal, never-distributed extension; no
   attacker to protect it from, same as `../accountabilitymachine`).

## The `reference/` constraint (important)

These files are extracted from the reference extension's config. Reuse is justified *only* because it's
free-tier data, largely functional (form selectors), and used personally/non-redistributed.
Therefore: **do not commit `reference/` to any public repo, ship it in a distributed
extension, publish it, or sell anything built on it.** If the project ever goes beyond
personal one-cycle use, drop the copied config and rely on the LLM field-mapper. Rationale
in `docs/04`. Do not copy AIHawk *code* (AGPL-3.0, viral) — the schema/config is fine.

## Build order (v1)

1. ✅ `schemaScrape` (DOM→field schema) + `ai.mapFields()` + `ai.coverLetter()` — the LLM path
   alone is a working tool on any form, needs no config.
2. ✅ Résumé→profile import: pdf.js text extract + `ai.parseResumeToProfile()` (`docs/06`),
   plus storing the PDF bytes for uploads.
3. ✅ Config `fillEngine` (`config-engine.js`) for **all 52 playbooks** in
   `reference/ats-selectors.json` — a generic interpreter of `reference/fill-strategies.md`
   (methods) + `reference/actions-dsl.md` (actions DSL, placeholders, repeating sections,
   job-ID extractors). Full method vocabulary incl. best-effort dijit/ui5/tinyMCE/jQuery;
   résumé upload via DataTransfer; essays via `ai.answerBatch`; multi-page flows
   (continue = user-clicked; Workday hardening is the tail of this step). Gate: the all-52
   structural-validation suite (`test/validate-config.mjs`) + fixtures + both e2e suites.
   Only a handful of ATSes are live-verified; the rest are verified-by-construction and
   coverage-logged (`coverageLog` in storage) at first real use.
4. ✅ Local tracker keyed by the canonical job id (engine's `extractJobId`) +
   `submittedSuccessPaths`, with fill telemetry + scrubbed break snapshots.
5. ✅ Résumé tailoring (`tailor-core.js` + Tailor tab): `ai.tailor()` reorders/rephrases the
   structured CV against a posting; `auditTailored()` is a defense-in-depth fabrication check
   (RED-flags invented metrics/tools/unattributable claims — reordering is allowed and must
   NOT flag); keyword-coverage meter + word-diff; pdfMake regenerates an ATS-friendly PDF
   (NOT the original layout — the dual-canvas preview makes that cost visible). An approved
   tailored PDF uploads ONLY for its own job (`pickUploadResume` gates on `approvedAt`); every
   other job uploads the original. Legal/EEO never enters the tailor path. Gate:
   `test/unit-tailor.mjs`, `unit-ai-tailor.mjs`, `e2e-tailor.mjs` (mock + LIVE).

## Conventions

- Match `../accountabilitymachine` style: vanilla JS, MV3, `chrome.storage.local`, sidepanel,
  direct OpenRouter fetch to `z-ai/glm-5.2` (copy its request/streaming shape). No framework,
  no build step, no server unless the user asks.
- When implementing a fill method, follow the verified event sequences in
  `reference/fill-strategies.md` (they're trial-and-error-hardened; don't simplify them).
