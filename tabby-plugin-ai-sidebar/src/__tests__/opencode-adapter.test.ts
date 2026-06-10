import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'

import { OpencodeHookAdapter, opencodeConfigDirExistsSync, opencodePluginSource } from '../hook-adapters/opencode'
import { TabStatus } from '../tab-monitor'

let oldHome: string | undefined
let oldUserProfile: string | undefined
let tempHome: string

function pluginPath (): string {
    return path.join(tempHome, '.config', 'opencode', 'plugins', 'glanceterm.ts')
}

beforeEach(async () => {
    oldHome = process.env.HOME
    oldUserProfile = process.env.USERPROFILE
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-opencode-adapter-'))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
})

afterEach(async () => {
    process.env.HOME = oldHome
    process.env.USERPROFILE = oldUserProfile
    await fs.rm(tempHome, { recursive: true, force: true })
    vi.restoreAllMocks()
})

describe('OpencodeHookAdapter installHooks', () => {
    it('writes the GlanceTerm plugin to ~/.config/opencode/plugins/glanceterm.ts', async () => {
        const adapter = new OpencodeHookAdapter()

        const report = await adapter.installHooks('(unused for opencode)')
        const raw = await fs.readFile(pluginPath(), 'utf8')

        expect(report.installed).toBe(true)
        expect(report.settingsPath).toBe(pluginPath())
        expect(raw).toContain('glanceterm-opencode bridge')
        expect(raw).toContain('GLANCETERM_TAB_ID')
        expect(raw).toBe(opencodePluginSource())
    })

    it('is idempotent on a second install (same content → not rewritten)', async () => {
        const adapter = new OpencodeHookAdapter()

        await adapter.installHooks('x')
        const second = await adapter.installHooks('x')

        expect(second.installed).toBe(false)
    })

    it('reports installed only after the plugin file exists', async () => {
        const adapter = new OpencodeHookAdapter()

        expect(await adapter.isInstalled()).toBe(false)
        await adapter.installHooks('x')
        expect(await adapter.isInstalled()).toBe(true)
    })
})

describe('OpencodeHookAdapter uninstallHooks', () => {
    it('removes our plugin file', async () => {
        const adapter = new OpencodeHookAdapter()
        await adapter.installHooks('x')
        expect(fsSync.existsSync(pluginPath())).toBe(true)

        await adapter.uninstallHooks()
        expect(fsSync.existsSync(pluginPath())).toBe(false)
    })

    it('leaves a non-GlanceTerm file at the same path untouched', async () => {
        await fs.mkdir(path.dirname(pluginPath()), { recursive: true })
        await fs.writeFile(pluginPath(), '// someone else\nexport const X = async () => ({})\n')
        const adapter = new OpencodeHookAdapter()

        await adapter.uninstallHooks()

        expect(fsSync.existsSync(pluginPath())).toBe(true)
    })
})

describe('OpencodeHookAdapter status mapping', () => {
    it.each([
        ['working', TabStatus.Working],
        ['permission.replied', TabStatus.Working],
        ['session.idle', TabStatus.Idle],
        ['permission.asked', TabStatus.NeedsPermission],
        ['message.part.updated', null],   // raw activity types aren't emitted; only "working"
        ['UnknownEvent', null],
    ])('maps %s to %s', (event, expected) => {
        expect(new OpencodeHookAdapter().mapEventToStatus(event)).toBe(expected)
    })
})

describe('shipped opencode plugin', () => {
    it('is syntactically valid ES module JS (node --check)', () => {
        // The plugin is shipped verbatim and loaded by opencode's Bun runtime.
        // A syntax error would silently break status for every opencode tab, so
        // pin it: write to a .mjs temp file and have node parse it.
        const tmp = path.join(tempHome, 'plugin-check.mjs')
        fsSync.writeFileSync(tmp, opencodePluginSource())
        expect(() => execFileSync(process.execPath, ['--check', tmp], { encoding: 'utf8' }))
            .not.toThrow()
    })

    it('routes by GLANCETERM_TAB_ID and tags records as the opencode agent', () => {
        // Guard the two contract points the watcher depends on.
        const src = opencodePluginSource()
        expect(src).toContain('process.env.GLANCETERM_TAB_ID')
        expect(src).toContain('agent: "opencode"')
        expect(src).toContain('.glanceterm')
    })
})

