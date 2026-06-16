import { Injectable } from '@angular/core'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

import { ChannelBinding } from './binding/types'
import { TabIdentity } from './tab-identity.service'
import { BackendRegistry } from './backends/registry.service'
import { MessagingError, ThreadRef } from './backends/types'

/**
 * Mirrors `sidebar.component.ts`'s helper of the same name. Returns the
 * trailing path segment, or `undefined` for empty / root-only inputs so
 * the caller can fall back cleanly.
 */
function folderName (p: string | undefined): string | undefined {
    if (!p) return undefined
    const trimmed = p.replace(/[/\\]+$/, '')
    if (!trimmed) return undefined
    const m = trimmed.match(/[^/\\]+$/)
    return m ? m[0] : undefined
}

/** Short machine name baked into topic titles ("<folder>@<machine>") so a
 *  phone bridged to several hosts can tell which machine a topic belongs to.
 *  os.hostname() often returns "Name.local" / an FQDN — take the first label. */
const MACHINE_NAME = os.hostname().split('.')[0] || os.hostname()

/** Local-time HH:MM. Used in archive notices that surface in the mobile
 *  topic-list preview row — full timestamp would line-wrap on iPhone. */
function formatHHMM (d: Date): string {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Cooldown window for repeat force-closes on the same topic. Inbound
 * messages on stale-closed topics get one "wasn't delivered" reply +
 * one force-close per window — burst typing or platform-side reopens
 * inside the window are absorbed silently. 30 s comfortably covers a
 * user typing a paragraph onto a wrong topic while not permanently
 * masking a legitimate re-open hours later.
 */
export const FORCED_CLOSE_COOLDOWN_MS = 30_000

/**
 * Persisted cache entry: which thread we created for a given tab, the
 * title we last pushed (rename detection), and the open/closed status
 * mirror so we can tell "tab still alive" from "tab was closed, topic is
 * archived."
 */
export interface TopicEntry {
    threadId: ThreadRef
    lastTitle: string
    status: 'open' | 'closed'
    closedAt?: number
}

/**
 * Per-tab thread lifecycle cache, keyed by `(bindingId, tabUuid)`.
 *
 * Two writers:
 *   - TopicSyncService — proactive create/close/reopen driven by diffs
 *     between TabIdentityService.identities$ and this cache.
 *   - Outbound dispatcher (via {@link ensureTopic}) — last-resort lazy
 *     create + read-only lookup on the send path, for the early-launch
 *     race window where sync hasn't reconciled yet.
 *
 * Cross-platform note: this service is messaging-platform agnostic. The
 * actual thread create/close/edit calls go through {@link BackendRegistry}
 * → {@link MessagingBackend}, dispatched per `binding.platform`. Telegram
 * Forum Topics, Feishu threads, and Discord forum posts all map to the
 * same `TopicEntry` shape — the differences (Feishu's "edit anchor to
 * mark closed" vs Telegram's native closeForumTopic) live inside the
 * backend implementation, not here.
 *
 * Title format:
 *     #<displayIndex> · <label> · <uuid-suffix>
 * where `<label>` mirrors the sidebar primary text (folder name from cwd
 * when available, falling back to the tab title) so a phone glance lines
 * up with what the user sees in GlanceTerm; `<uuid-suffix>` is the last
 * 4 chars of the UUID. Closed topics get a leading `✓ ` prefix so the
 * archive state is legible in Telegram's mobile topic list (the native
 * lock badge alone is too subtle on iPhone). We rebuild on every sync —
 * reorder/title/cwd changes all drift `displayIndex` or `<label>` and
 * trigger a re-edit.
 */
@Injectable()
export class TopicService {
    private static readonly FILE = path.join(os.homedir(), '.glanceterm', 'mobile-bridge-topics.json')

    private cache = new Map<string, TopicEntry>()
    private loaded = false
    private loadPromise: Promise<void> | null = null
    private saveTimer: ReturnType<typeof setTimeout> | null = null
    /** In-flight create dedup keyed on `(bindingId, tabUuid)`. */
    private inFlight = new Map<string, Promise<ThreadRef>>()

    constructor (private backends: BackendRegistry) {}

    /**
     * Resolve the threadId for `(binding, identity)`, creating the thread
     * on the platform side if we've never seen this tab before. Fallback
     * path — TopicSyncService normally creates proactively when a tab
     * appears, but a send arriving in the early-launch race window calls
     * ensureTopic to bootstrap. Doesn't auto-reopen a closed entry; that
     * decision is delegated to the caller (dispatcher handles
     * {@link MessagingError} kind=thread_closed explicitly).
     */
    async ensureTopic (binding: ChannelBinding, identity: TabIdentity): Promise<ThreadRef> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const cached = this.cache.get(key)
        if (cached) {
            void this.syncTitle(binding, identity).catch(err => {
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:topic] title sync failed:', err)
            })
            return cached.threadId
        }
        const inFlight = this.inFlight.get(key)
        if (inFlight) return inFlight

        const promise = (async () => {
            try {
                const name = this.formatTitle(identity)
                const threadId = await this.backends.forPlatform(binding.platform)
                    .createThread(binding.chatId, name)
                this.cache.set(key, {
                    threadId,
                    lastTitle: name,
                    status: 'open',
                })
                this.scheduleSave()
                return threadId
            } finally {
                this.inFlight.delete(key)
            }
        })()
        this.inFlight.set(key, promise)
        return promise
    }

    /** Update the thread title if it's drifted. Idempotent. */
    async syncTitle (binding: ChannelBinding, identity: TabIdentity): Promise<void> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const entry = this.cache.get(key)
        if (!entry) return
        const expected = this.formatTitle(identity)
        if (entry.lastTitle === expected) return
        try {
            await this.backends.forPlatform(binding.platform)
                .renameThread(binding.chatId, entry.threadId, expected)
            entry.lastTitle = expected
            this.scheduleSave()
        } catch (err: unknown) {
            // Thread deleted on the platform side — drop the cache entry
            // so ensureTopic re-creates next call.
            if (err instanceof MessagingError && err.kind === 'thread_not_found') {
                this.cache.delete(key)
                this.scheduleSave()
            }
            throw err
        }
    }

    // ── TopicSyncService surface ─────────────────────────────────────────

    /**
     * Synchronous peek into the cache. Returns the entry if the cache has
     * already been loaded AND the key is present; null otherwise. Callers
     * that need the cache loaded should use the async lookups instead —
     * peekEntry exists for the hot path in InboundRouter where doing
     * `await this.load()` per inbound message would queue up disk reads
     * on a busy chat.
     */
    peekEntry (bindingId: string, tabUuid: string): TopicEntry | null {
        if (!this.loaded) return null
        return this.cache.get(this.key(bindingId, tabUuid)) ?? null
    }

    async snapshotForBinding (bindingId: string): Promise<Array<{ tabUuid: string; entry: TopicEntry }>> {
        await this.load()
        const prefix = `${bindingId}|`
        const out: Array<{ tabUuid: string; entry: TopicEntry }> = []
        for (const [k, v] of this.cache) {
            if (!k.startsWith(prefix)) continue
            out.push({ tabUuid: k.substring(prefix.length), entry: { ...v } })
        }
        return out
    }

    async syncCreateTopic (binding: ChannelBinding, identity: TabIdentity): Promise<ThreadRef> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const cached = this.cache.get(key)
        if (cached) return cached.threadId
        const inFlight = this.inFlight.get(key)
        if (inFlight) return inFlight

        const promise = (async () => {
            try {
                const name = this.formatTitle(identity)
                const threadId = await this.backends.forPlatform(binding.platform)
                    .createThread(binding.chatId, name)
                this.cache.set(key, {
                    threadId,
                    lastTitle: name,
                    status: 'open',
                })
                this.scheduleSave()
                return threadId
            } finally {
                this.inFlight.delete(key)
            }
        })()
        this.inFlight.set(key, promise)
        return promise
    }

    /**
     * Close a topic. `force=true` skips the cache-status early-exit so
     * callers can re-assert closed state when the platform side diverged
     * (e.g. user manually reopened a TG topic and our cache still says
     * closed — InboundRouter calls force when an inbound lands on a
     * cache-closed topic).
     */
    async syncCloseTopic (
        binding: ChannelBinding,
        tabUuid: string,
        identity?: TabIdentity,
        force = false,
    ): Promise<void> {
        await this.load()
        const key = this.key(binding.id, tabUuid)
        const entry = this.cache.get(key)
        if (!entry) return
        if (!force && entry.status === 'closed') return
        // Cooldown: even when force=true, a repeat close within the window
        // is suppressed. Catches the inbound-flood case (5 fast messages on
        // a stale-closed topic) where each message would otherwise replay
        // rename + archive notice + closeThread, eat into the per-chat
        // 1 msg/s ceiling, and pollute the audit log. The cooldown does NOT
        // gate the legitimate "user manually reopened the topic on the
        // platform" path — `closedAt` is reset every successful close, so
        // a user-initiated reopen followed by a wait > FORCED_CLOSE_COOLDOWN_MS
        // sees the close fire normally.
        if (force && entry.status === 'closed' && entry.closedAt
            && Date.now() - entry.closedAt < FORCED_CLOSE_COOLDOWN_MS) return
        const backend = this.backends.forPlatform(binding.platform)
        // Telegram's native lock badge is too subtle on iPhone — rename
        // first so the ✓ prefix is the primary visible signal in the
        // mobile topic list. `identity` may be absent when called via
        // the tab-already-closed path (TopicSyncService can no longer
        // resolve displayIndex/name); in that case just prefix the
        // existing lastTitle without recomputing.
        const closedTitle = identity
            ? this.formatTitle(identity, 'closed')
            : entry.lastTitle.startsWith('✓ ') ? entry.lastTitle : `✓ ${entry.lastTitle}`
        try {
            if (closedTitle !== entry.lastTitle) {
                await backend.renameThread(binding.chatId, entry.threadId, closedTitle)
                entry.lastTitle = closedTitle
            }
            // Send the archive notice BEFORE close — this becomes the
            // topic's last message and shows up in the mobile topic-list
            // preview line, which is far more visible than the small
            // lock badge / title prefix. Failure is non-fatal; the close
            // itself is the important part.
            try {
                await backend.sendText(
                    binding.chatId,
                    entry.threadId,
                    `🗑️ Tab archived at ${formatHHMM(new Date())}`,
                )
            } catch (notifyErr) {
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:topic] archive notice failed (continuing to close):', notifyErr)
            }
            // Pass the last-known title so backends that emulate close
            // via title-prefix (Feishu) can preserve the original. TG
            // ignores the param.
            await backend.closeThread(binding.chatId, entry.threadId, entry.lastTitle)
        } catch (err: unknown) {
            if (err instanceof MessagingError && err.kind === 'thread_not_found') {
                this.cache.delete(key)
                this.scheduleSave()
                return
            }
            throw err
        }
        entry.status = 'closed'
        entry.closedAt = Date.now()
        this.scheduleSave()
    }

    /**
     * Permanently delete a topic and drop its cache entry. Used by the
     * launch-time orphan purge (TopicSyncService): every tab gets a fresh
     * in-memory uuid each app run, so last session's cached topics can never
     * be re-matched — left alone they pile up as one dead (closed) topic per
     * tab per restart. Backends without a native delete (Feishu / Discord)
     * degrade to closeThread so the topic at least goes quiet.
     */
    async syncDeleteTopic (binding: ChannelBinding, tabUuid: string): Promise<void> {
        await this.load()
        const key = this.key(binding.id, tabUuid)
        const entry = this.cache.get(key)
        if (!entry) return
        const backend = this.backends.forPlatform(binding.platform)
        try {
            if (backend.deleteThread) {
                await backend.deleteThread(binding.chatId, entry.threadId)
            } else {
                // No native delete — degrade to close and keep the cache entry
                // (status closed) so we don't lose the threadId mapping.
                await backend.closeThread(binding.chatId, entry.threadId, entry.lastTitle)
                entry.status = 'closed'
                entry.closedAt = Date.now()
                this.scheduleSave()
                return
            }
        } catch (err: unknown) {
            // Already gone on the platform — converge by dropping the entry.
            if (err instanceof MessagingError && err.kind === 'thread_not_found') {
                this.cache.delete(key)
                this.scheduleSave()
                return
            }
            throw err
        }
        this.cache.delete(key)
        this.scheduleSave()
    }

    async syncReopenTopic (binding: ChannelBinding, tabUuid: string, identity?: TabIdentity): Promise<void> {
        await this.load()
        const key = this.key(binding.id, tabUuid)
        const entry = this.cache.get(key)
        if (!entry) return
        if (entry.status === 'open') return
        const backend = this.backends.forPlatform(binding.platform)
        // Strip the ✓ prefix on reopen. Prefer recomputing from identity
        // (also picks up any displayIndex/cwd drift while it was closed);
        // fall back to plain prefix removal.
        const openTitle = identity
            ? this.formatTitle(identity, 'open')
            : entry.lastTitle.startsWith('✓ ') ? entry.lastTitle.slice(2) : entry.lastTitle
        try {
            // Restore the pre-close title so Feishu can strip its
            // closed-marker prefix in one edit instead of waiting for
            // syncRetitleTopic to overwrite with '(reopening)'.
            await backend.reopenThread(binding.chatId, entry.threadId, openTitle)
            if (openTitle !== entry.lastTitle) {
                await backend.renameThread(binding.chatId, entry.threadId, openTitle)
                entry.lastTitle = openTitle
            }
        } catch (err: unknown) {
            if (err instanceof MessagingError && err.kind === 'thread_not_found') {
                this.cache.delete(key)
                this.scheduleSave()
                return
            }
            throw err
        }
        entry.status = 'open'
        entry.closedAt = undefined
        this.scheduleSave()
    }

    async syncRetitleTopic (binding: ChannelBinding, identity: TabIdentity): Promise<void> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const entry = this.cache.get(key)
        if (!entry) return
        // Preserve the ✓ marker across reorders / tab-rename events: a
        // retitle on a closed topic must still produce a closed-format
        // title, otherwise the mobile-visible marker would flicker off
        // any time displayIndex drifted.
        const expected = this.formatTitle(identity, entry.status)
        if (entry.lastTitle === expected) return
        try {
            await this.backends.forPlatform(binding.platform)
                .renameThread(binding.chatId, entry.threadId, expected)
        } catch (err: unknown) {
            if (err instanceof MessagingError && err.kind === 'thread_not_found') {
                this.cache.delete(key)
                this.scheduleSave()
                return
            }
            throw err
        }
        entry.lastTitle = expected
        this.scheduleSave()
    }

    forgetBinding (bindingId: string): Promise<void> {
        const prefix = `${bindingId}|`
        let changed = false
        for (const k of [...this.cache.keys()]) {
            if (k.startsWith(prefix)) {
                this.cache.delete(k)
                changed = true
            }
        }
        if (changed) this.scheduleSave()
        return Promise.resolve()
    }

    getThreadId (bindingId: string, tabUuid: string): ThreadRef | undefined {
        return this.cache.get(this.key(bindingId, tabUuid))?.threadId
    }

    getEntry (bindingId: string, tabUuid: string): TopicEntry | undefined {
        const e = this.cache.get(this.key(bindingId, tabUuid))
        return e ? { ...e } : undefined
    }

    getStatsForBinding (bindingId: string): { open: number; closed: number } {
        const prefix = `${bindingId}|`
        let open = 0
        let closed = 0
        for (const [k, v] of this.cache) {
            if (!k.startsWith(prefix)) continue
            if (v.status === 'closed') closed++
            else open++
        }
        return { open, closed }
    }

    async findByThread (bindingId: string, threadId: ThreadRef): Promise<string | undefined> {
        await this.load()
        const prefix = `${bindingId}|`
        for (const [k, v] of this.cache) {
            if (v.threadId === threadId && k.startsWith(prefix)) {
                return k.substring(prefix.length)
            }
        }
        return undefined
    }

    private key (bindingId: string, tabUuid: string): string {
        return `${bindingId}|${tabUuid}`
    }

    /**
     * Public so TopicSyncService can diff against entry.lastTitle.
     * `status` defaults to 'open'; pass 'closed' to bake in the leading
     * ✓ marker so a subsequent retitle (e.g. user reorders tabs while
     * the topic is closed) doesn't strip it.
     */
    formatTitle (identity: TabIdentity, status: 'open' | 'closed' = 'open'): string {
        const label = folderName(identity.cwd) ?? identity.name
        const base = `${label}@${MACHINE_NAME}`
        return status === 'closed' ? `✓ ${base}` : base
    }

    private async load (): Promise<void> {
        if (this.loaded) return
        if (this.loadPromise) return this.loadPromise
        this.loadPromise = (async () => {
            try {
                const raw = await fs.readFile(TopicService.FILE, 'utf8')
                const parsed = JSON.parse(raw) as Record<string, Partial<TopicEntry> & { threadId?: number | string }>
                this.cache = new Map()
                for (const [k, v] of Object.entries(parsed)) {
                    const migrated = this.migrate(v)
                    // Drop unsalvageable entries (missing/empty threadId,
                    // hand-edited corruption) rather than poison the cache
                    // with a value that survives migrate but fails every
                    // backend call — Number('') is 0, not NaN, so a fallback
                    // empty-string threadId would silently route every send
                    // for that tab to a phantom thread_id=0.
                    if (!migrated) {
                        // eslint-disable-next-line no-console
                        console.warn('[mobile-bridge:topic] dropping corrupt cache entry:', k)
                        continue
                    }
                    this.cache.set(k, migrated)
                }
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                    // eslint-disable-next-line no-console
                    console.warn('[mobile-bridge:topic] load failed, starting empty:', err)
                }
                this.cache = new Map()
            } finally {
                this.loaded = true
            }
        })()
        return this.loadPromise
    }

    /**
     * Schema migration. Old entries (pre-Phase-1) stored threadId as a
     * number — stringify on load. Pre-sync builds didn't have `status`
     * — assume open. Forward-only: next save writes the migrated shape.
     *
     * Returns null for entries with missing / empty threadId. The caller
     * drops those rather than persist a poisoned cache row that would
     * fail every subsequent backend call.
     */
    private migrate (raw: Partial<TopicEntry> & { threadId?: number | string }): TopicEntry | null {
        const threadIdRaw = raw.threadId
        if (threadIdRaw === undefined || threadIdRaw === null || threadIdRaw === '') {
            return null
        }
        const threadId = typeof threadIdRaw === 'number'
            ? String(threadIdRaw)
            : threadIdRaw
        return {
            threadId,
            lastTitle: raw.lastTitle ?? '',
            status: raw.status ?? 'open',
            closedAt: raw.closedAt,
        }
    }

    private scheduleSave (): void {
        if (this.saveTimer) clearTimeout(this.saveTimer)
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null
            void this.flush().catch(err => {
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:topic] save failed:', err)
            })
        }, 200)
    }

    private async flush (): Promise<void> {
        const dir = path.dirname(TopicService.FILE)
        await fs.mkdir(dir, { recursive: true })
        const obj: Record<string, TopicEntry> = {}
        for (const [k, v] of this.cache) obj[k] = v
        await fs.writeFile(TopicService.FILE, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 })
    }
}
