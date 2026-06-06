import { Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core'
import { Subscription } from 'rxjs'
import * as os from 'os'

import { AppService, BaseTabComponent, ConfigService, MenuItemOptions, NotificationsService, PlatformService } from 'tabby-core'

import { TabMonitor, TabState } from './tab-monitor'
import { UnreadService } from './unread.service'
import { ScreenshotService } from './screenshot/screenshot.service'
import { ScreenshotPasteService } from './screenshot/paste.service'
import { SplitShellService } from './split-shell.service'
import { AutoApproveService } from './auto-approve.service'

type FilterId = 'all' | 'done' | 'needs_permission' | 'working' | 'idle'

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
                     [attr.data-status]="effStatus(s)"
                     [class.active]="isActive(s)"
                     [class.subordinate]="isSubordinate(s)"
                     [class.pinned]="isPinned(s)"
                     [attr.aria-label]="ariaLabel(s)"
                     [attr.title]="s.cwd || s.title"
                     role="button"
                     (click)="onSelect(s)"
                     (contextmenu)="onContextMenu(s, $event)">
                    <div class="num" aria-hidden="true">{{ tabIndex(s) }}</div>
                    <div class="rail">
                        <span class="dot" [attr.data-status]="effStatus(s)" aria-hidden="true"></span>
                    </div>
                    <div class="body">
                        <div class="line1">
                            <svg *ngIf="isPinned(s)" class="pin-mark" width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" title="Pinned to top">
                                <path d="M9.5 1.5 L14.5 6.5 L12 7.2 L11.5 11 L8.2 7.8 L4 12 L4 11 L8 6.8 L4.8 3.5 L8.5 3 Z"
                                      stroke="currentColor" stroke-width="0.6" stroke-linejoin="round"/>
                            </svg>
                            <span class="primary" [attr.title]="s.cwd || s.title">{{ s.cwd ? folderName(s.cwd) : s.title }}</span>
                            <span *ngIf="effStatus(s) === 'needs_permission'" class="attn" aria-hidden="true"></span>
                        </div>
                        <div class="line2">
                            <span *ngIf="s.aiTool" class="tag" [attr.data-tool]="s.aiTool">{{ toolTag(s.aiTool) }}</span>
                            <span class="status" [attr.data-status]="effStatus(s)">{{ statusLabel(s) }}</span>
                            <span *ngIf="s.subagentCount > 0" class="micro accent">{{ s.subagentCount }} {{ s.subagentCount === 1 ? 'agent' : 'agents' }}</span>
                            <span *ngIf="s.backgroundJobCount > 0" class="micro accent" [title]="bgJobTitle(s)">{{ s.backgroundJobCount }} bg</span>
                        </div>
                        <div *ngIf="s.cwd && effStatus(s) !== 'needs_permission'" class="line3">
                            <span class="path-sub" [attr.title]="s.cwd">{{ displayCwd(s.cwd) }}</span>
                        </div>
                    </div>
                    <div class="meta">
                        <span class="age" *ngIf="effStatus(s) !== 'no_ai' && s.lastActiveMs !== null">{{ ageStr(s.lastActiveMs) }}</span>
                    </div>
                </div>
            </div>

            <div *ngIf="visibleStates.length > 0" class="sb-footer">
                <span *ngIf="countDone > 0" class="stat done-stat"><i></i>{{ countDone }}<span class="lbl"> done</span></span>
                <span class="stat work"><i></i>{{ countWorking }}<span class="lbl"> working</span></span>
                <span class="stat idle"><i></i>{{ countIdle }}<span class="lbl"> idle</span></span>
                <span *ngIf="countAttn > 0" class="stat attn-stat"><i></i>{{ countAttn }}<span class="lbl"> need you</span></span>
            </div>

            <!-- "AI toolbar" — always rendered. Per-tab AI actions on the left
                 enable/disable based on focus state rather than mount/unmount,
                 because hiding the split button while a GlanceTerm-owned split
                 is still open leaves the user with no way to close it (agent
                 exited, or focus moved to the shell side of the split → no
                 focused AI agent → button gone, split orphaned). Right cluster
                 is a single gear button that opens a settings popover with
                 every global toggle (chime, auto-approve, …). The two earlier
                 standalone toggles got noisy as a cluster and competed with
                 the per-tab actions for attention; folding them into a popover
                 puts focus back on the per-tab buttons. -->
            <div class="sb-actions" role="toolbar" aria-label="AI tab actions">
                <div class="split-action" #screenshotSplit>
                    <button type="button"
                            class="action-btn split-main"
                            [class.busy]="capturing"
                            [class.muted]="!activeIsAi"
                            [disabled]="capturing"
                            (click)="onScreenshot()"
                            [title]="screenshotTitle()"
                            aria-label="Take a screenshot and paste it into the focused AI agent">
                        <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M5.2 3.5 L6.3 2.2 L9.7 2.2 L10.8 3.5 L13.2 3.5
                                     A1.5 1.5 0 0 1 14.7 5 V11.8
                                     A1.5 1.5 0 0 1 13.2 13.3 H2.8
                                     A1.5 1.5 0 0 1 1.3 11.8 V5
                                     A1.5 1.5 0 0 1 2.8 3.5 Z"
                                  stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
                            <circle cx="8" cy="8.4" r="2.6" stroke="currentColor" stroke-width="1.2" fill="none"/>
                        </svg>
                    </button>
                    <button type="button"
                            class="action-btn split-caret"
                            [class.open]="screenshotMenuOpen"
                            [class.muted]="!activeIsAi"
                            [disabled]="capturing"
                            (click)="toggleScreenshotMenu($event)"
                            title="Screenshot options"
                            aria-label="Open screenshot options menu"
                            [attr.aria-expanded]="screenshotMenuOpen"
                            aria-haspopup="menu">
                        <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M3 6 L8 11 L13 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                    <div *ngIf="screenshotMenuOpen" class="action-menu" role="menu">
                        <button type="button"
                                class="action-menu-item"
                                role="menuitemcheckbox"
                                [attr.aria-checked]="screenshotHideWindow"
                                (click)="toggleScreenshotHideWindow()">
                            <svg class="check" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                <path *ngIf="screenshotHideWindow" d="M3 8.5 L6.5 12 L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span class="lbl">Hide GlanceTerm window</span>
                        </button>
                    </div>
                </div>
                <button type="button"
                        class="action-btn"
                        [class.active]="isSplitOpenInActiveTab()"
                        (click)="onSplitShell()"
                        [title]="splitTitle()"
                        [attr.aria-label]="splitAriaLabel()">
                    <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <rect x="1.5" y="2.5" width="6" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.7"/>
                        <rect x="8.5" y="2.5" width="6" height="11" rx="1"/>
                    </svg>
                </button>
                <!-- Settings cluster — collapsed from the previous two icon
                     toggles into a single gear button + popover. Pattern mirrors
                     the screenshot-options split: a .action-menu opens upward
                     above the toolbar so it never clips behind the sidebar
                     footer. .right-anchored flips the menu anchor edge so it
                     doesn't overflow the sidebar's right boundary. -->
                <div class="split-action settings-action" #settingsSplit>
                    <button type="button"
                            class="action-btn settings-btn"
                            [class.open]="settingsMenuOpen"
                            (click)="toggleSettingsMenu($event)"
                            title="AI sidebar settings"
                            aria-label="Open AI sidebar settings"
                            [attr.aria-expanded]="settingsMenuOpen"
                            aria-haspopup="menu">
                        <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <!-- Cog: center bearing + 8 evenly-spaced teeth pairs
                                 drawn as short radial strokes. Pure-stroke render
                                 reads as "settings" on dark + light backgrounds
                                 alike, and the inner circle doubles as a focus
                                 anchor for hover state. -->
                            <circle cx="8" cy="8" r="2.4" stroke="currentColor" stroke-width="1.2" fill="none"/>
                            <path d="M8 1.5 V3.4 M8 12.6 V14.5 M1.5 8 H3.4 M12.6 8 H14.5
                                     M3.4 3.4 L4.7 4.7 M11.3 11.3 L12.6 12.6
                                     M3.4 12.6 L4.7 11.3 M11.3 4.7 L12.6 3.4"
                                  stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                        </svg>
                    </button>
                    <div *ngIf="settingsMenuOpen" class="action-menu right-anchored" role="menu">
                        <button type="button"
                                class="action-menu-item"
                                role="menuitemcheckbox"
                                [attr.aria-checked]="soundOnReady"
                                (click)="toggleSoundOnReady()">
                            <svg class="check" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                <path *ngIf="soundOnReady" d="M3 8.5 L6.5 12 L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span class="lbl">Chime on agent done</span>
                        </button>
                        <button type="button"
                                class="action-menu-item"
                                role="menuitemcheckbox"
                                [attr.aria-checked]="autoApprovePermissions"
                                (click)="toggleAutoApprove()">
                            <svg class="check" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                <path *ngIf="autoApprovePermissions" d="M3 8.5 L6.5 12 L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span class="lbl">Auto-approve permission prompts</span>
                        </button>
                    </div>
                </div>
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
            /* Active wash sits at the WeChat-conversation-list ratio: focused
               row reads as a dominant solid surface, pinned rows are a whisper.
               Earlier value (0.12 alpha) was the same intensity as pinned-gold
               (0.10), so an active+pinned screen made the two compete as
               siblings rather than reading as primary + secondary. Bumped to
               0.32 to put active at ~6× the weight of pinned. */
            --gt-st-active-bg:    rgba(91, 158, 245, 0.32);
            --gt-st-perm:         #FF9F45;
            --gt-st-done:         #FF5252;
            --gt-st-done-soft:    rgba(255, 82, 82, 0.14);
            --gt-st-done-ring:    rgba(255, 82, 82, 0.45);

            /* User-pin colour — orthogonal axis to the status palette (green
               working / red done / orange needs-perm / blue ready). Gold
               matches the universal "favorite / star / pinned" convention
               and doesn't compete with any status hue. */
            --gt-pin:             #E8C547;
            /* Pinned wash is intentionally a whisper — the gold ★ glyph next
               to the title is the primary "this row is pinned" signal; the
               background tint is just there so a pinned row is *barely*
               distinguishable from a non-pinned idle row, without competing
               visually with the active blue (see --gt-st-active-bg). Was
               0.10; halved to 0.05 to widen the active-vs-pinned ratio. */
            --gt-pin-soft:        rgba(232, 197, 71, 0.05);
            --gt-pin-border:      rgba(232, 197, 71, 0.40);

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
            font-size: 17px;
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
            gap: 10px;
            padding: 16px 16px 13px;
        }
        .sb-header .h-title {
            font-size: 12.5px;
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
            gap: 18px;
            padding: 34px 26px;
            text-align: center;
        }
        .sb-empty.filtered {
            flex: 0 0 auto;
            padding: 30px 20px;
            gap: 7px;
        }
        .sb-empty .comb { opacity: 0.8; }
        .sb-empty .et {
            font-size: 15px;
            font-weight: 600;
            color: var(--gt-text-dim);
        }
        .sb-empty .es {
            font-size: 13.5px;
            color: var(--gt-text-faint);
            line-height: 1.5;
            max-width: 210px;
        }

        /* ---- filter pills (v0.2-2) ---- */
        .sb-filters {
            display: flex;
            flex-wrap: wrap;
            gap: 7px;
            padding: 0 14px 12px;
        }
        .pill {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            padding: 6px 12px;
            border-radius: 99px;
            border: 1px solid var(--gt-border);
            background: transparent;
            color: var(--gt-text-dim);
            font: inherit;
            font-size: 13px;
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
        .pill[data-id="done"].active {
            background: var(--gt-st-done-soft);
            border-color: rgba(255, 82, 82, 0.6);
            color: var(--gt-st-done);
        }
        .pill .c {
            font-family: var(--gt-mono);
            font-size: 11.5px;
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
            padding: 4px 10px 12px;
            min-height: 0;
        }
        .sb-list::-webkit-scrollbar { width: 10px; }
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
            grid-template-columns: 26px 18px minmax(0, 1fr) auto;
            align-items: center;
            gap: 13px;
            padding: 13px 14px 13px 12px;
            border-radius: 10px;
            cursor: pointer;
            transition: background-color 0.13s ease;
            margin-bottom: 3px;
        }

        /* ---- tab index (matches the numeric prefix on Tabby's top tab bar) ---- */
        .num {
            font-family: var(--gt-mono);
            font-size: 15px;
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

        /* Done row — agent finished, user hasn't engaged with it yet.
           Quieter than needs_permission (no animated indicator), louder than
           idle (tinted background). All done styling is gated on :not(.active):
           an active+done row is common now — attention-notifier fires
           markReady + chime on every working→idle transition regardless of
           focus state (see AttentionNotifierService docstring), so even the
           focused active tab gets marked unread. In that case the blue "you
           are here" surface wins visually until the user actually engages
           with the terminal content (scroll, type, or click into the body —
           see UnreadService docstring for the IM-style engagement model).
           Tab focus alone does NOT clear unread — that's intentional. */
        .row[data-status="done"]:not(.active) {
            box-shadow: inset 0 0 0 1px rgba(255, 82, 82, 0.3);
            background: rgba(255, 82, 82, 0.06);
        }

        .row.active { background: var(--gt-st-active-bg); }
        /* Left rail bar: secondary "you are here" cue alongside the bumped
           background wash. Widened from 2.5px → 4px so it reads at a glance
           even when the row is scrolled toward an edge or partially obscured
           by a hover state — defense in depth for the focus indicator after
           the WeChat-style background bump. */
        .row.active::before {
            content: "";
            position: absolute;
            left: 0;
            top: 6px;
            bottom: 6px;
            width: 4px;
            border-radius: 0 3px 3px 0;
            background: var(--gt-st-active);
        }
        .row.active .primary { color: var(--gt-text); font-weight: 600; }

        /* ---- user-pinned row (right-click → Pin to top) ----
           Faint gold wash + gold pin glyph next to the title. Background
           is intentionally low-alpha so it doesn't fight the .active blue
           wash when a pinned row is also the currently-focused tab — the
           two layer rather than clash. Gold is the only colour in the
           sidebar that isn't already claimed by a status, so "pinned"
           reads independently of status state. */
        .row.pinned {
            background: var(--gt-pin-soft);
        }
        .row.pinned.active {
            /* When both, lean active (blue wash + pin glyph still gold). */
            background: var(--gt-st-active-bg);
        }
        .pin-mark {
            display: inline-flex;
            align-items: center;
            color: var(--gt-pin);
            margin-right: 5px;
            flex: none;
            line-height: 1;
        }

        /* ---- subordinate row (extra leaf inside a SplitTabComponent) ----
           A subordinate leaf — a non-primary pane in a split tab, whether a
           plain shell or another AI — renders with a COMPACT variant of the
           primary row's content so it visibly reads as an attached child:
           the index number is suppressed (it would just repeat the
           primary's), padding is tighter, and the dot + text are smaller.
           The whole row is also indented so the dashed bracket has its own
           gutter on the left instead of overlapping the num/dot columns.
           visibleStates always emits subordinates directly below their
           primary, so the bracket points at a real parent. */
        .row.subordinate {
            padding: 7px 14px 7px 26px;
        }
        /* The outer tab's index is already shown on the primary one row up;
           repeating it on the subordinate is noise. visibility:hidden keeps
           the grid column reserved so the dot + body stay indented further
           right than the primary's. */
        .row.subordinate .num { visibility: hidden; }
        .row.subordinate .dot { width: 10px; height: 10px; }
        .row.subordinate .primary { font-size: 14px; }
        .row.subordinate .line2 { margin-top: 3px; }
        .row.subordinate .status { font-size: 12.5px; }
        .row.subordinate .line3 { margin-top: 2px; }
        .row.subordinate .path-sub { font-size: 12px; }
        .row.subordinate .age { font-size: 12px; }
        .row.subordinate::after {
            content: "";
            position: absolute;
            /* Vertical leg starts well into the row above (which has its own
               13px top padding + ~32px content height); ending around the
               compact subordinate's mid-height makes the bracket read as
               "dropped from the primary". Alpha 0.38 survives the
               .row[data-status="no_ai"] opacity 0.52 compounding
               (→ effective ~0.20), still visible for the most common case
               (shell pane under AI primary). */
            left: 8px;
            top: -24px;
            width: 14px;
            height: 44px;
            border-left: 1px dashed rgba(255, 255, 255, 0.38);
            border-bottom: 1px dashed rgba(255, 255, 255, 0.38);
            border-bottom-left-radius: 4px;
            pointer-events: none;
        }

        /* ---- status rail dot ---- */
        .rail {
            display: grid;
            place-items: center;
            align-self: stretch;
        }
        .dot {
            width: 14px;
            height: 14px;
            border-radius: 99px;
            position: relative;
            display: block;
            transform-origin: center;
            /* Soften the done → idle (red → grey) and idle → done (grey → red)
               transitions so that, paired with the click-sort-pin, the row
               *fades* between buckets instead of teleporting. Working's
               pulse animation overrides background-color and isn't affected. */
            transition: background-color 0.25s ease, box-shadow 0.25s ease;
        }
        /* Working — "breathing" dot. Three layers:
             1. The dot itself scales 1 → 1.22 → 1 each cycle.
             2. An outer ripple (the 0 0 0 Npx ring) grows from 0 to ~13 px
                while fading to alpha 0 — radiates outward.
             3. A static glow halo (the 0 0 Npx blur) that intensifies at the
                peak of the breath — gives the dot a soft "alive" feel even
                between ripple peaks.
           Slightly slower cadence (1.9 s) + ease-in-out feels more like
           breathing than a tick. */
        .dot[data-status="working"] {
            background: var(--gt-st-working);
            box-shadow:
                0 0 0 0 rgba(76, 175, 80, 0.55),
                0 0 6px rgba(76, 175, 80, 0.45);
            animation: ht-pulse 1.9s ease-in-out infinite;
        }
        .dot[data-status="idle"]             { background: var(--gt-st-idle); }
        .dot[data-status="no_ai"] {
            background: transparent;
            box-shadow: inset 0 0 0 1.5px var(--gt-text-faint);
        }
        .dot[data-status="needs_permission"] { background: var(--gt-st-perm); }
        /* Done — solid red, steady halo. No pulse: it shares the column with
           working's pulsing green dot, and a second animation in the same
           viewport reads as chaos. The halo + tinted row background carry
           enough weight on their own. */
        .dot[data-status="done"] {
            background: var(--gt-st-done);
            box-shadow: 0 0 0 3px var(--gt-st-done-ring);
        }

        @keyframes ht-pulse {
            0% {
                box-shadow:
                    0 0 0 0 rgba(76, 175, 80, 0.6),
                    0 0 4px rgba(76, 175, 80, 0.35);
                transform: scale(1);
            }
            50% {
                box-shadow:
                    0 0 0 13px rgba(76, 175, 80, 0),
                    0 0 16px rgba(76, 175, 80, 0.75);
                transform: scale(1.22);
            }
            100% {
                box-shadow:
                    0 0 0 0 rgba(76, 175, 80, 0),
                    0 0 4px rgba(76, 175, 80, 0.35);
                transform: scale(1);
            }
        }

        /* ---- body ---- */
        .body { min-width: 0; }
        .line1 {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
        }
        /* Primary identifier on line1 — folder basename (the project the user
           is in). Falls back to the tab title when cwd isn't reported. Single
           line with end-ellipsis; the full path lives on line3 (.path-sub). */
        .primary {
            font-size: 17px;
            font-weight: 500;
            color: var(--gt-text);
            line-height: 1.3;
            flex: 1 1 auto;
            min-width: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .attn {
            width: 8px;
            height: 8px;
            border-radius: 99px;
            background: var(--gt-st-perm);
            flex: none;
            animation: ht-attn 1.2s ease-in-out infinite;
        }
        @keyframes ht-attn { 50% { opacity: 0.25; } }

        .line2 {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 5px;
            min-width: 0;
        }
        .status {
            font-size: 15px;
            font-weight: 500;
            white-space: nowrap;
            flex: none;
        }
        .status[data-status="working"]          { color: var(--gt-st-working); }
        .status[data-status="idle"]             { color: var(--gt-st-ready); }
        .status[data-status="no_ai"]            { color: var(--gt-text-faint); }
        .status[data-status="needs_permission"] { color: var(--gt-st-perm); font-weight: 600; }
        .status[data-status="done"]             { color: var(--gt-st-done); font-weight: 600; }

        /* Inline subagent-count pill on line2 ("· 2 agents"). Leading bullet
           via ::before so the template doesn't carry literal separators. The
           .accent variant uses brand honey so the backgrounded-work indicator
           pops. Shrinks/clips rather than pushing status off-row on narrow
           sidebars. */
        .micro {
            font-family: var(--gt-mono);
            font-size: 12.5px;
            font-weight: 500;
            color: var(--gt-text-faint);
            white-space: nowrap;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            flex: 0 1 auto;
        }
        .micro::before {
            content: "· ";
            color: var(--gt-text-faint);
            opacity: 0.6;
        }
        .micro.accent {
            color: var(--gt-accent);
            font-weight: 600;
        }

        .line3 {
            display: flex;
            align-items: flex-start;
            margin-top: 4px;
            min-width: 0;
        }
        /* Full path under the folder name — mono, dim, up to 2 lines. Long
           paths are pre-truncated with a middle '…' by displayCwd, so the
           END (most specific directory) is always visible. */
        .path-sub {
            font-family: var(--gt-mono);
            font-size: 13.5px;
            line-height: 1.35;
            color: var(--gt-text-faint);
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 2;
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
            gap: 6px;
            align-self: flex-start;
            padding-top: 2px;
        }
        .age {
            font-family: var(--gt-mono);
            font-size: 13.5px;
            color: var(--gt-text-faint);
        }

        /* ---- tool tag ---- */
        .tag {
            font-family: var(--gt-mono);
            font-size: 12.5px;
            font-weight: 600;
            padding: 4px 7px;
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
            gap: 12px;
            padding: 11px 16px;
            border-top: 1px solid var(--gt-border);
            font-family: var(--gt-mono);
            font-size: 12px;
            color: var(--gt-text-dim);
        }
        .sb-footer .stat {
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .sb-footer .stat i {
            width: 8px;
            height: 8px;
            border-radius: 99px;
            display: block;
        }
        .sb-footer .stat.work          { color: var(--gt-st-working); }
        .sb-footer .stat.work i        { background: var(--gt-st-working); }
        .sb-footer .stat.idle          { color: var(--gt-text-dim); }
        .sb-footer .stat.idle i        { background: var(--gt-st-idle); }
        .sb-footer .stat.attn-stat     { color: var(--gt-st-perm); }
        .sb-footer .stat.attn-stat i   { background: var(--gt-st-perm); }
        .sb-footer .stat.done-stat     { color: var(--gt-st-done); font-weight: 600; }
        .sb-footer .stat.done-stat i   { background: var(--gt-st-done); }

        /* ---- bottom action row (screenshot etc.) ----
           Sits below the aggregate-stats footer. Always visible — the button
           must be reachable even when no AI tabs are open (the user might
           want to capture something to share into a shell they're about to
           start). */
        .sb-actions {
            display: flex;
            align-items: center;
            gap: 9px;
            padding: 10px 14px 14px;
            border-top: 1px solid var(--gt-border);
        }
        .action-btn {
            /* Icon-only feature buttons. Fixed compact square so the row
               packs left-to-right as more buttons get added later — not a
               stretching grid that resizes every existing button.
               box-sizing: border-box so the 1px border is INSIDE the 32px
               height — without it the standalone .action-btn ended up 34px
               tall while the split-action wrapper rendered at 32px, making
               the screenshot group look slightly taller than its neighbours.
               line-height: 1 + vertical-align: middle defend against the
               browser sneaking in a font/baseline-driven gap at the bottom
               of inline-level flex containers (which was making the camera
               group still read as ~1px taller than its neighbours). */
            box-sizing: border-box;
            flex: 0 0 auto;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 32px;
            min-height: 32px;
            max-height: 32px;
            padding: 0;
            margin: 0;
            line-height: 1;
            vertical-align: middle;
            border-radius: 8px;
            background: var(--gt-surface-2);
            border: 1px solid var(--gt-border);
            color: var(--gt-text-dim);
            cursor: pointer;
            transition: background-color 0.13s ease, color 0.13s ease,
                        border-color 0.13s ease, transform 0.06s ease;
        }
        .action-btn:hover {
            background: var(--gt-accent-soft);
            border-color: rgba(255, 170, 85, 0.45);
            color: var(--gt-accent);
        }
        .action-btn:active { transform: translateY(0.5px); }
        .action-btn:disabled {
            opacity: 0.55;
            cursor: progress;
        }
        .action-btn.busy { color: var(--gt-accent); }
        /* "Available but not useful right now" — visually dim like :disabled,
           but the button stays clickable so onScreenshot() can fire a toast
           explaining why nothing happened. Cursor stays default (not progress)
           so the user can tell this from an in-flight capture. */
        .action-btn.muted:not(:disabled) {
            opacity: 0.55;
        }
        .action-btn.muted:not(:disabled):hover {
            opacity: 1;
        }
        .action-btn.active {
            background: var(--gt-accent-soft);
            border-color: rgba(255, 170, 85, 0.55);
            color: var(--gt-accent);
        }
        .action-btn svg { flex: none; }

        /* Split-button group: the main action sits flush against a narrow
           caret that opens a popover menu. We keep the visual footprint close
           to a normal action-btn by making the caret slim (14px wide) and
           collapsing the shared border between the two halves.
           Explicit display:flex (NOT inline-flex) + explicit 32px height
           is the belt-and-braces fix for "screenshot group reads a hair
           taller than its neighbours": inline-flex containers sit on the
           text baseline of the parent flex row, which on some font/zoom
           combos adds a sub-pixel of descender room below the children.
           Block-level flex sidesteps it. */
        .split-action {
            position: relative;
            display: flex;
            align-items: center;
            height: 32px;
            box-sizing: border-box;
            flex: 0 0 auto;
            line-height: 1;
            vertical-align: middle;
        }
        .split-action .action-btn.split-main {
            border-top-right-radius: 0;
            border-bottom-right-radius: 0;
            border-right: none;
        }
        .split-action .action-btn.split-caret {
            width: 14px;
            padding: 0;
            border-top-left-radius: 0;
            border-bottom-left-radius: 0;
            border-left: 1px solid var(--gt-border);
            color: var(--gt-text-faint);
        }
        .split-action .action-btn.split-caret:hover {
            color: var(--gt-accent);
        }
        .split-action .action-btn.split-caret.open {
            background: var(--gt-accent-soft);
            border-color: rgba(255, 170, 85, 0.55);
            color: var(--gt-accent);
        }

        /* Popover menu — anchored to the split-action group, opens upward so
           it doesn't clip below the sidebar footer. Default anchors to the
           left edge of the group (screenshot menu lives at left side of the
           toolbar). The .right-anchored modifier flips for groups that live
           at the right edge of the sidebar (settings cluster), so the menu
           doesn't run off the right boundary. */
        .action-menu {
            position: absolute;
            bottom: calc(100% + 6px);
            left: 0;
            min-width: 220px;
            padding: 5px;
            background: var(--gt-surface-1);
            border: 1px solid var(--gt-border);
            border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
            z-index: 50;
        }
        .action-menu.right-anchored {
            left: auto;
            right: 0;
        }
        .action-menu-item {
            display: flex;
            align-items: center;
            gap: 9px;
            width: 100%;
            padding: 7px 9px;
            background: transparent;
            border: none;
            border-radius: 5px;
            color: var(--gt-text);
            font: inherit;
            font-size: 13px;
            text-align: left;
            cursor: pointer;
        }
        .action-menu-item:hover {
            background: var(--gt-surface-3);
        }
        .action-menu-item .check {
            flex: none;
            color: var(--gt-accent);
        }
        .action-menu-item .lbl {
            flex: 1;
            white-space: nowrap;
        }

        /* Settings cluster lives at the right end of the action row, pushed
           right via margin-left:auto on its split-action wrapper. Wrapping in
           a .split-action keeps the gear button + popover positioning
           identical to the screenshot menu pattern. */
        .split-action.settings-action { margin-left: auto; }
        /* Open state mirrors the screenshot caret's open style: accent wash
           + accent border + accent color, so it visibly reads as "menu is up"
           the same way across the toolbar. */
        .action-btn.settings-btn.open {
            background: var(--gt-accent-soft);
            border-color: rgba(255, 170, 85, 0.55);
            color: var(--gt-accent);
        }

        @media (prefers-reduced-motion: reduce) {
            .dot[data-status="working"],
            .attn { animation: none !important; }
        }
    `],
})
export class AiSidebarComponent implements OnInit, OnDestroy {
    states: TabState[] = []
    /**
     * True when the focused inner tab is one of our recognised AI agents
     * (`aiTool != null` AND `status != 'no_ai'`). Gates the *enabled* state
     * of the per-tab AI toolbar buttons (screenshot, open-split). The
     * buttons are always rendered — disabling rather than unmounting keeps
     * the close-split action reachable after an agent exits or focus moves
     * to the shell side of the split.
     */
    activeIsAi = false
    filterMode: FilterId = 'all'
    /** Pill definitions — order is render order, left → right. Mirrors the
     *  attention-priority sort: blocking-on-user first, then "your turn",
     *  then the non-attention buckets in their natural reading order. */
    readonly FILTERS: ReadonlyArray<{ id: FilterId; label: string }> = [
        { id: 'all',              label: 'All' },
        { id: 'needs_permission', label: 'Needs You' },
        { id: 'done',             label: 'Done' },
        { id: 'working',          label: 'Working' },
        { id: 'idle',             label: 'Idle' },
    ]
    private sub?: Subscription
    private activeTabSub?: Subscription
    private unreadSub?: Subscription
    private tabOpenedSub?: Subscription
    private splitTabSubs = new Map<BaseTabComponent, Subscription[]>()
    private home = os.homedir()
    capturing = false
    screenshotMenuOpen = false
    settingsMenuOpen = false
    @ViewChild('screenshotSplit', { static: false }) private screenshotSplitEl?: ElementRef<HTMLElement>
    @ViewChild('settingsSplit',   { static: false }) private settingsSplitEl?:   ElementRef<HTMLElement>

    /**
     * Sort-position pin for the just-clicked row. When you click a `done` row,
     * the unread flag clears (focus → markRead) and effStatus flips done →
     * idle in the same tick — that demotes the row from sort-rank 0 to 3, so
     * the row teleports out from under your cursor while its dot recolours.
     * Disorienting: you can't tell what you just clicked.
     *
     * The fix: hold the row's pre-click sort rank for PIN_MS so the row
     * doesn't move; the dot still recolours (with a CSS transition) so the
     * "ack, I saw your click" feedback survives. After PIN_MS the natural
     * sort takes over and the row slides to its new bucket.
     *
     * The pin is dropped early when the row's raw `TabState.status` changes
     * (a real external event from the monitor) so genuinely new state is
     * always immediately visible. Only the done→idle flip-on-focus, which
     * leaves raw status as `'idle'`, gets suppressed.
     *
     * Keyed by innerTab (same key visibleStates groups by) so split panes
     * stay independent.
     */
    private pinnedRank = new Map<BaseTabComponent, number>()
    private pinnedRawStatusAtPin = new Map<BaseTabComponent, TabState['status']>()
    private readonly PIN_MS = 2000

    /**
     * Cwds we've observed at least once during THIS session run — the gate
     * that lets `prunePinnedCwds` distinguish "user closed this tab" (cwd
     * was seen earlier, now gone → prune) from "session-restore hasn't
     * brought the tab back yet" (cwd never seen yet this session → keep
     * the pin, the tab may still load).
     *
     * Without this gate, restart would clear every pin on the very first
     * tick before Tabby finished restoring tabs — the persisted set would
     * be wiped by the same mechanism meant to clean up after a close.
     */
    private seenPinCwdsThisSession = new Set<string>()

    /**
     * Two attention buckets float to the top — that's the whole point of the
     * sidebar — and *everything else stays in Tabby's top-bar order*.
     *
     *   0. needs_permission — AI is blocked waiting on you, fix it first
     *   1. done             — AI finished a turn, your reply queued
     *   2. (rest)           — working / idle / no_ai all flat: position
     *                         tracks Tabby's tab bar, so spatial memory works
     *
     * Why not put `working` above `idle` like we used to? The dot already
     * encodes "this one is alive" (green breathing pulse) — encoding it a
     * *second* time in vertical position just made the list re-sort every
     * time a tab transitioned working→idle or vice versa, with zero
     * information gain. Spatial memory > duplicate visual encoding.
     *
     * `no_ai` (plain shells) sits in its natural Tabby-bar position rather
     * than being buried at the bottom — those are part of the workflow,
     * not noise. CSS already lowers their opacity (.row[data-status="no_ai"])
     * so they're visually de-emphasised without needing to be re-ordered.
     */
    private static readonly STATUS_RANK: Record<TabState['status'], number> = {
        needs_permission: 0,
        done:             1,
        working:          2,
        idle:             2,
        no_ai:            2,
    }

    constructor (
        public app: AppService,
        public monitor: TabMonitor,
        private platform: PlatformService,
        private unread: UnreadService,
        private screenshot: ScreenshotService,
        private screenshotPaste: ScreenshotPasteService,
        private splitShell: SplitShellService,
        private config: ConfigService,
        private notifications: NotificationsService,
        private zone: NgZone,
        private autoApprove: AutoApproveService,
    ) {}

    /**
     * Read-through to the persisted setting. The `?.` reaches all the way
     * through `store` itself — ConfigService loads `store` asynchronously
     * (config.service.ts:226) and component getters run during early CD
     * passes before that resolves. Default true matches the default declared
     * in AiSidebarConfigProvider, so the speaker icon starts in the "on"
     * state during the load window.
     */
    get soundOnReady (): boolean {
        return this.config.store?.ai?.soundOnReady !== false
    }

    /**
     * Flip the chime setting and persist. AttentionNotifierService reads
     * `config.store.ai.soundOnReady` per-chime, so the new value takes
     * effect on the very next working → done transition with no restart.
     * `ai` is a structural default in AiSidebarConfigProvider, so ConfigProxy
     * guarantees `store.ai` exists once `store` itself is loaded — no need
     * to seed it.
     */
    toggleSoundOnReady (): void {
        this.config.store.ai.soundOnReady = !this.soundOnReady
        void this.config.save()
    }

    /**
     * Read-through to the persisted auto-approve setting. Default false —
     * matches AiSidebarConfigProvider — so the shield icon starts in the
     * "off" state during the config-load window.
     */
    get autoApprovePermissions (): boolean {
        return this.autoApprove.enabled
    }

    /**
     * Flip the auto-approve switch. Enabling goes through
     * AutoApproveService.enable() which pops a confirm dialog first — we
     * never want a stray click to grant the AI unconditional run rights.
     * Disabling is one click, no dialog: backing off should be frictionless.
     */
    async toggleAutoApprove (): Promise<void> {
        if (this.autoApprovePermissions) {
            await this.autoApprove.disable()
        } else {
            await this.autoApprove.enable()
        }
    }

    /**
     * Read-through to the persisted setting. Default `true` matches
     * AiSidebarConfigProvider — when the store hasn't loaded yet we still
     * read as "hide enabled" so the menu's checkmark matches the actual
     * behavior the ScreenshotService will apply on its own first-read.
     */
    get screenshotHideWindow (): boolean {
        return this.config.store?.ai?.screenshotHideWindow !== false
    }

    toggleScreenshotHideWindow (): void {
        this.config.store.ai.screenshotHideWindow = !this.screenshotHideWindow
        void this.config.save()
        // Close the menu after the choice — single-item menu, no reason to
        // linger and force a second click.
        this.screenshotMenuOpen = false
    }

    toggleScreenshotMenu (ev: MouseEvent): void {
        // The document:click listener uses contains() to keep the menu open
        // when the click is inside the split-action group. We still call
        // stopPropagation here as belt-and-braces against future ancestors
        // (e.g. a row-click handler on `.sb-actions`) intercepting the event.
        ev.stopPropagation()
        this.screenshotMenuOpen = !this.screenshotMenuOpen
        if (this.screenshotMenuOpen) this.settingsMenuOpen = false
    }

    /**
     * Toggle the global-settings popover. Mutual-exclusion: opening this
     * closes the screenshot menu (and vice versa) — two popovers stacked
     * upward in the same row of the sidebar would overlap. stopPropagation
     * for the same reason as toggleScreenshotMenu.
     */
    toggleSettingsMenu (ev: MouseEvent): void {
        ev.stopPropagation()
        this.settingsMenuOpen = !this.settingsMenuOpen
        if (this.settingsMenuOpen) this.screenshotMenuOpen = false
    }

    /**
     * Close the popover when the user clicks anywhere outside the
     * split-action group. We let clicks INSIDE the group through (the caret
     * toggle and the menu items handle their own state) — contains() covers
     * both the buttons and the menu, which is rendered as a child of the
     * group.
     */
    @HostListener('document:click', ['$event'])
    onDocumentClick (ev: MouseEvent): void {
        if (this.screenshotMenuOpen) {
            const host = this.screenshotSplitEl?.nativeElement
            const inside = host && ev.target instanceof Node && host.contains(ev.target)
            if (!inside) this.zone.run(() => { this.screenshotMenuOpen = false })
        }
        if (this.settingsMenuOpen) {
            const host = this.settingsSplitEl?.nativeElement
            const inside = host && ev.target instanceof Node && host.contains(ev.target)
            if (!inside) this.zone.run(() => { this.settingsMenuOpen = false })
        }
    }

    @HostListener('document:keydown.escape')
    onEscape (): void {
        if (this.screenshotMenuOpen) {
            this.zone.run(() => { this.screenshotMenuOpen = false })
        }
        if (this.settingsMenuOpen) {
            this.zone.run(() => { this.settingsMenuOpen = false })
        }
    }

    async onSplitShell (): Promise<void> {
        await this.splitShell.toggleShellInCurrentTab('r')
        // tabsService.create / addTab dispatch through Tabby internals that
        // can resolve outside the Angular zone, so the `[class.active]` /
        // `[disabled]` bindings on this button would otherwise stay stale
        // until the next tab-monitor poll (~1.5 s). Re-enter the zone to
        // flush a CD pass now.
        this.zone.run(() => { /* trigger CD */ })
    }

    /**
     * Drives the button's open/close icon state. Called per change-detection
     * cycle (no OnPush in this component); the underlying resolution scans
     * `activeTab.getAllTabs()` for our marker, which is O(leaves) — fine at
     * the typical 1–4 panes per tab.
     */
    isSplitOpenInActiveTab (): boolean {
        return this.splitShell.isOpenIn(this.app.activeTab)
    }

    /**
     * Capture flow: open the WeChat-style overlay, then route the cropped PNG
     * through the per-agent paste adapter (Claude first, fallback = generic).
     * `capturing` flips the button into a disabled / "Capturing…" state so
     * users don't double-trigger.
     */
    async onScreenshot (): Promise<void> {
        if (this.capturing) return
        // Non-AI tab: the paste step has no target. Tell the user instead of
        // silently dropping the click — disabling the button leaves users
        // wondering whether it's broken.
        if (!this.activeIsAi) {
            this.notifications.info('Focus an AI agent tab (Claude, Codex, …) to use screenshot paste.')
            return
        }
        // Close the options popover if it's open — clicking the main action
        // means "I'm done configuring, go". The document:click handler treats
        // the whole split-action group as "inside" so it wouldn't auto-close.
        this.screenshotMenuOpen = false
        this.capturing = true
        try {
            const result = await this.screenshot.capture()
            if (!result) return   // user cancelled or capture failed
            await this.screenshotPaste.paste(result.buffer)
        } finally {
            this.capturing = false
        }
    }

    screenshotTitle (): string {
        if (this.capturing) return 'Capture in progress…'
        if (!this.activeIsAi) return 'Focus an AI agent tab to enable screenshot paste'
        return 'Take a screenshot — drag to select, annotate, then confirm to paste the path into the focused AI agent.'
    }

    splitTitle (): string {
        if (this.isSplitOpenInActiveTab()) return 'Close shell split'
        return 'Open shell in current tab CWD'
    }

    splitAriaLabel (): string {
        if (this.isSplitOpenInActiveTab()) return 'Close the shell pane GlanceTerm opened in this tab'
        return 'Open a local shell split to the right of the focused tab, with CWD inherited from the focused pane'
    }

    ngOnInit (): void {
        this.sub = this.monitor.states$.subscribe(s => {
            // Bounce through zone — the BehaviorSubject's notifications can
            // resolve outside Angular's zone after a few ticks (the monitor's
            // setInterval was set up in zone, but rxjs scheduling drift can
            // still escape it), and our `[class.active]` / `[disabled]` bindings
            // on the toolbar buttons need CD to re-read isSplitOpenInActiveTab()
            // after each poll. Without this the split button stays stuck on its
            // boot-time state until something else (tab switch, hover) triggers
            // CD.
            this.zone.run(() => {
                this.states = s
                this.dropStalePins(s)
                this.recomputeActiveIsAi()
            })
        })
        // Tab switches don't change `states`, but they do change which row is
        // "active" — so the toolbar's enabled state (`activeIsAi`) needs to
        // re-evaluate. AppService emits outside the Angular zone in some
        // paths (focus restoration), so re-enter the zone to keep the
        // bindings reactive.
        this.activeTabSub = this.app.activeTabChange$.subscribe(() => {
            this.zone.run(() => this.recomputeActiveIsAi())
        })
        // tabOpened$ fires for every restored tab during boot. Each event is
        // a chance for isSplitOpenInActiveTab() to flip true (the moment the
        // SplitTab finishes its async recovery and the inner pane carrying
        // our env-persisted flag becomes reachable via getAllTabs()). Without
        // this hook the button stays inactive for up to ~1.5 s after boot —
        // until the first monitor poll lands — which reads as "didn't
        // remember my split".
        this.tabOpenedSub = this.app.tabOpened$.subscribe(tab => {
            this.zone.run(() => this.watchSplitTab(tab))
            this.recomputeActiveIsAi()
        })
        // Also watch any tabs that were already present at mount time
        // (singleton-revived case, or a sidebar that mounted late).
        for (const tab of this.app.tabs) {
            this.watchSplitTab(tab)
        }
        // Unread set membership is what derives the `done` display status from
        // a raw `idle`. The monitor's 1.5 s poll would eventually re-render
        // anyway, but a focus-clear should flip done → ready instantly — so
        // we subscribe to unread.count$ and bounce a CD pass through the zone.
        // The subject also fires when `markReady` adds a tab, giving us a
        // working → done flip with no perceived lag.
        this.unreadSub = this.unread.count$.subscribe(() => {
            this.zone.run(() => { /* trigger CD */ })
        })
        this.recomputeActiveIsAi()
    }

    /**
     * For a SplitTabComponent (the outer container Tabby uses for AI tabs),
     * subscribe to its tabAdded$/tabRemoved$ so the toolbar's `active` state
     * updates the moment a GlanceTerm-owned inner pane is recovered/destroyed.
     * Plain (non-split) tabs are ignored — they can't host an owned split.
     *
     * The destroyed$ subscription cleans us up when the tab itself goes away,
     * so the Map doesn't leak. Idempotent on already-watched tabs.
     */
    private watchSplitTab (tab: BaseTabComponent): void {
        if (this.splitTabSubs.has(tab)) return
        const inner = (tab as any).tabAdded$ as { subscribe: (fn: () => void) => Subscription } | undefined
        const removed = (tab as any).tabRemoved$ as { subscribe: (fn: () => void) => Subscription } | undefined
        if (!inner || !removed || typeof inner.subscribe !== 'function') return
        const subs: Subscription[] = [
            inner.subscribe(() => this.zone.run(() => { /* trigger CD */ })),
            removed.subscribe(() => this.zone.run(() => { /* trigger CD */ })),
        ]
        this.splitTabSubs.set(tab, subs)
        tab.destroyed$.subscribe(() => {
            for (const s of subs) s.unsubscribe()
            this.splitTabSubs.delete(tab)
        })
    }

    ngOnDestroy (): void {
        this.sub?.unsubscribe()
        this.activeTabSub?.unsubscribe()
        this.unreadSub?.unsubscribe()
        this.tabOpenedSub?.unsubscribe()
        for (const subs of this.splitTabSubs.values()) {
            for (const s of subs) s.unsubscribe()
        }
        this.splitTabSubs.clear()
    }

    /**
     * Render-time projection of the raw `TabState.status` to the displayable
     * `TabStatus` (which adds `'done'`). A raw `idle` row whose innerTab is
     * still in UnreadService — i.e. the agent finished its turn and the user
     * hasn't focused this tab since — surfaces as `done`. Everything else is
     * a pass-through. UnreadService is the source of truth for the flip; the
     * monitor never produces `'done'` directly.
     *
     * Called from many template bindings (`[attr.data-status]`, `*ngIf`,
     * status label, …). Cheap — a Set.has on a WeakSet-sized set, plus one
     * conditional. Memoising would risk drift when the unread set changes.
     */
    effStatus (s: TabState): TabState['status'] {
        if (s.status === 'idle' && this.unread.isUnread(s.innerTab)) return 'done'
        return s.status
    }

    /**
     * Recompute `activeIsAi` from the current `app.activeTab` and the latest
     * state snapshot. We match by inner pane: a focused leaf inside a split
     * may have a different status than its sibling, so we mirror the same
     * "outer match + focused inner" logic the paste service uses for
     * picking the target tab.
     */
    private recomputeActiveIsAi (): void {
        const active = this.app.activeTab
        if (!active) { this.activeIsAi = false; return }
        const focusedInner = focusedInnerOf(active)
        const match = this.states.find(s => s.outerTab === active && s.innerTab === focusedInner)
            ?? this.states.find(s => s.outerTab === active)
        this.activeIsAi = !!(match && match.aiTool && this.effStatus(match) !== 'no_ai')
    }

    /**
     * Tabs we render. Only the two "you have to act" states float to the top;
     * everything else mirrors Tabby's top-bar tab order so spatial memory
     * works (the 3rd row from top stays the 3rd row from top as long as no
     * attention event interrupts).
     *
     * Two-stage layout:
     *   1. Sort PRIMARIES (one per outer tab) by (pinnedRank ?? STATUS_RANK,
     *      tabIdx).
     *   2. Glue each primary's SUBORDINATES (other leaves of the same outer
     *      tab, in their split-pane order) directly underneath. Subordinates
     *      never participate in status-rank sorting — a `working` shell pane
     *      in an idle AI tab still rides under the idle AI, not into the
     *      Working bucket.
     *
     * Within any rank tier we fall back to Tabby's tab-bar order — STABLE,
     * so tabs only move when their attention status changes, not when their
     * elapsed timer ticks. See STATUS_RANK doc for the bucket layout.
     *
     * Filtering: a primary survives the filter when itself OR any of its
     * subordinates matches the chosen status. This keeps the filtered view
     * in sync with the pill counts (each row counted by its own effStatus)
     * — a `working` shell pane riding under an `idle` AI still surfaces the
     * pair under the Working filter. Subordinates ride along regardless of
     * their own status so the connector bracket always points somewhere.
     *
     * NOTE: ranking and filtering both go through `effStatus`, not the raw
     * `s.status` from the monitor. The monitor never produces `'done'` — it's
     * derived from raw `idle + isUnread`.
     */
    get visibleStates (): TabState[] {
        const rank = AiSidebarComponent.STATUS_RANK
        const tabIdx = (s: TabState): number => {
            const i = this.app.tabs.indexOf(s.outerTab)
            return i < 0 ? Number.MAX_SAFE_INTEGER : i
        }
        const rankOf = (s: TabState): number => {
            // User-driven pin wins over everything else — even the click-pin
            // and even needs_permission (the user explicitly asked for this
            // row to live at the top; respect it). Negative so it slots
            // above STATUS_RANK[needs_permission] = 0.
            if (this.isPinned(s)) return -1
            const pinned = this.pinnedRank.get(s.innerTab)
            if (pinned !== undefined) return pinned
            return rank[this.effStatus(s)] ?? 99
        }
        // Group by outer tab so we can pick a primary per group AND ride
        // subordinates along under their primary's filter decision.
        const byOuter = new Map<BaseTabComponent, TabState[]>()
        for (const s of this.states) {
            const arr = byOuter.get(s.outerTab) ?? []
            arr.push(s)
            byOuter.set(s.outerTab, arr)
        }
        const fm = this.filterMode
        const primaryOf = (group: TabState[]): TabState => this.pickPrimary(group)
        const groupMatches = (group: TabState[]): boolean =>
            fm === 'all' || group.some(s => this.effStatus(s) === fm)
        const visiblePrimaries: TabState[] = []
        const subsByOuter = new Map<BaseTabComponent, TabState[]>()
        for (const [outer, group] of byOuter) {
            if (!groupMatches(group)) continue
            const p = primaryOf(group)
            visiblePrimaries.push(p)
            const subs = group.filter(s => s !== p)
            if (subs.length > 0) subsByOuter.set(outer, subs)
        }
        visiblePrimaries.sort((a, b) => {
            const dr = rankOf(a) - rankOf(b)
            if (dr !== 0) return dr
            return tabIdx(a) - tabIdx(b)
        })
        const out: TabState[] = []
        for (const p of visiblePrimaries) {
            out.push(p)
            const subs = subsByOuter.get(p.outerTab)
            if (subs) out.push(...subs)
        }
        return out
    }

    /**
     * Per outer tab, pick the leaf that represents the tab in the sidebar's
     * primary row. Preference order:
     *   1. The first leaf whose effStatus is NOT `no_ai` (i.e. an AI pane).
     *      A running AI is what users care about; if the user split-left a
     *      plain shell next to their AI, the AI still gets to be primary.
     *   2. Otherwise the first leaf in pane order (= `getAllTabs()` order).
     *
     * The chosen primary represents the tab in the sort/filter/rank pipeline;
     * every other leaf in the same outer tab is rendered as a subordinate
     * row below it.
     */
    private pickPrimary (group: TabState[]): TabState {
        return group.find(s => this.effStatus(s) !== 'no_ai') ?? group[0]
    }

    /**
     * True when this row is a non-primary leaf inside a SplitTabComponent.
     * Whether it's an AI agent or a plain shell doesn't matter: subordinates
     * render with the same content & layout as a primary row (real status,
     * tool tag, cwd, age) but get a dashed connector to the row above and
     * skip status-rank sorting so they stay glued under their primary.
     *
     * See `pickPrimary` for how the primary is chosen within an outer tab.
     */
    isSubordinate (s: TabState): boolean {
        if (s.outerTab === s.innerTab) return false
        const group = this.states.filter(o => o.outerTab === s.outerTab)
        if (group.length <= 1) return false
        return this.pickPrimary(group) !== s
    }

    /**
     * Drop any sort-pin whose underlying row has a different raw status from
     * what it had at pin time. That's our signal that the change isn't just
     * "click cleared unread" — it's a real new event from the monitor (AI
     * started working, requested permission, etc.) — and the row should be
     * allowed to jump to its new bucket immediately.
     *
     * Pins on rows that have disappeared from the state list (tab closed)
     * also get cleared.
     */
    private dropStalePins (states: TabState[]): void {
        // Drop click-pins on rows whose raw status has changed (the original
        // signal for "the click feedback isn't the latest story anymore")
        // or rows that have disappeared entirely (tab closed).
        if (this.pinnedRank.size > 0) {
            const byInner = new Map(states.map(s => [s.innerTab, s.status]))
            for (const innerTab of [...this.pinnedRank.keys()]) {
                const nowStatus = byInner.get(innerTab)
                const pinStatus = this.pinnedRawStatusAtPin.get(innerTab)
                if (nowStatus === undefined || nowStatus !== pinStatus) {
                    this.pinnedRank.delete(innerTab)
                    this.pinnedRawStatusAtPin.delete(innerTab)
                }
            }
        }
        // Drop user-pinned cwds for tabs that have disappeared from the
        // live state list (close removes pin per the v1.1 requirement).
        // The "seen-this-session" gate prevents over-eager pruning during
        // app startup, when Tabby's session-restore hasn't yet repopulated
        // the tab list but the persisted pinnedCwds are already loaded.
        this.prunePinnedCwds(states)
    }

    /**
     * Two-phase prune of the persisted pinnedCwds list:
     *   1. Mark every live tab's cwd as "seen this session" so future
     *      ticks can confidently prune it on disappearance.
     *   2. For each persisted pinned cwd: if we've seen it this session
     *      AND it's no longer in the live list, it's been closed → drop
     *      from config. If we've never seen it this session, leave it —
     *      a restored tab may bring it back later.
     *
     * Writes to config only when the list actually shrinks, to avoid a
     * spurious ConfigService.changed$ emit per poll (which would re-fire
     * AutoApproveService's flag sync, sound-chime config readers, etc.).
     */
    private prunePinnedCwds (states: TabState[]): void {
        const liveCwds = new Set<string>()
        for (const s of states) {
            if (s.cwd) liveCwds.add(s.cwd)
        }
        for (const cwd of liveCwds) this.seenPinCwdsThisSession.add(cwd)

        const current = this.pinnedCwds
        if (current.length === 0) return
        const kept = current.filter(cwd => liveCwds.has(cwd) || !this.seenPinCwdsThisSession.has(cwd))
        if (kept.length === current.length) return
        this.config.store.ai.pinnedCwds = kept
        void this.config.save()
    }

    /** Set or toggle the filter. Clicking the active pill resets to 'all'. */
    setFilter (id: FilterId): void {
        this.filterMode = this.filterMode === id && id !== 'all' ? 'all' : id
    }

    /** Pill counter — `All` counts every tab; the others count their bucket. */
    countFor (id: FilterId): number {
        if (id === 'all') return this.states.length
        return this.states.filter(s => this.effStatus(s) === id).length
    }

    filterLabel (): string {
        switch (this.filterMode) {
            case 'done':             return 'finished tabs you haven’t opened'
            case 'needs_permission': return 'tabs need you right now'
            case 'working':          return 'working tabs'
            case 'idle':             return 'idle tabs'
            default:                 return 'tabs'
        }
    }

    get countWorking (): number {
        return this.states.filter(s => this.effStatus(s) === 'working').length
    }

    get countIdle (): number {
        return this.states.filter(s => this.effStatus(s) === 'idle').length
    }

    get countAttn (): number {
        return this.states.filter(s => this.effStatus(s) === 'needs_permission').length
    }

    get countDone (): number {
        return this.states.filter(s => this.effStatus(s) === 'done').length
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
        // Freeze the row's sort position BEFORE focus runs, so the unread
        // flip triggered by selectTab doesn't yank the row out from under
        // the click. See `pinnedRank` doc for the full rationale. Subordinate
        // rows don't participate in status-rank sort (visibleStates only
        // sorts primaries), so we skip the pin for them — it would be a
        // wasted timer + map write.
        if (!this.isSubordinate(s)) {
            const preClickRank = AiSidebarComponent.STATUS_RANK[this.effStatus(s)] ?? 99
            this.pinnedRank.set(s.innerTab, preClickRank)
            this.pinnedRawStatusAtPin.set(s.innerTab, s.status)
            setTimeout(() => {
                this.pinnedRank.delete(s.innerTab)
                this.pinnedRawStatusAtPin.delete(s.innerTab)
                // setTimeout is zone-patched → CD picks this up automatically.
            }, this.PIN_MS)
        }

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
        switch (this.effStatus(s)) {
            case 'working':          return 'working'
            case 'needs_permission': return 'needs you'
            case 'done':             return 'done'
            case 'idle':             return 'ready'
            case 'no_ai':            return 'shell'
            default:                 return s.status
        }
    }

    ariaLabel (s: TabState): string {
        const a11y: Record<string, string> = {
            working: 'Working — AI responding',
            done: 'Done — agent finished, click to view',
            idle: 'Ready — waiting for you',
            needs_permission: 'Needs permission — decide now',
            no_ai: 'Plain shell, no AI',
        }
        const eff = this.effStatus(s)
        return `${s.title} — ${a11y[eff] || eff}`
    }

    /** Full agent name for the chip on line2. */
    toolTag (tool: string | null): string {
        if (!tool) return ''
        const tags: Record<string, string> = {
            claude:   'Claude',
            codex:    'Codex',
            gemini:   'Gemini',
            opencode: 'OpenCode',
            aider:    'Aider',
            goose:    'Goose',
        }
        return tags[tool] || tool.charAt(0).toUpperCase() + tool.slice(1)
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

    bgJobTitle (s: TabState): string {
        const n = s.backgroundJobCount
        const noun = n === 1 ? 'job' : 'jobs'
        return `${n} background ${noun} running under this agent (immediate child processes of the agent's PID that have persisted across polls — typically backgrounded shells started via the agent's own bg-task mechanism).`
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
     * Trailing folder name (basename) of a cwd. Used as the prominent label
     * on line1 — typically the project the user is working in. Handles both
     * `/` and `\` separators, trims trailing ones, and degrades gracefully
     * for filesystem roots (`/`, `C:\`) by returning the input unchanged.
     */
    folderName (p: string | null): string {
        if (!p) return ''
        const trimmed = p.replace(/[/\\]+$/, '')
        if (!trimmed) return p
        const m = trimmed.match(/[^/\\]+$/)
        return m ? m[0] : p
    }

    /**
     * Tab-row right-click menu. Mirrors the most useful subset of Tabby's
     * own top-bar tab menu, scoped to what an AI-sidebar user typically
     * wants on a row: rename, copy the path, jump to it in Finder, or
     * spawn another shell at the same cwd.
     */
    /** Persisted pin list. Read-only accessor — mutations go through
     *  togglePin() / prunePinnedCwds() so a config save always pairs with
     *  the in-memory change. */
    get pinnedCwds (): string[] {
        return this.config.store?.ai?.pinnedCwds ?? []
    }

    isPinned (s: TabState): boolean {
        return s.cwd != null && this.pinnedCwds.includes(s.cwd)
    }

    async togglePin (s: TabState): Promise<void> {
        // No cwd → no stable persistence key. The context menu disables the
        // item in this case, but guard here too in case someone wires a
        // hotkey to togglePin later.
        if (!s.cwd) return
        const list = [...this.pinnedCwds]
        const i = list.indexOf(s.cwd)
        if (i >= 0) {
            list.splice(i, 1)
        } else {
            list.push(s.cwd)
        }
        this.config.store.ai.pinnedCwds = list
        await this.config.save()
    }

    async onContextMenu (s: TabState, ev: MouseEvent): Promise<void> {
        ev.preventDefault()
        ev.stopPropagation()
        const cwd = s.cwd ?? null
        const pinned = this.isPinned(s)
        const items: MenuItemOptions[] = [
            {
                label: pinned ? 'Unpin from top' : 'Pin to top',
                // Need a cwd to persist against. Tabs that haven't reported
                // one yet (fresh local shell pre-OSC-7) can't be pinned.
                enabled: !!cwd,
                click: () => { void this.togglePin(s) },
            },
            { type: 'separator' },
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

/**
 * Resolve the focused leaf of a tab. For a split tab, `getFocusedTab()`
 * returns the currently-focused pane; for everything else (or if the API
 * throws) the tab itself IS the leaf.
 */
function focusedInnerOf (outer: BaseTabComponent): BaseTabComponent {
    try {
        const fn = (outer as any).getFocusedTab
        if (typeof fn === 'function') {
            const inner = fn.call(outer)
            if (inner) return inner
        }
    } catch { /* fall through */ }
    return outer
}
