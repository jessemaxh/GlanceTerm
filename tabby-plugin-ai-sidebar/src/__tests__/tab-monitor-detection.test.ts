import { describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { codexTranscriptCompletedAfter, detectAiToolFromCommand } from '../tab-monitor'

describe('detectAiToolFromCommand', () => {
    it.each([
        ['codex', 'codex'],
        ['codex --model gpt-5', 'codex'],
        ['/opt/homebrew/bin/codex --sandbox workspace-write', 'codex'],
        ['node /Users/me/.local/share/npm/lib/node_modules/codex-cli/dist/cli.js --model gpt-5', 'codex'],
        ['node /Users/me/.local/share/npm/lib/node_modules/codex/dist/index.mjs', 'codex'],
        ['gemini', 'gemini'],
        ['gemini --model gemini-2.5-pro', 'gemini'],
        ['node /Users/me/.local/share/npm/lib/node_modules/@google/gemini-cli/dist/index.js', 'gemini'],
        ['opencode', 'opencode'],
        ['opencode run', 'opencode'],
        ['node /Users/me/.local/share/npm/lib/node_modules/opencode/dist/index.mjs', 'opencode'],
    ] as const)('detects Codex from %s', (command, expected) => {
        expect(detectAiToolFromCommand(command)).toBe(expected)
    })

    it.each([
        ['echo codexical'],
        ['node /tmp/not-codexical/index.js'],
        ['echo geminified'],
        ['echo notopencode'],
        ['python -m pytest'],
    ])('does not false-positive Codex from %s', command => {
        expect(detectAiToolFromCommand(command)).toBeNull()
    })
})

describe('codexTranscriptCompletedAfter', () => {
    it('returns true when a Codex task_complete record is newer than the hook event', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-codex-transcript-'))
        try {
            const file = path.join(dir, 'rollout.jsonl')
            await fs.writeFile(file, [
                JSON.stringify({ timestamp: '2026-06-09T12:52:52.632Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
                JSON.stringify({ timestamp: '2026-06-09T12:53:57.090Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', completed_at: 1781009637 } }),
                '',
            ].join('\n'))

            expect(await codexTranscriptCompletedAfter(file, 1781009618 * 1000)).toBe(true)
        } finally {
            await fs.rm(dir, { recursive: true, force: true })
        }
    })

    it('returns false when the only task_complete predates the current hook event', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-codex-transcript-'))
        try {
            const file = path.join(dir, 'rollout.jsonl')
            await fs.writeFile(file, [
                JSON.stringify({ timestamp: '2026-06-09T12:49:57.090Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old', completed_at: 1781009397 } }),
                JSON.stringify({ timestamp: '2026-06-09T12:52:52.632Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'new' } }),
                '',
            ].join('\n'))

            expect(await codexTranscriptCompletedAfter(file, 1781009618 * 1000)).toBe(false)
        } finally {
            await fs.rm(dir, { recursive: true, force: true })
        }
    })

    it('returns true when a Codex abort record is newer than the hook event', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-codex-transcript-'))
        try {
            const file = path.join(dir, 'rollout.jsonl')
            await fs.writeFile(file, [
                JSON.stringify({ timestamp: '2026-06-09T12:52:52.632Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
                JSON.stringify({ timestamp: '2026-06-09T12:53:57.090Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1' } }),
                '',
            ].join('\n'))

            expect(await codexTranscriptCompletedAfter(file, 1781009618 * 1000)).toBe(true)
        } finally {
            await fs.rm(dir, { recursive: true, force: true })
        }
    })

    it('returns true when a Claude interrupted tool result is newer than the hook event', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-claude-transcript-'))
        try {
            const file = path.join(dir, 'session.jsonl')
            await fs.writeFile(file, [
                JSON.stringify({ timestamp: '2026-06-09T12:52:52.632Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } }),
                JSON.stringify({ timestamp: '2026-06-09T12:53:57.090Z', type: 'user', toolUseResult: { interrupted: true, stdout: '', stderr: '' } }),
                '',
            ].join('\n'))

            expect(await codexTranscriptCompletedAfter(file, 1781009618 * 1000)).toBe(true)
        } finally {
            await fs.rm(dir, { recursive: true, force: true })
        }
    })

    it('returns true when a Claude request-interrupted transcript marker is newer than the hook event', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-claude-transcript-'))
        try {
            const file = path.join(dir, 'session.jsonl')
            await fs.writeFile(file, [
                JSON.stringify({ timestamp: '2026-06-09T12:52:52.632Z', type: 'user', message: { role: 'user', content: [{ type: 'text', text: '状态?' }] } }),
                JSON.stringify({
                    timestamp: '2026-06-09T12:53:57.090Z',
                    type: 'user',
                    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
                    interruptedMessageId: 'msg_01',
                }),
                '',
            ].join('\n'))

            expect(await codexTranscriptCompletedAfter(file, 1781009618 * 1000)).toBe(true)
        } finally {
            await fs.rm(dir, { recursive: true, force: true })
        }
    })
})
