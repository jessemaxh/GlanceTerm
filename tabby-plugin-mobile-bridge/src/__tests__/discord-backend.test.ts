import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { firstValueFrom } from 'rxjs'

import { DiscordBackend } from '../backends/discord/client.service'
import { GatewayOp } from '../backends/discord/wire-types'
import { MessagingError } from '../backends/types'
import { KeystoreService } from '../keystore.service'

/**
 * Exercises the Discord backend against a scripted fake gateway + REST
 * layer. No network: `WebSocket` and `fetch` globals are stubbed, so the
 * tests drive the exact wire payloads (HELLO → IDENTIFY → READY,
 * MESSAGE_CREATE in a thread, INTERACTION_CREATE, fatal close codes)
 * and assert the cross-platform translation at the boundary.
 */

class FakeWebSocket {
    static instances: FakeWebSocket[] = []
    url: string
    sent: Array<Record<string, unknown>> = []
    onmessage: ((ev: { data: string }) => void) | null = null
    onclose: ((ev: { code: number }) => void) | null = null
    onerror: (() => void) | null = null

    constructor (url: string) {
        this.url = url
        FakeWebSocket.instances.push(this)
    }

    send (data: string): void {
        this.sent.push(JSON.parse(data) as Record<string, unknown>)
    }

    close (code = 1000): void {
        this.onclose?.({ code })
    }

    /** Push a gateway frame into the backend. */
    receive (payload: Record<string, unknown>): void {
        this.onmessage?.({ data: JSON.stringify(payload) })
    }

    sentOps (): number[] {
        return this.sent.map(p => p.op as number)
    }
}

type FetchHandler = (method: string, path: string, body: unknown) => { status: number; body?: unknown }

/** Routes fetch calls to a per-test handler; records every call. */
const fetchCalls: Array<{ method: string; path: string; body: unknown }> = []
let fetchHandler: FetchHandler = () => ({ status: 200, body: {} })

function installFetch (): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const path = url.replace('https://discord.com/api/v10', '')
        const method = init?.method ?? 'GET'
        const body = init?.body !== undefined ? JSON.parse(init.body) : undefined
        fetchCalls.push({ method, path, body })
        const res = fetchHandler(method, path, body)
        return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            json: async () => res.body ?? {},
        }
    }))
}

const ME = { id: '42', username: 'glancebot', bot: true }

function defaultHandler (overrides: Record<string, FetchHandler> = {}): FetchHandler {
    return (method, path, body) => {
        const key = `${method} ${path}`
        for (const [prefix, h] of Object.entries(overrides)) {
            if (key.startsWith(prefix)) return h(method, path, body)
        }
        if (key === 'GET /users/@me') return { status: 200, body: ME }
        return { status: 200, body: {} }
    }
}

function makeBackend (): DiscordBackend {
    return new DiscordBackend({ read: vi.fn() } as unknown as KeystoreService)
}

/** start() + drive the fake gateway through HELLO/READY. Returns the ws. */
async function startAndConnect (backend: DiscordBackend): Promise<FakeWebSocket> {
    await backend.start({ platform: 'discord', botToken: 'tok.en.value' })
    const ws = FakeWebSocket.instances.at(-1)!
    ws.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 45_000 } })
    ws.receive({
        op: GatewayOp.DISPATCH, s: 1, t: 'READY',
        d: { session_id: 'sess1', resume_gateway_url: 'wss://resume.discord.gg', user: ME },
    })
    return ws
}

