import { Injectable, OnDestroy } from '@angular/core'
import { Subscription, combineLatest } from 'rxjs'
import { debounceTime } from 'rxjs/operators'

import { TabIdentityService, TabIdentity } from './tab-identity.service'
import { BindingStoreService } from './binding/store.service'
import { ChannelBinding } from './binding/types'
import { TopicService } from './topic.service'
import { InstanceLockService } from './instance-lock.service'

/**
 * Mirrors GlanceTerm tab state onto Telegram Forum Topics, 1:1.
 *
 * Truth source: {@link TabIdentityService.identities$} — every tab in
 * `app.tabs` gets a UUID + displayIndex + title. The cache lives in
 * {@link TopicService} keyed on `(bindingId, tabUuid)`.
 *
 * Lifecycle reactions:
 *   - New uuid appears in identities → createForumTopic
 *   - uuid disappears from identities → closeForumTopic (history retained)
 *   - displayIndex / title drifts → editForumTopic (rename)
 *   - cached entry was closed but uuid is back → reopenForumTopic
 *     (rare in practice — restored tabs get fresh uuids from
 *     TabIdentityService — but defensive against future reconnection
 *     logic and against TOPIC_CLOSED races on the dispatcher path)
 *
 * Why not just lazy-create-on-send (the v0 behaviour we're replacing):
 * v0 left empty tabs invisible to the phone, and never closed dead
 * topics. The user's mental model is "phone == desktop, just smaller" —
 * lazy-create violated that on every shell tab.
 *
 * Rate control: per-binding serial queue with a 250 ms gap between ops.
 * Telegram's per-chat send limit is ~1 req/s; topic management appears
 * to allow faster but isn't formally documented. 250 ms (4 req/s) is
 * comfortably conservative and lets a 20-tab launch reconcile in ~5 s
 * instead of hammering and eating 429s.
 *
 * Debounce: 1 s on the combined identities$ × bindings$ stream. Both
 * subjects seed with [] then re-emit real data once their loads complete;
 * without debounce we'd diff against an empty identities list and try
 * to close every topic on every launch.
 *
 * Op-dedup: a Set of in-flight op keys per binding stops back-to-back
 * diffs from queueing duplicate work. Without it, a rapid identities$
 * burst (e.g. user opens 5 tabs in 2 s) would schedule overlapping
 * create calls — TopicService.syncCreateTopic's in-flight Map dedupes
 * the Telegram side, but the queue slots would still be consumed,
 * delaying real work by 250 ms × dup-count.
 */
@Injectable()
export class TopicSyncService implements OnDestroy {
    /** Quiet window before reconciling. Long enough to absorb the
     *  app-launch BehaviorSubject seeding flurry, short enough that
     *  a single user-driven new-tab is felt as immediate. */
    private static readonly DEBOUNCE_MS = 1_000
    /** Gap between Telegram API ops within one binding's queue. */
    private static readonly THROTTLE_MS = 250

    private subs: Subscription[] = []
    /** Per-binding promise tail. New ops chain onto this; failures don't
     *  poison the chain (caught inside the queued thunk). */
    private queues = new Map<string, Promise<void>>()
    /** Per-binding set of in-flight op identifiers (e.g. "create:<uuid>").
     *  Read before enqueue to skip duplicates; written/cleared by the queue. */
    private inProgressOps = new Map<string, Set<string>>()
    /** Per-binding "we need another reconcile after current ops drain"
     *  marker. Set when an enqueue is suppressed by the in-progress
     *  dedup; checked at queue-drain time to trigger a follow-up
     *  reconcile against the latest identities snapshot.
     *
     *  Without this, a fast double-rename (titleChange A → in-flight
     *  retitle:X; titleChange B → dedup skip) leaves the phone topic
     *  stuck on title A. The redo bit makes the dedup latest-wins
     *  rather than first-wins. */
    private redoNeeded = new Set<string>()

    constructor (
        private identity: TabIdentityService,
        private store: BindingStoreService,
        private topics: TopicService,
        private lock: InstanceLockService,
    ) {
        this.subs.push(
            combineLatest([this.identity.identities$, this.store.bindings$])
                .pipe(debounceTime(TopicSyncService.DEBOUNCE_MS))
                .subscribe(([identities, bindings]) =>
                    void this.reconcile(identities, bindings)),
        )
        // Kick BindingStore load — combineLatest will fire once both
        // subjects have produced their first emission. store.load() is
        // idempotent so other consumers (PairingService etc.) load() too.
        void this.store.load()
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
    }

