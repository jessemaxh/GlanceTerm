/**
 * Layer 3 E2E harness — drives a running GlanceTerm dev instance via
 * Chrome DevTools Protocol over the remote-debugging port `./dev.sh`
 * always exposes on 9222.
 *
 * What this harness does NOT do (yet):
 *   - Spawn `./dev.sh` itself. Tests assume it's already running; a
 *     suite that wants self-contained CI execution should add a
 *     setup hook that calls `spawn('./dev.sh', ...)` and polls for
 *     CDP availability before each run.
 *   - Cross-tab orchestration. The first cut treats the renderer as
 *     a single page; future expansions can use Target.attachToTarget
 *     to drive the screenshot overlay window, the settings modal in
 *     a separate webContents, etc.
 *
 * What it DOES expose: a vitest-friendly connect/disconnect lifecycle,
 * a `evaluate()` for running arbitrary JS in the renderer, structured
 * helpers (`click`, `pressKey`, `getSidebarRows`), and a `waitFor`
 * loop with default 2 s timeout so flaky CD timing doesn't bleed into
 * each spec.
 *
 * Why over chrome-remote-interface rather than raw WebSocket: the
 * library handles the /json/list target enumeration, the framing,
 * promise-ifying RPC, and reconnection — none of which add value to
 * write by hand for our needs.
 */

import CDP from 'chrome-remote-interface'

/**
 * Sidebar row as JSON, returned from getSidebarRows(). Shape mirrors
 * the visible columns: status (working / idle / done / needs_permission
 * / no_ai), the label under the dot, the displayed cwd, and whether
 * the row is the currently-active tab. New fields can be added as
 * spec needs grow — they're computed in renderer-side JS per call so
 * there's no schema to migrate.
 */
export interface SidebarRowState {
    status: string | null
    title: string
    statusLabel: string
    cwd: string | null
    pinned: boolean
    active: boolean
    subagentCount: number
}

export interface SidebarState {
    rows: SidebarRowState[]
    counts: {
        working: number
        idle: number
        done: number
        needsYou: number
    }
}

export interface WaitOptions {
    timeoutMs?: number
    intervalMs?: number
    message?: string
}

const DEFAULT_PORT = 9222

/**
 * One-shot lifecycle wrapper. Open with `await harness.connect()`,
 * tear down with `await harness.disconnect()`. Reusable across multiple
 * tests but a fresh instance per `describe` block keeps state clean.
 */
export class E2EHarness {
    private client: any = null
    readonly port: number

    constructor (port: number = DEFAULT_PORT) {
        this.port = port
    }

    /**
     * Attach to the renderer. Throws if no target is listening on the
     * configured port — the error message points at the most likely
     * cause so test runs in CI without dev.sh up fail loudly with an
     * actionable diagnosis instead of a generic "ECONNREFUSED".
     */
    async connect (): Promise<void> {
        try {
            // List targets first so we can prefer the main renderer over
            // the overlay/screenshot windows that share the same port.
            // Filter for the main app page (its title contains
            // "GlanceTerm" or url starts with file://…/app/dist/index.html);
            // fall back to the first webContents target if the heuristic
            // misses on a future Tabby version.
            const targets = await CDP.List({ port: this.port })
            const page = targets.find(t =>
                t.type === 'page' && (
                    (t.title || '').toLowerCase().includes('glanceterm')
                    || (t.url || '').includes('/app/dist/index.html')
                ),
            ) ?? targets.find(t => t.type === 'page') ?? targets[0]
            if (!page) {
                throw new Error('no CDP target found')
            }
            this.client = await CDP({ port: this.port, target: page })
            await this.client.Runtime.enable()
            await this.client.DOM.enable()
        } catch (e: any) {
            const code = e?.code ?? e?.message ?? ''
            if (String(code).includes('ECONNREFUSED') || String(code).includes('ECONNRESET')) {
                throw new Error(
                    `Cannot connect to GlanceTerm dev on port ${this.port}. ` +
                    'Start it with `./dev.sh` from the repo root, then re-run the test. ' +
                    'The dev script always exposes --remote-debugging-port=9222.',
                )
            }
            throw e
        }
    }

    async disconnect (): Promise<void> {
        if (this.client) {
            await this.client.close()
            this.client = null
        }
    }

