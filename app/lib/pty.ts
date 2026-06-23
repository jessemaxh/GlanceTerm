import * as nodePTY from 'node-pty'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain } from 'electron'
import { Application } from './app'
import { UTF8Splitter } from './utfSplitter'
import { Subject, debounceTime } from 'rxjs'

class PTYDataQueue {
    private buffers: Buffer[] = []
    private delta = 0
    private maxChunk = 1024 * 100
    private maxDelta = this.maxChunk * 5
    private flowPaused = false
    private decoder = new UTF8Splitter()
    private output$ = new Subject<Buffer>()

    constructor (private pty: nodePTY.IPty, private onData: (data: Buffer) => void) {
        this.output$.pipe(debounceTime(500)).subscribe(() => {
            const remainder = this.decoder.flush()
            if (remainder.length) {
                this.onData(remainder)
            }
        })
    }

    push (data: Buffer) {
        this.buffers.push(data)
        this.maybeEmit()
    }

    ack (length: number) {
        this.delta -= length
        this.maybeEmit()
    }

    private maybeEmit () {
        if (this.delta <= this.maxDelta && this.flowPaused) {
            this.resume()
            return
        }
        if (this.buffers.length > 0) {
            if (this.delta > this.maxDelta && !this.flowPaused) {
                this.pause()
                return
            }

            const buffersToSend = []
            let totalLength = 0
            while (totalLength < this.maxChunk && this.buffers.length) {
                totalLength += this.buffers[0].length
                buffersToSend.push(this.buffers.shift())
            }

            if (buffersToSend.length === 0) {
                return
            }

            let toSend = Buffer.concat(buffersToSend)
            if (toSend.length > this.maxChunk) {
                this.buffers.unshift(toSend.slice(this.maxChunk))
                toSend = toSend.slice(0, this.maxChunk)
            }
            this.emitData(toSend)
            this.delta += toSend.length

            if (this.buffers.length) {
                setImmediate(() => this.maybeEmit())
            }
        }
    }

    private emitData (data: Buffer) {
        const validChunk = this.decoder.write(data)
        this.onData(validChunk)
        this.output$.next(validChunk)
    }

    private pause () {
        this.pty.pause()
        this.flowPaused = true
    }

    private resume () {
        this.pty.resume()
        this.flowPaused = false
        this.maybeEmit()
    }
}

export class PTY {
    private pty: nodePTY.IPty
    private outputQueue: PTYDataQueue
    exited = false

    constructor (private id: string, private app: Application, ...args: any[]) {
        this.pty = (nodePTY as any).spawn(...args)
        for (const key of ['close', 'exit']) {
            (this.pty as any).on(key, (...eventArgs) => this.emit(key, ...eventArgs))
        }

        this.outputQueue = new PTYDataQueue(this.pty, data => {
            setImmediate(() => this.emit('data', data))
        })

        this.pty.onData(data => this.outputQueue.push(Buffer.from(data)))
        this.pty.onExit((e?: { exitCode?: number, signal?: number }) => {
            this.exited = true
            // Opt-in PTY-exit diagnostic. Records WHY each pty ended — exitCode +
            // signal (1=SIGHUP→tab closed, 9=SIGKILL, 15=SIGTERM, code 0=normal
            // exit), command, cwd, pid, time — to ~/.glanceterm/pty-exit-debug.log.
            // For diagnosing tabs that vanish when an agent's pty dies; cross-
            // reference the SessionEnd timestamps in ~/.glanceterm/hooks/*.log.
            //
            // OFF by default (it would otherwise log every shell's command line).
            // Enable per-machine by creating the flag file — `touch
            // ~/.glanceterm/pty-debug.flag` — matching the auto-approve.flag /
            // permission-relay.flag convention. This has to live in the shipped
            // (Developer-ID-signed) build, not a local one: macOS keys TCC
            // permissions on the code signature, so only the signed release has
            // stable permissions to reproduce the bug against.
            try {
                /* eslint-disable @typescript-eslint/no-var-requires */
                const fs = require('fs'); const os = require('os'); const path = require('path')
                const dir = path.join(os.homedir(), '.glanceterm')
                if (!fs.existsSync(path.join(dir, 'pty-debug.flag'))) return
                const file = (args as any[])[0]
                const a = Array.isArray((args as any[])[1]) ? (args as any[])[1] : []
                const opts = (args as any[])[2] || {}
                const line = JSON.stringify({
                    ts: new Date().toISOString(),
                    pid: (this.pty as any)?.pid,
                    exitCode: e?.exitCode, signal: e?.signal,
                    cmd: `${file} ${a.join(' ')}`.slice(0, 200),
                    cwd: opts.cwd,
                }) + '\n'
                fs.appendFileSync(path.join(dir, 'pty-exit-debug.log'), line)
            } catch { /* never throw from a diagnostic */ }
        })
    }

    getPID (): number {
        return this.pty.pid
    }

    resize (columns: number, rows: number): void {
        if ((this.pty as any)._writable) {
            this.pty.resize(columns, rows)
        }
    }

    write (buffer: Buffer): void {
        if ((this.pty as any)._writable) {
            this.pty.write(buffer as any)
        }
    }

    ackData (length: number): void {
        this.outputQueue.ack(length)
    }

    kill (signal?: string): void {
        this.pty.kill(signal)
    }

    private emit (event: string, ...args: any[]) {
        this.app.broadcast(`pty:${this.id}:${event}`, ...args)
    }
}

export class PTYManager {
    private ptys: Record<string, PTY|undefined> = {}

    init (app: Application): void {
        ipcMain.on('pty:spawn', (event, ...options) => {
            const id = uuidv4().toString()
            event.returnValue = id
            this.ptys[id] = new PTY(id, app, ...options)
        })

        ipcMain.on('pty:exists', (event, id) => {
            event.returnValue = this.ptys[id] && !this.ptys[id].exited
        })

        ipcMain.on('pty:get-pid', (event, id) => {
            event.returnValue = this.ptys[id]?.getPID()
        })

        ipcMain.on('pty:resize', (_event, id, columns, rows) => {
            this.ptys[id]?.resize(columns, rows)
        })

        ipcMain.on('pty:write', (_event, id, data) => {
            this.ptys[id]?.write(Buffer.from(data))
        })

        ipcMain.on('pty:kill', (_event, id, signal) => {
            this.ptys[id]?.kill(signal)
        })

        ipcMain.on('pty:ack-data', (_event, id, length) => {
            this.ptys[id]?.ackData(length)
        })
    }
}
