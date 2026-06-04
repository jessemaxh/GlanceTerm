import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { execSync } from 'child_process'

import { AppService, BaseTabComponent } from 'tabby-core'

import { SessionWatcher } from './session-watcher'
import { FINGERPRINTS, GENERIC_FINGERPRINT } from './ai-fingerprints'

const POLL_MS = 1000
/**
 * Bytes from the PTY within this window keep a tab marked "working".
 * Tuned for claude/codex spinners, which tick at least every ~300ms while
 * active (counter increments, frame rotation). 1.5s is comfortably above
 * that, low enough that "stopped" feels instantaneous.
 */
const QUIESCENCE_MS = 1500
/**
 * A bell within this many ms biases ambiguous quiet periods toward
 * "needs_permission" — most AI tools ring on permission prompts.
 */
const BELL_RECENT_MS = 30_000
/**
 * Hide a row briefly after focus to avoid the obvious "you're already
 * looking at it" rotation. Currently unused but reserved for the UI layer.
 */
export const STATE_RETENTION_TICKS = 1
/**
 * How many rendered terminal rows from the bottom of the visible screen
 * to scan for each kind of signal. Live UI lives at the bottom — these
 * windows must be wide enough to cover the tallest legitimate widget
 * (Claude's permission menu is ~6 lines) but narrow enough to exclude
 * already-answered prompts and stale spinner frames sitting in scrollback.
 */
const PERMISSION_TAIL_LINES = 10
const SPINNER_TAIL_LINES = 5

export type TabStatus = 'working' | 'idle' | 'needs_permission' | 'no_ai'

/**
 * AI CLI tools we recognise. Add more by extending AI_PATTERNS below and,
 * if their UI has a distinctive spinner / permission prompt, by adding a
 * `Fingerprint` entry in ai-fingerprints.ts.
 */
export type AiTool =
    | 'claude'
    | 'codex'
    | 'gemini'
    | 'antigravity'
    | 'cursor'
    | 'opencode'
    | 'aider'
    | 'goose'
    | 'crush'
    | 'plandex'
    | 'sweagent'
    | 'amp'
    | 'droid'

/**
 * How we identify each AI CLI by its command line. We match the *real*
 * command line (read via `ps`) because Tabby's getChildProcesses().command
 * sometimes contains the tool's version string instead of the executable
 * name (e.g. "2.1.162" instead of "claude").
 *
 * `\b...(\s|$)` catches the bare name at the end of a path
 * (e.g. `/Users/foo/.local/bin/claude`) and at the start of an argv
 * sequence (e.g. `aider --model gpt-4`).
 *
 * For 2-letter names like Google's `av` (Antigravity CLI) we use
 * `(?:^|\/)` instead of `\b` so we don't false-positive on `avconv`,
 * `avahi-daemon`, `avenv`, etc.
 */
const AI_PATTERNS: Array<{ tool: AiTool; regex: RegExp }> = [
    { tool: 'claude',      regex: /\bclaude(\s|$)/ },
    { tool: 'codex',       regex: /\bcodex(\s|$)/ },
    { tool: 'gemini',      regex: /\bgemini(\s|$)/ },
    { tool: 'antigravity', regex: /(?:^|\/)av(\s|$)/ },
    { tool: 'cursor',      regex: /\bcursor-agent(\s|$)/ },
    { tool: 'opencode',    regex: /\bopencode(\s|$)/ },
    { tool: 'aider',       regex: /\baider(\s|$)/ },
    { tool: 'goose',       regex: /\bgoose(\s|$)/ },
    { tool: 'crush',       regex: /\bcrush(\s|$)/ },
    { tool: 'plandex',     regex: /\bplandex(\s|$)/ },
    { tool: 'sweagent',    regex: /\bsweagent(\s|$)/ },
    { tool: 'amp',         regex: /\bamp(\s|$)/ },
    { tool: 'droid',       regex: /\bdroid(\s|$)/ },
]

