#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import asar from '@electron/asar'
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'
import { build as builder } from 'electron-builder'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import path from 'node:path'
import * as vars from './vars.mjs'

// ============================================================
//   PATH override (must run BEFORE any child process)
// ============================================================
//
// Force system npm to the head of PATH for THIS process and every child
// (electron-builder, the prepackage yarn/npm calls, …).
//
// Background: this script is invoked through `npm run dmg:mac`, and npm
// prepends `<root>/node_modules/.bin/` to PATH for any script it runs.
// `<root>/node_modules/.bin/npm` is the OLD npm v6 bundled as a runtime
// dep (tabby-plugin-manager uses it). When electron-builder shells out
// to `npm list -a --include prod --include optional --omit dev --json`
// to compute the production dep tree (the bytes that end up in the asar's
// node_modules), it picks up that v6 — which on Node 18+ either crashes
// with `cb.apply is not a function` or returns an empty `dependencies`
// object. The visible symptom is `collected node modules nodeModules=[]`
// in the electron-builder log and a node_modules-free asar (the afterPack
// self-check catches this and aborts the build).
//
// We prepend the system bin dirs once at script start so every child
// process spawned from here resolves `npm` to the user's installed
// v10+. Filtering on `existsSync` keeps the override well-formed on
// machines where one of these directories doesn't exist (e.g. Apple
// Silicon hosts skip `/usr/local/bin`).
{
    const systemBins = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
        .filter(p => fs.existsSync(p))
        .join(':')
    process.env.PATH = `${systemBins}:${process.env.PATH ?? ''}`
}

// ============================================================
//   Pre-flight checks — fail fast with actionable errors
// ============================================================
//
// All of these were learned the hard way from real build failures. Each
// check exists because skipping it produces a cryptic downstream error
// that costs 5+ minutes to diagnose. Better to surface the actual
// problem here in <1 second.
{
    const failures = []
    const note = msg => { console.error(`  ✖ ${msg}`); failures.push(msg) }
    const ok = msg => { console.log(`  ✓ ${msg}`) }

    console.log('  • pre-flight checks')

    // (1) npm ≥ 7. v6 returns an empty `dependencies` object from
    //     `npm list --json` even with a valid package-lock — the same
    //     symptom as no lockfile at all. v7 introduced the modern
    //     resolution algorithm electron-builder relies on.
    let npmVersion = ''
    try {
        npmVersion = String(execFileSync('npm', ['--version'], { encoding: 'utf8' })).trim()
        const major = parseInt(npmVersion.split('.')[0], 10)
        if (!Number.isFinite(major) || major < 7) {
            note(`npm ${npmVersion} found, but ≥7 required (electron-builder dep walker needs the v7+ resolver). ` +
                 'Install via: brew install node  OR  https://nodejs.org/en/download/')
        } else {
            ok(`npm ${npmVersion}`)
        }
    } catch (e) {
        note(`npm not found on PATH (${e?.message ?? e}). PATH=${process.env.PATH}`)
    }

    // (2) yarn present. Used in the prepackage step for patch-package
    //     against @serialport/bindings-cpp and glasstron (their post-
    //     install patches don't apply cleanly under npm).
    try {
        const yarnVersion = String(execFileSync('yarn', ['--version'], { encoding: 'utf8' })).trim()
        ok(`yarn ${yarnVersion}`)
    } catch (e) {
        note(`yarn not found on PATH (${e?.message ?? e}). Install via: brew install yarn  OR  npm install -g yarn`)
    }

    // (3) Node ≥ 18. electron-builder 26 + electron 38 both require it.
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10)
    if (nodeMajor < 18) {
        note(`Node ${process.versions.node} too old; need ≥18 for electron-builder 26 + electron 38.`)
    } else {
        ok(`node ${process.versions.node}`)
    }

    // (4) Root node_modules exists. electron-builder symlinks electron
    //     from <root>/node_modules/electron into app/node_modules/electron;
    //     missing root install short-circuits that whole path.
    if (!fs.existsSync('node_modules/electron/package.json')) {
        note('node_modules/electron missing — run `npm install` at the repo root first.')
    } else {
        ok('root node_modules/electron present')
    }

    if (failures.length > 0) {
        console.error(`\n\x1b[31m✖ pre-flight failed (${failures.length} issue${failures.length === 1 ? '' : 's'}). Fix the items above and re-run.\x1b[0m\n`)
        process.exit(1)
    }
}

