# Changelog

## [0.3.0](https://github.com/jessemaxh/GlanceTerm/compare/v0.3.10...v0.3.0) (2026-09-22)


### Features

* add 'Export to file' option to terminal context menu ([#11109](https://github.com/jessemaxh/GlanceTerm/issues/11109)) ([1466543](https://github.com/jessemaxh/GlanceTerm/commit/1466543ef2e52f82e8bbee6255b03a34a43f711a))
* add refresh button for sftp ([#11047](https://github.com/jessemaxh/GlanceTerm/issues/11047)) ([2c91ac8](https://github.com/jessemaxh/GlanceTerm/commit/2c91ac853e0d6fff8d8124b488e2b194ba78cb2e))
* **ai-sidebar,mobile-bridge:** show live status + inline enable toggle for contributed settings rows ([f5701e0](https://github.com/jessemaxh/GlanceTerm/commit/f5701e024f2b7249fe7ce7f08cb8a180213840ad))
* **ai-sidebar/auto-resume:** preserve original flags across restart ([3a75e32](https://github.com/jessemaxh/GlanceTerm/commit/3a75e32b36dfd0af922ac53755e029d57d3f6f6d))
* **ai-sidebar/bg:** anchor Claude bg-shell detection on the run_in_background hook ([ec1a79c](https://github.com/jessemaxh/GlanceTerm/commit/ec1a79c4851b7852220702c7976db103d9cfee75))
* **ai-sidebar/pin:** persist by cwd, auto-unpin on tab close ([9bda75a](https://github.com/jessemaxh/GlanceTerm/commit/9bda75a093f62181890a48e3c94ca229cc8f0fa2))
* **ai-sidebar:** add "hide tabs without an AI agent" toggle ([ecb4755](https://github.com/jessemaxh/GlanceTerm/commit/ecb47555be0edb85cb7618cd3abc6df176bb39a9))
* **ai-sidebar:** add "Open agent in worktree" to the sidebar row menu ([2dce21e](https://github.com/jessemaxh/GlanceTerm/commit/2dce21efcdd0b0872d9aeac34274114d049a713f))
* **ai-sidebar:** add Done status for finished-but-unseen agent tabs ([97864df](https://github.com/jessemaxh/GlanceTerm/commit/97864dfc1e23f697aaaf90147ee8d5f94228f38e))
* **ai-sidebar:** auto-resume AI agents on app restart ([5cf174b](https://github.com/jessemaxh/GlanceTerm/commit/5cf174b3078b6e1cad0fa8a71554766725e03543))
* **ai-sidebar:** brand-themed agent pills (default) ([b59eeb1](https://github.com/jessemaxh/GlanceTerm/commit/b59eeb1dd0e287bf6ef3d43ff4928d536418f0d0))
* **ai-sidebar:** clean hook lifecycle — uninstall button + residue-reconciling (re)install ([85c4d89](https://github.com/jessemaxh/GlanceTerm/commit/85c4d89a6399f81962bd4654b0455347cf81fd59))
* **ai-sidebar:** Codex hook adapter (untested, written from docs) ([8c00312](https://github.com/jessemaxh/GlanceTerm/commit/8c003126d830de1cda95ff47e5496076ca748036))
* **ai-sidebar:** consolidate toolbar in sidebar footer + reliability fixes ([fc0c2ec](https://github.com/jessemaxh/GlanceTerm/commit/fc0c2ec779cda0fd53a253cb06bcb2cb3f308580))
* **ai-sidebar:** fold two toolbar toggles into a single gear button + popover ([02a4672](https://github.com/jessemaxh/GlanceTerm/commit/02a4672ab01e6b570e95a45c4cc1774e409a0062))
* **ai-sidebar:** image-paste hook — Cmd+V a PNG, get a typed path ([08bd51a](https://github.com/jessemaxh/GlanceTerm/commit/08bd51a05c73760b8e914dcefd6f8ae391878544))
* **ai-sidebar:** inline current-tool + subagent count on row line2 ([4539dc2](https://github.com/jessemaxh/GlanceTerm/commit/4539dc2c5a74fcf7e2f0511495c8fa6bd78a05e0))
* **ai-sidebar:** macOS Screen Recording permission gate ([f3de7c5](https://github.com/jessemaxh/GlanceTerm/commit/f3de7c5217ce68ee9d90d29975fcc365e0bbd067))
* **ai-sidebar:** native Ctrl+V image paste for Claude Code ([50d0c71](https://github.com/jessemaxh/GlanceTerm/commit/50d0c71bfda53250e2eaf828b0164e1f960370f4))
* **ai-sidebar:** per-tab agent adapters overhaul + model display ([9b79bfd](https://github.com/jessemaxh/GlanceTerm/commit/9b79bfd90a5c5dbc8344b0fe3001893c6eb34400))
* **ai-sidebar:** remote version-check + update gate (off by default) ([240bb51](https://github.com/jessemaxh/GlanceTerm/commit/240bb514ab8b649d156b3751e552c1c793314434))
* **ai-sidebar:** resume agents into their exact prior session on restore ([4e364fe](https://github.com/jessemaxh/GlanceTerm/commit/4e364fead92af9e18bffba1b5246878a0d35bca5))
* **ai-sidebar:** rework screenshot button — no-hide by default, hide via menu, double-click to confirm ([7181955](https://github.com/jessemaxh/GlanceTerm/commit/7181955f83126934ef64600abc75a53d2b52f0ae))
* **ai-sidebar:** rewrite status detection with PTY byte-rate + screen fingerprints ([c7eb235](https://github.com/jessemaxh/GlanceTerm/commit/c7eb2356e5f1a0e9ae9868651049abc8941f5141))
* **ai-sidebar:** right-click "Pin to top" with gold marker ([29cb86f](https://github.com/jessemaxh/GlanceTerm/commit/29cb86f161e69a98c2ee42592b1fc2c4373f9a9f))
* **ai-sidebar:** right-click "Reset agent status" to clear a stuck row ([#100](https://github.com/jessemaxh/GlanceTerm/issues/100)) ([b8e5ad4](https://github.com/jessemaxh/GlanceTerm/commit/b8e5ad46b22b4f5df702ffd2acb078c3517dd819))
* **ai-sidebar:** scale up sidebar typography + breathing working dot ([3b98201](https://github.com/jessemaxh/GlanceTerm/commit/3b98201d105f7993587fa65a3431e867b65f9f62))
* **ai-sidebar:** screenshot button with per-agent paste adapters ([0f47afb](https://github.com/jessemaxh/GlanceTerm/commit/0f47afba62157da0ba3761b35993bc9c5d4d2955))
* **ai-sidebar:** settings dialog with title + description per option ([9f8f4d1](https://github.com/jessemaxh/GlanceTerm/commit/9f8f4d1e222d0477e51f45dac4011f767f604a4b))
* **ai-sidebar:** show "· N bg" when an AI agent has background jobs ([bd5cfdb](https://github.com/jessemaxh/GlanceTerm/commit/bd5cfdb5f13d46de6d7b82bc9d7fa5f5bfaf1e56))
* **ai-sidebar:** show session token usage (input/output) per tab ([8dfd0d7](https://github.com/jessemaxh/GlanceTerm/commit/8dfd0d7933d4622c8079b6732ea0c6e299ff3a03))
* **ai-sidebar:** sidebar redesign + constant row height + row dividers; screenshot Esc-cancel + menu-bar alignment ([647ef23](https://github.com/jessemaxh/GlanceTerm/commit/647ef2321d3a78d6a56e4a126e25d8ac86a016c8))
* **ai-sidebar:** split cache-read from input tokens + token chip on its own line ([40d194c](https://github.com/jessemaxh/GlanceTerm/commit/40d194cd4390c32713368f4ec64be5141d911de8))
* **ai-sidebar:** token display — add b/t units, 2-decimal precision ([c9c4eb3](https://github.com/jessemaxh/GlanceTerm/commit/c9c4eb3fc2e69f06fd4e3f4c15c1320d7014f0ee))
* **ai-sidebar:** toolbar button to split a shell in current tab CWD ([ed26107](https://github.com/jessemaxh/GlanceTerm/commit/ed261079fe4320a989458294a472ddffb38cde3e))
* **ai-sidebar:** UI polish + restored-tab visibility + typing echo guard ([0283dd3](https://github.com/jessemaxh/GlanceTerm/commit/0283dd3e37d3d11050192be77bb52d072f68847a))
* **ai-sidebar:** unified rotating debug log (~/.glanceterm/debug.log) ([305f00a](https://github.com/jessemaxh/GlanceTerm/commit/305f00a37fb604378e75d7f1356c212dc04837cc))
* **ai-sidebar:** v0.2 — priority sort + filter pills + hotkeys + sparklines + notifications ([0ee54d4](https://github.com/jessemaxh/GlanceTerm/commit/0ee54d437f5fe93b61ef9c89a6b0a529864da287))
* **ai-sidebar:** worktree — auto-launch the agent + reclaim inner-pane closes ([49dfffc](https://github.com/jessemaxh/GlanceTerm/commit/49dfffc1c4667900f7bf885beb912160dbd018b3))
* **ai-sidebar:** worktree P2 — persistence + startup re-attach & reaper ([c175d9d](https://github.com/jessemaxh/GlanceTerm/commit/c175d9d768a32f44935eef9b2c1fb473e8039e2e))
* **ai-sidebar:** worktree P2 — repo picker, branch badge, auto-cleanup on close ([918f0d3](https://github.com/jessemaxh/GlanceTerm/commit/918f0d305c26ffcea90e64817d2394016c162ac7))
* **ai-sidebar:** worktree P2c — manager panel (list + remove orphans) ([783727a](https://github.com/jessemaxh/GlanceTerm/commit/783727af0be903c9bb75da816100ff5506718774))
* **ai-sidebar:** worktree UI — "Open agent in worktree…" command (first cut) ([a13107e](https://github.com/jessemaxh/GlanceTerm/commit/a13107ea882ff8ce14c4bfa393642862df499cb4))
* **ai-sidebar:** worktree-isolation engine (multi-repo git ops) ([bd9805b](https://github.com/jessemaxh/GlanceTerm/commit/bd9805b91ae26a238472e47a33f4e7085ffa76f6))
* Allow third-party plugins to add quick connection support. ([#11004](https://github.com/jessemaxh/GlanceTerm/issues/11004)) ([943c777](https://github.com/jessemaxh/GlanceTerm/commit/943c77781225eef7cb80e977f0253c4d52567d1c))
* **app:** add "Check for Updates…" to the macOS app menu under About ([#104](https://github.com/jessemaxh/GlanceTerm/issues/104)) ([53d44fd](https://github.com/jessemaxh/GlanceTerm/commit/53d44fde905510982734111394af71f253d2753e))
* auto-sudo-password support multi language and sudo-rs ([#11019](https://github.com/jessemaxh/GlanceTerm/issues/11019)) ([277f708](https://github.com/jessemaxh/GlanceTerm/commit/277f70805b7e9d69fb29fb828db27a5cffc7995a))
* Implement tabby:// URL scheme handler ([#11005](https://github.com/jessemaxh/GlanceTerm/issues/11005)) ([c326432](https://github.com/jessemaxh/GlanceTerm/commit/c326432048b237bd5187baf256ea3ead914ecf62))
* **mobile-bridge:** /bind pairing + binding persistence ([0db32ae](https://github.com/jessemaxh/GlanceTerm/commit/0db32ae740d52957fa2dae87e979cd9ae06b597a))
* **mobile-bridge:** add Discord as third backend (native gateway, threads per tab) ([678b910](https://github.com/jessemaxh/GlanceTerm/commit/678b910d470954a77f889e3b117da08c01261196))
* **mobile-bridge:** auto-clean topics stranded by a removed/re-paired binding ([a6c922b](https://github.com/jessemaxh/GlanceTerm/commit/a6c922bdf1c37e9e447c450f28a44890afd8fce3))
* **mobile-bridge:** Feishu / Lark pairing UI ([ffddbc1](https://github.com/jessemaxh/GlanceTerm/commit/ffddbc113c349b66e5ea12b08cf6283d1117c328))
* **mobile-bridge:** FeishuBackend on @larksuiteoapi/node-sdk ([7077e85](https://github.com/jessemaxh/GlanceTerm/commit/7077e851d74f56151a275c2c32183ef5856dcabe))
* **mobile-bridge:** folder@machine topic titles + purge orphan topics on launch ([db2ca20](https://github.com/jessemaxh/GlanceTerm/commit/db2ca2037bd7f02f4db798d2577f15d2444fdc94))
* **mobile-bridge:** Forum Topic lifecycle keyed by tab UUID ([6228563](https://github.com/jessemaxh/GlanceTerm/commit/6228563115180fb0bd85346c19d42373d8fe9332))
* **mobile-bridge:** in-app setup walkthrough + pairing diagnostics ([ebad864](https://github.com/jessemaxh/GlanceTerm/commit/ebad864c9618da1d62f186ed8180e63da879ff6e))
* **mobile-bridge:** inbound router + sender whitelist ([6b73493](https://github.com/jessemaxh/GlanceTerm/commit/6b73493572d69863bb3f3fa5d0a2aec37fc2a3e3))
* **mobile-bridge:** KeystoreService for encrypted secrets ([24a7ca5](https://github.com/jessemaxh/GlanceTerm/commit/24a7ca52f8b0d4a4029be468ac6085d05e465af9))
* **mobile-bridge:** MessagingBackend interface + TelegramBackend impl ([79732f6](https://github.com/jessemaxh/GlanceTerm/commit/79732f6f5a8aff0a637ad5b3b4116279b5e939c2))
* **mobile-bridge:** native topic delete for Discord + Feishu (purge parity) ([a52e0df](https://github.com/jessemaxh/GlanceTerm/commit/a52e0dfb44d82d86984eff55c0e0337c27ce8f48))
* **mobile-bridge:** outbound dispatcher + event sources wired ([08e8b65](https://github.com/jessemaxh/GlanceTerm/commit/08e8b654e03606f5bcdd202c82b8e096bb74179a))
* **mobile-bridge:** per-AI keystroke adapter registry ([495a31b](https://github.com/jessemaxh/GlanceTerm/commit/495a31bf514de232c7ea46f062bbf5437948d89d))
* **mobile-bridge:** plugin skeleton ([2a4e915](https://github.com/jessemaxh/GlanceTerm/commit/2a4e915dd91ced2f4868c3d547aa64eaeacd15fe))
* **mobile-bridge:** retry with exponential backoff + shared drop log ([4ec3b37](https://github.com/jessemaxh/GlanceTerm/commit/4ec3b37c9375672576dcaf770426d3e067215ec0))
* **mobile-bridge:** settings panel (Tabby Settings tab) ([2fba49f](https://github.com/jessemaxh/GlanceTerm/commit/2fba49fcb1bd1055155f88283d9bd84247c46a1f))
* **mobile-bridge:** tab↔topic sync + simplified settings + single-instance lock ([5b272bc](https://github.com/jessemaxh/GlanceTerm/commit/5b272bc2303bc1be41beb901bc152125b962ad62))
* **mobile-bridge:** TabIdentityService — session-stable UUID per tab ([6451641](https://github.com/jessemaxh/GlanceTerm/commit/64516411dd4084b0891b7005a527f523fe4aee79))
* **mobile-bridge:** Telegram client — long-poll + Forum Topic API ([ef973aa](https://github.com/jessemaxh/GlanceTerm/commit/ef973aaf21ec5e1346f09ca6ab3833c633a6d841))
* **mobile-bridge:** UI doesn't lie + opt-in PTY mirror ([1c7d135](https://github.com/jessemaxh/GlanceTerm/commit/1c7d1355bd5b5ee7cb40f1df13ae7e305a7b6ffd))
* opt-in pty-exit diagnostic to catch vanishing tabs (flag-gated) ([6d2b3fc](https://github.com/jessemaxh/GlanceTerm/commit/6d2b3fcd73d437aacce6198d266071a0a890d5c9))
* **sidebar:** clearer process-tree chips + platform support matrix ([cd30ecd](https://github.com/jessemaxh/GlanceTerm/commit/cd30ecd93e8409cc793c0cd15f5d771433f4af25))
* **sidebar:** remote-tab-awareness — connection chip for remote tabs ([06caf3b](https://github.com/jessemaxh/GlanceTerm/commit/06caf3bd501951c022b3678d085d45b759bcc990))
* **sidebar:** surface auto-resume toggle in the gear menu ([8c5a199](https://github.com/jessemaxh/GlanceTerm/commit/8c5a19992b044af39f3ea70784b74d627ff944b0))
* **sidebar:** track harness Workflow agents and show a workflow chip ([#114](https://github.com/jessemaxh/GlanceTerm/issues/114)) ([ea88d7e](https://github.com/jessemaxh/GlanceTerm/commit/ea88d7e8777a1d93d855a992e9f14c2843c6ead6))
* **ssh:** add hotkey to open SFTP panel ([#11106](https://github.com/jessemaxh/GlanceTerm/issues/11106)) ([2a5b69c](https://github.com/jessemaxh/GlanceTerm/commit/2a5b69c8dbcd3bddc3dd9e06cdb2467b9db446a4))
* **ssh:** pre-populate vault password in auth prompts for MFA (fixes [#9911](https://github.com/jessemaxh/GlanceTerm/issues/9911)) ([#11170](https://github.com/jessemaxh/GlanceTerm/issues/11170)) ([d9d6a21](https://github.com/jessemaxh/GlanceTerm/commit/d9d6a219d1467dc8984c8990dcc78029d435dd62))
* **ssh:** support agent authentication using specific public key identity ([#10953](https://github.com/jessemaxh/GlanceTerm/issues/10953)) ([983acef](https://github.com/jessemaxh/GlanceTerm/commit/983acefc77b038b87107ee0056653fbd8ee271eb))
* **terminal:** IMAGE_PASTE_HOOK extension point for paste() ([5722126](https://github.com/jessemaxh/GlanceTerm/commit/57221261909699df12f06a1fc549f3f5948634ae))
* **token-stats:** all-time/windowed usage aggregator (part 1/2: service core) ([99931a9](https://github.com/jessemaxh/GlanceTerm/commit/99931a9ce449e2ae9ccc52e4d812d242bcbffbdb))
* **token-stats:** move entry into the sidebar gear menu (not Tabby Settings) ([e3d84ff](https://github.com/jessemaxh/GlanceTerm/commit/e3d84ff54e21329348bec680221f05d58f1ecfcf))
* **token-stats:** standalone Token Usage settings page (part 2/2: UI) ([16b30bc](https://github.com/jessemaxh/GlanceTerm/commit/16b30bc06190bc9e2d300dacbd69e9e5ee515c33))
* **update:** notify + browser DMG download on macOS, never ShipIt (no admin prompt) ([#107](https://github.com/jessemaxh/GlanceTerm/issues/107)) ([a88148c](https://github.com/jessemaxh/GlanceTerm/commit/a88148cef09ee31819f36f61ddf7de7ac5b8800c))
* **updater:** GitHub-driven in-app auto-update ([aa45519](https://github.com/jessemaxh/GlanceTerm/commit/aa45519f131c5aae6ead26ab43b03b0d0bcd3987))
* **window:** multi-window — File menu, move/drag a tab to a new window ([eb76aec](https://github.com/jessemaxh/GlanceTerm/commit/eb76aeca2e4d9f785c9084452d65a7fe6adce175))


### Bug Fixes

* adjust ssh config time resolution ([#10803](https://github.com/jessemaxh/GlanceTerm/issues/10803)) ([dc657cf](https://github.com/jessemaxh/GlanceTerm/commit/dc657cfacc54aa3bab1fd2bd43c325a38650e666))
* **ai-sidebar/hooks:** address adversarial review of df4e84ef ([049d729](https://github.com/jessemaxh/GlanceTerm/commit/049d729e1aee67947f379194b3d2c1976211e65b))
* **ai-sidebar/hooks:** debounce ingest emits + reset counter on SessionEnd ([f683c86](https://github.com/jessemaxh/GlanceTerm/commit/f683c8697238d59ee5f5627eac10ce0da48a2d0b))
* **ai-sidebar/hooks:** keep row on 'working' while a backgrounded subagent runs ([df4e84e](https://github.com/jessemaxh/GlanceTerm/commit/df4e84efcff870452f321eddcff5dde9d33ac41d))
* **ai-sidebar/hooks:** map Pre/PostToolUse → working so needs_permission unsticks after approval ([2782682](https://github.com/jessemaxh/GlanceTerm/commit/2782682b0c9b0906f77699ece2a69b00b47a8fc7))
* **ai-sidebar/hooks:** startupTs unit-correctness + second-pass doc fixes ([d35d89e](https://github.com/jessemaxh/GlanceTerm/commit/d35d89e98948b924475df3f3b87e7d4aea5f316f))
* **ai-sidebar/hooks:** subscribe to PermissionRequest for inline y/n prompts ([6e190ce](https://github.com/jessemaxh/GlanceTerm/commit/6e190ceac1c8b29744e0d40ef85f24aee2dab536))
* **ai-sidebar/screenshot:** macOS Dock + Dock icon vanishing after capture ([7e797b1](https://github.com/jessemaxh/GlanceTerm/commit/7e797b17004c67514b62f99a3d1533c211f5e7b1))
* **ai-sidebar/screenshot:** pre-flight permission check to avoid macOS restart ([501bde7](https://github.com/jessemaxh/GlanceTerm/commit/501bde7ab434630d227ba3c2ade87e215c4f3d76))
* **ai-sidebar:** adversarial-review pass — npm-install, flap, leak, scope ([7b2c9c1](https://github.com/jessemaxh/GlanceTerm/commit/7b2c9c1d37120f623642b8bed26abb1d5071344e))
* **ai-sidebar:** badge + chime on working→idle even when tab is focused ([e8c8982](https://github.com/jessemaxh/GlanceTerm/commit/e8c8982f9231ec7e232ce1932b635f77f7097011))
* **ai-sidebar:** bound PTY-IPC awaits so a wedged pty cant freeze all tab statuses ([ecceb22](https://github.com/jessemaxh/GlanceTerm/commit/ecceb220a3c9356818b4c7a6689d43997732b373))
* **ai-sidebar:** bound the "M monitor" badge by each monitor's timeout ([4293b6b](https://github.com/jessemaxh/GlanceTerm/commit/4293b6beb912466505fd14ac281836854d048668))
* **ai-sidebar:** bound the live-monitor badge by the monitors REAL timeout ([9f3ab82](https://github.com/jessemaxh/GlanceTerm/commit/9f3ab82bb13cf8e38b42dd913e8f5d2fed373503))
* **ai-sidebar:** clear needs_permission when ESC cancels the prompt ([bf82855](https://github.com/jessemaxh/GlanceTerm/commit/bf82855e3aee8a7e2c0ce4653c6e48670838ec4f))
* **ai-sidebar:** clear the unread badge when a ready tab resumes working ([308aea0](https://github.com/jessemaxh/GlanceTerm/commit/308aea03a212b8061c675fceb12bef62267ae82b))
* **ai-sidebar:** close the residual worktree rm landmine (1-level isolatedRoot) ([850ef0f](https://github.com/jessemaxh/GlanceTerm/commit/850ef0f00af9590c6f20627d29426205aaa6b0a1))
* **ai-sidebar:** defensive sizing for pin glyph; modal styles need no CSS vars ([4962e28](https://github.com/jessemaxh/GlanceTerm/commit/4962e2826d6de34618a84f536e2a3b88852ff875))
* **ai-sidebar:** deterministic subagent pairing by agent_id ([d48bd70](https://github.com/jessemaxh/GlanceTerm/commit/d48bd706d607aa8d9440b82211a0c7ccb3fc2d09))
* **ai-sidebar:** drop hard-coded "Claude Code" from auto-approve copy ([a9e20aa](https://github.com/jessemaxh/GlanceTerm/commit/a9e20aaf45a0ea545df6b7e33de9f0ab9bd3dd58))
* **ai-sidebar:** eliminate screen jitter on screenshot capture ([6c53c4e](https://github.com/jessemaxh/GlanceTerm/commit/6c53c4e37036fd996f03b510365bf5dfa0904523))
* **ai-sidebar:** ESC interrupt now releases stuck `working` row ([90496fc](https://github.com/jessemaxh/GlanceTerm/commit/90496fca4de1686308d8f0b98321a9d3752ac359))
* **ai-sidebar:** fall back to a fresh launch when --resume targets a pruned session ([7dd7ced](https://github.com/jessemaxh/GlanceTerm/commit/7dd7cedb24111cee04701b51dc0de5edab1f6e14))
* **ai-sidebar:** gate auto-approve flag reconcile on config readiness ([c3344db](https://github.com/jessemaxh/GlanceTerm/commit/c3344dbeb2fd120c685c9ec05c0ee2b72f682d58))
* **ai-sidebar:** graceful snapshot fallback + async Linux /proc + stale comment ([62dcd41](https://github.com/jessemaxh/GlanceTerm/commit/62dcd4104ad52ea40b0f1a3b3ddf49d5ff39109b))
* **ai-sidebar:** harden the hook watcher against bursts, bad lines, stale bg arrivals ([8258699](https://github.com/jessemaxh/GlanceTerm/commit/82586992146fe0820c23cfb91bf345b80265ad5e))
* **ai-sidebar:** hold raw idle for 3s before exposing to UI ([ce9cbd2](https://github.com/jessemaxh/GlanceTerm/commit/ce9cbd2b4f5d8266c62241b83c6f676db0f06672))
* **ai-sidebar:** home-path prefix collision + skip notifications for closed tabs ([3da3f79](https://github.com/jessemaxh/GlanceTerm/commit/3da3f795f76299bf7b081a41f162ed2880c1fcb6))
* **ai-sidebar:** idle main agent stays idle even with background subagents running ([0caa1c6](https://github.com/jessemaxh/GlanceTerm/commit/0caa1c6c64e99363d5e20029135f0f87dd5f9335))
* **ai-sidebar:** keep a tab working while a subagent is in flight (revert idle-semantic) ([13156f7](https://github.com/jessemaxh/GlanceTerm/commit/13156f7094f98d4d0be18767f7e49f0fdd2641cd))
* **ai-sidebar:** keep bg shell count when the pgrep probe times out under load ([d2f3a33](https://github.com/jessemaxh/GlanceTerm/commit/d2f3a3398710c18739187cce85d439bd3aab1d76))
* **ai-sidebar:** make auto-approve toggle transactional ([ce5cd9f](https://github.com/jessemaxh/GlanceTerm/commit/ce5cd9f60fa9c72a7fb282769394bfd1b068b909))
* **ai-sidebar:** make focused row dominant vs pinned (WeChat-style ratio) ([ac6486f](https://github.com/jessemaxh/GlanceTerm/commit/ac6486f3b7699dab8a618928a1057748627f2067))
* **ai-sidebar:** make subagent counter robust against spurious SubagentStops ([c05f1e4](https://github.com/jessemaxh/GlanceTerm/commit/c05f1e4d061e0dfd57be3abb51ab6bf982750552))
* **ai-sidebar:** notify on working → idle (debounced) when tab unfocused ([db159a4](https://github.com/jessemaxh/GlanceTerm/commit/db159a4f2098ad3852bcf2ff9fc8bdfd478c4360))
* **ai-sidebar:** pill count + pinned subordinate bypass for hide-no-ai filter ([66a2374](https://github.com/jessemaxh/GlanceTerm/commit/66a237451658284e63dbed7916bbcbfe53a38194))
* **ai-sidebar:** pin attaches to the tab instance, not the cwd ([2f9bf8b](https://github.com/jessemaxh/GlanceTerm/commit/2f9bf8b0693d0e8c7db5c7e0700f236e18c7cf78))
* **ai-sidebar:** pin clicked row's sort rank so done→idle doesn't teleport ([690e5c3](https://github.com/jessemaxh/GlanceTerm/commit/690e5c32f1f1475b807e5dfca798b6fe3ad5dffa))
* **ai-sidebar:** pin SVG dimensions so the footer doesn't deform after a relayout ([0dd9c87](https://github.com/jessemaxh/GlanceTerm/commit/0dd9c87a90867ffa457efe0abae6415c9f2ae1f2))
* **ai-sidebar:** plug per-tab state leaks + gate Claude side-channel ([a6a6bb0](https://github.com/jessemaxh/GlanceTerm/commit/a6a6bb0e1d752fcd00ce54aec9d8ab067c332ac3))
* **ai-sidebar:** raise sidebar minWidth 300-&gt;360 so row info fits ([8f4a770](https://github.com/jessemaxh/GlanceTerm/commit/8f4a77073ebd282724f4f88266bcf1927700f34e))
* **ai-sidebar:** read GLANCETERM_TAB_ID from live env block + scan truePID and ancestors ([adf973b](https://github.com/jessemaxh/GlanceTerm/commit/adf973b7b1abe79041660006b290cecf8f6d4a6e))
* **ai-sidebar:** reconcile subagent count against the transcript on idle ([ed917ed](https://github.com/jessemaxh/GlanceTerm/commit/ed917ed1b1d17860423defb1b8446169a2217fbf))
* **ai-sidebar:** reject shell-unsafe cmdlines in auto-resume capture + replay ([8630ade](https://github.com/jessemaxh/GlanceTerm/commit/8630ade683fa46ec55bdd96bb62dfbd70fcdc27f))
* **ai-sidebar:** require terminal engagement (not tab focus) to clear done badge ([ec35e35](https://github.com/jessemaxh/GlanceTerm/commit/ec35e355c4dec206e4dc551d5b7e5d0be11cad83))
* **ai-sidebar:** revert transcript subagent-reconcile (it cleared running bg agents) ([1eff180](https://github.com/jessemaxh/GlanceTerm/commit/1eff180ff31c835bc4f871f9a565772cbb44c510))
* **ai-sidebar:** screenshot button no longer permanently breaks if remote bridge throws ([ad48ef5](https://github.com/jessemaxh/GlanceTerm/commit/ad48ef5cdf3aaa065db23d32fbb4e670da6225b9))
* **ai-sidebar:** show "Open agent in worktree" on the TAB HEADER too ([a34b520](https://github.com/jessemaxh/GlanceTerm/commit/a34b520b07ff7a83855285de0d2d18ae74da27a4))
* **ai-sidebar:** stop coldLoad re-reading closed-tab logs every 30s ([3cc6c07](https://github.com/jessemaxh/GlanceTerm/commit/3cc6c07b58b1de0a9b8447e3b80852ee6dae2102))
* **ai-sidebar:** stop counting long synchronous Bash as a bg job on Claude tabs ([dc2fab0](https://github.com/jessemaxh/GlanceTerm/commit/dc2fab098ea9ba6d87d0a9d8062c80c4d38ef6c9))
* **ai-sidebar:** stop phantom "working · 1 agent" on idle tabs (orphan agent_id leak) ([276b0cf](https://github.com/jessemaxh/GlanceTerm/commit/276b0cf3f5ed0cafa0dfd24e989fac4b6efd9b20))
* **ai-sidebar:** subagent ending via StopFailure leaked the in-flight count ([f55d22b](https://github.com/jessemaxh/GlanceTerm/commit/f55d22b5b53ae255fb8fb2dbee81dc57af86b86e))
* **ai-sidebar:** subagent tool events must not clobber the main agent status ([c72c30a](https://github.com/jessemaxh/GlanceTerm/commit/c72c30a8066a392fd1f3409459041bbb5dd6c2f0))
* **ai-sidebar:** sweep stale hook logs at startup to bound disk + cold-load cost ([1ec7071](https://github.com/jessemaxh/GlanceTerm/commit/1ec7071f260ffe8d23e20fb6f5ba41e0672e0889))
* **ai-sidebar:** unstick screenshot perm dialog + restore non-focused tabs' AI ([f69fcc3](https://github.com/jessemaxh/GlanceTerm/commit/f69fcc37352d8be7377f2201355908bd00758d58))
* **ai-sidebar:** unstick stale sidebar status during long event-less windows ([c6c6a0d](https://github.com/jessemaxh/GlanceTerm/commit/c6c6a0de15d8ae9978fb720e52f09acfec2ab65f))
* **ai-sidebar:** worktree — DI startup crash + split-pane worktree deletion (2 HIGH) ([9c97ac6](https://github.com/jessemaxh/GlanceTerm/commit/9c97ac65862d51d6c0a70dd80277226907d1dd62))
* **ai-sidebar:** worktree — removeSet rm-failure + isInUse tri-state (review) ([990dfe7](https://github.com/jessemaxh/GlanceTerm/commit/990dfe74da4824a374a8fa19c928fbcfcacc48e1))
* **ai-sidebar:** worktree — single-repo rollback safety + don't mount unselected repos ([830929c](https://github.com/jessemaxh/GlanceTerm/commit/830929c3038426802824e48927c6a09a76ecc52c))
* **ai-sidebar:** worktree engine — non-force removeSet must not fs.rm protected work (self-review) ([5c9151f](https://github.com/jessemaxh/GlanceTerm/commit/5c9151f7806fc3f99ed425c1e6489850a551973c))
* **ai-sidebar:** worktree engine — remaining review findings (symlink/lock/lstat/etc.) ([999bd0e](https://github.com/jessemaxh/GlanceTerm/commit/999bd0eeeff291abb9529d6aa3b0a08dc2f0e0fe))
* **ai-sidebar:** worktree engine — unique isolated dir + SHA base anchor (review) ([9336bbf](https://github.com/jessemaxh/GlanceTerm/commit/9336bbf23ad73b80379b8e9c32a60c039e061126))
* **ai-sidebar:** worktree engine review fixes (branch safety, single-repo layout) ([401a99e](https://github.com/jessemaxh/GlanceTerm/commit/401a99e77173b7b157ca3dda7291428aae36d39f))
* **ai-sidebar:** worktree isolation fails on a workspace of linked worktrees ([#102](https://github.com/jessemaxh/GlanceTerm/issues/102)) ([03e5da0](https://github.com/jessemaxh/GlanceTerm/commit/03e5da084d01cfd33fa9a30fdec7d4a1506ffe82))
* **ai-sidebar:** worktree manager — isInUse lsof exit-1 + remove() concurrency ([83754c7](https://github.com/jessemaxh/GlanceTerm/commit/83754c7318a8e3f7ba3ca8e24652adc393fa3249))
* **ai-sidebar:** worktree manager — never delete an in-use worktree (review) ([c5d0483](https://github.com/jessemaxh/GlanceTerm/commit/c5d04835312b740988142104a5a1860f10e7418b))
* **ai-sidebar:** worktree P2 review — close the reaper/persistence data-loss CRITICALs ([baee9c2](https://github.com/jessemaxh/GlanceTerm/commit/baee9c2092d0eb37236cb4e2eaca8a4804add0ed))
* **ai-sidebar:** worktree removeSet non-force teardown is atomic (review MEDIUM) ([0dd7c09](https://github.com/jessemaxh/GlanceTerm/commit/0dd7c094d0c826e8491db9aef012b7ca866d2974))
* **build/mac:** apply CI's app/yarn + electron symlink before electron-builder ([09b32a4](https://github.com/jessemaxh/GlanceTerm/commit/09b32a465cb40596f87cb7ec9eb504a3cbf5682a))
* **build/mac:** gate the new app/yarn + electron symlink behind SKIP_PREPACKAGE ([7819962](https://github.com/jessemaxh/GlanceTerm/commit/7819962a6457b7e913f8f88ba7f48c3d1dc65648))
* **build:** add temp keychain to search list so dmg codesign finds the identity ([adfab21](https://github.com/jessemaxh/GlanceTerm/commit/adfab2118f7f7c4ed6fe1a58c54e62c67eef5f40))
* **build:** exclude test files from the ai-sidebar typings build ([#109](https://github.com/jessemaxh/GlanceTerm/issues/109)) ([134628b](https://github.com/jessemaxh/GlanceTerm/commit/134628b9833e499ad5ecc4aa4b4359c0ef3eff28))
* **build:** make ai-sidebar/mobile-bridge typings resolvable on a cold build ([44de183](https://github.com/jessemaxh/GlanceTerm/commit/44de1837649ed7c8f68fb7465599cc40aacdf493))
* **build:** ship the inset/rounded macOS icon by default ([#103](https://github.com/jessemaxh/GlanceTerm/issues/103)) ([c4557f6](https://github.com/jessemaxh/GlanceTerm/commit/c4557f67a6ffd619be1c0ff0c0f8ae94b6a08302))
* **build:** sign + notarize + staple the dmg (electron-builder leaves it unsigned) ([d304d76](https://github.com/jessemaxh/GlanceTerm/commit/d304d76c31ddeb51f4a02504d1e846d3b842238d))
* **build:** stop bundling npm@6's https-proxy-agent@2 into plugins (0.3.0 splash hang) ([c8902f8](https://github.com/jessemaxh/GlanceTerm/commit/c8902f8c7656d89e2a9d349c4b8613f4a6dca889))
* **build:** strict RELEASE check + signed-dev warning + icon-block rollback (review) ([6b5bfe3](https://github.com/jessemaxh/GlanceTerm/commit/6b5bfe36495854aee2e1228662ca7386744fcc58))
* **close:** stop the per-tab "X is still running" bombardment on quit ([6ed6980](https://github.com/jessemaxh/GlanceTerm/commit/6ed698000a3e590298b1f4131d26544cd97b41ad))
* **configSync:** require HTTPS for sync host to prevent MITM RCE ([#11228](https://github.com/jessemaxh/GlanceTerm/issues/11228)) ([70022ae](https://github.com/jessemaxh/GlanceTerm/commit/70022ae63a19170e39c27ea639b745c9a3166ecb))
* **deps:** bump vitest 1.6 -&gt; 3.2.6 (CVE-2026-47429) ([72f1bd5](https://github.com/jessemaxh/GlanceTerm/commit/72f1bd5840139019782b9b02d975c21b9c22f305))
* disable spellchecker to prevent automatic dictionary downloads ([#11107](https://github.com/jessemaxh/GlanceTerm/issues/11107)) ([49aebfb](https://github.com/jessemaxh/GlanceTerm/commit/49aebfb7f5cc7b6b1b03957769ad106fcac22c0e))
* handle OSC sequences split across buffer chunks ([#11144](https://github.com/jessemaxh/GlanceTerm/issues/11144)) ([48bded7](https://github.com/jessemaxh/GlanceTerm/commit/48bded7b0effa3313430859cfe4ec7d06886d98b)), closes [#6001](https://github.com/jessemaxh/GlanceTerm/issues/6001)
* hide blacklisted profiles from OS dock/taskbar menu ([#11108](https://github.com/jessemaxh/GlanceTerm/issues/11108)) ([7a15a11](https://github.com/jessemaxh/GlanceTerm/commit/7a15a11624db162d03974c58b708fb9471d09240))
* **icon:** bake background as a layer so it renders on older macOS ([5768d15](https://github.com/jessemaxh/GlanceTerm/commit/5768d15cce398cea02d6f299459677d41b72c197))
* **icon:** unify on the dark background across all appearances ([43199a8](https://github.com/jessemaxh/GlanceTerm/commit/43199a88be3356a9482635dc0900b17780bdd7d4))
* improve agent authentication error handling and socket path validation ([#11034](https://github.com/jessemaxh/GlanceTerm/issues/11034)) ([78514d8](https://github.com/jessemaxh/GlanceTerm/commit/78514d8775753cd7132634858fc72df13729e410))
* improve menu readability and Chinese localization ([#11272](https://github.com/jessemaxh/GlanceTerm/issues/11272)) ([643d716](https://github.com/jessemaxh/GlanceTerm/commit/643d7164a447bb68f9bf6cb06c95166cb85246f8))
* include http proxy settings in ssh multiplexer key ([#10943](https://github.com/jessemaxh/GlanceTerm/issues/10943)) ([2d0f59c](https://github.com/jessemaxh/GlanceTerm/commit/2d0f59c315f5343372858f51b80c8fc782918d94))
* **mac:** bottom-up ad-hoc sign so Electron Framework loads ([556540b](https://github.com/jessemaxh/GlanceTerm/commit/556540b361f7b038f98adca53dc2036410b20991))
* **mac:** flip fuses before ad-hoc sign ([00be946](https://github.com/jessemaxh/GlanceTerm/commit/00be94639aa3728d4c4dbe066e47d422a1b03c61))
* **mobile-bridge,ai-sidebar:** address 13-issue review backlog ([b768835](https://github.com/jessemaxh/GlanceTerm/commit/b7688357a547ed8e85ffa6b4761bab022036dd59))
* **mobile-bridge:** abort-aware backoff + lifecycle queue + topic dedup ([a8bf4b3](https://github.com/jessemaxh/GlanceTerm/commit/a8bf4b3d9a8b979f786b8cc49bdb9e0fbedfd65f))
* **mobile-bridge:** apply 2nd-pass review findings ([7145644](https://github.com/jessemaxh/GlanceTerm/commit/7145644b0f78860269fc0802448bc6c422a2ab33))
* **mobile-bridge:** build break + token leak + launch-time spam ([2337548](https://github.com/jessemaxh/GlanceTerm/commit/23375481630dfa94061d74de78072edc87d40c68))
* **mobile-bridge:** dedup "started" push across permission round-trip + preserve eventFilter on status toggle ([7325a4f](https://github.com/jessemaxh/GlanceTerm/commit/7325a4fdf265449e60c2e5238ad2a66ac27e8333))
* **mobile-bridge:** degrade-to-close on delete failure + harden purge (review) ([d73c4cb](https://github.com/jessemaxh/GlanceTerm/commit/d73c4cb4162b7382edd307843c89ba3ec5127ead))
* **mobile-bridge:** detect Feishu recall failure so delete degrades to close (review) ([1c2ea7b](https://github.com/jessemaxh/GlanceTerm/commit/1c2ea7b6942045d2307b50bf1202a185e7580fe6))
* **mobile-bridge:** fall back to native cwd for topic titles ([88d43f2](https://github.com/jessemaxh/GlanceTerm/commit/88d43f24e881936b1ad513051e7fc01d901ba853))
* **mobile-bridge:** finish agent-agnostic + Feishu inbound ([70d98c4](https://github.com/jessemaxh/GlanceTerm/commit/70d98c4ae41b5c076c2dba701c40b0e8f5c8150f))
* **mobile-bridge:** inbound race + write race + pairing leak + silent fail ([11d2698](https://github.com/jessemaxh/GlanceTerm/commit/11d26983240b76a3fc82591c820b282670f1e1a4))
* **mobile-bridge:** post-await leak + send-side auth signal + audit platform ([ce29e7b](https://github.com/jessemaxh/GlanceTerm/commit/ce29e7ba765c3c4de36b2fc5e2f6eb1556ee803d))
* **mobile-bridge:** tear binding down to unbound on unrecoverable backend failure ([e31935a](https://github.com/jessemaxh/GlanceTerm/commit/e31935a2e4182cea6d2ddb9df394206fea2d4437))
* **opencode:** show model mid-turn, suppress phantom bg, stop wedged-working ([8bb8488](https://github.com/jessemaxh/GlanceTerm/commit/8bb8488dcc99522d63203fac50e7a2b7782a7d34))
* pin 3 unpinned action(s) ([#11117](https://github.com/jessemaxh/GlanceTerm/issues/11117)) ([7782b70](https://github.com/jessemaxh/GlanceTerm/commit/7782b70f3390232b8874c53cc5db301e1bc30119))
* **pluginsSettingsTab.component.pug:** flex wrapper for gap in buttons ([#10986](https://github.com/jessemaxh/GlanceTerm/issues/10986)) ([731f543](https://github.com/jessemaxh/GlanceTerm/commit/731f54321782361252c121d0fc58e413a228ae32))
* remove unsafe exec() in UAC.cpp ([#11195](https://github.com/jessemaxh/GlanceTerm/issues/11195)) ([1000791](https://github.com/jessemaxh/GlanceTerm/commit/100079134659345dfd71b9eefd82da5ef4a6f31f))
* **screenshot:** check Screen Recording permission before the AI-agent gate ([9fd952c](https://github.com/jessemaxh/GlanceTerm/commit/9fd952c45c319adfe1742987b540a865bb30a7b8))
* **screenshot:** serialize the permission preflight across entry points (review) ([5ae7c0a](https://github.com/jessemaxh/GlanceTerm/commit/5ae7c0acdabcbaf88c2a4abfe6f233743d901031))
* **security:** refuse destructive saves after corrupt store loads; validate plugin install specs ([de635c3](https://github.com/jessemaxh/GlanceTerm/commit/de635c35c99ae771f1ba07c4ccc49be9567a0705))
* **sidebar:** count SendMessage-resumed background subagents in the in-flight badge ([#94](https://github.com/jessemaxh/GlanceTerm/issues/94)) ([e83e065](https://github.com/jessemaxh/GlanceTerm/commit/e83e0657f5539799195329c2ae5276fa05bf803c))
* **sidebar:** keep model slug across resume/compact SessionStart (chip vanished after resume) ([c2b801d](https://github.com/jessemaxh/GlanceTerm/commit/c2b801d4bfb8a70f1b928484c50df4c00a63d131))
* **sidebar:** show Codex cache tokens in the live token chip ([49485dc](https://github.com/jessemaxh/GlanceTerm/commit/49485dc9dd8ef226899d9d617ce932e0f923e5d3))
* **sidebar:** stop the model chip sticking on a subagent's model ([#97](https://github.com/jessemaxh/GlanceTerm/issues/97)) ([5179aa7](https://github.com/jessemaxh/GlanceTerm/commit/5179aa74a4c183d9a6dbaf3f794a9df2748e0526))
* **ssh/settings:** formats date value according to locale rules ([#10468](https://github.com/jessemaxh/GlanceTerm/issues/10468)) ([804b967](https://github.com/jessemaxh/GlanceTerm/commit/804b96746652b03734b50275db2e266eab5dee2c))
* **ssh:** add EOF handling and error propagation for port forwarding ([#10964](https://github.com/jessemaxh/GlanceTerm/issues/10964)) ([ec1bbfb](https://github.com/jessemaxh/GlanceTerm/commit/ec1bbfb348c2dc64cbd25bc580c5cb28818e829c))
* **ssh:** fix windows openssh agent detection logic ([#10954](https://github.com/jessemaxh/GlanceTerm/issues/10954)) ([01abea8](https://github.com/jessemaxh/GlanceTerm/commit/01abea8effea328bf2bd87e538d441784b464172))
* **terminal:** prevent scroll-to-top race during fast output ([#11102](https://github.com/jessemaxh/GlanceTerm/issues/11102)) ([aea2645](https://github.com/jessemaxh/GlanceTerm/commit/aea26455632d8f649c95f399ab50456569e48a25))
* **token-stats:** 3rd-pass review polish (modal close, trackBy keys, dead-instance CD) ([17fa555](https://github.com/jessemaxh/GlanceTerm/commit/17fa555f51564da14f59a5ded3dbf83c47cd6af3))
* **token-stats:** adversarial-review fixes (3 critical correctness + perf) ([afc59e7](https://github.com/jessemaxh/GlanceTerm/commit/afc59e77732091f5ad80f3273fdf38cb9cda8d73))
* **token-stats:** make the table scroll when it overflows the modal ([902650f](https://github.com/jessemaxh/GlanceTerm/commit/902650fb7173980e42dcb74df20ea7c04309c0d6))
* **tokens:** show cache for Gemini + opencode too (sidebar + Token Usage) ([e776ab7](https://github.com/jessemaxh/GlanceTerm/commit/e776ab7a00941dad46a8124677afb4518deaa8c5))
* Unable to launch WinSCP for SSH sessions using private key ([#10308](https://github.com/jessemaxh/GlanceTerm/issues/10308)) ([36cd131](https://github.com/jessemaxh/GlanceTerm/commit/36cd1314a54e27bdddbb2cdfca43c53beb0f1b2b))
* unexpected configuration was selected in the recent profiles ([#10817](https://github.com/jessemaxh/GlanceTerm/issues/10817)) ([fdc8e22](https://github.com/jessemaxh/GlanceTerm/commit/fdc8e22e0bb8c92c182d05bed36693b7f16806f9))
* **update:** install macOS updates in place to avoid the admin-helper prompt ([#112](https://github.com/jessemaxh/GlanceTerm/issues/112)) ([bdcfa61](https://github.com/jessemaxh/GlanceTerm/commit/bdcfa6170d0aaa0b31331799ed4f5f2d6312eff4))
* **updater,packaging:** point release feed at jessemaxh/glanceterm ([b6f9255](https://github.com/jessemaxh/GlanceTerm/commit/b6f9255a4ffc86fa854b4ccc21e38c45baa89a78))
* **updater:** address second adversarial review (real defects) ([9f6f4c8](https://github.com/jessemaxh/GlanceTerm/commit/9f6f4c86f68d860c473823a6827f00b3b016bfa1))
* **updater:** distinguish integrity errors from benign network errors ([bfcffab](https://github.com/jessemaxh/GlanceTerm/commit/bfcffab032d7c2c9b6e15db886e2e81ee28cc295))
* **updater:** feed/upload ordering + lint (review) ([c6318cc](https://github.com/jessemaxh/GlanceTerm/commit/c6318cc1c769ff8e559b82634f4abafb7b658454))
* **updater:** make auto-update actually work + harden (review fixes) ([e45f5df](https://github.com/jessemaxh/GlanceTerm/commit/e45f5df54742be5eec2fb934973901baa4b1330a))
* upgraded webpack from 5.86.0 to 5.104.1 to fix ES6 class extension bug with xterm.js v6. ([#11007](https://github.com/jessemaxh/GlanceTerm/issues/11007)) ([6363a21](https://github.com/jessemaxh/GlanceTerm/commit/6363a21b04ad6ca60db93534ffe13430d955698b))
* **usage:** count Claude subagent tokens, which were silently missing ([#118](https://github.com/jessemaxh/GlanceTerm/issues/118)) ([9b9ef61](https://github.com/jessemaxh/GlanceTerm/commit/9b9ef6159810c71bd0986a7fc717b27e482e53aa))
* **usage:** read transcripts in chunks so big sessions keep reporting tokens ([#120](https://github.com/jessemaxh/GlanceTerm/issues/120)) ([94c1e0c](https://github.com/jessemaxh/GlanceTerm/commit/94c1e0c89ab76a73502fdf4fcb0df7ca8dcdf933))
* use switchMap instead of flatMap for plugin search to prevent st… ([#11089](https://github.com/jessemaxh/GlanceTerm/issues/11089)) ([2537aa1](https://github.com/jessemaxh/GlanceTerm/commit/2537aa119ef827c395cc2389434526eb5fb03e23))
* **worktree:** name isolated dirs readably instead of percent-escaping them ([#105](https://github.com/jessemaxh/GlanceTerm/issues/105)) ([0a6a27b](https://github.com/jessemaxh/GlanceTerm/commit/0a6a27b8493061047d539c2b96de84df977e2af4))


### Performance Improvements

* **ai-sidebar:** async exec + per-tick process-tree snapshot in tab-monitor ([fb21a4e](https://github.com/jessemaxh/GlanceTerm/commit/fb21a4ed974df8a3057cc8daefeb22791b1679be))
* **ai-sidebar:** kill the per-CD O(N²) isSubordinate filter ([c25db93](https://github.com/jessemaxh/GlanceTerm/commit/c25db93bd35c21ba1d906ed28381e7c0f3472b45))
* **ai-sidebar:** refresh on tabsChanged$ with coalescing re-tick ([d6b240c](https://github.com/jessemaxh/GlanceTerm/commit/d6b240cb7da0fb88cd6c41d875f07dc20151e661))
* fix UI degradation with large SSH config files. Issue [#11078](https://github.com/jessemaxh/GlanceTerm/issues/11078) ([#11094](https://github.com/jessemaxh/GlanceTerm/issues/11094)) ([11587d8](https://github.com/jessemaxh/GlanceTerm/commit/11587d8e2c125c835a5f18a5b9d7cf7f2b1dff2d))
* **sidebar:** memoize view-model + back off polls; gate mobile-bridge relay poll; composite-only dot animations ([3c3ab7b](https://github.com/jessemaxh/GlanceTerm/commit/3c3ab7b1d378fb5a21abf8e2bc494c5a1f1defb0))


### Miscellaneous Chores

* next release is v0.2.0 (worktree isolation) ([ce9d7d9](https://github.com/jessemaxh/GlanceTerm/commit/ce9d7d964ce5ad44b8750ac6b716e76df2669117))
* release 0.3.0 ([c0abcfa](https://github.com/jessemaxh/GlanceTerm/commit/c0abcfa2f62d879464c225337c0be1131cbd6a36))

## [0.3.10](https://github.com/jessemaxh/GlanceTerm/compare/v0.3.9...v0.3.10) (2026-09-21)


### Bug Fixes

* **usage:** count Claude subagent tokens, which were silently missing ([#118](https://github.com/jessemaxh/GlanceTerm/issues/118)) ([9b9ef61](https://github.com/jessemaxh/GlanceTerm/commit/9b9ef6159810c71bd0986a7fc717b27e482e53aa))
* **usage:** read transcripts in chunks so big sessions keep reporting tokens ([#120](https://github.com/jessemaxh/GlanceTerm/issues/120)) ([94c1e0c](https://github.com/jessemaxh/GlanceTerm/commit/94c1e0c89ab76a73502fdf4fcb0df7ca8dcdf933))

## [0.3.9](https://github.com/jessemaxh/GlanceTerm/compare/v0.3.8...v0.3.9) (2026-08-02)


### Features

* **sidebar:** track harness Workflow agents and show a workflow chip ([#114](https://github.com/jessemaxh/GlanceTerm/issues/114)) ([ea88d7e](https://github.com/jessemaxh/GlanceTerm/commit/ea88d7e8777a1d93d855a992e9f14c2843c6ead6))

## [0.3.8](https://github.com/jessemaxh/GlanceTerm/compare/v0.3.7...v0.3.8) (2026-07-17)


### Bug Fixes

* **update:** install macOS updates in place to avoid the admin-helper prompt ([#112](https://github.com/jessemaxh/GlanceTerm/issues/112)) ([bdcfa61](https://github.com/jessemaxh/GlanceTerm/commit/bdcfa6170d0aaa0b31331799ed4f5f2d6312eff4))

## [0.3.7](https://github.com/jessemaxh/GlanceTerm/compare/v0.3.6...v0.3.7) (2026-07-13)


### Bug Fixes

* **build:** exclude test files from the ai-sidebar typings build ([#109](https://github.com/jessemaxh/GlanceTerm/issues/109)) ([134628b](https://github.com/jessemaxh/GlanceTerm/commit/134628b9833e499ad5ecc4aa4b4359c0ef3eff28))

## [0.3.6](https://github.com/jessemaxh/GlanceTerm/compare/v0.3.5...v0.3.6) (2026-07-13)


### Features

* **update:** notify + browser DMG download on macOS, never ShipIt (no admin prompt) ([#107](https://github.com/jessemaxh/GlanceTerm/issues/107)) ([a88148c](https://github.com/jessemaxh/GlanceTerm/commit/a88148cef09ee31819f36f61ddf7de7ac5b8800c))

## [0.3.5](https://github.com/jessemaxh/GlanceTerm/compare/v0.3.4...v0.3.5) (2026-07-09)


### Features

* **app:** add "Check for Updates…" to the macOS app menu under About ([#104](https://github.com/jessemaxh/GlanceTerm/issues/104)) ([53d44fd](https://github.com/jessemaxh/GlanceTerm/commit/53d44fde905510982734111394af71f253d2753e))


### Bug Fixes

* **worktree:** name isolated dirs readably instead of percent-escaping them ([#105](https://github.com/jessemaxh/GlanceTerm/issues/105)) ([0a6a27b](https://github.com/jessemaxh/GlanceTerm/commit/0a6a27b8493061047d539c2b96de84df977e2af4))

## [0.3.4](https://github.com/jessemaxh/GlanceTerm/compare/v0.3.3...v0.3.4) (2026-07-06)


### Features

* **ai-sidebar:** right-click "Reset agent status" to clear a stuck row ([#100](https://github.com/jessemaxh/GlanceTerm/issues/100)) ([b8e5ad4](https://github.com/jessemaxh/GlanceTerm/commit/b8e5ad46b22b4f5df702ffd2acb078c3517dd819))


### Bug Fixes

* **ai-sidebar:** worktree isolation fails on a workspace of linked worktrees ([#102](https://github.com/jessemaxh/GlanceTerm/issues/102)) ([03e5da0](https://github.com/jessemaxh/GlanceTerm/commit/03e5da084d01cfd33fa9a30fdec7d4a1506ffe82))
* **build:** ship the inset/rounded macOS icon by default ([#103](https://github.com/jessemaxh/GlanceTerm/issues/103)) ([c4557f6](https://github.com/jessemaxh/GlanceTerm/commit/c4557f67a6ffd619be1c0ff0c0f8ae94b6a08302))

## [0.3.3](https://github.com/jessemaxh/GlanceTerm/compare/v0.3.2...v0.3.3) (2026-07-03)


### Bug Fixes

* **sidebar:** count SendMessage-resumed background subagents in the in-flight badge ([#94](https://github.com/jessemaxh/GlanceTerm/issues/94)) ([e83e065](https://github.com/jessemaxh/GlanceTerm/commit/e83e0657f5539799195329c2ae5276fa05bf803c))
* **sidebar:** stop the model chip sticking on a subagent's model ([#97](https://github.com/jessemaxh/GlanceTerm/issues/97)) ([5179aa7](https://github.com/jessemaxh/GlanceTerm/commit/5179aa74a4c183d9a6dbaf3f794a9df2748e0526))

## [0.3.2](https://github.com/jessemaxh/GlanceTerm/compare/v0.3.1...v0.3.2) (2026-06-26)


### Features

* **sidebar:** remote-tab-awareness — connection chip for remote tabs ([06caf3b](https://github.com/jessemaxh/GlanceTerm/commit/06caf3bd501951c022b3678d085d45b759bcc990))

## [0.3.1](https://github.com/jessemaxh/GlanceTerm/compare/v0.3.0...v0.3.1) (2026-06-26)


### Bug Fixes

* **build:** stop bundling npm@6's https-proxy-agent@2 into plugins (0.3.0 splash hang) ([c8902f8](https://github.com/jessemaxh/GlanceTerm/commit/c8902f8c7656d89e2a9d349c4b8613f4a6dca889))

## [0.3.0](https://github.com/jessemaxh/GlanceTerm/compare/v0.2.0...v0.3.0) (2026-06-26)


### Features

* **updater:** GitHub-driven in-app auto-update ([aa45519](https://github.com/jessemaxh/GlanceTerm/commit/aa45519f131c5aae6ead26ab43b03b0d0bcd3987))


### Bug Fixes

* **updater:** address second adversarial review (real defects) ([9f6f4c8](https://github.com/jessemaxh/GlanceTerm/commit/9f6f4c86f68d860c473823a6827f00b3b016bfa1))
* **updater:** distinguish integrity errors from benign network errors ([bfcffab](https://github.com/jessemaxh/GlanceTerm/commit/bfcffab032d7c2c9b6e15db886e2e81ee28cc295))
* **updater:** feed/upload ordering + lint (review) ([c6318cc](https://github.com/jessemaxh/GlanceTerm/commit/c6318cc1c769ff8e559b82634f4abafb7b658454))
* **updater:** make auto-update actually work + harden (review fixes) ([e45f5df](https://github.com/jessemaxh/GlanceTerm/commit/e45f5df54742be5eec2fb934973901baa4b1330a))


### Miscellaneous Chores

* release 0.3.0 ([c0abcfa](https://github.com/jessemaxh/GlanceTerm/commit/c0abcfa2f62d879464c225337c0be1131cbd6a36))

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
