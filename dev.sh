#!/usr/bin/env bash
# Launch GlanceTerm in dev mode with the bundled AI sidebar plugin preloaded.
#
# Uses a dedicated user-data dir so the dev session does NOT share
# preferences / plugins / single-instance lock with a brew-installed Tabby.
# You can run both side by side.
#
# Remote-debugging port stays on 9222 for CDP-driven self-testing.

set -euo pipefail
FORK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$FORK/tabby-plugin-ai-sidebar"
MOBILE_BRIDGE_PKG="$FORK/tabby-plugin-mobile-bridge"
TERMINAL_PKG="$FORK/tabby-terminal"
USER_DATA="$HOME/Library/Application Support/GlanceTerm-dev"

# Rebuild the plugin (fast, idempotent).
echo "→ building plugin…"
(cd "$PLUGIN" && npm run build) >/dev/null

# Build mobile-bridge — its dist/ is gitignored and the plugin is registered
# in builtin-plugins, so a missing dist/index.js makes Angular bootstrap fail
# and the renderer wedges on the splash logo. Cheap, idempotent.
echo "→ building mobile-bridge plugin…"
(cd "$MOBILE_BRIDGE_PKG" && ../node_modules/.bin/webpack) >/dev/null 2>&1

# Rebuild tabby-terminal too — we vendored an `IMAGE_PASTE_HOOK` extension
# point into BaseTerminalTabComponent (see tabby-terminal/src/api/), and a
# stale dist/ from before that change will make Angular fail to resolve the
# IMAGE_PASTE_HOOK token at construction time. dist/ is gitignored so anyone
# pulling these changes will have an out-of-date built tree until this runs.
# ~3 s on a warm machine; skip with SKIP_TERMINAL_BUILD=1 once you know it's
# in sync.
if [[ -z "${SKIP_TERMINAL_BUILD:-}" ]]; then
    echo "→ building tabby-terminal…"
    (cd "$TERMINAL_PKG" && ../node_modules/.bin/webpack) >/dev/null 2>&1
fi

# We do NOT touch brewed Tabby — separate user-data-dir means independent locks.
# But if a previous GlanceTerm-dev Electron is still alive, quit it. Scoped
# strictly by the user-data-dir argument so we never touch unrelated procs.
if pgrep -f "user-data-dir=$USER_DATA" >/dev/null 2>&1; then
    echo "→ stopping previous GlanceTerm-dev instance…"
    pkill -f "user-data-dir=$USER_DATA" || true
    sleep 1
fi

mkdir -p "$USER_DATA"

echo "→ launching GlanceTerm (dev) — user-data-dir=$USER_DATA"
cd "$FORK"
TABBY_PLUGINS="$PLUGIN" \
TABBY_DEV=1 \
exec ./node_modules/.bin/electron app \
    -d \
    --remote-debugging-port=9222 \
    --user-data-dir="$USER_DATA"
