/**
 * Transfer module: export a project (or the shared space) as a zip, and import one losslessly or from a
 * folder of Markdown files. Design: data-model.md section 8, api.md section 9, auth-and-security.md section 9.
 *
 * Wiring (src/app.ts): `const transfer = createTransferModule(deps)` then `api.route('/', transfer.routes)`
 * inside the cookie API, after the guards.
 */
import type { ServerDeps } from '../../lib/deps.js'
import { transferRoutes } from './routes.js'
import { TransferService } from './service.js'

export { TransferService } from './service.js'

export function createTransferModule(deps: ServerDeps) {
  const transfer = new TransferService(deps)
  return { name: 'transfer', transfer, routes: transferRoutes(deps, transfer) }
}

export type TransferModule = ReturnType<typeof createTransferModule>
