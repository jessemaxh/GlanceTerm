import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { BindingStoreService } from './binding/store.service'

/**
 * Owns `~/.glanceterm/permission-relay.flag` — the one-byte file the hook
 * handler reads (`head -c 1`) to decide whether to push Claude's
 * PermissionRequest events to Telegram and block on the user's verdict.
 *
 * No UI surface as of the simplified settings rewrite. The flag is now
 * an automatic side-effect of the bindings state: any enabled telegram
 * binding ⇒ flag is "1", otherwise "0". The user's mental model is
 * "Mobile Bridge is on" — surfacing a separate relay toggle was v0
 * legacy from before the topic-sync model when individual event types
 * were a meaningful axis.
 *
 * Persistence shape mirrors the deleted AutoApprove-flag implementation
 * deliberately:
 *   - file content is the byte "1" (on) or "0" / absent (off); the
 *     handler reads exactly one byte and tolerates trailing newlines
 *   - mode 0o600 so a multi-user host doesn't leak the toggle state
 *   - writes are serialised on a promise chain so a flurry of binding
 *     changes can't reorder
 *
 * Conflict with auto-approve is handled inside the hook handler:
 * auto-approve short-circuits BEFORE relay code runs. If both flags are
 * "1" the phone stays silent for that request. No coordination needed
 * here — we just write our flag in response to our own state.
 */
@Injectable()
export class PermissionModeService implements OnDestroy {
    /** Same path the hook handler reads. Hard-coded rather than pulled
     *  from HookRuntimeService.root so this plugin doesn't take a hard
     *  dependency on ai-sidebar's internals — the cross-plugin contract
     *  is the file path, nothing more. */
    private readonly flagPath = path.join(os.homedir(), '.glanceterm', 'permission-relay.flag')
    private readonly root = path.dirname(this.flagPath)

    /** Last byte we successfully wrote — skips no-op writes (same
     *  optimisation as the prior toggle implementation). `null` means
     *  "haven't written yet this session" so the next call always writes
     *  regardless of computed desired state. */
    private lastWritten: string | null = null
    private writing: Promise<void> = Promise.resolve()
    private sub: Subscription | null = null
    private destroyed = false

    constructor (store: BindingStoreService) {
        // CRITICAL: BindingStoreService.bindings$ is a BehaviorSubject
        // seeded with []. Subscribing synchronously would fire immediately
        // with `[]` → want=false → writeFlag('0'), clobbering whatever the
        // previous session left on disk BEFORE load() reads the persisted
        // bindings. Any hook-handler permission request during that window
        // would read "0" and skip the Telegram relay entirely (the v1
        // launch-window-clobber regression caught in reviewer pass 2026-06-08).
        //
        // Fix: await load() before subscribing. The first emission we observe
        // is then the post-load state (real bindings or empty if first run).
        // ngOnDestroy may fire before this resolves on a very fast unload —
        // guard with `destroyed` so we don't subscribe after teardown.
        void store.load().then(() => {
            if (this.destroyed) return
            this.sub = store.bindings$.subscribe(bindings => {
                const want = bindings.some(b => b.platform === 'telegram' && b.enabled)
                void this.writeFlag(want)
            })
        })
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.sub?.unsubscribe()
    }

    private async writeFlag (on: boolean): Promise<void> {
        const desired = on ? '1' : '0'
        if (this.lastWritten === desired) return
        // Chain to serialise rapid emissions.
        this.writing = this.writing.then(async () => {
            try {
                await fs.mkdir(this.root, { recursive: true })
                await fs.writeFile(this.flagPath, desired, { encoding: 'utf8', mode: 0o600 })
                this.lastWritten = desired
            } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                    '[mobile-bridge:permission-mode] could not write flag:',
                    err instanceof Error ? err.message : String(err),
                )
                // Leave `lastWritten` so the next emission retries.
            }
        })
        return this.writing
    }
}
