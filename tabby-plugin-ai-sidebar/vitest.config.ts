import { defineConfig } from 'vitest/config'

/**
 * Vitest config for the plugin's unit tests.
 *
 * Scope: pure functions only. We don't construct Angular services in tests
 * — the DI graph reaches deep into Tabby internals and the bundle isn't
 * test-friendly. Instead we extract the testable logic into exported pure
 * functions (e.g. `toRunnableCommand`, `isShellSafe`, `reduceSubagentQueue`)
 * and unit-test those. Whole-component tests would need an Angular TestBed
 * setup that's out of scope for this first pass — see engineering review.
 *
 * Layout: `src/__tests__/<topic>.test.ts` next to the code under test.
 * esbuild handles the TS transpile; no separate tsconfig wiring needed.
 */
export default defineConfig({
    test: {
        include: ['src/__tests__/**/*.test.ts'],
        environment: 'node',
        // Keep test output terse — for now we just want fast pass/fail in CI
        // and a clear diff on regression. Add `verbose` later if a failure
        // is hard to debug from the default reporter.
        reporters: 'default',
    },
})
