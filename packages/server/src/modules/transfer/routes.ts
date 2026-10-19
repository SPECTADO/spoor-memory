/** Export and import routes, mounted at /api/v1 (api.md section 9). Parsing and status codes only. */
import { nameSchema, projectSlugSchema } from '@spoor/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError, invalidInput } from '../../lib/errors.js'
import { readQuery } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { requireInstanceAdmin, requireUser } from '../auth/index.js'
import { loadProjectAccess } from '../projects/index.js'
import type { TransferService } from './service.js'

/** api.md section 0.1: uploads are capped at 50 MB (the body, multipart framing included, gets a little slack). */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024
const FRAMING_SLACK = 64 * 1024

const exportQuery = z.strictObject({ history: z.enum(['0', '1', 'false', 'true']).optional() })
const remapField = z.enum(['true', 'false']).default('false')
const newFields = z.strictObject({
  slug: projectSlugSchema,
  name: nameSchema.optional(),
  remap_ids: remapField,
})
const intoFields = z.strictObject({ remap_ids: remapField })

const tooBig = () => new ApiError('payload_too_large', { message: 'The upload is larger than 50 MB.' })

/** Read the multipart body with a running byte counter (Content-Length may be missing or a lie). */
async function readUpload(req: Request): Promise<{ file: Uint8Array; fields: Record<string, string> }> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES + FRAMING_SLACK) throw tooBig()
  const type = req.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data/i.test(type) || !req.body) {
    throw new ApiError('invalid_input', { message: 'Send multipart/form-data with a file field.' })
  }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > UPLOAD_MAX_BYTES + FRAMING_SLACK) {
      await reader.cancel().catch(() => {})
      throw tooBig()
    }
    chunks.push(value)
  }
  let form: FormData
  try {
    form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': type } }).formData()
  } catch {
    throw new ApiError('invalid_input', { message: 'The multipart body could not be read.' })
  }
  const fields: Record<string, string> = {}
  let file: Uint8Array | undefined
  for (const [k, v] of form.entries()) {
    if (k === 'file') {
      if (typeof v === 'string')
        throw new ApiError('invalid_input', { message: 'file must be a file upload.' })
      if (file) throw new ApiError('invalid_input', { message: 'Only one file is accepted.' })
      file = new Uint8Array(await v.arrayBuffer())
    } else if (typeof v === 'string') {
      if (k in fields) throw new ApiError('invalid_input', { message: `Duplicate field ${k}.` })
      fields[k] = v
    } else {
      throw new ApiError('invalid_input', { message: `Field ${k} must be text.` })
    }
  }
  if (!file) throw new ApiError('invalid_input', { message: 'The file field is missing.' })
  return { file, fields }
}

function parseFields<S extends z.ZodType>(schema: S, fields: Record<string, string>): z.output<S> {
  const p = schema.safeParse(fields)
  if (!p.success) throw invalidInput(p.error)
  return p.data
}

export function transferRoutes(deps: ServerDeps, service: TransferService) {
  return new Hono<AppEnv>()
    .get('/projects/:slug/export', async (c) => {
      const access = await loadProjectAccess(deps.db, requireUser(c), c.req.param('slug'))
      const q = readQuery(c, exportQuery)
      const result = await service.exportProject(access, {
        history: q.history === undefined || q.history === '1' || q.history === 'true',
      })
      return c.body(result.zip as Uint8Array<ArrayBuffer>, 200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'no-store',
      })
    })
    .post('/projects/import', async (c) => {
      const ctx = requireInstanceAdmin(c)
      const { file, fields } = await readUpload(c.req.raw)
      const f = parseFields(newFields, fields)
      return c.json(
        await service.importNew(ctx, { file, slug: f.slug, name: f.name, remapIds: f.remap_ids === 'true' }),
      )
    })
    .post('/projects/:slug/import', async (c) => {
      const access = await loadProjectAccess(deps.db, requireUser(c), c.req.param('slug'))
      access.assert('project.transfer')
      const { file, fields } = await readUpload(c.req.raw)
      const f = parseFields(intoFields, fields)
      return c.json(await service.importInto(access, { file, remapIds: f.remap_ids === 'true' }))
    })
}
