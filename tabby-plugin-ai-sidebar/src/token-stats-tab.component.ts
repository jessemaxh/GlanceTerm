import { Component, NgZone } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

import {
    TokenStatsService, SessionStat, Totals,
    dayKey, totalsInWindow, grandTotal, groupBy,
} from './token-stats.service'
import type { AiTool } from './tab-monitor'

type Range = 'today' | '7d' | '30d' | 'all'
type View = 'agent' | 'session' | 'project'
type SortKey = 'in' | 'cache' | 'out' | 'turns' | 'recent' | 'name'

interface Row {
    name: string          // agent / project / session label
    agent: AiTool | ''     // '' for project rows (mixed)
    sub?: string           // secondary label (project for session rows)
    totals: Totals
    turns: number
    sessions: number
    lastActive: number
}

const AGENT_LABEL: Record<string, string> = {
    claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'opencode',
}

/**
 * Standalone "Token Usage" settings page. Reads TokenStatsService (all on-disk
 * transcripts, day-bucketed) and renders total / by-agent / by-session /
 * by-project breakdowns within a time window, with CSV export. Cost ($) is
 * intentionally omitted — subscriptions + price changes make it unreliable.
 */
@Component({
    template: `
    <div class="gt-ts">
      <div class="gt-ts-head">
        <h3>Token Usage</h3>
        <div class="gt-ts-controls">
          <div class="btn-group">
            <button *ngFor="let r of ranges" class="btn btn-sm"
                    [class.btn-primary]="range===r.k" [class.btn-outline-secondary]="range!==r.k"
                    (click)="range=r.k">{{ r.label }}</button>
          </div>
          <button class="btn btn-sm btn-outline-secondary" (click)="refresh()" [disabled]="loading">
            {{ loading ? 'Scanning…' : '↻ Refresh' }}
          </button>
          <button class="btn btn-sm btn-outline-secondary" (click)="exportCsv()">⤓ CSV</button>
          <button class="btn btn-sm btn-outline-secondary" (click)="modal.dismiss()" aria-label="Close">✕</button>
        </div>
      </div>

      <div class="gt-ts-progress" *ngIf="loading && scanTotal>0">
        <div class="bar"><div class="fill" [style.width.%]="scanTotal ? (scanDone*100/scanTotal) : 0"></div></div>
        <span>{{ scanDone }} / {{ scanTotal }} transcripts</span>
      </div>

      <div class="gt-ts-total">
        <span class="m"><span class="l">in</span><span class="v">{{ fmt(total.inTok) }}</span></span>
        <span class="m cache"><span class="l">cache</span><span class="v">{{ fmt(total.cacheTok) }}</span></span>
        <span class="m"><span class="l">out</span><span class="v">{{ fmt(total.outTok) }}</span></span>
        <span class="scope">{{ scopeLabel }}</span>
      </div>

      <div class="btn-group gt-ts-views">
        <button *ngFor="let v of views" class="btn btn-sm"
                [class.btn-primary]="view===v.k" [class.btn-outline-secondary]="view!==v.k"
                (click)="view=v.k">{{ v.label }}</button>
      </div>

      <table class="gt-ts-table">
        <thead>
          <tr>
            <th (click)="sortBy('name')">{{ view==='session' ? 'Session' : view==='project' ? 'Project' : 'Agent' }}</th>
            <th class="num" (click)="sortBy('in')">in</th>
            <th class="num" (click)="sortBy('cache')">cache</th>
            <th class="num" (click)="sortBy('out')">out</th>
            <th class="num" (click)="sortBy('turns')">turns</th>
            <th class="num" *ngIf="view!=='agent'" (click)="sortBy('recent')">last</th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let row of rows">
            <td class="name">
              <span class="agent" *ngIf="row.agent">{{ agentLabel(row.agent) }}</span>
              <span class="primary">{{ row.name }}</span>
              <span class="sub" *ngIf="row.sub">{{ row.sub }}</span>
            </td>
            <td class="num">{{ fmt(row.totals.inTok) }}</td>
            <td class="num cache">{{ fmt(row.totals.cacheTok) }}</td>
            <td class="num">{{ fmt(row.totals.outTok) }}</td>
            <td class="num">{{ row.turns || '' }}</td>
            <td class="num" *ngIf="view!=='agent'">{{ ago(row.lastActive) }}</td>
          </tr>
          <tr *ngIf="rows.length===0"><td colspan="6" class="empty">{{ loading ? 'Scanning…' : 'No usage in this window.' }}</td></tr>
        </tbody>
      </table>
      <p class="gt-ts-note">opencode history is partial (only what's still in the hook logs). Totals survive <code>/clear</code> — each cleared session is summed back per project. No cost estimate (subscription/price changes).</p>
    </div>
    `,
    styles: [`
      .gt-ts { padding: 12px 4px; font-size: 13px; }
      .gt-ts-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
      .gt-ts-head h3 { margin:0; }
      .gt-ts-controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .gt-ts-progress { display:flex; align-items:center; gap:8px; margin:8px 0; font-size:11px; opacity:.7; }
      .gt-ts-progress .bar { flex:1; height:4px; background:rgba(255,255,255,.1); border-radius:2px; overflow:hidden; }
      .gt-ts-progress .fill { height:100%; background:#5BD068; transition:width .2s; }
      .gt-ts-total { display:flex; align-items:baseline; gap:18px; margin:14px 0 8px; padding:10px 12px; background:rgba(255,255,255,.04); border-radius:8px; font-family:ui-monospace,monospace; }
      .gt-ts-total .m { display:inline-flex; align-items:baseline; gap:6px; }
      .gt-ts-total .l { opacity:.5; font-size:11px; }
      .gt-ts-total .v { font-size:18px; font-weight:600; }
      .gt-ts-total .cache .v { color:#FFAA55; }
      .gt-ts-total .scope { margin-left:auto; opacity:.5; font-size:11px; }
      .gt-ts-views { margin:8px 0; }
      .gt-ts-table { width:100%; border-collapse:collapse; font-family:ui-monospace,monospace; }
      .gt-ts-table th { text-align:left; opacity:.55; font-weight:500; font-size:11px; padding:6px 8px; cursor:pointer; user-select:none; border-bottom:1px solid rgba(255,255,255,.08); }
      .gt-ts-table th.num, .gt-ts-table td.num { text-align:right; }
      .gt-ts-table td { padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.04); }
      .gt-ts-table td.cache { color:#FFAA55; }
      .gt-ts-table td.name { display:flex; gap:8px; align-items:baseline; }
      .gt-ts-table .agent { font-size:10px; padding:1px 6px; border-radius:6px; background:rgba(217,119,87,.18); color:#D97757; }
      .gt-ts-table .sub { opacity:.45; font-size:11px; }
      .gt-ts-table .empty { text-align:center; opacity:.5; padding:18px; }
      .gt-ts-note { margin-top:12px; opacity:.45; font-size:11px; line-height:1.5; }
    `],
})
export class TokenStatsTabComponent {
    ranges: { k: Range; label: string }[] = [
        { k: 'today', label: 'Today' }, { k: '7d', label: '7d' }, { k: '30d', label: '30d' }, { k: 'all', label: 'All-time' },
    ]
    views: { k: View; label: string }[] = [
        { k: 'agent', label: 'By agent' }, { k: 'session', label: 'By session' }, { k: 'project', label: 'By project' },
    ]
    range: Range = 'all'
    view: View = 'agent'
    sortKey: SortKey = 'out'
    sortDir: 1 | -1 = -1

