/**
 * Per integration test file: a clean database before every test (empty tables, and only the migrations'
 * HNSW index on chunks), the pool closed at the end. The indexes are reset after each test too, so a run
 * leaves the schema as the migrations made it for the next run's global setup to read.
 */
import { afterAll, afterEach, beforeEach } from 'vitest'
import { closeTestDb, resetHnswIndexes, truncateAll } from './db.js'

beforeEach(async () => {
  await truncateAll()
  await resetHnswIndexes()
})

afterEach(async () => {
  await resetHnswIndexes()
})

afterAll(async () => {
  await closeTestDb()
})
