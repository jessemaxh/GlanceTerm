#!/usr/bin/env bash
# Launch the forked Tabby with our plugin preloaded.
# Quits any running Tabby first — they share a single-instance lock.
# Adds --remote-debugging-port so we can self-verify via CDP as before.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK="$ROOT/tabby-fork"
PLUGIN="$FORK/tabby-plugin-ai-sidebar"

# Build the plugin (cheap, fast).
echo "→ building plugin…"
(cd "$PLUGIN" && npm run build) >/dev/null

# Ensure no other Tabby is hogging the single-instance lock or the debug port.
# We're cautious here: only the GUI Tabby (the brewed Tabby.app) and our fork
# Electron. We do NOT pkill -f claude (see memory).
osascript -e 'quit app "Tabby"' 2>/dev/null || true
sleep 1

echo "→ launching fork Tabby with our plugin…"
cd "$FORK"
TABBY_PLUGINS="$PLUGIN" \
TABBY_DEV=1 \
exec ./node_modules/.bin/electron app -d --remote-debugging-port=9222
