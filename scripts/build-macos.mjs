#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { build as builder } from 'electron-builder'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import * as vars from './vars.mjs'

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
            if (!adHocSign) return
            if (context.electronPlatformName !== 'darwin') return
            const appPath = path.join(
                context.appOutDir,
                `${context.packager.appInfo.productFilename}.app`,
            )
            console.log(`  • ad-hoc signing  appPath=${appPath}`)
            execFileSync(
                'codesign',
                ['--force', '--deep', '--sign', '-', appPath],
                { stdio: 'inherit' },
            )
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
