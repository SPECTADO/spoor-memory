// Copies src/db/migrations to ./drizzle, the folder the Dockerfile ships (SPOOR_MIGRATIONS_DIR=/app/drizzle).
import { cpSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(join(root, 'drizzle'), { recursive: true, force: true })
cpSync(join(root, 'src/db/migrations'), join(root, 'drizzle'), { recursive: true })
