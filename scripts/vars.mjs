import * as path from 'path'
import * as fs from 'fs'
import * as semver from 'semver'
import * as childProcess from 'child_process'

process.env.ARCH = ((process.env.ARCH || process.arch) === 'arm') ? 'armv7l' : (process.env.ARCH || process.arch)

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const electronInfo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../node_modules/electron/package.json')))

// Version source, in order:
//   1. The pushed git TAG. CI sets GITHUB_REF=refs/tags/vX.Y.Z on a tag build,
//      and the tag IS the release version — so cutting a release is just
//      `git tag v0.1.1 && git push`, with NO app/package.json edit. We read the
//      EXPLICIT ref rather than `git describe`, because this Tabby fork still
//      carries upstream's old v1.x tags (describe would report 1.0.235).
//   2. app/package.json's version — the local/dev baseline when there's no tag.
//
// The build version is then specialised so every artifact filename is traceable
// (e.g. GlanceTerm-0.1.0-dev.g3a1b2c4-macos-arm64.dmg). Precedence:
//   RELEASE=1 → clean baseVersion (the actual distributable; keeps semver/auto-update tidy)
//   REV set   → CI nightly, <base>-nightly.<REV>
//   otherwise → local dev, <base>-dev.g<shorthash>[.dirty]
// The `g` prefix keeps the hash a valid *alphanumeric* semver prerelease id even
// when a hash is all digits (a bare numeric id may not have a leading zero).
function tagVersion () {
    const m = (process.env.GITHUB_REF || '').match(/^refs\/tags\/v(\d+\.\d+\.\d+(?:-[\w.]+)?)$/)
    return m && semver.valid(m[1]) ? m[1] : null
}
const baseVersion = tagVersion() ?? JSON.parse(fs.readFileSync(path.resolve(__dirname, '../app/package.json'), 'utf-8')).version

function gitDevTag() {
    try {
        const opts = { cwd: __dirname, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
        const hash = String(childProcess.execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], opts)).trim()
        if (!hash) return ''
        let dirty = ''
        try {
            if (String(childProcess.execFileSync('git', ['status', '--porcelain'], opts)).trim()) dirty = '.dirty'
        } catch { /* git unavailable / not a worktree — treat as clean */ }
        return `g${hash}${dirty}`
    } catch {
        return ''
    }
}

// Explicit comparisons, not truthiness: `RELEASE=0` / `RELEASE=false` must NOT
// be read as "this is a release". Release is strictly opt-in via RELEASE=1.
const isRelease = process.env.RELEASE === '1'
const rev = process.env.REV
const devTag = (isRelease || rev) ? '' : gitDevTag()
export let version =
    isRelease ? baseVersion
        : rev ? `${baseVersion}-nightly.${rev}`
            : devTag ? `${baseVersion}-dev.${devTag}`
                : baseVersion

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
