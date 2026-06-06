# Contributing to GlanceTerm

Thanks for your interest. This file is intentionally short — the real
contributor docs live in:

- [HACKING-glanceterm.md](HACKING-glanceterm.md) — architecture, how to add
  a new AI agent adapter, status state machine, file map.
- [HACKING.md](HACKING.md) — generic Tabby-fork build mechanics (inherited
  from upstream and still applies).

## Quick start

1. Read the issue you want to work on, or open one first if you're
   proposing something non-trivial — for a one-line typo fix, just send the
   PR. For "let me add an aider hook adapter," chat in an issue first so we
   don't duplicate work.
2. Fork → branch → PR against `main`.
3. Run `yarn run lint` before pushing — CI will reject the PR otherwise.
4. One PR per concern. Drive-by refactors in a bug-fix PR will get split.

## Where help is most wanted

- **Linux validation** — does the plugin work end-to-end on Ubuntu /
  Arch / Fedora? File issues with specifics if it breaks.
- **Windows validation** — same as Linux. The PowerShell hook handler
  exists but has never been observed running.
- **New agent adapters** — Codex, Gemini CLI, opencode, aider, goose.
  See [HACKING-glanceterm.md](HACKING-glanceterm.md#adding-a-new-agent-adapter).
- **Real screenshots / demo GIF** — the README's ASCII diagram does the
  bare minimum. A real visual would carry far more weight.

## Bug reports

Include:
- Platform (macOS Sequoia / Ubuntu 24.04 / Windows 11 etc.)
- Which AI tool (Claude Code version, Codex CLI version, etc.)
- Output of `~/.glanceterm/hooks/<tab-id>.log` if the bug is about status
  detection or hook events not firing
- Steps to reproduce — ideally with a fresh tab so prior state isn't in
  play

## Security issues

For anything that could let an attacker bypass auto-approve, exfiltrate
data via the hook handler, or escape the sandbox, **don't open a public
issue**. Email me directly (address in commit history) and we'll
coordinate a disclosure window.

## Code style

- TypeScript strict mode; avoid `any` without a comment explaining why.
- Comments explain **why**, not **what**. Bug fixes should leave a note
  pointing at the past incident so future readers don't undo the fix.
- Adversarial self-review is welcome and expected — see commits like
  `ad49dbce` and `2c134933` for the bar.

## Licensing

By submitting a PR you agree your contribution is licensed under the
project's [MIT License](LICENSE). No CLA at this stage; that may change if
the project grows.
