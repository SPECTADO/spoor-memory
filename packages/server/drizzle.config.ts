import { defineConfig } from 'drizzle-kit'

// `drizzle-kit generate` only diffs src/db/schema.ts into SQL files; it never connects.
// Hand-written migrations: `drizzle-kit generate --custom --name <name>`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL ?? '' },
})
