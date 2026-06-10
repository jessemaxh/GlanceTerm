import { Injectable, Type } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'

/** Tone drives the status dot colour + reads as the section's health at a
 *  glance. `connected` = live + healthy, `idle` = configured but not
 *  running / mid-connect, `disabled` = user toggled it off, `error` =
 *  needs attention (auth failed, etc.). */
export type SectionStatusTone = 'connected' | 'idle' | 'disabled' | 'error'

/** One-line live status a section can surface in its gear-modal row. */
export interface SectionStatus {
    label: string
    tone: SectionStatusTone
}

/**
 * A row another plugin contributes into the AI-sidebar gear modal. Click →
 * ai-sidebar opens `component` in an NgbModal for full configuration.
 *
 * Keeping the contract as a plain component class (rather than a callback)
 * means contributing plugins don't need to depend on @ng-bootstrap or
 * decide on modal sizing — those concerns stay with the host.
 *
 * The optional reactive trio lets a section show its state inline without
 * opening the modal — currently used by tabby-plugin-mobile-bridge to
 * surface "connected to Telegram / @bot" and an enable/disable toggle:
 *   - `status$`  — live one-liner + tone; when provided it replaces the
 *                  static `description` in the row.
 *   - `enabled$` — current on/off, or `null` when there's nothing to toggle
 *                  (not configured yet) → the host hides the switch.
 *   - `setEnabled` — applies a toggle flip. Only meaningful alongside
 *                  `enabled$`.
 * All three are optional and back-compatible: a section that omits them
 * renders exactly as before (title + description + Configure…).
 */
export interface SidebarSettingsSection {
    id: string
    title: string
    description?: string
    component: Type<unknown>
    status$?: Observable<SectionStatus | null>
    enabled$?: Observable<boolean | null>
    setEnabled?: (value: boolean) => void
}

/**
 * Extension point for plugins to register settings panels into the AI
 * sidebar's gear modal. Used to keep cross-plugin settings (e.g.
 * tabby-plugin-mobile-bridge) discoverable from one place instead of
 * scattered across Tabby's global Settings dialog.
 *
 * `providedIn: 'root'` so the same instance is visible to every plugin
 * regardless of NgModule boundaries — the alternative (module-scoped
 * provider) would give each plugin its own empty registry.
 */
@Injectable({ providedIn: 'root' })
export class SidebarSettingsRegistry {
    private readonly subject = new BehaviorSubject<SidebarSettingsSection[]>([])
    readonly sections$: Observable<SidebarSettingsSection[]> = this.subject.asObservable()

    register (section: SidebarSettingsSection): void {
        const existing = this.subject.value
        // Idempotent on id so a hot-reload re-registration replaces rather
        // than duplicates — a duplicated row would also open two modals on
        // click which is just confusing.
        const next = existing.filter(s => s.id !== section.id).concat(section)
        this.subject.next(next)
    }
}
