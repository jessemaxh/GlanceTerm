# GlanceTerm — agent rules

## Packaging the macOS .dmg

**The only correct command is `npm run dmg:mac`** (= `node scripts/build-macos.mjs`).
It runs the build, prepackages plugins, refreshes `app/node_modules` via yarn,
and ensures the `app/node_modules/electron → ../../node_modules/electron`
symlink — all four steps are load-bearing.

### Do not

- **Do not call `electron-builder` directly.** It silently ships an `app.asar`
  with zero `node_modules`; the resulting `.app` crashes at launch with
  `Cannot find module 'v8-compile-cache'`. The build "succeeds" so the
  failure isn't caught until a human runs the app.
- **Do not set `SKIP_PREPACKAGE=1` for a final/ship build.** It is for
  inner-loop iteration on the Electron shell only. Even with a valid
  `app/node_modules/electron` symlink and a fresh `(cd app && yarn)`, the
  dep walker has been observed to silently bail and ship an asar with zero
  `node_modules`. The unconditional prepackage path is the only one verified
  to produce a runnable .app.
- **Do not "save time" by reusing a previous `dist/mac-arm64/` build.** If
  you didn't watch this `npm run dmg:mac` finish in this session, treat the
  artifacts as suspect and rebuild.

### Self-check

`scripts/build-macos.mjs` verifies the asar contains `v8-compile-cache`,
`keytar`, `source-map-support`, and `electron-updater` inside its
`afterPack` hook — i.e. *before* the DMG is assembled. If you see
`✖ BROKEN BUILD — app.asar is missing production node_modules`, do not
retry blindly: re-read the diagnostic, then run the recommended fix.

### Why `dist/mac-arm64/GlanceTerm.app` gets deleted after the build

`npm run dmg:mac` removes the loose `dist/mac-arm64/GlanceTerm.app` once the
DMG/zip are produced (both artifacts already contain it). This avoids
LaunchServices indexing a second `GlanceTerm.app` next to
`/Applications/GlanceTerm.app` — when both are registered, Launchpad and
Spotlight return duplicates and can fail to match the app by name. Set
`KEEP_DIR_BUILD=1` if you need the unpacked .app for debugging.

### Reporting "build done"

Only report a successful packaging once the self-check has printed
`• verifying asar deps …` and the script has exited 0. A green
electron-builder log alone is not sufficient evidence.
