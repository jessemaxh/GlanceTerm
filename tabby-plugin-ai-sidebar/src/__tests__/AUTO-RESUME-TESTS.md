# Auto-Resume — Test Plan & Cases

What this directory covers and why it's organised this way, for anyone
touching `auto-resume.service.ts` later. Pair this with the inline
docstrings in the service file for the full picture.

## Why two test files

| File | Scope | Test style |
|---|---|---|
| `auto-resume.test.ts` | Pure helpers (`parsePersistedEntry`, `isShellSafe`, `toRunnableCommand`) | Hermetic unit tests |
| `auto-resume-replay.test.ts` | Live `AutoResumeService` class against mocked Tabby singletons | Integration with fake timers |

The split exists because **`AutoResumeService` is a state machine with
real side effects** (`config.save()` writes, `sendInput()` typing) and
those need to be observed end-to-end. Unit-testing the helpers in
isolation would miss every bug that lives in the orchestration: focus
gating, quota arithmetic, persisted-shape evolution, attempted-set
hygiene. Those are exactly the bugs the recent rewrite was meant to fix,
so the integration tier earns its keep.

The harness in `auto-resume-harness.ts` mocks only the surface the
service actually reads:

- `ConfigService` — `store.ai.{autoResumeAgents, autoResumeCommandByCwd}`, `save()`
- `AppService` — `tabs`, `tabOpened$`, `activeTab`, `activeTabChange$`
- `TabMonitor` — `states$`, `current`
- Tab — `customTitle`, `title`, `sendInput()`

Production class code (the state machine) is what runs in tests; no
re-implementation. If a future change drifts the contract, the harness
needs updating in exactly one place.

## What's tested

### CAPTURE
- Single agent persists `{ command, count: 1 }`.
- Three tabs running claude at the same cwd → `count: 3`.
- Same tab observed across many ticks is counted once.
- Shell-unsafe commands are refused (regression pin).
- Master toggle off → no writes at all.
- A tab moving cwd while the agent is alive rebalances both cwds.

### CLEANUP
- One of N tabs exiting the agent decrements `count`, leaves entry.
- Last agent exiting deletes the entry.
- A bare-shell tick before any agent was observed does NOT wipe a
  persisted entry — the `hadAgentThisSession` gate must hold.

### REPLAY — focus gate (Bug 1)
- No focus = no replay, even with a matching cwd and live shell.
- `app.activeTab` at construction is seeded into the focus set so
  the originally-active tab replays without an explicit click.
- A previously-unfocused tab gaining focus immediately fires the
  REPLAY check (no waiting for next 1.5 s poll).
- A user-opened tab (post 30 s capture window) is NOT replayed even
  if focused at a matching cwd.

### REPLAY — per-cwd quota (Bug 2)
- 3 restored tabs sharing `/repo`, persisted count=1 → first focused
  resumes, other two stay bare.
- count=N matches tab count → all N resume.
- count=2 across N=3 tabs in focus order → first two resume, third
  marked attempted and skipped.
- A tab considered (whether resumed or quota-skipped) doesn't
  re-enter REPLAY on subsequent ticks.

### Persisted format compatibility
- Legacy bare-string entry parses as count=1; one tab resumes.
- After one CAPTURE pass at that cwd the shape upgrades in-place.

### End-to-end scenarios
- Reported bug: 3 tabs share cwd, only 1 had agent → restart, only
  the focused one resumes.
- Two agents at same cwd, quit-without-exit → next session resumes
  both as they're focused.

## Running

```bash
cd tabby-plugin-ai-sidebar
yarn test                  # all unit + integration
yarn test:watch            # interactive while editing
```

E2E (`__e2e__/`) is a separate, slower tier driven over CDP against
`./dev.sh` — see `__e2e__/README.md`. The integration tier here doesn't
need a running app, so it runs in CI on every push.

## What's NOT covered yet

- **App-restart boundary**: tests simulate session 1 → session 2 by
  building two harnesses and threading the persisted map. A real
  ConfigService disk round-trip (with the legacy migration) is not
  exercised — that's a deliberate trade-off, since disk I/O isn't where
  the bugs hide and adding a temp-dir round-trip would slow the suite
  by ~100×.
- **Real Tabby reordering**: `app.tabs` reorders on drag, splits adopt
  child tabs into different outer tabs, etc. Harness keeps the array
  static. The service doesn't read positional indexes so this hasn't
  bitten us, but a future feature that does should grow the harness.
- **Concurrent state machines**: `onStates` is single-pass; nothing
  in production runs two onStates concurrently. If you add async
  inside the loop, write a concurrency test before shipping it.

## Adding a case

1. Decide whether you're testing a pure helper or live state — pick
   the file accordingly.
2. For integration: write `beforeEach(() => vi.useFakeTimers())` then
   build a `new AutoResumeHarness({...})`, call `start()`, and drive
   it with `addTab` / `focus` / `emitTick` / `advance`.
3. Assert on `tab.sentInputs` for replay side effects and
   `harness.getPersisted()` for config writes.
4. Run `yarn test` — the suite is 80+ tests and stays under 500 ms,
   so iteration is cheap.
