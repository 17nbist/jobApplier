# jobApplier

A Chrome extension that fills out job applications for you — autofills the boring fields on
Greenhouse / Lever / Ashby / Workday, drafts tailored cover letters and application answers
with AI, and reshapes your résumé to match the posting. Everything runs in your browser with
your own API key. Nothing goes to a server, and it never hits Submit for you.

## Features

- **Autofill** on Greenhouse, Lever, Ashby, and Workday forms — name, contact, links, work
  history, EEO, all from a profile you set up once. 50+ ATS platforms supported via a config
  engine, with an AI fallback that maps fields on any form the config doesn't cover.
- **AI cover letters** written against the specific job description, using your own
  OpenRouter key (defaults to GLM 5.2).
- **AI answers** to application questions ("why do you want to work here?", etc.).
- **Résumé tailoring** — reorder and rephrase your existing résumé to match a posting's
  keywords, with a coverage meter and an anti-fabrication check that flags any invented
  metric, tool, or claim. Exports a clean, ATS-friendly PDF.
- **Résumé import** — drop in your résumé PDF and it builds your profile automatically.
- **Application tracker** — keeps a local log of what you've applied to.
- **Local and private** — your résumé, profile, and API key live in your browser
  (`chrome.storage.local`). The only thing that leaves your machine is the per-request
  context sent to OpenRouter. Work-authorization / sponsorship / EEO answers always come
  straight from your profile — the AI never writes those.

## Installation and Usage

You'll need Google Chrome and a free [OpenRouter](https://openrouter.ai) account (you pay
per request for the AI — a full application costs a fraction of a cent).

1. **Get the code.** Clone or download this repo somewhere permanent — Chrome loads the
   extension from this folder, so don't delete or move it after:
   ```
   git clone https://github.com/YOUR_USERNAME/jobApplier.git
   ```
2. **Open** `chrome://extensions` in Chrome (type it in the address bar).
3. **Turn on Developer mode** (toggle, top-right).
4. **Click "Load unpacked"** (top-left) and select the `jobApplier` folder — the one with
   `manifest.json` in it.
5. **Pin it** — click the puzzle-piece icon in the toolbar and pin **jobApplier**. Click the
   icon to open the side panel; everything happens there.
6. **Add your API key** — in the side panel's Settings, paste your OpenRouter key (create one
   at openrouter.ai → Keys). Leave the model as `z-ai/glm-5.2` unless you have a preference.
7. **Build your profile** — upload your résumé PDF in the panel. It fills in your profile
   automatically. Review it, and fill in the work-authorization / EEO sections **yourself**
   (the importer never touches those on purpose).
8. **Apply.** Open any Greenhouse / Lever / Ashby / Workday application, open the side panel,
   and hit **Scan** then **Fill**. Review everything, then **you** click Continue / Submit —
   the extension never submits for you.

The config fill engine (fast, no-token autofill on the 50+ supported platforms) works
immediately — the selector playbooks ship with the repo. If a platform's form changes and
autofill drifts, you can refresh the playbooks with `node reference/refresh.js` from the repo
root (needs Node.js 18+); see [reference/REFRESH.md](reference/REFRESH.md).

**After editing the code:** go to `chrome://extensions` and click the ↻ reload icon on the
jobApplier card.

## Supported ATS platforms

Config-driven autofill covers 50+ platforms including Greenhouse, Lever, Ashby, Workday,
iCIMS, SmartRecruiters, Taleo, and more. Any form not in the config still works through the
AI field-mapper. A handful are live-verified; the rest are verified-by-construction and
confirm on first real use.

## Contributing

ATS forms change their layouts constantly, which breaks selectors — that's the one part of a
tool like this that genuinely needs a community. If a form stops filling correctly, a fix is
usually small and self-contained. Open an issue or a PR with the ATS name and what broke, and
it helps everyone using it. Bug reports, new-platform support, and prompt improvements all
welcome.

## Notes & disclaimer

- **Career pages only.** This automates the same application forms a normal autofill tool
  does (Greenhouse, Lever, Ashby, Workday). It is **not** for LinkedIn Easy-Apply or
  mass-applying — that gets accounts banned and isn't what this is.
- **You stay in control.** It fills forms; you review and submit. It never applies on its own.
- **Résumé tailoring** regenerates a clean, ATS-friendly PDF from your content — it does not
  reproduce your original PDF's exact design. The Tailor tab shows both side by side so you
  can see the trade-off before approving.
- Personal project, provided as-is. No warranty, no affiliation with any ATS or job board.
