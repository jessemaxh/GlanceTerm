import { Component, OnDestroy, OnInit } from '@angular/core'
import { Subscription } from 'rxjs'
import * as os from 'os'

import { AppService, MenuItemOptions, PlatformService } from 'tabby-core'

import { TabMonitor, TabState } from './tab-monitor'
import { UnreadService } from './unread.service'

type FilterId = 'all' | 'needs_permission' | 'working' | 'idle'

/**
 * The actual sidebar content. NOT a BaseTabComponent — this is a plain
 * Angular component that the host (Tabby's appRoot) instantiates inside a
 * `.sidebar-slot` via SidebarProvider, NOT inside a tab.
 *
 * Lives alongside the tab body and stays visible regardless of which
 * terminal tab is active. Click a row → AppService.selectTab() focuses that
 * terminal tab.
 *
 * Visual system: GlanceTerm "Restrained" direction — single warm accent
 * on a dark surface, status conveyed by colour + shape + word (color-blind
 * safe), and blue reserved for the active row so it always reads as
 * "you are here."
 */
@Component({
    selector: 'ai-sidebar',
    template: `
        <div class="sb">
            <div class="sb-header">
                <span class="h-title">AI Tabs</span>
            </div>

            <div class="sb-filters" *ngIf="states.length > 0">
                <button type="button"
                        *ngFor="let f of FILTERS"
                        class="pill"
                        [class.active]="filterMode === f.id"
                        [attr.data-id]="f.id"
                        [attr.aria-pressed]="filterMode === f.id"
                        (click)="setFilter(f.id)">
                    <span class="lbl">{{ f.label }}</span>
                    <span class="c">{{ countFor(f.id) }}</span>
                </button>
            </div>

            <div *ngIf="states.length === 0" class="sb-empty">
                <!-- Empty-state glyph: three stacked "tab rows" representing
                     what the sidebar will fill with. The bottom row has a
                     filled accent dot to hint "this is where status lights
                     up". -->
                <svg class="emptyglyph" width="82" height="58" viewBox="0 0 82 58" fill="none" aria-hidden="true">
                    <rect x="1" y="1"  width="80" height="14" rx="3"
                          stroke="var(--gt-text-faint)" stroke-width="1.2" opacity="0.45" fill="none"/>
                    <rect x="1" y="22" width="80" height="14" rx="3"
                          stroke="var(--gt-text-faint)" stroke-width="1.2" opacity="0.55" fill="none"/>
                    <rect x="1" y="43" width="80" height="14" rx="3"
                          stroke="var(--gt-accent)" stroke-width="1.3" fill="var(--gt-accent-soft)"/>
                    <circle cx="11" cy="50" r="3" fill="var(--gt-accent)"/>
                </svg>
                <div class="et">Nothing to glance at yet</div>
                <div class="es">No AI agents running. Open a shell, start one, and it'll light up here.</div>
            </div>

            <div *ngIf="states.length > 0 && visibleStates.length === 0" class="sb-empty filtered">
                <div class="et">No {{ filterLabel() }}</div>
                <div class="es">Tap "All" to see every tab.</div>
            </div>

            <div *ngIf="visibleStates.length > 0" class="sb-list">
                <div *ngFor="let s of visibleStates; trackBy: trackByTab"
                     class="row"
                     [attr.data-status]="s.status"
                     [class.active]="isActive(s)"
                     [attr.aria-label]="ariaLabel(s)"
                     [attr.title]="s.cwd || s.title"
                     role="button"
                     (click)="onSelect(s)"
                     (contextmenu)="onContextMenu(s, $event)">
                    <div class="num" aria-hidden="true">{{ tabIndex(s) }}</div>
                    <div class="rail">
                        <span class="dot" [attr.data-status]="s.status" aria-hidden="true"></span>
                    </div>
                    <div class="body">
                        <div class="line1">
                            <span class="ttl">{{ s.title }}</span>
                            <span *ngIf="s.status === 'needs_permission'" class="attn" aria-hidden="true"></span>
                            <span *ngIf="isUnread(s)" class="unread" title="Agent finished — click to dismiss" aria-label="Unread: agent finished"></span>
                        </div>
                        <div class="line2">
                            <span *ngIf="s.aiTool" class="tag" [attr.data-tool]="s.aiTool">{{ toolTag(s.aiTool) }}</span>
                            <span class="status" [attr.data-status]="s.status">{{ statusLabel(s) }}</span>
                        </div>
                        <div *ngIf="s.cwd && s.status !== 'needs_permission'" class="line3">
                            <span class="cwd" [attr.title]="s.cwd">{{ displayCwd(s.cwd) }}</span>
                        </div>
                    </div>
                    <div class="meta">
                        <span class="age" *ngIf="s.status !== 'no_ai' && s.lastActiveMs !== null">{{ ageStr(s.lastActiveMs) }}</span>
                    </div>
                </div>
            </div>

            <div *ngIf="visibleStates.length > 0" class="sb-footer">
                <span class="stat work"><i></i>{{ countWorking }}<span class="lbl"> working</span></span>
                <span class="stat idle"><i></i>{{ countIdle }}<span class="lbl"> idle</span></span>
                <span *ngIf="countAttn > 0" class="stat attn-stat"><i></i>{{ countAttn }}<span class="lbl"> need you</span></span>
            </div>
        </div>
    `,
    styles: [`
        :host {
            /* GlanceTerm tokens — dark direction. Light theme not wired (Tabby is dark-first). */
            --gt-accent:        #FFAA55;
            --gt-accent-deep:   #FF7A3D;
            --gt-accent-soft:   rgba(255, 170, 85, 0.14);

            --gt-st-working:      #4CAF50;
            --gt-st-working-glow: rgba(76, 175, 80, 0.45);
            --gt-st-idle:         #8A9099;
            --gt-st-ready:        #5B9EF5;
            --gt-st-active:       #5B9EF5;
            --gt-st-active-bg:    rgba(91, 158, 245, 0.12);
            --gt-st-perm:         #FF9F45;

            --gt-surface-1: var(--bs-body-bg, #1C1F23);
            --gt-surface-2: rgba(255, 255, 255, 0.04);
            --gt-surface-3: rgba(255, 255, 255, 0.07);

            --gt-border:    rgba(255, 255, 255, 0.07);
            --gt-text:      var(--bs-body-color, #E7E9EC);
            --gt-text-dim:  #9BA1A9;
            --gt-text-faint:#6B7178;

            --gt-mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;

            display: block;
            width: 100%;
            height: 100%;
            background: var(--gt-surface-1);
            color: var(--gt-text);
            overflow: hidden;
            font-size: 15px;
            -webkit-font-smoothing: antialiased;
        }

        .sb {
            display: flex;
            flex-direction: column;
            height: 100%;
            user-select: none;
            -webkit-user-select: none;
        }

        /* ---- header ---- */
        .sb-header {
            display: flex;
            align-items: center;
            gap: 9px;
            padding: 13px 14px 11px;
        }
        .sb-header .h-title {
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.13em;
            text-transform: uppercase;
            color: var(--gt-text-faint);
            white-space: nowrap;
        }
        /* ---- empty state (C2) ---- */
        .sb-empty {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 16px;
            padding: 30px 24px;
            text-align: center;
        }
        .sb-empty.filtered {
            flex: 0 0 auto;
            padding: 28px 18px;
            gap: 6px;
        }
        .sb-empty .comb { opacity: 0.8; }
        .sb-empty .et {
            font-size: 13px;
            font-weight: 600;
            color: var(--gt-text-dim);
        }
        .sb-empty .es {
            font-size: 12px;
            color: var(--gt-text-faint);
            line-height: 1.5;
            max-width: 190px;
        }

        /* ---- filter pills (v0.2-2) ---- */
        .sb-filters {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            padding: 0 12px 10px;
        }
        .pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 99px;
            border: 1px solid var(--gt-border);
            background: transparent;
            color: var(--gt-text-dim);
            font: inherit;
            font-size: 11.5px;
            font-weight: 500;
            line-height: 1.2;
            cursor: pointer;
            transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
        }
        .pill:hover {
            background: var(--gt-surface-2);
            color: var(--gt-text);
            border-color: rgba(255,255,255,0.14);
        }
        .pill.active {
            background: var(--gt-accent-soft);
            border-color: rgba(255, 170, 85, 0.55);
            color: var(--gt-accent);
        }
        .pill[data-id="needs_permission"].active {
            background: rgba(255, 159, 69, 0.18);
            border-color: rgba(255, 159, 69, 0.6);
            color: var(--gt-st-perm);
        }
        .pill .c {
            font-family: var(--gt-mono);
            font-size: 10px;
            font-weight: 600;
            opacity: 0.85;
            font-variant-numeric: tabular-nums;
        }
        .pill.active .c { opacity: 1; }

        /* ---- list / row ---- */
        .sb-list {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 2px 8px 10px;
            min-height: 0;
        }
        .sb-list::-webkit-scrollbar { width: 9px; }
        .sb-list::-webkit-scrollbar-thumb {
            background: var(--gt-border);
            border-radius: 99px;
            border: 2px solid transparent;
            background-clip: padding-box;
        }
        .sb-list::-webkit-scrollbar-thumb:hover {
            background: rgba(255,255,255,0.16);
            background-clip: padding-box;
        }

        .row {
            position: relative;
            display: grid;
            grid-template-columns: 22px 14px minmax(0, 1fr) auto;
            align-items: center;
            gap: 11px;
            padding: 11px 12px 11px 10px;
            border-radius: 9px;
            cursor: pointer;
            transition: background-color 0.13s ease;
            margin-bottom: 2px;
        }

        /* ---- tab index (matches the numeric prefix on Tabby's top tab bar) ---- */
        .num {
            font-family: var(--gt-mono);
            font-size: 13px;
            font-weight: 500;
            color: var(--gt-text-faint);
            text-align: right;
            font-variant-numeric: tabular-nums;
            line-height: 1;
        }
        .row.active .num { color: var(--gt-st-active); font-weight: 600; }
        .row:hover { background: var(--gt-surface-2); }

        .row[data-status="no_ai"] { opacity: 0.52; }
        .row[data-status="no_ai"]:hover { opacity: 0.75; }

        /* needs_permission rail — inset shadow always; orange wash only when not active
           so the blue "you are here" surface still wins on an active perm row. */
        .row[data-status="needs_permission"] {
            box-shadow: inset 0 0 0 1px rgba(255, 159, 69, 0.35);
        }
        .row[data-status="needs_permission"]:not(.active) {
            background: rgba(255, 159, 69, 0.07);
        }

        .row.active { background: var(--gt-st-active-bg); }
        .row.active::before {
            content: "";
            position: absolute;
            left: 0;
            top: 6px;
            bottom: 6px;
            width: 2.5px;
            border-radius: 0 3px 3px 0;
            background: var(--gt-st-active);
        }
        .row.active .ttl { color: var(--gt-text); font-weight: 600; }

        /* ---- status rail dot ---- */
        .rail {
            display: grid;
            place-items: center;
            align-self: stretch;
        }
        .dot {
            width: 11px;
            height: 11px;
            border-radius: 99px;
            position: relative;
            display: block;
        }
        .dot[data-status="working"] {
            background: var(--gt-st-working);
            box-shadow: 0 0 0 0 var(--gt-st-working-glow);
            animation: ht-pulse 1.7s ease-out infinite;
        }
        .dot[data-status="idle"]             { background: var(--gt-st-idle); }
        .dot[data-status="no_ai"] {
            background: transparent;
            box-shadow: inset 0 0 0 1.5px var(--gt-text-faint);
        }
        .dot[data-status="needs_permission"] { background: var(--gt-st-perm); }

        @keyframes ht-pulse {
            0%   { box-shadow: 0 0 0 0 var(--gt-st-working-glow); }
            70%  { box-shadow: 0 0 0 6px rgba(76, 175, 80, 0); }
            100% { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0); }
        }

        /* ---- body ---- */
        .body { min-width: 0; }
        .line1 {
            display: flex;
            align-items: center;
            gap: 7px;
            min-width: 0;
        }
        .ttl {
            font-size: 15px;
            font-weight: 500;
            color: var(--gt-text);
            overflow-wrap: anywhere;
            word-break: break-word;
            line-height: 1.3;
            flex: 1 1 auto;
            min-width: 0;
        }
        .attn {
            width: 6px;
            height: 6px;
            border-radius: 99px;
            background: var(--gt-st-perm);
            flex: none;
            animation: ht-attn 1.2s ease-in-out infinite;
        }
        @keyframes ht-attn { 50% { opacity: 0.25; } }

        /* Unread "agent finished" red dot. Distinct from .attn (which means
           "needs you now" — orange + pulsing): unread is a quieter red,
           non-animated, larger so it reads as a notification badge rather
           than a state-change indicator. Cleared when the row is focused. */
        .unread {
            width: 8px;
            height: 8px;
            border-radius: 99px;
            background: #FF5252;
            box-shadow: 0 0 0 1.5px var(--gt-surface-1);
            flex: none;
        }

        .line2 {
            display: flex;
            align-items: center;
            gap: 7px;
            margin-top: 4px;
            min-width: 0;
        }
        .status {
            font-size: 13px;
            font-weight: 500;
            white-space: nowrap;
            flex: none;
        }
        .status[data-status="working"]          { color: var(--gt-st-working); }
        .status[data-status="idle"]             { color: var(--gt-st-ready); }
        .status[data-status="no_ai"]            { color: var(--gt-text-faint); }
        .status[data-status="needs_permission"] { color: var(--gt-st-perm); font-weight: 600; }

        .line3 {
            display: flex;
            align-items: flex-start;
            margin-top: 3px;
            min-width: 0;
        }
        /* Up to 3 lines; long paths are pre-truncated with a middle '…' in JS
           (displayCwd) so the END of the path — usually the most specific
           directory — always stays visible. Hover the row to see the full
           path via the [title] attribute. */
        .cwd {
            font-family: var(--gt-mono);
            font-size: 12px;
            line-height: 1.35;
            color: var(--gt-text-faint);
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 3;
            overflow: hidden;
            overflow-wrap: anywhere;
            word-break: break-all;
            min-width: 0;
            flex: 1 1 auto;
        }

        /* ---- meta column ---- */
        .meta {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 5px;
            align-self: flex-start;
            padding-top: 1px;
        }
        .age {
            font-family: var(--gt-mono);
            font-size: 12px;
            color: var(--gt-text-faint);
        }

        /* ---- tool tag ---- */
        .tag {
            font-family: var(--gt-mono);
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.04em;
            padding: 3px 6px;
            border-radius: 5px;
            line-height: 1;
            white-space: nowrap;
            flex: none;
        }
        /* Palette: claude moved off honey (brand), aider moved off red (error). */
        .tag[data-tool="claude"]      { color: #E879A6; background: rgba(232, 121, 166, 0.16); }
        .tag[data-tool="codex"]       { color: #5BC8E5; background: rgba(91, 200, 229, 0.16); }
        .tag[data-tool="gemini"]      { color: #6FA0F2; background: rgba(111, 160, 242, 0.16); }
        .tag[data-tool="opencode"]    { color: #B794F4; background: rgba(183, 148, 244, 0.16); }
        .tag[data-tool="aider"]       { color: #3FC9B0; background: rgba(63, 201, 176, 0.16); }
        .tag[data-tool="goose"]       { color: #8ED1A4; background: rgba(142, 209, 164, 0.16); }

        /* ---- footer (aggregate stats) ---- */
        .sb-footer {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 9px 14px;
            border-top: 1px solid var(--gt-border);
            font-family: var(--gt-mono);
            font-size: 10.5px;
            color: var(--gt-text-dim);
        }
        .sb-footer .stat {
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .sb-footer .stat i {
            width: 7px;
            height: 7px;
            border-radius: 99px;
            display: block;
        }
        .sb-footer .stat.work          { color: var(--gt-st-working); }
        .sb-footer .stat.work i        { background: var(--gt-st-working); }
        .sb-footer .stat.idle          { color: var(--gt-text-dim); }
        .sb-footer .stat.idle i        { background: var(--gt-st-idle); }
        .sb-footer .stat.attn-stat     { color: var(--gt-st-perm); }
        .sb-footer .stat.attn-stat i   { background: var(--gt-st-perm); }

        @media (prefers-reduced-motion: reduce) {
            .dot[data-status="working"],
            .attn { animation: none !important; }
        }
    `],
})
export class AiSidebarComponent implements OnInit, OnDestroy {
    states: TabState[] = []
    filterMode: FilterId = 'all'
    /** Pill definitions — order is render order, left → right. */
    readonly FILTERS: ReadonlyArray<{ id: FilterId; label: string }> = [
        { id: 'all',              label: 'All' },
        { id: 'needs_permission', label: 'Needs You' },
        { id: 'working',          label: 'Working' },
        { id: 'idle',             label: 'Idle' },
    ]
    private sub?: Subscription
    private home = os.homedir()

