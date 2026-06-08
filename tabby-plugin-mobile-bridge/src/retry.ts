import { MessagingError } from './backends/types'

/**
 * Exponential-backoff retry. Backoff schedule with base=500 ms, factor=2:
 *   attempt 0 → 0 ms wait
 *   attempt 1 → 500 ms
 *   attempt 2 → 1 s
 *   attempt 3 → 2 s
 *   attempt 4 → 4 s
 *   attempt 5 → 8 s
 * Capped at maxMs (default 60s) per individual wait.
 *
 * `shouldRetry` lets callers narrow retryable errors. Default policy:
 *   - {@link MessagingError} with kind=`rate_limited` → retry (honour
 *     `retryAfterMs` if present, else exponential)
 *   - {@link MessagingError} with any other kind → fail fast (auth,
 *     thread_closed, etc. won't recover by retrying)
 *   - Other errors (network, unknown) → retry
 *
 * Cross-platform: doesn't import any backend-specific error type. All
 * decisions go through the {@link MessagingError.kind} taxonomy so the
 * same policy applies to Telegram, Feishu, Discord, etc.
 */
export interface RetryOptions {
    maxAttempts?: number
    baseMs?: number
    maxMs?: number
    shouldRetry?: (err: unknown) => boolean
}

const DEFAULT_SHOULD_RETRY = (err: unknown): boolean => {
    if (err instanceof MessagingError) {
        return err.kind === 'rate_limited'
    }
    return true
}

export async function retryWithBackoff<T> (
    fn: () => Promise<T>,
    opts: RetryOptions = {},
): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? 5
    const baseMs = opts.baseMs ?? 500
    const maxMs = opts.maxMs ?? 60_000
    const shouldRetry = opts.shouldRetry ?? DEFAULT_SHOULD_RETRY

    let lastErr: unknown
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn()
        } catch (err) {
            lastErr = err
            if (!shouldRetry(err)) throw err
            if (attempt === maxAttempts - 1) break
            // Honour the server's `retry_after` hint when present; falls
            // back to exponential backoff otherwise.
            const hint = err instanceof MessagingError ? err.retryAfterMs : undefined
            const delay = hint ?? Math.min(baseMs * 2 ** attempt, maxMs)
            await new Promise(r => setTimeout(r, Math.min(delay, maxMs)))
        }
    }
    throw lastErr
}
