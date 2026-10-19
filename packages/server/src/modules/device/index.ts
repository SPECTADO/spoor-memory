/**
 * Device module: `spoor login`'s RFC 8628-style device flow (auth-and-security.md section 6, api.md
 * section 3, deviations I33, I39, X4). The CLI requests a code and polls; a logged-in member of the project
 * types the code on the SPA's `/device` page and approves (optionally read-only) or denies; the poll then
 * mints a 90-day user token with `origin='device'` (through the tokens module's `mintToken`).
 *
 * Wiring (app.ts): `publicRoutes` is mounted at `/p/:slug/device`, `routes` on `/api/v1` after
 * `auth.cookieApiGuards`. Old device rows are deleted by the jobs module's `purge-ephemeral` (one day past
 * `expires_at`).
 */
import type { ServerDeps } from '../../lib/deps.js'
import { deviceCookieRoutes, devicePublicRoutes } from './routes.js'
import { DeviceService, type DeviceServiceOptions } from './service.js'

export { DEVICE_GRANT_TYPE } from '@spoor/shared'
export { cleanClientName, displayIp, formatUserCode, generateUserCode, normalizeUserCode } from './codes.js'
export { MissLimiter } from './limiter.js'
export {
  DEVICE_CODE_TTL_S,
  DEVICE_TOKEN_DAYS,
  DeviceService,
  type DeviceServiceOptions,
  MAX_DEVICE_ROWS,
} from './service.js'

export function createDeviceModule(deps: ServerDeps, opts: DeviceServiceOptions = {}) {
  const device = new DeviceService(deps, opts)
  return {
    name: 'device',
    device,
    /** `POST /code`, `POST /token`; mount at `/p/:slug/device` (public). */
    publicRoutes: devicePublicRoutes(device, deps.config.trustedProxies),
    /** `GET /device/lookup`, `POST /device/{approve,deny}`; mount on `/api/v1` after the cookie guards. */
    routes: deviceCookieRoutes(device),
  }
}

export type DeviceModule = ReturnType<typeof createDeviceModule>