    constructor (
        public app: AppService,
        public monitor: TabMonitor,
        private platform: PlatformService,
        private unread: UnreadService,
    ) {}

    /**
     * True when the tab transitioned working→ready and the user hasn't
     * focused it yet. Drives the red dot. Clearing happens automatically in
     * UnreadService when the user clicks the row (via activeTabChange$).
     */
    isUnread (s: TabState): boolean {
        return this.unread.isUnread(s.innerTab)
    }

    ngOnInit (): void {
        this.sub = this.monitor.states$.subscribe(s => {
            this.states = s
        })
    }

    ngOnDestroy (): void {
        this.sub?.unsubscribe()
    }

    /**
     * Tabs we render, sorted by attention priority so the rows the user is
     * most likely to act on bubble to the top.
     *
     *   1. needs_permission — block-on-user, must act now
     *   2. working          — actively producing output
     *   3. idle             — AI running but waiting on you
     *   4. no_ai            — plain shell, low signal
     *
     * Within a priority bucket we fall back to Tabby's own top-bar tab order.
     * That's STABLE — using `lastActiveMs` as a tiebreaker would shuffle the
     * list on every poll as the "working" rows tick, which reads as flicker.
     */
    get visibleStates (): TabState[] {
        const rank: Record<TabState['status'], number> = {
            needs_permission: 0,
            working:          1,
            idle:             2,
            no_ai:            3,
        }
        const tabIdx = (s: TabState): number => {
            const i = this.app.tabs.indexOf(s.outerTab)
            return i < 0 ? Number.MAX_SAFE_INTEGER : i
        }
        const filtered = this.filterMode === 'all'
            ? this.states
            : this.states.filter(s => s.status === this.filterMode)
        return [...filtered].sort((a, b) => {
            const dr = (rank[a.status] ?? 99) - (rank[b.status] ?? 99)
            return dr !== 0 ? dr : tabIdx(a) - tabIdx(b)
        })
    }

