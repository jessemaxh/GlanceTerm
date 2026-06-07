import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { E2EHarness } from './harness'

/**
 * First Layer-3 smoke test. The goals here are deliberately tight:
 *
 *   1. Prove the CDP harness can attach to the running dev instance.
 *   2. Prove we can drive UI (click the gear) and observe DOM (the
 *      modal element appears).
 *   3. Prove the keyboard path (Escape dismisses the modal).
 *
 * Anything fancier — visual diff, multi-tab orchestration, hook
 * injection — comes in follow-up specs once these primitives are
 * stable.
 *
 * Pre-req: run `./dev.sh` from the repo root before this suite. The
 * harness throws an actionable error if it can't reach port 9222.
 */
describe('settings dialog (E2E)', () => {
    const harness = new E2EHarness()

    beforeAll(async () => {
        await harness.connect()
    })

    afterAll(async () => {
        await harness.disconnect()
    })

    it('gear button opens the settings modal', async () => {
        // Make sure no modal is already up from a previous run.
        const initial = await harness.isVisible('.gt-settings-modal')
        if (initial) {
            await harness.pressKey('Escape')
            await harness.waitFor(
                async () => !(await harness.isVisible('.gt-settings-modal')),
                { message: 'modal should have dismissed before the test' },
            )
        }

        await harness.click('.action-btn.settings-btn')

        // ng-bootstrap mounts the modal into a portal at the end of
        // <body>, so the selector still works at document scope.
        await harness.waitFor(
            () => harness.isVisible('.gt-settings-modal'),
            { message: 'modal didn\'t appear after gear click' },
        )

        // Sanity-check the modal renders our three settings; if the
        // template ever drifts (a row gets removed, a class gets
        // renamed), this assertion catches it.
        const titles = await harness.evaluate<string[]>(`
            Array.from(document.querySelectorAll('.gt-settings-modal .gt-setting-title'))
                .map(el => el.textContent?.trim() ?? '')
        `)
        expect(titles).toEqual([
            'Chime on agent done',
            'Auto-approve permission prompts',
            'Hide tabs without an AI agent',
        ])
    })

    it('Escape dismisses the settings modal', async () => {
        // Test ordering matters here: previous test left the modal
        // open. If a future re-order puts this first, open it first.
        if (!(await harness.isVisible('.gt-settings-modal'))) {
            await harness.click('.action-btn.settings-btn')
            await harness.waitFor(() => harness.isVisible('.gt-settings-modal'))
        }

        await harness.pressKey('Escape')
        await harness.waitFor(
            async () => !(await harness.isVisible('.gt-settings-modal')),
            { message: 'modal stayed open after Escape' },
        )
    })
})
