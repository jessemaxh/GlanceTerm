import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import { distinctUntilChanged, map } from 'rxjs/operators'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as os from 'os'
import * as path from 'path'

import { TabMonitor } from 'tabby-plugin-ai-sidebar'

import { TabIdentityService } from './tab-identity.service'
import { BindingStoreService } from './binding/store.service'
import { TopicService } from './topic.service'
import { BackendRegistry } from './backends/registry.service'
import { InteractiveSpec, MessageRef } from './backends/types'
import { appendAudit, redactToken } from './audit-log'

/**
 * The bridge between the hook handler's file-IPC permission-relay protocol
 * and the Telegram side.
 *
 * **The file-IPC contract** (cross-process, language-agnostic):
 *   1. Handler writes `~/.glanceterm/permissions/<5-letter-id>.req` whose
 *      body is the raw Claude PermissionRequest payload (JSON).
 *   2. Handler polls every 100 ms for `~/.glanceterm/permissions/<id>.decision`.
 *   3. When `.decision` appears, handler reads ONE word — `allow` / `deny` /
 *      `cancel` — and either emits a hookSpecificOutput JSON to its stdout
 *      (allow/deny) or exits silent so Claude's local dialog handles it
 *      (cancel / anything else).
 *   4. Handler deletes both `.req` and `.decision` on its way out; if the
 *      handler dies the .req is left and we sweep it on next startup.
 *
 * This service:
 *   - watches the permissions dir; on `.req` arrival, picks the tab from
 *     the payload's `cwd` -> session match (via TabIdentityService), then
 *     sends a message with an inline-keyboard ✅ Allow / ❌ Deny to EVERY
 *     enabled binding. There is no per-tab binding scope in v0 — every
 *     enabled binding sees and may answer every prompt. Fine while all
 *     bindings belong to the same user (one binding per platform, paired
 *     from this machine); MUST grow a binding↔tab scope check here and
 *     in applyVerdict before bindings can ever span users.
 *   - records the sent (chat_id, message_id) per id so it can later
 *     editMessageText to remove the keyboard after a verdict;
 *   - on `.decision` arrival, edits the message to show who answered;
 *   - sweeps stale `.req` files older than 30 min on startup.
 *
 * The matching .decision-writing logic lives in InboundRouterService —
 * inline-keyboard taps and `yes <id>` / `no <id>` text both land there.
 * Keeping the write and the watch in different services keeps the
 * inbound-side fan-out (callbacks vs. text) close to the existing
 * inbound routing code, while this service owns the file-IPC half alone.
 */
@Injectable()
export class PermissionRelayService implements OnDestroy {
    private static readonly PERM_DIR = path.join(os.homedir(), '.glanceterm', 'permissions')
    /** Stale-.req sweep threshold. Matches the handler's 25 min poll
     *  budget with a 5 min safety margin — anything older than this is
     *  guaranteed orphaned (the handler has already given up). */
    private static readonly STALE_REQ_MS = 30 * 60_000

    /** id -> per-binding MessageRef of the prompt sent. Multiple bindings
     *  can mirror the same prompt; we track each so an edit-on-verdict
     *  reaches every chat. The inner Map keys on bindingId so a tab
     *  with multiple bindings can edit each independently. MessageRef
     *  carries chatId+threadId+messageId — enough for backend.editMessage
     *  without re-threading through the original send context. */
    private readonly outboundByReq = new Map<string, Map<string, MessageRef>>()
    /** Per-id timer that lazily evicts outboundByReq entries that never
     *  get an applyVerdict (handler timed out, GlanceTerm restarted, etc.).
     *  Matches the handler's 25 min poll ceiling + 5 min safety margin. */
    private readonly outboundTtls = new Map<string, ReturnType<typeof setTimeout>>()
    private static readonly OUTBOUND_TTL_MS = 30 * 60_000

