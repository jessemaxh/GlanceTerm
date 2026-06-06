import { Injectable } from '@angular/core'
import {
    AppService,
    NotificationsService,
    ProfilesService,
    SplitDirection,
    SplitTabComponent,
    TabsService,
    BaseTabComponent,
} from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TerminalService } from 'tabby-local'

import { TabMonitor } from './tab-monitor'

/** Runtime marker stamped on shell panes we created — instance state on the
 *  BaseTabComponent. Cheap O(1) check during CD; only survives within one
 *  renderer lifetime. */
const GT_SPLIT_MARKER = '__glanceterm_split_shell__'

/** Persisted marker — lives inside `profile.options.env`, the one corner of
 *  the profile that round-trips raw values past Tabby's ConfigProxy. The
 *  proxy whitelists known option keys against LocalProfile.configDefaults
 *  (tabby-local/src/profiles.ts:14), so a top-level `options[FLAG]` is
 *  silently dropped on read. The `env` entry is declared `__nonStructural`,
 *  which makes ConfigProxy expose the raw env object directly (config.service
 *  .ts:94) — so an unknown key inside `env` survives the round-trip through
 *  ConfigProxy.options.env AND through the spread in TerminalTabComponent
 *  .getRecoveryToken (`...this.profile.options` then `env: real.options.env`).
 *  Used to re-adopt a pane that came back from disk (renderer reload, app
 *  restart) so the toggle button keeps its "second click closes" contract
 *  instead of opening duplicates. The trade-off is the spawned shell sees
 *  `__glanceterm_split_shell__=1` as an environment variable — acceptable
 *  pollution (underscore-prefixed marker, no real program reads it). */
const GT_SPLIT_PROFILE_FLAG = '__glanceterm_split_shell__'

/** Per-leaf flag (instance state) telling us we've already wired the
 *  destroyed$ subscription. findOwnedShell can run every CD tick — without
 *  this, every tick after adoption would stack another subscription. */
const GT_SPLIT_SUBSCRIBED = '__glanceterm_split_subscribed__'

/**
 * Opens (or closes) a fresh local shell pane inside the currently active
 * AI tab, with its CWD pre-set to the focused leaf's live working directory.
 *
 * Per-outer-tab toggle:
 *   - One owned shell pane per SplitTabComponent (the outer AI tab).
 *   - Click once → open. Click again → close THAT pane (not the user's own panes).
 *   - Identity is recorded in `ownedByOuter` (WeakMap) AND stamped on the pane
 *     itself via `GT_SPLIT_MARKER`. The marker is a same-session fallback
 *     (singleton re-instantiation, getAllTabs scan during CD); it is plain
 *     runtime state on the BaseTabComponent instance.
 *
 * Concurrency:
 *   - `inflight` (per-outer WeakSet) gates against rapid double-click and
 *     keyboard repeat. A second toggle while the first is mid-await is a
 *     no-op rather than racing to open a second pane. The button's icon
 *     stays "inactive" until the open path finishes — that's intentional:
 *     it reflects "no committed pane yet", and the inflight gate prevents
 *     the misleading state from causing a duplicate open.
 *
 * Renderer reload / session restore:
 *   - Tabby's recovery path (SplitTabComponent.recoverContainer →
 *     tabsService.create) constructs FRESH BaseTabComponent instances; the
 *     runtime GT_SPLIT_MARKER (plain instance state) is dropped, and the
 *     SplitShellService singleton is rebuilt so the WeakMap is empty.
 *   - To survive that, we ALSO write GT_SPLIT_PROFILE_FLAG into
 *     profile.options at creation time; TerminalTabComponent
 *     .getRecoveryToken() spreads profile.options into the token, so the
 *     flag round-trips through disk. On first sighting of a recovered leaf
 *     carrying the flag we re-stamp the runtime marker, restore the
 *     WeakMap entry, and subscribe destroyed$. See tab-monitor.ts:174-200
 *     for the same class of "renderer reload while PTYs survive" issue.
 *
 * Uses Tabby's own primitives end-to-end:
 *   - SplitTabComponent.getFocusedTab() + addTab() — same path the built-in
 *     "Split right" context-menu item walks (tabContextMenu.ts:90).
 *   - session.getWorkingDirectory() — same source as the "Copy CWD" action.
 *   - TerminalService.getDefaultProfile() — Tabby's resolver for the user's
 *     configured default local profile, falling back to the first builtin.
 *   - tab.destroy() — destroyed$ subscription on SplitTabComponent (splitTab
 *     .component.ts:871) calls removeTab() for us, so no manual layout work.
 *
 * We deliberately do NOT call SplitTabComponent.splitTab(), because that
 * goes through tabsService.duplicate() and would re-run whatever command
 * the AI tab was launched with (claude / codex / …). We want a bare shell.
 */
