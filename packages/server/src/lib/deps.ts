import type { Logger } from 'pino'
import type { Config } from '../config.js'
import type { Ports } from '../ports.js'
import type { Db } from './db.js'

/**
 * Everything a module needs, passed explicitly (no globals): `createXService(deps)` and
 * `xRoutes(deps)` both take this. Tests build it with a real test DB and `testPorts()`.
 */
export interface ServerDeps {
  config: Config
  logger: Logger
  db: Db
  ports: Ports
}
