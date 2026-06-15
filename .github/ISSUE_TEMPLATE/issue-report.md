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

**Logs** (this is what lets us pin it down fast — GlanceTerm writes it automatically; nothing to enable):
**Attach `~/.glanceterm/debug.log`** — one unified file covering auto-resume, watcher events, auto-approve, and any renderer errors. A fresh one is started each launch, so reproduce the problem and then grab it. If it rotated mid-session you'll also see `debug.log.1` … `debug.log.3` (most recent first) — include the relevant one.

For deep dives we may also ask for the raw per-tab event logs in `~/.glanceterm/hooks/` (optional).

> ⚠️ `debug.log` contains your working-directory paths (project/folder names). Review or redact it before posting if that's sensitive.

**Environment**:
- GlanceTerm version:
- OS and version:
- Agent(s) involved: [Claude Code / Codex / Gemini CLI / opencode]
