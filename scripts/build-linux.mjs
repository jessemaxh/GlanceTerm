#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { build as builder } from 'electron-builder'
import { execFileSync } from 'node:child_process'
import * as vars from './vars.mjs'

// Ensure builtin-plugins/ is in sync with current source.
// See build-macos.mjs for the rationale — a stale builtin-plugins/ snapshot
// silently ships missing/old features inside the package. Override with
// SKIP_PREPACKAGE=1 when iterating on the shell only.
if (!process.env.SKIP_PREPACKAGE) {
    execFileSync('npm', ['run', 'build'],                    { stdio: 'inherit' })
    execFileSync('node', ['scripts/prepackage-plugins.mjs'], { stdio: 'inherit' })
}

const isTag = (process.env.GITHUB_REF || '').startsWith('refs/tags/')

process.env.ARCH = (process.env.ARCH || process.arch) === 'arm' ? 'armv7l' : process.env.ARCH || process.arch

builder({
    dir: true,
    linux: ['deb', 'tar.gz', 'rpm', 'pacman', 'appimage'],
    armv7l: process.env.ARCH === 'armv7l',
    arm64: process.env.ARCH === 'arm64',
    config: {
        npmRebuild: false,
        extraMetadata: {
            version: vars.version,
        },
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
