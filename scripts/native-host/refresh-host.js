#!/usr/bin/env node
// Native-messaging host for jobApplier's "Refresh reference config" button.
// Speaks Chrome's framing (4-byte LE length + JSON) on stdio, runs
// `node reference/refresh.js`, and replies { ok, exitCode, output }.
// Installed by install.sh; launched by Chrome, one process per message exchange.

const { execFileSync } = require("child_process");
const path = require("path");

const REFRESH_JS = path.resolve(__dirname, "..", "..", "reference", "refresh.js");

// Exit only after the pipe write flushes — process.exit() right after a >64KB write can
// truncate the frame (macOS pipe buffer) and Chrome then rejects the whole response.
function sendAndExit(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]), () => process.exit(0));
}

function handle(msg) {
  if (!msg || msg.cmd !== "refresh") {
    sendAndExit({ ok: false, error: `unknown cmd: ${msg && msg.cmd}` });
    return;
  }
  let output = "";
  let exitCode = 0;
  try {
    // refresh.js exits 0 = unchanged, 1 = changed, 2 = extension not found.
    output = execFileSync(process.execPath, [REFRESH_JS], {
      encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    exitCode = typeof e.status === "number" ? e.status : -1;
    output = `${e.stdout || ""}${e.stderr || ""}` || String(e.message);
  }
  // Native messaging caps host→extension messages at 1MB; the summary is tiny anyway.
  sendAndExit({ ok: exitCode === 0 || exitCode === 1, exitCode, output: output.slice(0, 100000) });
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (buf.length < 4) return;
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) return;
  let msg = null;
  try { msg = JSON.parse(buf.slice(4, 4 + len).toString("utf8")); } catch { /* reply below */ }
  handle(msg); // exits via sendAndExit once the reply has flushed
});
process.stdin.on("end", () => process.exit(0));
