import { promisify } from 'util'

// Matches npm's package-name rules (optionally scoped, lowercase,
// url-safe), tightened to also reject a leading `-` in the scope and
// name segments so nothing that LOOKS like a CLI flag (`--registry`,
// `--ignore-scripts`) ever reaches the install command — npm6's
// programmatic API treats array elements as package specs today, but
// the validation must not depend on that staying true. `file:../x`,
// `git+https://…`, paths and ranges all fail the regexes too, since
// name/version arrive over IPC from the renderer and get concatenated
// into an install spec.
const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/
// Exact versions and dist-tags only (1.2.3, 1.2.3-beta.1, latest) —
// no ranges, no URLs, no leading dash.
const PACKAGE_VERSION = /^[a-z0-9][a-z0-9.+-]*$/i

// JSON.stringify throws on BigInt — and these values come over IPC, so
// the error path has to render ANY input without itself throwing.
function show (v: unknown): string {
    return typeof v === 'string' ? JSON.stringify(v) : String(v)
}

function validateSpec (name: string, version?: string): void {
    if (typeof name !== 'string' || name.length > 214 || !PACKAGE_NAME.test(name)) {
        throw new Error(`PluginManager: invalid package name ${show(name)}`)
    }
    if (version !== undefined && (typeof version !== 'string' || version.length > 64 || !PACKAGE_VERSION.test(version))) {
        throw new Error(`PluginManager: invalid package version ${show(version)}`)
    }
}

export class PluginManager {
    npm: any
    npmReady?: Promise<void>

    async ensureLoaded (): Promise<void> {
        if (!this.npmReady) {
            this.npmReady = new Promise(resolve => {
                const npm = require('npm')
                npm.load(err => {
                    if (err) {
                        console.error(err)
                        return
                    }
                    npm.config.set('global', false)
                    this.npm = npm
                    resolve()
                })
            })
        }
        return this.npmReady
    }

    async install (path: string, name: string, version: string): Promise<void> {
        validateSpec(name, version)
        await this.ensureLoaded()
        this.npm.prefix = path
        return promisify(this.npm.commands.install)([`${name}@${version}`])
    }

    async uninstall (path: string, name: string): Promise<void> {
        validateSpec(name)
        await this.ensureLoaded()
        this.npm.prefix = path
        return promisify(this.npm.commands.remove)([name])
    }
}


export const pluginManager = new PluginManager()