    private watcher: fsSync.FSWatcher | null = null
    private pollHandle: ReturnType<typeof setInterval> | null = null
    private bindingSub: Subscription | null = null

    // No in-memory `seen` Set — claim semantics live in the filesystem
    // via the `.req` → `.req.sent` rename in scanOnce(). Lost across
    // restart by design: a `.req` left behind by a still-running handler
    // gets re-dispatched on next launch, which the user prefers over
    // silently dropping a real pending request.

    constructor (
        private backends: BackendRegistry,
        private store: BindingStoreService,
        private identity: TabIdentityService,
        private topics: TopicService,
        private monitor: TabMonitor,
    ) {
        void this.start()
    }

    ngOnDestroy (): void {
        this.watcher?.close()
        this.bindingSub?.unsubscribe()
        if (this.pollHandle) clearInterval(this.pollHandle)
        for (const t of this.outboundTtls.values()) clearTimeout(t)
        this.outboundTtls.clear()
    }

    private async start (): Promise<void> {
        try {
            await fs.mkdir(PermissionRelayService.PERM_DIR, { recursive: true })
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
                '[mobile-bridge:permission-relay] could not ensure permissions dir:',
                err instanceof Error ? err.message : String(err),
            )
            return
        }

        await this.sweepStale()
        await this.scanOnce()  // pick up any .req that arrived BETWEEN sweep and watch attach

