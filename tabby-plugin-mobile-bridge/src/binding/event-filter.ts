/**
 * Pure helpers for the per-binding outbound event filter. Dependency-free (no
 * Angular, no dispatcher, no ai-sidebar) so the status-toggle math — which has
 * to preserve unrelated allowlist entries and round-trip the "empty = defaults"
 * sentinel — is unit-testable in isolation.
 *
 * Filter semantics mirror the dispatcher's `passesFilter`: an EMPTY filter
 * means "use defaults" (assistant_text only — `DEFAULT_FILTER` in
 * outbound-dispatcher.service); a non-empty filter is an explicit allowlist.
 */

/** The conversation baseline an empty filter implies. */
const ASSISTANT_TEXT = 'assistant_text'

/** The events the "status updates" toggle owns. `state_transition` is the
 *  sentinel {@link hasStatusUpdates} reads, but all three move together. */
export const STATUS_EVENT_TYPES = ['needs_permission', 'task_completed', 'state_transition']

/** Whether a binding's event filter currently has status pushes enabled. */
export function hasStatusUpdates (eventFilter: string[]): boolean {
    return eventFilter.includes('state_transition')
}

/**
 * Flip status pushes on/off in `eventFilter` WITHOUT clobbering unrelated
 * entries (tool_use, task_failed, or any future custom allowlist) — only the
 * three {@link STATUS_EVENT_TYPES} move. Returns the new filter.
 *
 *   - turning ON: add the status events. If the filter was empty (= defaults),
 *     seed it with the assistant_text baseline first, because a now-non-empty
 *     filter is an explicit allowlist and would otherwise silently drop the
 *     agent's messages. A filter that's already an explicit allowlist WITHOUT
 *     assistant_text (conversation deliberately off) is respected as-is.
 *   - turning OFF: remove just the status events; collapse back to `[]` when
 *     nothing but the assistant_text baseline survives, so we don't leave a
 *     redundant explicit `['assistant_text']` (semantically identical to `[]`).
 */
export function nextStatusFilter (eventFilter: string[]): string[] {
    if (hasStatusUpdates(eventFilter)) {
        const remaining = eventFilter.filter(e => !STATUS_EVENT_TYPES.includes(e))
        const onlyBaseline = remaining.length === 0
            || remaining.length === 1 && remaining[0] === ASSISTANT_TEXT
        return onlyBaseline ? [] : remaining
    }
    const base = eventFilter.length ? eventFilter : [ASSISTANT_TEXT]
    return [...new Set([...base, ...STATUS_EVENT_TYPES])]
}
