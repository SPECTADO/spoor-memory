// The heavy-operation mark another container reads from pg_stat_activity: only validated values round-trip.
import { describe, expect, it } from 'vitest'
import { parseRunningMark } from './lock.js'

const mark = (json: string) => `SELECT pg_try_advisory_lock(38038, 1) AS ok /* spoor-heavy ${json} */`

describe('parseRunningMark', () => {
  it('reads a holder mark', () => {
    const info = {
      operation: 'backup',
      backup_id: '20261126T030000Z-auto',
      kind: 'auto',
      started_at: '2026-11-26T03:00:00.000Z',
    }
    expect(parseRunningMark(mark(JSON.stringify(info)))).toEqual(info)
  })

  it.each([
    ['no mark', 'SELECT 1'],
    ['bad json', mark('{nope}')],
    [
      'unknown operation',
      mark('{"operation":"drop","backup_id":"","kind":null,"started_at":"2026-11-26T03:00:00Z"}'),
    ],
    [
      'traversal id',
      mark('{"operation":"backup","backup_id":"../x","kind":null,"started_at":"2026-11-26T03:00:00Z"}'),
    ],
    [
      'bad kind',
      mark('{"operation":"backup","backup_id":"","kind":"evil","started_at":"2026-11-26T03:00:00Z"}'),
    ],
    ['bad time', mark('{"operation":"backup","backup_id":"","kind":null,"started_at":"<script>"}')],
  ])('%s -> null', (_label, query) => {
    expect(parseRunningMark(query)).toBeNull()
  })
})
