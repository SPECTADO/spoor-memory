/**
 * Row factories for integration tests. They write straight to the database (no services, no audit), with
 * unique defaults, so a test states only what it cares about.
 */
import { sql } from 'drizzle-orm'
import { itemRevisions, items, memberships, projects, tokens, users } from '../src/db/schema.js'
import { randomSecret, sha256 } from '../src/lib/crypto.js'
import type { Db } from '../src/lib/db.js'
import { hashPassword } from '../src/modules/auth/passwords.js'

export const DEFAULT_PASSWORD = 'correct horse battery staple'
export const DEFAULT_MODEL = 'local:Xenova/multilingual-e5-small@q8/384'

let seq = 0
const next = () => ++seq

// scrypt at the real parameters costs ~200 ms, so the default password is hashed once per test file
let defaultHash: Promise<string> | undefined
function hashFor(password: string): Promise<string> {
  if (password !== DEFAULT_PASSWORD) return hashPassword(password)
  defaultHash ??= hashPassword(DEFAULT_PASSWORD)
  return defaultHash
}

export interface UserOpts {
  email?: string
  name?: string
  password?: string
  /** A pre-built stored hash (e.g. one with outdated parameters); overrides `password` for the row. */
  passwordHash?: string
  isAdmin?: boolean
  sharedEditor?: boolean
  disabled?: boolean
}

export async function createUser(db: Db, opts: UserOpts = {}) {
  const n = next()
  const password = opts.password ?? DEFAULT_PASSWORD
  const [row] = await db
    .insert(users)
    .values({
      email: opts.email ?? `user${n}@example.com`,
      name: opts.name ?? `User ${n}`,
      passwordHash: opts.passwordHash ?? (await hashFor(password)),
      isAdmin: opts.isAdmin ?? false,
      sharedEditor: opts.sharedEditor ?? false,
      disabledAt: opts.disabled ? sql`now()` : null,
    })
    .returning()
  return { ...(row as typeof users.$inferSelect), password }
}

export const createAdmin = (db: Db, opts: UserOpts = {}) => createUser(db, { ...opts, isAdmin: true })

export interface ProjectOpts {
  slug?: string
  name?: string
  kind?: 'project' | 'shared'
  embeddingModel?: string
  settings?: Record<string, unknown>
}

export async function createProject(db: Db, opts: ProjectOpts = {}) {
  const n = next()
  const kind = opts.kind ?? 'project'
  const [row] = await db
    .insert(projects)
    .values({
      kind,
      slug: kind === 'shared' ? '_shared' : (opts.slug ?? `proj-${n}`),
      name: opts.name ?? (kind === 'shared' ? 'Shared' : `Project ${n}`),
      embeddingModel: opts.embeddingModel ?? DEFAULT_MODEL,
      settings: opts.settings ?? {},
    })
    .returning()
  return row as typeof projects.$inferSelect
}

export const createSharedProject = (db: Db) => createProject(db, { kind: 'shared' })

export async function addMember(
  db: Db,
  projectId: string,
  userId: string,
  role: 'admin' | 'editor' | 'viewer',
) {
  await db.insert(memberships).values({ projectId, userId, role })
}

export interface TokenOpts {
  projectId: string
  userId?: string | null
  kind?: 'user' | 'service'
  role?: 'editor' | 'viewer' | null
  name?: string
  origin?: 'web' | 'device'
}

/** Returns the row plus the plaintext `secret`. */
export async function createToken(db: Db, opts: TokenOpts) {
  const kind = opts.kind ?? (opts.userId ? 'user' : 'service')
  const secret = randomSecret(kind === 'service' ? 'sprs_' : 'spr_')
  const [row] = await db
    .insert(tokens)
    .values({
      kind,
      tokenHash: sha256(secret),
      prefix: secret.slice(0, 12),
      name: opts.name ?? `token ${next()}`,
      projectId: opts.projectId,
      userId: opts.userId ?? null,
      role: opts.role ?? (kind === 'service' ? 'viewer' : null),
      origin: opts.origin ?? 'web',
    })
    .returning()
  return { ...(row as typeof tokens.$inferSelect), secret }
}

export interface ItemOpts {
  projectId: string
  space?: 'memories' | 'decisions' | 'docs'
  title?: string
  body?: string
  type?: 'decision' | 'fact' | 'procedure' | 'observation'
  status?: string
  tags?: string[]
  anchors?: string[]
  pinned?: boolean
  provenance?: 'human' | 'agent'
  createdBy?: string | null
  label?: string
}

/** An item at revision 1 with its revision row; numbers come from the project counters like the real path. */
export async function createItem(db: Db, opts: ItemOpts) {
  const space = opts.space ?? 'memories'
  const n = next()
  return db.transaction(async (tx) => {
    const [counters] = await tx
      .update(projects)
      .set({
        nextItemNumber: sql`${projects.nextItemNumber} + 1`,
        nextAdrNumber:
          space === 'decisions' ? sql`${projects.nextAdrNumber} + 1` : sql`${projects.nextAdrNumber}`,
      })
      .where(sql`${projects.id} = ${opts.projectId}`)
      .returning({
        number: sql<number>`${projects.nextItemNumber} - 1`,
        adr: sql<number>`${projects.nextAdrNumber} - 1`,
      })
    if (!counters) throw new Error(`createItem: no project ${opts.projectId}`)
    const type = space === 'memories' ? (opts.type ?? 'fact') : null
    const status = opts.status ?? (space === 'decisions' ? 'proposed' : 'active')
    const title = opts.title ?? `Item ${n}`
    const label = opts.label ?? 'test'
    const [row] = await tx
      .insert(items)
      .values({
        projectId: opts.projectId,
        space,
        number: counters.number,
        adrNumber: space === 'decisions' ? counters.adr : null,
        slug: `item-${n}`,
        title,
        type,
        status,
        confidence: space === 'memories' ? 'medium' : null,
        tags: opts.tags ?? [],
        anchors: opts.anchors ?? [],
        body: opts.body ?? '',
        pinned: opts.pinned ?? false,
        provenance: opts.provenance ?? 'human',
        expiresAt: type === 'observation' ? sql`now() + interval '7 days'` : null,
        createdBy: opts.createdBy ?? null,
        createdByLabel: label,
        updatedBy: opts.createdBy ?? null,
        updatedByLabel: label,
      })
      .returning()
    const item = row as typeof items.$inferSelect
    await tx.insert(itemRevisions).values({
      itemId: item.id,
      revision: 1,
      title,
      body: item.body,
      status,
      frontmatter: { title, ...(type ? { type } : {}), tags: item.tags },
      change: 'create',
      actorUserId: opts.createdBy ?? null,
      actorLabel: label,
      via: 'web',
    })
    return item
  })
}
