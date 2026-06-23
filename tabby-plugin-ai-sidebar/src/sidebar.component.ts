import { Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, TemplateRef, ViewChild } from '@angular/core'
import { Subscription } from 'rxjs'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import * as os from 'os'

import { AppService, BaseTabComponent, ConfigService, MenuItemOptions, NotificationsService, PlatformService } from 'tabby-core'

import { TabMonitor, TabState, TabStatus } from './tab-monitor'
import { UnreadService } from './unread.service'
import { ScreenshotService } from './screenshot/screenshot.service'
import { ScreenshotPasteService } from './screenshot/paste.service'
import { SplitShellService } from './split-shell.service'
import { WorktreeLifecycleService } from './worktree-lifecycle.service'
import { WorktreeActionsService } from './worktree-actions.service'
import { AutoApproveService } from './auto-approve.service'
import { SidebarSettingsRegistry, SidebarSettingsSection } from './sidebar-settings-registry.service'
import { TokenStatsTabComponent } from './token-stats-tab.component'

/**
 * Pill filter ids — a strict subset of TabStatus (`'no_ai'` is excluded
 * since "shell" tabs don't appear in the AI sidebar by default) plus a
 * sentinel `'all'` for the disabled-filter state. Reuses TabStatus values
 * where they overlap so a future TabStatus rename propagates without a
 * silent drift between the filter pill, sidebar row, and footer counts.
 */
