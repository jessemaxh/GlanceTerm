# Changelog

## [0.2.0](https://github.com/jessemaxh/GlanceTerm/compare/v0.1.2...v0.2.0) (2026-06-23)


### Features

* **ai-sidebar:** add "Open agent in worktree" to the sidebar row menu ([2dce21e](https://github.com/jessemaxh/GlanceTerm/commit/2dce21efcdd0b0872d9aeac34274114d049a713f))
* **ai-sidebar:** worktree — auto-launch the agent + reclaim inner-pane closes ([49dfffc](https://github.com/jessemaxh/GlanceTerm/commit/49dfffc1c4667900f7bf885beb912160dbd018b3))
* **ai-sidebar:** worktree P2 — persistence + startup re-attach & reaper ([c175d9d](https://github.com/jessemaxh/GlanceTerm/commit/c175d9d768a32f44935eef9b2c1fb473e8039e2e))
* **ai-sidebar:** worktree P2 — repo picker, branch badge, auto-cleanup on close ([918f0d3](https://github.com/jessemaxh/GlanceTerm/commit/918f0d305c26ffcea90e64817d2394016c162ac7))
* **ai-sidebar:** worktree P2c — manager panel (list + remove orphans) ([783727a](https://github.com/jessemaxh/GlanceTerm/commit/783727af0be903c9bb75da816100ff5506718774))
* **ai-sidebar:** worktree UI — "Open agent in worktree…" command (first cut) ([a13107e](https://github.com/jessemaxh/GlanceTerm/commit/a13107ea882ff8ce14c4bfa393642862df499cb4))
* **ai-sidebar:** worktree-isolation engine (multi-repo git ops) ([bd9805b](https://github.com/jessemaxh/GlanceTerm/commit/bd9805b91ae26a238472e47a33f4e7085ffa76f6))
* opt-in pty-exit diagnostic to catch vanishing tabs (flag-gated) ([6d2b3fc](https://github.com/jessemaxh/GlanceTerm/commit/6d2b3fcd73d437aacce6198d266071a0a890d5c9))


### Bug Fixes

* **ai-sidebar:** clear the unread badge when a ready tab resumes working ([308aea0](https://github.com/jessemaxh/GlanceTerm/commit/308aea03a212b8061c675fceb12bef62267ae82b))
* **ai-sidebar:** close the residual worktree rm landmine (1-level isolatedRoot) ([850ef0f](https://github.com/jessemaxh/GlanceTerm/commit/850ef0f00af9590c6f20627d29426205aaa6b0a1))
* **ai-sidebar:** pin SVG dimensions so the footer doesn't deform after a relayout ([0dd9c87](https://github.com/jessemaxh/GlanceTerm/commit/0dd9c87a90867ffa457efe0abae6415c9f2ae1f2))
* **ai-sidebar:** revert transcript subagent-reconcile (it cleared running bg agents) ([1eff180](https://github.com/jessemaxh/GlanceTerm/commit/1eff180ff31c835bc4f871f9a565772cbb44c510))
* **ai-sidebar:** show "Open agent in worktree" on the TAB HEADER too ([a34b520](https://github.com/jessemaxh/GlanceTerm/commit/a34b520b07ff7a83855285de0d2d18ae74da27a4))
* **ai-sidebar:** worktree — DI startup crash + split-pane worktree deletion (2 HIGH) ([9c97ac6](https://github.com/jessemaxh/GlanceTerm/commit/9c97ac65862d51d6c0a70dd80277226907d1dd62))
* **ai-sidebar:** worktree — removeSet rm-failure + isInUse tri-state (review) ([990dfe7](https://github.com/jessemaxh/GlanceTerm/commit/990dfe74da4824a374a8fa19c928fbcfcacc48e1))
* **ai-sidebar:** worktree — single-repo rollback safety + don't mount unselected repos ([830929c](https://github.com/jessemaxh/GlanceTerm/commit/830929c3038426802824e48927c6a09a76ecc52c))
* **ai-sidebar:** worktree engine — non-force removeSet must not fs.rm protected work (self-review) ([5c9151f](https://github.com/jessemaxh/GlanceTerm/commit/5c9151f7806fc3f99ed425c1e6489850a551973c))
* **ai-sidebar:** worktree engine — remaining review findings (symlink/lock/lstat/etc.) ([999bd0e](https://github.com/jessemaxh/GlanceTerm/commit/999bd0eeeff291abb9529d6aa3b0a08dc2f0e0fe))
* **ai-sidebar:** worktree engine — unique isolated dir + SHA base anchor (review) ([9336bbf](https://github.com/jessemaxh/GlanceTerm/commit/9336bbf23ad73b80379b8e9c32a60c039e061126))
* **ai-sidebar:** worktree engine review fixes (branch safety, single-repo layout) ([401a99e](https://github.com/jessemaxh/GlanceTerm/commit/401a99e77173b7b157ca3dda7291428aae36d39f))
* **ai-sidebar:** worktree manager — isInUse lsof exit-1 + remove() concurrency ([83754c7](https://github.com/jessemaxh/GlanceTerm/commit/83754c7318a8e3f7ba3ca8e24652adc393fa3249))
* **ai-sidebar:** worktree manager — never delete an in-use worktree (review) ([c5d0483](https://github.com/jessemaxh/GlanceTerm/commit/c5d04835312b740988142104a5a1860f10e7418b))
* **ai-sidebar:** worktree P2 review — close the reaper/persistence data-loss CRITICALs ([baee9c2](https://github.com/jessemaxh/GlanceTerm/commit/baee9c2092d0eb37236cb4e2eaca8a4804add0ed))
* **ai-sidebar:** worktree removeSet non-force teardown is atomic (review MEDIUM) ([0dd7c09](https://github.com/jessemaxh/GlanceTerm/commit/0dd7c094d0c826e8491db9aef012b7ca866d2974))


### Miscellaneous Chores

* next release is v0.2.0 (worktree isolation) ([ce9d7d9](https://github.com/jessemaxh/GlanceTerm/commit/ce9d7d964ce5ad44b8750ac6b716e76df2669117))

## [0.1.2](https://github.com/jessemaxh/GlanceTerm/compare/v0.1.1...v0.1.2) (2026-06-23)


### Bug Fixes

* **ai-sidebar:** subagent tool events must not clobber the main agent status ([c72c30a](https://github.com/jessemaxh/GlanceTerm/commit/c72c30a8066a392fd1f3409459041bbb5dd6c2f0))

## [0.1.1](https://github.com/jessemaxh/GlanceTerm/compare/v0.1.0...v0.1.1) (2026-06-22)


### Bug Fixes

* **ai-sidebar:** reconcile subagent count against the transcript on idle ([ed917ed](https://github.com/jessemaxh/GlanceTerm/commit/ed917ed1b1d17860423defb1b8446169a2217fbf))
