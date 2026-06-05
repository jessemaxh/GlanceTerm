import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { execSync } from 'child_process'
import * as fsSync from 'fs'

import { AppService, BaseTabComponent } from 'tabby-core'

import { HookAdapterRegistry } from './hook-adapters/registry'
import { HookWatcherService } from './hook-watcher.service'
import { HookInstallerService } from './hook-installer.service'

/** Poll cadence for process-tree scans. Hooks deliver state pushes; the poll
 * is only here to discover when an AI tool starts/stops in a tab. */
const POLL_MS = 1500

export type TabStatus = 'working' | 'idle' | 'needs_permission' | 'no_ai'

/**
 * AI CLIs we recognise from `ps` output. Knowing WHICH tool is running tells
 * the UI which HookAdapter to consult and which tag (CLA/CDX/AID …) to draw.
 * Pure process-tree match — never screen content. To add a new tool: add the
 * regex pair here AND register the matching adapter (see hook-adapters/).
 */
export type AiTool =
    | 'claude'
    | 'codex'
    | 'gemini'
    | 'opencode'
    | 'aider'
    | 'goose'

const AI_PATTERNS: Array<{ tool: AiTool; regexes: RegExp[] }> = [
    {
        tool: 'claude',
        regexes: [
            /\bclaude(\s|$)/,
            /\/(?:@anthropic-ai\/)?claude-code\/[^\s]+\.[mc]?js/,
        ],
    },
    {
        tool: 'codex',
        regexes: [
            /\bcodex(\s|$)/,
            /\/codex(?:-cli)?\/[^\s]+\.[mc]?js/,
        ],
    },
    {
        tool: 'gemini',
        regexes: [
            /\bgemini(\s|$)/,
            /\/(?:@google\/)?gemini(?:-cli)?\/[^\s]+\.[mc]?js/,
        ],
    },
    {
        tool: 'opencode',
        regexes: [
            /\bopencode(\s|$)/,
            /\/opencode\/[^\s]+\.[mc]?js/,
        ],
    },
    {
        tool: 'aider',
        regexes: [
            /\baider(\s|$)/,
            /python[\d.]*\s+(?:-m\s+aider|.+\/aider\/(?:__main__|main)\.py)/,
        ],
    },
    {
        tool: 'goose',
        regexes: [
            /\bgoose(\s|$)/,
        ],
    },
]

export interface TabState {
    /** Outer tab in app.tabs[]. Pass to AppService.selectTab() to focus. */
    outerTab: BaseTabComponent
    /** Inner tab (= outerTab unless it's inside a split). */
    innerTab: BaseTabComponent
    /** What the user sees in the top tab bar — used as our row label. */
    title: string
    /** The descendant AI process pid, if there is one. */
    aiPid: number | null
    /** Which AI tool we detected running, if any. */
    aiTool: AiTool | null
    /** Final state for the UI to render. */
    status: TabStatus
    /** Best-effort cwd of the shell session. Display only. */
    cwd: string | null
    /** ms since the last hook event for this tab — null if no event yet. */
    lastActiveMs: number | null
    /**
     * True when this tab has an adapter-supported tool AND no hook event has
     * fired yet. UI uses this to render "waiting for first event…" rather
     * than a stale or fabricated status.
     */
    awaitingFirstEvent: boolean
}

interface ChildProcessInfo { pid: number; ppid: number; command: string }

/**
 * Polls Tabby's tab list and produces a TabState per terminal tab.
 *
 * Hook-driven architecture (v0.2):
 *   1. Tabby spawns each shell with `GLANCETERM_TAB_ID=<uuid>` (see
 *      tabby-local/src/session.ts).
 *   2. On first launch the installer writes that uuid into the AI tool's
 *      settings hook entries, so the agent's hook handler calls our script
 *      with that env var inherited from the shell.
 *   3. The handler writes JSON status to ~/.glanceterm/hooks/<uuid>.json.
 *   4. HookWatcherService fs.watches that dir and exposes a sync getStatus.
 *   5. This TabMonitor stitches the two halves together: it discovers which
 *      AI tool is alive in each tab via the process tree, then looks up that
 *      tab's hook snapshot to decide working/idle/needs_permission.
 *
 * Tools with adapters but no event yet show as `idle` with awaitingFirstEvent
 * = true. Tools without adapters (aider, opencode, goose) show as `working`
 * for as long as the process is alive — degraded but visible. Their
 * granular state will arrive when those adapters land.
 */
