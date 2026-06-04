/**
 * Per-tool screen fingerprints. We run these regexes over the *rendered*
 * text of the last ~40 visible rows of the terminal (no ANSI escapes —
 * xterm.js already rasterised them into characters).
 *
 * Two checks per tool:
 *   - spinner:    matched while the tool is between byte chunks but still
 *                 actively working (rare — most tools tick the spinner
 *                 frame every ~100ms so the byte-rate signal catches them).
 *   - permission: the tool has stopped and is waiting on a yes/no decision.
 *
 * We deliberately do NOT match an "idle prompt" pattern. Claude/codex/aider
 * keep their input box on screen at all times, so an idle-box regex would
 * also fire mid-response. Instead, "idle" is inferred as the residual case:
 * quiet on the wire, no spinner glyph, no permission prompt.
 *
 * Regexes are intentionally loose. If a tool ships a new UI tweak we'd
 * rather miss-classify briefly and recover than false-pin to a stale state.
 */
import type { AiTool } from './tab-monitor'

export interface Fingerprint {
    spinner: RegExp[]
    permission: RegExp[]
}

export const FINGERPRINTS: Partial<Record<AiTool, Fingerprint>> = {
    claude: {
        // Claude's working footer is the most stable string in the UI:
        //   "✻ Crafting… (12s · ↑ 1.2k tokens · esc to interrupt)"
        // "esc to interrupt" only appears while Claude is actively working —
        // it's gone the moment the turn ends. We deliberately do NOT match
        // bare glyphs like ⏺/✻: ⏺ marks COMPLETED tool calls in scrollback
        // (e.g. "⏺ Bash(...)") and ✻ also appears in the static post-turn
        // summary "✻ Brewed for 43s", both of which would falsely pin the
        // tab to "working" forever once they entered the visible buffer.
        // The 1.5s byte-rate quiescence already covers the case where the
        // spinner pauses between frames (it ticks ~3×/s while active).
        spinner: [
            /esc to interrupt/i,
        ],
        // Claude's permission dialog renders a numbered menu like:
        //     ❯ 1. Yes
        //       2. Yes, and don't ask again
        //       3. No, tell Claude what to do differently (esc)
        // The arrow line is unique to live menus. We deliberately do NOT
        // match the conversational "Do you want to ..." stem — Claude itself
        // frequently writes that phrase in its responses ("Do you want to
        // proceed with option A?") which would falsely pin the tab to
        // needs_permission.
        permission: [
            /❯\s*1\.\s+Yes\b/,
        ],
    },
    codex: {
        spinner: [
            /esc to interrupt/i,
            // braille spinner frames codex uses while streaming/thinking
            /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
        ],
        // Bare "Approve?" / "allow this …" appear in model prose
        // (code reviews, docs). Keep only the explicit y/n token.
        permission: [
            /\?\s*[\[\(]y(es)?[\/\\]n/i,
        ],
    },
    gemini: {
        spinner: [/esc to interrupt/i, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
        permission: [/\?\s*[\[\(]y(es)?[\/\\]n/i],
    },
    aider: {
        // Bare /\bThinking\b/i matches the model's own prose. The braille
        // spinner ticks every ~100ms so byte-rate quiescence already catches
        // an active aider.
        spinner: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
        // aider's confirm: "(Y)es/(N)o/(A)ll/(S)kip all/(D)on't ask"
        permission: [
            /\(Y\)es\/\(N\)o/i,
            /Add .+ to the chat\?/i,
            /Run shell command\?/i,
        ],
    },
    opencode: {
        spinner: [/esc to interrupt/i, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
        permission: [/\?\s*[\[\(]y(es)?[\/\\]n/i],
    },
    goose: {
        // /\b(thinking|working)\b/i matches model prose ("I'm working on
        // it") → permanent working pin. Same bug class as Claude's old
        // glyph regex. Rely on braille + byte-rate.
        spinner: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
        permission: [/\?\s*[\[\(]y(es)?[\/\\]n/i],
    },
}

/**
 * Tools we know nothing about get a generic fingerprint. This is just
 * "enough" to avoid getting stuck in working forever — it'll rely entirely
 * on byte-rate quiescence.
 */
export const GENERIC_FINGERPRINT: Fingerprint = {
    spinner: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, /esc to interrupt/i],
    permission: [/\?\s*[\[\(]y(es)?[\/\\]n/i],
}