        // fs.watch is the primary, event-driven detector — always on, near-zero
        // idle cost, no periodic change-detection wakeups. It's best-effort
        // (drops events on NFS/SMB and occasionally on Linux per HookWatcher's
        // own comments), so a 2 s safety-net poll guarantees no .req sits
        // unhandled longer than 2 s even when watch misses it.
        try {
            this.watcher = fsSync.watch(PermissionRelayService.PERM_DIR, () => {
                void this.scanOnce()
            })
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
                '[mobile-bridge:permission-relay] fs.watch failed, falling back to poll only:',
                err instanceof Error ? err.message : String(err),
            )
        }

        // Gate the 2 s safety-net poll on there being ≥1 enabled binding.
        // With no enabled binding there is nobody to relay a prompt to, so a
        // perpetual 2 s timer is pure waste — and because every setInterval
        // tick runs inside Angular's zone, it forces a full sidebar change
        // detection every 2 s for nothing. fs.watch stays on regardless, so
        // correctness (catching a .req the instant it lands once a binding IS
        // enabled) is unaffected; this only removes the idle backstop churn.
        this.bindingSub = this.store.bindings$
            .pipe(
                map(bindings => bindings.some(b => b.enabled)),
                distinctUntilChanged(),
            )
            .subscribe(hasEnabled => this.setBackstopPoll(hasEnabled))
    }

    /** Start/stop the 2 s fs.watch safety-net poll. Idempotent. */
    private setBackstopPoll (enabled: boolean): void {
        if (enabled && !this.pollHandle) {
            this.pollHandle = setInterval(() => void this.scanOnce(), 2_000)
        } else if (!enabled && this.pollHandle) {
            clearInterval(this.pollHandle)
            this.pollHandle = null
        }
    }

    /**
     * Discover new `.req` files in the permissions dir and dispatch each
     * to the bound Telegram chats. We mark a request "claimed" by
     * renaming `.req` → `.req.sent` after first dispatch (NOT by an
     * in-memory `seen` Set, which would lose state across GlanceTerm
     * restart and let the user receive duplicate prompts the next launch
     * for any request still in flight). The handler doesn't look at the
     * filename — it only cares about the matching `.decision` arriving —
     * so the rename is invisible to it.
     *
     * .decision files are NO LONGER watched here. The verdict path goes
     * straight from InboundRouter → applyVerdict (this service) → both
     * writes the .decision (for handler) and edits the TG bubble
     * (using outboundByReq state). See applyVerdict for the rationale.
     */
    private async scanOnce (): Promise<void> {
        let entries: string[]
        try {
            entries = await fs.readdir(PermissionRelayService.PERM_DIR)
        } catch {
            return
        }
        for (const name of entries) {
            if (!name.endsWith('.req')) continue  // skip .req.sent (already dispatched) and .decision (out-of-band)
            const full = path.join(PermissionRelayService.PERM_DIR, name)
            const id = name.slice(0, -4)
            // Atomically claim by rename — if two scanOnce()s race or the
            // 2 s poll fires while fs.watch is mid-callback, only one wins
            // the rename and the other gets ENOENT. handleReq is then
            // called exactly once per .req file lifetime.
            const claimed = path.join(PermissionRelayService.PERM_DIR, `${id}.req.sent`)
            try {
                await fs.rename(full, claimed)
            } catch {
                continue  // lost the race, or file vanished (handler timeout cleanup)
            }
            await this.handleReq(claimed, id)
        }
    }

    private async handleReq (filePath: string, id: string): Promise<void> {
        let bodyStr: string
        try {
            bodyStr = await fs.readFile(filePath, 'utf8')
        } catch {
            // Race: handler created and removed .req between watch fire and
            // our read (decision arrived very fast, e.g. from a previous
            // in-flight .decision). Nothing to do.
            return
        }

        let wrapper: RelayRequestWrapper
        try {
            wrapper = JSON.parse(bodyStr) as RelayRequestWrapper
        } catch {
            // eslint-disable-next-line no-console
            console.warn('[mobile-bridge:permission-relay] .req has non-JSON body, id=', id)
            return
        }
        const tabId = wrapper.tab_id
        const payload = wrapper.payload ?? {}

        // tab_id from the wrapper is the GLANCETERM_TAB_ID Session injected
        // and the handler captured from env. Route via the existing
        // identity lookup that already handles split panes.
        const ident = this.identity.byHookTabId(tabId)
        if (!ident) {
            // eslint-disable-next-line no-console
            console.warn('[mobile-bridge:permission-relay] no identity for hookTabId=', tabId, 'id=', id)
            return
        }

        const toolName = payload.tool_name ?? 'tool'
        const preview = summarisePayloadForPhone(payload)
        // Agent name comes from TabMonitor.current's TabState, NOT from
        // the .req payload — Claude is the only agent that writes the
        // permission-request JSON shape today, but the bridge runs for
        // any agent. Looking up via TabState gives us 'claude' / 'codex'
        // / 'gemini' / 'opencode' or undefined for raw shells.
        const tabState = this.monitor.current.find(s => {
            const uuid = this.identity.uuidOf(s.outerTab)
            return uuid === ident.uuid
        })
        const agentName = tabState?.aiTool ?? 'agent'
        const text = formatPrompt(id, agentName, toolName, preview)

        const sentForId = new Map<string, MessageRef>()
        for (const binding of this.store.current) {
            if (!binding.enabled) continue
            try {
                const threadId = await this.topics.ensureTopic(binding, ident)
                const ref = await this.backends.forPlatform(binding.platform)
                    .sendInteractive(binding.chatId, threadId, buildPromptSpec(id, text))
                sentForId.set(binding.id, ref)
            } catch (err) {
                const safe = redactToken(err instanceof Error ? err.message : String(err))
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:permission-relay] send failed for binding', binding.id, safe)
                await appendAudit({
                    kind: 'permission-prompt-failed',
                    bindingId: binding.id,
                    requestId: id,
                    error: safe,
                })
            }
        }

        if (sentForId.size > 0) {
            this.outboundByReq.set(id, sentForId)
            // Lazy eviction: if applyVerdict never fires (handler timed
            // out, GlanceTerm restarted while .req was pending) the map
            // entry would leak forever. 30 min ≥ handler's 25 min poll
            // ceiling + 5 min safety margin.
            const ttl = setTimeout(() => {
                this.outboundByReq.delete(id)
                this.outboundTtls.delete(id)
            }, PermissionRelayService.OUTBOUND_TTL_MS)
            this.outboundTtls.set(id, ttl)
        }
    }

    /**
     * Apply a remote verdict (from a phone callback tap or `yes <id>` /
     * `no <id>` text reply). Owns BOTH halves of the verdict commit:
     *
     *   1. Write the `.decision` file the hook handler is polling for.
     *      The handler reads exactly one word — `allow` / `deny` — and
     *      emits the hookSpecificOutput JSON to Claude on its own.
     *   2. Edit the original phone bubble with the verdict text and drop
     *      the inline keyboard, using the in-memory `outboundByReq`
     *      record from the original send.
     *
     * Doing both in one call avoids the race the earlier .decision-watch
     * design had: handler typically deletes .decision within ~100 ms of
     * it appearing (its poll cadence), which beat fs.watch on macOS often
     * enough that the edit pass would read an empty file and mis-render
     * "Answered at the desktop" even when the user had tapped Allow on
     * their phone. Direct call eliminates the file-system round-trip.
     *
     * Returns the same boolean as the .decision write — true means the
     * verdict made it onto disk before the handler timeout / .req
     * deletion; false means the request already resolved (locally /
     * timed out) and the verdict is stale.
     */
    async applyVerdict (id: string, verdict: 'allow' | 'deny'): Promise<boolean> {
        // 1. Write .decision for the handler. We try to write into the
        // .req's directory only if the .req (or .req.sent) is still there;
        // otherwise the handler already gave up and we'd be writing an
        // orphan .decision that nothing consumes.
        const reqPath = path.join(PermissionRelayService.PERM_DIR, `${id}.req`)
        const sentReqPath = path.join(PermissionRelayService.PERM_DIR, `${id}.req.sent`)
        let stillPending = false
        try {
            await fs.access(reqPath)
            stillPending = true
        } catch {
            try {
                await fs.access(sentReqPath)
                stillPending = true
            } catch {
                stillPending = false
            }
        }
        if (stillPending) {
            try {
                await fs.writeFile(
                    path.join(PermissionRelayService.PERM_DIR, `${id}.decision`),
                    verdict,
                    { encoding: 'utf8', mode: 0o600 },
                )
                // Drop our claim file too — handler's `rm -f $REQ_FILE`
                // looks for `<id>.req` and silently no-ops on the renamed
                // `<id>.req.sent`. Without this cleanup .req.sent files
                // accumulate until sweepStale's 30-min sweep collects them.
                fs.unlink(sentReqPath).catch(() => undefined)
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:permission-relay] .decision write failed:', err)
                stillPending = false  // treat as stale; don't edit the bubble misleadingly
            }
        }

        // 2. Edit the original message(s) — even if stale, this cleans up
        // a stuck inline keyboard from a prior local-handled prompt.
        const sent = this.outboundByReq.get(id)
        if (sent) {
            const editText = stillPending
                ? (verdict === 'allow' ? '✅ Allowed on phone' : '❌ Denied on phone')
                : '↩️ Already resolved on desktop'
            for (const [bindingId, ref] of sent) {
                // Look up the binding to resolve platform; the binding may
                // have been removed in the interim (rare), in which case
                // we silently skip the edit — the user already disconnected.
                const binding = this.store.current.find(b => b.id === bindingId)
                if (!binding) continue
                try {
                    await this.backends.forPlatform(binding.platform)
                        .editMessage(ref, editText, { clearButtons: true })
                } catch (err) {
                    const safe = redactToken(err instanceof Error ? err.message : String(err))
                    // eslint-disable-next-line no-console
                    console.warn(
                        '[mobile-bridge:permission-relay] edit failed for binding',
                        bindingId, 'id=', id, safe,
                    )
                }
            }
            this.outboundByReq.delete(id)
            const ttl = this.outboundTtls.get(id)
            if (ttl) { clearTimeout(ttl); this.outboundTtls.delete(id) }
        }

        return stillPending
    }

    private async sweepStale (): Promise<void> {
        let entries: string[]
        try {
            entries = await fs.readdir(PermissionRelayService.PERM_DIR)
        } catch {
            return
        }
        const now = Date.now()
        for (const name of entries) {
            if (!name.endsWith('.req') && !name.endsWith('.req.sent') && !name.endsWith('.decision')) continue
            const full = path.join(PermissionRelayService.PERM_DIR, name)
            try {
                const st = await fs.stat(full)
                if (now - st.mtimeMs > PermissionRelayService.STALE_REQ_MS) {
                    await fs.unlink(full)
                }
            } catch {
                // Best-effort; skip on error.
            }
        }
    }
}

