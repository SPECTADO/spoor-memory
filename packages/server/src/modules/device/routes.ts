/**
 * Device-flow routes (api.md section 3): the public CLI side under `/p/:slug/device` and the cookie side
 * under `/api/v1/device`. Parsing, the caller and status codes only; the rules are in service.ts.
 */
import type { IncomingMessage } from 'node:http'
import {
  deviceApproveRequest,
  deviceCodeRequest,
  deviceDenyRequest,
  deviceLookupQuery,
  deviceTokenRequest,
} from '@spoor/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { clientIp, type TrustedProxies } from '../../lib/client-ip.js'
import { errorResponse } from '../../lib/errors.js'
import { readJson, readQuery } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { requireUser } from '../auth/index.js'
import type { DeviceService } from './service.js'

/** Small JSON bodies only on the public endpoints (they take no authentication). */
const PUBLIC_BODY_LIMIT = 16 * 1024

/**
 * The requester's address for the approval page. The TCP peer of the request (`@hono/node-server` passes the
 * Node request as `env.incoming`) unless `SPOOR_TRUST_PROXY` names that peer as a trusted proxy; then the
 * right-most `X-Forwarded-For` hop that is not a trusted proxy (lib/client-ip.ts). Forwarded headers are
 * never trusted by default: anyone could claim any address, and the IP is shown to the approver precisely to
 * spot a request that is not their own (deviations.md P3-1).
 */
export function requesterAddress(c: Context<AppEnv>, trusted: TrustedProxies | null): string | null {
  const env = c.env as { incoming?: Pick<IncomingMessage, 'socket'> } | undefined
  const peer = env?.incoming?.socket?.remoteAddress ?? null
  return clientIp(peer, trusted === null ? null : c.req.header('x-forwarded-for'), trusted)
}

/** Mount at `/p/:slug/device` (public, no cookie, no token). */
export function devicePublicRoutes(device: DeviceService, trusted: TrustedProxies | null = null) {
  const slugOf = (c: Context<AppEnv>) => c.req.param('slug') ?? ''
  return new Hono<AppEnv>()
    .use(
      '*',
      bodyLimit({
        maxSize: PUBLIC_BODY_LIMIT,
        onError: (c) =>
          errorResponse(c as Context<AppEnv>, 'payload_too_large', {
            message: 'The request body is too large.',
          }),
      }),
    )
    .post('/code', async (c) => {
      const body = await readJson(c, deviceCodeRequest)
      const res = await device.requestCode(slugOf(c), {
        clientName: body.client_name,
        requesterIp: requesterAddress(c, trusted),
      })
      c.header('Cache-Control', 'no-store')
      return c.json(res)
    })
    .post('/token', async (c) => {
      // RFC 6749 section 5.1: token responses, errors included, are never cached
      c.header('Cache-Control', 'no-store')
      const body = await readJson(c, deviceTokenRequest)
      return c.json(
        await device.poll(slugOf(c), { grantType: body.grant_type, deviceCode: body.device_code }),
      )
    })
}

/** Mount on `/api/v1` after `auth.cookieApiGuards` (session, origin check, Authorization header refused). */
export function deviceCookieRoutes(device: DeviceService) {
  return new Hono<AppEnv>()
    .get('/device/lookup', async (c) => {
      const ctx = requireUser(c)
      c.header('Cache-Control', 'no-store')
      return c.json(await device.lookup(ctx, readQuery(c, deviceLookupQuery).code))
    })
    .post('/device/approve', async (c) => {
      const ctx = requireUser(c)
      const body = await readJson(c, deviceApproveRequest)
      return c.json(await device.approve(ctx, body.code, body.read_only === true))
    })
    .post('/device/deny', async (c) => {
      const ctx = requireUser(c)
      const body = await readJson(c, deviceDenyRequest)
      return c.json(await device.deny(ctx, body.code))
    })
}
