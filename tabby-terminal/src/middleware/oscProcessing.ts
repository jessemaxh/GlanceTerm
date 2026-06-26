import * as os from 'os'
import { Subject, Observable } from 'rxjs'
import { SessionMiddleware } from '../api/middleware'

const OSCPrefix = Buffer.from('\x1b]')
const OSCSuffixes = [Buffer.from('\x07'), Buffer.from('\x1b\\')]

/**
 * A reported cwd is UNTRUSTED input — OSC 7 over SSH carries bytes straight from
 * the remote shell, and `cwd` flows downstream into sinks that bypass Angular's
 * HTML escaping (the desktop Notification body, the mobile-bridge Telegram topic
 * title). Strip control chars (a `%0a` decoded to a newline would forge extra
 * lines / inject text into those sinks) and bound the length. '' = nothing usable.
 */
function sanitizeCwd (raw: string): string {
    // eslint-disable-next-line no-control-regex
    return raw.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1024)
}

export class OSCProcessor extends SessionMiddleware {
    get cwdReported$ (): Observable<string> { return this.cwdReported }
    get copyRequested$ (): Observable<string> { return this.copyRequested }

    private cwdReported = new Subject<string>()
    private buffer: Buffer | null = null
    private copyRequested = new Subject<string>()

    feedFromSession (data: Buffer): void {
        // Prepend any buffered data from previous chunks
        if (this.buffer) {
            data = Buffer.concat([this.buffer, data])
            this.buffer = null
        }

        let startIndex = 0
        const processedData: Buffer[] = []

        while (startIndex < data.length) {
            const prefixIndex = data.indexOf(OSCPrefix, startIndex)

            if (prefixIndex === -1) {
                // No more OSC sequences, pass remaining data
                if (startIndex < data.length) {
                    processedData.push(data.subarray(startIndex))
                }
                break
            }

            // Pass data before this OSC sequence
            if (prefixIndex > startIndex) {
                processedData.push(data.subarray(startIndex, prefixIndex))
            }

            // Look for suffix after the prefix
            const suffixSearchStart = prefixIndex + OSCPrefix.length
            let foundSuffix: [Buffer, number] | null = null

            for (const suffix of OSCSuffixes) {
                const suffixIndex = data.indexOf(suffix, suffixSearchStart)
                if (suffixIndex !== -1) {
                    if (!foundSuffix || suffixIndex < foundSuffix[1]) {
                        foundSuffix = [suffix, suffixIndex]
                    }
                }
            }

            if (!foundSuffix) {
                // No suffix found - buffer the rest and wait for next chunk
                this.buffer = data.subarray(prefixIndex)
                break
            }

            // Extract OSC string (between prefix and suffix)
            const oscString = data.subarray(suffixSearchStart, foundSuffix[1]).toString()
            const [oscCodeString, ...oscParams] = oscString.split(';')
            const oscCode = parseInt(oscCodeString)

            if (oscCode === 1337) {
                const paramString = oscParams.join(';')
                if (paramString.startsWith('CurrentDir=')) {
                    let reportedCWD = paramString.split('=', 2)[1]
                    if (reportedCWD.startsWith('~')) {
                        reportedCWD = os.homedir() + reportedCWD.substring(1)
                    }
                    const clean = sanitizeCwd(reportedCWD)
                    if (clean) {
                        this.cwdReported.next(clean)
                    }
                } else {
                    console.debug('Unsupported OSC 1337 parameter:', paramString)
                }
            } else if (oscCode === 52) {
                if (oscParams[0] === 'c' || oscParams[0] === '') {
                    const content = Buffer.from(oscParams[1], 'base64')
                    this.copyRequested.next(content.toString())
                }
            } else if (oscCode === 7) {
                // OSC 7 — `file://<host>/<percent-encoded-path>`: the de-facto
                // standard "current directory" report (bash/zsh/fish ship it by
                // default on many distros). Complements OSC 1337 above; for an
                // SSH tab this is the REMOTE shell reporting its cwd, which rides
                // back over the connection — the one zero-config way to surface a
                // remote path. We use only the path, ignoring the host part.
                const url = oscParams.join(';')
                if (url.startsWith('file://')) {
                    const afterScheme = url.slice('file://'.length)
                    const slashIndex = afterScheme.indexOf('/')
                    if (slashIndex !== -1) {
                        let reportedCWD = afterScheme.slice(slashIndex)
                        try { reportedCWD = decodeURIComponent(reportedCWD) } catch { /* keep raw on a bad %xx */ }
                        const clean = sanitizeCwd(reportedCWD)
                        if (clean) {
                            this.cwdReported.next(clean)
                        }
                    }
                }
            } else {
                processedData.push(data.subarray(prefixIndex, foundSuffix[1] + foundSuffix[0].length))
            }

            // Move past this OSC sequence
            startIndex = foundSuffix[1] + foundSuffix[0].length
        }

        // Pass through all processed data
        if (processedData.length > 0) {
            super.feedFromSession(Buffer.concat(processedData))
        }
    }

    close (): void {
        this.cwdReported.complete()
        this.copyRequested.complete()
        super.close()
    }
}
