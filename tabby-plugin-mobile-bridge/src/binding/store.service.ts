import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { randomUUID } from 'crypto'

import { BackendCredentials, PlaintextBackendCredentials, SecretRef } from '../backends/types'
import { KeystoreService } from '../keystore.service'
import { redactToken } from '../audit-log'
import { BindingDraft, ChannelBinding, LegacyChannelBinding, LegacyCredentials } from './types'

function errMessage (err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

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
    /** Non-null iff load() could not produce a trustworthy in-memory
     *  view of the persisted bindings. Three distinct sources, each with
     *  its own recovery guidance baked into the reason string:
     *    - bindings file unreadable / corrupt JSON (restore or delete it)
     *    - bindings file is valid JSON but not an array (inspect/fix it)
     *    - credential migration failed (KEYSTORE problem — the bindings
     *      file is intact and must NOT be deleted)
     *  In this state the in-memory view stays empty for reads, but every
     *  mutation is refused — saving would replace the original file with
     *  the empty list and silently destroy the user's bindings. Cleared
     *  only by restarting after the underlying problem is fixed. */
    private degradedReason: string | null = null
    /**
     * Serializes all mutations through a single promise chain. Without
     * this, two concurrent callers (e.g. settings UI toggle racing with
     * PairingService.onTelegramInbound's store.add) both read the same
     * BehaviorSubject snapshot, mutate, and the second writer wipes
     * the first writer's change.
     */
    private writeQueue: Promise<unknown> = Promise.resolve()

    constructor (private keystore: KeystoreService) {}

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
                // Phase 1: read + parse. Only failures HERE may blame the
                // bindings file — the recovery text tells the user to
                // restore or delete it, which is only safe advice when the
                // file itself is actually the problem.
                let parsed: LegacyChannelBinding[]
                try {
                    const raw = await fs.readFile(BindingStoreService.FILE, 'utf8')
                    const maybe = JSON.parse(raw) as unknown
                    if (!Array.isArray(maybe)) {
                        // Valid JSON of the wrong shape (hand-edit, partial
                        // restore, foreign format) carries the same
                        // destruction risk as corrupt JSON: treating it as
                        // empty and later saving would overwrite the user's
                        // real data with [].
                        this.degrade(
                            'the bindings file is valid JSON but not an array. '
                            + `Inspect/fix ${BindingStoreService.FILE} (restore from backup if needed), then restart GlanceTerm.`,
                        )
                        this.bindingsSubject.next([])
                        return
                    }
                    parsed = maybe as LegacyChannelBinding[]
                } catch (err: unknown) {
                    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                        // redactToken: a JSON.parse error can quote file
                        // content, and legacy bindings files held plaintext
                        // bot tokens.
                        this.degrade(
                            `the existing bindings file failed to load (${redactToken(errMessage(err))}). `
                            + 'Saving would overwrite it with an empty list and destroy the bindings it still holds. '
                            + `To recover: restore ${BindingStoreService.FILE} from backup, or delete it `
                            + 'to start fresh, then restart GlanceTerm.',
                        )
                    }
                    this.bindingsSubject.next([])
                    return
                }

                // Phase 2: credential migration. A failure here is a
                // KEYSTORE problem (its file corrupt, disk full, EACCES) —
                // the bindings file itself read fine, so the guidance must
                // not point the user at deleting an intact file.
                //
                // Sequential migration so keystore writes don't pile up in
                // an unbounded parallel fan-out; KeystoreService serialises
                // saves internally but the JSON round-trip of each write
                // dominates wall-clock anyway.
                try {
                    const results: Array<{ binding: ChannelBinding; changed: boolean }> = []
                    for (const raw of parsed) {
                        results.push(await this.migrate(raw))
                    }
                    const migrated = results.map(r => r.binding)
                    this.bindingsSubject.next(migrated)
                    if (results.some(r => r.changed)) {
                        await this.save().catch(err => {
                            // eslint-disable-next-line no-console
                            console.warn('[mobile-bridge:store] migration save failed:', err)
                        })
                    }
                } catch (err: unknown) {
                    this.degrade(
                        `credential migration failed (${redactToken(errMessage(err))}). `
                        + `The bindings file (${BindingStoreService.FILE}) is intact — do NOT delete it. `
                        + 'Fix the keystore problem (see earlier errors), then restart GlanceTerm.',
                    )
                    this.bindingsSubject.next([])
                }
            } finally {
                this.loaded = true
            }
        })()
        return this.loadPromise
    }

    /** Enter degraded (mutation-refuse) mode with a reason that already
     *  carries source-specific recovery guidance. */
    private degrade (reason: string): void {
        this.degradedReason = reason
        // eslint-disable-next-line no-console
        console.warn('[mobile-bridge:store] entering degraded (mutation-refuse) mode:', reason)
    }

    /** Throws if the store is degraded. Called at every mutation entry
     *  point so add() fails BEFORE persisting a secret to the keystore —
     *  without this, each retry of a doomed add() leaks one orphan
     *  keystore entry (save() would still refuse, but only after the
     *  keystore write already hit disk). */
    private assertWritable (): void {
        if (this.degradedReason) {
            throw new Error(`BindingStore: refusing to modify bindings — ${this.degradedReason}`)
        }
    }

    /**
     * Forward-only migration covering three on-disk shapes:
     *   - Pre-Phase-1: top-level `botToken` (Telegram-only world)
     *   - Phase 1: `credentials.botToken` as plaintext string
     *   - Phase 2 (current): `credentials.botToken` as SecretRef
     *
     * Any plaintext secret encountered is written to {@link KeystoreService}
     * and replaced with a SecretRef pointer in the in-memory record.
     * The returned `changed` flag drives the post-load save so the on-disk
     * shape catches up to current.
     *
     * Keystore ids are DETERMINISTIC from the binding id + secret kind
     * (`binding-${id}-bot-token`, etc.). On a save-failure → re-launch →
     * re-migration cycle the second migration write hits the SAME
     * keystore id and overwrites instead of accumulating; the previous
     * version minted a fresh UUID per attempt and grew the encrypted
     * file by N entries per failed launch.
     */
    private async migrate (raw: LegacyChannelBinding): Promise<{ binding: ChannelBinding; changed: boolean }> {
        const { botToken, credentials, ...rest } = raw
        // Migration assumes raw.id is present (every binding ever written
        // since v0 had one). Defensive fallback to randomUUID for hand-
        // edited records that somehow lost it — slightly worse for the
        // orphan-protection invariant but better than crashing.
        const rawId = (raw as unknown as { id?: unknown }).id
        const bindingId = typeof rawId === 'string' ? rawId : randomUUID()

        // Pre-Phase-1: legacy plaintext at top-level. Only ever telegram.
        if (!credentials && raw.platform === 'telegram' && typeof botToken === 'string') {
            const ref = await this.storeSecret(botToken, this.secretIdFor(bindingId, 'bot-token'))
            return {
                binding: {
                    ...(rest as unknown as Omit<ChannelBinding, 'credentials'>),
                    credentials: { platform: 'telegram', botToken: ref },
                },
                changed: true,
            }
        }

        if (credentials) {
            const { creds: nextCreds, changed } = await this.migrateCredentials(bindingId, credentials)
            return {
                binding: { ...rest, credentials: nextCreds } as unknown as ChannelBinding,
                changed,
            }
        }

        // No usable credentials. Preserve the record so the user can
        // disable / remove it via the UI; runtime will throw when trying
        // to start the backend.
        return {
            binding: rest as unknown as ChannelBinding,
            changed: false,
        }
    }

    /**
     * Translate {@link LegacyCredentials} (plaintext OR SecretRef secrets)
     * into the current {@link BackendCredentials} shape (SecretRef only).
     * If the input was already current the return is structurally
     * identical and `changed` is false.
     */
    private async migrateCredentials (bindingId: string, creds: LegacyCredentials): Promise<{ creds: BackendCredentials; changed: boolean }> {
        if (creds.platform === 'telegram') {
            if (typeof creds.botToken === 'string') {
                const ref = await this.storeSecret(creds.botToken, this.secretIdFor(bindingId, 'bot-token'))
                return { creds: { platform: 'telegram', botToken: ref }, changed: true }
            }
            return { creds: { platform: 'telegram', botToken: creds.botToken }, changed: false }
        }
        // feishu
        if (typeof creds.appSecret === 'string') {
            const ref = await this.storeSecret(creds.appSecret, this.secretIdFor(bindingId, 'app-secret'))
            return {
                creds: { platform: 'feishu', appId: creds.appId, region: creds.region, appSecret: ref },
                changed: true,
            }
        }
        return {
            creds: { platform: 'feishu', appId: creds.appId, region: creds.region, appSecret: creds.appSecret },
            changed: false,
        }
    }

    /** Stable keystore id from binding id + secret kind. Re-running a
     *  migration writes back to the same key, preventing orphan growth. */
    private secretIdFor (bindingId: string, kind: 'bot-token' | 'app-secret'): string {
        return `binding-${bindingId}-${kind}`
    }

    /** Write a plaintext secret into the keystore under the given id and
     *  return its reference. */
    private async storeSecret (plaintext: string, id: string): Promise<SecretRef> {
        await this.keystore.write(id, plaintext)
        return { source: 'keystore', id }
    }

    /** Convert plaintext credentials (from pairing) to the SecretRef
     *  form. Keystore ids derive from the binding id so save-failure +
     *  user-retry doesn't leak unreferenced encrypted entries. */
    private async credentialsFromPlaintext (bindingId: string, plain: PlaintextBackendCredentials): Promise<BackendCredentials> {
        if (plain.platform === 'telegram') {
            const ref = await this.storeSecret(plain.botToken, this.secretIdFor(bindingId, 'bot-token'))
            return { platform: 'telegram', botToken: ref }
        }
        const ref = await this.storeSecret(plain.appSecret, this.secretIdFor(bindingId, 'app-secret'))
        return { platform: 'feishu', appId: plain.appId, region: plain.region, appSecret: ref }
    }

    /**
     * Add a new binding from a {@link BindingDraft}. Mints a fresh
     * internal id; writes the plaintext secret(s) to keystore and stores
     * the SecretRef pointer(s) in the record. Serialized + rewind so
     * disk and BehaviorSubject stay consistent on save failure.
     *
     * If save() rejects after the keystore write succeeded, the keystore
     * entry leaks (orphaned secret with no referring binding). Acceptable
     * — `remove()` doesn't currently delete keystore entries either, and
     * fixing that is a separate hygiene pass; the user can hand-edit
     * the encrypted file or wait for the disk-space pressure that never
     * actually arrives at the kilobyte scale these secrets occupy.
     */
    add (draft: BindingDraft): Promise<ChannelBinding> {
        return this.serialize(async () => {
            await this.load()
            this.assertWritable()
            // v0 cap: one binding per platform. Defence in depth — the
            // settings UI only shows bindings[0] and only one pairing flow
            // can be active at a time, but a duplicate /bind landing
            // inside the keystore-write window of a previous /bind could
            // pass the PairingService claim and reach here. Reject so we
            // don't end up with an invisible second binding the user
            // can't disconnect.
            if (this.current.some(b => b.platform === draft.platform)) {
                throw new Error(
                    `BindingStore: a ${draft.platform} binding already exists. `
                    + 'Disconnect the existing one before adding another.',
                )
            }
            const id = randomUUID()
            // Pass the binding id INTO credential creation so the keystore
            // keys are derived from it (binding-{id}-bot-token etc.). On
            // save failure the orphan keystore entry is bounded — at most
            // one per add() click — and would be overwritten if the user
            // somehow retries with the same id (impossible with a fresh
            // uuid each call, but the discipline matches migrate()'s
            // stable-id pattern).
            const credentials = await this.credentialsFromPlaintext(id, draft.credentials)
            const binding: ChannelBinding = {
                ...draft,
                credentials,
                id,
                createdAt: Date.now(),
            }
            return this.applyOrRewind([...this.current, binding], () => binding)
        })
    }

    /** Mutate a binding by id. Throws if not found. Serialized + rewind. */
    update (id: string, patch: Partial<Omit<ChannelBinding, 'id'>>): Promise<ChannelBinding> {
        return this.serialize(async () => {
            await this.load()
            this.assertWritable()
            const idx = this.current.findIndex(b => b.id === id)
            if (idx < 0) throw new Error(`BindingStore: no binding with id=${id}`)
            const next = [...this.current]
            next[idx] = { ...next[idx], ...patch }
            return this.applyOrRewind(next, () => next[idx])
        })
    }

    /** Serialized + rewind. Also clears the keystore entries the removed
     *  binding referenced — orphan secrets accumulating across disconnect/
     *  reconnect cycles would be a slow-growing privacy leak. */
    remove (id: string): Promise<void> {
        return this.serialize(async () => {
            await this.load()
            this.assertWritable()
            const target = this.current.find(b => b.id === id)
            await this.applyOrRewind(this.current.filter(b => b.id !== id), () => undefined as void)
            if (target) {
                for (const ref of this.secretRefsOf(target.credentials)) {
                    await this.keystore.delete(ref.id).catch(err => {
                        // eslint-disable-next-line no-console
                        console.warn('[mobile-bridge:store] keystore delete failed:', err)
                    })
                }
            }
        })
    }

    private secretRefsOf (creds: BackendCredentials): SecretRef[] {
        if (creds.platform === 'telegram') return [creds.botToken]
        return [creds.appSecret]
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
        // Defence in depth behind assertWritable() at the mutation entry
        // points — the reason string already carries the right recovery
        // guidance for whichever failure put us in degraded mode.
        if (this.degradedReason) {
            throw new Error(`BindingStore: refusing to save — ${this.degradedReason}`)
        }
        const dir = path.dirname(BindingStoreService.FILE)
        await fs.mkdir(dir, { recursive: true })
        const tmp = `${BindingStoreService.FILE}.${process.pid}.tmp`
        const json = JSON.stringify(this.current, null, 2)
        await fs.writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(tmp, BindingStoreService.FILE)
    }
}
