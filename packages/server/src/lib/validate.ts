/** Request parsing for route handlers: strict zod validation into `invalid_input` (api.md section 0.1). */
import type { Context } from 'hono'
import { z } from 'zod'
import { ApiError, invalidInput } from './errors.js'

/** JSON body cap for every route except the import upload (api.md section 0.1). */
export const JSON_BODY_LIMIT = 1024 * 1024

/**
 * Parse the JSON body with `schema` (use `z.strictObject` so unknown fields are rejected). A missing body
 * parses as `{}`, so an all-optional schema accepts a bodyless request.
 */
// biome-ignore lint/suspicious/noExplicitAny: Context is generic over every app env here
export async function readJson<S extends z.ZodType>(c: Context<any>, schema: S): Promise<z.output<S>> {
  const text = await c.req.text()
  let raw: unknown = {}
  if (text.trim() !== '') {
    // defence in depth for the origin check's content-type rule: a body is parsed only as JSON
    const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
    if (type !== 'application/json') {
      throw new ApiError('invalid_input', { message: 'Content-Type must be application/json.' })
    }
    try {
      raw = JSON.parse(text)
    } catch {
      throw new ApiError('invalid_input', { message: 'The request body is not valid JSON.' })
    }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw invalidInput(parsed.error)
  return parsed.data
}

/** Parse the query string (single values; repeated keys arrive as arrays) with `schema`. */
// biome-ignore lint/suspicious/noExplicitAny: Context is generic over every app env here
export function readQuery<S extends z.ZodType>(c: Context<any>, schema: S): z.output<S> {
  const all = c.req.queries()
  const raw: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(all)) raw[k] = v.length === 1 ? (v[0] as string) : v
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw invalidInput(parsed.error, 'Invalid query parameters.')
  return parsed.data
}

export const uuidParam = z.uuid()

/** A path parameter that must be a uuid; anything else is `not_found` (the row cannot exist). */
export function uuidOr404(value: string | undefined): string {
  if (!value || !uuidParam.safeParse(value).success) throw new ApiError('not_found')
  return value
}
