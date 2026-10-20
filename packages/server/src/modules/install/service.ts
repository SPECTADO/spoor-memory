/** Template values of a project for the install doc (api.md section 11.1: URL, slug, version, budget, memory mode only). */
import { and, eq } from 'drizzle-orm'
import { projects } from '../../db/schema.js'
import type { ServerDeps } from '../../lib/deps.js'
import { VERSION } from '../../version.js'
import { resolveSettings } from '../projects/index.js'
import type { InstallValues } from './templates.js'

export class InstallService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly version: string = VERSION,
  ) {}

  /** The template values of a regular project, or `null` (unknown slug, `_shared`). */
  async values(slug: string): Promise<InstallValues | null> {
    const [p] = await this.deps.db
      .select({ slug: projects.slug, settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.slug, slug), eq(projects.kind, 'project')))
      .limit(1)
    if (!p) return null
    const settings = resolveSettings(p.settings)
    return {
      server: this.deps.config.publicOrigin,
      slug: p.slug,
      version: this.version,
      budget: settings.digest.default_budget,
      memoryExclusive: settings.memory.exclusive,
    }
  }
}