    sessions: SessionStat[] = []
    loading = false
    scanDone = 0
    scanTotal = 0

    constructor (private stats: TokenStatsService, private zone: NgZone, public modal: NgbActiveModal) {}

    async ngOnInit (): Promise<void> {
        this.sessions = this.stats.snapshot()   // instant from cache
        await this.refresh()                     // then rescan for fresh/active sessions
    }

    async refresh (): Promise<void> {
        if (this.loading) return
        this.loading = true; this.scanDone = 0; this.scanTotal = 0
        try {
            this.sessions = await this.stats.scan((d, t) => this.zone.run(() => { this.scanDone = d; this.scanTotal = t }))
        } finally {
            this.loading = false
        }
    }

    private get bounds (): { from: string; to: string } {
        const off = (n: number): string => { const d = new Date(); d.setDate(d.getDate() - n); return dayKey(d.getTime()) }
        switch (this.range) {
            case 'today': return { from: off(0), to: off(0) }
            case '7d': return { from: off(6), to: off(0) }
            case '30d': return { from: off(29), to: off(0) }
            default: return { from: '', to: '' }
        }
    }

    get scopeLabel (): string {
        return this.range === 'all' ? 'all-time' : this.range === 'today' ? 'today' : `last ${this.range}`
    }

    get total (): Totals {
        const { from, to } = this.bounds
        return grandTotal(this.sessions, from, to)
    }

