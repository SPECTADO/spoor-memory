/** Request schemas of the mirror's bearer routes (api.md section 7.2). */
import { z } from 'zod'

export const activityQuery = z.strictObject({ since: z.iso.datetime({ offset: true }).optional() })

/** `POST /adr/push` and `POST /docs/push`: `POST /push` with the space taken from the path. */
export const spacePushRequest = z.strictObject({
  source_path: z.string().min(1).max(256),
  content: z.string().max(400_000),
  base_revision: z.number().int().min(1).optional(),
  force: z.boolean().optional(),
})