@Injectable({ providedIn: 'root' })
export class SplitShellService {
    private ownedByOuter = new WeakMap<SplitTabComponent, BaseTabComponent>()
    private inflight = new WeakSet<SplitTabComponent>()

    constructor (
        private app: AppService,
        private tabsService: TabsService,
        private profilesService: ProfilesService,
        private terminalService: TerminalService,
        private notifications: NotificationsService,
        private monitor: TabMonitor,
    ) {
        // Eager re-adoption on app start / tab recovery.
        //
        // The button's "open vs close" state and the destroyed$ subscription
        // that keeps ownedByOuter in sync are wired by findOwnedShell. Before
        // this hook, findOwnedShell was only reached via isOpenIn from the
        // sidebar template — so a recovered GT-owned pane stayed orphaned
        // from our bookkeeping until the user opened the sidebar, at which
        // point the template tick adopted it. Symptom: "split state only
        // restored after I opened the AI agent".
        //
        // Subscribing to tabOpened$ catches tabs added after this service
        // wakes up — that includes the recovery path (AppService.recoverTabs
        // → openNewTabRaw → addTabRaw → tabOpened.next). Iterating app.tabs
        // covers the race where recovery finished before DI got us here.
        // findOwnedShell is idempotent (WeakMap + GT_SPLIT_SUBSCRIBED guard),
        // so a double-adopt is a no-op.
        for (const tab of this.app.tabs) {
            this.adoptIfSplit(tab)
        }
        this.app.tabOpened$.subscribe(tab => this.adoptIfSplit(tab))
    }

    private adoptIfSplit (tab: BaseTabComponent): void {
        if (!(tab instanceof SplitTabComponent)) return
        // ngAfterViewInit -> recoverContainer runs after the SplitTab is
        // pushed onto app.tabs, so children aren't populated yet when
        // tabOpened$ fires. Wait for initialized$ before scanning leaves.
        // The Subject completes after recoverContainer, so a late
        // subscription resolves immediately — safe for both fresh and
        // already-initialized tabs.
        tab.initialized$.toPromise().then(() => {
            this.findOwnedShell(tab)
        }).catch(() => { /* tab destroyed before init — nothing to adopt */ })
    }

    /**
     * Toggle a GlanceTerm-owned shell pane inside the active AI tab.
     * Returns true if a pane was opened, false if one was closed, null if
     * the call was rejected (no active tab, no default profile, in-flight, …).
     */
    async toggleShellInCurrentTab (side: SplitDirection = 'r'): Promise<boolean | null> {
        const root = this.app.activeTab
        if (!(root instanceof SplitTabComponent)) {
            this.notifications.info('No active tab to split')
            return null
        }

        if (this.inflight.has(root)) {
            return null
        }
        this.inflight.add(root)
        try {
            return await this.toggleInternal(root, side)
        } finally {
            this.inflight.delete(root)
        }
    }

