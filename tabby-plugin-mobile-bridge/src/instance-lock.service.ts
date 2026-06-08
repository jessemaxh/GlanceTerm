import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import * as fs from 'fs/promises'
import { unlinkSync, readFileSync } from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * Single-instance guard for the mobile-bridge plugin.
 *
 * Why this exists: ~/.glanceterm/mobile-bridge-{bindings,topics}.json
 * and the Telegram long-poll offset are global state per `os.homedir()`.
 * Two concurrent GlanceTerm processes (production .app + a dev build,
 * the author's regular setup) will:
 *   - both long-poll the same bot token and steal each other's
 *     updates (Telegram delivers each update_id exactly once)
 *   - both write topics.json concurrently (last writer wins, lost work)
 *   - both react to the same /bind code (one of them wins, the other
 *     races on a now-spent code)
 *
 * Solution: a sticky lockfile at ~/.glanceterm/mobile-bridge.lock. First
 * process to acquire it runs the bridge; later processes go silent. Lock
 * is released on graceful shutdown (OnDestroy + process exit handlers)
 * and cleaned up as stale on next launch if the holder crashed.
 *
 * Out of scope: cross-host coordination (the lockfile is on a local
 * filesystem). If you're running GlanceTerm on two machines against the
 * same bot token, that's not a supported topology — Telegram's polling
 * model fundamentally can't support it without a real broker.
 */
@Injectable()
export class InstanceLockService implements OnDestroy {
    private static readonly LOCK_FILE = path.join(os.homedir(), '.glanceterm', 'mobile-bridge.lock')

    private acquired = false
    private readonly acquirePromise: Promise<boolean>
    /** Reactive mirror of the lock decision for UI templates. Stays `false`
     *  during the (sub-100ms) acquire window so the settings panel renders
     *  the "not primary" warning conservatively until proven otherwise —
     *  the brief flicker is invisible in practice. */
    private readonly primarySubject = new BehaviorSubject<boolean>(false)
    /** Bound once so we can `process.off` on destroy without a stale ref. */
    private readonly exitHandler = () => this.releaseSync()

    constructor () {
        this.acquirePromise = this.tryAcquire().then(ok => {
            this.primarySubject.next(ok)
            return ok
        })
        // Best-effort release on hard exits (Cmd+Q → process.exit, signals,
        // uncaught errors). Angular's OnDestroy doesn't fire on all of
        // these. unlinkSync is safe in exit handlers; unlink() is not.
        process.on('exit', this.exitHandler)
        process.on('SIGINT', this.exitHandler)
        process.on('SIGTERM', this.exitHandler)
    }

    ngOnDestroy (): void {
        this.releaseSync()
        process.off('exit', this.exitHandler)
        process.off('SIGINT', this.exitHandler)
        process.off('SIGTERM', this.exitHandler)
    }

    /**
     * Resolves true if this process holds the lock and the plugin should
     * be active. False means another live GlanceTerm has it; callers
     * suppress all outbound activity in that case.
     */
    isPrimary (): Promise<boolean> {
        return this.acquirePromise
    }

    /** Reactive variant of {@link isPrimary} for UI templates. Flips at
     *  most once per process lifetime: starts false, settles true/false
     *  when acquire resolves. */
    get isPrimary$ (): Observable<boolean> {
        return this.primarySubject
    }

    private async tryAcquire (): Promise<boolean> {
        const dir = path.dirname(InstanceLockService.LOCK_FILE)
        try {
            await fs.mkdir(dir, { recursive: true })
        } catch {
            // dir creation failure is unrecoverable — caller will see false
            // and disable. Better to silently disable than crash the app.
            return false
        }

        // Two attempts: first try, then clear stale and retry once. We
        // don't loop indefinitely — a perpetually-failing acquire means
        // some other reproducible problem (filesystem ENOSPC, perms),
        // and we'd rather disable than spin.
        for (let attempt = 0; attempt < 2; attempt++) {
            // `wx` = exclusive create. Atomically claims the lock — two
            // parallel acquirers can't both win this. The handle MUST be
            // closed even if writeFile throws, otherwise we leak an fd
            // and the lockfile holds an unparseable partial write.
            let handle: fs.FileHandle | undefined
            try {
                handle = await fs.open(InstanceLockService.LOCK_FILE, 'wx')
                await handle.writeFile(`${process.pid}\n${Date.now()}\n`)
                this.acquired = true
                return true
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                    // eslint-disable-next-line no-console
                    console.warn('[mobile-bridge:lock] acquire failed:', err)
                    return false
                }
            } finally {
                if (handle) await handle.close().catch(() => undefined)
            }
            // EEXIST — someone holds it (or held it and crashed). Decide.
            if (!this.isLockStale()) {
                // eslint-disable-next-line no-console
                console.warn(
                    '[mobile-bridge:lock] another GlanceTerm instance holds the lock; '
                    + 'mobile-bridge will be silent in this process. Quit the other '
                    + 'GlanceTerm to re-enable.',
                )
                return false
            }
            // Stale — best-effort unlink and retry. If unlink fails the
            // second open() will see EEXIST again; we'll fall through
            // and report not-primary, which is the safe answer.
            try {
                unlinkSync(InstanceLockService.LOCK_FILE)
            } catch {
                // ignore — covered by the retry
            }
        }
        return false
    }

    /**
     * Sync read of the lock holder's PID + liveness. Sync (not async) so
     * the retry loop in tryAcquire stays linear; the file is tiny and
     * the read latency is negligible compared to the EEXIST throw it
     * follows.
     */
    private isLockStale (): boolean {
        let raw: string
        try {
            raw = readFileSync(InstanceLockService.LOCK_FILE, 'utf8')
        } catch {
            // Race: lock vanished between our open()'s EEXIST and this read.
            // Treat as stale so we retry; if a fresh holder appeared in
            // that window the retry's wx open will see EEXIST again.
            return true
        }
        const pid = parseInt(raw.split('\n')[0], 10)
        if (!Number.isFinite(pid) || pid <= 0) return true
        if (pid === process.pid) {
            // Defensive: we crashed and our PID got recycled to us. Treat
            // as stale so we re-claim the file with a fresh timestamp.
            return true
        }
        try {
            // signal 0 = liveness probe. Throws ESRCH if dead, EPERM if
            // alive but unowned (different user — won't happen in our
            // setup but defensive).
            process.kill(pid, 0)
            return false
        } catch (err) {
            return (err as NodeJS.ErrnoException).code !== 'EPERM'
        }
    }

    /**
     * Sync release for exit handlers. Verifies the file still has OUR
     * pid before unlinking — paranoia against a race where a second
     * process saw us as stale, deleted, and re-acquired. Without the
     * check we'd unlink the new holder's lock on our way out.
     */
    private releaseSync (): void {
        if (!this.acquired) return
        this.acquired = false
        try {
            const raw = readFileSync(InstanceLockService.LOCK_FILE, 'utf8')
            const pid = parseInt(raw.split('\n')[0], 10)
            if (pid !== process.pid) return
            unlinkSync(InstanceLockService.LOCK_FILE)
        } catch {
            // Already gone or unreadable — nothing to release.
        }
    }
}
