/**
 * Forward-declares the SidebarProvider extension point we added to our Tabby
 * fork. The npm-published `tabby-core` typings don't yet have these (since
 * upstream hasn't merged the feature), so this file shims them in at build
 * time. At runtime, the symbols are resolved against the fork's `tabby-core`.
 *
 * Drop this file once SidebarProvider is part of the npm-published `tabby-core`.
 */
import { Type } from '@angular/core'

declare module 'tabby-core' {
    export type SidebarSide = 'left' | 'right'

    export interface SidebarContribution {
        id: string
        title: string
        component: Type<any>
        side?: SidebarSide
        defaultWidth?: number
        minWidth?: number
        maxWidth?: number
        defaultVisible?: boolean
        icon?: string
    }

    export abstract class SidebarProvider {
        abstract provide (): SidebarContribution[]
    }

    export class SidebarService {
        isVisible (id: string, fallback?: boolean): boolean
        setVisible (id: string, visible: boolean): void
        toggle (id: string): void
        getWidth (id: string, fallback?: number): number
        setWidth (id: string, px: number): void
        readonly changes$: import('rxjs').Observable<number>
    }
}