export interface TabState {
    /** Outer tab in app.tabs[]. Pass to AppService.selectTab() to focus. */
    outerTab: BaseTabComponent
    /** Inner tab (= outerTab unless it's inside a split). */
    innerTab: BaseTabComponent
    /** What the user sees in the top tab bar — used as our row label. */
    title: string
    /** Resolved once per tab via async getTruePID(); used for trackBy/debug only. */
    shellPid: number | null
    /** Which AI tool we detected running, if any. */
    aiTool: AiTool | null
    /** The descendant AI process pid, if there is one. */
    aiPid: number | null
    /** Final state for the UI to render. */
    status: TabStatus
    /** Best-effort cwd of the shell session. Display only. */
    cwd: string | null
    /** ms since the AI last wrote to the PTY (null if never). */
    lastActiveMs: number | null
    /** Trailing bytes-per-second samples for the sparkline. Undefined when no AI. */
    byteHistory?: number[]
}

interface ChildProcessInfo { pid: number; ppid: number; command: string }

/**
 * Polls Tabby's tab list once per second and produces a TabState for every
 * terminal tab. Activity detection is now entirely terminal-internal:
 * a per-tab `SessionWatcher` listens to the PTY byte stream and the
 * frontend's bell/input events. CPU sampling and Claude jsonl mtime probing
 * (the previous heuristics) are gone — they were noisy across multiple
 * tabs sharing a cwd and couldn't distinguish "waiting on permission"
 * from "idle".
 */
@Injectable({ providedIn: 'root' })
export class TabMonitor implements OnDestroy {
    private subject = new BehaviorSubject<TabState[]>([])
    private timer?: NodeJS.Timeout
    private busy = false
    /** Shell PID cache (getTruePID is async; resolve once per tab). */
    private shellPidCache = new WeakMap<BaseTabComponent, number>()
    /** Per-tab terminal-internal listeners (output / bell / input). */
    private watchers = new WeakMap<BaseTabComponent, SessionWatcher>()
    /**
     * Last status we returned for a tab — used purely as a fallback when
     * the screen-tail parse is inconclusive (e.g. unknown AI tool, or a
     * UI we don't yet have a fingerprint for). Keeps the row from flapping
     * on a single ambiguous frame.
     */
    private lastStatus = new WeakMap<BaseTabComponent, TabStatus>()

    readonly states$: Observable<TabState[]> = this.subject.asObservable()

    constructor (private app: AppService) {
        // Fire immediately, then poll. void-ignore the Promise since we run on a timer.
        void this.tick()
        this.timer = setInterval(() => { void this.tick() }, POLL_MS)
    }

    ngOnDestroy (): void {
        if (this.timer) {
            clearInterval(this.timer)
        }
    }

    private async tick (): Promise<void> {
        if (this.busy) return
        this.busy = true
        try {
            const tabs = this.collectTerminalTabs()
            // Cap concurrency to keep the renderer responsive even with 30+ tabs.
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
            console.error('[ai-sidebar] tick failed:', e)
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
            // Per-tab failure shouldn't kill the whole sidebar.
            // eslint-disable-next-line no-console
            console.error('[ai-sidebar] makeState failed for tab:', t.outer?.title, e)
            return null
        }
    }

