import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { demoteStaleClaudeResume, claudeSessionTranscriptExists } from '../auto-resume.service'

/**
 * Edge case: a session too old to resume. `claude --resume <id>` for a session
 * Claude has pruned fails with "No conversation found with session ID: …",
 * leaving the restored tab dead at a shell prompt. The auto-resume replay
 * checks the session transcript still exists and, if gone, demotes to a fresh
 * launch (keeping other flags) instead of typing a doomed --resume.
 */

const EXISTING = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const GONE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
let home: string

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'glanceterm-resume-'))
    // One project dir with a transcript for EXISTING only.
    const proj = path.join(home, '.claude', 'projects', '-Users-me-work-majiang')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, `${EXISTING}.jsonl`), '{}\n')
})

afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
})

describe('claudeSessionTranscriptExists', () => {
    it('true when the transcript exists in any project dir, false when gone', () => {
        expect(claudeSessionTranscriptExists(EXISTING, home)).toBe(true)
        expect(claudeSessionTranscriptExists(GONE, home)).toBe(false)
    })
    it('false (not throw) when ~/.claude/projects does not exist', () => {
        expect(claudeSessionTranscriptExists(EXISTING, path.join(home, 'nope'))).toBe(false)
    })
})

describe('demoteStaleClaudeResume', () => {
    it('keeps the resume command when the session still exists', () => {
        expect(demoteStaleClaudeResume(`claude --resume ${EXISTING}`, home))
            .toEqual({ command: `claude --resume ${EXISTING}`, demoted: false })
    })

    it('demotes to a fresh launch when the session is gone (the reported bug)', () => {
        expect(demoteStaleClaudeResume(`claude --resume ${GONE}`, home))
            .toEqual({ command: 'claude', demoted: true })
    })

    it('preserves other flags when demoting', () => {
        expect(demoteStaleClaudeResume(`claude --resume ${GONE} --model opus`, home))
            .toEqual({ command: 'claude --model opus', demoted: true })
    })

    it('handles the --resume=<id> single-token form', () => {
        expect(demoteStaleClaudeResume(`claude --resume=${GONE} --model opus`, home))
            .toEqual({ command: 'claude --model opus', demoted: true })
    })

    it('leaves non-Claude resume commands untouched (codex/opencode are experimental)', () => {
        expect(demoteStaleClaudeResume(`codex resume ${GONE}`, home)).toEqual({ command: `codex resume ${GONE}`, demoted: false })
        expect(demoteStaleClaudeResume(`opencode --session ses_${GONE}`, home).demoted).toBe(false)
    })

    it('leaves a non-resume claude command untouched', () => {
        expect(demoteStaleClaudeResume('claude --model opus', home)).toEqual({ command: 'claude --model opus', demoted: false })
    })

    it('ignores a malformed (non-UUID) resume id rather than demoting blindly', () => {
        expect(demoteStaleClaudeResume('claude --resume not-a-uuid', home).demoted).toBe(false)
    })
})