    /**
     * Run an expression in the renderer's main world and return the
     * deserialised result. Use `await` inside the expression for async
     * work — the harness awaits the promise on this side. Errors and
     * `console.log` from inside the expression surface in the renderer's
     * devtools (visible via dev.sh's stdout), not here.
     *
     * Concrete shape: pass a single arrow expression body, e.g.
     *   harness.evaluate('document.querySelectorAll(".row").length')
     *   harness.evaluate('(async () => { ... return value })()')
     */
    async evaluate<T = unknown> (expression: string): Promise<T> {
        if (!this.client) throw new Error('harness not connected; call connect() first')
        const result = await this.client.Runtime.evaluate({
            expression,
            returnByValue: true,
            awaitPromise: true,
        })
        if (result.exceptionDetails) {
            throw new Error(
                `renderer threw: ${result.exceptionDetails.text}\n` +
                `  expression: ${expression.slice(0, 200)}${expression.length > 200 ? '…' : ''}`,
            )
        }
        return result.result.value as T
    }

    /**
     * Click the first element matching the selector. Uses a synthesized
     * MouseEvent inside the renderer rather than Input.dispatchMouseEvent
     * so we don't need to compute viewport-relative coordinates and so
     * Angular's NgZone runs the resulting CD pass (Input.dispatch fires
     * native events at the OS level which Tabby's listeners may not see
     * the same way).
     */
    async click (selector: string): Promise<void> {
        const ok = await this.evaluate<boolean>(`
            (() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return false;
                el.click();
                return true;
            })()
        `)
        if (!ok) {
            throw new Error(`no element matches selector ${JSON.stringify(selector)}`)
        }
    }

    /**
     * Dispatch a single keyboard event on document.activeElement (or
     * document if nothing is focused). `key` follows the
     * KeyboardEvent.key spec: "Escape", "Enter", "ArrowDown", letters
     * uppercase for shifted form.
     */
    async pressKey (key: string): Promise<void> {
        await this.evaluate(`
            (() => {
                const target = document.activeElement ?? document;
                for (const type of ['keydown', 'keyup']) {
                    target.dispatchEvent(new KeyboardEvent(type, { key: ${JSON.stringify(key)}, bubbles: true }));
                }
                return true;
            })()
        `)
    }

    /**
     * Snapshot the sidebar's row state plus the pill counts. Runs once
     * per call; if the test needs to observe a transition, wrap the
     * call in waitFor() and read the snapshot again after the event.
     */
    async getSidebarState (): Promise<SidebarState> {
        return await this.evaluate<SidebarState>(`
            (() => {
                const rows = Array.from(document.querySelectorAll('.sb-list .row')).map(el => {
                    const num = (s) => parseInt(s, 10) || 0;
                    const txt = (sel) => el.querySelector(sel)?.textContent?.trim() ?? '';
                    const sub = txt('.micro.accent');
                    return {
                        status: el.getAttribute('data-status'),
                        title: txt('.primary'),
                        statusLabel: txt('.status'),
                        cwd: el.getAttribute('title') || null,
                        pinned: el.classList.contains('pinned'),
                        active: el.classList.contains('active'),
                        subagentCount: num(sub.match(/^\\d+/)?.[0] || '0'),
                    };
                });
                const footerText = (cls) => document.querySelector('.sb-footer .stat.' + cls)?.textContent?.trim() ?? '';
                const num = (cls) => parseInt((footerText(cls).match(/\\d+/) || ['0'])[0], 10);
                return {
                    rows,
                    counts: {
                        working: num('work'),
                        idle: num('idle'),
                        done: num('done-stat'),
                        needsYou: num('attn-stat'),
                    },
                };
            })()
        `)
    }

    /**
     * Poll until `predicate` returns truthy. Default 2 s budget with
     * 50 ms ticks — enough for one tab-monitor poll (1.5 s) plus
     * Angular CD on top, tight enough that a real failure surfaces in
     * a few seconds rather than minutes.
     */
    async waitFor<T> (predicate: () => Promise<T> | T, opts: WaitOptions = {}): Promise<T> {
        const timeoutMs = opts.timeoutMs ?? 2000
        const intervalMs = opts.intervalMs ?? 50
        const start = Date.now()
        let lastValue: T | undefined
        while (Date.now() - start < timeoutMs) {
            lastValue = await predicate()
            if (lastValue) return lastValue
            await new Promise(r => setTimeout(r, intervalMs))
        }
        const reason = opts.message ?? 'predicate never returned truthy'
        throw new Error(`waitFor timed out after ${timeoutMs}ms — ${reason}`)
    }

    /**
     * True when an element matching the selector exists and is
     * visible (offsetParent != null skips display:none rules).
     */
    async isVisible (selector: string): Promise<boolean> {
        return await this.evaluate<boolean>(`
            (() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                return !!(el && el.offsetParent !== null);
            })()
        `)
    }
}