describe('DiscordBackend', () => {
    beforeEach(() => {
        FakeWebSocket.instances = []
        fetchCalls.length = 0
        fetchHandler = defaultHandler()
        vi.stubGlobal('WebSocket', FakeWebSocket)
        installFetch()
        // Deterministic heartbeat kickoff (jitter × interval → 0ms).
        vi.spyOn(Math, 'random').mockReturnValue(0)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('rejects start() with auth_failed when the token is invalid', async () => {
        fetchHandler = () => ({ status: 401, body: { message: '401: Unauthorized' } })
        const backend = makeBackend()
        await expect(backend.start({ platform: 'discord', botToken: 'bad' }))
            .rejects.toMatchObject({ kind: 'auth_failed' })
        expect(FakeWebSocket.instances).toHaveLength(0)
        const lastError = await firstValueFrom(backend.lastError$)
        expect(lastError?.kind).toBe('auth_failed')
    })

    it('identifies after HELLO and surfaces identity from READY', async () => {
        const backend = makeBackend()
        const ws = await startAndConnect(backend)
        const identify = ws.sent.find(p => p.op === GatewayOp.IDENTIFY)
        expect(identify).toBeDefined()
        expect((identify!.d as { token: string }).token).toBe('tok.en.value')
        const identity = await firstValueFrom(backend.identity$)
        expect(identity).toMatchObject({ displayName: '@glancebot', platformLabel: 'Discord' })
        await backend.stop()
    })

    it('flattens a thread message to (parent chatId, thread threadId)', async () => {
        fetchHandler = defaultHandler({
            'GET /channels/thread9': () => ({
                status: 200,
                body: { id: 'thread9', type: 11, parent_id: 'chan1' },
            }),
        })
        const backend = makeBackend()
        const ws = await startAndConnect(backend)
        const inbound = firstValueFrom(backend.inbound$)
        ws.receive({
            op: GatewayOp.DISPATCH, s: 2, t: 'MESSAGE_CREATE',
            d: { id: 'm1', channel_id: 'thread9', author: { id: 'u7', username: 'max' }, content: 'hello' },
        })
        expect(await inbound).toEqual({
            platform: 'discord',
            chatId: 'chan1',
            threadId: 'thread9',
            senderId: 'u7',
            senderName: 'max',
            text: 'hello',
            messageId: 'm1',
        })
        await backend.stop()
    })

    it('flattens a plain-channel message with null threadId and ignores bots', async () => {
        fetchHandler = defaultHandler({
            'GET /channels/chan1': () => ({ status: 200, body: { id: 'chan1', type: 0 } }),
        })
        const backend = makeBackend()
        const ws = await startAndConnect(backend)
        const inbound = firstValueFrom(backend.inbound$)
        // bot-authored first — must be dropped, not emitted
        ws.receive({
            op: GatewayOp.DISPATCH, s: 2, t: 'MESSAGE_CREATE',
            d: { id: 'm0', channel_id: 'chan1', author: { id: '42', username: 'glancebot', bot: true }, content: 'self' },
        })
        ws.receive({
            op: GatewayOp.DISPATCH, s: 3, t: 'MESSAGE_CREATE',
            d: { id: 'm1', channel_id: 'chan1', author: { id: 'u7', username: 'max' }, content: '/bind ABC234' },
        })
        const msg = await inbound
        expect(msg.messageId).toBe('m1')
        expect(msg.chatId).toBe('chan1')
        expect(msg.threadId).toBeNull()
        await backend.stop()
    })

    it('translates INTERACTION_CREATE into a callback with id:token', async () => {
        fetchHandler = defaultHandler({
            'GET /channels/thread9': () => ({
                status: 200,
                body: { id: 'thread9', type: 11, parent_id: 'chan1' },
            }),
        })
        const backend = makeBackend()
        const ws = await startAndConnect(backend)
        const cb = firstValueFrom(backend.callbacks$)
        ws.receive({
            op: GatewayOp.DISPATCH, s: 2, t: 'INTERACTION_CREATE',
            d: {
                id: 'int5', token: 'itok', type: 3,
                channel_id: 'thread9',
                data: { custom_id: 'perm:allow:abcde' },
                message: { id: 'm9', channel_id: 'thread9' },
                member: { user: { id: 'u7', username: 'max' } },
            },
        })
        expect(await cb).toMatchObject({
            platform: 'discord',
            callbackId: 'int5:itok',
            chatId: 'chan1',
            threadId: 'thread9',
            messageId: 'm9',
            senderId: 'u7',
            data: 'perm:allow:abcde',
        })
        // ack hits the interaction callback endpoint with type 6
        await backend.ackCallback('int5:itok')
        const ack = fetchCalls.find(c => c.path === '/interactions/int5/itok/callback')
        expect(ack).toBeDefined()
        expect((ack!.body as { type: number }).type).toBe(6)
        await backend.stop()
    })

    it('maps InteractiveSpec buttons to Discord components', async () => {
        fetchHandler = defaultHandler({
            'POST /channels/thread9/messages': () => ({ status: 200, body: { id: 'm2', channel_id: 'thread9' } }),
        })
        const backend = makeBackend()
        await startAndConnect(backend)
        const ref = await backend.sendInteractive('chan1', 'thread9', {
            body: 'allow?',
            buttons: [[
                { label: 'Allow', value: 'perm:allow:abcde', style: 'primary' },
                { label: 'Deny', value: 'perm:deny:abcde', style: 'danger' },
            ]],
        })
        expect(ref).toEqual({ chatId: 'chan1', threadId: 'thread9', messageId: 'm2' })
        const sent = fetchCalls.find(c => c.path === '/channels/thread9/messages')!
        const rows = (sent.body as { components: Array<{ components: Array<Record<string, unknown>> }> }).components
        expect(rows[0].components).toEqual([
            { type: 2, style: 1, label: 'Allow', custom_id: 'perm:allow:abcde' },
            { type: 2, style: 4, label: 'Deny', custom_id: 'perm:deny:abcde' },
        ])
        await backend.stop()
    })

    it('maps an archived-thread send failure to thread_closed', async () => {
        fetchHandler = defaultHandler({
            'POST /channels/thread9/messages': () => ({
                status: 400,
                body: { code: 50083, message: 'Thread is archived' },
            }),
        })
        const backend = makeBackend()
        await startAndConnect(backend)
        const err = await backend.sendText('chan1', 'thread9', 'hi').then(() => null, e => e as MessagingError)
        expect(err?.kind).toBe('thread_closed')
        await backend.stop()
    })

    it('halts (no reconnect) and records permission_denied on close 4014', async () => {
        const backend = makeBackend()
        const ws = await startAndConnect(backend)
        ws.onclose?.({ code: 4014 })
        const lastError = await firstValueFrom(backend.lastError$)
        expect(lastError?.kind).toBe('permission_denied')
        expect(lastError?.message).toMatch(/Message Content Intent/)
        const running = await firstValueFrom(backend.running$)
        expect(running).toBe(false)
        expect(FakeWebSocket.instances).toHaveLength(1)
    })

    it('heartbeats with the last seq and reconnects with RESUME after a drop', async () => {
        vi.useFakeTimers()
        try {
            const backend = makeBackend()
            await backend.start({ platform: 'discord', botToken: 'tok.en.value' })
            const ws = FakeWebSocket.instances.at(-1)!
            ws.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 1_000 } })
            ws.receive({
                op: GatewayOp.DISPATCH, s: 7, t: 'READY',
                d: { session_id: 'sess1', resume_gateway_url: 'wss://resume.discord.gg', user: ME },
            })
            // jitter mocked to 0 → kickoff beat fires at t=0
            await vi.advanceTimersByTimeAsync(0)
            const beat = ws.sent.find(p => p.op === GatewayOp.HEARTBEAT)
            expect(beat).toBeDefined()
            expect(beat!.d).toBe(7)
            ws.receive({ op: GatewayOp.HEARTBEAT_ACK })

            // network drop → reconnect after RETRY_MS against the resume URL
            ws.onclose?.({ code: 1006 })
            await vi.advanceTimersByTimeAsync(5_000)
            expect(FakeWebSocket.instances).toHaveLength(2)
            const ws2 = FakeWebSocket.instances.at(-1)!
            expect(ws2.url).toContain('wss://resume.discord.gg')
            ws2.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 1_000 } })
            const resume = ws2.sent.find(p => p.op === GatewayOp.RESUME)
            expect(resume).toBeDefined()
            expect(resume!.d).toMatchObject({ session_id: 'sess1', seq: 7 })
            await backend.stop()
        } finally {
            vi.useRealTimers()
        }
    })
})
