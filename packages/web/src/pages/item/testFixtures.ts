/** Test fixtures for the item pages (imported by *.test.tsx only). */
import type { ItemJson, ProjectJson } from '../../api/types'
import { meFixture, type Reply } from '../../test/utils'

export function itemFixture(over: Partial<ItemJson> = {}): ItemJson {
  return {
    id: 'id-42',
    handle: 'm42',
    project: 'acme',
    space: 'memories',
    number: 42,
    adr_number: null,
    slug: 'session-store',
    title: 'Sessions live in Redis',
    type: 'fact',
    status: 'active',
    lifecycle: 'active',
    confidence: 'medium',
    tags: ['auth'],
    anchors: ['src/auth/'],
    pinned: false,
    revision: 3,
    provenance: 'human',
    decided_on: null,
    source_path: null,
    push_conflict_at: null,
    last_verified_at: '2026-10-01T00:00:00Z',
    last_used_at: null,
    expires_at: null,
    stale_since: null,
    archived_at: null,
    archive_reason: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    updated_by: 'ann@example.com',
    client_name: null,
    body: 'Sessions are stored in Redis.\n\nSee [[m7]].\n',
    extra: {},
    created_by: { id: 'u1', label: 'ann@example.com' },
    superseded_by: null,
    ...over,
  }
}

/** `can_edit_library` defaults to true for admins only; pass it to model a viewer/editor with the flag. */
export function projectFixture(
  role: ProjectJson['role'],
  slug = 'acme',
  opts: { can_edit_library?: boolean } = {},
): ProjectJson {
  return {
    id: 'p1',
    slug,
    name: 'Acme',
    description: '',
    kind: slug === '_shared' ? 'shared' : 'project',
    settings: {
      cleanup: { stale_days: 30, archive_days: 90, observation_days: 7 },
      digest: { default_budget: 1500, decision_window_days: 30 },
      dedupe: { threshold: 0.92 },
      embedding: { provider: 'local' },
      memory: { exclusive: true },
    },
    role,
    can_edit_library: opts.can_edit_library ?? role === 'admin',
    embedding: { model: 'x', target: null, remaining: 0 },
    created_at: '2026-10-01T00:00:00Z',
  }
}

/** The routes every project page needs: me, project list (switcher), the project with `role`. */
export function baseRoutes(
  role: ProjectJson['role'],
  slug = 'acme',
  opts: { can_edit_library?: boolean } = {},
): Record<string, Reply | Reply[]> {
  return {
    'GET /api/v1/me': [200, meFixture()],
    'GET /api/v1/projects': [200, { items: [] }],
    [`GET /api/v1/projects/${slug}`]: [200, projectFixture(role, slug, opts)],
    [`GET /api/v1/projects/${slug}/review`]: [
      200,
      { counts: { stale: 0, archived: 0, expiring: 0, conflicts: 0, push_conflicts: 0 } },
    ],
  }
}
