import { Injectable, OnDestroy } from '@angular/core'
import * as fs from 'fs/promises'
import * as path from 'path'
import { Subscription } from 'rxjs'

import { ConfigService, PlatformService } from 'tabby-core'

import { HookRuntimeService } from './hook-runtime.service'

/**
 * Owns the on-disk auto-approve flag (`~/.glanceterm/auto-approve.flag`) that
 * the hook handler script reads on every Claude PermissionRequest event to
 * decide whether to respond `allow`. Single source of truth for the feature:
 *
 *   - Reads `ai.autoApprovePermissions` from Tabby's config on startup and
 *     whenever any config save happens (we subscribe to ConfigService.changed$,
 *     not a per-key watcher, because there isn't one — the cost of a wasteful
 *     re-write on unrelated saves is one byte to disk).
 *   - Writes `"1"` or `"0"` to the flag file. The handler reads ONE byte with
 *     `head -c 1`, so trailing newlines don't matter.
 *   - Exposes enable() / disable() for the sidebar toolbar button. enable()
 *     pops a confirmation dialog because flipping it on grants the AI free
 *     rein to run any command, including destructive ones — we want that
 *     decision to be deliberate.
 *
 * The handler script writes its own audit line to `auto-approve.log` for
 * every grant — this service deliberately does NOT log toggles, because the
 * relevant audit question is "what got approved?", not "when did the user
 * change their mind?".
 */
// Module already lists this service in `providers` (see index.ts) and the
// module constructor eager-injects it, so a plain @Injectable is enough.
// `providedIn: 'root'` would create a second registration in the root
// injector — harmless in practice (the module-scoped instance wins for
// every consumer in this plugin) but confusing to the next reader.
@Injectable()
export class AutoApproveService implements OnDestroy {
    private sub: Subscription | null = null
    /** Serialise writes via a promise chain so a fast toggle (click-click)
     *  can't race and leave the wrong byte on disk. Cheap; the chain stays
     *  short because writes are sub-millisecond. */
    private writing: Promise<void> = Promise.resolve()
    /** Last byte we successfully wrote to disk. `null` means "we haven't
     *  written anything yet" — used to skip no-op writes when ConfigService
     *  fires `changed$` for unrelated saves (theme tweak, font change, etc.).
     *  Saves writes AND removes the truncation window in which a concurrent
     *  handler could read an empty file. */
    private lastWritten: string | null = null

    constructor (
        private config: ConfigService,
        private platform: PlatformService,
        private runtime: HookRuntimeService,
    ) {
        // changed$ fires after every save(). Theme tweaks etc. trigger a
        // spurious flag re-write, but the write is idempotent and ~1 ms, so
        // a global subscription is simpler than wiring a per-key watcher.
        this.sub = this.config.changed$.subscribe(() => { void this.sync() })
        // Initial reconcile — covers the boot case where the config was
        // loaded before this service existed.
        void this.sync()
    }

    ngOnDestroy (): void {
        this.sub?.unsubscribe()
    }

    /** True iff the user has the feature toggled on right now. */
    get enabled (): boolean {
        return this.config.store?.ai?.autoApprovePermissions === true
    }

    private get flagPath (): string {
        return path.join(this.runtime.root, 'auto-approve.flag')
    }

    /**
     * Show the confirm dialog and, on Yes, flip the config flag to true.
     * The actual flag-file write happens via the changed$ subscription, so
     * a programmatic config edit elsewhere stays in sync.
     *
     * Returns `true` if the feature is enabled at the end of the call —
     * either the user confirmed, or it was already on (idempotent).
     */
    async enable (): Promise<boolean> {
        if (this.enabled) return true
        const r = await this.platform.showMessageBox({
            type: 'warning',
            message: 'Enable auto-approve permission prompts?',
            detail:
                'GlanceTerm will respond "allow" to every AI agent permission prompt ' +
                'on your behalf. The agent will be able to run any command — including ' +
                'destructive ones like `rm -rf` — without asking you first.\n\n' +
                'Only enable this in a sandbox or disposable environment. Each ' +
                'auto-approved action is recorded to ~/.glanceterm/auto-approve.log so ' +
                'you can review what was granted after the fact.',
            buttons: ['Enable', 'Cancel'],
            // Default + Cancel both point at the safe choice so a stray
            // Enter / Esc never flips the feature on.
            defaultId: 1,
            cancelId: 1,
        })
        if (r.response !== 0) return false
        return this.commit(true)
    }

