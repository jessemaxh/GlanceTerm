import { Type } from '@angular/core'

/**
 * Which side of the main content area the sidebar attaches to.
 */
export type SidebarSide = 'left' | 'right'

/**
 * A single sidebar contributed by a plugin. The host renders the `component`
 * inside a fixed-width vertical strip next to the tab body — visible across
 * tab switches, NOT swapped out when the active tab changes.
 */
export interface SidebarContribution {
    /** Stable id used to persist visibility/width per-sidebar in user config. */
    id: string

    /** Display label, used in tooltips and the settings UI. */
    title: string

    /** Angular component class. Instantiated via NgComponentOutlet. */
    component: Type<any>

    /** Which side to attach to. Default: 'left'. */
    side?: SidebarSide

    /** Default width in pixels. Default: 250. User-resizable. */
    defaultWidth?: number

    /** Minimum width in pixels. Default: 180. */
    minWidth?: number

    /** Maximum width in pixels. Default: 600. */
    maxWidth?: number

    /** Whether the sidebar is visible by default. Default: true. */
    defaultVisible?: boolean

    /**
     * Optional SVG icon code for a toolbar toggle button. If provided, the
     * host adds a button that flips this sidebar's visibility.
     */
    icon?: string
}

/**
 * Extend this and register as a multi-provider in your plugin's NgModule to
 * contribute a persistent sidebar alongside the terminal tab body:
 *
 *     providers: [
 *         { provide: SidebarProvider, useClass: MySidebarProvider, multi: true },
 *     ]
 *
 * Unlike a custom tab type (BaseTabComponent), a sidebar lives outside the
 * tab system — it stays visible regardless of which tab is active.
 */
export abstract class SidebarProvider {
    abstract provide (): SidebarContribution[]
}
