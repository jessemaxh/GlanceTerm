import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

/** All bridge-side audit + drop events go here as JSONL. */
export const AUDIT_LOG_PATH = path.join(os.homedir(), '.glanceterm', 'mobile-bridge.log')

/**
 * Strips `/bot<bot_id>:<secret>/` URL fragments from a string. fetch()
 * network errors stringify with the full request URL, which embeds the
 * Telegram bot token — without redaction those messages end up in
 * devtools, console logs, and the audit log on disk.
 *
 * Pattern matches the Telegram URL shape exactly (digits, colon,
 * alphanumeric/underscore/dash secret). Permissive enough to handle any
 * legitimate token, narrow enough that it doesn't false-positive on
 * arbitrary text.
 */
const TOKEN_PATTERN = /\/bot\d+:[A-Za-z0-9_-]+\//g
export function redactToken (s: string): string {
    return s.replace(TOKEN_PATTERN, '/bot<REDACTED>/')
}

/** Per-session de-dup so a sustained disk-full error doesn't flood the
 *  console — but the user still gets at least one warning so the
 *  audit-log silently-broken failure mode is observable. */
let auditLogFailureWarned = false

/**
 * Append one JSON-encoded line to the audit log. Failure is logged once
 * to console.warn then suppressed for the rest of the session — losing
 * lines is preferable to crashing the bridge over an fs error (disk
 * full, perm flap, etc.), but silently losing every line was the
 * previous behaviour and made "is anything getting through" diagnosis
 * impossible.
 */
export async function appendAudit (entry: Record<string, unknown>): Promise<void> {
    try {
        const dir = path.dirname(AUDIT_LOG_PATH)
        await fs.mkdir(dir, { recursive: true })
        // Redact the entire serialized line: easier to reason about than
        // per-field whitelisting, and we don't write tokens deliberately
        // anywhere — anything matching the pattern is a leak.
        const line = redactToken(JSON.stringify({ ts: new Date().toISOString(), ...entry }))
        await fs.appendFile(AUDIT_LOG_PATH, line + '\n', { mode: 0o600 })
    } catch (err) {
        if (!auditLogFailureWarned) {
            auditLogFailureWarned = true
            // eslint-disable-next-line no-console
            console.warn('[mobile-bridge:audit] log write failed (further failures suppressed this session):', err)
        }
    }
}