/**
 * The `.req` body the hook handler writes — a wrapper around Claude's raw
 * PermissionRequest payload that adds tab routing context that the payload
 * itself doesn't carry.
 */
interface RelayRequestWrapper {
    tab_id: string
    payload: ClaudePermissionPayload
}

interface ClaudePermissionPayload {
    hook_event_name?: string
    session_id?: string
    cwd?: string
    tool_name?: string
    tool_input?: Record<string, unknown>
    [k: string]: unknown
}

/**
 * One-line summary for the IM prompt body. Bash → command; Write/Edit →
 * file path; Read/Glob/Grep → pattern; everything else → the tool name
 * alone. Phone UIs truncate long monospace lines awfully, so cap at
 * a tight per-tool threshold rather than the global Telegram 4096.
 */
function summarisePayloadForPhone (p: ClaudePermissionPayload): string {
    const input = p.tool_input ?? {}
    const str = (k: string): string => {
        const v = (input as Record<string, unknown>)[k]
        return typeof v === 'string' ? v : ''
    }
    const trunc = (s: string, n: number): string =>
        s.length > n ? s.slice(0, n - 1) + '…' : s

    switch (p.tool_name) {
        case 'Bash':
            return trunc(str('command'), 300)
        case 'Read':
        case 'Edit':
        case 'Write':
        case 'MultiEdit':
        case 'NotebookEdit':
            return trunc(str('file_path'), 200)
        case 'Glob':
        case 'Grep':
            return trunc(str('pattern'), 200)
        case 'WebFetch':
            return trunc(str('url'), 200)
        case 'WebSearch':
            return trunc(str('query'), 200)
        default:
            return ''
    }
}

