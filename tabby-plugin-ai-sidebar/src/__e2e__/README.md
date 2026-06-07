# Layer 3 E2E tests

Drives a running GlanceTerm dev instance over Chrome DevTools Protocol.

## Run

```bash
# Terminal 1: start the dev instance
./dev.sh

# Terminal 2: run the suite
cd tabby-plugin-ai-sidebar
npm run test:e2e
```

The harness throws an actionable error if `./dev.sh` isn't up — there's
no "magic spawn" that auto-launches it (yet), because cold-start takes
several seconds and would dominate CI wall-clock.

## What's here

| File | Purpose |
|---|---|
| `harness.ts` | CDP attach + `evaluate` / `click` / `pressKey` / `getSidebarState` / `waitFor` |
| `settings-dialog.test.ts` | Smoke: gear click opens modal, Esc closes it |

## Adding a new test

1. `import { E2EHarness }` in a new `*.test.ts`.
2. Drive the UI via `harness.click(selector)` / `harness.pressKey(key)`.
3. Read state via `harness.getSidebarState()` for structured snapshots,
   or `harness.evaluate('<JS expression>')` for arbitrary renderer queries.
4. Use `harness.waitFor(predicate)` to bridge async UI updates (CD
   passes, tab-monitor polls). Default 2 s budget — bump via the
   `timeoutMs` option for genuinely long flows.

## Selector contract

These selectors are exercised by tests; renaming them needs a coordinated
template + spec change:

- `.action-btn.settings-btn` — gear button in the sidebar action row
- `.gt-settings-modal` — settings modal root (rendered via NgbModal portal)
- `.gt-setting-title` — title text inside each setting row
- `.sb-list .row` — one row per tab in the sidebar list
- `.sb-list .row .primary` — tab title text
- `.sb-list .row .status` — status label ("working" / "ready" / "done" / …)
- `.sb-footer .stat.work|idle|done-stat|attn-stat` — footer count badges

## What's intentionally NOT here yet

- Hook-event injection (writing into `~/.glanceterm/hooks/<tab>.log` from
  inside the renderer process). Hook layer is already covered by
  Layer 2 replay tests — Layer 3 will only need this once we want to
  assert end-to-end "event arrives → sidebar updates within X ms".
- New-tab orchestration (creating a Tabby tab from a test). Needs
  Angular DI access via `Runtime.evaluate` — designable but out of
  scope for the smoke pass.
- Visual diff (PNG screenshot vs golden). Layer 4 territory.
