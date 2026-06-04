#!/usr/bin/env bash
# Rebuild the plugin and launch Tabby with TABBY_PLUGINS pointing at us.
# Quit any running Tabby first — it only loads plugins at startup.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

echo "→ building plugin…"
npm run build

# Kill any running Tabby so the new plugin gets picked up on next launch.
if pgrep -x Tabby >/dev/null; then
  echo "→ quitting running Tabby…"
  osascript -e 'quit app "Tabby"' || true
  sleep 1
fi

echo "→ launching Tabby with our plugin (--debug)…"
TABBY_PLUGINS="$HERE" exec /Applications/Tabby.app/Contents/MacOS/Tabby --debug
