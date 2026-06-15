import { test, expect } from '@playwright/test'
import { launchApp, freshPluginLoaded, openTerminalTab, writeHook, expectStatus, rowStatus, cleanup, AppHandle } from './helpers'

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

test('idle main + live background subagent → row stays idle, badge shows the agent', async () => {
  writeHook(tabId, cwd, 'Stop')
  await expectStatus(h.page, tabId, 'idle', 10_000)
  // a backgrounded subagent spawns; main agent is idle (already Stopped)
  writeHook(tabId, cwd, 'PostToolUse', { tool_name: 'Agent', spawn_agent_id: 'aE2E1' })
  // semantic: status must NOT flip to working
  await new Promise(r => setTimeout(r, 2500))
  expect(await rowStatus(h.page, tabId)).toBe('idle')
  // and the subagent surfaces as a count badge in the row
  const hasAgentBadge = await h.page.evaluate((id) => /agent/i.test(document.querySelector(`ai-sidebar .row[data-tab-id="${id}"]`)?.textContent || ''), tabId)
  expect(hasAgentBadge).toBe(true)
  // SubagentStop clears it
  writeHook(tabId, cwd, 'SubagentStop', { agent_id: 'aE2E1' })
})

test('clicking a row activates it', async () => {
  writeHook(tabId, cwd, 'PreToolUse', { tool_name: 'Bash' })
  await expectStatus(h.page, tabId, 'working')
  await h.page.click(`ai-sidebar .row[data-tab-id="${tabId}"]`)
  await expect(h.page.locator(`ai-sidebar .row[data-tab-id="${tabId}"]`)).toHaveClass(/active/, { timeout: 5000 })
})
