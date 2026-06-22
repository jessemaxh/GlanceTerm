import type { TabStatus } from 'tabby-plugin-ai-sidebar'

/**
 * The outbound events a per-tab status transition can fire — a subset of
 * `BridgeEventType` (outbound-dispatcher.service). Kept as its own type so this
 * module carries no value-level dependency on the dispatcher, and (via the
 * type-only `TabStatus` import above) none on the ai-sidebar package either.
 * That isolation is what lets it be unit-tested without standing up Angular or
 * the whole sidebar plugin.
 */
export type StatusTransitionEvent = 'needs_permission' | 'task_completed' | 'state_transition'

/**
 * Pure transition→event decision, extracted from the dispatcher's `detect`.
 * Returns the event a status change should fire, or null for transitions that
 * produce no push. `prev` is the immediately-preceding status for the same
 * tab; callers must already have a recorded prev (first-sight tabs fire
 * nothing).
 *
 * The comparisons use the raw TabStatus string values (Working='working',
 * Done='done', Idle='idle', NeedsPermission='needs_permission', NoAi='no_ai')
 * rather than the `TabStatus.*` constants, so the `TabStatus` import can stay
 * type-only and pull no runtime dependency. They stay correct because
 * `status`/`prev` are typed `TabStatus`: a literal outside that union is a tsc
 * "no overlap" error, so a typo can't slip through.
 */
export function classifyStatusTransition (status: TabStatus, prev: TabStatus): StatusTransitionEvent | null {
    // any → needs_permission
    if (status === 'needs_permission' && prev !== 'needs_permission') {
        return 'needs_permission'
    }
    // working → idle/done = finished a turn ('done' is just idle-while-
    // unfocused, so both terminal states mean "stopped working").
    if ((status === 'idle' || status === 'done') && prev === 'working') {
        return 'task_completed'
    }
    // (non-working) → working = a fresh turn started. Deliberately NOT for:
    //   - idle↔done (desktop focus flips, not real activity)
    //   - → no_ai (the tab/agent went away)
    //   - needs_permission → working: the SAME turn resuming after the user
    //     approved a permission prompt, not a new start. Without this guard
    //     every approval fires a duplicate, misleading "agent started" — the
    //     permission round-trip (working → needs_permission → working) would
    //     book-end one turn with two "started"s.
    if (status === 'working' && prev !== 'working' && prev !== 'needs_permission') {
        return 'state_transition'
    }
    return null
}
