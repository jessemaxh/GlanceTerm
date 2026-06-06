#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'
import { build as builder } from 'electron-builder'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import path from 'node:path'
import * as vars from './vars.mjs'

// Ensure builtin-plugins/ is in sync with current source.
// build-macos used to assume the developer ran `npm run build` and
// `node scripts/prepackage-plugins.mjs` first; forgetting either silently
// shipped a stale plugin snapshot inside the .dmg (you'd notice when a
// freshly-installed app was missing recently-merged features). We now do
// both unconditionally so the .dmg always reflects HEAD.
// Override with SKIP_PREPACKAGE=1 if you're iterating only on the Electron
// shell and know plugins are fresh.
if (!process.env.SKIP_PREPACKAGE) {
    execFileSync('npm', ['run', 'build'],                    { stdio: 'inherit' })
    execFileSync('node', ['scripts/prepackage-plugins.mjs'], { stdio: 'inherit' })
}

// CI does these two steps in .github/workflows/build.yml; for local
// `npm run dmg:mac` we have to do them too or electron-builder packages
// a broken .app. Both are idempotent — safe to run on every build.
//
// 1. `yarn` in app/ runs patch-package against app/node_modules. Several
//    packages (notably @serialport/bindings-cpp and glasstron) need patches
//    applied at install time; without them the runtime crashes are
//    obscure ("native module unable to load" deep in xterm). The yarn
//    invocation also writes the `.yarn-integrity` file electron-builder
//    uses as a hint that "this is a real production node_modules tree."
// 2. The electron symlink at app/node_modules/electron is a workaround
//    for an electron-builder beta bug — without it, electron-builder's
//    production-dep walker finds no `electron` in the app's node_modules
//    and silently bails on collecting ANY other deps. The visible
//    symptom is a 9 MB asar with only app/ source files and no
//    node_modules at all, and a .app that crashes at launch with
//    `Cannot find module 'v8-compile-cache'`. Symlinking electron from
//    root/node_modules makes the walker happy.
const appDir = path.resolve('app')
if (fs.existsSync(appDir)) {
    execFileSync('yarn', [], { cwd: appDir, stdio: 'inherit' })
    const electronLink = path.join(appDir, 'node_modules', 'electron')
    const electronTarget = path.join('..', '..', 'node_modules', 'electron')
    try {
        const existing = fs.lstatSync(electronLink)
        if (existing.isSymbolicLink()) {
            // Already symlinked — leave it. fs.symlinkSync would EEXIST.
        } else {
            // Real directory or file shadowing the symlink target — replace.
            fs.rmSync(electronLink, { recursive: true, force: true })
            fs.symlinkSync(electronTarget, electronLink)
        }
    } catch (e) {
        if (e?.code === 'ENOENT') {
            fs.symlinkSync(electronTarget, electronLink)
        } else {
            throw e
        }
    }
}

const isTag = (process.env.GITHUB_REF || '').startsWith('refs/tags/')

process.env.ARCH = process.env.ARCH || process.arch

if (process.env.GITHUB_HEAD_REF) {
    delete process.env.CSC_LINK
    delete process.env.CSC_KEY_PASSWORD
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
}

process.env.APPLE_ID ??= process.env.APPSTORE_USERNAME
process.env.APPLE_APP_SPECIFIC_PASSWORD ??= process.env.APPSTORE_PASSWORD

// Without CSC_LINK we want ad-hoc signing — runs locally without Gatekeeper
// nagging the developer, and avoids electron-builder's keychain
// auto-discovery silently picking the wrong cert. electron-builder 26 no
// longer honours `identity: '-'` (it treats `-` as a keychain identity name
// and skips signing when no match is found), so we run codesign ourselves
// in `afterPack`, before the DMG is assembled.
const adHocSign = !process.env.CSC_LINK