    private async toggleInternal (
        root: SplitTabComponent,
        side: SplitDirection,
    ): Promise<boolean | null> {
        const existing = this.findOwnedShell(root)
        if (existing) {
            existing.destroy()
            this.ownedByOuter.delete(root)
            return false
        }

        const focused = root.getFocusedTab() ?? root.getAllTabs()[0] ?? null
        if (!focused) {
            this.notifications.info('Active tab is empty')
            return null
        }

        const cwd = await this.resolveCwd(focused)

        const baseProfile = await this.terminalService.getDefaultProfile()
        if (!baseProfile) {
            this.notifications.error('No default local profile configured')
            return null
        }
        const profile = {
            ...baseProfile,
            options: {
                ...(baseProfile.options ?? {}),
                cwd,
                // Persisted ownership flag — see GT_SPLIT_PROFILE_FLAG decl.
                // Stashed inside `env` (a `__nonStructural` ConfigProxy entry)
                // because top-level options keys outside the LocalProfile
                // configDefaults whitelist are dropped on the next CD pass.
                env: {
                    ...(baseProfile.options?.env ?? {}),
                    [GT_SPLIT_PROFILE_FLAG]: '1',
                },
            },
        }

        const params = await this.profilesService.newTabParametersForProfile(profile)
        if (!params) {
            this.notifications.error('Could not build tab params for default profile')
            return null
        }

        const newTab = this.tabsService.create(params)
        try {
            await root.addTab(newTab, focused, side)
        } catch (err) {
            // addTab failed before the pane is wired in — tear down the
            // orphan ourselves. We haven't stamped the marker or written to
            // ownedByOuter yet, so there's nothing else to clean up.
            newTab.destroy()
            throw err
        }

        this.adoptLeaf(root, newTab)
        return true
    }

    /**
     * Wire a leaf as the GlanceTerm-owned shell for `outer`. Used both at
     * creation time (toggleInternal) and at recovery time (findOwnedShell
     * when it spots GT_SPLIT_PROFILE_FLAG on a fresh leaf). Idempotent on
     * the destroyed$ subscription via GT_SPLIT_SUBSCRIBED so CD-driven
     * re-adoption doesn't stack listeners.
     *
     * Self-prune when the user closes our pane via their own UI (close
     * button, Cmd+W on the focused pane, etc.) — otherwise the next
     * toggle would think a pane is still open and try to close a destroyed
     * component. baseTab.destroyed$ emits .next() then .complete(), so the
     * subscription self-terminates — no takeUntil needed and no leak.
     */
    private adoptLeaf (outer: SplitTabComponent, leaf: BaseTabComponent): void {
        const flags = leaf as unknown as Record<string, unknown>
        flags[GT_SPLIT_MARKER] = true
        this.ownedByOuter.set(outer, leaf)
        if (flags[GT_SPLIT_SUBSCRIBED]) return
        flags[GT_SPLIT_SUBSCRIBED] = true
        leaf.destroyed$.subscribe(() => {
            if (this.ownedByOuter.get(outer) === leaf) {
                this.ownedByOuter.delete(outer)
            }
        })
    }

    /**
     * For the sidebar button to render "open vs close" state. Returns true
     * iff `outer` is a SplitTabComponent with a live GlanceTerm-owned pane.
     * Called from the template every change-detection tick; O(leaves).
     *
     * Side-effect: findOwnedShell may rewrite the WeakMap to repair drift
     * (cached pane removed, marker found on another leaf). The write is
     * idempotent within a CD tick and doesn't trigger re-CD.
     */
    isOpenIn (outer: BaseTabComponent | null): boolean {
        if (!(outer instanceof SplitTabComponent)) return false
        return this.findOwnedShell(outer) !== null
    }

    private findOwnedShell (outer: SplitTabComponent): BaseTabComponent | null {
        const leaves = outer.getAllTabs()
        const cached = this.ownedByOuter.get(outer)
        if (cached && leaves.includes(cached)) {
            return cached
        }
        if (cached) {
            this.ownedByOuter.delete(outer)
        }
        for (const leaf of leaves) {
            const flags = leaf as unknown as Record<string, unknown>
            if (flags[GT_SPLIT_MARKER]) {
                this.ownedByOuter.set(outer, leaf)
                return leaf
            }
            // Recovered from disk: runtime marker is gone but profile.options
            // .env still carries our persisted flag. Adopt: re-stamp the
            // runtime marker, restore the WeakMap entry, and wire destroyed$.
            const profile = (leaf as unknown as { profile?: { options?: { env?: Record<string, unknown> } } }).profile
            if (profile?.options?.env?.[GT_SPLIT_PROFILE_FLAG]) {
                this.adoptLeaf(outer, leaf)
                return leaf
            }
        }
        // Legacy fallback — for shell panes opened BEFORE the env-flag fix
        // landed (or via Tabby's own "Split right" context-menu), nothing
        // tags them. But the sidebar's whole reason to exist is one AI agent
        // per outer tab paired with at most one shell, so if TabMonitor says
        // an outer has exactly one AI-running leaf AND a non-AI local-shell
        // sibling, that sibling is what the user means by "the split". Adopt
        // it AND mutate profile.options.env so the standard env-flag path
        // takes over on the next save → reload cycle.
        return this.findLegacyShell(outer, leaves)
    }

