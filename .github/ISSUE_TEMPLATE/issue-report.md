---
name: Issue report
about: Report a problem
title: ''
labels: 'T: Bug'
assignees: ''

---

<!--
# READ CAREFULLY:

* **ENGLISH ONLY** - this issue tracker is English-only. Please respect the people who take time to help you with your problems.
* Search existing issues first: https://github.com/jessemaxh/glanceterm/issues
* Test with the latest GlanceTerm version: https://github.com/jessemaxh/glanceterm/releases
* Disable third-party plugins.
-->

**Describe the problem**:
[A clear and concise description of what the bug is.]

**To Reproduce**:
[Steps to reproduce the behavior]

**Screenshot**:
[Attach a screenshot of the sidebar showing the problem — the screenshot button in the sidebar's bottom toolbar grabs one.]

**Logs** (these let us pin it down fast — GlanceTerm writes them automatically; nothing to enable):
Please attach the relevant logs from `~/.glanceterm/`:
- `~/.glanceterm/hooks/` — the per-tab event logs (the file named after the affected tab; if you're not sure which, zip the whole folder). This is the main diagnostic trail for status/badge issues.
- `~/.glanceterm/auto-approve.log` — only if the issue is about auto-approve.

> ⚠️ These logs contain your working-directory paths (project/folder names). Review or redact them before posting if that's sensitive.

**Environment**:
- GlanceTerm version:
- OS and version:
- Agent(s) involved: [Claude Code / Codex / Gemini CLI / opencode]
