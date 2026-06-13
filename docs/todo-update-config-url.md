# TODO — Update config URL (remote version check)

Wire up the data source for the remote version-check / update gate.

**Status:** built, disabled · **Added:** 2026-06-13

Naming convention: one file per scoped feature, `todo-<feature-slug>.md`.

### One-liner
The remote version-check + update gate (Step 1) is implemented and shipped but
**disabled by default** — `ai.updateCheck.configUrl` is empty, so
`UpdateCheckService` no-ops. To turn it on, stand up a JSON endpoint and point
the config at it. No code change needed to enable.

### What's left
1. **Stand up the JSON endpoint** (Cloudflare Worker / R2 / GitHub raw — leaning
   Cloudflare for the rollout/conditional-targeting headroom). Shape:
   ```json
   {
     "latest": "1.1.0",
     "minimum": "1.0.0",
     "notes_url": "https://github.com/jessemaxh/glanceterm/releases",
     "downloads": {
       "mac": "https://.../GlanceTerm-1.1.0-arm64.dmg",
       "win": "https://.../GlanceTerm-1.1.0-setup.exe",
       "linux": "https://.../GlanceTerm-1.1.0.AppImage"
     }
   }
   ```
   `latest`/`minimum` are required + must be valid SemVer; everything else is
   optional. Serve over HTTPS — this is a remote kill-switch (force-update), so
   treat the source as a security asset.
2. **Set `ai.updateCheck.configUrl`** to that URL (Tabby config / settings).
   That's the whole "enable" step.
3. **Phase 2 (after signing + CI release land):** swap
   `UpdateCheckService.openDownload()` from "open the download URL in the
   browser" to the electron-updater IPC (`updater:check-for-updates` →
   `updater:quit-and-install`). The gating logic + both UIs stay untouched.
   electron-updater is already wired in `app/lib/window.ts`; it just needs a
   `build.publish` feed + signed builds producing `latest-*.yml`.

### Behaviour recap
- `current < minimum` → non-dismissible force-update modal → download
- `minimum ≤ current < latest` → dismissible "update available" prompt (once
  per new version)
- otherwise / **any fetch or parse error** → silent no-op (fail-open)

### Pointers
- Decision logic (pure, unit-tested): `tabby-plugin-ai-sidebar/src/update-decision.ts`
- Service: `tabby-plugin-ai-sidebar/src/update-check.service.ts`
- Force modal: `tabby-plugin-ai-sidebar/src/update-force-modal.component.ts`
- Default config: `tabby-plugin-ai-sidebar/src/ai-config-provider.ts` (`ai.updateCheck`)
- Tests: `tabby-plugin-ai-sidebar/src/__tests__/update-decision.test.ts`
