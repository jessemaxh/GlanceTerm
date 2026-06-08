import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { randomUUID } from 'crypto'

import { ChannelBinding, LegacyChannelBinding } from './types'

/**
 * Persistent storage for {@link ChannelBinding}s. Writes through to a flat
 * JSON file under `~/.glanceterm/`. No locking — concurrent GlanceTerm
 * instances aren't a supported configuration.
 *
 * Why a sibling file instead of tabby-core's ConfigService:
 *   - The bridge owns its own UI (task #11 builds its panel inside the
 *     plugin, not the global Settings dialog), so ConfigService gives us
 *     nothing here except an extra dependency on tabby's config schema.
 *   - The file is easy to back up / wipe / inspect by hand for debugging.
 *
 * Hardening note: see {@link ChannelBinding.botToken} — secret storage
 * needs to move to keytar before a public release.
 */
@Injectable()
export class BindingStoreService {
    private static readonly FILE = path.join(os.homedir(), '.glanceterm', 'mobile-bridge-bindings.json')

    private bindingsSubject = new BehaviorSubject<ChannelBinding[]>([])
    private loaded = false
    private loadPromise: Promise<void> | null = null
    /**
     * Serializes all mutations through a single promise chain. Without
     * this, two concurrent callers (e.g. settings UI toggle racing with
     * PairingService.onTelegramInbound's store.add) both read the same
     * BehaviorSubject snapshot, mutate, and the second writer wipes
     * the first writer's change.
     */
    private writeQueue: Promise<unknown> = Promise.resolve()

    /** Stream of current bindings. Cold subscribers get the latest snapshot. */
    get bindings$ (): Observable<ChannelBinding[]> { return this.bindingsSubject }

    /** Snapshot accessor — caller is responsible for awaiting `load()` first
     *  if they need persisted data. */
    get current (): ChannelBinding[] { return this.bindingsSubject.value }

