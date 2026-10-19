/** Stable API error codes (docs/design/api.md section 0.4) and their HTTP status. */

export const ERROR_STATUS = {
  // 400
  invalid_input: 400,
  invalid_grant: 400,
  authorization_pending: 400,
  slow_down: 400,
  access_denied: 400,
  expired_token: 400,
  unsupported_grant_type: 400,
  revision_required: 400,
  wrong_space: 400,
  // 401
  unauthenticated: 401,
  invalid_credentials: 401,
  invalid_token: 401,
  // 403
  forbidden: 403,
  forbidden_role: 403,
  forbidden_origin: 403,
  read_only_space: 403,
  token_project_mismatch: 403,
  // 404
  not_found: 404,
  user_not_found: 404,
  // 409
  revision_conflict: 409,
  slug_taken: 409,
  ambiguous_id: 409,
  pushed_over_spoor_edit: 409,
  already_drafted: 409,
  source_path_taken: 409,
  last_admin: 409,
  promote_required: 409,
  edge_not_editable: 409,
  project_not_empty: 409,
  id_collision: 409,
  already_exists: 409,
  /** MCP edit of a repo-mirrored ADR or doc (mcp.md section 7); never raised by REST. */
  mirrored_item: 409,
  // 413
  payload_too_large: 413,
  zip_limits: 413,
  /** A field over its limit after normalisation (an item body over ITEM_LIMITS.body). */
  too_large: 413,
  // 422
  invalid_archive: 422,
  // 503
  busy: 503,
  too_many_pending: 503,
  starting: 503,
  // 500
  internal: 500,
} as const

export type ErrorCode = keyof typeof ERROR_STATUS

/** Constant map `ErrorCodes.not_found === 'not_found'`. */
export const ErrorCodes = Object.fromEntries(Object.keys(ERROR_STATUS).map((k) => [k, k])) as {
  [K in ErrorCode]: K
}

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === 'string' && Object.hasOwn(ERROR_STATUS, x)
}

/** Flat error body for every non-2xx JSON response. */
export interface ApiErrorBody {
  error: ErrorCode
  request_id: string
  message?: string
  hint?: string
  details?: Record<string, unknown>
}