    /** Set or toggle the filter. Clicking the active pill resets to 'all'. */
    setFilter (id: FilterId): void {
        this.filterMode = this.filterMode === id && id !== 'all' ? 'all' : id
    }

    /** Pill counter — `All` counts every tab; the others count their bucket. */
    countFor (id: FilterId): number {
        if (id === 'all') return this.states.length
        return this.states.filter(s => s.status === id).length
    }

    filterLabel (): string {
        switch (this.filterMode) {
            case 'needs_permission': return 'tabs need you right now'
            case 'working':          return 'working tabs'
            case 'idle':             return 'idle tabs'
            default:                 return 'tabs'
        }
    }

    get countWorking (): number {
        return this.states.filter(s => s.status === 'working').length
    }

    get countIdle (): number {
        return this.states.filter(s => s.status === 'idle').length
    }

    get countAttn (): number {
        return this.states.filter(s => s.status === 'needs_permission').length
    }

    trackByTab = (_: number, s: TabState): any => s.innerTab

    /**
     * 1-based position of the row's outer tab in Tabby's top tab bar — same
     * number Tabby renders on the tab and binds to its switch hotkeys
     * (Cmd/Ctrl+N). Split leaves share the outer tab's number; that matches
     * the hotkey behavior (Cmd+3 selects the split, then focus the desired
     * pane). Empty string if the outer tab isn't found (race during close).
     */
    tabIndex (s: TabState): string {
        const i = this.app.tabs.indexOf(s.outerTab)
        return i < 0 ? '' : String(i + 1)
    }

