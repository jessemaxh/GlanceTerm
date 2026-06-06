import { describe, it, expect } from 'vitest'

import { isShellSafe, toRunnableCommand } from '../auto-resume.service'

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
            ['aider --4-turbo --no-auto-commits'],
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
