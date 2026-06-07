import { defineConfig } from 'vitest/config'

/**
 * Vitest config for Layer-3 E2E specs that drive a running `./dev.sh`
 * instance over CDP at port 9222.
 *
 * Separated from the plain unit config (`vitest.config.ts`) because:
 *   - These specs need a live dev instance — running them with `npm test`
 *     would fail with a connection-refused error on every CI machine
 *     that doesn't have one up.
 *   - The wait-for loops cap at 2 s each; tests can chain several
 *     conditions, so the per-test timeout needs to be higher than
 *     the unit default.
 *   - Concurrency = 1 keeps tests from racing on the single dev
 *     instance's UI state (one test opens the modal while another
 *     asserts it's closed).
 *
 * Run with: `npm run test:e2e`
 * Pre-req:  `./dev.sh` running (in another shell)
 */
export default defineConfig({
    test: {
        include: ['src/__e2e__/**/*.test.ts'],
        environment: 'node',
        testTimeout: 15_000,
        hookTimeout: 15_000,
        // One-at-a-time: shared dev instance, shared DOM state.
        sequence: { concurrent: false },
        pool: 'forks',
        poolOptions: { forks: { singleFork: true } },
        reporters: 'default',
    },
})
