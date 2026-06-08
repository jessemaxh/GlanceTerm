import { Injectable } from '@angular/core'

import { TelegramBackend } from './telegram/client.service'
import { MessagingBackend } from './types'
import { ChannelBinding } from '../binding/types'

/**
 * Maps `binding.platform` to a {@link MessagingBackend} instance. Each
 * backend is a DI singleton (one per platform; v0 caps bindings to one per
 * platform). Callers — OutboundDispatcher, TopicService, PermissionRelay
 * — depend on this registry rather than a specific backend class so the
 * dispatch logic stays uniform across Telegram, Feishu, Discord, etc.
 *
 * Lifecycle: registry only holds references. Each backend manages its
 * own start/stop independently (driven by OutboundDispatcher.syncTransport
 * which calls `forPlatform(...).start(creds)` when bindings$ emits).
 */
@Injectable()
export class BackendRegistry {
    constructor (
        private tg: TelegramBackend,
    ) {}

    forPlatform (platform: ChannelBinding['platform']): MessagingBackend {
        switch (platform) {
            case 'telegram': return this.tg
            case 'feishu':
                // Phase 3 will wire a FeishuBackend here. Returning the
                // TG backend would silently misroute outbound traffic,
                // so we hard-throw — downstream callers gate their
                // dispatch on binding.platform anyway, so a thrown error
                // here means the gating is broken upstream.
                throw new Error('BackendRegistry: feishu backend not implemented yet (Phase 3)')
            default: {
                // Exhaustiveness check: adding a new platform to the
                // ChannelBinding union surfaces here as a TS error.
                const exhaustive: never = platform
                throw new Error(`BackendRegistry: unknown platform ${exhaustive as string}`)
            }
        }
    }
}