    private async reconcile (identities: TabIdentity[], bindings: ChannelBinding[]): Promise<void> {
        // Single-instance guard — a secondary GlanceTerm must not mutate
        // shared topic state (would clobber the primary's writes and burn
        // Telegram quota creating duplicates).
        if (!await this.lock.isPrimary()) return
        for (const binding of bindings) {
            if (!binding.enabled) continue
            // No per-platform filter: reconcileBinding's actual ops go
            // through BackendRegistry.forPlatform(binding.platform), so
            // every backend that implements MessagingBackend handles its
            // own thread lifecycle. A telegram-only guard here (Phase 1
            // leftover) silently disabled sync for Feishu — bindings
            // created topics on first lazy ensureTopic but tab close /
            // rename never propagated.
            try {
                await this.reconcileBinding(binding, identities)
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[mobile-bridge:topic-sync] reconcile failed for ${binding.id}:`, err)
            }
        }
    }

    private async reconcileBinding (binding: ChannelBinding, identities: TabIdentity[]): Promise<void> {
        const cached = await this.topics.snapshotForBinding(binding.id)
        const cachedByUuid = new Map(cached.map(c => [c.tabUuid, c.entry]))
        const desiredByUuid = new Map(identities.map(i => [i.uuid, i]))

        // 1. Create / reopen / retitle for tabs present in identities.
        for (const identity of identities) {
            const entry = cachedByUuid.get(identity.uuid)
            if (!entry) {
                this.enqueue(binding.id, `create:${identity.uuid}`, () =>
                    this.topics.syncCreateTopic(binding, identity).then(() => undefined))
                continue
            }
            if (entry.status === 'closed') {
                this.enqueue(binding.id, `reopen:${identity.uuid}`, () =>
                    this.topics.syncReopenTopic(binding, identity.uuid))
            }
            const expected = this.topics.formatTitle(identity)
            if (entry.lastTitle !== expected) {
                this.enqueue(binding.id, `retitle:${identity.uuid}`, () =>
                    this.topics.syncRetitleTopic(binding, identity))
            }
        }

        // 2. Close topics whose tabs are gone. Already-closed entries are
        //    no-ops inside syncCloseTopic but we filter here too so they
        //    don't burn queue slots / throttle gaps.
        for (const { tabUuid, entry } of cached) {
            if (desiredByUuid.has(tabUuid)) continue
            if (entry.status === 'closed') continue
            this.enqueue(binding.id, `close:${tabUuid}`, () =>
                this.topics.syncCloseTopic(binding, tabUuid))
        }
    }

    private enqueue (bindingId: string, opKey: string, fn: () => Promise<void>): void {
        let ops = this.inProgressOps.get(bindingId)
        if (!ops) {
            ops = new Set<string>()
            this.inProgressOps.set(bindingId, ops)
        }
        if (ops.has(opKey)) {
            // Dup skip — but record that work was requested while busy
            // so the drain check fires another reconcile against the
            // latest state. Caller's `fn` closure is bound to the
            // identity snapshot at enqueue time; the redo path re-derives
            // from `identity.current`, so a second rename A→B→C that
            // gets squashed here is recovered by the redo reading the
            // current C-state.
            this.redoNeeded.add(bindingId)
            return
        }
        ops.add(opKey)
        const prev = this.queues.get(bindingId) ?? Promise.resolve()
        const next = prev.then(async () => {
            try {
                await fn()
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[mobile-bridge:topic-sync] op ${opKey} failed:`, err)
            } finally {
                ops!.delete(opKey)
            }
            // Throttle gap AFTER the op completes — keeps the next item
            // waiting even if the previous returned instantly (cache hit
            // path inside syncCreateTopic etc.). Without this a queue
            // full of no-op cache hits would burst at native speed and
            // make the throttle useless for the real-work items behind.
            await new Promise(r => setTimeout(r, TopicSyncService.THROTTLE_MS))

            // Drain check: when this op was the LAST in flight for the
            // binding AND a redo was requested while we were busy, fire
            // another reconcile against the latest identities snapshot.
            // We read from this.identity.current (sync) rather than the
            // identities$ stream so we don't have to wait for the next
            // emission to catch up. store.current likewise.
            if (ops!.size === 0 && this.redoNeeded.has(bindingId)) {
                this.redoNeeded.delete(bindingId)
                const binding = this.store.current.find(b => b.id === bindingId)
                if (binding && binding.enabled) {
                    try {
                        await this.reconcileBinding(binding, this.identity.current)
                    } catch (err) {
                        // eslint-disable-next-line no-console
                        console.warn('[mobile-bridge:topic-sync] redo reconcile failed:', err)
                    }
                }
            }
        })
        this.queues.set(bindingId, next)
    }
}
