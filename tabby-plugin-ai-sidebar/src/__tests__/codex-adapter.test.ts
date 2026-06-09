import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { CodexHookAdapter, codexConfigDirExistsSync } from '../hook-adapters/codex'
import { TabStatus } from '../tab-monitor'

const HANDLER = "'/tmp/glanceterm-hook.sh' codex"
const EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'SubagentStop',
    'PermissionRequest',
]

let oldHome: string | undefined
let oldUserProfile: string | undefined
let oldCodexHome: string | undefined
let tempHome: string

async function readHooksJson (): Promise<any> {
    const raw = await fs.readFile(path.join(tempHome, '.codex', 'hooks.json'), 'utf8')
    return JSON.parse(raw)
}

async function writeHooksJson (value: unknown): Promise<void> {
    const dir = path.join(tempHome, '.codex')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'hooks.json'), JSON.stringify(value, null, 2) + '\n')
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
    oldCodexHome = process.env.CODEX_HOME
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-codex-adapter-'))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    process.env.CODEX_HOME = path.join(tempHome, '.codex')
})

afterEach(async () => {
    process.env.HOME = oldHome
    process.env.USERPROFILE = oldUserProfile
    process.env.CODEX_HOME = oldCodexHome
    await fs.rm(tempHome, { recursive: true, force: true })
    vi.restoreAllMocks()
})

describe('CodexHookAdapter installHooks', () => {
    it('creates ~/.codex/hooks.json with one GlanceTerm command hook for each supported event', async () => {
        const adapter = new CodexHookAdapter()

        const report = await adapter.installHooks(HANDLER)
        const settings = await readHooksJson()

        expect(report.installed).toBe(true)
        expect(report.settingsPath).toBe(path.join(tempHome, '.codex', 'hooks.json'))
        expect(Object.keys(settings.hooks).sort()).toEqual([...EVENTS].sort())
        for (const event of EVENTS) {
            const matchers = settings.hooks[event]
            expect(matchers).toHaveLength(1)
            expect(matchers[0]).toEqual({
                hooks: [
                    {
                        type: 'command',
                        command: HANDLER,
                    },
                ],
            })
        }
    })

    it('does not write async:true because Codex currently skips async command hooks', async () => {
        const adapter = new CodexHookAdapter()

        await adapter.installHooks(HANDLER)
        const settings = await readHooksJson()

        for (const event of EVENTS) {
            const entry = settings.hooks[event][0].hooks[0]
            expect(entry).not.toHaveProperty('async')
        }
    })

    it('is idempotent on a second install', async () => {
        const adapter = new CodexHookAdapter()

        await adapter.installHooks(HANDLER)
        const before = await fs.readFile(path.join(tempHome, '.codex', 'hooks.json'), 'utf8')
        const second = await adapter.installHooks(HANDLER)
        const after = await fs.readFile(path.join(tempHome, '.codex', 'hooks.json'), 'utf8')

        expect(second.installed).toBe(false)
        expect(after).toBe(before)
        const settings = JSON.parse(after)
        for (const event of EVENTS) {
            expect(installedCommandsFor(settings, event)).toEqual([HANDLER])
        }
    })

    it('preserves existing user hook entries while adding GlanceTerm entries', async () => {
        await writeHooksJson({
            custom: 'keep-me',
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Bash',
                        hooks: [
                            {
                                type: 'command',
                                command: '/usr/bin/python3 ~/.codex/hooks/pre_tool_use_policy.py',
                                statusMessage: 'Checking Bash command',
                            },
                        ],
                    },
                ],
            },
        })
        const adapter = new CodexHookAdapter()

        await adapter.installHooks(HANDLER)
        const settings = await readHooksJson()

        expect(settings.custom).toBe('keep-me')
        expect(settings.hooks.PreToolUse[0]).toEqual({
            matcher: 'Bash',
            hooks: [
                {
                    type: 'command',
                    command: '/usr/bin/python3 ~/.codex/hooks/pre_tool_use_policy.py',
                    statusMessage: 'Checking Bash command',
                },
            ],
        })
        expect(installedCommandsFor(settings, 'PreToolUse')).toEqual([HANDLER])
    })

    it('refuses to overwrite malformed hooks.json', async () => {
        const dir = path.join(tempHome, '.codex')
        const file = path.join(dir, 'hooks.json')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(file, '{ this is not json')
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const adapter = new CodexHookAdapter()

        const report = await adapter.installHooks(HANDLER)
        const raw = await fs.readFile(file, 'utf8')

        expect(report.installed).toBe(false)
        expect(raw).toBe('{ this is not json')
        expect(errorSpy).toHaveBeenCalledOnce()
    })

    it('reports installed only after every supported event has a GlanceTerm Codex hook', async () => {
        const adapter = new CodexHookAdapter()

        expect(await adapter.isInstalled()).toBe(false)
        await adapter.installHooks(HANDLER)

        expect(await adapter.isInstalled()).toBe(true)
    })
})

describe('CodexHookAdapter uninstallHooks', () => {
    it('removes only GlanceTerm Codex hook entries and keeps user hooks', async () => {
        await writeHooksJson({
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Bash',
                        hooks: [
                            { type: 'command', command: '/user/hook.sh' },
                            { type: 'command', command: HANDLER },
                        ],
                    },
                ],
                Stop: [
                    {
                        hooks: [
                            { type: 'command', command: HANDLER },
                        ],
                    },
                ],
                UserPromptSubmit: [
                    {
                        hooks: [
                            { type: 'command', command: "'/tmp/glanceterm-hook.sh' claude" },
                        ],
                    },
                ],
            },
        })
        const adapter = new CodexHookAdapter()

        await adapter.uninstallHooks()
        const settings = await readHooksJson()

        expect(settings.hooks.PreToolUse).toEqual([
            {
                matcher: 'Bash',
                hooks: [
                    { type: 'command', command: '/user/hook.sh' },
                ],
            },
        ])
        expect(settings.hooks.Stop).toBeUndefined()
        expect(settings.hooks.UserPromptSubmit).toEqual([
            {
                hooks: [
                    { type: 'command', command: "'/tmp/glanceterm-hook.sh' claude" },
                ],
            },
        ])
    })
})

describe('CodexHookAdapter status mapping', () => {
    it.each([
        ['UserPromptSubmit', TabStatus.Working],
        ['PreToolUse', TabStatus.Working],
        ['PostToolUse', TabStatus.Working],
        ['Stop', TabStatus.Idle],
        ['SessionStart', TabStatus.Idle],
        ['PermissionRequest', TabStatus.NeedsPermission],
        ['SubagentStop', null],
        ['UnknownEvent', null],
    ])('maps %s to %s', (event, expected) => {
        expect(new CodexHookAdapter().mapEventToStatus(event)).toBe(expected)
    })

    it('treats Codex hook bg signals as authoritative to avoid counting the native helper as bg', () => {
        expect(new CodexHookAdapter().signalsBgJobs()).toBe(true)
    })
})

describe('codexConfigDirExistsSync', () => {
    it('returns true only when ~/.codex exists as a directory', async () => {
        expect(codexConfigDirExistsSync()).toBe(false)

        await fs.mkdir(path.join(tempHome, '.codex'))

        expect(codexConfigDirExistsSync()).toBe(true)
    })
})