@Injectable({ providedIn: 'root' })
export class TabMonitor implements OnDestroy {
    private subject = new BehaviorSubject<TabState[]>([])
    private timer?: NodeJS.Timeout
    private busy = false
    /** Cache so we don't re-stat per tick when nothing has changed. */
    private shellPidCache = new WeakMap<BaseTabComponent, number>()
    /**
     * Per-tab cache of the REAL `GLANCETERM_TAB_ID` read from the running
     * PTY process's environment block. Authoritative over `sess.glancetermTabId`
     * because any path that attaches a NEW Session instance to a PRE-EXISTING
     * pty produces a fresh field-initializer UUID on the Session while the
     * live pty's env block still holds the UUID injected at the original
     * spawn. The hook handler writes JSON named after the env-block UUID, so
     * we must match THAT one or every row stays "awaitingFirstEvent" forever.
     *
     * Paths that trigger the mismatch:
     *   - Renderer reload (dev hot-reload, or Cmd+R when TABBY_DEV adds the
     *     `role: 'reload'` menu — see app/lib/app.ts). Main process keeps the
     *     PTYManager alive, so PTYs survive while the renderer reconstructs
     *     all Sessions from scratch.
     *   - "Duplicate tab while keeping state" / split-tab recovery within a
     *     running app — `terminalTab.component.ts` calls back into
     *     `Session.start` with `restoreFromPTYID`, reattaching to a live pty.
     *     (Available in release builds — user-triggered, but it exists.)
     *   - Renderer-only crash recovery (rare): renderer dies and Electron
     *     reloads it; main process and PTYs untouched.
     *
     * NOT a problem: cold app relaunch. Main process death takes PTYManager
     * with it, all PTYs are killed, the next launch spawns fresh PTYs whose
     * env block and Session UUID are generated together.
     *
     * Once captured, the value never changes — env blocks are immutable post-exec.
     */
    private envTabIdCache = new WeakMap<BaseTabComponent, string>()
    /**
     * Per-tool flag — true once we've kicked off `installer.installFor(tool)`
     * in response to detecting that tool running. Covers the "installed
     * Claude AFTER GlanceTerm was already up" case: startup-time install
     * was gated off (no ~/.claude/ yet), then user installs Claude and runs
     * it, we see the process, fire a one-shot install. Idempotent so the
     * worst case is one redundant lockfile probe.
     */
    private installTriggered = new Set<AiTool>()

    readonly states$: Observable<TabState[]> = this.subject.asObservable()

    /** Snapshot of the most recent tick's states — useful for one-shot
     *  consumers (e.g. the screenshot paste service) that need a value
     *  without subscribing. */
    get current (): TabState[] {
        return this.subject.getValue()
    }

    constructor (
        private app: AppService,
        private registry: HookAdapterRegistry,
        private hooks: HookWatcherService,
        private installer: HookInstallerService,
    ) {
        void this.tick()
        this.timer = setInterval(() => { void this.tick() }, POLL_MS)
        // A fresh hook event should refresh the UI within the next render
        // cycle even if no poll has fired since — re-emit our last states.
        this.hooks.snapshots$.subscribe(() => { void this.tick() })
    }

    ngOnDestroy (): void {
        if (this.timer) clearInterval(this.timer)
    }

