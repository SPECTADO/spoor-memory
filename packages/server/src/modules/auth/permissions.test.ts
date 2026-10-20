// The permission matrix of auth-and-security.md section 7, row by row, for every kind of caller on every
// surface. A row lists who is allowed; everyone else must be refused.
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/errors.js'
import { type Action, assertCan, can, type Principal, type Target } from './permissions.js'

// web callers (section 7 legend): IA instance admin (no membership), PA / E / V members, LE / LV an editor
// and a viewer holding the library flag, SE shared editor without a membership, U any other logged-in user
const WEB = {
  IA: { surface: 'web', isAdmin: true, sharedEditor: false, membership: null, libraryEditor: false },
  PA: { surface: 'web', isAdmin: false, sharedEditor: false, membership: 'admin', libraryEditor: false },
  E: { surface: 'web', isAdmin: false, sharedEditor: false, membership: 'editor', libraryEditor: false },
  V: { surface: 'web', isAdmin: false, sharedEditor: false, membership: 'viewer', libraryEditor: false },
  LE: { surface: 'web', isAdmin: false, sharedEditor: false, membership: 'editor', libraryEditor: true },
  LV: { surface: 'web', isAdmin: false, sharedEditor: false, membership: 'viewer', libraryEditor: true },
  SE: { surface: 'web', isAdmin: false, sharedEditor: true, membership: null, libraryEditor: false },
  U: { surface: 'web', isAdmin: false, sharedEditor: false, membership: null, libraryEditor: false },
} as const satisfies Record<string, Principal>
type WebWho = keyof typeof WEB

// bearer callers by effective role: UT user token (admin / editor / viewer, the latter also covers a
// read-only cap), ST service token (editor / viewer; never admin)
const TOKENS = ['UT:admin', 'UT:editor', 'UT:viewer', 'ST:editor', 'ST:viewer'] as const
type TokenWho = (typeof TOKENS)[number]
const bearer = (surface: 'rest' | 'mcp', who: TokenWho): Principal => ({
  surface,
  role: who.split(':')[1] as 'admin' | 'editor' | 'viewer',
})

const ALL_WEB = Object.keys(WEB) as WebWho[]
const MEMBERS: WebWho[] = ['IA', 'PA', 'E', 'V', 'LE', 'LV']
const ANY_TOKEN: TokenWho[] = [...TOKENS]
const WRITE_TOKENS: TokenWho[] = ['UT:admin', 'UT:editor', 'ST:editor']

interface Row {
  row: string
  action: Action
  target?: Target
  web: WebWho[]
  rest: TokenWho[]
  mcp: TokenWho[]
}

const MATRIX: Row[] = [
  {
    row: 'read project items, search, history, backlinks, audit log',
    action: 'project.read',
    web: MEMBERS,
    rest: ANY_TOKEN,
    mcp: ANY_TOKEN,
  },
  {
    row: 'create / edit project items, pin, verify, archive, restore, relate',
    action: 'item.write',
    web: ['IA', 'PA', 'E', 'LE'],
    rest: WRITE_TOKENS,
    mcp: WRITE_TOKENS,
  },
  {
    row: 'write library (create, edit, archive, restore, relate from a library page)',
    action: 'library.write',
    web: ['IA', 'PA', 'LE', 'LV'],
    rest: [],
    mcp: [],
  },
  { row: 'hard-delete project item', action: 'item.delete', web: ['IA', 'PA'], rest: [], mcp: [] },
  { row: 'review-queue actions', action: 'review.act', web: ['IA', 'PA', 'E', 'LE'], rest: [], mcp: [] },
  {
    row: 'read shared space',
    action: 'project.read',
    target: { shared: true },
    web: ALL_WEB,
    rest: ANY_TOKEN,
    mcp: ANY_TOKEN,
  },
  {
    row: 'write shared space (create, edit, pin, archive, restore, relate)',
    action: 'item.write',
    target: { shared: true },
    web: ['IA', 'SE'],
    rest: [],
    mcp: [],
  },
  {
    row: 'write the shared library',
    action: 'library.write',
    target: { shared: true },
    web: ['IA', 'SE'],
    rest: [],
    mcp: [],
  },
  {
    row: 'hard-delete shared item',
    action: 'item.delete',
    target: { shared: true },
    web: ['IA', 'SE'],
    rest: [],
    mcp: [],
  },
  { row: 'create own user token', action: 'token.create_own', web: MEMBERS, rest: [], mcp: [] },
  {
    row: 'look up, approve or deny a device code for a project',
    action: 'device.approve',
    web: MEMBERS,
    rest: [],
    mcp: [],
  },
  {
    row: 'revoke own token (owner)',
    action: 'token.revoke',
    target: { ownsToken: true },
    web: MEMBERS,
    rest: [],
    mcp: [],
  },
  {
    row: 'revoke own token (somebody else’s: PA, IA)',
    action: 'token.revoke',
    target: { ownsToken: false },
    web: ['IA', 'PA'],
    rest: [],
    mcp: [],
  },
  {
    row: 'service tokens: create / revoke',
    action: 'service_token.manage',
    web: ['IA', 'PA'],
    rest: [],
    mcp: [],
  },
  {
    row: 'memberships and roles of a project',
    action: 'members.manage',
    web: ['IA', 'PA'],
    rest: [],
    mcp: [],
  },
  { row: 'project settings', action: 'settings.manage', web: ['IA', 'PA'], rest: [], mcp: [] },
  { row: 'export / import project', action: 'project.transfer', web: ['IA', 'PA'], rest: [], mcp: [] },
  { row: 'create project', action: 'project.create', web: ['IA'], rest: [], mcp: [] },
  { row: 'delete project', action: 'project.delete', web: ['IA'], rest: [], mcp: [] },
  { row: 'users, is_admin, shared_editor', action: 'users.manage', web: ['IA'], rest: [], mcp: [] },
  {
    row: 'project invites (non-empty grants, all on own projects)',
    action: 'invite.project',
    web: ['IA', 'PA'],
    rest: [],
    mcp: [],
  },
  { row: 'reset invites, instance-flag invites', action: 'invite.instance', web: ['IA'], rest: [], mcp: [] },
  {
    row: 'export / import shared space',
    action: 'project.transfer',
    target: { shared: true },
    web: ['IA'],
    rest: [],
    mcp: [],
  },
  {
    row: 'job status, re-embed progress (own project)',
    action: 'jobs.read',
    web: ['IA', 'PA'],
    rest: [],
    mcp: [],
  },
  // consequences of section 8 and api.md 4: the shared project has no members, tokens or deletion,
  // and its settings and jobs belong to instance admins
  {
    row: '_shared: settings',
    action: 'settings.manage',
    target: { shared: true },
    web: ['IA'],
    rest: [],
    mcp: [],
  },
  { row: '_shared: jobs', action: 'jobs.read', target: { shared: true }, web: ['IA'], rest: [], mcp: [] },
  {
    row: '_shared: review actions',
    action: 'review.act',
    target: { shared: true },
    web: ['IA', 'SE'],
    rest: [],
    mcp: [],
  },
  { row: '_shared: delete', action: 'project.delete', target: { shared: true }, web: [], rest: [], mcp: [] },
  { row: '_shared: members', action: 'members.manage', target: { shared: true }, web: [], rest: [], mcp: [] },
  {
    row: '_shared: own tokens',
    action: 'token.create_own',
    target: { shared: true },
    web: [],
    rest: [],
    mcp: [],
  },
  {
    row: '_shared: service tokens',
    action: 'service_token.manage',
    target: { shared: true },
    web: [],
    rest: [],
    mcp: [],
  },
  {
    row: '_shared: device codes',
    action: 'device.approve',
    target: { shared: true },
    web: [],
    rest: [],
    mcp: [],
  },
]

