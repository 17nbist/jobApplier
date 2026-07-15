#!/bin/bash
# One-time install of the jobApplier native-messaging host (macOS).
# Chrome launches native hosts with a minimal PATH, so the wrapper bakes in the
# absolute node path resolved right now. Re-run after moving the repo or node.
# (The extension's RSA key pair lives in ~/.config/jobapplier/ — kept OUT of this
# tree because Chrome's "Load unpacked" warns about any .pem in the extension dir.
# Only extension-id.txt is needed here; the public key is pinned in manifest.json.)
set -euo pipefail

HOST_NAME="com.nbist.jobapplier"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ID="$(cat "$DIR/extension-id.txt")"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH — install Node or add it to PATH, then re-run." >&2
  exit 1
fi

WRAPPER="$DIR/run-host.sh"
cat > "$WRAPPER" <<EOF
#!/bin/bash
exec "$NODE_BIN" "$DIR/refresh-host.js"
EOF
chmod +x "$WRAPPER"

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "jobApplier: runs reference/refresh.js to re-extract the reference config",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

# Chrome for daily use; Chromium for the Playwright test harness (branded Chrome >=137
# can't load unpacked extensions via --load-extension anymore).
for BROWSER_DIR in "Google/Chrome" "Chromium"; do
  DEST="$HOME/Library/Application Support/$BROWSER_DIR/NativeMessagingHosts"
  mkdir -p "$DEST"
  printf '%s\n' "$MANIFEST" > "$DEST/$HOST_NAME.json"
  echo "installed: $DEST/$HOST_NAME.json"
done

echo "native host ready (extension id: $EXT_ID, node: $NODE_BIN)"
