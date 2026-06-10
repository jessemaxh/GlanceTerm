# Auto-Resume — Test Plan & Cases

What this directory covers and why it's organised this way, for anyone
touching `auto-resume.service.ts` later. Pair this with the inline
docstrings in the service file for the full picture.

## The model under test (per-tab, not per-cwd)

The agent command is keyed **per tab**. It is stashed on the
`TerminalTabComponent` instance (`glancetermResumeCommand`), serialized into
that tab's own Tabby recovery token, and restored onto the recovered instance
by `RecoveryProvider.recover`. There is **no config map** — the old
`ai.autoResumeCommandByCwd` (a `cwd → { command, count }` record) was removed
because cwd is not a unique key: two tabs in the same directory running
different agents (or the same agent with different flags) collapsed onto one
entry, and on restart every restored tab at that cwd got the same single
command. The reported bug. Keying on the tab's recovery token removes the
collision; each tab carries its own command (or none) and replays exactly
that.

## Why two test files

| File | Scope | Test style |
|---|---|---|
| `auto-resume.test.ts` | Pure helpers (`isShellSafe`, `toRunnableCommand`) | Hermetic unit tests |
| `auto-resume-replay.test.ts` | Live `AutoResumeService` class against mocked Tabby singletons | Integration with fake timers |

The split exists because **`AutoResumeService` is a state machine with real
side effects** (`tab.glancetermResumeCommand` writes, `sendInput()` typing)
and those need to be observed end-to-end. Unit-testing the helpers in
isolation would miss every bug that lives in the orchestration: focus gating,
the restored-tab gate, attempted-set hygiene, capture/cleanup transitions.

The harness in `auto-resume-harness.ts` mocks only the surface the service
actually reads:

- `ConfigService` — `store.ai.autoResumeAgents`
- `AppService` — `tabs`, `tabOpened$`, `activeTab`, `activeTabChange$`
- `TabMonitor` — `states$`, `current`
- Tab — `customTitle`, `title`, `sendInput()`, `glancetermResumeCommand`,
  `emitFocused()`/`emitBlurred()`

A "restored" tab is built with a preset `resumeCommand`, mirroring what
`RecoveryProvider.recover` applies onto the recovered instance from the token.

Production class code (the state machine) is what runs in tests; no
re-implementation. If a future change drifts the contract, the harness needs
updating in exactly one place.

## What's tested

### CAPTURE
- An alive agent stashes the reduced command on the tab.
- Two tabs, two agents, one cwd → **each keeps its own command** (the fix).
- The command refreshes as flags drift across ticks.
- Shell-unsafe commands that survive reduction are refused (security pin).
- Bare-tool fallback is stashed for cmdlines `toRunnableCommand` can't parse.
- Master toggle off → nothing stashed.
- No cwd required — capture is cwd-agnostic now.

### CLEANUP
- Quitting the agent clears the tab's command.
- Only the quitting tab is cleared; a sibling at the same cwd is untouched.
- A restored command is NOT wiped on the first bare-shell tick before any
  agent ran this session — the `hadAgentThisSession` gate must hold (that
  tick is REPLAY's cue).

### REPLAY
- **Headline fix**: same cwd, two restored tabs, two different agents → each
  replays its OWN command.
- All restored tabs carrying a command resume at startup via the warm-up
  dance (synthetic focus on each non-active restored tab).
- Master switch off → no warm-up, no replay.
- `app.activeTab` at construction is seeded into the focus set so the
  originally-active tab replays without an explicit click.
- A previously-unfocused tab gaining focus fires the REPLAY check immediately.
- A restored tab carrying NO command (was a bare shell) does not replay.
- A user-opened tab (post 30 s capture window) is not replayed.
- A tab is resumed at most once (the `attempted` guard).
- No replay while an agent is already detected running in the restored tab
  (the `!aiTool` gate, for live-pty restores).

### End-to-end scenarios
- Two agents at one cwd: capture in session 1 → restore both in session 2.
- 3 tabs share a cwd, only 1 had an agent → only that tab resumes (used to
  need a per-cwd count/quota hack; now it's free).
- Quitting the agent before app exit → no resume next launch.
- Codex command with flags survives capture → reduce → replay.

## Running

```bash
cd tabby-plugin-ai-sidebar
yarn test                  # all unit + integration
yarn test:watch            # interactive while editing
```

E2E (`__e2e__/`) is a separate, slower tier driven over CDP against
`./dev.sh` — see `__e2e__/README.md`.

## What's NOT covered yet

- **App-restart boundary**: tests simulate session 1 → session 2 by building
  two harnesses and threading the captured command through `resumeCommand`. A
  real `getRecoveryToken` → localStorage → `recover` round-trip is not
  exercised — disk/serialization I/O isn't where the bugs hide.
- **Split panes**: the command and per-tab lifecycle state are keyed by the
  inner tab so split panes resume independently, but the harness uses
  single-pane tabs (inner === outer). A split-specific case should grow the
  harness if that path gains complexity.
- **Real Tabby reordering / tab adoption**: harness keeps `app.tabs` static.
  The service reads no positional indexes, so this hasn't bitten us.

## Adding a case

1. Decide whether you're testing a pure helper or live state — pick the file
   accordingly.
2. For integration: `beforeEach(() => vi.useFakeTimers())`, build a
   `new AutoResumeHarness({...})`, call `start()`, drive it with `addTab`
   (with `resumeCommand` for restored tabs) / `focus` / `emitTick` / `advance`.
3. Assert on `tab.sentInputs` for replay side effects and
   `tab.glancetermResumeCommand` for capture/cleanup.
4. Run `yarn test` — the suite stays well under a second.
