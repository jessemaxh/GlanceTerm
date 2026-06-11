import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Subject, AsyncSubject } from 'rxjs'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

import { AutoApproveService } from '../auto-approve.service'

/**
 * Regression test for the startup config↔flag DRIFT.
 *
 * Bug it pins (found 2026-06-11): AutoApproveService ran its initial reconcile
 * (`void this.sync()`) synchronously in the constructor. But ConfigService
 * loads config asynchronously — `store.ai` is undefined until init() resolves
 * and fires `ready$` — so that early sync read enabled=false and wrote
 * `auto-approve.flag = "0"`, clobbering a user who actually had
 * `ai.autoApprovePermissions: true`. Because `changed$` only fires on save()
 * (never on the initial load), nothing corrected the stale "0": the feature
 * went silently dead after every app restart — shield lit in the UI, flag 0 on
 * disk, Claude falling back to its native `Bash(rm *)` prompt.
 *
 * The fix gates the first reconcile on `config.ready$` (mirroring
 * PermissionModeService, which awaits store.load() for the same reason). These
 * tests drive the not-ready → ready transition and assert the flag reflects the
 * LOADED config, never the empty-store default.
 *
 * Follows the repo's service-test convention (see auto-resume-harness): pass
 * plain fakes cast `as any` rather than standing up the real Angular DI graph.
 */

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 20))

/** Minimal ConfigService stand-in: just the surface AutoApproveService touches
 *  at construction + sync() — `changed$`, `ready$`, and `store`. */
function makeFakeConfig (store: any) {
    return {
        store,
        ready$: new AsyncSubject<boolean>(),
        changed$: new Subject<void>(),
    }
}

describe('AutoApproveService — startup config/flag reconcile (drift regression)', () => {
    let tmpRoot: string

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-aa-svc-'))
    })
    afterEach(() => {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* */ }
    })

    const flagPath = (): string => path.join(tmpRoot, 'auto-approve.flag')
    const runtime = (): any => ({ root: tmpRoot })
    // enable()'s confirm dialog returns Cancel — never reached in these tests.
    const platform = (): any => ({ showMessageBox: async () => ({ response: 1 }) })

    it('does NOT write flag="0" before config is ready (the clobber)', async () => {
        // `store.ai` absent — mimics ConfigService before init() resolves. The
        // pre-fix code would synchronously write "0" here.
        const config = makeFakeConfig({})
        const svc = new AutoApproveService(config as any, platform(), runtime())
        await tick()
        expect(fs.existsSync(flagPath())).toBe(false)
        svc.ngOnDestroy()
    })

    it('writes flag="1" once ready$ fires with the feature enabled', async () => {
        const config = makeFakeConfig({})
        const svc = new AutoApproveService(config as any, platform(), runtime())
        await tick()
        expect(fs.existsSync(flagPath())).toBe(false)   // still gated, no clobber

        // Config finishes loading: store populated, THEN ready$ completes.
        config.store = { ai: { autoApprovePermissions: true } }
        config.ready$.next(true)
        config.ready$.complete()

        await tick()
        await svc.sync()   // flush the write chain
        expect(fs.readFileSync(flagPath(), 'utf8')).toBe('1')
        svc.ngOnDestroy()
    })

    it('writes flag="0" once ready$ fires with the feature disabled', async () => {
        const config = makeFakeConfig({})
        const svc = new AutoApproveService(config as any, platform(), runtime())
        config.store = { ai: { autoApprovePermissions: false } }
        config.ready$.next(true)
        config.ready$.complete()
        await tick()
        await svc.sync()
        expect(fs.readFileSync(flagPath(), 'utf8')).toBe('0')
        svc.ngOnDestroy()
    })

    it('still reconciles when ready$ already completed before construction', async () => {
        // Config loaded fast: ready$ has already emitted+completed. AsyncSubject
        // replays its value to the late subscriber, so the gated sync still runs
        // — no boot-ordering race leaves the flag unwritten.
        const config = makeFakeConfig({ ai: { autoApprovePermissions: true } })
        config.ready$.next(true)
        config.ready$.complete()
        const svc = new AutoApproveService(config as any, platform(), runtime())
        await tick()
        await svc.sync()
        expect(fs.readFileSync(flagPath(), 'utf8')).toBe('1')
        svc.ngOnDestroy()
    })

    it('reflects a later toggle via changed$ after the initial reconcile', async () => {
        // Once ready, a config save (changed$) re-syncs the flag — the path the
        // sidebar shield button relies on.
        const config = makeFakeConfig({ ai: { autoApprovePermissions: false } })
        config.ready$.next(true)
        config.ready$.complete()
        const svc = new AutoApproveService(config as any, platform(), runtime())
        await tick()
        await svc.sync()
        expect(fs.readFileSync(flagPath(), 'utf8')).toBe('0')

        config.store.ai.autoApprovePermissions = true
        config.changed$.next()
        await tick()
        await svc.sync()
        expect(fs.readFileSync(flagPath(), 'utf8')).toBe('1')
        svc.ngOnDestroy()
    })
})
