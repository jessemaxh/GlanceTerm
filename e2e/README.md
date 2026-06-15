# GlanceTerm sidebar E2E (Playwright `_electron`)

Launches the real app and drives the sidebar by writing synthetic
`~/.glanceterm/hooks/<tab-id>.log` events, then asserts the rendered row
`[data-tab-id]` `[data-status]`. Isolated from the monorepo dep graph (own
package.json) to dodge a pre-existing pug ERESOLVE.

## Run
    cd e2e && npm install        # once (Playwright, no browsers needed)
    npx playwright test

`global-setup.ts` rebuilds the plugin dists first.

## ⚠️ Installed-app plugin shadow (self-skip)
On a dev machine with **GlanceTerm.app installed in /Applications**, the dev
launch resolves `process.resourcesPath` to the installed bundle and loads
`/Applications/GlanceTerm.app/Contents/Resources/builtin-plugins/tabby-plugin-ai-sidebar`
(stale, from the last dmg) FIRST, deduping/skipping the repo's fresh copy. The
under-test code (the `data-tab-id` attr + the `GLANCETERM_E2E` seam) is then NOT
loaded, so the suite **self-skips** (it detects the missing seam) instead of
asserting against the wrong build.

To run the assertions locally, ensure the fresh build is the one that loads —
options: (a) run on a machine/CI without GlanceTerm.app installed; (b) sync the
freshly-built `tabby-plugin-ai-sidebar/dist` into the installed bundle's
`builtin-plugins/tabby-plugin-ai-sidebar/dist`; or (c) launch via dev.sh's
`.bin/electron` path instead of the raw binary (the raw-binary launch is what
triggers the installed-bundle resolution). Needs a maintainer decision.
