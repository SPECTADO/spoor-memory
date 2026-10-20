import { defineConfig } from 'vitest/config'

// testTimeout as in packages/server: the file-heavy tests (150-file adr import, setup) took 0.5 s to 5.2 s on
// GitHub runners for the same code, and the 5 s default failed a release; tests that check timing assert it themselves.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], testTimeout: 30_000 } })
