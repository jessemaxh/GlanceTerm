import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

/** All bridge-side audit + drop events go here as JSONL. */
export const AUDIT_LOG_PATH = path.join(os.homedir(), '.glanceterm', 'mobile-bridge.log')

/**
 * Append one JSON-encoded line to the audit log. Failure is swallowed —
 * losing the log line is preferable to crashing the bridge over an fs
 * error (disk full, perm flap, etc.). Callers don't await this when they
 * can't tolerate latency; for non-hot paths, await it so disk pressure
 * gets surfaced.
 */
export async function appendAudit (entry: Record<string, unknown>): Promise<void> {
    try {
        const dir = path.dirname(AUDIT_LOG_PATH)
        await fs.mkdir(dir, { recursive: true })
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
        await fs.appendFile(AUDIT_LOG_PATH, line + '\n', { mode: 0o600 })
    } catch {
        // Audit log failure is non-fatal — surfaced via console at most.
    }
}