    private async tick (): Promise<void> {
        if (this.busy) return
        this.busy = true
        try {
            const tabs = this.collectTerminalTabs()
            const out: TabState[] = []
            const CHUNK = 8
            for (let i = 0; i < tabs.length; i += CHUNK) {
                const chunk = tabs.slice(i, i + CHUNK)
                const results = await Promise.all(chunk.map(t => this.safeMakeState(t)))
                for (const r of results) if (r) out.push(r)
            }
            this.subject.next(out)
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] tick failed:', e)
        } finally {
            this.busy = false
        }
    }

    private async safeMakeState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
    ): Promise<TabState | null> {
        try {
            return await this.makeState(t)
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] makeState failed for tab:', t.outer?.title, e)
            return null
        }
    }

    private async makeState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
    ): Promise<TabState | null> {
        const sess: any = (t.inner as any).session
        if (!sess || typeof sess.getChildProcesses !== 'function') {
            // Restored tab with no live session — show as no_ai so the row
            // appears (user can click to wake it) without lighting up status.
            return this.placeholderState(t)
        }

        // 1. truePID = the pty's foreground process leader. We also use it
        //    as our shell-pid cache value (informational) AND include it in
        //    the AI-tool scan — see (2) below.
        let truePid: number | null = null
        try {
            const pid = await sess.pty?.getTruePID?.()
            if (typeof pid === 'number' && pid > 0) {
                truePid = pid
                this.shellPidCache.set(t.inner, pid)
            }
        } catch { /* swallow */ }
        if (!truePid && this.shellPidCache.has(t.inner)) {
            truePid = this.shellPidCache.get(t.inner) ?? null
        }

        // 2. Process-tree AI tool detection. Tabby's `command` field lies
        //    for several tools (claude returns the version string), so
        //    re-read the real cmdline via ps.
        //
        //    IMPORTANT: scan both `children` AND `truePID` itself. When the
        //    user runs an AI CLI like `claude` from a shell, the tty's
        //    foreground process group leader becomes claude — so getTruePID
        //    returns claude's pid, and `getChildProcesses` (which filters by
        //    `ppid === truePID`) only returns claude's OWN children (zsh,
        //    caffeinate). If we only inspect children we never see claude.
        let children: ChildProcessInfo[] = []
        try {
            children = await sess.getChildProcesses() ?? []
        } catch { /* swallow */ }

        // Candidates: truePID + its ANCESTORS + its DIRECT CHILDREN.
        //
        // Why ancestors: the pty's foreground-process leader (truePID) is
        // whichever process currently holds the controlling tty. When the
        // user runs `claude`, claude may spawn helpers (zsh subshells,
        // `caffeinate`, …). Any of those can end up as the foreground
        // leader at the moment we poll, which means truePID is sometimes
        // `caffeinate` while the actual AI tool sits one level up. We walk
        // up the ppid chain a few steps to make sure we still see claude.
        //
        // Why direct children: covers the inverse case — e.g. shell is still
        // foreground and claude was just launched but hasn't taken over yet.
        //
        // Ordering: truePID first, then ancestors (closest first), then
        // children. First AI match wins, so the most "active" candidate
        // (the foreground program itself) gets priority over its parent
        // shell when both look AI-ish.
        const candidates: ChildProcessInfo[] = []
        const seenPids = new Set<number>()
        const pushCand = (pid: number) => {
            if (pid > 0 && !seenPids.has(pid)) {
                seenPids.add(pid)
                candidates.push({ pid, ppid: -1, command: '' })
            }
        }
        if (truePid !== null) {
            pushCand(truePid)
            for (const a of ancestorsOf(truePid, 6)) pushCand(a)
        }
        for (const c of children) pushCand(c.pid)

        const realCmds = realCommandsFor(candidates.map(c => c.pid))

        let aiTool: AiTool | null = null
        let aiPid: number | null = null
        for (const c of candidates) {
            const real = realCmds.get(c.pid) ?? c.command
            if (!real) continue
            const match = AI_PATTERNS.find(p => p.regexes.some(r => r.test(real)))
            if (match) { aiTool = match.tool; aiPid = c.pid; break }
        }

        // First-detection trigger for late hook install — if Claude (etc.)
        // appeared on the machine AFTER GlanceTerm's startup install gate
        // ran, the user would otherwise need to relaunch GlanceTerm to get
        // hooks wired. Fire installFor() the first time we see each tool;
        // the installer is idempotent + lock-protected so repeat fires are
        // cheap. Skipped for non-adapter tools (no-op anyway).
        if (aiTool && this.registry.supports(aiTool) && !this.installTriggered.has(aiTool)) {
            this.installTriggered.add(aiTool)
            void this.installer.installFor(aiTool)
        }

        // 3. CWD (display only).
        let cwd: string | null = typeof sess.reportedCWD === 'string' && sess.reportedCWD
            ? sess.reportedCWD : null
        if (!cwd && typeof sess.getWorkingDirectory === 'function') {
            try { cwd = await sess.getWorkingDirectory() } catch { /* swallow */ }
        }

        // 4. Decide status. The new pipeline pivots on whether (a) an AI tool
        //    is running at all, (b) we have an adapter for it, (c) a hook has
        //    fired yet for the shell's GLANCETERM_TAB_ID.
        let status: TabStatus
        let lastActiveMs: number | null = null
        let awaitingFirstEvent = false

        if (!aiTool) {
            status = 'no_ai'
        } else if (!this.registry.supports(aiTool)) {
            // Tool we recognise via ps but don't have a hook adapter for yet —
            // degraded "we know it's alive, can't tell working vs idle" state.
            status = 'working'
        } else {
            // Prefer the UUID actually present in the live process env block —
            // see `envTabIdCache` doc above for why this beats sess.glancetermTabId.
            //
            // Try aiPid FIRST (almost always the right pick — claude/codex
            // were spawned by Tabby's shell, so they inherit GLANCETERM_TAB_ID
            // and are readable by `ps eww`/proc), then truePID, then ancestor
            // chain. The fallback covers the case where the foreground process
            // is a SIP-protected system binary like `caffeinate` whose env
            // block macOS refuses to expose — its parent (claude) is fine.
            const envCandidates: number[] = []
            const push = (p: number | null) => { if (p && !envCandidates.includes(p)) envCandidates.push(p) }
            push(aiPid)
            push(truePid)
            if (truePid) for (const a of ancestorsOf(truePid, 6)) push(a)
            const envId = this.readEnvTabId(t.inner, envCandidates)
            const tabId: string | undefined = envId ?? sess.glancetermTabId
            const snap = tabId ? this.hooks.getStatus(tabId) : null
            if (snap) {
                status = snap.status
                lastActiveMs = Math.max(0, Date.now() - snap.eventAt)
            } else {
                // Adapter exists and tool is running but no hook event in our
                // state dir yet. Either (a) hook just got installed and Claude
                // hasn't restarted, (b) session predates GLANCETERM_TAB_ID
                // injection, or (c) we somehow lost the file. Show "idle" so
                // the row reads as "present but not actively working" and
                // mark awaitingFirstEvent so UI can hint that to the user.
                status = 'idle'
                awaitingFirstEvent = true
            }
        }

        return {
            outerTab: t.outer,
            innerTab: t.inner,
            title: t.outer.customTitle || t.outer.title || `(tab ${this.shellPidCache.get(t.inner) ?? '?'})`,
            aiTool,
            aiPid,
            cwd,
            status,
            lastActiveMs,
            awaitingFirstEvent,
        }
    }

    /**
     * Read GLANCETERM_TAB_ID from a live process env block. Tries each pid in
     * `candidatePids` order and returns the first hit. Cached per tab — env
     * blocks don't change after exec, so a single successful read is enough
     * for the lifetime of the pty.
     */
    private readEnvTabId (inner: BaseTabComponent, candidatePids: number[]): string | undefined {
        if (this.envTabIdCache.has(inner)) return this.envTabIdCache.get(inner)
        for (const pid of candidatePids) {
            const id = readGlancetermTabIdFromPid(pid)
            if (id) {
                this.envTabIdCache.set(inner, id)
                return id
            }
        }
        return undefined
    }

    private placeholderState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
    ): TabState {
        return {
            outerTab: t.outer,
            innerTab: t.inner,
            title: t.outer.customTitle || t.outer.title || '(tab)',
            aiTool: null,
            aiPid: null,
            cwd: null,
            status: 'no_ai',
            lastActiveMs: null,
            awaitingFirstEvent: false,
        }
    }

    private collectTerminalTabs (): Array<{ outer: BaseTabComponent; inner: BaseTabComponent }> {
        const out: Array<{ outer: BaseTabComponent; inner: BaseTabComponent }> = []
        for (const outer of this.app.tabs) {
            if (isSplit(outer)) {
                const leaves = outer.getAllTabs()
                if (leaves.length === 0) continue
                for (const inner of leaves) {
                    if (isTerminalTab(inner)) out.push({ outer, inner })
                }
            } else if (isTerminalTab(outer)) {
                out.push({ outer, inner: outer })
            }
        }
        return out
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isSplit (t: any): t is { getAllTabs(): BaseTabComponent[] } {
    return t && typeof t.getAllTabs === 'function'
}

function isTerminalTab (t: any): boolean {
    return t && typeof t.setSession === 'function'
}

/**
 * Cross-platform "give me the real command lines for these pids" helper.
 * Tabby's getChildProcesses().command is unreliable for several AI CLIs
 * (notably `claude`, which returns the version string), so we re-read
 * via OS-native APIs and dispatch by platform.
 */
function realCommandsFor (pids: number[]): Map<number, string> {
    if (pids.length === 0) return new Map()
    return process.platform === 'win32'
        ? realCommandsForWindows(pids)
        : realCommandsForPosix(pids)
}

function realCommandsForPosix (pids: number[]): Map<number, string> {
    const out = new Map<number, string>()
    try {
        const psOut = execSync(`ps -p ${pids.join(',')} -o pid=,command=`, {
            encoding: 'utf8',
            timeout: 500,
        })
        for (const line of psOut.split('\n')) {
            const m = line.match(/^\s*(\d+)\s+(.*)$/)
            if (m) out.set(parseInt(m[1], 10), m[2].trim())
        }
    } catch { /* swallow */ }
    return out
}

/**
 * Windows: `ps` doesn't exist. Get-CimInstance Win32_Process is the modern,
 * reliable way to read full command lines. We pass the script via
 * `-EncodedCommand` (base64 UTF-16LE) to dodge cmd.exe quoting hell — the
 * pid list goes through verbatim and the JSON output round-trips cleanly.
 *
 * WQL has no `IN(…)` operator, so we client-side-filter with PowerShell's
 * `-contains`. Win32_Process enumeration is sub-second on typical machines
 * and we only fire one call per tab-monitor tick.
 *
 * Timeout is bumped vs POSIX (2 s vs 500 ms) — PowerShell cold-start adds
 * ~150–250 ms on top of the query itself.
 */
function realCommandsForWindows (pids: number[]): Map<number, string> {
    const out = new Map<number, string>()
    try {
        const script = [
            `$ids = @(${pids.join(',')})`,
            `Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress -Depth 2`,
        ].join('; ')
        const encoded = Buffer.from(script, 'utf16le').toString('base64')
        const psOut = execSync(
            `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
            { encoding: 'utf8', timeout: 2000, windowsHide: true },
        )

        // ConvertTo-Json emits a single object if there's one row, an array
        // otherwise. Normalise both shapes.
        const trimmed = psOut.trim()
        if (!trimmed) return out
        const parsed = JSON.parse(trimmed)
        const list: Array<{ ProcessId?: number; CommandLine?: string }> =
            Array.isArray(parsed) ? parsed : [parsed]
        for (const item of list) {
            if (typeof item.ProcessId === 'number' && typeof item.CommandLine === 'string') {
                out.set(item.ProcessId, item.CommandLine.trim())
            }
        }
    } catch { /* swallow — degraded "no command info" mode is fine */ }
    return out
}

/**
 * Walk up the ppid chain from `pid`, returning at most `maxDepth` ancestors
 * (closest-first). Stops at pid 1 / 0 / failure. Cross-platform.
 *
 * Used by tab detection to find AI tools that sit above the pty's
 * foreground process — e.g. truePID = caffeinate, ppid = claude, ppid =
 * zsh. We want to inspect claude even though it isn't the foreground
 * leader at this moment.
 */
function ancestorsOf (pid: number, maxDepth: number): number[] {
    const out: number[] = []
    let cur = pid
    for (let i = 0; i < maxDepth; i++) {
        const parent = parentPidOf(cur)
        if (!parent || parent <= 1 || parent === cur) break
        out.push(parent)
        cur = parent
    }
    return out
}

function parentPidOf (pid: number): number | null {
    if (process.platform === 'linux') {
        try {
            const data = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8')
            // /proc/<pid>/stat: pid (comm) state ppid …
            // `comm` may contain whitespace/parens, so anchor on the LAST ')'.
            const close = data.lastIndexOf(')')
            if (close < 0) return null
            const rest = data.slice(close + 1).trim().split(/\s+/)
            // After ')' the fields are: state, ppid, …
            const ppid = parseInt(rest[1], 10)
            return Number.isFinite(ppid) ? ppid : null
        } catch { return null }
    }
    if (process.platform === 'darwin') {
        try {
            const out = execSync(`ps -p ${pid} -o ppid=`, { encoding: 'utf8', timeout: 300 })
            const ppid = parseInt(out.trim(), 10)
            return Number.isFinite(ppid) ? ppid : null
        } catch { return null }
    }
    if (process.platform === 'win32') {
        // Single-shot wmic is fast enough for the 6-deep walk; we accept
        // the per-call cost vs setting up a batched PowerShell query that
        // would only pay off for very deep trees.
        try {
            const out = execSync(`wmic process where ProcessId=${pid} get ParentProcessId /format:value`, {
                encoding: 'utf8', timeout: 1500, windowsHide: true,
            })
            const m = out.match(/ParentProcessId=(\d+)/)
            return m ? parseInt(m[1], 10) : null
        } catch { return null }
    }
    return null
}

/**
 * Cross-platform "read GLANCETERM_TAB_ID from this pid's env block."
 * Returns null when:
 *   - the platform reader isn't implemented (Windows fallback today),
 *   - the process exited / we lack permission to read its env,
 *   - the env var isn't set (a non-Tabby-spawned process).
 *
 * Callers must treat null as "fall back to sess.glancetermTabId" rather
 * than as a hard failure.
 */
function readGlancetermTabIdFromPid (pid: number): string | null {
    if (process.platform === 'linux') {
        try {
            const buf = fsSync.readFileSync(`/proc/${pid}/environ`)
            for (const entry of buf.toString('utf8').split('\0')) {
                if (entry.startsWith('GLANCETERM_TAB_ID=')) {
                    return entry.slice('GLANCETERM_TAB_ID='.length)
                }
            }
        } catch { /* swallow */ }
        return null
    }
    if (process.platform === 'darwin') {
        // `ps eww -p <pid> -o command=` prints argv followed by KEY=VAL pairs
        // separated by single spaces. We can't disambiguate spaces in argv
        // from the env-pair separator, but GLANCETERM_TAB_ID values are
        // UUIDv4 — fixed shape — so a focused regex is enough.
        try {
            const out = execSync(`ps eww -p ${pid} -o command=`, {
                encoding: 'utf8',
                timeout: 500,
            })
            const m = out.match(/\bGLANCETERM_TAB_ID=([0-9a-fA-F-]{36})\b/)
            return m ? m[1] : null
        } catch { /* swallow */ }
        return null
    }
    // Windows: reading another process's env block requires NtQueryInformation
    // -Process gymnastics that aren't worth the bundle weight. We fall back
    // to sess.glancetermTabId here; the mismatch only surfaces on
    // session-restore which is rarer on Windows (no native session restore).
    return null
}
