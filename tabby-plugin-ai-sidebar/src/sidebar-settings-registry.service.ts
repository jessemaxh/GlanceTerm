import { Injectable, Type } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'

/**
 * A "Configure…" row that another plugin contributes into the AI-sidebar
 * gear modal. Click → ai-sidebar opens `component` in an NgbModal.
 *
 * Keeping the contract as a plain component class (rather than a callback)
 * means contributing plugins don't need to depend on @ng-bootstrap or
 * decide on modal sizing — those concerns stay with the host.
 */
export interface SidebarSettingsSection {
    id: string
    title: string
    description?: string
    component: Type<unknown>
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
