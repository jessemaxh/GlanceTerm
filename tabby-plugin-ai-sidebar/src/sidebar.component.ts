import { Component, OnDestroy, OnInit } from '@angular/core'
import { Subscription } from 'rxjs'
import * as os from 'os'

import { AppService } from 'tabby-core'

import { TabMonitor, TabState } from './tab-monitor'

/**
 * The actual sidebar content. NOT a BaseTabComponent — this is a plain
 * Angular component that the host (Tabby's appRoot) instantiates inside a
 * `.sidebar-slot` via SidebarProvider, NOT inside a tab.
 *
 * Lives alongside the tab body and stays visible regardless of which
 * terminal tab is active. Click a row → AppService.selectTab() focuses that
 * terminal tab.
 */
@Component({
    selector: 'ai-sidebar',
    template: `
        <div class="ai-sidebar">
            <div class="header">
                <span class="title-text">AI Tabs</span>
                <span class="count" *ngIf="visibleStates.length > 0">{{ visibleStates.length }}</span>
            </div>

            <div *ngIf="visibleStates.length === 0" class="empty">
                <div class="empty-icon">○</div>
                <div class="empty-text">no terminal tabs</div>
                <div class="empty-hint">open a shell to start</div>
            </div>

            <div *ngIf="visibleStates.length > 0" class="list">
                <div *ngFor="let s of visibleStates; trackBy: trackByTab"
                     class="row"
                     [class.no-ai]="s.status === 'no_ai'"
                     [class.active-now]="s.outerTab === app.activeTab"
                     (click)="onSelect(s)">
                    <div class="dot" [attr.data-status]="s.status"></div>
                    <div class="meta">
                        <div class="line1">
                            <span class="title">{{ s.title }}</span>
                            <span class="age" *ngIf="s.status !== 'no_ai'">
                                {{ ageStr(s.lastActiveMs) }}
                            </span>
                        </div>
                        <div class="line2">
                            <span class="tool-tag" *ngIf="s.aiTool" [attr.data-tool]="s.aiTool">
                                {{ s.aiTool }}
                            </span>
                            <span class="status-label" [attr.data-status]="s.status">
                                {{ statusLabel(s) }}
                            </span>
                            <span class="cwd">{{ compressHome(s.cwd) }}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `,
    styles: [`
        :host {
            display: block;
            width: 100%;
            height: 100%;
            background: var(--bs-body-bg, #1c1f23);
            color: var(--bs-body-color, #d8d8d8);
            overflow-y: auto;
            font-family: ui-monospace, "SF Mono", Menlo, monospace;
            font-size: 12px;
        }
        .ai-sidebar { padding: 6px 0 12px; }
        .header {
            padding: 10px 14px 8px;
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            opacity: 0.7;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .count {
            opacity: 0.55;
            font-weight: 500;
            background: rgba(255,255,255,0.08);
            padding: 1px 6px;
            border-radius: 8px;
            font-size: 10px;
        }
        .empty {
            padding: 40px 14px;
            text-align: center;
            opacity: 0.45;
        }
        .empty-icon { font-size: 32px; line-height: 1; margin-bottom: 8px; opacity: 0.5; }
        .empty-text { font-size: 12px; margin-bottom: 4px; }
        .empty-hint { font-size: 10px; opacity: 0.7; }
        .list { display: flex; flex-direction: column; }
        .row {
            display: flex;
            align-items: flex-start;
            padding: 8px 12px 8px 10px;
            border-left: 2px solid transparent;
            cursor: pointer;
            transition: background-color 0.08s, border-color 0.08s;
        }
        .row:hover { background: rgba(255,255,255,0.04); }
        .row.active-now {
            background: rgba(80,140,220,0.16);
            border-left-color: #5aa0ff;
        }
        .row.active-now .title { color: #cfe2ff; }
        .row.no-ai { opacity: 0.5; }
        .row.no-ai:hover { opacity: 0.75; }
        .dot {
            width: 8px; height: 8px;
            border-radius: 50%;
            margin: 6px 10px 0 0;
            flex-shrink: 0;
        }
        .dot[data-status="working"] {
            background: #4caf50;
            box-shadow: 0 0 6px #4caf5066;
            animation: pulse 1.4s ease-in-out infinite;
        }
        .dot[data-status="idle"]    { background: #888; }
        .dot[data-status="no_ai"]   { background: transparent; border: 1px solid #555; }
        @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50%      { transform: scale(1.25); opacity: 0.65; }
        }
        .meta { flex: 1; min-width: 0; }
        .line1 {
            display: flex;
            align-items: baseline;
            gap: 8px;
            font-weight: 600;
        }
        .title {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .age { opacity: 0.5; font-size: 10px; font-weight: 400; flex-shrink: 0; }
        .line2 {
            display: flex;
            gap: 8px;
            margin-top: 2px;
            font-size: 11px;
            opacity: 0.65;
        }
        .tool-tag {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            padding: 1px 4px;
            border-radius: 3px;
            font-weight: 700;
            flex-shrink: 0;
            color: #1c1f23;
        }
        .tool-tag[data-tool="claude"]   { background: #ffaa55; }
        .tool-tag[data-tool="codex"]    { background: #61c8e1; }
        .tool-tag[data-tool="opencode"] { background: #b794f4; }
        .tool-tag[data-tool="aider"]    { background: #f56565; }
        .status-label { text-transform: lowercase; flex-shrink: 0; }
        .status-label[data-status="working"] { color: #6cc46e; }
        .status-label[data-status="idle"]    { color: #9bd1ff; }
        .status-label[data-status="no_ai"]   { color: #888; }
        .cwd {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            text-align: right;
            font-size: 10px;
        }
    `],
})
export class AiSidebarComponent implements OnInit, OnDestroy {
    states: TabState[] = []
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
     * Tabs we actually render. Filters out:
     *   - SplitTabComponents Tabby restored from disk with no leaf yet
     *     (these have no session, no claude — pure UI noise).
     */
    get visibleStates (): TabState[] {
        return this.states
    }

    trackByTab = (_: number, s: TabState): any => s.innerTab

    onSelect (s: TabState): void {
        this.app.selectTab(s.outerTab)
        // If the matched leaf is inside a split, also focus that specific pane.
        if (s.outerTab !== s.innerTab && typeof (s.outerTab as any).focus === 'function') {
            try {
                (s.outerTab as any).focus(s.innerTab)
            } catch { /* best-effort */ }
        }
    }

    statusLabel (s: TabState): string {
        switch (s.status) {
            case 'working': return 'working'
            case 'idle':    return 'idle'
            case 'no_ai':   return 'shell'
            default:        return s.status
        }
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
