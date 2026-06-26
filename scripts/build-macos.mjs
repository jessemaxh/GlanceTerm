#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import asar from '@electron/asar'
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'
import { build as builder } from 'electron-builder'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
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

// In a real release (the CI release workflow sets REQUIRE_SIGNED=1) we must NOT
// silently fall back to ad-hoc signing. An ad-hoc/unsigned .app attached to the
// GitHub release is Gatekeeper-blocked on download AND becomes the trust anchor
// that auto-update verifies every FUTURE update against — so a single
// missing/expired secret could pin users to an unsignable identity. Fail loudly
// (here, before any build work) instead of shipping unsigned. Local/test builds
// leave REQUIRE_SIGNED unset and keep the ad-hoc path.
if (process.env.REQUIRE_SIGNED === '1') {
    const missing = ['CSC_LINK', 'APPLE_TEAM_ID', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']
        .filter(k => !process.env[k])
    if (missing.length) {
        console.error(`\n  ✖ REQUIRE_SIGNED=1 but signing secrets are missing: ${missing.join(', ')}`)
        console.error('  A release build must be Developer-ID signed + notarized; refusing to')
        console.error('  produce an ad-hoc/unsigned artifact. Configure the repo secrets, or')
        console.error('  unset REQUIRE_SIGNED for a local/test build.\n')
        process.exit(1)
    }
}

// Without CSC_LINK we want ad-hoc signing — runs locally without Gatekeeper
// nagging the developer, and avoids electron-builder's keychain
// auto-discovery silently picking the wrong cert. electron-builder 26 no
// longer honours `identity: '-'` (it treats `-` as a keychain identity name
// and skips signing when no match is found), so we run codesign ourselves
// in `afterPack`, before the DMG is assembled.
const adHocSign = !process.env.CSC_LINK

// A signed build that isn't an explicit release still carries the dev version
// (0.1.0-dev.g<hash>[.dirty]) — which also lands in CFBundleVersion. Fine for
// test builds (and keeps the artifact filename traceable), but you almost never
// want to hand someone a "dev"/"dirty"-tagged signed dmg as a release. Remind,
// don't override (overriding would strip the hash that makes test builds
// distinguishable). For a clean release artifact: RELEASE=1 npm run dmg:mac
if (!adHocSign && process.env.RELEASE !== '1') {
    console.warn(`  ⚠ signed build, RELEASE!=1 — version is "${vars.version}" (also CFBundleVersion). For a clean release, run: RELEASE=1 npm run dmg:mac`)
}

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
            // 1.5 macOS 26 (Tahoe) icon. If a compiled Icon Composer `.icon` is
            //     present at build/mac/icon.icon, bundle it (actool → Assets.car +
            //     CFBundleIconName) AND swap the bundled legacy icon.icns to the
            //     inset version (build/mac/icon-legacy.icns) so macOS ≤15 sizes
            //     correctly too. ATOMIC + gated: the .icns swap happens only AFTER
            //     actool + the plist edit succeed, so a missing OR a failed .icon
            //     leaves the full-bleed icon.icns electron-builder already bundled
            //     (correct on Tahoe, slightly large on ≤15 — NO regression before
            //     the .icon lands). The actool invocation is VERIFIED against
            //     Xcode 26.3 actool (2026-06-16): the `.icon` bundle is passed to
            //     actool DIRECTLY — wrapping it in an .xcassets silently compiles to
            //     nothing. We also assert Assets.car was produced, so a future actool
            //     change that no-ops falls back to full-bleed instead of shipping a
            //     CFBundleIconName with no catalog behind it.
            //     Runs before signing so the cert covers Assets.car + the new icns.
            try {
                const dotIcon = path.resolve('build/mac/icon.icon')
                if (fs.existsSync(dotIcon)) {
                    const res = path.join(appPath, 'Contents', 'Resources')
                    const work = path.resolve('dist/.icon-build')
                    fs.rmSync(work, { recursive: true, force: true })
                    fs.mkdirSync(work, { recursive: true })
                    // actool consumes the .icon bundle directly. Stage it as
                    // AppIcon.icon so the emitted asset/plist key is the
                    // conventional "AppIcon".
                    const stagedIcon = path.join(work, 'AppIcon.icon')
                    fs.cpSync(dotIcon, stagedIcon, { recursive: true })
                    const partial = path.join(work, 'icon-partial.plist')
                    // → Assets.car (Liquid Glass; Tahoe reads it via CFBundleIconName)
                    //   + AppIcon.icns, both written into Contents/Resources.
                    execFileSync('xcrun', ['actool', stagedIcon, '--compile', res, '--app-icon', 'AppIcon',
                        '--platform', 'macosx', '--minimum-deployment-target', '26.0', '--target-device', 'mac',
                        '--output-partial-info-plist', partial], { stdio: 'inherit' })
                    if (!fs.existsSync(path.join(res, 'Assets.car'))) {
                        throw new Error('actool produced no Assets.car — refusing to set CFBundleIconName')
                    }
                    const info = path.join(appPath, 'Contents', 'Info.plist')
                    // Tahoe reads CFBundleIconName → Assets.car. Leave CFBundleIconFile
                    // (=icon) pointing at icon.icns, which we swap to the inset legacy
                    // art so macOS ≤15 (which ignores the Tahoe catalog) sizes correctly.
                    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconName AppIcon', info], { stdio: 'ignore' }) }
                    catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleIconName string AppIcon', info], { stdio: 'ignore' }) }
                    const inset = path.resolve('build/mac/icon-legacy.icns')
                    const insetApplied = fs.existsSync(inset)
                    if (insetApplied) fs.copyFileSync(inset, path.join(res, 'icon.icns'))
                    else console.warn('  ⚠ build/mac/icon-legacy.icns missing — macOS ≤15 keeps the full-bleed icon.icns (may look oversized).')
                    console.log(`  • Tahoe icon: bundled .icon (Assets.car + CFBundleIconName)${insetApplied ? ' + inset icon.icns for macOS ≤15' : ''}`)
                } else {
                    console.log('  • no build/mac/icon.icon — keeping full-bleed icon.icns (Tahoe-safe). Drop the Icon Composer export at build/mac/icon.icon to enable the dual-format.')
                }
            } catch (e) {
                // Roll back any partial catalog actool wrote before the failure
                // so we don't ship an orphan Assets.car / AppIcon.icns that no
                // CFBundleIconName points at (it would still get signed).
                try {
                    const resDir = path.join(appPath, 'Contents', 'Resources')
                    fs.rmSync(path.join(resDir, 'Assets.car'), { force: true })
                    fs.rmSync(path.join(resDir, 'AppIcon.icns'), { force: true })
                } catch { /* best-effort cleanup */ }
                console.warn('  ⚠ Tahoe .icon bundling failed — kept full-bleed icon.icns (no Tahoe regression). Verify the actool step with the real .icon:', e?.message ?? e)
            }
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
        // Always configure the GitHub provider so electron-builder bakes
        // `app-update.yml` into the .app and emits `latest-mac.yml` plus the
        // update `.zip`/`.blockmap` that installed apps poll to auto-update.
        //
        // NO per-arch `channel`: electron-updater's GitHub provider only ever
        // requests `latest-mac.yml` for a stable release — it ignores the baked
        // channel (GitHubProvider.getDefaultChannelName hardcodes "latest"), so
        // a `latest-arm64-mac.yml` would 404 and updates would silently never
        // apply. Each arch build therefore emits a standard `latest-mac.yml`
        // listing that arch's zip; the release workflow MERGES the two arches'
        // `files` into one `latest-mac.yml` (electron-updater's MacUpdater then
        // selects by the "arm64" substring in the filename).
        //
        // Generation needs only owner/repo, NOT a token; the top-level
        // `publish: 'never'` (below) keeps electron-builder from uploading — the
        // release workflow attaches artifacts via `gh release upload`. The
        // Keygen feed is layered on only when its token is present.
        publish: [
            ...(process.env.KEYGEN_TOKEN ? [vars.keygenConfig] : []),
            {
                provider: 'github',
                owner: 'jessemaxh',
                repo: 'GlanceTerm',
            },
        ],
    },
    publish: (process.env.KEYGEN_TOKEN && isTag) ? 'always' : 'never',
}).then(async () => {
    // electron-builder's built-in notarization only handles the .app — it
    // leaves the DMG wrapper unsigned + un-notarized, so a freshly-built dmg
    // is rejected by Gatekeeper ("no usable signature") on download even
    // though the .app inside is fine. Close that gap before anything else.
    await signNotarizeStapleDmg()
    // Final integrity gate before artifacts can be uploaded: assert the
    // signed+notarized .app (the same bytes inside BOTH the .dmg and the
    // auto-update .zip) actually verifies. A mis-signed app passes the build but
    // Gatekeeper-blocks on download and Squirrel.Mac rejects on auto-update.
    // Ad-hoc/local builds skip this — they can't pass spctl.
    if (!adHocSign) {
        const appPath = path.join('dist', `mac-${process.env.ARCH === 'x86_64' ? 'x64' : process.env.ARCH}`, 'GlanceTerm.app')
        if (fs.existsSync(appPath)) {
            // codesign --verify is the assertion that matters for auto-update:
            // Squirrel.Mac validates the downloaded .app's CODE SIGNATURE against
            // the running app, not its Gatekeeper/notarization status. (Download
            // notarization is asserted on the stapled .dmg below — offline-valid,
            // no flaky online spctl lookup on a possibly-unstapled .app.)
            console.log(`  • verifying code signature of ${appPath}`)
            execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' })
        }
    }
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

/**
 * Sign + notarize + staple every .dmg in dist/.
 *
 * electron-builder's built-in notarization (mac.notarize) only handles the
 * .app — it does NOT sign, notarize, or staple the DMG *wrapper*. A fresh
 * `npm run dmg:mac` therefore yields a dmg that `codesign` reports as "no
 * usable signature" and Gatekeeper rejects on download (the .app inside is
 * notarized + stapled and fine; the dmg layer isn't). We close that gap here.
 *
 * Gated on the real signing+notarization env (CSC_LINK + the three APPLE_*
 * vars). The ad-hoc / local path skips it — an ad-hoc dmg can't be notarized.
 *
 * Steps mirror Apple's recommended flow: re-establish the Developer ID
 * identity in a throwaway keychain (electron-builder's own CSC keychain is
 * gone by now), codesign the dmg with a secure timestamp, submit it to the
 * notary service (--wait), then staple the ticket so it validates offline.
 */
async function signNotarizeStapleDmg () {
    const { CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env
    if (!CSC_LINK || !APPLE_TEAM_ID || !APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD) {
        return
    }
    const distDir = path.resolve('dist')
    let dmgs = []
    try { dmgs = fs.readdirSync(distDir).filter(f => f.endsWith('.dmg')) } catch { return }
    if (dmgs.length === 0) return

    // CSC_LINK is either a .p12 path or base64 (electron-builder accepts both);
    // security(1) needs a file on disk, so materialise base64 to a temp file.
    let p12Path = CSC_LINK
    let tmpP12 = null
    if (!fs.existsSync(CSC_LINK)) {
        tmpP12 = path.join(os.tmpdir(), `gt-csc-${process.pid}.p12`)
        fs.writeFileSync(tmpP12, Buffer.from(CSC_LINK, 'base64'), { mode: 0o600 })
        p12Path = tmpP12
    }

    const kc = path.join(os.tmpdir(), `gt-dmgsign-${process.pid}.keychain-db`)
    const kcPass = `tmp-${process.pid}`
    const sec = args => execFileSync('security', args, { stdio: 'pipe' })
    let prevSearch = null
    try {
        try { sec(['delete-keychain', kc]) } catch { /* none yet */ }
        sec(['create-keychain', '-p', kcPass, kc])
        sec(['unlock-keychain', '-p', kcPass, kc])
        sec(['import', p12Path, '-k', kc, '-P', CSC_KEY_PASSWORD ?? '', '-T', '/usr/bin/codesign', '-A'])
        // Allow codesign to use the key WITHOUT a GUI authorization prompt.
        sec(['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', kcPass, kc])

        // codesign resolves the signing identity through the keychain SEARCH
        // LIST, not the --keychain flag alone. On a clean CI runner the cert
        // lives only in our temp keychain, which isn't in the search list, so
        // codesign fails with "The specified item could not be found in the
        // keychain" — even though find-identity below finds it in `kc`.
        // (Locally it works only because the login keychain also holds the
        // cert.) Prepend kc to the user search list; restore it in finally.
        prevSearch = execFileSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' })
            .split('\n').map(s => s.trim().replace(/(^")|("$)/g, '')).filter(Boolean)
        sec(['list-keychains', '-d', 'user', '-s', kc, ...prevSearch])

        const ids = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning', kc], { encoding: 'utf8' })
        const line = ids.split('\n').find(l => /Developer ID Application/.test(l))
        const hash = line && (line.match(/\b([0-9A-Fa-f]{40})\b/) || [])[1]
        if (!hash) throw new Error('signNotarizeStapleDmg: no Developer ID Application identity found in CSC_LINK')

        for (const dmg of dmgs) {
            const dmgPath = path.join(distDir, dmg)
            console.log(`  • signing dmg ${dmg}`)
            execFileSync('codesign', ['--force', '--keychain', kc, '--sign', hash, '--timestamp', dmgPath], { stdio: 'inherit' })
            console.log(`  • notarizing dmg ${dmg} (submitting to Apple — this waits)`)
            execFileSync('xcrun', ['notarytool', 'submit', dmgPath,
                '--apple-id', APPLE_ID, '--password', APPLE_APP_SPECIFIC_PASSWORD, '--team-id', APPLE_TEAM_ID, '--wait'],
            { stdio: 'inherit' })
            console.log(`  • stapling dmg ${dmg}`)
            execFileSync('xcrun', ['stapler', 'staple', dmgPath], { stdio: 'inherit' })
            // Assert the wrapper is genuinely signed + notarized + stapled, so a
            // silent no-op above can't let an unverifiable dmg into a release.
            // spctl reads the stapled ticket (offline-valid); both fail closed.
            console.log(`  • verifying Gatekeeper acceptance of ${dmg}`)
            execFileSync('codesign', ['--verify', '--strict', '--verbose=2', dmgPath], { stdio: 'inherit' })
            execFileSync('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', dmgPath], { stdio: 'inherit' })
        }
    } finally {
        if (prevSearch) { try { sec(['list-keychains', '-d', 'user', '-s', ...prevSearch]) } catch { /* best-effort */ } }
        try { sec(['delete-keychain', kc]) } catch { /* best-effort */ }
        if (tmpP12) { try { fs.rmSync(tmpP12, { force: true }) } catch { /* best-effort */ } }
    }
}

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
