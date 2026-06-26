import fs from 'fs'
import yaml from 'js-yaml'

// Merge the per-arch electron-builder `latest-mac.yml` files (one from the
// arm64 build, one from the x64 build) into a SINGLE feed.
//
// Why: electron-updater's GitHub provider only ever requests `latest-mac.yml`
// for a stable release — it ignores any baked per-arch `channel`. Its
// MacUpdater then picks the right artifact by testing whether the file url
// contains the substring "arm64" (arm64 Macs take the arm64 file; Intel Macs
// take the non-arm64 one). So we need ONE `latest-mac.yml` whose `files` lists
// every arch's zip (+ dmg). The two arch builds run in separate matrix jobs and
// each emit their own `latest-mac.yml`; this script unions their `files`.
//
// Usage: node scripts/merge-mac-feed.mjs <latest-mac.yml> <latest-mac.yml> [...]
//        (writes the merged YAML to stdout)

const inputs = process.argv.slice(2)
if (inputs.length < 2) {
    console.error('usage: node merge-mac-feed.mjs <latest-mac.yml> <latest-mac.yml> [...]')
    process.exit(1)
}

const docs = inputs.map(p => {
    const doc = yaml.load(fs.readFileSync(p, 'utf8'))
    if (!doc || !doc.version || !Array.isArray(doc.files)) {
        console.error(`error: ${p} is not a valid latest-mac.yml (missing version/files)`)
        process.exit(1)
    }
    return doc
})

// All inputs MUST describe the same release version — otherwise the matrix
// built mismatched arches and shipping a blended feed would hand users the
// wrong version. Fail loudly rather than publish an inconsistent feed.
const version = docs[0].version
for (let i = 1; i < docs.length; i++) {
    if (docs[i].version !== version) {
        console.error(`error: version mismatch — ${inputs[0]} is ${version} but ${inputs[i]} is ${docs[i].version}`)
        process.exit(1)
    }
}

// Union files by url, preserving input order (arm64 first). The top-level
// path/sha512 stay as the first doc's: MacUpdater filters `files` by arch and
// does not fall back to the top-level path, so it only matters to non-arch-aware
// consumers, for which a deterministic default is fine.
const seen = new Set()
const files = []
for (const doc of docs) {
    for (const f of doc.files) {
        if (seen.has(f.url)) {
            continue
        }
        seen.add(f.url)
        files.push(f)
    }
}

// Sanity: the merged feed must contain at least one arm64 and one non-arm64
// file, or one arch of users silently has no update. Warn (don't fail — a
// deliberate single-arch release is valid) so a botched matrix is visible.
const hasArm64 = files.some(f => f.url.includes('arm64'))
const hasIntel = files.some(f => !f.url.includes('arm64'))
if (!hasArm64 || !hasIntel) {
    console.error(`warning: merged feed missing an arch (arm64=${hasArm64} intel=${hasIntel}) — files: ${files.map(f => f.url).join(', ')}`)
}

const merged = { ...docs[0], files }
process.stdout.write(yaml.dump(merged, { lineWidth: -1 }))
