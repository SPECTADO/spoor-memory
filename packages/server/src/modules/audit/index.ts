/**
 * Audit module: the read side of `audit_log` (per project and instance-level). Every module writes rows
 * with `writeAudit` (src/lib/audit.ts) in the same transaction as its change. Design: api.md 10,
 * data-model.md 4.
 */
import type { ServerDeps } from '../../lib/deps.js'
import { auditRoutes } from './routes.js'
import { AuditService } from './service.js'

export { AuditService, auditRowJson } from './service.js'

export function createAuditModule(deps: ServerDeps) {
  const audit = new AuditService(deps)
  return { name: 'audit', audit, routes: auditRoutes(deps, audit) }
}

export type AuditModule = ReturnType<typeof createAuditModule>