    onSelect (s: TabState): void {
        this.app.selectTab(s.outerTab)
        // If the matched leaf is inside a split, also focus that specific pane.
        if (s.outerTab !== s.innerTab && typeof (s.outerTab as any).focus === 'function') {
            try {
                (s.outerTab as any).focus(s.innerTab)
            } catch { /* best-effort */ }
        }
    }

    /**
     * "You are here" check. With splits open, `app.activeTab` is the outer
     * SplitTabComponent — every leaf inside it would match a naive ===.
     * Use SplitTabComponent.getFocusedTab() to pick the one focused leaf;
     * fall back to "outer match wins" if the API isn't available.
     */
    isActive (s: TabState): boolean {
        if (s.outerTab !== this.app.activeTab) return false
        if (s.outerTab === s.innerTab) return true
        const split = s.outerTab as any
        try {
            if (typeof split.getFocusedTab === 'function') {
                const focused = split.getFocusedTab()
                return focused == null || focused === s.innerTab
            }
        } catch { /* fall through */ }
        return true
    }

    statusLabel (s: TabState): string {
        switch (s.status) {
            case 'working':          return 'working'
            case 'needs_permission': return 'needs you'
            case 'idle':             return 'ready'
            case 'no_ai':            return 'shell'
            default:                 return s.status
        }
    }

