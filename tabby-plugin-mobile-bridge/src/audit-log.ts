import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

/** All bridge-side audit + drop events go here as JSONL. */
export const AUDIT_LOG_PATH = path.join(os.homedir(), '.glanceterm', 'mobile-bridge.log')

/**
 * Strip secrets from a string before it reaches the audit log or any
 * console output. Covers patterns from every supported backend so a
 * platform-specific error message can't sneak credentials onto disk:
 *
 *   - Telegram: `/bot<digits>:<secret>/` URL fragment that fetch()
 *     embeds in network error strings. Pattern matches the token shape
 *     exactly.
 *   - Named secret keys in stringified JSON / form bodies:
 *     `tenant_access_token`, `app_access_token`, `access_token`,
 *     `refresh_token`, `app_secret`, `app_id`. The Lark SDK is known
 *     to embed these in OAuth/refresh error envelopes — the bare
 *     `access_token` key in particular is the audited-leak path the
 *     review-2026-06-08 pass caught.
 *   - Lark tenant bearer shape `t-g_<chars>` when it appears bare
 *     (no surrounding `tenant_access_token=` key) — observed in a few
 *     SDK error message templates.
 *
 * Every regex is intentionally narrow: we'd rather miss a leak in an
 * unusual error string than scrub user-visible context. New backends
 * should add their token shape here as the FIRST step of integration.
 */
const TG_TOKEN_PATTERN = /\/bot\d+:[A-Za-z0-9_-]+\//g
const NAMED_SECRET_PATTERN = /\b(tenant_access_token|app_access_token|access_token|refresh_token|app_secret|app_id)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{8,})/gi
const FEISHU_BEARER_PATTERN = /\b(t-g_[A-Za-z0-9_-]{10,})\b/g
// Discord bot token: three dot-separated base64url segments
// (user-id ≥20 chars · 6-8 char timestamp · ≥24 char HMAC). The token
// rides the Authorization header so URLs never leak it, but fetch /
// gateway error strings assembled from user-supplied tokens might.
const DISCORD_TOKEN_PATTERN = /\b[\w-]{20,}\.[\w-]{5,8}\.[\w-]{24,}\b/g
export function redactToken (s: string): string {
    return s
        .replace(TG_TOKEN_PATTERN, '/bot<REDACTED>/')
        .replace(NAMED_SECRET_PATTERN, '$1=<REDACTED>')
        .replace(FEISHU_BEARER_PATTERN, '<REDACTED>')
        .replace(DISCORD_TOKEN_PATTERN, '<REDACTED>')
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