describe('shipped opencode plugin — runtime behaviour', () => {
    const UUID = '11111111-2222-4333-8444-555555555555'

    /** Run the shipped plugin in a REAL node process (faithful to opencode's
     *  Bun loader, and avoids vitest's module-system interference): write the
     *  plugin + a driver that imports it and feeds `events`, then read back the
     *  per-tab log. Returns the parsed NDJSON records. */
    function driveEvents (tabId: string | undefined, events: Array<string | Record<string, any>>): any[] {
        // Items are either a bare event type (string) or a full event object
        // (e.g. { type: 'message.updated', properties: { info: {...} } }).
        const evObjs = events.map(e => typeof e === 'string' ? { type: e } : e)
        const pluginFile = path.join(tempHome, 'gt-plugin.mjs')
        fsSync.writeFileSync(pluginFile, opencodePluginSource())
        const driver =
            `import { GlanceTerm } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n` +
            `const hooks = await GlanceTerm()\n` +
            `if (hooks.event) { for (const ev of ${JSON.stringify(evObjs)}) { await hooks.event({ event: ev }) } }\n`
        const driverFile = path.join(tempHome, 'gt-driver.mjs')
        fsSync.writeFileSync(driverFile, driver)
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: tempHome, USERPROFILE: tempHome }
        if (tabId === undefined) delete env.GLANCETERM_TAB_ID
        else env.GLANCETERM_TAB_ID = tabId
        execFileSync(process.execPath, [driverFile], { env, encoding: 'utf8', timeout: 10_000 })
        const logPath = path.join(tempHome, '.glanceterm', 'hooks', `${UUID}.log`)
        if (!fsSync.existsSync(logPath)) return []
        return fsSync.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    }

    it('emits one debounced "working" edge then idle, as watcher-compatible NDJSON', () => {
        const recs = driveEvents(UUID, ['message.part.updated', 'message.part.updated', 'session.idle'])
        // Debounce: the two message.part.updated collapse to a single "working".
        expect(recs.map(r => r.event)).toEqual(['working', 'session.idle'])
        const adapter = new OpencodeHookAdapter()
        for (const r of recs) {
            expect(r.tab_id).toBe(UUID)                  // === <tab_id>.log filename base
            expect(r.agent).toBe('opencode')             // selects the adapter in the watcher
            expect(Number.isInteger(r.ts)).toBe(true)    // epoch SECONDS, not ms…
            expect(r.ts).toBeLessThan(1e12)              // …sanity: a ms value would be ~1.7e12
            expect(adapter.mapEventToStatus(r.event)).not.toBeNull()
        }
    })

    it('re-emits "working" after a permission prompt (row is not wedged on needs_permission)', () => {
        // M1 regression: permission.asked must reset the working latch so the
        // next activity re-emits working even if no permission.replied arrives.
        const recs = driveEvents(UUID, ['message.part.updated', 'permission.asked', 'message.part.updated'])
        expect(recs.map(r => r.event)).toEqual(['working', 'permission.asked', 'working'])
    })

    it('writes nothing when GLANCETERM_TAB_ID is absent (cannot attribute to a tab)', () => {
        const recs = driveEvents(undefined, ['message.part.updated', 'session.idle'])
        expect(recs).toEqual([])
    })

    it('captures the model id from an assistant message.updated and tags later records', () => {
        // event.properties.info.modelID on an assistant message → recorded as
        // `model` on the emitted records (sidebar shows it next to the tag).
        const recs = driveEvents(UUID, [
            { type: 'message.updated', properties: { info: { role: 'assistant', modelID: 'claude-opus-4-5', providerID: 'anthropic' } } },
            'session.idle',
        ])
        expect(recs.map(r => r.event)).toEqual(['working', 'session.idle'])
        expect(recs[0].model).toBe('claude-opus-4-5')
        expect(recs[1].model).toBe('claude-opus-4-5')   // sticky within the session
    })
})

describe('opencodeConfigDirExistsSync', () => {
    it('returns true only when ~/.config/opencode exists as a directory', async () => {
        expect(opencodeConfigDirExistsSync()).toBe(false)
        await fs.mkdir(path.join(tempHome, '.config', 'opencode'), { recursive: true })
        expect(opencodeConfigDirExistsSync()).toBe(true)
    })
})
