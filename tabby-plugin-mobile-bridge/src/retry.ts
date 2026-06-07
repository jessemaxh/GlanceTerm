import { TelegramApiError } from './telegram/client.service'

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
 * `shouldRetry` lets callers narrow retryable errors. Default: retry
 * network / unknown errors and Telegram 429 / 5xx; fail fast on Telegram
 * 4xx (bad token, invalid chat) — retrying won't change those.
 */
export interface RetryOptions {
    maxAttempts?: number
    baseMs?: number
    maxMs?: number
    shouldRetry?: (err: unknown) => boolean
}

const DEFAULT_SHOULD_RETRY = (err: unknown): boolean => {
    if (err instanceof TelegramApiError && err.code !== undefined) {
        return err.code === 429 || err.code >= 500
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
            const delay = Math.min(baseMs * 2 ** attempt, maxMs)
            await new Promise(r => setTimeout(r, delay))
        }
    }
    throw lastErr
}
