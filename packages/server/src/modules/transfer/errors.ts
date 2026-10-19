/** Error constructors of the transfer module (api.md section 9). Messages never echo archive content beyond names. */
import { ApiError } from '../../lib/errors.js'

export interface ArchiveIssue {
  path?: string
  message: string
}

/** 422 `invalid_archive`: bad name, bad UTF-8, bad manifest, CRC-32 or size mismatch (`details.issues`). */
export function invalidArchive(message: string, issues: ArchiveIssue[] = []): ApiError {
  return new ApiError('invalid_archive', {
    message,
    details: { issues: issues.slice(0, 50) },
  })
}

/** 413 `zip_limits`: too many entries, an entry or the total too large (auth-and-security.md section 9). */
export function zipLimits(message: string): ApiError {
  return new ApiError('zip_limits', { message })
}

/** Names shown in an error are cut so a hostile archive cannot fill the response. */
export function shortName(name: string): string {
  const cut = [...name].slice(0, 80).join('')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: printing control characters is what is avoided
  return cut.replace(/[\u0000-\u001f\u007f]/g, '?')
}
