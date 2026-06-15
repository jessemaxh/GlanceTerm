import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { DebugLog } from '../debug-log.service'

/**
 * The unified ~/.glanceterm/debug.log: fresh per startup, capped at ~10 MB with
 * rotated backups, always-on, and safe to run in the renderer hot path (never
 * throws; the console tee never recurses). maxBytes + path are injectable so
 * these tests don't write 10 MB for real.
 */

let dir: string
const fp = () => path.join(dir, 'debug.log')

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glanceterm-dbg-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('DebugLog rotation', () => {
    it('startup rotates the previous debug.log to .1 and opens a fresh one', () => {
        fs.writeFileSync(fp(), 'PREVIOUS SESSION CONTENT\n')
        const dbg = new DebugLog({ filePath: fp(), teeConsole: false })
        dbg.init()
        expect(fs.readFileSync(fp() + '.1', 'utf8')).toContain('PREVIOUS SESSION CONTENT')
        const fresh = fs.readFileSync(fp(), 'utf8')
        expect(fresh).toContain('[startup]')
        expect(fresh).not.toContain('PREVIOUS SESSION CONTENT')
    })

    it('rotates when a write would exceed maxBytes', () => {
        const dbg = new DebugLog({ filePath: fp(), maxBytes: 200, backups: 3, teeConsole: false })
        dbg.init()
        for (let i = 0; i < 12; i++) dbg.log('info', 'test', `line number ${i} padding-padding`)
        expect(fs.existsSync(fp() + '.1')).toBe(true) // rotated at least once
        expect(fs.existsSync(fp())).toBe(true)        // and continued in a fresh file
    })

    it('caps backups at 3 — the oldest (.4) is dropped', () => {
        const dbg = new DebugLog({ filePath: fp(), maxBytes: 120, backups: 3, teeConsole: false })
        dbg.init()
        for (let i = 0; i < 60; i++) dbg.log('info', 'test', `rotating line ${i} with some padding here`)
        expect(fs.existsSync(fp() + '.1')).toBe(true)
        expect(fs.existsSync(fp() + '.2')).toBe(true)
        expect(fs.existsSync(fp() + '.3')).toBe(true)
        expect(fs.existsSync(fp() + '.4')).toBe(false) // never keeps more than `backups`
    })

    it('a failing write never throws (unwritable target)', () => {
        // Parent of the log path is a FILE → mkdir + append both fail (ENOTDIR).
        const blocker = path.join(dir, 'blocker')
        fs.writeFileSync(blocker, 'x')
        const dbg = new DebugLog({ filePath: path.join(blocker, 'debug.log'), teeConsole: false })
        expect(() => { dbg.init(); dbg.log('error', 'test', 'should not throw') }).not.toThrow()
    })
})

describe('DebugLog console tee', () => {
    it('console.error is captured to the file AND still calls the original, no loop', () => {
        const realWarn = console.warn
        const realError = console.error
        const spyError = vi.fn()
        console.error = spyError // installed BEFORE init → captured as the "original"
        const dbg = new DebugLog({ filePath: fp(), teeConsole: true })
        try {
            dbg.init()
            console.error('boom-marker', new Error('explode'))
            expect(spyError).toHaveBeenCalledTimes(1) // original still invoked exactly once (no recursion)
            const content = fs.readFileSync(fp(), 'utf8')
            expect(content).toContain('ERROR [console]')
            expect(content).toContain('boom-marker')
            expect(content).toContain('explode') // Error rendered via stack/message
        } finally {
            dbg.restoreConsole()
            console.warn = realWarn
            console.error = realError
        }
    })
})
