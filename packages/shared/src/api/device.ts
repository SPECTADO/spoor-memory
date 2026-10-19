/**
 * Request and response shapes of the device flow (docs/design/api.md section 3, auth-and-security.md
 * section 6). Shared by the server (validation), the SPA's `/device` page and the CLI's `spoor login`.
 * Objects are strict: unknown fields are rejected.
 */
import { z } from 'zod'
import type { ProjectRole } from './auth.js'

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * `POST /p/:slug/device/code`. `client_name` is cut to 64 characters by the server, so a longer one is
 * accepted (deviations.md X4).
 */
export const deviceCodeRequest = z.strictObject({ client_name: z.string().max(4096).optional() })

/** `POST /p/:slug/device/token`. `grant_type` is checked by the server (`unsupported_grant_type`), not here. */
export const deviceTokenRequest = z.strictObject({
  grant_type: z.string().max(200),
  device_code: z.string().max(200),
})

/** The user code as typed (`WDJB-MJHT`; case, spaces and the dash are normalised by the server). */
const code = z.string().min(1).max(32)
/** `GET /api/v1/device/lookup?code=`, `POST /api/v1/device/approve`, `POST /api/v1/device/deny`. */
export const deviceLookupQuery = z.strictObject({ code })
export const deviceApproveRequest = z.strictObject({ code, read_only: z.boolean().optional() })
export const deviceDenyRequest = z.strictObject({ code })
export type DeviceCodeRequest = z.input<typeof deviceCodeRequest>
export type DeviceTokenRequest = z.input<typeof deviceTokenRequest>
export type DeviceApproveRequest = z.input<typeof deviceApproveRequest>
export type DeviceDenyRequest = z.input<typeof deviceDenyRequest>

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface DeviceTokenResponse {
  access_token: string
  token_type: 'Bearer'
  project: string
  role: ProjectRole
  token_name: string
}

export interface DeviceLookupResponse {
  project: { slug: string; name: string }
  /** Reported by the requester, unverified. */
  client_name: string
  requester_ip: string | null
  requested_at: string
  age_s: number
  your_role: ProjectRole
}

/** `read_only` caps the minted token at `viewer`; without it the token inherits the approver's live role. */
export interface DeviceApproveResponse {
  status: 'approved'
  role_cap: 'viewer' | null
}

export interface DeviceDenyResponse {
  status: 'denied'
}