const FilterId = {
    All: 'all',
    NeedsPermission: TabStatus.NeedsPermission,
    Done: TabStatus.Done,
    Working: TabStatus.Working,
    Idle: TabStatus.Idle,
} as const
type FilterId = typeof FilterId[keyof typeof FilterId]

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
                <span class="sb-logo" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 100 100">
                        <rect x="13" y="22" width="74" height="56" rx="13" fill="none" stroke="var(--gt-accent)" stroke-width="7"/>
                        <line x1="39" y1="27" x2="39" y2="73" stroke="var(--gt-accent)" stroke-opacity="0.45" stroke-width="5"/>
                        <circle cx="26" cy="35" r="4" fill="var(--gt-st-working)"/>
                        <circle cx="26" cy="50" r="4" fill="var(--gt-accent)"/>
                        <path d="M55 44 L63 50 L55 56" fill="none" stroke="var(--gt-accent)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
                        <rect x="67" y="54" width="13" height="5" rx="2.5" fill="var(--gt-accent)"/>
                    </svg>
                </span>
                <span class="sb-title">Glance<b>Term</b></span>
                <span *ngIf="countAttn > 0" class="sb-attn"><span class="pip"></span>{{ countAttn }} need you</span>
                <span class="sb-grow"></span>
            </div>

            <div class="sb-filters" *ngIf="states.length > 0">
                <button type="button"
                        *ngFor="let f of FILTERS"
                        class="pill"
                        [class.active]="filterMode === f.id"
                        [class.zero]="countFor(f.id) === 0"
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
                <ng-container *ngIf="hideTabsWithoutAgent && filterMode === FilterId.All; else regularFilterEmpty">
                    <div class="et">All hidden</div>
                    <div class="es">Every open tab is a plain shell. Uncheck "Hide tabs without an AI agent" in settings to see them.</div>
                </ng-container>
                <ng-template #regularFilterEmpty>
                    <div class="et">No {{ filterLabel() }}</div>
                    <div class="es">Tap "All" to see every tab.</div>
                </ng-template>
            </div>

            <div *ngIf="visibleStates.length > 0" class="sb-list">
                <div *ngFor="let s of visibleStates; trackBy: trackByTab"
                     class="row"
                     [attr.data-status]="effStatus(s)"
                     [attr.data-tab-id]="s.tabId"
                     [class.active]="isActive(s)"
                     [class.subordinate]="isSubordinate(s)"
                     [class.pinned]="isPinned(s)"
                     [attr.aria-label]="ariaLabel(s)"
                     [attr.title]="s.cwd || s.title"
                     role="button"
                     (click)="onSelect(s)"
                     (contextmenu)="onContextMenu(s, $event)">
                    <div class="rail">
                        <span class="dot" [attr.data-status]="effStatus(s)" aria-hidden="true"></span>
                    </div>
                    <div class="body">
                        <!-- line1 — index · name · pin · status -->
                        <div class="line1">
                            <span class="num" aria-hidden="true">{{ tabIndex(s) }}</span>
                            <span *ngIf="isSubordinate(s)" class="subicon" aria-hidden="true" title="split pane">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7v6a2 2 0 0 0 2 2h6"/></svg>
                            </span>
                            <span class="primary" [attr.title]="s.cwd || s.title">{{ s.cwd ? folderName(s.cwd) : s.title }}</span>
                            <span *ngIf="worktreeBranch(s) as br" class="wt-badge" [attr.title]="'Isolated worktree — ' + br">⎇ {{ br }}</span>
                            <svg *ngIf="isPinned(s)" class="pin-mark" width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" title="Pinned to top">
                                <path d="M9.5 1.5 L14.5 6.5 L12 7.2 L11.5 11 L8.2 7.8 L4 12 L4 11 L8 6.8 L4.8 3.5 L8.5 3 Z"
                                      stroke="currentColor" stroke-width="0.6" stroke-linejoin="round"/>
                            </svg>
                            <span class="l1-sp"></span>
                            <span class="status" [attr.data-status]="effStatus(s)">{{ statusLabel(s) }}</span>
                        </div>

                        <!-- line2 (AI) — neutral agent·model pill · (spacer) · age -->
                        <div class="line2" *ngIf="s.aiTool">
                            <span class="agent-tag" [attr.data-tool]="s.aiTool" [attr.title]="s.model || toolTag(s.aiTool)">
                                <span class="tg" aria-hidden="true">{{ toolGlyph(s.aiTool) }}</span>
                                <span class="agent-name">{{ toolTag(s.aiTool) }}</span>
                                <span *ngIf="s.model" class="agent-model">{{ modelLabel(s.aiTool, s.model) }}</span>
                            </span>
                            <span class="l2-sp"></span>
                            <span class="age" *ngIf="s.lastActiveMs !== null">{{ ageStr(s.lastActiveMs) }}</span>
                        </div>

                        <!-- token usage — its own line: the in/cache/out chip got
                             too wide to share line2 with the agent pill (overflowed
                             the row), so it sits below, left-aligned under the pill. -->
                        <div class="line-tok" *ngIf="s.aiTool && (s.tokensIn || s.tokensOut || s.tokensCacheRead)">
                            <span class="usage tokens" [title]="tokensTitle(s)"><span class="tk"><span class="tk-l">in:</span><span class="tk-v">{{ fmtTokens(s.tokensIn) }}</span></span><span class="tk tk-cache" *ngIf="s.tokensCacheRead"><span class="tk-l">cache:</span><span class="tk-v">{{ fmtTokens(s.tokensCacheRead) }}</span></span><span class="tk"><span class="tk-l">out:</span><span class="tk-v">{{ fmtTokens(s.tokensOut) }}</span></span></span>
                        </div>

                        <!-- line2 (shell) — cwd · age -->
                        <div class="line2" *ngIf="!s.aiTool && s.cwd">
                            <span class="usage shell-cwd" [attr.title]="s.cwd">{{ displayCwd(s.cwd) }}</span>
                            <span class="l2-sp"></span>
                            <span class="age" *ngIf="s.lastActiveMs !== null">{{ ageStr(s.lastActiveMs) }}</span>
                        </div>

                        <!-- line3 — full path (EVERY AI row that has a cwd, not
                             just the focused one, so a row's height is identical
                             focused or not → no reflow/jump when focus moves) +
                             process-tree counts. We surface the process tree
                             GlanceTerm can observe, not terminal text. -->
                        <div class="line3" *ngIf="s.aiTool && (s.cwd || s.subagentCount > 0 || s.backgroundJobCount > 0 || s.monitorCount > 0)">
                            <span class="path-sub" *ngIf="s.cwd" [attr.title]="s.cwd">{{ displayCwd(s.cwd) }}</span>
                            <span class="l3-sp"></span>
                            <span class="conc" *ngIf="s.subagentCount > 0 || s.backgroundJobCount > 0 || s.monitorCount > 0">
                                <span *ngIf="s.subagentCount > 0" [title]="subagentTitle(s)"><b>{{ s.subagentCount }}</b> {{ s.subagentCount === 1 ? 'agent' : 'agents' }}</span>
                                <span *ngIf="s.backgroundJobCount > 0" [title]="bgJobTitle(s)"><b>{{ s.backgroundJobCount }}</b> {{ bgLabel(s) }}</span>
                                <span *ngIf="s.monitorCount > 0" [title]="monitorTitle(s)"><b>{{ s.monitorCount }}</b> {{ s.monitorCount === 1 ? 'monitor' : 'monitors' }}</span>
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <div *ngIf="visibleStates.length > 0" class="sb-footer">
                <span *ngIf="countAttn > 0" class="stat attn-stat"><i></i>{{ countAttn }} need you</span>
                <span *ngIf="countDone > 0" class="stat done-stat"><i></i>{{ countDone }} done</span>
                <span class="stat work"><i></i>{{ countWorking }} working</span>
                <span class="stat idle muted"><i></i>{{ countIdle }} idle</span>
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
                            [ngbTooltip]="screenshotTitle()"
                            [openDelay]="0"
                            placement="top"
                            container="body"
                            aria-label="Take a screenshot and paste it into the focused AI agent">
                        <span *ngIf="capturing" class="spin" aria-hidden="true"></span>
                        <svg *ngIf="!capturing" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M5.2 3.5 L6.3 2.2 L9.7 2.2 L10.8 3.5 L13.2 3.5
                                     A1.5 1.5 0 0 1 14.7 5 V11.8
                                     A1.5 1.5 0 0 1 13.2 13.3 H2.8
                                     A1.5 1.5 0 0 1 1.3 11.8 V5
                                     A1.5 1.5 0 0 1 2.8 3.5 Z"
                                  stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
                            <circle cx="8" cy="8.4" r="2.6" stroke="currentColor" stroke-width="1.2" fill="none"/>
                        </svg>
                        <span class="btn-label">{{ capturing ? 'Capturing…' : 'Screenshot' }}</span>
                    </button>
                    <button type="button"
                            class="action-btn split-caret"
                            [class.open]="screenshotMenuOpen"
                            [class.muted]="!activeIsAi"
                            [disabled]="capturing"
                            (click)="toggleScreenshotMenu($event)"
                            ngbTooltip="Screenshot options"
                            [openDelay]="0"
                            placement="top"
                            container="body"
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
                                role="menuitem"
                                [disabled]="capturing"
                                (click)="onScreenshotHideWindow()">
                            <svg class="check" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                <path d="M2.5 5 L2.5 11.5 A1 1 0 0 0 3.5 12.5 L12.5 12.5 A1 1 0 0 0 13.5 11.5 L13.5 5 M2 4.5 L6 4.5 L7 6 L13.5 6"
                                      stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" opacity="0.55"/>
                                <path d="M8 1.5 L8 5.5 M6 3.5 L8 5.5 L10 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span class="lbl">Hide Window Screenshot</span>
                        </button>
                    </div>
                </div>
                <button type="button"
                        class="action-btn"
                        [class.active]="isSplitOpenInActiveTab()"
                        (click)="onSplitShell()"
                        [ngbTooltip]="splitTitle()"
                        [openDelay]="0"
                        placement="top"
                        container="body"
                        [attr.aria-label]="splitAriaLabel()">
                    <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <rect x="1.5" y="2.5" width="6" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.7"/>
                        <rect x="8.5" y="2.5" width="6" height="11" rx="1"/>
                    </svg>
                </button>
                <!-- Settings button — Material-Design-style gear that
                     opens a centered modal dialog. The previous popover
                     anchored above the toolbar gave each row only one
                     line for a label, which left no room for explanatory
                     copy and forced settings to be either self-evident or
                     misunderstood. The modal pattern fits a title +
                     description + toggle per setting cleanly, and reuses
                     ng-bootstrap's NgbModal so escape/backdrop dismissal
                     and a11y focus-trap are handled for us. -->
                <button type="button"
                        class="action-btn settings-btn"
                        (click)="openSettingsModal()"
                        ngbTooltip="Settings"
                        [openDelay]="0"
                        placement="top"
                        container="body"
                        aria-label="Open AI sidebar settings"
                        aria-haspopup="dialog">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <!-- Material Design "settings" gear: outer 8-toothed
                             ring with a clear circular bore. Universally
                             recognisable as "settings" — beats the previous
                             radial-stroke shape that read as a sun on first
                             glance. -->
                        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94 0 .31.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 0 1 8.4 12c0-1.98 1.62-3.6 3.6-3.6s3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                    </svg>
                </button>
            </div>
        </div>

        <!-- Settings modal template. Lives in the same component template
             so it has direct access to the host's setters; opened via
             NgbModal.open(this.settingsModalTpl) on gear click. Each row
             is a self-contained card with title / description / toggle.
             The toggles are native checkboxes styled as iOS-style
             switches via the gt-switch utility further down in styles. -->
        <ng-template #settingsModalTpl let-modal>
            <div class="gt-settings-modal">
                <div class="gt-settings-header">
                    <h4 class="gt-settings-title">AI sidebar settings</h4>
                    <button type="button" class="gt-settings-close" aria-label="Close" (click)="modal.dismiss()">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M3 3 L13 13 M13 3 L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                        </svg>
                    </button>
                </div>
                <div class="gt-settings-body">
                    <label class="gt-setting-row">
                        <div class="gt-setting-text">
                            <div class="gt-setting-title">Chime on agent done</div>
                            <div class="gt-setting-desc">Play a short tone whenever an AI agent finishes a turn, so you don't have to keep an eye on the sidebar to know when a reply is ready.</div>
                        </div>
                        <input type="checkbox" class="gt-switch" [checked]="soundOnReady" (change)="toggleSoundOnReady()" aria-label="Chime on agent done"/>
                    </label>
                    <label class="gt-setting-row">
                        <div class="gt-setting-text">
                            <div class="gt-setting-title">Auto-approve permission prompts</div>
                            <div class="gt-setting-desc">When Claude asks for permission to run a tool (e.g. a Bash command), GlanceTerm approves it silently instead of pausing for you. Off by default — only enable if you trust what the agent is doing.</div>
                        </div>
                        <input type="checkbox" class="gt-switch" [checked]="autoApprovePermissions" (change)="toggleAutoApprove()" aria-label="Auto-approve permission prompts"/>
                    </label>
                    <label class="gt-setting-row">
                        <div class="gt-setting-text">
                            <div class="gt-setting-title">Hide tabs without an AI agent</div>
                            <div class="gt-setting-desc">Suppress plain shells (no Claude / Codex / Gemini running in them) from the sidebar list. Pinned tabs always show through regardless of this setting.</div>
                        </div>
                        <input type="checkbox" class="gt-switch" [checked]="hideTabsWithoutAgent" (change)="toggleHideTabsWithoutAgent()" aria-label="Hide tabs without an AI agent"/>
                    </label>
                    <label class="gt-setting-row">
                        <div class="gt-setting-text">
                            <div class="gt-setting-title">Resume agent sessions on restart</div>
                            <div class="gt-setting-desc">When a tab comes back after you quit and reopen GlanceTerm, automatically relaunch the AI agent that was running in it and continue its previous session — instead of leaving you a bare shell to re-type the command into. On by default.</div>
                        </div>
                        <input type="checkbox" class="gt-switch" [checked]="autoResumeAgents" (change)="toggleAutoResumeAgents()" aria-label="Resume agent sessions on restart"/>
                    </label>
                    <label class="gt-setting-row">
                        <div class="gt-setting-text">
                            <div class="gt-setting-title">Warn when closing a tab with a running process</div>
                            <div class="gt-setting-desc">Show the "… is still running. Close?" prompt on quit. Off by default — an AI-agent tab almost always has a process running, so it would otherwise prompt once per tab every time you quit. Turn on to restore the safety check.</div>
                        </div>
                        <input type="checkbox" class="gt-switch" [checked]="warnOnCloseRunning" (change)="toggleWarnOnCloseRunning()" aria-label="Warn when closing a tab with a running process"/>
                    </label>
                    <div class="gt-setting-row gt-setting-row-action" (click)="openTokenStats()">
                        <div class="gt-setting-text">
                            <div class="gt-setting-title">Token usage</div>
                            <div class="gt-setting-desc">Total in / cache / out across all sessions — by agent / session / project, with time windows and CSV export.</div>
                        </div>
                        <button type="button" class="gt-section-btn" (click)="openTokenStats(); $event.stopPropagation()" aria-label="Open Token usage">Open…</button>
                    </div>

                    <!-- Plugin-contributed sections (currently:
                         tabby-plugin-mobile-bridge). Rendered as a row with
                         a "Configure…" button rather than inlined because
                         the contributed UI is too large for an at-a-glance
                         toggle — opening a sub-modal keeps the gear sheet
                         compact. -->
                    <div *ngFor="let s of (sidebarSettingsRegistry.sections$ | async)"
                         class="gt-setting-row gt-setting-row-action"
                         (click)="openSidebarSettingsSection(s)">
                        <div class="gt-setting-text">
                            <div class="gt-setting-title">{{ s.title }}</div>
                            <!-- Live status replaces the static description when
                                 the section provides one (mobile-bridge). -->
                            <div class="gt-section-status"
                                 *ngIf="s.status$ && (s.status$ | async) as st"
                                 [attr.data-tone]="st.tone">
                                <span class="gt-status-dot"></span>{{ st.label }}
                            </div>
                            <div class="gt-setting-desc"
                                 *ngIf="s.description && !s.status$">{{ s.description }}</div>
                        </div>
                        <div class="gt-section-actions">
                            <!-- Inline enable/disable — only when the section
                                 is configured (enabled$ emits non-null). Lets
                                 the user flip the binding without opening the
                                 full Configure modal. -->
                            <input *ngIf="s.enabled$ && (s.enabled$ | async) !== null"
                                   type="checkbox" class="gt-switch"
                                   [checked]="(s.enabled$ | async) === true"
                                   (click)="$event.stopPropagation()"
                                   (change)="onSectionToggle(s, $event)"
                                   [attr.aria-label]="s.title + ' enabled'"/>
                            <button type="button" class="gt-section-btn"
                                    (click)="openSidebarSettingsSection(s); $event.stopPropagation()"
                                    [attr.aria-label]="'Open ' + s.title + ' settings'">
                                Configure…
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </ng-template>
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

            /* status taxonomy aliases (design token names) */
            --gt-needsyou: var(--gt-st-perm);
            --gt-done:     var(--gt-st-done);
            --gt-working:  var(--gt-st-working);
            --gt-idle:     var(--gt-st-ready);
            --gt-shell:    var(--gt-text-faint);
            --gt-ghost:    #4A4F57;
            --gt-rail-line: rgba(255, 255, 255, 0.08);
            --gt-meta-bg:  rgba(255, 255, 255, 0.055);
            --gt-meta-br:  rgba(255, 255, 255, 0.09);
            --gt-meta-tx:  #AEB4BC;

            /* Process-tree chips (agents / shells·bgs / monitors) — designer
               handoff 2026-06-12. Cyan tint reads clearly against the dark row
               without competing with the status rail. Light theme is deferred
               for the sidebar; when it lands, override with:
                 --gt-proc: #0E8FA3;  --gt-proc-bg: rgba(14, 143, 163, 0.12); */
            --gt-proc:     #45CFE0;
            --gt-proc-bg:  rgba(69, 207, 224, 0.13);

            display: block;
            width: 100%;
            height: 100%;
            background: var(--gt-surface-1);
            color: var(--gt-text);
            overflow: hidden;
            font-size: 13px;
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
            padding: 13px 14px 11px;
            flex: none;
        }
        .sb-header .sb-logo { width: 22px; height: 22px; flex: none; display: inline-flex; }
        .sb-header .sb-title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; color: var(--gt-text); white-space: nowrap; }
        .sb-header .sb-title b { color: var(--gt-accent); font-weight: 600; }
        .sb-header .sb-grow { flex: 1; }
        .sb-header .sb-attn {
            display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; flex: none;
            font-family: var(--gt-mono); font-size: 11.5px; font-weight: 600;
            color: var(--gt-needsyou); background: var(--gt-accent-soft);
            padding: 2.5px 7px; border-radius: 99px;
        }
        .sb-header .sb-attn .pip { width: 5px; height: 5px; border-radius: 99px; background: var(--gt-needsyou); }
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
            gap: 5px;
            padding: 2px 12px 11px;
            flex: none;
        }
        .pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 9px;
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
            color: var(--gt-text);
            border-color: var(--gt-border-2, rgba(255,255,255,0.14));
        }
        .pill.active {
            background: var(--gt-surface-3);
            border-color: rgba(255,255,255,0.14);
            color: var(--gt-text);
        }
        /* the needs-you filter carries a faint accent when it has items */
        .pill[data-id="needs_permission"]:not(.zero) {
            color: var(--gt-needsyou);
            border-color: color-mix(in srgb, var(--gt-needsyou) 35%, transparent);
        }
        .pill[data-id="needs_permission"]:not(.zero) .c { color: var(--gt-needsyou); }
        .pill[data-id="needs_permission"].active { background: var(--gt-accent-soft); }
        .pill[data-id="done"].active {
            background: var(--gt-st-done-soft);
            border-color: rgba(255, 82, 82, 0.5);
            color: var(--gt-done);
        }
        .pill.zero { opacity: 0.5; }
        .pill .c {
            font-family: var(--gt-mono);
            font-size: 11px;
            font-weight: 600;
            color: var(--gt-text-faint);
            font-variant-numeric: tabular-nums;
        }
        .pill.active .c { color: var(--gt-text-dim); }

        /* ---- list / row ---- */
        .sb-list {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 6px;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 2px 8px 8px;
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
            grid-template-columns: 18px minmax(0, 1fr);
            gap: 9px;
            padding: 9px 10px 9px 6px;
            border-radius: 10px;
            cursor: pointer;
            transition: background-color 0.13s ease;
            /* Our class="row" collides with Bootstrap's grid .row, which
               otherwise injects negative horizontal margins (pulling the row
               off the list's left edge so the active left:0 status bar lands
               off-screen) AND ".row > *" gutter padding (12px) on .rail —
               left-shifting the dot off the rail line's centre. Zero the
               gutter var (kills the child padding) and the margins (kills the
               overhang) so the row owns its own geometry. */
            --bs-gutter-x: 0;
            margin: 0;
        }
        .row:hover { background: var(--gt-surface-2); }

        /* ---- index (now inline on line1) ---- */
        .num {
            font-family: var(--gt-mono);
            font-size: 12.5px;
            color: var(--gt-text-faint);
            flex: none;
            width: 15px;
            text-align: right;
            font-variant-numeric: tabular-nums;
            line-height: 1;
        }
        .row.active .num { color: var(--gt-text-dim); }
        .subicon { color: var(--gt-ghost); flex: none; display: inline-flex; }

        /* shell rows recede — nearly invisible until hovered */
        .row[data-status="no_ai"] { opacity: 0.5; }
        .row[data-status="no_ai"]:hover { opacity: 0.78; }

        /* ---- status emphasis: needs-you / done out-rank the rest with a
               left edge rail + a faint row tint (colour + shape + word, never
               colour alone). ---- */
        .row[data-status="needs_permission"] {
            background: color-mix(in srgb, var(--gt-needsyou) 9%, transparent);
        }
        .row[data-status="needs_permission"]::after {
            content: ""; position: absolute; left: 0; top: 5px; bottom: 5px;
            width: 3px; border-radius: 0 3px 3px 0; background: var(--gt-needsyou);
        }
        .row[data-status="done"] {
            background: color-mix(in srgb, var(--gt-done) 6%, transparent);
        }
        .row[data-status="done"]::after {
            content: ""; position: absolute; left: 0; top: 7px; bottom: 7px;
            width: 2.5px; border-radius: 0 3px 3px 0; background: var(--gt-done); opacity: 0.8;
        }

        /* ---- active row — "you are here". The only blue in the list. ---- */
        .row.active { background: var(--gt-st-active-bg); }
        /* Focused row carries a bold leading-edge bar in the SAME colour as its
           status dot. It must clear the active wash — a thin blue bar on the
           blue wash washes out entirely (blue-on-blue), so it's full-height,
           4px wide, and per-status coloured rather than always the active blue. */
        .row.active::after {
            content: ""; position: absolute; left: 0; top: 4px; bottom: 4px;
            width: 4px; border-radius: 0 3px 3px 0; background: var(--gt-st-active);
        }
        .row.active[data-status="working"]::after          { background: var(--gt-working); }
        .row.active[data-status="idle"]::after             { background: var(--gt-idle); }
        .row.active[data-status="needs_permission"]::after { background: var(--gt-needsyou); }
        .row.active[data-status="done"]::after             { background: var(--gt-done); }
        .row.active[data-status="no_ai"]::after            { background: var(--gt-ghost); }
        .row.active .primary { color: var(--gt-text); font-weight: 650; }

        /* ---- user-pinned row (right-click → Pin to top) ----
           Faint gold wash + gold pin glyph next to the title. Gold is the
           only colour in the sidebar not claimed by a status, so "pinned"
           reads independently of status state. */
        .row.pinned { background: var(--gt-pin-soft); }
        .row.pinned.active { background: var(--gt-st-active-bg); }
        .pin-mark {
            display: inline-flex;
            align-items: center;
            color: var(--gt-pin);
            flex: none;
            line-height: 1;
            /* Explicit CSS sizing reinforces the inline SVG width/height
               attributes (a late stylesheet — Bootstrap reset, an OS-event
               relayout — could otherwise inflate the SVG to its content box;
               observed ~200px after returning from System Settings). */
            width: 11px;
            height: 11px;
        }
        .pin-mark > svg, svg.pin-mark { width: 11px; height: 11px; flex: none; }

        /* ---- isolated-worktree branch badge (line1, after the name) ----
           Marks a row whose tab runs in a git-worktree this session. Subtle
           chip so it reads as metadata, not a status. */
        .wt-badge {
            flex: none;
            max-width: 40%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-family: ui-monospace, monospace;
            font-size: 10px;
            line-height: 1.4;
            padding: 0 5px;
            border-radius: 999px;
            color: var(--gt-text-dim);
            border: 1px solid var(--gt-hairline, rgba(255,255,255,.12));
            opacity: .85;
        }

        /* ---- rail line — the continuous vertical thread the status dots ride
               on, like a timeline / subway map. Drawn full-height per row so
               consecutive rows join into one unbroken line; each dot's
               surface-coloured ring (see .dot box-shadow) punches a small gap
               where the line passes behind it. ---- */
        .rail {
            position: relative;
            display: grid;
            justify-items: center;   /* dot centred in the rail column */
            align-items: center;     /* dot rides the row's vertical centre, so the
                                        rail line shows as two equal segments above
                                        and below it (timeline "station" look) */
            align-self: stretch;     /* span the full row height for the line */
        }
        .rail::before {
            content: "";
            position: absolute;
            top: -9px;               /* reach up into the row's top padding … */
            bottom: -9px;            /* … and down, so adjacent rows' lines meet */
            left: 50%;
            width: 1.5px;
            transform: translateX(-50%);
            background: var(--gt-rail-line);
            z-index: 0;              /* behind the dot (z-index: 1) */
        }

        /* ---- subordinate row (extra leaf inside a SplitTabComponent) ----
           Indented, with a dashed rail line + a corner glyph so it reads as an
           attached child of the primary one row up. The index is suppressed —
           a split's panes share the parent tab's number, so repeating it is
           noise. visibleStates emits subordinates directly below their parent. */
        .row.subordinate { padding-left: 18px; }
        .row.subordinate .rail::before {
            background: repeating-linear-gradient(var(--gt-rail-line) 0 2px, transparent 2px 5px);
        }
        .row.subordinate .num { visibility: hidden; }
        .row.subordinate .primary { font-weight: 500; color: var(--gt-text-dim); }

        /* ---- status dot — threaded on the rail line, shaped per status so
               it never relies on colour alone (colour + shape + word). ---- */
        .dot {
            position: relative;
            z-index: 1;
            width: 10px;
            height: 10px;
            border-radius: 99px;
            display: block;
            transform-origin: center;
            background: var(--gt-shell);
            /* surface-coloured ring gives the dot a small gap from the rail line */
            box-shadow: 0 0 0 3px var(--gt-surface-1);
            transition: background-color 0.25s ease, box-shadow 0.25s ease;
        }
        .dot[data-status="working"] { background: var(--gt-working); }
        .dot[data-status="needs_permission"] { background: var(--gt-needsyou); }
        /* The animated ripple/breathe lives on a ::after ring that animates
           ONLY transform + opacity — compositor-only, no per-frame repaint
           (animating box-shadow on the dot itself repainted every frame). The
           dot keeps its static surface-1 box-shadow ring (the rail-line gap);
           the ::after's own ring box-shadow is painted once and merely scaled,
           so z-order vs the rail is unchanged. */
        .dot[data-status="working"]::after,
        .dot[data-status="needs_permission"]::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: 99px;
            pointer-events: none;
        }
        .dot[data-status="working"]::after {
            box-shadow: 0 0 0 2px color-mix(in srgb, var(--gt-working) 55%, transparent);
            animation: ht-pulse 1.8s ease-out infinite;
        }
        .dot[data-status="needs_permission"]::after {
            box-shadow: 0 0 0 2px color-mix(in srgb, var(--gt-needsyou) 55%, transparent);
            animation: ht-breathe 1.5s ease-in-out infinite;
        }
        .dot[data-status="done"] {
            background: var(--gt-done);
            box-shadow: 0 0 0 3px var(--gt-surface-1), 0 0 0 4.5px color-mix(in srgb, var(--gt-done) 45%, transparent);
        }
        .dot[data-status="idle"] { background: var(--gt-idle); width: 8px; height: 8px; }
        .dot[data-status="no_ai"] {
            background: transparent;
            box-shadow: inset 0 0 0 1.5px var(--gt-ghost), 0 0 0 3px var(--gt-surface-1);
            width: 8px; height: 8px;
        }
        /* Working — soft outward ripple. Done/needs-you carry their own cues
           (ring / breathe); only working + needs-you animate so the list reads
           calm, not busy. */
        @keyframes ht-pulse {
            0%   { transform: scale(1);   opacity: 0.85; }
            70%  { transform: scale(2.6); opacity: 0; }
            100% { transform: scale(2.6); opacity: 0; }
        }
        @keyframes ht-breathe {
            0%, 100% { transform: scale(1);   opacity: 0.9; }
            50%      { transform: scale(1.6); opacity: 0.3; }
        }

        /* ---- body ---- */
        .body { min-width: 0; }

        /* line1 — index · name · pin · (spacer) · status word */
        .line1 {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }
        .l1-sp { flex: 1; }
        /* Primary identifier — folder basename (the project the user is in).
           Falls back to the tab title when cwd isn't reported. Single line with
           end-ellipsis; the full path lives on line3 (on every AI row). */
        .primary {
            font-size: 16px;
            font-weight: 550;
            color: var(--gt-text);
            letter-spacing: -0.005em;
            flex: 0 1 auto;
            min-width: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .status {
            flex: none;
            font-size: 13.5px;
            font-weight: 600;
            white-space: nowrap;
            letter-spacing: -0.005em;
        }
        .status[data-status="working"]          { color: var(--gt-working); }
        .status[data-status="idle"]             { color: var(--gt-idle); }
        .status[data-status="no_ai"]            { color: var(--gt-text-faint); font-weight: 500; }
        .status[data-status="needs_permission"] { color: var(--gt-needsyou); }
        .status[data-status="done"]             { color: var(--gt-done); }

        /* line2 — neutral agent·model pill · (spacer) · age */
        .line2 {
            display: flex;
            align-items: center;
            gap: 7px;
            margin-top: 5px;
            min-width: 0;
        }
        .l2-sp { flex: 1; }
        /* token usage row — the in/cache/out chip lives on its own line below
           line2 so it can't overflow the row beside the agent pill. */
        .line-tok {
            display: flex;
            align-items: center;
            margin-top: 5px;
            min-width: 0;
        }
        .age { flex: none; font-family: var(--gt-mono); font-size: 12.5px; color: var(--gt-text-faint); }

        /* Token usage base (shared with the shell cwd label) — dim mono. */
        .usage {
            font-family: var(--gt-mono);
            font-size: 12.5px;
            line-height: 1;
            color: color-mix(in srgb, var(--gt-text-faint), var(--gt-text-dim));
            white-space: nowrap;
            flex: none;
        }
        .usage.shell-cwd {
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
            flex: 0 1 auto;
            opacity: 0.85;
        }
        /* Token usage chip ("in: 27k out: 284k") — label-first: dimmed label
           with trailing colon, bright value (weight 600), in the neutral
           --gt-meta chip (same bg/border as the agent pill it sits beside).
           Designer handoff 2026-06-12. */
        .usage.tokens {
            display: inline-flex;
            align-items: baseline;
            gap: 7px;
            padding: 1.5px 6px;
            border-radius: 5px;
            background: var(--gt-meta-bg);
            border: 1px solid var(--gt-meta-br);
        }
        .usage.tokens .tk { display: inline-flex; align-items: baseline; gap: 4px; }
        .usage.tokens .tk-l { color: var(--gt-text-faint); }
        .usage.tokens .tk-v { color: var(--gt-text); font-weight: 600; }
        /* cache-read is the cheap re-read of the cached context (0.1x billed) —
           de-emphasised so it doesn't compete with the real in/out figures. */
        .usage.tokens .tk-cache .tk-l,
        .usage.tokens .tk-cache .tk-v { color: var(--gt-text-faint); font-weight: 400; }

        /* line3 — full path (every AI row with a cwd) + process-tree counts. */
        .line3 {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 5px;
            min-width: 0;
            font-family: var(--gt-mono);
            font-size: 12.5px;
            color: color-mix(in srgb, var(--gt-text-faint), var(--gt-text-dim));
        }
        .l3-sp { flex: 1; }
        /* Full path under the folder name — mono, dim, single line. Long paths
           are pre-truncated with a middle '…' by displayCwd, so the END (most
           specific directory) stays visible. */
        .path-sub {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
        }
        .conc { flex: none; display: inline-flex; gap: 6px; }
        .conc > span {
            display: inline-flex;
            align-items: center;
            white-space: nowrap;
            font-family: var(--gt-mono);
            font-size: 10px;
            font-weight: 600;
            line-height: 1;
            color: var(--gt-proc);
            background: var(--gt-proc-bg);
            padding: 1.5px 6px;
            border-radius: 5px;
        }
        .conc b { color: var(--gt-proc); font-weight: 700; margin-right: 3px; }

        /* ---- agent + model pill (BRAND-THEMED, default) ----
           One pill holding a tool glyph, the tool name, and the active model.
           Brand mode: the glyph + name take the agent's brand colour and the
           chip gets a faint matching tint, so each agent reads in its own
           colour (Claude coral / Codex green / Gemini blue / opencode purple).
           The MODEL name stays neutral grey (it's metadata), and the chip tint
           is kept low (12% brand over the neutral --gt-meta chip) so it never
           reads as a saturated STATUS colour (green working / red done / orange
           needs-you). The --brand var is set per agent via [data-tool] below;
           the default is the old neutral grey for any unbranded tool. */
        .agent-tag {
            --brand: var(--gt-meta-tx);
            display: inline-flex;
            align-items: center;
            gap: 5px;
            max-width: 100%;
            min-width: 0;
            font-family: var(--gt-mono);
            font-size: 12.5px;
            line-height: 1;
            padding: 3px 7px 3px 5px;
            border-radius: 5px;
            background: color-mix(in srgb, var(--brand) 12%, var(--gt-meta-bg));
            border: 1px solid color-mix(in srgb, var(--brand) 28%, transparent);
            color: var(--gt-meta-tx);
            white-space: nowrap;
            flex: none;
        }
        /* Per-agent brand colours (drives glyph + name + chip tint). */
        .agent-tag[data-tool="claude"]   { --brand: #D97757; }
        .agent-tag[data-tool="codex"]    { --brand: #10A37F; }
        .agent-tag[data-tool="gemini"]   { --brand: #4285F4; }
        .agent-tag[data-tool="opencode"] { --brand: #A855F7; }
        .agent-tag .tg { font-size: 12px; color: var(--brand); opacity: 0.9; flex: none; }
        .agent-name { font-weight: 600; color: var(--brand); flex: none; }
        .agent-model {
            color: var(--gt-text-faint);
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* ---- footer (aggregate stats) ---- */
        .sb-footer {
            display: flex;
            align-items: center;
            gap: 11px;
            flex-wrap: wrap;
            padding: 9px 14px;
            border-top: 1px solid var(--gt-border);
            font-family: var(--gt-mono);
            font-size: 12.5px;
            color: var(--gt-text-dim);
            flex: none;
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
        .sb-footer .stat.muted         { color: var(--gt-text-faint); }
        .sb-footer .stat.work          { color: var(--gt-working); }
        .sb-footer .stat.work i        { background: var(--gt-working); }
        .sb-footer .stat.idle i        { background: var(--gt-idle); }
        .sb-footer .stat.attn-stat     { color: var(--gt-needsyou); }
        .sb-footer .stat.attn-stat i   { background: var(--gt-needsyou); }
        .sb-footer .stat.done-stat     { color: var(--gt-done); }
        .sb-footer .stat.done-stat i   { background: var(--gt-done); }

        /* ---- bottom action row (screenshot etc.) ----
           Sits below the aggregate-stats footer. Always visible — the button
           must be reachable even when no AI tabs are open (the user might
           want to capture something to share into a shell they're about to
           start). */
        .sb-actions {
            display: flex;
            align-items: stretch;
            gap: 7px;
            padding: 10px 12px 12px;
            border-top: 1px solid var(--gt-border);
            flex: none;
        }
        /* Screenshot is the primary action — a wide labelled button (design);
           split-shell + settings are square icon buttons beside it. */
        .split-action { flex: 1; }
        .split-action .action-btn.split-main {
            flex: 1;
            width: auto;
            gap: 8px;
            padding: 0 12px;
            font-size: 12.5px;
            font-weight: 550;
            color: var(--gt-text);
        }
        .split-action .action-btn.split-main .btn-label { white-space: nowrap; }
        .split-action .action-btn.split-main.muted:not(:disabled) { opacity: 0.55; }
        .split-action .action-btn.split-caret { width: 28px; }
        .split-main .spin {
            width: 12px; height: 12px; flex: none;
            border: 2px solid var(--gt-border);
            border-top-color: var(--gt-accent);
            border-radius: 99px;
            animation: gt-spin 0.7s linear infinite;
        }
        @keyframes gt-spin { to { transform: rotate(360deg); } }
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
            width: 34px;
            height: 34px;
            min-height: 34px;
            max-height: 34px;
            padding: 0;
            margin: 0;
            line-height: 1;
            vertical-align: middle;
            border-radius: 7px;
            background: var(--gt-surface-3);
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
            align-items: stretch;
            height: 34px;
            box-sizing: border-box;
            flex: 1;
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

        /* Gear button sits at the right end of the action row. No popover
           wrapping anymore — the button is a single tap target that opens
           a modal — so margin-left:auto goes directly on the button. */
        /* Screenshot group now fills the row (flex:1), so split-shell + settings
           sit flush at the right with the toolbar gap — no auto-margin needed. */

        /* ============================================================
           Settings modal — rendered by NgbModal as an EmbeddedView from
           our template ref and then RELOCATED into a portal at <body>
           level. The relocated nodes still carry the [_ngcontent-*]
           attribute Angular's emulated encapsulation injected, so these
           selectors STILL match — but the nodes are no longer DOM-
           descendants of our component's host, so CSS-variable
           inheritance for :host scoped CSS variables does NOT reach them.
           Every value here is therefore spelled out literally; no
           var(--gt-*) lookups across the gap. (Layout / size / flex
           still work through the matching attribute.) Each rule is
           prefixed with a .gt-* class to avoid colliding with Tabby's
           own modal styles, since these rules are effectively global
           in the relocated-view sense.
           ============================================================ */
        .gt-settings-modal {
            background: #1C1F23;
            color: #E7E9EC;
            border-radius: 12px;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, sans-serif;
        }
        .gt-settings-header {
            display: flex;
            align-items: center;
            padding: 16px 20px 14px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.07);
        }
        .gt-settings-title {
            flex: 1;
            margin: 0;
            font-size: 16px;
            font-weight: 600;
            color: #E7E9EC;
        }
        .gt-settings-close {
            background: transparent;
            border: none;
            color: #6B7178;
            padding: 4px;
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.12s ease, color 0.12s ease;
        }
        .gt-settings-close:hover {
            background: rgba(255, 255, 255, 0.04);
            color: #E7E9EC;
        }
        .gt-settings-body {
            padding: 8px 4px;
        }
        .gt-setting-row {
            display: flex;
            align-items: flex-start;
            gap: 16px;
            padding: 14px 18px;
            margin: 0;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.12s ease;
        }
        .gt-setting-row:hover {
            background: rgba(255, 255, 255, 0.04);
        }
        .gt-setting-text {
            flex: 1;
            min-width: 0;
        }
        .gt-setting-title {
            font-size: 14px;
            font-weight: 500;
            color: #E7E9EC;
            margin-bottom: 4px;
        }
        .gt-setting-desc {
            font-size: 12.5px;
            line-height: 1.5;
            color: #6B7178;
        }

        /* Live status line for a contributed section (e.g. mobile-bridge
           "Telegram @bot · connected"). Sits where the description would. */
        .gt-section-status {
            display: flex;
            align-items: center;
            gap: 7px;
            font-size: 12.5px;
            line-height: 1.5;
            color: #9BA1A8;
        }
        .gt-status-dot {
            flex: none;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #6B7178;   /* idle default */
        }
        .gt-section-status[data-tone="connected"] { color: #B6C2B8; }
        .gt-section-status[data-tone="connected"] .gt-status-dot {
            background: #54D183;
            box-shadow: 0 0 0 3px rgba(84, 209, 131, 0.16);
        }
        .gt-section-status[data-tone="disabled"] .gt-status-dot { background: #6B7178; }
        .gt-section-status[data-tone="error"] { color: #E6A2A2; }
        .gt-section-status[data-tone="error"] .gt-status-dot {
            background: #E66B6B;
            box-shadow: 0 0 0 3px rgba(230, 107, 107, 0.16);
        }

        /* Right-hand controls for a contributed section row: optional
           inline toggle + the Configure button, kept on one line. */
        .gt-section-actions {
            flex: none;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        /* iOS-style toggle. Native checkbox, native a11y. */
        .gt-switch {
            appearance: none;
            -webkit-appearance: none;
            width: 38px;
            height: 22px;
            background: rgba(255, 255, 255, 0.16);
            border-radius: 11px;
            position: relative;
            cursor: pointer;
            transition: background 0.16s ease;
            flex: none;
            margin-top: 2px;
        }
        .gt-switch::after {
            content: "";
            position: absolute;
            top: 2px;
            left: 2px;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #fff;
            transition: transform 0.16s ease;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        }
        .gt-switch:checked {
            background: #FFAA55;
        }
        .gt-switch:checked::after {
            transform: translateX(16px);
        }
        .gt-switch:focus-visible {
            outline: 2px solid #FFAA55;
            outline-offset: 2px;
        }

        /* "Configure…" button for plugin-contributed settings sections.
           Restrained — same hierarchy as the toggle switches so the row
           reads as one of the existing settings, just with a sub-modal
           rather than an inline control. */
        .gt-section-btn {
            flex: none;
            margin-top: 2px;
            padding: 6px 12px;
            font-size: 12.5px;
            font-weight: 500;
            color: #E7E9EC;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.10);
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.12s ease, border-color 0.12s ease;
        }
        .gt-section-btn:hover {
            background: rgba(255, 170, 85, 0.14);
            border-color: rgba(255, 170, 85, 0.45);
        }
        .gt-section-btn:focus-visible {
            outline: 2px solid #FFAA55;
            outline-offset: 2px;
        }

        @media (prefers-reduced-motion: reduce) {
            .dot[data-status="working"]::after,
            .dot[data-status="needs_permission"]::after,
            .attn { animation: none !important; }
            .gt-switch, .gt-switch::after { transition: none !important; }
        }
    `],
})
export class AiSidebarComponent implements OnInit, OnDestroy {
    /** Re-exposed for the template so `*ngIf="effStatus(s) === TabStatus.NeedsPermission"`
     *  works without falling back to magic strings. Angular templates can
     *  only reach component-class members, not module-scope imports. */
    readonly TabStatus = TabStatus
    /** Same shape as the TabStatus re-export — lets template bindings on
     *  the filter pills (e.g. `filterMode === FilterId.All`) avoid magic
     *  strings on the Angular side too. */
    readonly FilterId = FilterId

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
    filterMode: FilterId = FilterId.All
    /** Pill definitions — order is render order, left → right. Mirrors the
     *  attention-priority sort: blocking-on-user first, then "your turn",
     *  then the non-attention buckets in their natural reading order. */
    readonly FILTERS: ReadonlyArray<{ id: FilterId; label: string }> = [
        { id: FilterId.All,              label: 'All' },
        { id: FilterId.NeedsPermission,  label: 'Needs You' },
        { id: FilterId.Done,             label: 'Done' },
        { id: FilterId.Working,          label: 'Working' },
        { id: FilterId.Idle,             label: 'Idle' },
    ]
    private sub?: Subscription
    private activeTabSub?: Subscription
    private unreadSub?: Subscription
    private tabOpenedSub?: Subscription
    private splitTabSubs = new Map<BaseTabComponent, Subscription[]>()
    private home = os.homedir()
    capturing = false
    screenshotMenuOpen = false
    @ViewChild('screenshotSplit', { static: false }) private screenshotSplitEl?: ElementRef<HTMLElement>
    @ViewChild('settingsModalTpl', { static: false }) private settingsModalTpl?: TemplateRef<unknown>

    /**
     * Per-tab user-set pins. Keyed by the inner `BaseTabComponent` (the
     * actual tab object Tabby creates) so a pin attaches to *this specific
     * tab instance* — opening a brand-new tab in the same cwd does NOT
     * inherit the pinned state.
     *
     * In-memory only. The previous design persisted a list of pinned
     * `cwd`s via config so pins survived restart; that conflated "I want
     * this folder favorited" with "I want this tab on top" and meant any
     * fresh shell in a pinned folder showed up pre-pinned. The user filed
     * that as a bug, so we drop the cwd persistence entirely — restart
     * clears all pins, which is the lesser surprise than spurious pins on
     * unrelated tabs.
     *
     * Entries are cleaned up at every tick by `prunePinnedTabs(states)`
     * once their BaseTabComponent disappears from the live tab list, so
     * the Set never holds dangling refs to closed tabs.
     */
    private pinnedInnerTabs = new Set<BaseTabComponent>()

    constructor (
        public app: AppService,
        public monitor: TabMonitor,
        private platform: PlatformService,
        private unread: UnreadService,
        private screenshot: ScreenshotService,
        private screenshotPaste: ScreenshotPasteService,
        private splitShell: SplitShellService,
        private worktreeLifecycle: WorktreeLifecycleService,
        private worktreeActions: WorktreeActionsService,
        private config: ConfigService,
        private notifications: NotificationsService,
        private zone: NgZone,
        private autoApprove: AutoApproveService,
        private ngbModal: NgbModal,
        public sidebarSettingsRegistry: SidebarSettingsRegistry,
    ) {}

    /**
     * Read-through to the persisted setting. The `?.` reaches all the way
     * through `store` itself — ConfigService loads `store` asynchronously
     * (config.service.ts:226) and component getters run during early CD
     * passes before that resolves. Default true matches the default declared
     * in AiSidebarConfigProvider, so the gear menu's checkmark starts checked
     * during the load window.
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
     * matches AiSidebarConfigProvider — so the gear menu's checkmark starts
     * unchecked during the config-load window.
     */
    get autoApprovePermissions (): boolean {
        return this.autoApprove.enabled
    }

    /**
     * Read-through to the "hide rows for tabs without an AI agent" setting.
     * Default false (matches AiSidebarConfigProvider) so during the
     * config-load window we show every tab; flipping ON triggers a single
     * Angular CD pass that drops no_ai rows from `visibleStates`.
     */
    get hideTabsWithoutAgent (): boolean {
        return this.config.store?.ai?.hideTabsWithoutAgent === true
    }

    /**
     * Flip the hide-no-ai setting and persist. `visibleStates` reads this on
     * every CD pass so the row list re-renders on the next tick with no
     * further plumbing. Idempotent — no-op when the value is unchanged.
     */
    toggleHideTabsWithoutAgent (): void {
        this.config.store.ai.hideTabsWithoutAgent = !this.hideTabsWithoutAgent
        void this.config.save()
        this.recomputeView()
    }

    /**
     * Read-through to the auto-resume master switch. Default true (matches
     * AiSidebarConfigProvider) so the gear menu's checkmark starts checked
     * during the config-load window. AutoResumeService.enabled reads the same
     * key live, so a flip takes effect on the next quit/restore — no restart.
     */
    get autoResumeAgents (): boolean {
        return this.config.store?.ai?.autoResumeAgents !== false
    }

    /**
     * Flip the auto-resume setting and persist. No re-plumbing needed —
     * AutoResumeService reads config.store.ai.autoResumeAgents at capture and
     * restore time, so the new value applies the next time a tab is restored.
     */
    toggleAutoResumeAgents (): void {
        this.config.store.ai.autoResumeAgents = !this.autoResumeAgents
        void this.config.save()
    }

    /** Whether to show Tabby's "X is still running. Close?" prompt on quit.
     *  Default false (read as `=== true`) — see AiSidebarConfigProvider and the
     *  vendored TerminalTabComponent.canClose() that honours it. */
    get warnOnCloseRunning (): boolean {
        return this.config.store?.ai?.warnOnCloseRunning === true
    }

    toggleWarnOnCloseRunning (): void {
        this.config.store.ai.warnOnCloseRunning = !this.warnOnCloseRunning
        void this.config.save()
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

    toggleScreenshotMenu (ev: MouseEvent): void {
        // The document:click listener uses contains() to keep the menu open
        // when the click is inside the split-action group. We still call
        // stopPropagation here as belt-and-braces against future ancestors
        // (e.g. a row-click handler on `.sb-actions`) intercepting the event.
        ev.stopPropagation()
        this.screenshotMenuOpen = !this.screenshotMenuOpen
    }

    /**
     * Open the AI-sidebar settings modal. Uses ng-bootstrap's NgbModal so
     * escape/backdrop dismissal, focus trap, and ARIA wiring come for
     * free; `centered: true` matches the visual treatment Tabby uses for
     * its own "edit profile" / "transfers" dialogs.
     *
     * Why a modal rather than the previous popover: each setting needs a
     * one-sentence description (off vs on isn't obvious for auto-approve
     * and hide-no-AI), and a popover anchored above the sidebar toolbar
     * has nowhere to put body copy without overflowing the side rail.
     */
    openSettingsModal (): void {
        if (!this.settingsModalTpl) return
        this.ngbModal.open(this.settingsModalTpl, { centered: true, size: 'md' })
    }

    /**
     * Open a plugin-contributed settings section (e.g. Mobile Bridge) in a
     * separate NgbModal. The section's component is whatever the plugin
     * registered via SidebarSettingsRegistry; Angular's component factory
     * resolves it as long as the contributing module is loaded (which it
     * always is here — both plugins are bundled at app startup).
     *
     * Size `lg` rather than `md` because contributed UIs tend to have
     * forms / lists (Mobile Bridge has both) that wrap awkwardly at the
     * gear-modal's narrow width.
     */
    openSidebarSettingsSection (section: SidebarSettingsSection): void {
        this.ngbModal.open(section.component, { centered: true, size: 'lg' })
    }

    private tokenStatsOpen = false

    /** Open the Token Usage dashboard as a modal from the gear menu (same
     *  NgbModal path the plugin "Configure…" sections use). Lives in our sidebar
     *  settings, not Tabby's global Settings. `xl` + scrollable for the tables.
     *  Guarded so a rapid double-click doesn't stack two modals. */
    openTokenStats (): void {
        if (this.tokenStatsOpen) return
        let ref
        try {
            ref = this.ngbModal.open(TokenStatsTabComponent, { size: 'xl', scrollable: true })
        } catch {
            return   // open failed — leave the flag untouched so reopening still works
        }
        this.tokenStatsOpen = true
        // result rejects on dismiss (✕ / backdrop / Escape); handle BOTH arms so
        // there's no unhandled rejection on a normal close, and the flag always clears.
        ref.result.then(() => { this.tokenStatsOpen = false }, () => { this.tokenStatsOpen = false })
    }

    /**
     * Apply a contributed section's inline enable/disable switch. The
     * section owns the actual mutation (e.g. mobile-bridge's
     * BindingStore.update); we just forward the new checked state. No-op
     * if the section didn't supply a setter (defensive — the toggle only
     * renders when enabled$ is present, but setEnabled is independently
     * optional in the contract).
     */
    onSectionToggle (section: SidebarSettingsSection, ev: Event): void {
        const checked = (ev.target as HTMLInputElement).checked
        section.setEnabled?.(checked)
    }

    /**
     * Close the screenshot popover when the user clicks anywhere outside
     * the split-action group. (The settings menu is now a modal that
     * NgbModal manages on its own — no inline dismissal needed here.)
     */
    @HostListener('document:click', ['$event'])
    onDocumentClick (ev: MouseEvent): void {
        if (this.screenshotMenuOpen) {
            const host = this.screenshotSplitEl?.nativeElement
            const inside = host && ev.target instanceof Node && host.contains(ev.target)
            if (!inside) this.zone.run(() => { this.screenshotMenuOpen = false })
        }
    }

    @HostListener('document:keydown.escape')
    onEscape (): void {
        if (this.screenshotMenuOpen) {
            this.zone.run(() => { this.screenshotMenuOpen = false })
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
     * Main button: capture WITHOUT hiding GlanceTerm — the common case is
     * snipping something inside another GlanceTerm tab to route at the
     * focused agent, so the window stays on-screen and in the frame.
     */
    async onScreenshot (): Promise<void> {
        // Clicking the main action means "go" — close the options popover if
        // it's open. The document:click handler treats the whole split-action
        // group as "inside" so it wouldn't auto-close on its own.
        this.screenshotMenuOpen = false
        await this.runCapture(false)
    }

    /**
     * Split-button menu action: hide the GlanceTerm window first, THEN
     * capture — for snipping something behind GlanceTerm without its UI in
     * the frame. A direct action (not a persisted toggle): the hide is
     * applied for this one capture inside ScreenshotService.capture().
     */
    async onScreenshotHideWindow (): Promise<void> {
        this.screenshotMenuOpen = false
        await this.runCapture(true)
    }

    /**
     * Shared capture flow: open the WeChat-style overlay, then route the
     * cropped PNG through the per-agent paste adapter (Claude first,
     * fallback = generic). `capturing` flips the button into a disabled /
     * "Capturing…" state so users don't double-trigger.
     */
    private async runCapture (hideWindow: boolean): Promise<void> {
        if (this.capturing) return
        this.capturing = true
        try {
            // Permission first, then the agent-tab gate: surface the Screen
            // Recording prompt regardless of which tab is focused, so a missing
            // permission isn't hidden behind "focus an AI agent tab".
            if (!await this.screenshot.ensureScreenPermission()) return
            // Non-AI tab: the paste step has no target. Tell the user instead of
            // silently dropping the click — disabling the button leaves users
            // wondering whether it's broken.
            if (!this.activeIsAi) {
                this.notifications.info('Focus an AI agent tab (Claude, Codex, …) to use screenshot paste.')
                return
            }
            const result = await this.screenshot.capture({ hideWindow })
            if (!result) return   // user cancelled or capture failed
            await this.screenshotPaste.paste(result.buffer)
        } finally {
            this.capturing = false
        }
    }

    /**
     * Display string for a hotkey id's first binding, read live from config so
     * a rebind in Settings → Hotkeys is reflected immediately. Tabby stores
     * bindings as `⌘-Shift-G` (macOS) / `Ctrl-Shift-G` (Win/Linux); we swap the
     * `-` joiner for `+` for a conventional shortcut look. Empty string when the
     * id is unbound, so callers can omit the hint entirely.
     */
    hotkeyHint (id: string): string {
        const binding = (this.config.store?.hotkeys?.[id] ?? [])[0]
        if (typeof binding !== 'string' || !binding) return ''
        return binding.split('-').join('+')
    }

    screenshotTitle (): string {
        const hk = this.hotkeyHint('ai-screenshot')
        const key = hk ? ` (${hk})` : ''
        return `Screenshot${key}`
    }

    splitTitle (): string {
        const hk = this.hotkeyHint('ai-split-shell')
        const key = hk ? ` (${hk})` : ''
        if (this.isSplitOpenInActiveTab()) return `Close split${key}`
        return `Split shell${key}`
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
                this.recomputeSubordinates(s)
                this.dropStalePins(s)
                this.recomputeActiveIsAi()
                this.recomputeView()
            })
        })
        // Tab switches don't change `states`, but they do change which row is
        // "active" — so the toolbar's enabled state (`activeIsAi`) needs to
        // re-evaluate. AppService emits outside the Angular zone in some
        // paths (focus restoration), so re-enter the zone to keep the
        // bindings reactive.
        this.activeTabSub = this.app.activeTabChange$.subscribe(() => {
            // Only the toolbar's activeIsAi depends on the active tab. The
            // memoized view-model does NOT: effStatus reads s.status + unread,
            // and tab focus does NOT clear unread (clearing is engagement-based
            // — input/scroll/click — and arrives via unread.count$). The
            // per-row [class.active] highlight re-evaluates on this CD pass.
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
        // a raw `idle`. The monitor's poll would eventually re-render anyway,
        // but a focus-clear should flip done → ready instantly — so we
        // subscribe to unread.count$ and rebuild the memoized view-model (which
        // also bounces a CD pass through the zone). The subject also fires when
        // `markReady` adds a tab, giving us a working → done flip with no
        // perceived lag. This is the dedicated unread-change channel, so it's
        // the load-bearing recomputeView() trigger for effStatus's Done/Idle
        // derivation — independent of states$ and activeTabChange$.
        this.unreadSub = this.unread.count$.subscribe(() => {
            this.zone.run(() => this.recomputeView())
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
        if (s.status === TabStatus.Idle && this.unread.isUnread(s.innerTab)) return TabStatus.Done
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
        this.activeIsAi = !!(match && match.aiTool && this.effStatus(match) !== TabStatus.NoAi)
    }

    /**
     * Tabs we render. Slack-mode layout — rows mirror Tabby's tab-bar
     * order one-to-one, no attention buckets float up. The 3rd row from
     * top stays the 3rd row from top, period. Status comes through dot
     * colour, the per-row `data-status` attribute, and the done-state
     * red `!` (held until viewed via UnreadService) — none of those
     * reorder the list.
     *
     * Two-stage layout:
     *   1. Sort PRIMARIES (one per outer tab) by Tabby's tab-bar index.
     *   2. Glue each primary's SUBORDINATES (other leaves of the same
     *      outer tab, in their split-pane order) directly underneath.
     *
     * Filtering: a primary survives the filter when itself OR any of its
     * subordinates matches the chosen status. This keeps the filtered view
     * in sync with the pill counts (each row counted by its own effStatus)
     * — a `working` shell pane riding under an `idle` AI still surfaces the
     * pair under the Working filter. Subordinates ride along regardless of
     * their own status so the connector bracket always points somewhere.
     *
     * NOTE: filtering goes through `effStatus`, not the raw `s.status` from
     * the monitor. The monitor never produces `'done'` — it's derived from
     * raw `idle + isUnread`.
     */
    get visibleStates (): TabState[] { return this.vmVisibleStates }

    /** Heavy computation behind {@link visibleStates}; invoked only from
     *  {@link recomputeView}, never per change-detection pass. */
    private computeVisibleStates (): TabState[] {
        // Slack-mode sort: rows always follow Tabby's tab-bar order. Status
        // (needs_permission, done, working) is conveyed by dot colour and
        // the per-row `data-status` attribute, never by position — spatial
        // memory works because row N stays at row N. The "Needs You" pill
        // is the safety valve when the user wants to see only urgent rows.
        const tabIdx = (s: TabState): number => {
            const i = this.app.tabs.indexOf(s.outerTab)
            return i < 0 ? Number.MAX_SAFE_INTEGER : i
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
            fm === FilterId.All || group.some(s => this.effStatus(s) === fm)
        const visiblePrimaries: TabState[] = []
        const subsByOuter = new Map<BaseTabComponent, TabState[]>()
        for (const [outer, group] of byOuter) {
            if (!groupMatches(group)) continue
            const p = primaryOf(group)
            if (!this.groupPassesNoAiFilter(group, p)) continue
            visiblePrimaries.push(p)
            const subs = group.filter(s => s !== p)
            if (subs.length > 0) subsByOuter.set(outer, subs)
        }
        visiblePrimaries.sort((a, b) => tabIdx(a) - tabIdx(b))
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
        return group.find(s => this.effStatus(s) !== TabStatus.NoAi) ?? group[0]
    }

    /**
     * Shared predicate for the "Hide tabs without an AI agent" filter — used
     * by both `visibleStates` (list rendering) and `countFor('all')` (pill
     * counter) so the two NEVER disagree.
     *
     * Returns true when the group should remain visible. Subtleties:
     *
     *   - `pickPrimary` prefers any non-no_ai leaf, so a no_ai primary means
     *     EVERY leaf in the outer tab is no_ai. A SplitTab with one AI leaf
     *     still has the AI as primary and passes.
     *
     *   - User-pinned tabs bypass the filter. Pin status is checked across
     *     EVERY leaf in the group, not just the primary — if the user
     *     right-clicked a non-primary shell leaf to pin it, that pin gesture
     *     should still keep the whole group visible. (`isPinned` is keyed
     *     on the inner BaseTabComponent, so pinning a subordinate doesn't
     *     propagate to the primary by itself.)
     */
    private groupPassesNoAiFilter (group: TabState[], primary: TabState): boolean {
        if (!this.hideTabsWithoutAgent) return true
        if (group.some(s => this.isPinned(s))) return true
        return this.effStatus(primary) !== TabStatus.NoAi
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
        return this.subordinateInnerTabs.has(s.innerTab)
    }

    /**
     * Pre-computed set of innerTabs that should render as subordinate rows.
     * Rebuilt once per `states$` emission via `recomputeSubordinates()`;
     * `isSubordinate(s)` becomes an O(1) lookup instead of an O(N) filter
     * over `this.states` per row binding (which is O(N²) across all rows
     * per change-detection pass — the single biggest CD hot spot the
     * engineering review flagged).
     */
    private readonly subordinateInnerTabs = new Set<BaseTabComponent>()

    /**
     * Memoized view-model. The `visibleStates` / `countFor` / `count*` getters
     * read THESE fields (O(1)) instead of recomputing O(N) work on every
     * change-detection pass. This component is default CD (CheckAlways) in a
     * zone-based app, so a full CD fires on every async event app-wide —
     * including every IPC chunk of background-agent terminal output and every
     * mobile-bridge callback. Re-running the un-memoized getters (visibleStates
     * sorts + groups; four count filters; countFor ×10/pass) on each of those
     * was a real renderer hot spot. Rebuilt once per inputs change via
     * {@link recomputeView} — the same precompute-in-subscription pattern the
     * engineering review already applied to {@link subordinateInnerTabs}.
     * Inputs: states, filterMode, hideTabsWithoutAgent, pinnedInnerTabs, unread.
     */
    private vmVisibleStates: TabState[] = []
    private vmCountAll = 0
    private vmCountWorking = 0
    private vmCountIdle = 0
    private vmCountAttn = 0
    private vmCountDone = 0

    /**
     * Rebuild the memoized view-model. Cheap; safe to over-call. Must run after
     * `this.states` is assigned and after any pin/filter/unread input changes;
     * wired into the states$ + activeTabChange$ subscriptions and the
     * setFilter / toggleHideTabsWithoutAgent / togglePin handlers. A missed
     * trigger self-heals on the next states$ emission (≤ POLL_MS), so the
     * failure mode is a transiently-stale count, never a hard desync.
     */
    private recomputeView (): void {
        this.vmVisibleStates = this.computeVisibleStates()
        // Single pass for the status buckets — replaces four separate O(N)
        // `states.filter(...)` getters that each ran per CD pass.
        let working = 0, idle = 0, attn = 0, done = 0
        for (const s of this.states) {
            switch (this.effStatus(s)) {
                case TabStatus.Working:         working++; break
                case TabStatus.Idle:            idle++; break
                case TabStatus.NeedsPermission: attn++; break
                case TabStatus.Done:            done++; break
                default: break
            }
        }
        this.vmCountWorking = working
        this.vmCountIdle = idle
        this.vmCountAttn = attn
        this.vmCountDone = done
        this.vmCountAll = this.computeCountAll()
    }

    private recomputeSubordinates (states: TabState[]): void {
        this.subordinateInnerTabs.clear()
        // Group by outer tab once.
        const byOuter = new Map<BaseTabComponent, TabState[]>()
        for (const s of states) {
            if (s.outerTab === s.innerTab) continue   // top-level tab — never subordinate
            const arr = byOuter.get(s.outerTab) ?? []
            arr.push(s)
            byOuter.set(s.outerTab, arr)
        }
        for (const [outer, leaves] of byOuter) {
            // We also need the FULL leaf list (including the primary) to run
            // pickPrimary correctly — `leaves` above already represents that
            // (it's every state whose outerTab is this SplitTab; the only
            // states excluded above were rows where inner === outer, i.e.
            // non-split tabs, which we don't store in byOuter).
            if (leaves.length <= 1) continue
            const primary = this.pickPrimary(leaves)
            for (const s of leaves) {
                if (s !== primary) this.subordinateInnerTabs.add(s.innerTab)
            }
            // Suppress unused-var warning while keeping the destructuring
            // self-documenting — outer's only role in this loop is the
            // Map key.
            void outer
        }
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
        // Slack-mode dropped the click-pin map entirely (PIN_MS / pinnedRank
        // / pinnedRawStatusAtPin all deleted). The only thing left to GC is
        // the user-driven pin set when a tab closes — handled below.
        this.prunePinnedTabs(states)
    }

    /**
     * Drop pinned tab references whose inner BaseTabComponent has
     * disappeared from the live state list (user closed the tab).
     * Idempotent and cheap — early-out on empty Set.
     */
    private prunePinnedTabs (states: TabState[]): void {
        if (this.pinnedInnerTabs.size === 0) return
        const live = new Set<BaseTabComponent>()
        for (const s of states) live.add(s.innerTab)
        for (const tab of this.pinnedInnerTabs) {
            if (!live.has(tab)) this.pinnedInnerTabs.delete(tab)
        }
    }

    /** Set or toggle the filter. Clicking the active pill resets to All. */
    setFilter (id: FilterId): void {
        this.filterMode = this.filterMode === id && id !== FilterId.All ? FilterId.All : id
        this.recomputeView()
    }

    /** Pill counter — `All` matches `visibleStates.length` exactly (every leaf
     *  the sidebar will actually render, including subordinates of a passing
     *  SplitTab); other pills count their effStatus bucket. The no_ai bucket
     *  isn't a pill, so flipping hideTabsWithoutAgent on only changes `All`;
     *  working/idle/done/needs_permission counts are unaffected by definition.
     *
     *  Same group / primary / pin-bypass semantics as visibleStates via the
     *  shared `groupPassesNoAiFilter` predicate — invariant to maintain is
     *  that the pill number and the rendered row count never disagree, even
     *  when a passing SplitTab contributes a primary plus N subordinate rows. */
    countFor (id: FilterId): number {
        switch (id) {
            case FilterId.All:             return this.vmCountAll
            case FilterId.Working:         return this.vmCountWorking
            case FilterId.Idle:            return this.vmCountIdle
            case FilterId.NeedsPermission: return this.vmCountAttn
            case FilterId.Done:            return this.vmCountDone
            default:                       return 0
        }
    }

    /** Heavy `All`-pill count (no_ai-filter aware); invoked only from
     *  {@link recomputeView}. `All` matches the rendered leaf count exactly
     *  (group.length per passing group, so a SplitTab's primary + N
     *  subordinate rows are all counted) via the shared groupPassesNoAiFilter
     *  predicate — same invariant as computeVisibleStates. */
    private computeCountAll (): number {
        if (!this.hideTabsWithoutAgent) return this.states.length
        const groups = new Map<BaseTabComponent, TabState[]>()
        for (const s of this.states) {
            const arr = groups.get(s.outerTab) ?? []
            arr.push(s)
            groups.set(s.outerTab, arr)
        }
        let n = 0
        for (const group of groups.values()) {
            const primary = this.pickPrimary(group)
            if (this.groupPassesNoAiFilter(group, primary)) n += group.length
        }
        return n
    }

    filterLabel (): string {
        switch (this.filterMode) {
            case FilterId.Done:             return 'finished tabs you haven’t opened'
            case FilterId.NeedsPermission:  return 'tabs need you right now'
            case FilterId.Working:          return 'working tabs'
            case FilterId.Idle:             return 'idle tabs'
            default:                        return 'tabs'
        }
    }

    get countWorking (): number { return this.vmCountWorking }
    get countIdle (): number { return this.vmCountIdle }
    get countAttn (): number { return this.vmCountAttn }
    get countDone (): number { return this.vmCountDone }

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
        // Slack-mode: row position is purely tab-bar order, never moves on
        // state change. So no click-pin is needed — the done→idle flip
        // triggered by focus only changes the dot colour, not the row's
        // index in the list. Removed the pinnedRank freeze that used to
        // shield against the teleport when the previous sort had `done`
        // floating above `idle`.
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
            case TabStatus.Working:          return 'working'
            case TabStatus.NeedsPermission:  return 'needs you'
            case TabStatus.Done:             return 'done'
            case TabStatus.Idle:             return 'ready'
            case TabStatus.NoAi:             return 'shell'
            default:                         return s.status
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
        }
        return tags[tool] || tool.charAt(0).toUpperCase() + tool.slice(1)
    }

    /** Single-glyph mark shown before the tool name in the neutral agent pill
     *  (design spec). Purely decorative — inherits the pill's neutral colour,
     *  never a status hue. Unknown tools fall back to a generic terminal mark. */
    toolGlyph (tool: string | null): string {
        if (!tool) return ''
        const glyphs: Record<string, string> = {
            claude:   '✳',
            codex:    '⬡',
            gemini:   '✦',
            opencode: '◇',
        }
        return glyphs[tool] || '›'
    }

    /** Short, de-noised model label for the chip next to the agent tag. Drops
     *  a provider prefix (opencode `anthropic/claude-…` → `claude-…`), a
     *  trailing `-YYYYMMDD` date (Claude dated ids), and the redundant
     *  agent-name prefix (`claude-opus-4-8` → `opus-4-8`, `gemini-2.5-pro` →
     *  `2.5-pro`). Codex (`gpt-5.5`) is left as-is. The full id is in the
     *  chip's title attribute. */
    modelLabel (tool: string | null, model: string | null): string {
        if (!model) return ''
        let m = model
        const slash = m.lastIndexOf('/')
        if (slash >= 0) m = m.slice(slash + 1)
        m = m.replace(/-\d{8}$/, '')
        if (tool && m.toLowerCase().startsWith(tool.toLowerCase() + '-')) {
            m = m.slice(tool.length + 1)
        }
        return m
    }

    /** Compact token count: <1k raw, then `k`, `m`, `b`, `t`. From `m` up,
     *  shows up to 2 decimals with a trailing zero trimmed (min 1 decimal) —
     *  `1.00t`→`1.0t`, `56.70b`→`56.7b`, but `12.34m` keeps both — so big
     *  counts stay precise without trailing-zero noise. Exact value is in the
     *  hover tooltip. null→0. Each threshold sits just below the round
     *  boundary so rounding never spills a magnitude (999_999 → `1.0m`, not
     *  `1000k`; 999_500_000 → `1.0b`). Cumulative cache-read input on a long
     *  Claude session reaches the hundreds of millions / billions. */
    fmtTokens (n: number | null): string {
        const v = n ?? 0
        if (v < 1000) return String(v)
        if (v < 999_500) return `${(v / 1000).toFixed(v < 9_950 ? 1 : 0)}k`
        if (v < 999_500_000) return `${this.trim2(v / 1_000_000)}m`
        if (v < 999_500_000_000) return `${this.trim2(v / 1_000_000_000)}b`
        return `${this.trim2(v / 1_000_000_000_000)}t`
    }

    /** `x` to ≤2 decimals, dropping a trailing zero in the 2nd place
     *  (`1.00`→`1.0`, `56.70`→`56.7`) while keeping `12.34` intact. Always
     *  ≥1 decimal so the value still reads as a rounded magnitude. */
    private trim2 (x: number): string {
        return x.toFixed(2).replace(/(\.\d)0$/, '$1')
    }

    /** Hover text for the token chip — exact counts. */
    tokensTitle (s: TabState): string {
        const cache = s.tokensCacheRead ? `, cache-read ${s.tokensCacheRead}` : ''
        return `session tokens — input ${s.tokensIn ?? 0}${cache}, output ${s.tokensOut ?? 0} `
            + `(input = fresh input + cache creation; cache-read is the cached context re-read each turn, billed ~0.1x)`
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

    subagentTitle (s: TabState): string {
        const n = s.subagentCount
        const noun = n === 1 ? 'subagent' : 'subagents'
        return `${n} ${noun} in flight (spawned via the Agent/Task tool, not yet retired by a matching SubagentStop).`
    }

    bgJobTitle (s: TabState): string {
        const n = s.backgroundJobCount
        const noun = n === 1 ? 'job' : 'jobs'
        return `${n} background ${noun} running under this agent (immediate child processes of the agent's PID that have persisted across polls — typically backgrounded shells started via the agent's own bg-task mechanism).`
    }

    /**
     * Label for the bg-job badge. Claude reports its own count as "shell"
     * (each is a confirmed PreToolUse(Bash, run_in_background:true)
     * spawn — the hook layer guarantees that semantic), so the sidebar
     * matches that wording to mirror Claude's bottom-bar
     * "N shell, M monitor" pair. Non-Claude agents fall back to the
     * generic "bg" — those counts come from our persistence-time
     * heuristic and might be any long-lived child process, not
     * necessarily a shell.
     */
    bgLabel (s: TabState): string {
        return s.aiTool === 'claude' ? 'shell' : 'bg'
    }

    monitorTitle (s: TabState): string {
        const n = s.monitorCount
        const noun = n === 1 ? 'task' : 'tasks'
        return `${n} Monitor ${noun} active (Claude's Monitor tool — started via PostToolUse(Monitor), retired on the matching PreToolUse(TaskStop)). Reset on SessionStart/SessionEnd; a monitor that exits via its own until-condition without a TaskStop will linger here until then.`
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
     * Worktree branch for a row, if it's running in an isolated worktree this
     * session — drives the `⎇ branch` badge. Cheap Map lookup, safe to call per
     * CD cycle. Null for ordinary tabs (and for worktree tabs recovered from a
     * previous launch, which the in-memory map doesn't track — see
     * WorktreeLifecycleService).
     */
    worktreeBranch (s: TabState): string | null {
        return this.worktreeLifecycle.branchForTab(s.outerTab)
    }

    /**
     * Tab-row right-click menu. Mirrors the most useful subset of Tabby's
     * own top-bar tab menu, scoped to what an AI-sidebar user typically
     * wants on a row: rename, copy the path, jump to it in Finder, or
     * spawn another shell at the same cwd.
     */
    isPinned (s: TabState): boolean {
        return this.pinnedInnerTabs.has(s.innerTab)
    }

    togglePin (s: TabState): void {
        if (this.pinnedInnerTabs.has(s.innerTab)) {
            this.pinnedInnerTabs.delete(s.innerTab)
        } else {
            this.pinnedInnerTabs.add(s.innerTab)
        }
        // Pin status feeds groupPassesNoAiFilter → the All-pill count and the
        // visible list under "hide tabs without agent". Rebuild the view-model.
        this.recomputeView()
    }

    async onContextMenu (s: TabState, ev: MouseEvent): Promise<void> {
        ev.preventDefault()
        ev.stopPropagation()
        const cwd = s.cwd ?? null
        const pinned = this.isPinned(s)
        const items: MenuItemOptions[] = [
            {
                label: pinned ? 'Unpin from top' : 'Pin to top',
                // Pin keys off the BaseTabComponent reference now, not cwd —
                // any tab can be pinned, including a fresh local shell that
                // hasn't yet sent OSC-7.
                click: () => this.togglePin(s),
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
            { type: 'separator' },
            {
                label: 'Open agent in worktree…',
                click: () => {
                    void this.worktreeActions.openInWorktree(s.innerTab)
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