    ariaLabel (s: TabState): string {
        const a11y: Record<string, string> = {
            working: 'Working — AI responding',
            idle: 'Idle — waiting for you',
            needs_permission: 'Needs permission — decide now',
            no_ai: 'Plain shell, no AI',
        }
        return `${s.title} — ${a11y[s.status] || s.status}`
    }

    /** 3-letter uppercase tag matching the GlanceTerm design language. */
    toolTag (tool: string | null): string {
        if (!tool) return ''
        const tags: Record<string, string> = {
            claude:   'CLA',
            codex:    'CDX',
            gemini:   'GEM',
            opencode: 'OPC',
            aider:    'AID',
            goose:    'GSE',
        }
        return tags[tool] || tool.slice(0, 3).toUpperCase()
    }

    ageStr (ms: number | null): string {
        if (ms === null || isNaN(ms)) return ''
        const s = Math.floor(ms / 1000)
        if (s < 60) return `${s}s`
        const m = Math.floor(s / 60)
        if (m < 60) return `${m}m`
        const h = Math.floor(m / 60)
        if (h < 24) return `${h}h`
        return `${Math.floor(h / 24)}d`
    }

    /**
     * Compress `$HOME` to `~`. Critically: only replace when the home path
     * is followed by a path separator (or is the entire string), so that a
     * sibling user's home — e.g. `/Users/foo-archive` when HOME is
     * `/Users/foo` — does NOT get mangled to `~-archive`. Checks both `/`
     * and `\` so this also stays correct if Tabby ever feeds us a
     * backslash-separated cwd on Windows.
     */
    compressHome (p: string | null): string {
        if (!p) return ''
        if (!this.home) return p
        if (p === this.home) return '~'
        if (!p.startsWith(this.home)) return p
        const next = p[this.home.length]
        if (next !== '/' && next !== '\\') return p
        return '~' + p.slice(this.home.length)
    }

