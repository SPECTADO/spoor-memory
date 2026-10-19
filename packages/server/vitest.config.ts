import { defineConfig } from 'vitest/config'
import { testDatabaseUrl } from './test/db-url.js'

// Two projects (packages/server/README.md "Tests"):
// - unit: pure logic, no database, files run in parallel.            `pnpm test:unit`
// - integration: *.integration.test.ts against the real Postgres test database. test/global-setup.ts fails
//   fast when it is unreachable and runs the migrations once; test/setup.ts truncates every table before
//   each test, so files run one at a time.                            `pnpm test:integration`
// - e2e: test/e2e/*.e2e.test.ts boots the real server on a random port against its own database
//   (`<test db>_e2e_test`, dropped and created by test/e2e/global-setup.ts) and drives the built CLI
//   (packages/cli/dist, so `pnpm build` first).                     `pnpm test:e2e`
// `pnpm test` runs all three.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          setupFiles: ['test/setup.ts'],
          fileParallelism: false,
          env: { DATABASE_URL: testDatabaseUrl(), NODE_ENV: 'test' },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e.test.ts'],
          globalSetup: ['test/e2e/global-setup.ts'],
          fileParallelism: false,
          env: { DATABASE_URL: testDatabaseUrl(), NODE_ENV: 'test' },
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