// ============================================================
//   Stale-output cleanup — guarantee a clean output tree
// ============================================================
//
// Leftover `dist/mac-arm64/` from a previous run that failed mid-build
// (asar verification threw, ad-hoc sign crashed, …) creates two failure
// modes for the next run:
//   - electron-builder's "overwrite" logic occasionally misfires on a
//     partially-populated tree and skips rewriting `app.asar`, so we
//     verify the OLD asar and either pass or fail based on history,
//     not the current source.
//   - LaunchServices catches and indexes the stale .app, so Spotlight
//     and Launchpad pick it up alongside the real install.
// Nuking it up-front sidesteps both. The DMG/zip artifacts in dist/
// itself stay (overwriting them is fine, electron-builder handles it).
{
    const stale = path.resolve('dist', `mac-${process.arch === 'x64' ? 'x64' : process.arch}`)
    if (fs.existsSync(stale)) {
        console.log(`  • cleaning stale output ${stale}`)
        fs.rmSync(stale, { recursive: true, force: true })
    }
}

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

    // CI does these two steps in .github/workflows/build.yml; for local
    // `npm run dmg:mac` we have to do them too or electron-builder
    // packages a broken .app. Both are idempotent. Bundled with the
    // SKIP_PREPACKAGE gate because the inner-loop case (developer
    // iterating on Electron shell, plugins already fresh) doesn't need
    // them either.
    //
    // 1. `yarn` in app/ runs patch-package against app/node_modules.
    //    Several packages (notably @serialport/bindings-cpp and
    //    glasstron) need patches applied at install time; without them
    //    the runtime crashes are obscure ("native module unable to
    //    load" deep in xterm). The yarn invocation also writes the
    //    `.yarn-integrity` file electron-builder uses as a hint that
    //    "this is a real production node_modules tree."
    // 2. The electron symlink at app/node_modules/electron is a
    //    workaround for an electron-builder beta bug — without it,
    //    electron-builder's production-dep walker finds no `electron`
    //    in the app's node_modules and silently bails on collecting
    //    ANY other deps. The visible symptom is a 9 MB asar with only
    //    app/ source files and no node_modules at all, and a .app
    //    that crashes at launch with `Cannot find module
    //    'v8-compile-cache'`. Symlinking electron from
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
        // 3. Materialise a package-lock.json npm can read.
        //
        //    electron-builder's production-dep walker shells out to
        //    `npm list -a --include prod --include optional --omit dev --json`
        //    in app/ to learn which modules to copy into the asar. With
        //    only yarn.lock present npm has no resolved dependency graph
        //    and the JSON comes back with an empty `dependencies` object,
        //    which logs as `collected node modules nodeModules=[]` and
        //    bakes a node_modules-free asar (the visible symptom is the
        //    `BROKEN BUILD — app.asar is missing production node_modules`
        //    self-check failure in afterPack). yarn warns when both
        //    lockfiles exist — that warning is fine, we just need npm
        //    to see SOMETHING, and --package-lock-only writes the lock
        //    without touching node_modules on disk (so the yarn-applied
        //    patch-package patches survive untouched). Run with
        //    `--ignore-scripts` so postinstall doesn't re-fire
        //    patch-package (it would no-op but it's noise; faster too).
        //
        //    process.env.PATH is already fixed at the top of this file
        //    so this child resolves `npm` to the system v10+ (see the
        //    PATH-override block near imports for the full rationale).
        execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
            { cwd: appDir, stdio: 'inherit' })
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
            // 0. Verify the asar actually got production node_modules. The
            //    electron-builder dep walker silently bails when it can't
            //    find `electron` in app/node_modules (see prepackage block
            //    above); the resulting .app launches and immediately crashes
            //    with `Cannot find module 'v8-compile-cache'`. Catch that
            //    here — before fuses/sign/DMG — so the failure is loud and
            //    the broken .app is never wrapped in a DMG that looks fine.
            verifyAsarHasNodeModules(appPath)
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
}).then(() => {
    // The .dmg and .zip already contain a copy of GlanceTerm.app; keeping the
    // loose `dist/mac-arm64/GlanceTerm.app` around just makes LaunchServices
    // index it alongside `/Applications/GlanceTerm.app`, which leaves Launchpad
    // / Spotlight returning duplicates (and sometimes failing to find the app
    // by name at all). Delete it once the artifacts are produced.
    if (process.env.KEEP_DIR_BUILD) return
    const dirBuild = path.join('dist', `mac-${process.env.ARCH === 'x86_64' ? 'x64' : process.env.ARCH}`, 'GlanceTerm.app')
    try {
        fs.rmSync(dirBuild, { recursive: true, force: true })
        console.log(`  • removed loose ${dirBuild} (set KEEP_DIR_BUILD=1 to retain)`)
    } catch { /* best-effort */ }
}).catch(e => {
    console.error(e)
    process.exit(1)
})

// Canary modules that MUST end up inside app.asar's node_modules. If any are
// missing the dep walker bailed (almost always: stale/missing
// app/node_modules/electron symlink, or SKIP_PREPACKAGE=1 with no prior `yarn`
// in app/). v8-compile-cache is the one that surfaces first at launch
// (Cannot find module 'v8-compile-cache'); the others are listed so a future
// regression that drops only some deps still trips the check.
const REQUIRED_ASAR_MODULES = [
    'node_modules/v8-compile-cache/package.json',
    'node_modules/keytar/package.json',
    'node_modules/source-map-support/package.json',
    'node_modules/electron-updater/package.json',
]

function verifyAsarHasNodeModules (appPath) {
    const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar')
    console.log(`  • verifying asar deps ${asarPath}`)
    const entries = new Set(
        asar.listPackage(asarPath, { isPack: false }).map(e => e.replace(/^[/\\]/, '')),
    )
    const missing = REQUIRED_ASAR_MODULES.filter(m => !entries.has(m))
    if (missing.length === 0) return

    console.error('\n\x1b[31m✖ BROKEN BUILD — app.asar is missing production node_modules.\x1b[0m')
    console.error('  Missing entries:')
    for (const m of missing) console.error(`    - ${m}`)
    console.error('\n  This means electron-builder\'s production-dep walker bailed.')
    console.error('  Almost always the cause is one of:')
    console.error('    • SKIP_PREPACKAGE=1 was set (the symlink + yarn fallback is')
    console.error('      NOT reliable — observed to silently bail even when set up correctly)')
    console.error('    • electron-builder was invoked directly (bypassing this script)')
    console.error('\n  Fix: run `npm run dmg:mac` with SKIP_PREPACKAGE unset.\n')

    // Throwing aborts the build before DMG/zip; no need to wipe the .app
    // ourselves. (Earlier versions rm-ed appPath here, but afterPack also
    // runs for the dir-only pass with `dir: true` — and we'd rather inspect
    // a broken .app than have it silently disappear.)
    throw new Error('app.asar verification failed — see message above')
}

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