builder({
    dir: true,
    mac: ['dmg', 'zip'],
    x64: process.env.ARCH === 'x86_64',
    arm64: process.env.ARCH === 'arm64',
    config: {
        extraMetadata: {
            version: vars.version,
            teamId: process.env.APPLE_TEAM_ID,
        },
        forceCodeSigning: !!process.env.CSC_LINK,
        afterPack: async context => {
            if (context.electronPlatformName !== 'darwin') return
            const appPath = path.join(
                context.appOutDir,
                `${context.packager.appInfo.productFilename}.app`,
            )
            // 1. Flip Electron fuses FIRST (this rewrites bytes inside the
            //    Electron Framework binary and would invalidate any prior
            //    signature). electron-builder's own fuses step runs AFTER
            //    afterPack, so we do it here ourselves and disable theirs.
            //    flipFuses expects the .app path; it resolves the binary internally.
            console.log(`  • flipping fuses ${appPath}`)
            await flipFuses(appPath, {
                version: FuseVersion.V1,
                [FuseV1Options.RunAsNode]: false,
                [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
                [FuseV1Options.EnableNodeCliInspectArguments]: false,
            })
            // 2. Now sign bottom-up. Skip when CSC_LINK is set — electron-builder
            //    handles that case with the real cert.
            if (!adHocSign) return
            console.log(`  • ad-hoc signing (bottom-up) ${appPath}`)
            adHocSignBundle(appPath)
        },
        mac: {
            // null disables electron-builder's own signing pass; `afterPack`
            // above does an ad-hoc codesign instead. With CSC_LINK set we
            // hand off to electron-builder for real Developer ID signing.
            identity: adHocSign ? null : undefined,
            notarize: !!process.env.APPLE_TEAM_ID,
        },
        npmRebuild: process.env.ARCH !== 'arm64',
        publish: process.env.KEYGEN_TOKEN ? [
            vars.keygenConfig,
            {
                provider: 'github',
                channel: `latest-${process.env.ARCH}`,
            },
        ] : undefined,
    },
    publish: (process.env.KEYGEN_TOKEN && isTag) ? 'always' : 'never',
}).catch(e => {
    console.error(e)
    process.exit(1)
})

// `codesign --deep` cannot reliably re-sign Electron's nested
// frameworks (Apple deprecated it and it silently leaves the inner
// `Electron Framework.framework` mis-hashed → macOS kills the process at
// dyld load with `Code Signature Invalid` / `Invalid Page`). We instead walk
// the bundle bottom-up: deepest Mach-O binaries first, then frameworks, then
// the wrapping .app bundles.
function codesignAdHoc (target) {
    execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], {
        stdio: ['ignore', 'ignore', 'inherit'],
    })
}

function isMachO (filePath) {
    try {
        const fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(4)
        fs.readSync(fd, buf, 0, 4, 0)
        fs.closeSync(fd)
        const magic = buf.readUInt32BE(0)
        // 0xfeedface / 0xfeedfacf  + LE swapped variants  + fat magics
        return magic === 0xfeedface || magic === 0xfeedfacf
            || magic === 0xcefaedfe || magic === 0xcffaedfe
            || magic === 0xcafebabe || magic === 0xbebafeca
    } catch {
        return false
    }
}

// Sign every Mach-O dylib / executable directly inside a directory (no
// recursion into sub-bundles — those are handled by adHocSignBundle).
function signLooseMachOsIn (dir) {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        const st = fs.lstatSync(full)
        if (st.isSymbolicLink()) continue
        if (st.isFile() && isMachO(full)) {
            codesignAdHoc(full)
        }
    }
}

function adHocSignBundle (bundlePath) {
    // 1. Recurse into ALL nested .app and .framework bundles first.
    const frameworksDir = path.join(bundlePath, 'Contents', 'Frameworks')
    if (fs.existsSync(frameworksDir)) {
        for (const name of fs.readdirSync(frameworksDir)) {
            const child = path.join(frameworksDir, name)
            if (name.endsWith('.app') || name.endsWith('.framework')) {
                adHocSignBundle(child)
            }
        }
    }

    // 2. Inside a .framework, sign loose dylibs + helpers under Versions/A/.
    if (bundlePath.endsWith('.framework')) {
        const versionsA = path.join(bundlePath, 'Versions', 'A')
        if (fs.existsSync(versionsA)) {
            signLooseMachOsIn(path.join(versionsA, 'Libraries'))
            signLooseMachOsIn(path.join(versionsA, 'Helpers'))
        }
    }

    // 3. Finally seal this bundle itself.
    codesignAdHoc(bundlePath)
}
