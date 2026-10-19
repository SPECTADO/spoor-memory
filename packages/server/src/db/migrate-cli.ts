// `pnpm db:migrate`: run the startup migration once against DATABASE_URL (+ DATABASE_MIGRATE_URL).
import { loadConfig } from '../config.js'
import { runMigrations } from './migrate.js'

const cfg = loadConfig()
await runMigrations({
  databaseUrl: cfg.DATABASE_URL,
  migrateUrl: cfg.DATABASE_MIGRATE_URL,
  migrationsDir: cfg.SPOOR_MIGRATIONS_DIR,
  log: (m) => console.log(m),
})