describe('permission matrix (auth-and-security.md section 7)', () => {
  const cases = MATRIX.flatMap((r) => [
    ...ALL_WEB.map((who) => ({ r, surface: 'web', who, p: WEB[who] as Principal, ok: r.web.includes(who) })),
    ...TOKENS.map((who) => ({ r, surface: 'rest', who, p: bearer('rest', who), ok: r.rest.includes(who) })),
    ...TOKENS.map((who) => ({ r, surface: 'mcp', who, p: bearer('mcp', who), ok: r.mcp.includes(who) })),
  ])

  it.each(cases)('$r.row · $surface · $who → $ok', ({ r, p, ok }) => {
    expect(can(p, r.action, r.target)).toBe(ok)
  })

  it('covers every action', async () => {
    const { ACTIONS } = await import('./permissions.js')
    expect(new Set(MATRIX.map((r) => r.action))).toEqual(new Set(ACTIONS))
  })

  it('a token without an effective role can do nothing', () => {
    for (const r of MATRIX) expect(can({ surface: 'mcp', role: null }, r.action, r.target)).toBe(false)
  })
})

describe('assertCan error codes', () => {
  const code = (p: Principal, a: Action, t?: Target) => {
    try {
      assertCan(p, a, t)
      return 'ok'
    } catch (e) {
      return (e as ApiError).code
    }
  }

  it('web refusals are 403 forbidden', () => {
    expect(code(WEB.V, 'item.write')).toBe('forbidden')
    expect(code(WEB.U, 'item.write', { shared: true })).toBe('forbidden')
    expect(code(WEB.E, 'item.write')).toBe('ok')
  })

  it('bearer: forbidden_role for a viewer, read_only_space for any shared write', () => {
    expect(code(bearer('rest', 'UT:viewer'), 'item.write')).toBe('forbidden_role')
    expect(code(bearer('rest', 'ST:editor'), 'item.write', { shared: true })).toBe('read_only_space')
    expect(code(bearer('mcp', 'UT:editor'), 'members.manage')).toBe('forbidden_role')
    expect(code(bearer('mcp', 'ST:viewer'), 'project.read', { shared: true })).toBe('ok')
    expect(new ApiError('forbidden_role').status).toBe(403)
  })

  it('bearer: read_only_space for any library write, whatever the role', () => {
    for (const who of TOKENS) {
      expect(code(bearer('rest', who), 'library.write')).toBe('read_only_space')
      expect(code(bearer('mcp', who), 'library.write')).toBe('read_only_space')
      expect(code(bearer('mcp', who), 'library.write', { shared: true })).toBe('read_only_space')
    }
    expect(code({ surface: 'mcp', role: null }, 'library.write')).toBe('read_only_space')
  })

  it('web: the library flag grants library.write only; a flagged viewer still may not write items', () => {
    expect(code(WEB.LV, 'library.write')).toBe('ok')
    expect(code(WEB.LV, 'item.write')).toBe('forbidden')
    expect(code(WEB.LV, 'item.delete')).toBe('forbidden')
    expect(code(WEB.E, 'library.write')).toBe('forbidden')
    expect(code(WEB.LE, 'library.write', { shared: true })).toBe('forbidden')
  })
})

describe('webPrincipal', () => {
  it('carries the library flag of a membership, never one without a membership', async () => {
    const { webPrincipal } = await import('./permissions.js')
    const user = { isAdmin: false, sharedEditor: false }
    expect(webPrincipal(user, 'viewer', true).libraryEditor).toBe(true)
    expect(webPrincipal(user, 'viewer').libraryEditor).toBe(false)
    expect(webPrincipal(user, null, true).libraryEditor).toBe(false)
  })
})
