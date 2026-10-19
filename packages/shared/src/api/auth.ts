/**
 * Request schemas of the auth, invite and user routes (docs/design/api.md sections 1 and 2).
 * Shared by the server (validation) and the SPA (forms). Objects are strict: unknown fields are rejected.
 */
import { z } from 'zod'
import { cleanLine } from '../text.js'

export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 256
export const PROJECT_ROLES = ['admin', 'editor', 'viewer'] as const
export type ProjectRole = (typeof PROJECT_ROLES)[number]

/** NFKC-normalised, 12 to 256 characters, no composition rules (auth-and-security.md section 2). */
export const passwordSchema = z
  .string()
  .max(4 * PASSWORD_MAX)
  .transform((p) => p.normalize('NFKC'))
  .pipe(z.string().min(PASSWORD_MIN).max(PASSWORD_MAX))

/** Lower-cased, trimmed email (the `users_email_check` shape). */
export const emailSchema = z
  .string()
  .max(320)
  .transform((e) => e.trim().toLowerCase())
  .pipe(z.email().max(254))

/** Display name: control and bidi characters stripped, trimmed, 1 to 100 characters. */
export const nameSchema = z.string().max(400).transform(cleanLine).pipe(z.string().min(1).max(100))

export const loginRequest = z.strictObject({
  email: z
    .string()
    .max(320)
    .transform((e) => e.trim().toLowerCase()),
  // not length-checked: a wrong password of any length is just `invalid_credentials`
  password: z
    .string()
    .min(1)
    .max(4 * PASSWORD_MAX),
})

export const mePatchRequest = z.strictObject({ name: nameSchema })

export const passwordChangeRequest = z.strictObject({
  current_password: z
    .string()
    .min(1)
    .max(4 * PASSWORD_MAX),
  new_password: passwordSchema,
})

export const inviteTokenSchema = z.string().min(1).max(200)

export const invitePreviewRequest = z.strictObject({ token: inviteTokenSchema })

export const inviteAcceptRequest = z.strictObject({
  token: inviteTokenSchema,
  name: nameSchema.optional(),
  email: emailSchema.optional(),
  password: passwordSchema,
})

export const inviteGrantInput = z.strictObject({
  project: z.string().min(1).max(64),
  role: z.enum(PROJECT_ROLES),
})

export const inviteCreateRequest = z.strictObject({
  email: emailSchema.optional(),
  grants: z.array(inviteGrantInput).max(200).default([]),
  is_admin: z.boolean().default(false),
  shared_editor: z.boolean().default(false),
  reset_user_id: z.uuid().optional(),
  reset_revoke_tokens: z.boolean().default(true),
  expires_in_hours: z.number().int().min(1).max(720).default(168),
})

export const INVITE_STATUSES = ['open', 'used', 'expired', 'revoked'] as const

export const userPatchRequest = z.strictObject({
  name: nameSchema.optional(),
  is_admin: z.boolean().optional(),
  shared_editor: z.boolean().optional(),
  disabled: z.boolean().optional(),
})

export type LoginRequest = z.input<typeof loginRequest>
export type InviteCreateRequest = z.input<typeof inviteCreateRequest>
export type InviteAcceptRequest = z.input<typeof inviteAcceptRequest>
export type UserPatchRequest = z.input<typeof userPatchRequest>

/** `user` object of login, accept, `GET /me` and the admin user list. */
export interface UserJson {
  id: string
  email: string
  name: string
  is_admin: boolean
  shared_editor: boolean
}

export interface MeResponse {
  user: UserJson
  memberships: { project: { id: string; slug: string; name: string }; role: ProjectRole }[]
}
