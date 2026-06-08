import { describe, it, expect } from 'vitest'

import { isShellSafe, parsePersistedEntry, toRunnableCommand } from '../auto-resume.service'

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

describe('parsePersistedEntry', () => {
    describe('legacy bare-string entries', () => {
        it('normalises a plain command string to count=1', () => {
            // Pre-fix installs wrote the value as just the command string.
            // We accept it and assume one tab — first restored tab at the
            // cwd gets the resume, no others (the typical case anyway).
            expect(parsePersistedEntry('claude --resume foo'))
                .toEqual({ command: 'claude --resume foo', count: 1 })
        })

        it('rejects the empty string', () => {
            // Empty would mean "no command to type" — degenerate.
            expect(parsePersistedEntry('')).toBeNull()
        })
    })

    describe('new object entries', () => {
        it('preserves command and a positive count', () => {
            expect(parsePersistedEntry({ command: 'claude', count: 3 }))
                .toEqual({ command: 'claude', count: 3 })
        })

        it('defaults a missing count to 1', () => {
            // Forward-compat: future writers might drop count for cwds
            // where it's always 1; readers shouldn't choke.
            expect(parsePersistedEntry({ command: 'claude' } as unknown))
                .toEqual({ command: 'claude', count: 1 })
        })

        it('truncates non-integer counts toward zero', () => {
            expect(parsePersistedEntry({ command: 'claude', count: 2.7 }))
                .toEqual({ command: 'claude', count: 2 })
        })

        it.each([
            ['zero', 0],
            ['negative', -2],
            ['NaN', NaN],
            ['Infinity', Infinity],
        ])('defaults a %s count to 1', (_label, count) => {
            // Manual config edits / pre-fix migrations can produce odd
            // counts; we never WRITE these, but defending the read keeps
            // a future hand-edit from disabling resume entirely.
            expect(parsePersistedEntry({ command: 'claude', count }))
                .toEqual({ command: 'claude', count: 1 })
        })

        it('rejects an object with a non-string command', () => {
            expect(parsePersistedEntry({ command: 42, count: 1 } as unknown)).toBeNull()
        })

        it('rejects an object with an empty-string command', () => {
            expect(parsePersistedEntry({ command: '', count: 2 } as unknown)).toBeNull()
        })
    })

    describe('garbage / missing', () => {
        it.each([
            ['undefined', undefined],
            ['null', null],
            ['number', 42],
            ['boolean', true],
            ['empty object', {}],
            ['array', ['claude', 2]],
        ])('returns null for %s', (_label, raw) => {
            expect(parsePersistedEntry(raw as unknown)).toBeNull()
        })
    })
})
