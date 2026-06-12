<!-- Thanks for contributing to GlanceTerm! Keep this short — delete sections that don't apply. -->

## What & why

<!-- What does this PR change, and what problem does it solve? Link any issue: Closes #123 -->

## How to test

<!-- Steps for a reviewer to verify. Which platform/agent did you test on? -->
- Platform: <!-- macOS / Linux / Windows -->
- Agent (if relevant): <!-- Claude Code / Codex / Gemini / opencode -->

## Checklist

- [ ] Builds locally (`npm run dmg:mac`, or the relevant platform build).
- [ ] Plugin unit tests pass (`cd tabby-plugin-ai-sidebar && yarn test`).
- [ ] If this changes AI-agent behaviour, `docs/feature-matrix.md` is updated.
- [ ] No personal paths, secrets, or `.env` values are committed.
- [ ] User-facing changes don't overclaim vs. the feature matrix.

<!--
Heads up: `main` is protected. Anyone can open a PR, but a maintainer
approval + green CI are required to merge.
-->