    /**
     * Idempotent disk load. Safe to call multiple times; concurrent calls
     * share the same in-flight promise.
     */
    async load (): Promise<void> {
        if (this.loaded) return
        if (this.loadPromise) return this.loadPromise
        this.loadPromise = (async () => {
            try {
                const raw = await fs.readFile(BindingStoreService.FILE, 'utf8')
                const parsed = JSON.parse(raw) as LegacyChannelBinding[]
                const migrated = Array.isArray(parsed) ? parsed.map(b => this.migrate(b)) : []
                this.bindingsSubject.next(migrated)
                // Persist the migration if any record was rewritten — keeps
                // the on-disk shape current so subsequent loads skip the
                // migrate() path entirely. Best-effort; failure here just
                // means the migration re-runs next launch.
                if (migrated.some((m, i) => parsed[i]?.botToken !== undefined && !parsed[i]?.credentials)) {
                    await this.save().catch(err => {
                        // eslint-disable-next-line no-console
                        console.warn('[mobile-bridge:store] migration save failed:', err)
                    })
                }
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                    // eslint-disable-next-line no-console
                    console.warn('[mobile-bridge:store] load failed, starting empty:', err)
                }
                this.bindingsSubject.next([])
            } finally {
                this.loaded = true
            }
        })()
        return this.loadPromise
    }

    /**
     * Forward-only migration of pre-Phase-1 records. Pre-Phase-1 stored
     * `botToken` at the top level (Telegram-only world); Phase 1 introduces
     * the `credentials` discriminated union to support Feishu / Lark.
     * Records without `credentials` are inferred from `platform` +
     * `botToken`; the legacy field is dropped on the next save.
     *
     * Records that already have `credentials` pass through unchanged.
     */
    private migrate (raw: LegacyChannelBinding): ChannelBinding {
        const { botToken, credentials, ...rest } = raw
        // Already-migrated record: preserve the credentials we just
        // destructured. The previous version returned `rest` here, which
        // had stripped `credentials` along with `botToken` — every relaunch
        // after the first migration would silently wipe the credentials,
        // breaking telegram.start() on every subsequent boot.
        if (credentials) {
            return { ...rest, credentials } as unknown as ChannelBinding
        }
        if (raw.platform === 'telegram' && typeof botToken === 'string') {
            return {
                ...(rest as unknown as Omit<ChannelBinding, 'credentials'>),
                credentials: { platform: 'telegram', botToken },
            }
        }
        // No legacy field and no credentials — record is unusable but we
        // preserve it (the BindingStore's enabled toggle is the user's
        // escape hatch). The runtime will throw when trying to start the
        // backend with undefined credentials, surfacing the broken record.
        return rest as unknown as ChannelBinding
    }

    /**
     * Add a new binding. Mints a fresh internal id; returns it for the
     * caller's records. Serialized, and rewinds the in-memory state if
     * save() rejects so disk and BehaviorSubject stay consistent.
     */
    add (partial: Omit<ChannelBinding, 'id' | 'createdAt'>): Promise<ChannelBinding> {
        return this.serialize(async () => {
            await this.load()
            const binding: ChannelBinding = {
                ...partial,
                id: randomUUID(),
                createdAt: Date.now(),
            }
            return this.applyOrRewind([...this.current, binding], () => binding)
        })
    }

    /** Mutate a binding by id. Throws if not found. Serialized + rewind. */
    update (id: string, patch: Partial<Omit<ChannelBinding, 'id'>>): Promise<ChannelBinding> {
        return this.serialize(async () => {
            await this.load()
            const idx = this.current.findIndex(b => b.id === id)
            if (idx < 0) throw new Error(`BindingStore: no binding with id=${id}`)
            const next = [...this.current]
            next[idx] = { ...next[idx], ...patch }
            return this.applyOrRewind(next, () => next[idx])
        })
    }

    /** Serialized + rewind. */
    remove (id: string): Promise<void> {
        return this.serialize(async () => {
            await this.load()
            await this.applyOrRewind(this.current.filter(b => b.id !== id), () => undefined as void)
        })
    }

    /**
     * Queue `fn` after any in-flight mutation. The queue tail is reset
     * to a resolved promise after each step so a single failure
     * doesn't poison every subsequent mutation; the returned promise
     * still rejects with the original error for the caller of the
     * failing op.
     */
    private serialize<T> (fn: () => Promise<T>): Promise<T> {
        const next = this.writeQueue.then(fn)
        this.writeQueue = next.then(() => undefined, () => undefined)
        return next
    }

    /**
     * Two-phase publish: tentatively next() the new state so reactive
     * consumers see it, then save to disk; if save fails, rewind the
     * BehaviorSubject to the prior snapshot and rethrow. Without this
     * a save failure would leave disk and memory permanently diverged —
     * the next add() would build on the unpersisted state, the user
     * would see "everything is fine" in the UI, and a relaunch would
     * silently revert. The transient bad state is acceptable; the
     * permanent divergence isn't.
     */
    private async applyOrRewind<T> (next: ChannelBinding[], result: () => T): Promise<T> {
        const snapshot = this.current
        this.bindingsSubject.next(next)
        try {
            await this.save()
        } catch (err) {
            this.bindingsSubject.next(snapshot)
            throw err
        }
        return result()
    }

    /** Find by platform — v0 caps platform to one, so this returns
     *  the binding or undefined. */
    forPlatform (platform: ChannelBinding['platform']): ChannelBinding | undefined {
        return this.current.find(b => b.platform === platform)
    }

    /**
     * Atomic write: tmp + rename. A crash mid-`writeFile` to the real
     * path would truncate the bindings file; next launch's load would
     * log "starting empty" and silently abandon every binding the user
     * had set up, including bot tokens. Renaming from a fully-written
     * tmp file collapses the failure window to the rename, which is
     * atomic on POSIX filesystems.
     *
     * Tmp filename includes PID so two GlanceTerm instances writing
     * concurrently (not a supported config, but cheap to defend
     * against) don't trample each other's staging file.
     */
    private async save (): Promise<void> {
        const dir = path.dirname(BindingStoreService.FILE)
        await fs.mkdir(dir, { recursive: true })
        const tmp = `${BindingStoreService.FILE}.${process.pid}.tmp`
        const json = JSON.stringify(this.current, null, 2)
        await fs.writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(tmp, BindingStoreService.FILE)
    }
}