    private async makeState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
    ): Promise<TabState | null> {
        const sess: any = (t.inner as any).session
        if (!sess || typeof sess.getChildProcesses !== 'function') {
            // Restored terminal tabs that haven't been focused yet have no
            // session: BaseTerminalTab.initializeSession() only fires from
            // onFrontendReady(), which only runs once the tab is focused.
            // Show them as a `no_ai` placeholder row so they aren't invisible
            // after restart — the user can click to focus and bring them up.
            // collectTerminalTabs() has already filtered out non-terminal
            // tabs (settings, welcome) via a duck-type check on setSession.
            return this.placeholderState(t)
        }

        // 1. Cache shell PID (only needed for display).
        let shellPid = this.shellPidCache.get(t.inner) ?? null
        if (shellPid === null) {
            try {
                const pid = await sess.pty?.getTruePID?.()
                if (typeof pid === 'number' && pid > 0) {
                    shellPid = pid
                    this.shellPidCache.set(t.inner, pid)
                }
            } catch { /* swallow */ }
        }

        // 2. Direct list of child processes from Tabby (same data path Tabby uses).
        //    Tabby's `command` field is unreliable — for `claude` it returns
        //    the *version string* ("2.1.162"), not the executable name. Re-read
        //    the real command line via `ps` using the pids Tabby gave us.
        let children: ChildProcessInfo[] = []
        try {
            children = await sess.getChildProcesses() ?? []
        } catch { /* swallow */ }
        const realCmds = realCommandsFor(children.map(c => c.pid))

        // 3. Walk children, find first matching AI tool.
        let aiTool: AiTool | null = null
        let aiPid: number | null = null
        for (const c of children) {
            const real = realCmds.get(c.pid) ?? c.command
            const match = AI_PATTERNS.find(p => p.regex.test(real))
            if (match) {
                aiTool = match.tool
                aiPid = c.pid
                break
            }
        }

        // 4. cwd: prefer reportedCWD (cheap), fall back to getWorkingDirectory.
        let cwd: string | null = typeof sess.reportedCWD === 'string' && sess.reportedCWD
            ? sess.reportedCWD
            : null
        if (!cwd && typeof sess.getWorkingDirectory === 'function') {
            try { cwd = await sess.getWorkingDirectory() } catch { /* swallow */ }
        }

        // 5. State decision.
        let status: TabStatus
        let lastActiveMs: number | null = null
        if (!aiTool) {
            status = 'no_ai'
            // Clean up watcher if we previously had one for this tab.
            const stale = this.watchers.get(t.inner)
            if (stale) { stale.dispose(); this.watchers.delete(t.inner) }
            this.lastStatus.delete(t.inner)
        } else {
            const watcher = this.ensureWatcher(t.inner)
            watcher.tryAttach() // idempotent — picks up frontend if just attached
            watcher.sample()    // push a bytes/sec sample into the sparkline ring buffer
            const snap = watcher.snapshot()
            const now = Date.now()
            const sinceByte = snap.lastByteAt ? now - snap.lastByteAt : Infinity
            const sinceBell = snap.lastBellAt ? now - snap.lastBellAt : Infinity
            const sinceInput = snap.lastInputAt ? now - snap.lastInputAt : Infinity
            lastActiveMs = snap.lastByteAt ? sinceByte : null

            status = this.classify({
                tool: aiTool,
                sinceByte,
                sinceBell,
                sinceInput,
                screenTail: watcher.readScreenTail(),
                prev: this.lastStatus.get(t.inner),
            })
            this.lastStatus.set(t.inner, status)

            return {
                outerTab: t.outer,
                innerTab: t.inner,
                title: t.outer.customTitle || t.outer.title || `(tab ${shellPid ?? '?'})`,
                shellPid,
                aiTool,
                aiPid,
                cwd,
                status,
                lastActiveMs,
                byteHistory: snap.byteHistory,
            }
        }

        return {
            outerTab: t.outer,
            innerTab: t.inner,
            title: t.outer.customTitle || t.outer.title || `(tab ${shellPid ?? '?'})`,
            shellPid,
            aiTool,
            aiPid,
            cwd,
            status,
            lastActiveMs,
        }
    }

    /**
     * Pure decision function. Order matters:
     *
     *   1. Recent PTY bytes ⇒ working — UNLESS those bytes arrived right after
     *      a keystroke. Terminal echo + AI TUI input-box redraws emit a PTY
     *      byte burst within tens of ms of every keypress, so naive byte-
     *      recency would flap status between working/idle as the user types.
     *      When recent input and recent bytes line up within ECHO_WINDOW_MS,
     *      treat the bytes as input echo, not AI activity.
     *   2. Permission UI on screen ⇒ needs_permission. We check this BEFORE
     *      the spinner regex because some tools show both (e.g. claude
     *      keeps "esc to interrupt" visible while the prompt sits below it
     *      — but during permission the byte stream has been quiet for >1.5s,
     *      so we're in this branch).
     *   3. Spinner glyph on screen ⇒ working. Backstop for tools whose
     *      spinner pauses between bytes longer than QUIESCENCE_MS.
     *   4. Recent bell + no user input since ⇒ needs_permission. Covers
     *      tools whose permission UI we don't have a regex for yet.
     *   5. Default ⇒ idle.
     */
    private classify (input: {
        tool: AiTool
        sinceByte: number
        sinceBell: number
        sinceInput: number
        screenTail: string
        prev: TabStatus | undefined
    }): TabStatus {
        if (input.sinceByte < QUIESCENCE_MS) {
            const ECHO_WINDOW_MS = 250
            const echoOfTyping =
                input.sinceInput < QUIESCENCE_MS &&
                Math.abs(input.sinceInput - input.sinceByte) <= ECHO_WINDOW_MS
            if (!echoOfTyping) return 'working'
        }

        const fp = FINGERPRINTS[input.tool] ?? GENERIC_FINGERPRINT
        const tail = input.screenTail
        if (tail) {
            // Live spinner/permission UI is ALWAYS at the bottom of the
            // visible screen. Restricting these checks to the last few
            // rendered lines prevents stale spinner glyphs and already-
            // answered "[y/n]" prompts in scrollback from re-pinning the
            // tab to the wrong status.
            const lines = tail.split('\n')
            const permissionWindow = lines.slice(-PERMISSION_TAIL_LINES).join('\n')
            const spinnerWindow = lines.slice(-SPINNER_TAIL_LINES).join('\n')
            if (fp.permission.some(r => r.test(permissionWindow))) return 'needs_permission'
            if (fp.spinner.some(r => r.test(spinnerWindow))) return 'working'
        }

        // Bell biases ambiguous quiet → user attention. Only honour the bell
        // if the user hasn't typed since it rang (otherwise they've already
        // responded to whatever wanted their attention).
        if (input.sinceBell < BELL_RECENT_MS && input.sinceInput > input.sinceBell) {
            return 'needs_permission'
        }

        return 'idle'
    }

    private ensureWatcher (inner: BaseTabComponent): SessionWatcher {
        let w = this.watchers.get(inner)
        if (!w) {
            w = new SessionWatcher(inner)
            this.watchers.set(inner, w)
        }
        return w
    }

    private placeholderState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
    ): TabState {
        return {
            outerTab: t.outer,
            innerTab: t.inner,
            title: t.outer.customTitle || t.outer.title || '(tab)',
            shellPid: null,
            aiTool: null,
            aiPid: null,
            cwd: null,
            status: 'no_ai',
            lastActiveMs: null,
        }
    }

    private collectTerminalTabs (): Array<{ outer: BaseTabComponent; inner: BaseTabComponent }> {
        const out: Array<{ outer: BaseTabComponent; inner: BaseTabComponent }> = []
        for (const outer of this.app.tabs) {
            if (isSplit(outer)) {
                const leaves = outer.getAllTabs()
                if (leaves.length === 0) {
                    continue // restored placeholder, no real terminal yet
                }
                for (const inner of leaves) {
                    if (isTerminalTab(inner)) {
                        out.push({ outer, inner })
                    }
                }
            } else if (isTerminalTab(outer)) {
                out.push({ outer, inner: outer })
            }
        }
        return out
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Duck-typed split detection. We can't use `instanceof SplitTabComponent`:
 * plugin and Tabby load tabby-core via separate module realms, so the class
 * reference our `import` resolves to is NOT the same constructor that Tabby
 * actually constructed the tab with → `instanceof` is always false. Checking
 * for the public `getAllTabs()` method is the reliable substitute.
 */
function isSplit (t: any): t is { getAllTabs(): BaseTabComponent[] } {
    return t && typeof t.getAllTabs === 'function'
}

/**
 * Duck-typed terminal-tab detection. Same module-realm issue as isSplit
 * blocks `instanceof BaseTerminalTabComponent`. setSession() is the cleanest
 * shibboleth — it's defined on BaseTerminalTabComponent and absent on
 * WelcomeTab / settings tabs / other non-terminal panels. Crucially, this
 * check passes for restored terminal tabs whose session has NOT been
 * initialized yet (they only initialize on first focus), so those tabs
 * still appear in the sidebar after a restart.
 */
function isTerminalTab (t: any): boolean {
    return t && typeof t.setSession === 'function'
}

/**
 * One `ps` call to get the real command line for a batch of pids.
 * Used to work around Tabby's getChildProcesses returning bogus `command`
 * values (e.g. the version string `2.1.162` for the `claude` CLI).
 */
function realCommandsFor (pids: number[]): Map<number, string> {
    const out = new Map<number, string>()
    if (pids.length === 0) return out
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
