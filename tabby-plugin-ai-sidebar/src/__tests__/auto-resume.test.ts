import { describe, it, expect } from 'vitest'

import { buildResumeCommand, isShellSafe, toRunnableCommand } from '../auto-resume.service'

describe('toRunnableCommand', () => {
    describe('Pass 1 — exact basename match', () => {
        it('returns the bare tool name when cmdline is just the tool', () => {
            expect(toRunnableCommand('claude', 'claude')).toBe('claude')
        })

        it('preserves args after a basename match on an absolute path', () => {
            expect(toRunnableCommand('/usr/local/bin/claude --resume foo', 'claude'))
                .toBe('claude --resume foo')
        })

        it('matches a node-launched .js basename', () => {
            expect(toRunnableCommand('node /path/to/claude.js --resume foo', 'claude'))
                .toBe('claude --resume foo')
        })

        it('matches a .mjs basename', () => {
            expect(toRunnableCommand('node /path/to/claude.mjs --model gpt-5', 'claude'))
                .toBe('claude --model gpt-5')
        })

        it('preserves --key=value style flags', () => {
            expect(toRunnableCommand('claude --model=claude-opus-4-7 --max-tokens 4096', 'claude'))
                .toBe('claude --model=claude-opus-4-7 --max-tokens 4096')
        })

        it('reduces multiple whitespace runs to single spaces', () => {
            expect(toRunnableCommand('claude   --resume    foo', 'claude'))
                .toBe('claude --resume foo')
        })

        it('handles codex with the same Pass 1 path', () => {
            expect(toRunnableCommand('codex --model gpt-5', 'codex'))
                .toBe('codex --model gpt-5')
        })
    })

    describe('Pass 2 — path-segment match', () => {
        it('matches the @anthropic-ai/claude-code/cli.js node launch shape', () => {
            expect(toRunnableCommand(
                'node /Users/me/.local/share/npm/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume foo',
                'claude',
            )).toBe('claude --resume foo')
        })

        it('matches /codex-cli/ path segment', () => {
            expect(toRunnableCommand(
                'node /Users/me/.local/share/npm/lib/node_modules/codex-cli/dist/cli.js --model gpt-5',
                'codex',
            )).toBe('codex --model gpt-5')
        })

        it('matches /claude/ as a path segment', () => {
            expect(toRunnableCommand(
                'node /opt/anthropic/claude/index.js',
                'claude',
            )).toBe('claude')
        })
    })

    describe('Fallback', () => {
        it('returns the bare tool name when no token matches either pass', () => {
            expect(toRunnableCommand('python -m something_else', 'claude'))
                .toBe('claude')
        })

        it('returns the bare tool name on empty cmdline', () => {
            expect(toRunnableCommand('', 'claude')).toBe('claude')
        })
    })
})

describe('isShellSafe', () => {
    describe('safe cmdlines that legitimately pass', () => {
        it.each([
            ['claude'],
            ['claude --resume foo'],
            ['node /Users/me/.local/share/npm/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume foo'],
            ['claude --model=claude-opus-4-7 --max-tokens 4096'],
            ['codex -m gpt-5'],
            ['/usr/local/bin/claude --resume my-session-1'],
            ['gemini --temperature 0.7 --top-k 40'],
            ['opencode run --model anthropic/claude-opus-4-8'],
            ['claude --resume session_with_underscores'],
            ['claude --resume session-with-dashes'],
            ['claude --resume session.with.dots'],
            ['claude --output /tmp/output.txt'],  // single / is fine, no redirect
        ])('accepts: %s', cmdline => {
            expect(isShellSafe(cmdline)).toBe(true)
        })
    })

    describe('shell metacharacters that must be rejected', () => {
        it.each([
            // Command separators
            ['claude; rm -rf /', 'semicolon'],
            ['claude && rm -rf /', 'AND'],
            ['claude || echo poisoned', 'OR'],
            ['claude & echo background', 'background'],
            // Substitution
            ['claude `id`', 'backtick'],
            ['claude $(id)', 'command substitution'],
            ['claude ${HOME}/x', 'variable expansion'],
            // Redirection
            ['claude > /etc/passwd', 'redirect out'],
            ['claude < /etc/passwd', 'redirect in'],
            ['claude >> /etc/passwd', 'append'],
            // Quoting
            ['claude "wrapped"', 'double quote'],
            ['claude \'wrapped\'', 'single quote'],
            // Escape
            ['claude \\n', 'backslash'],
            // Comment
            ['claude --resume foo # rm -rf', 'comment'],
            // Control chars
            ['claude\nrm -rf /', 'newline'],
            ['claude\rrm -rf /', 'carriage return'],
            ['claude\trm -rf /', 'tab'],
            ['claude\0rm -rf /', 'null byte'],
            // DEL
            ['claude\x7frm -rf /', 'DEL char'],
        ])('rejects: %s (%s)', (cmdline, _why) => {
            expect(isShellSafe(cmdline)).toBe(false)
        })
    })

    describe('edge cases', () => {
        it('accepts the empty string', () => {
            // Empty isn't dangerous; the caller decides whether to use it.
            expect(isShellSafe('')).toBe(true)
        })

        it('accepts paths with unicode', () => {
            expect(isShellSafe('claude --resume café-session')).toBe(true)
        })

        it('rejects strings ENDING with metacharacter', () => {
            expect(isShellSafe('claude --resume foo;')).toBe(false)
        })

        it('rejects strings STARTING with metacharacter', () => {
            expect(isShellSafe('; claude --resume foo')).toBe(false)
        })
    })
})