/**
 * The message body the IM platform shows. The id is in the body too
 * (not just `callback_data`) so a user on a client that doesn't render
 * inline keyboards (rare today, but possible on web/legacy mobile) can
 * still answer with `yes <id>` or `no <id>` text — same convention
 * Anthropic uses in their official Channels plugin.
 *
 * Agent name comes from TabState.aiTool — 'claude' / 'codex' / 'gemini'
 * / 'opencode' — so non-Claude users see "codex wants to run Bash" instead of
 * the previously hard-coded "Claude wants to run …" which was wrong
 * everywhere except Claude tabs.
 */
function formatPrompt (id: string, agentName: string, toolName: string, preview: string): string {
    const head = `🔔 ${agentName} wants to run **${toolName}**`
    const body = preview ? `\n\n\`\`\`\n${preview}\n\`\`\`` : ''
    const tail = `\n\nTap a button — or reply \`yes ${id}\` / \`no ${id}\``
    return head + body + tail
}

/** Cross-platform interactive prompt spec for the permission request.
 *  Backends translate `buttons` into the platform-native button shape
 *  (TG inline_keyboard, Feishu interactive card). */
function buildPromptSpec (id: string, body: string): InteractiveSpec {
    return {
        body,
        buttons: [
            [
                { label: '✅ Allow', value: `perm:allow:${id}`, style: 'primary' },
                { label: '❌ Deny', value: `perm:deny:${id}`, style: 'danger' },
            ],
        ],
    }
}
