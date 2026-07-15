// Shared e2e scaffolding: launch the unpacked extension in bundled Chromium, open the
// panel, tally checks, tear down. Board-finding, storage seeding, and assertions stay in
// the individual test files — only the genuinely shared pieces live here.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ART = path.join(EXT, "test", "artifacts");
fs.mkdirSync(ART, { recursive: true });

export function makeChecker() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  return { results, check };
}

// Node-side loader for the plain-script extension modules (profile-schema + ai.js) —
// shared by the resolver/validator/fixture suites instead of triplicating the
// new-Function sandbox dance.
export function loadAiSandbox() {
  const src = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
  const sandbox = {};
  new Function("globalThis",
    `${src("profile-schema.js")}\n${src("ai.js")}\n` +
    "globalThis.JA_AI = JA_AI; globalThis.JA_SAMPLE_PROFILE = JA_SAMPLE_PROFILE; globalThis.JA_PROFILE_SECTIONS = JA_PROFILE_SECTIONS;",
  )(sandbox);
  return sandbox; // { JA_AI, JA_SAMPLE_PROFILE, JA_PROFILE_SECTIONS }
}

// Tally + exit for suites that don't hold a browser/server (finish() covers those).
export function summarize(results) {
  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
  process.exit(fails.length ? 1 : 0);
}

// Bundled Chromium only: branded Chrome >=137 dropped --load-extension.
export async function launchExtension() {
  const context = await chromium.launchPersistentContext("", {
    headless: !!process.env.HEADLESS,
    viewport: { width: 1440, height: 950 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  return { context, sw, extId };
}

export async function openPanel(context, extId, query = "") {
  const panel = await context.newPage();
  panel.on("console", (m) => { if (m.type() === "error") console.log("panel console.error:", m.text()); });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html${query}`);
  return panel;
}

export async function finish(context, server, results) {
  await context?.close();
  server?.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
  process.exit(fails.length ? 1 : 0);
}
