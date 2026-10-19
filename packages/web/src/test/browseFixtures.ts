import type { ItemSummary } from '../api/types'

export function summary(over: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 'id-1',
    handle: 'm1',
    project: 'acme',
    space: 'memories',
    number: 1,
    adr_number: null,
    slug: 'a-memory',
    title: 'A memory',
    type: 'fact',
    status: 'active',
    lifecycle: 'active',
    confidence: 'medium',
    tags: [],
    anchors: [],
    pinned: false,
    revision: 1,
    provenance: 'human',
    decided_on: null,
    source_path: null,
    push_conflict_at: null,
    last_verified_at: '2026-10-18T10:00:00Z',
    last_used_at: null,
    expires_at: null,
    stale_since: null,
    archived_at: null,
    archive_reason: null,
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-18T10:00:00Z',
    updated_by: 'ann@example.com',
    client_name: null,
    ...over,
  }
}

export function projectFixture(slug: string, role: 'viewer' | 'editor' | 'admin') {
  return {
    id: `p-${slug}`,
    slug,
    name: slug === '_shared' ? 'Shared' : 'Acme',
    description: 'Main app',
    kind: slug === '_shared' ? 'shared' : 'project',
    settings: {
      cleanup: { stale_days: 90, archive_days: 30, observation_days: 14 },
      digest: { default_budget: 1500, decision_window_days: 30 },
      dedupe: { threshold: 0.9 },
      embedding: { provider: 'local' },
    },
    role,
    embedding: { model: 'e5', target: null, remaining: 0 },
    created_at: '2026-10-01T00:00:00Z',
  }
}
