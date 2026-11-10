import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { meFixture, mockApi, renderApp } from '../../test/utils'
import { bytes } from './StatusPage'

const status = {
  instance: {
    version: '0.6.1',
    public_url: 'https://spoor.example',
    started_at: '2026-11-10T08:00:00Z',
    uptime_s: 3_700,
    node: 'v24.1.0',
    platform: 'linux/x64',
    hostname: 'spoor-app',
    jobs_enabled: true,
  },
  embedding: {
    default: {
      name: 'local',
      model: 'Xenova/multilingual-e5-small',
      variant: 'q8',
      dims: 384,
      tag: 'local:Xenova/multilingual-e5-small@q8/384',
      max_input_tokens: 512,
    },
    providers: [
      {
        name: 'local',
        model: 'Xenova/multilingual-e5-small',
        dims: 384,
        tag: 'local:Xenova/multilingual-e5-small@q8/384',
        remote: false,
      },
    ],
    local_threads: 2,
    chunks: [{ model: 'local:Xenova/multilingual-e5-small@q8/384', dims: 384, chunks: 1234, pending: 3 }],
    projects_by_model: [{ model: 'local:Xenova/multilingual-e5-small@q8/384', projects: 4, reembedding: 0 }],
  },
  records: {
    projects: 3,
    users: 5,
    users_active: 4,
    memberships: 9,
    tokens_active: 6,
    web_sessions: 2,
    items: { memories: { active: 40, stale: 2 }, decisions: { active: 7 } },
    items_total: 49,
    revisions: 80,
    edges: 12,
    chunks: 1234,
    chunks_pending: 3,
    audit_rows: 300,
    request_log_rows: 900,
    job_runs: 50,
  },
  database: {
    version: '17.6',
    name: 'spoor',
    size_bytes: 25 * 1024 * 1024,
    connections: 7,
    extensions: [{ name: 'vector', version: '0.8.1' }],
    tables: [{ name: 'chunks', bytes: 10 * 1024 * 1024, rows_estimate: 1234 }],
    pool: { max: 10, total: 3, idle: 2, waiting: 0 },
  },
  runtime: {
    rss_bytes: 300 * 1024 * 1024,
    heap_used_bytes: 80 * 1024 * 1024,
    heap_total_bytes: 120 * 1024 * 1024,
    external_bytes: 5 * 1024 * 1024,
    load_avg: [0.5, 0.4, 0.3],
    cpus: 4,
    system_memory_bytes: 8 * 1024 ** 3,
    system_free_bytes: 2 * 1024 ** 3,
    mcp_sessions: 1,
  },
}

describe('AdminStatusPage', () => {
  it('shows the embedding model, record counts and database size', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture({ is_admin: true })],
      'GET /api/v1/status': [200, status],
    })
    renderApp('/admin/status')
    const embedding = await screen.findByRole('region', { name: 'Embedding' })
    expect(within(embedding).getByText('Xenova/multilingual-e5-small')).toBeInTheDocument()
    expect(within(embedding).getByText('3 chunks')).toBeInTheDocument()
    const db = screen.getByRole('region', { name: 'Database' })
    expect(within(db).getByText('25 MB')).toBeInTheDocument()
    const records = screen.getByRole('region', { name: 'Records' })
    expect(within(records).getByText('4 active of 5')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Table sizes' })).toHaveTextContent('10 MB')
  })

  it('formats byte counts', () => {
    expect(bytes(512)).toBe('512 B')
    expect(bytes(1536)).toBe('1.5 KB')
    expect(bytes(null)).toBe('—')
  })
})