describe('buildResumeCommand', () => {
    const CLAUDE_ID = 'ea59366a-a2d5-43e1-b894-aa40a8188fb6'
    const CODEX_ID = '019eba31-ac54-7311-949e-fde38fe88a03'   // UUIDv7-style
    const OPENCODE_ID = 'ses_3cf7dd8d4ffeUPfENpVxfFojZ2'       // ses_<base62>, NOT a UUID

    describe('claude', () => {
        it('injects --resume <id> into a bare command', () => {
            expect(buildResumeCommand('claude', CLAUDE_ID, 'claude'))
                .toBe(`claude --resume ${CLAUDE_ID}`)
        })

        it('preserves unrelated flags', () => {
            expect(buildResumeCommand('claude', CLAUDE_ID, 'claude --model opus --permission-mode plan'))
                .toBe(`claude --resume ${CLAUDE_ID} --model opus --permission-mode plan`)
        })

        it('replaces a stale --resume <old> with the current id (no double-resume)', () => {
            expect(buildResumeCommand('claude', CLAUDE_ID, 'claude --resume old-1234 --model opus'))
                .toBe(`claude --resume ${CLAUDE_ID} --model opus`)
        })

        it('drops -r <old> short form', () => {
            expect(buildResumeCommand('claude', CLAUDE_ID, 'claude -r old --model opus'))
                .toBe(`claude --resume ${CLAUDE_ID} --model opus`)
        })

        it('drops --continue / -c (would conflict with explicit resume)', () => {
            expect(buildResumeCommand('claude', CLAUDE_ID, 'claude --continue --model opus'))
                .toBe(`claude --resume ${CLAUDE_ID} --model opus`)
            expect(buildResumeCommand('claude', CLAUDE_ID, 'claude -c'))
                .toBe(`claude --resume ${CLAUDE_ID}`)
        })

        it('drops the --resume=<old> equals form', () => {
            expect(buildResumeCommand('claude', CLAUDE_ID, 'claude --resume=old --model opus'))
                .toBe(`claude --resume ${CLAUDE_ID} --model opus`)
        })

        it('output passes the shell-safety gate', () => {
            const cmd = buildResumeCommand('claude', CLAUDE_ID, 'claude')!
            expect(isShellSafe(cmd)).toBe(true)
        })
    })

    describe('codex', () => {
        it('uses the resume subcommand form', () => {
            expect(buildResumeCommand('codex', CODEX_ID, 'codex'))
                .toBe(`codex resume ${CODEX_ID}`)
        })

        it('does not thread original flags through the subcommand', () => {
            expect(buildResumeCommand('codex', CODEX_ID, 'codex --model gpt-5'))
                .toBe(`codex resume ${CODEX_ID}`)
        })
    })

    describe('opencode', () => {
        // Real opencode ids are `ses_<base62>`, NOT UUIDs — the gate must accept them.
        it('injects --session <ses_ id>', () => {
            expect(buildResumeCommand('opencode', OPENCODE_ID, 'opencode'))
                .toBe(`opencode --session ${OPENCODE_ID}`)
        })

        it('drops a prior -s <old> / --continue', () => {
            expect(buildResumeCommand('opencode', OPENCODE_ID, 'opencode -s old --continue'))
                .toBe(`opencode --session ${OPENCODE_ID}`)
        })

        it('rejects a UUID for opencode (wrong format → fresh launch)', () => {
            expect(buildResumeCommand('opencode', CLAUDE_ID, 'opencode')).toBeNull()
        })

        it('output passes the shell-safety gate', () => {
            expect(isShellSafe(buildResumeCommand('opencode', OPENCODE_ID, 'opencode')!)).toBe(true)
        })
    })

    describe('per-tool id-format validation', () => {
        it('claude/codex reject a ses_ id (only opencode uses that shape)', () => {
            expect(buildResumeCommand('claude', OPENCODE_ID, 'claude')).toBeNull()
            expect(buildResumeCommand('codex', OPENCODE_ID, 'codex')).toBeNull()
        })

        it('opencode rejects a malformed ses_ id with metacharacters', () => {
            expect(buildResumeCommand('opencode', 'ses_foo; rm -rf ~', 'opencode')).toBeNull()
            expect(buildResumeCommand('opencode', 'ses_', 'opencode')).toBeNull()
        })
    })

    describe('unsupported / invalid', () => {
        it('returns null for gemini (no CLI resume-by-id)', () => {
            expect(buildResumeCommand('gemini', CLAUDE_ID, 'gemini')).toBeNull()
        })

        it('returns null for an unknown tool', () => {
            expect(buildResumeCommand('aider', CLAUDE_ID, 'aider')).toBeNull()
        })

        it('returns null when the session id is not a valid id (anti-injection)', () => {
            expect(buildResumeCommand('claude', 'not-a-uuid', 'claude')).toBeNull()
            expect(buildResumeCommand('claude', 'foo; rm -rf ~', 'claude')).toBeNull()
            expect(buildResumeCommand('claude', '', 'claude')).toBeNull()
        })
    })
})
