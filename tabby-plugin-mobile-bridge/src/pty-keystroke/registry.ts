import { Injectable } from '@angular/core'

import { AiTool } from 'tabby-plugin-ai-sidebar'

/**
 * Translate IM-side text into PTY bytes for a specific agent.
 *
 * v0 default for every agent is `text + '\r'` — type-and-submit. The
 * structure exists so per-agent quirks (Codex `y`/`n` vs Claude
 * `1`/`2`/`3` permission menus vs Aider `/yes` slash commands) can be
 * specialised in one place when dogfooding surfaces them. Don't add
 * mappings speculatively — wait for "I typed X and the agent didn't
 * do the right thing" feedback, then add the rule + a comment quoting
 * the exact agent prompt that triggered it.
 */
export interface KeystrokeAdapter {
    translate(text: string): string
}

class DefaultAdapter implements KeystrokeAdapter {
    translate (text: string): string {
        // CR rather than LF: that's what xterm-style terminals get when
        // the user presses Enter — what xterm.js / node-pty pass through
        // to the agent's stdin. Agents that read with readline are
        // newline-tolerant so this works either way, but '\r' matches
        // the actual key event we'd be replaying.
        return text + '\r'
    }
}

class ClaudeAdapter implements KeystrokeAdapter {
    translate (text: string): string {
        // Permission menu shows numbered options; default (Enter) is the
        // first ("Yes"). v0 sends what the user typed — if dogfood shows
        // "yes" / "y" should map to "1\r" or just "\r", refine here.
        return text + '\r'
    }
}

class CodexAdapter implements KeystrokeAdapter {
    translate (text: string): string {
        return text + '\r'
    }
}

/**
 * Look up the adapter for `state.aiTool`. Unknown / null tool falls
 * back to the default. The registry is a singleton — adapters are
 * stateless, no per-binding instance needed.
 */
@Injectable()
export class KeystrokeAdapterRegistry {
    private adapters: Map<AiTool, KeystrokeAdapter> = new Map<AiTool, KeystrokeAdapter>([
        ['claude', new ClaudeAdapter()],
        ['codex', new CodexAdapter()],
    ])
    private fallback: KeystrokeAdapter = new DefaultAdapter()

    forTool (tool: AiTool | null | undefined): KeystrokeAdapter {
        if (!tool) return this.fallback
        return this.adapters.get(tool) ?? this.fallback
    }
}
