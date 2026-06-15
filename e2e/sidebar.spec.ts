import { test, expect } from '@playwright/test'
import { launchApp, freshPluginLoaded, openTerminalTab, writeHook, expectStatus, cleanup, AppHandle } from './helpers'

// Drives the real GlanceTerm sidebar via synthetic hook-log files and asserts
// the row [data-tab-id][data-status]. Self-skips when a stale shadowing plugin
// is loaded (e.g. an installed GlanceTerm.app bundle wins over the repo build —
// see README.md).
test.describe.configure({ mode: 'serial' })

let h: AppHandle
let tabId: string
let cwd: string
let shadowed = false

test.beforeAll(async () => {
  h = await launchApp()
  if (!(await freshPluginLoaded(h.page))) { shadowed = true; return }
  tabId = await openTerminalTab(h.page)
  cwd = (await h.page.evaluate((id) => (globalThis as any).__glanceTermE2E.liveTabs().find((t: any) => t.tabId === id)?.cwd, tabId)) || '/tmp'
})

test.afterAll(async () => { if (h) await cleanup(h) })

test.beforeEach(() => { test.skip(shadowed, 'stale shadowing plugin loaded (installed GlanceTerm.app) — see README.md') })

test('PreToolUse → row shows working', async () => {
  writeHook(tabId, cwd, 'PreToolUse', { tool_name: 'Bash' })
  await expectStatus(h.page, tabId, 'working')
})

test('PermissionRequest → needs_permission', async () => {
  writeHook(tabId, cwd, 'PermissionRequest', { tool_name: 'Bash' })
  await expectStatus(h.page, tabId, 'needs_permission')
})

test('Stop → idle (after the idle-gate hold)', async () => {
  writeHook(tabId, cwd, 'Stop')
  await expectStatus(h.page, tabId, 'idle', 10_000)
})

test('live subagent holds the row at working (no idle flap), idle when it stops', async () => {
  writeHook(tabId, cwd, 'Stop')
  await expectStatus(h.page, tabId, 'idle', 10_000)
  // A subagent spawns while the main agent has already Stopped. Real logs show
  // the main Stop landing in the same second as the subagent's next event, so
  // leaving the row idle makes it flap working↔idle. With a leak-free count, a
  // live subagent means real work → the row must show WORKING and hold it.
  writeHook(tabId, cwd, 'PostToolUse', { tool_name: 'Agent', spawn_agent_id: 'aE2E1' })
  await expectStatus(h.page, tabId, 'working', 10_000)
  // the subagent also surfaces as a count badge in the row
  const hasAgentBadge = await h.page.evaluate((id) => /agent/i.test(document.querySelector(`ai-sidebar .row[data-tab-id="${id}"]`)?.textContent || ''), tabId)
  expect(hasAgentBadge).toBe(true)
  // once the subagent stops, the count drops to 0 and the row returns to idle
  writeHook(tabId, cwd, 'SubagentStop', { agent_id: 'aE2E1' })
  await expectStatus(h.page, tabId, 'idle', 10_000)
})

test('clicking a row activates it', async () => {
  writeHook(tabId, cwd, 'PreToolUse', { tool_name: 'Bash' })
  await expectStatus(h.page, tabId, 'working')
  await h.page.click(`ai-sidebar .row[data-tab-id="${tabId}"]`)
  await expect(h.page.locator(`ai-sidebar .row[data-tab-id="${tabId}"]`)).toHaveClass(/active/, { timeout: 5000 })
})