    /**
     * Heuristic adoption for the "shell sibling next to an AI agent" pattern
     * when neither the runtime marker nor the persisted env flag is present.
     * Mirrors the TabMonitor's `aiTool` classification — the same field that
     * drives the sidebar's row status — so what the user sees and what the
     * button thinks "ownership" means stay in lockstep.
     *
     * Conditions for adoption:
     *   - the outer SplitTab has ≥2 leaves
     *   - exactly one leaf is currently running an AI tool (per TabMonitor)
     *   - exactly one leaf is a local TerminalTabComponent with no AI tool
     *
     * If those hold, we adopt the non-AI leaf AND stamp the env flag onto
     * its profile so the next saveTabs() persists it. Subsequent renderer
     * reloads then resolve via the standard env-flag path and don't need
     * the heuristic.
     *
     * Returns null if TabMonitor hasn't classified the leaves yet (boot
     * race) — the next CD tick after the first poll will retry, and `null`
     * here just means the button stays inactive a beat longer (no worse
     * than pre-fix).
     */
    private findLegacyShell (outer: SplitTabComponent, leaves: BaseTabComponent[]): BaseTabComponent | null {
        if (leaves.length < 2) return null
        const states = this.monitor.current
        let aiLeafCount = 0
        let candidate: BaseTabComponent | null = null
        for (const leaf of leaves) {
            const st = states.find(s => s.outerTab === outer && s.innerTab === leaf)
            // No TabMonitor state for this leaf yet — the poll hasn't classified
            // it. Bail rather than risk a wrong call.
            if (!st) return null
            if (st.aiTool) {
                aiLeafCount++
                continue
            }
            // Non-AI: must be a local terminal to qualify as "our shell".
            const profile = (leaf as unknown as { profile?: { type?: string } }).profile
            if (profile?.type !== 'local') return null
            if (candidate) return null   // ambiguous — two non-AI panes
            candidate = leaf
        }
        if (!candidate || aiLeafCount !== 1) return null
        // Stamp the env flag so the next persisted token carries it, and the
        // next reload doesn't need this heuristic. profile.options.env is the
        // same path getRecoveryToken spreads from, so the mutation rides
        // through saveTabs → localStorage automatically.
        const profile = (candidate as unknown as { profile?: { options?: { env?: Record<string, unknown> } } }).profile
        if (profile?.options) {
            const env = (profile.options.env ?? (profile.options.env = {})) as Record<string, unknown>
            env[GT_SPLIT_PROFILE_FLAG] = '1'
        }
        this.adoptLeaf(outer, candidate)
        // The mutated env rides along on the next saveTabs() pass. AppService
        // runs that on a 30 s heartbeat AND debounced off any tab mutation,
        // so the stamp hits disk well before the user can shut the app down
        // — we don't need to force it ourselves.
        return candidate
    }

    private async resolveCwd (tab: BaseTabComponent): Promise<string> {
        if (tab instanceof BaseTerminalTabComponent) {
            const session = (tab as unknown as { session?: { getWorkingDirectory?: () => Promise<string|null> } }).session
            try {
                const cwd = await session?.getWorkingDirectory?.()
                if (cwd) {
                    return cwd
                }
            } catch {
                // fall through to HOME
            }
        }
        return process.env.HOME ?? '/'
    }
}