    async disable (): Promise<void> {
        if (!this.enabled) return
        await this.commit(false)
    }

    /**
     * Atomically flip the toggle to `desired` across all three sources of
     * truth (in-memory store, on-disk yaml, on-disk flag file). If any step
     * fails we roll the store back to its previous value and surface the
     * error — without this, an earlier non-transactional enable() could
     * leave `store=true` (UI shows ON) while `yaml`/`flag` stayed unwritten,
     * which is the exact drift we hit in prod: the shield button looked
     * lit but Claude still hit the `Bash(rm *)` ask rule because the hook
     * handler read flag="0".
     *
     * Why store-then-save-then-sync (not save-first):
     *   ConfigService.save() serializes `this.config.store` to disk — it
     *   has no separate "what to write" argument. We have to mutate the
     *   store first, then save, then revert on throw. The window where the
     *   store transiently holds the not-yet-persisted value is bounded by
     *   the catch.
     */
    private async commit (desired: boolean): Promise<boolean> {
        const prev = this.config.store?.ai?.autoApprovePermissions
        this.config.store.ai.autoApprovePermissions = desired
        try {
            await this.config.save()
            // changed$ fires synchronously inside save() and schedules a
            // flag write on `this.writing`. Awaiting sync() chains onto
            // the same promise so this call doesn't return until the byte
            // is on disk — otherwise a PermissionRequest firing in the
            // next event-loop tick would read the stale flag and
            // (correctly, but surprisingly) fall back to interactive
            // approval.
            await this.sync()
            return true
        } catch (e: any) {
            // Roll the in-memory store back so the UI reflects reality —
            // otherwise the user sees the shield "on" while the handler
            // keeps reading flag="0".
            this.config.store.ai.autoApprovePermissions = prev
            // Best-effort: surface what broke. Don't await — if showMessageBox
            // itself throws we still want the caller to see the original
            // failure, not a dialog error.
            void this.platform.showMessageBox({
                type: 'error',
                message: desired
                    ? 'Failed to enable auto-approve'
                    : 'Failed to disable auto-approve',
                detail:
                    `GlanceTerm could not persist the change:\n\n${e?.message ?? e}\n\n` +
                    'The toggle has been reverted. Check ~/.glanceterm/ and your config ' +
                    'file for permission or disk issues, then try again.',
                buttons: ['OK'],
                defaultId: 0,
            }).catch(() => { /* swallow — original error is what matters */ })
            // eslint-disable-next-line no-console
            console.error('[glanceterm] auto-approve commit failed:', e)
            return false
        }
    }

    /** Reconcile the flag file with the current config value. Idempotent. */
    sync (): Promise<void> {
        this.writing = this.writing.then(() => this.writeFlag(this.enabled))
        return this.writing
    }

    private async writeFlag (on: boolean): Promise<void> {
        const desired = on ? '1' : '0'
        // Short-circuit: if the byte we want already matches the byte we
        // last successfully wrote, skip the syscall. ConfigService.changed$
        // fires on every save (theme tweak, font change, …), so without
        // this every unrelated setting flip would truncate + rewrite the
        // flag file. Tracking `lastWritten` instead of stat'ing the file
        // is cheaper and dodges TOCTOU vs out-of-band edits we don't
        // expect anyway.
        if (this.lastWritten === desired) return
        try {
            // mkdir recursive is idempotent and cheap; needed when this
            // service runs before HookRuntimeService.ensureReady() has
            // created ~/.glanceterm/.
            await fs.mkdir(this.runtime.root, { recursive: true })
            await fs.writeFile(this.flagPath, desired, { encoding: 'utf8', mode: 0o600 })
            this.lastWritten = desired
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] could not write auto-approve flag:', e?.message ?? e)
            // Don't update lastWritten — let the next sync() retry the write.
        }
    }
}
