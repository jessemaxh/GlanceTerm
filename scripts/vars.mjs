import * as path from 'path'
import * as fs from 'fs'
import * as semver from 'semver'
import * as childProcess from 'child_process'

process.env.ARCH = ((process.env.ARCH || process.arch) === 'arm') ? 'armv7l' : (process.env.ARCH || process.arch)

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const electronInfo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../node_modules/electron/package.json')))

// Version: GlanceTerm owns it in app/package.json (single source of truth).
// We deliberately do NOT derive it from `git describe` — this repo is a Tabby
// fork and still carries upstream's old `v1.x` git tags, so describe would make
// builds report 1.0.235 instead of GlanceTerm's own line. A CI/nightly build
// stamps a prerelease suffix via REV (e.g. 0.1.0-nightly.42); a release build
// leaves it clean (0.1.0). To bump the version, edit app/package.json.
const baseVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../app/package.json'), 'utf-8')).version
export let version = process.env.REV ? `${baseVersion}-nightly.${process.env.REV}` : baseVersion

export const builtinPlugins = [
    'tabby-core',
    'tabby-settings',
    'tabby-terminal',
    'tabby-web',
    'tabby-community-color-schemes',
    'tabby-ssh',
    'tabby-serial',
    'tabby-telnet',
    'tabby-local',
    'tabby-electron',
    'tabby-plugin-manager',
    'tabby-linkifier',
    'tabby-auto-sudo-password',
    'tabby-plugin-ai-sidebar',  // GlanceTerm AI sidebar — bundled by default
    'tabby-plugin-mobile-bridge',  // GlanceTerm mobile bridge — Telegram + 飞书
]

export const packagesWithDocs = [
    ['.', 'tabby-core'],
    ['terminal', 'tabby-terminal'],
    ['local', 'tabby-local'],
    ['settings', 'tabby-settings'],
]

export const allPackages = [
    ...builtinPlugins,
    'web',
    'tabby-web-demo',
]

export const bundledModules = [
    '@angular',
    '@ng-bootstrap',
]
export const electronVersion = electronInfo.version

export const keygenConfig = {
    provider: 'keygen',
    account: 'a06315f2-1031-47c6-9181-e92a20ec815e',
    channel: 'stable',
    product: {
        win32: {
            x64: 'f481b9d6-d5da-4970-b926-f515373e986f',
            arm64: '950999b9-371c-419b-b291-938c5e4d364c',
        }[process.env.ARCH],
        darwin: {
            arm64: '98fbadee-c707-4cd6-9d99-56683595a846',
            x86_64: 'f5a48841-d5b8-4b7b-aaa7-cf5bffd36461',
            x64: 'f5a48841-d5b8-4b7b-aaa7-cf5bffd36461',
        }[process.env.ARCH],
        linux: {
            x64: '7bf45071-3031-4a26-9f2e-72604308313e',
            arm64: '39e3c736-d4d4-4fbf-a201-324b7bab0d17',
            armv7l: '50ae0a82-7f47-4fa4-b0a8-b0d575ce9409',
            armhf: '7df5aa12-04ab-4075-a0fe-93b0bbea9643',
        }[process.env.ARCH],
    }[process.platform],
}

if (!keygenConfig.product) {
    throw new Error(`Unrecognized platform ${process.platform}/${process.env.ARCH}`)
}
