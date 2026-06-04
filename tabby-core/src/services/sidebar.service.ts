import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'

/**
 * Runtime state for SidebarProvider contributions — visibility and width.
 * Plugins inject this to toggle their sidebars (toolbar buttons, hotkeys).
 * The host `AppRootComponent` subscribes to `changes$` to re-render.
 *
 * State is kept in-memory for now. Persistence to ConfigService can be layered
 * on later without changing this surface.
 */
@Injectable({ providedIn: 'root' })
export class SidebarService {
    private visibilityMap = new Map<string, boolean>()
    private widthMap = new Map<string, number>()
    private changeSubject = new BehaviorSubject<number>(0)

    /** Emits a tick whenever any sidebar's visibility or width changed. */
    get changes$ (): Observable<number> {
        return this.changeSubject.asObservable()
    }

    isVisible (id: string, fallback = true): boolean {
        return this.visibilityMap.get(id) ?? fallback
    }

    setVisible (id: string, visible: boolean): void {
        this.visibilityMap.set(id, visible)
        this.bump()
    }

    toggle (id: string): void {
        this.setVisible(id, !this.isVisible(id))
    }

    getWidth (id: string, fallback = 280): number {
        return this.widthMap.get(id) ?? fallback
    }

    setWidth (id: string, px: number): void {
        this.widthMap.set(id, px)
        this.bump()
    }

    private bump (): void {
        this.changeSubject.next(this.changeSubject.value + 1)
    }
}
