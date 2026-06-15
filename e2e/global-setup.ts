import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const REPO = path.resolve(__dirname, '..')

// Build the three dists dev.sh builds (so the run is self-contained), then sync
// the freshly-built ai-sidebar into the repo's builtin-plugins/ — the location a
// dev-mode launch prefers on a clean machine / CI. (On a dev box with
// GlanceTerm.app installed, the installed bundle still shadows this; the spec
// self-skips — see README + helpers.freshPluginLoaded.)
export default function globalSetup (): void {
  const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd, stdio: 'inherit' })
  sh(path.join(REPO, 'tabby-plugin-ai-sidebar'), 'npm run build')
  // mobile-bridge + tabby-terminal: webpack run from the package dir (mirrors dev.sh)
  for (const pkg of ['tabby-plugin-mobile-bridge', 'tabby-terminal']) {
    try { sh(path.join(REPO, pkg), '../node_modules/.bin/webpack') } catch { /* dist already present */ }
  }
  const builtin = path.join(REPO, 'builtin-plugins', 'tabby-plugin-ai-sidebar', 'dist')
  if (fs.existsSync(builtin)) {
    fs.cpSync(path.join(REPO, 'tabby-plugin-ai-sidebar', 'dist'), builtin, { recursive: true })
  }
}
