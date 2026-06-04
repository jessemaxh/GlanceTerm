#!/usr/bin/env bash
# Launch HiveTerm in dev mode with the bundled AI sidebar plugin preloaded.
#
# Uses a dedicated user-data dir under /tmp so the dev session does NOT
# share preferences / plugins / single-instance lock with a brew-installed
# Tabby. You can run both side by side.
#
# Remote-debugging port stays on 9222 for CDP-driven self-testing.

set -euo pipefail
FORK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$FORK/tabby-plugin-ai-sidebar"
USER_DATA="$HOME/Library/Application Support/HiveTerm-dev"

# Rebuild the plugin (fast, idempotent).
echo "→ building plugin…"
(cd "$PLUGIN" && npm run build) >/dev/null

# We do NOT touch brewed Tabby — separate user-data-dir means independent locks.
# But if a previous HiveTerm-dev Electron is still alive, quit it.
if pgrep -f "user-data-dir=$USER_DATA" >/dev/null 2>&1; then
    echo "→ stopping previous HiveTerm-dev instance…"
    pkill -f "user-data-dir=$USER_DATA" || true
    sleep 1
fi

mkdir -p "$USER_DATA"

echo "→ launching HiveTerm (dev) — user-data-dir=$USER_DATA"
cd "$FORK"
TABBY_PLUGINS="$PLUGIN" \
TABBY_DEV=1 \
exec ./node_modules/.bin/electron app \
    -d \
    --remote-debugging-port=9222 \
    --user-data-dir="$USER_DATA"