    get rows (): Row[] {
        const { from, to } = this.bounds
        let rows: Row[]
        if (this.view === 'session') {
            rows = this.sessions.map(s => ({
                name: s.sessionId.slice(0, 8),
                agent: s.agent,
                sub: this.projectLabel(s.project),
                totals: totalsInWindow(s.perDay, from, to),
                turns: s.turns,
                sessions: 1,
                lastActive: s.lastActive,
            })).filter(r => r.totals.inTok || r.totals.cacheTok || r.totals.outTok)
        } else {
            rows = groupBy(this.sessions, this.view, from, to).map(g => ({
                name: this.view === 'project' ? this.projectLabel(g.key) : agentLabelOf(g.key),
                agent: this.view === 'agent' ? (g.key as AiTool) : '',
                totals: g.totals,
                turns: g.turns,
                sessions: g.sessions,
                lastActive: g.lastActive,
            }))
        }
        return this.sortRows(rows)
    }

    private sortRows (rows: Row[]): Row[] {
        const k = this.sortKey, d = this.sortDir
        const val = (r: Row): number | string =>
            k === 'in' ? r.totals.inTok : k === 'cache' ? r.totals.cacheTok : k === 'out' ? r.totals.outTok
                : k === 'turns' ? r.turns : k === 'recent' ? r.lastActive : r.name
        return [...rows].sort((a, b) => {
            const va = val(a), vb = val(b)
            if (typeof va === 'string' || typeof vb === 'string') return d * String(va).localeCompare(String(vb))
            return d * (va - vb)
        })
    }

    sortBy (k: SortKey): void {
        if (this.sortKey === k) this.sortDir = (this.sortDir === 1 ? -1 : 1) as 1 | -1
        else { this.sortKey = k; this.sortDir = k === 'name' ? 1 : -1 }
    }

    agentLabel (a: AiTool | ''): string { return a ? agentLabelOf(a) : '' }

    projectLabel (p: string): string {
        if (!p) return '(unknown)'
        const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
        let s = home && p.startsWith(home) ? '~' + p.slice(home.length) : p
        if (s.length > 40) s = '…' + s.slice(-39)
        return s
    }

    fmt (n: number): string {
        if (!n) return '0'
        const abs = Math.abs(n)
        if (abs >= 1e12) return (n / 1e12).toFixed(2) + 't'
        if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'b'
        if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'm'
        if (abs >= 1e3) return Math.round(n / 1e3) + 'k'
        return String(n)
    }

    ago (ms: number): string {
        if (!ms) return ''
        const s = (Date.now() - ms) / 1000
        if (s < 90) return 'now'
        if (s < 3600) return Math.round(s / 60) + 'm'
        if (s < 86400) return Math.round(s / 3600) + 'h'
        return Math.round(s / 86400) + 'd'
    }

    exportCsv (): void {
        const header = ['view', 'name', 'agent', 'project', 'in', 'cache', 'out', 'turns', 'sessions', 'lastActiveISO']
        const lines = [header.join(',')]
        for (const r of this.rows) {
            lines.push([
                this.view, csv(r.name), r.agent, csv(r.sub ?? ''),
                r.totals.inTok, r.totals.cacheTok, r.totals.outTok, r.turns, r.sessions,
                r.lastActive ? new Date(r.lastActive).toISOString() : '',
            ].join(','))
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `glanceterm-tokens-${this.view}-${this.range}.csv`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
}

function agentLabelOf (a: string): string { return AGENT_LABEL[a] ?? a }
function csv (s: string): string { return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
