import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { GeminiHookAdapter, geminiConfigDirExistsSync } from '../hook-adapters/gemini'
import { TabStatus } from '../tab-monitor'

const HANDLER = "'/tmp/glanceterm-hook.sh' gemini"
// Gemini's installed command appends the tab-id arg (gemini expands it from
// its own env at fire time, since the hook env is sanitized — see gemini.ts).
const INSTALLED_CMD = `${HANDLER} "$GLANCETERM_TAB_ID"`
const EVENTS = [
    'SessionStart',
    'BeforeAgent',
    'AfterAgent',
    'BeforeTool',
    'AfterTool',
    'SessionEnd',
]
const OUR_ENTRY = { type: 'command', command: INSTALLED_CMD, name: 'glanceterm' }

let oldHome: string | undefined
let oldUserProfile: string | undefined
let tempHome: string

function settingsPath (): string {
    return path.join(tempHome, '.gemini', 'settings.json')
}

async function readSettings (): Promise<any> {
    return JSON.parse(await fs.readFile(settingsPath(), 'utf8'))
}

async function writeSettings (value: unknown): Promise<void> {
    const dir = path.join(tempHome, '.gemini')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(settingsPath(), JSON.stringify(value, null, 2) + '\n')
}

function installedCommandsFor (settings: any, event: string): string[] {
    return (settings.hooks?.[event] ?? [])
        .flatMap((m: any) => m.hooks ?? [])
        .filter((h: any) => typeof h.command === 'string' && h.command.includes('glanceterm-hook'))
        .map((h: any) => h.command)
}

beforeEach(async () => {
    oldHome = process.env.HOME
    oldUserProfile = process.env.USERPROFILE
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-gemini-adapter-'))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
})

afterEach(async () => {
    process.env.HOME = oldHome
    process.env.USERPROFILE = oldUserProfile
    await fs.rm(tempHome, { recursive: true, force: true })
    vi.restoreAllMocks()
})

describe('GeminiHookAdapter installHooks', () => {
    it('creates ~/.gemini/settings.json with one GlanceTerm command hook per supported event', async () => {
        const adapter = new GeminiHookAdapter()

        const report = await adapter.installHooks(HANDLER)
        const settings = await readSettings()

        expect(report.installed).toBe(true)
        expect(report.settingsPath).toBe(settingsPath())
        expect(Object.keys(settings.hooks).sort()).toEqual([...EVENTS].sort())
        for (const event of EVENTS) {
            const matchers = settings.hooks[event]
            expect(matchers).toHaveLength(1)
            expect(matchers[0]).toEqual({ hooks: [OUR_ENTRY] })
        }
    })

    it('is idempotent on a second install', async () => {
        const adapter = new GeminiHookAdapter()

        await adapter.installHooks(HANDLER)
        const before = await fs.readFile(settingsPath(), 'utf8')
        const second = await adapter.installHooks(HANDLER)
        const after = await fs.readFile(settingsPath(), 'utf8')

        expect(second.installed).toBe(false)
        expect(after).toBe(before)
        for (const event of EVENTS) {
            expect(installedCommandsFor(JSON.parse(after), event)).toEqual([INSTALLED_CMD])
        }
    })

    it('preserves existing user settings and hook entries', async () => {
        await writeSettings({
            theme: 'dark',
            hooks: {
                BeforeTool: [
                    {
                        matcher: 'run_shell_command',
                        hooks: [
                            { type: 'command', command: '$GEMINI_PROJECT_DIR/.gemini/hooks/policy.sh', name: 'policy' },
                        ],
                    },
                ],
            },
        })
        const adapter = new GeminiHookAdapter()

        await adapter.installHooks(HANDLER)
        const settings = await readSettings()

        expect(settings.theme).toBe('dark')
        // User's existing BeforeTool entry is preserved; ours is appended.
        expect(settings.hooks.BeforeTool[0]).toEqual({
            matcher: 'run_shell_command',
            hooks: [
                { type: 'command', command: '$GEMINI_PROJECT_DIR/.gemini/hooks/policy.sh', name: 'policy' },
            ],
        })
        expect(installedCommandsFor(settings, 'BeforeTool')).toEqual([INSTALLED_CMD])
    })

    it('refuses to overwrite malformed settings.json', async () => {
        const dir = path.join(tempHome, '.gemini')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(settingsPath(), '{ not valid json')
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const adapter = new GeminiHookAdapter()

        const report = await adapter.installHooks(HANDLER)
        const raw = await fs.readFile(settingsPath(), 'utf8')

        expect(report.installed).toBe(false)
        expect(raw).toBe('{ not valid json')
        expect(errorSpy).toHaveBeenCalledOnce()
    })

    it('reports installed only after every supported event has a GlanceTerm hook', async () => {
        const adapter = new GeminiHookAdapter()

        expect(await adapter.isInstalled()).toBe(false)
        await adapter.installHooks(HANDLER)
        expect(await adapter.isInstalled()).toBe(true)
    })
})

describe('GeminiHookAdapter uninstallHooks', () => {
    it('removes only GlanceTerm gemini entries and keeps user + other-agent hooks', async () => {
        await writeSettings({
            hooks: {
                BeforeTool: [
                    {
                        matcher: 'run_shell_command',
                        hooks: [
                            { type: 'command', command: '/user/hook.sh' },
                            OUR_ENTRY,
                        ],
                    },
                ],
                AfterAgent: [
                    { hooks: [OUR_ENTRY] },
                ],
                // A claude entry must survive — the agent-token regex must not
                // match 'gemini' against a 'claude' invocation.
                SessionStart: [
                    { hooks: [{ type: 'command', command: "'/tmp/glanceterm-hook.sh' claude" }] },
                ],
            },
        })
        const adapter = new GeminiHookAdapter()

        await adapter.uninstallHooks()
        const settings = await readSettings()

        expect(settings.hooks.BeforeTool).toEqual([
            { matcher: 'run_shell_command', hooks: [{ type: 'command', command: '/user/hook.sh' }] },
        ])
        expect(settings.hooks.AfterAgent).toBeUndefined()
        expect(settings.hooks.SessionStart).toEqual([
            { hooks: [{ type: 'command', command: "'/tmp/glanceterm-hook.sh' claude" }] },
        ])
    })
})

describe('GeminiHookAdapter status mapping', () => {
    it.each([
        ['BeforeAgent', TabStatus.Working],
        ['BeforeTool', TabStatus.Working],
        ['AfterTool', TabStatus.Working],
        ['AfterAgent', TabStatus.Idle],
        ['SessionStart', TabStatus.Idle],
        ['SessionEnd', TabStatus.NoAi],
        // needs_permission is deferred: Notification must NOT map to a status
        // in v1 (no confirmed notification_type matcher), so it stays null.
        ['Notification', null],
        ['UnknownEvent', null],
    ])('maps %s to %s', (event, expected) => {
        expect(new GeminiHookAdapter().mapEventToStatus(event)).toBe(expected)
    })

    it('does not claim authoritative bg-job signalling (no Bash bg flag in gemini hooks)', () => {
        expect(new GeminiHookAdapter().signalsBgJobs()).toBe(false)
    })
})

describe('geminiConfigDirExistsSync', () => {
    it('returns true only when ~/.gemini exists as a directory', async () => {
        expect(geminiConfigDirExistsSync()).toBe(false)
        await fs.mkdir(path.join(tempHome, '.gemini'))
        expect(geminiConfigDirExistsSync()).toBe(true)
    })
})
