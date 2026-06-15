import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export const REPO = path.resolve(__dirname, '..')
const HOOKS = path.join(os.homedir(), '.glanceterm', 'hooks')
const electronPath = require(path.join(REPO, 'node_modules/electron')) as string
const DEV_CFG = path.join(os.homedir(), 'Library/Application Support/GlanceTerm-dev/config.yaml')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export interface AppHandle { app: ElectronApplication; page: Page; userData: string }

/** Launch the dev app with a fresh user-data dir (no tab recovery). Seeds a
 *  config that disables the welcome tab so a terminal can be opened directly. */
export async function launchApp (): Promise<AppHandle> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-e2e-ud-'))
  const cfg = fs.existsSync(DEV_CFG)
    ? fs.readFileSync(DEV_CFG, 'utf8')
    : 'version: 3\nenableWelcomeTab: false\nrecoverTabs: false\nprofiles: []\n'
  fs.writeFileSync(path.join(userData, 'config.yaml'), cfg)
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(REPO, 'app'), '-d', `--user-data-dir=${userData}`],
    cwd: REPO,
    env: { ...process.env, TABBY_PLUGINS: path.join(REPO, 'tabby-plugin-ai-sidebar'), TABBY_DEV: '1', GLANCETERM_E2E: '1' },
    timeout: 60_000,
  })
  const page = await app.firstWindow()
  await page.waitForSelector('ai-sidebar', { timeout: 30_000 })
  return { app, page, userData }
}

/** True only when the FRESH under-test plugin is the one running (the E2E seam
 *  exists). False ⇒ a stale shadowing copy loaded (e.g. an installed
 *  GlanceTerm.app's bundled plugin) ⇒ caller should skip. */
export async function freshPluginLoaded (page: Page): Promise<boolean> {
  for (let i = 0; i < 16; i++) {
    if (await page.evaluate(() => typeof (globalThis as any).__glanceTermE2E !== 'undefined')) return true
    await sleep(500)
  }
  return false
}

/** Open a terminal tab via the tab-bar "+" and return its GLANCETERM_TAB_ID. */
export async function openTerminalTab (page: Page): Promise<string> {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /fa-plus/.test(x.querySelector('i,svg')?.getAttribute('class') || ''))
    ;(b as HTMLElement | undefined)?.click()
  })
  for (let i = 0; i < 30; i++) {
    const live = await page.evaluate(() => (globalThis as any).__glanceTermE2E?.liveTabs() ?? [])
    if (live.length) return live[0].tabId
    await sleep(500)
  }
  throw new Error('no terminal tab appeared after clicking +')
}

/** Append one synthetic hook event for a tab (drives the sidebar). */
export function writeHook (tabId: string, cwd: string, event: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(HOOKS, { recursive: true })
  const line = JSON.stringify({
    tab_id: tabId, agent: 'claude', event, matcher: '', tool_name: '', session_id: 'e2e', cwd,
    transcript_path: '', ts: Math.floor(Date.now() / 1000), bg: 0, interrupted: 0, agent_id: '',
    agent_type: '', spawn_agent_id: '', monitor_task_id: '', monitor_timeout_ms: 0, stop_task_id: '',
    model: '', auto_approved: 0, source: '', ...extra,
  }) + '\n'
  fs.appendFileSync(path.join(HOOKS, `${tabId}.log`), line)
}

/** Poll the row's data-status until it equals `want` (or throw). */
export async function expectStatus (page: Page, tabId: string, want: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  let last: string | null = null
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate((id) => document.querySelector(`ai-sidebar .row[data-tab-id="${id}"]`)?.getAttribute('data-status') ?? null, tabId)
    if (last === want) return
    await sleep(250)
  }
  throw new Error(`row ${tabId}: expected data-status=${want}, last saw ${last}`)
}

export async function rowStatus (page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((id) => document.querySelector(`ai-sidebar .row[data-tab-id="${id}"]`)?.getAttribute('data-status') ?? null, tabId)
}

export async function cleanup (h: AppHandle): Promise<void> {
  await h.app.close().catch(() => {})
  fs.rmSync(h.userData, { recursive: true, force: true })
}
