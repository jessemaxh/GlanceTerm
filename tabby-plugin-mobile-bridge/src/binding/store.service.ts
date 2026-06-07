import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { randomUUID } from 'crypto'

import { ChannelBinding } from './types'

/**
 * Persistent storage for {@link ChannelBinding}s. Writes through to a flat
 * JSON file under `~/.glanceterm/`. No locking — concurrent GlanceTerm
 * instances aren't a supported configuration.
 *
 * Why a sibling file instead of tabby-core's ConfigService:
 *   - The bridge owns its own UI (task #11 builds its panel inside the
 *     plugin, not the global Settings dialog), so ConfigService gives us
 *     nothing here except an extra dependency on tabby's config schema.
 *   - The file is easy to back up / wipe / inspect by hand for debugging.
 *
 * Hardening note: see {@link ChannelBinding.botToken} — secret storage
 * needs to move to keytar before a public release.
 */
@Injectable()
export class BindingStoreService {
    private static readonly FILE = path.join(os.homedir(), '.glanceterm', 'mobile-bridge-bindings.json')

    private bindingsSubject = new BehaviorSubject<ChannelBinding[]>([])
    private loaded = false
    private loadPromise: Promise<void> | null = null

    /** Stream of current bindings. Cold subscribers get the latest snapshot. */
    get bindings$ (): Observable<ChannelBinding[]> { return this.bindingsSubject }

    /** Snapshot accessor — caller is responsible for awaiting `load()` first
     *  if they need persisted data. */
    get current (): ChannelBinding[] { return this.bindingsSubject.value }

    /**
     * Idempotent disk load. Safe to call multiple times; concurrent calls
     * share the same in-flight promise.
     */
    async load (): Promise<void> {
        if (this.loaded) return
        if (this.loadPromise) return this.loadPromise
        this.loadPromise = (async () => {
            try {
                const raw = await fs.readFile(BindingStoreService.FILE, 'utf8')
                const parsed = JSON.parse(raw) as ChannelBinding[]
                this.bindingsSubject.next(Array.isArray(parsed) ? parsed : [])
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                    // eslint-disable-next-line no-console
                    console.warn('[mobile-bridge:store] load failed, starting empty:', err)
                }
                this.bindingsSubject.next([])
            } finally {
                this.loaded = true
            }
        })()
        return this.loadPromise
    }

    /**
     * Add a new binding. Mints a fresh internal id; returns it for the
     * caller's records.
     */
    async add (partial: Omit<ChannelBinding, 'id' | 'createdAt'>): Promise<ChannelBinding> {
        await this.load()
        const binding: ChannelBinding = {
            ...partial,
            id: randomUUID(),
            createdAt: Date.now(),
        }
        this.bindingsSubject.next([...this.current, binding])
        await this.save()
        return binding
    }

    /** Mutate a binding by id. Throws if not found. */
    async update (id: string, patch: Partial<Omit<ChannelBinding, 'id'>>): Promise<ChannelBinding> {
        await this.load()
        const idx = this.current.findIndex(b => b.id === id)
        if (idx < 0) throw new Error(`BindingStore: no binding with id=${id}`)
        const next = [...this.current]
        next[idx] = { ...next[idx], ...patch }
        this.bindingsSubject.next(next)
        await this.save()
        return next[idx]
    }

    async remove (id: string): Promise<void> {
        await this.load()
        this.bindingsSubject.next(this.current.filter(b => b.id !== id))
        await this.save()
    }

    /** Find by platform — v0 caps platform to one, so this returns
     *  the binding or undefined. */
    forPlatform (platform: ChannelBinding['platform']): ChannelBinding | undefined {
        return this.current.find(b => b.platform === platform)
    }

    private async save (): Promise<void> {
        const dir = path.dirname(BindingStoreService.FILE)
        await fs.mkdir(dir, { recursive: true })
        const json = JSON.stringify(this.current, null, 2)
        await fs.writeFile(BindingStoreService.FILE, json, { encoding: 'utf8', mode: 0o600 })
    }
}
