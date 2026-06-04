import { Component, OnDestroy, OnInit } from '@angular/core'
import { Subscription } from 'rxjs'
import * as os from 'os'

import { AppService } from 'tabby-core'

import { TabMonitor, TabState } from './tab-monitor'

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
 * Visual system: HiveTerm "Restrained" direction — honey accent on a dark
 * surface, status conveyed by colour + shape + word (color-blind safe), and
 * blue reserved for the active row so it always reads as "you are here."
 */
@Component({
    selector: 'ai-sidebar',
    template: `
        <div class="sb">
            <div class="sb-header">
                <span class="h-title">AI Tabs</span>
                <span class="h-badge" *ngIf="states.length > 0">{{ states.length }}</span>
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
                <svg class="comb" width="78" height="74" viewBox="0 0 60 64" fill="none" aria-hidden="true">
                    <polygon points="39.5,3.5 39.5,14.5 30,20 20.5,14.5 20.5,3.5 30,-2"
                             stroke="var(--ht-text-faint)" stroke-width="1.3" fill="none"
                             stroke-linejoin="round" opacity="0.55" />
                    <polygon points="61.5,15.5 61.5,26.5 52,32 42.5,26.5 42.5,15.5 52,10"
                             stroke="var(--ht-text-faint)" stroke-width="1.3" fill="none"
                             stroke-linejoin="round" opacity="0.55" />
                    <polygon points="61.5,39.5 61.5,50.5 52,56 42.5,50.5 42.5,39.5 52,34"
                             stroke="var(--ht-text-faint)" stroke-width="1.3" fill="none"
                             stroke-linejoin="round" opacity="0.55" />
                    <polygon points="39.5,51.5 39.5,62.5 30,68 20.5,62.5 20.5,51.5 30,46"
                             stroke="var(--ht-text-faint)" stroke-width="1.3" fill="none"
                             stroke-linejoin="round" opacity="0.55" />
                    <polygon points="17.5,39.5 17.5,50.5 8,56 -1.5,50.5 -1.5,39.5 8,34"
                             stroke="var(--ht-text-faint)" stroke-width="1.3" fill="none"
                             stroke-linejoin="round" opacity="0.55" />
                    <polygon points="17.5,15.5 17.5,26.5 8,32 -1.5,26.5 -1.5,15.5 8,10"
                             stroke="var(--ht-text-faint)" stroke-width="1.3" fill="none"
                             stroke-linejoin="round" opacity="0.55" />
                    <polygon points="39.5,27.5 39.5,38.5 30,44 20.5,38.5 20.5,27.5 30,22"
                             stroke="var(--ht-honey)" stroke-width="1.3" fill="var(--ht-honey-soft)"
                             stroke-linejoin="round" />
                </svg>
                <div class="et">The hive is empty</div>
                <div class="es">No AI agents running yet. Open a shell and start one to see it light up here.</div>
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
                     (click)="onSelect(s)">
                    <div class="num" aria-hidden="true">{{ tabIndex(s) }}</div>
                    <div class="rail">
                        <span class="dot" [attr.data-status]="s.status" aria-hidden="true"></span>
                    </div>
                    <div class="body">
                        <div class="line1">
                            <span class="ttl">{{ s.title }}</span>
                            <span *ngIf="s.status === 'needs_permission'" class="attn" aria-hidden="true"></span>
                        </div>
                        <div class="line2">
                            <span *ngIf="s.aiTool" class="tag" [attr.data-tool]="s.aiTool">{{ toolTag(s.aiTool) }}</span>
                            <span class="status" [attr.data-status]="s.status">{{ statusLabel(s) }}</span>
                            <ng-container *ngIf="s.cwd && s.status !== 'needs_permission'">
                                <span class="dotsep" aria-hidden="true">·</span>
                                <span class="cwd">{{ compressHome(s.cwd) }}</span>
                            </ng-container>
                        </div>
                    </div>
                    <div class="meta">
                        <span class="age" *ngIf="s.status !== 'no_ai' && s.lastActiveMs !== null">{{ ageStr(s.lastActiveMs) }}</span>
                        <svg *ngIf="hasSpark(s)"
                             class="spark"
                             [attr.data-status]="s.status"
                             viewBox="0 0 52 14"
                             preserveAspectRatio="none"
                             aria-hidden="true">
                            <polyline [attr.points]="sparkPoints(s)" />
                        </svg>
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
            /* HiveTerm tokens — dark direction. Light theme not wired (Tabby is dark-first). */
            --ht-honey:        #FFAA55;
            --ht-honey-deep:   #FF7A3D;
            --ht-honey-soft:   rgba(255, 170, 85, 0.14);

            --ht-st-working:      #4CAF50;
            --ht-st-working-glow: rgba(76, 175, 80, 0.45);
            --ht-st-idle:         #8A9099;
            --ht-st-ready:        #5B9EF5;
            --ht-st-active:       #5B9EF5;
            --ht-st-active-bg:    rgba(91, 158, 245, 0.12);
            --ht-st-perm:         #FF9F45;

            --ht-surface-1: var(--bs-body-bg, #1C1F23);
            --ht-surface-2: rgba(255, 255, 255, 0.04);
            --ht-surface-3: rgba(255, 255, 255, 0.07);

            --ht-border:    rgba(255, 255, 255, 0.07);
            --ht-text:      var(--bs-body-color, #E7E9EC);
            --ht-text-dim:  #9BA1A9;
            --ht-text-faint:#6B7178;

            --ht-mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;

            display: block;
            width: 100%;
            height: 100%;
            background: var(--ht-surface-1);
            color: var(--ht-text);
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
            color: var(--ht-text-faint);
            white-space: nowrap;
        }
        .sb-header .h-badge {
            font-family: var(--ht-mono);
            font-size: 10.5px;
            font-weight: 600;
            min-width: 18px;
            height: 18px;
            padding: 0 5px;
            border-radius: 99px;
            display: grid;
            place-items: center;
            background: var(--ht-honey-soft);
            color: var(--ht-honey);
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
            color: var(--ht-text-dim);
        }
        .sb-empty .es {
            font-size: 12px;
            color: var(--ht-text-faint);
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
            border: 1px solid var(--ht-border);
            background: transparent;
            color: var(--ht-text-dim);
            font: inherit;
            font-size: 11.5px;
            font-weight: 500;
            line-height: 1.2;
            cursor: pointer;
            transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
        }
        .pill:hover {
            background: var(--ht-surface-2);
            color: var(--ht-text);
            border-color: rgba(255,255,255,0.14);
        }
        .pill.active {
            background: var(--ht-honey-soft);
            border-color: rgba(255, 170, 85, 0.55);
            color: var(--ht-honey);
        }
        .pill[data-id="needs_permission"].active {
            background: rgba(255, 159, 69, 0.18);
            border-color: rgba(255, 159, 69, 0.6);
            color: var(--ht-st-perm);
        }
        .pill .c {
            font-family: var(--ht-mono);
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
            background: var(--ht-border);
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
            font-family: var(--ht-mono);
            font-size: 13px;
            font-weight: 500;
            color: var(--ht-text-faint);
            text-align: right;
            font-variant-numeric: tabular-nums;
            line-height: 1;
        }
        .row.active .num { color: var(--ht-st-active); font-weight: 600; }
        .row:hover { background: var(--ht-surface-2); }

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

        .row.active { background: var(--ht-st-active-bg); }
        .row.active::before {
            content: "";
            position: absolute;
            left: 0;
            top: 6px;
            bottom: 6px;
            width: 2.5px;
            border-radius: 0 3px 3px 0;
            background: var(--ht-st-active);
        }
        .row.active .ttl { color: var(--ht-text); font-weight: 600; }

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
            background: var(--ht-st-working);
            box-shadow: 0 0 0 0 var(--ht-st-working-glow);
            animation: ht-pulse 1.7s ease-out infinite;
        }
        .dot[data-status="idle"]             { background: var(--ht-st-idle); }
        .dot[data-status="no_ai"] {
            background: transparent;
            box-shadow: inset 0 0 0 1.5px var(--ht-text-faint);
        }
        .dot[data-status="needs_permission"] { background: var(--ht-st-perm); }

        @keyframes ht-pulse {
            0%   { box-shadow: 0 0 0 0 var(--ht-st-working-glow); }
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
            color: var(--ht-text);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 0 1 auto;
        }
        .attn {
            width: 6px;
            height: 6px;
            border-radius: 99px;
            background: var(--ht-st-perm);
            flex: none;
            animation: ht-attn 1.2s ease-in-out infinite;
        }
        @keyframes ht-attn { 50% { opacity: 0.25; } }

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
            overflow: hidden;
            text-overflow: ellipsis;
            flex: 0 1 auto;
        }
        .status[data-status="working"]          { color: var(--ht-st-working); }
        .status[data-status="idle"]             { color: var(--ht-st-ready); }
        .status[data-status="no_ai"]            { color: var(--ht-text-faint); }
        .status[data-status="needs_permission"] { color: var(--ht-st-perm); font-weight: 600; }

        .cwd {
            font-family: var(--ht-mono);
            font-size: 12px;
            color: var(--ht-text-faint);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
        }
        .dotsep { color: var(--ht-text-faint); opacity: 0.6; flex: none; }

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
            font-family: var(--ht-mono);
            font-size: 12px;
            color: var(--ht-text-faint);
        }

        /* ---- sparkline (v0.2-4) ---- */
        .spark {
            width: 52px;
            height: 14px;
            display: block;
            opacity: 0.85;
        }
        .spark polyline {
            fill: none;
            stroke-width: 1.2;
            stroke-linejoin: round;
            stroke-linecap: round;
        }
        .spark[data-status="working"] polyline          { stroke: var(--ht-st-working); }
        .spark[data-status="idle"] polyline             { stroke: var(--ht-st-idle); }
        .spark[data-status="needs_permission"] polyline { stroke: var(--ht-st-perm); }

        /* ---- tool tag ---- */
        .tag {
            font-family: var(--ht-mono);
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
        .tag[data-tool="antigravity"] { color: #6B8AE8; background: rgba(107, 138, 232, 0.16); }
        .tag[data-tool="cursor"]      { color: #C0C8D0; background: rgba(192, 200, 208, 0.16); }
        .tag[data-tool="opencode"]    { color: #B794F4; background: rgba(183, 148, 244, 0.16); }
        .tag[data-tool="aider"]       { color: #3FC9B0; background: rgba(63, 201, 176, 0.16); }
        .tag[data-tool="goose"]       { color: #8ED1A4; background: rgba(142, 209, 164, 0.16); }
        .tag[data-tool="crush"]       { color: #FF79C6; background: rgba(255, 121, 198, 0.16); }
        .tag[data-tool="plandex"]     { color: #D9A066; background: rgba(217, 160, 102, 0.16); }
        .tag[data-tool="sweagent"]    { color: #9F7AEA; background: rgba(159, 122, 234, 0.16); }
        .tag[data-tool="amp"]         { color: #F2D070; background: rgba(242, 208, 112, 0.16); }
        .tag[data-tool="droid"]       { color: #4FD1C5; background: rgba(79, 209, 197, 0.16); }

        /* ---- footer (aggregate stats) ---- */
        .sb-footer {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 9px 14px;
            border-top: 1px solid var(--ht-border);
            font-family: var(--ht-mono);
            font-size: 10.5px;
            color: var(--ht-text-dim);
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
        .sb-footer .stat.work          { color: var(--ht-st-working); }
        .sb-footer .stat.work i        { background: var(--ht-st-working); }
        .sb-footer .stat.idle          { color: var(--ht-text-dim); }
        .sb-footer .stat.idle i        { background: var(--ht-st-idle); }
        .sb-footer .stat.attn-stat     { color: var(--ht-st-perm); }
        .sb-footer .stat.attn-stat i   { background: var(--ht-st-perm); }

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
    ) {}

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

    /** 3-letter uppercase tag matching the HiveTerm design language. */
    toolTag (tool: string | null): string {
        if (!tool) return ''
        const tags: Record<string, string> = {
            claude: 'CLA',
            codex: 'CDX',
            gemini: 'GEM',
            antigravity: 'ANT',
            cursor: 'CUR',
            opencode: 'OPC',
            aider: 'AID',
            goose: 'GSE',
            crush: 'CRU',
            plandex: 'PLD',
            sweagent: 'SWA',
            amp: 'AMP',
            droid: 'DRD',
        }
        return tags[tool] || tool.slice(0, 3).toUpperCase()
    }

    /** True when the row has a meaningful byte-rate history to plot. */
    hasSpark (s: TabState): boolean {
        return !!s.byteHistory && s.byteHistory.length >= 2
    }

    /**
     * Build SVG polyline "x,y x,y …" points for the row's bytes/sec history.
     * Viewbox is 52×14 (matches CSS). We rescale to the run's own max — every
     * sparkline ends up readable regardless of whether the tab fires 50 B/s
     * or 50 KB/s, at the cost of cross-row magnitude comparison (which the
     * status colour + dot already covers).
     */
    sparkPoints (s: TabState): string {
        const h = s.byteHistory!
        const max = Math.max(...h, 1)
        const W = 52
        const H = 14
        const pad = 1
        const n = h.length
        return h.map((v, i) => {
            const x = n === 1 ? W / 2 : (i / (n - 1)) * W
            const y = H - pad - (v / max) * (H - pad * 2)
            return `${x.toFixed(1)},${y.toFixed(1)}`
        }).join(' ')
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

    compressHome (p: string | null): string {
        if (!p) return ''
        if (this.home && p.startsWith(this.home)) {
            return '~' + p.slice(this.home.length)
        }
        return p
    }
}