    /**
     * Render-ready cwd: `~`-compressed, and for very long paths, middle-
     * truncated with a single `…` so the END (the most specific directory)
     * always stays visible. CSS line-clamps to 3 lines; this threshold is
     * a conservative upper bound for what fits — picked for the typical
     * sidebar width (~300px) at 12px JetBrains-Mono-ish glyph width. The
     * full path is always available via the row's [title] tooltip.
     */
    displayCwd (p: string | null): string {
        const s = this.compressHome(p)
        const MAX = 90
        if (s.length <= MAX) return s
        const ELLIPSIS = '…'
        const keep = MAX - ELLIPSIS.length
        // Bias toward keeping the END — the trailing directory is what tells
        // the user where this shell actually IS.
        const tail = Math.ceil(keep * 0.7)
        const head = keep - tail
        return s.slice(0, head) + ELLIPSIS + s.slice(s.length - tail)
    }

    /**
     * Tab-row right-click menu. Mirrors the most useful subset of Tabby's
     * own top-bar tab menu, scoped to what an AI-sidebar user typically
     * wants on a row: rename, copy the path, jump to it in Finder, or
     * spawn another shell at the same cwd.
     */
    async onContextMenu (s: TabState, ev: MouseEvent): Promise<void> {
        ev.preventDefault()
        ev.stopPropagation()
        const cwd = s.cwd ?? null
        const items: MenuItemOptions[] = [
            {
                label: 'Rename tab title…',
                click: () => this.app.renameTab(s.outerTab),
            },
            {
                label: 'Copy working directory',
                enabled: !!cwd,
                click: () => {
                    if (cwd) {
                        this.platform.setClipboard({ text: cwd })
                    }
                },
            },
            { type: 'separator' },
            {
                label: 'Reveal in Finder',
                enabled: !!cwd,
                click: () => {
                    if (cwd) {
                        try {
                            this.platform.openPath(cwd)
                        } catch { /* base PlatformService throws; safe to ignore */ }
                    }
                },
            },
            {
                label: 'New tab in this directory',
                click: () => {
                    void this.app.duplicateTab(s.outerTab)
                },
            },
        ]
        this.platform.popupContextMenu(items, ev)
    }
}
