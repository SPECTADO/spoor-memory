/**
 * Spoor's own releases: the GitHub repository the web UI links to and the version compare behind the "newer
 * release" notice (operations.md "Update check"). A release here is a published `x.y.z`: pre-releases and the
 * `0.0.0` of a source build are never announced and never compared.
 */

/** The public repository. The web UI links its version text here; the release notes live under `/releases/tag/`. */
export const REPO_URL = 'https://github.com/SPECTADO/spoor-memory'

/** Where the release-notes links of an update notice may point (the checker rejects any other host or owner). */
export const RELEASE_URL_PREFIX = 'https://github.com/SPECTADO/'

/** The GitHub release page of `version`. */
export const releaseTagUrl = (version: string) => `${REPO_URL}/releases/tag/v${version}`

const CORE_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/
const STABLE_RE = /^\d+\.\d+\.\d+$/

/** A published release: `x.y.z`, no pre-release part, not `0.0.0`. */
export const isStableRelease = (v: string): boolean => STABLE_RE.test(v) && v !== '0.0.0'

/**
 * True when `latest` is a stable release newer than `current`. `current` may be a pre-release: `0.8.0` is newer
 * than `0.8.0-rc.1`, `0.7.0` is not. A `current` of `0.0.0` (or anything unparsable) is never behind.
 */
export function isNewerRelease(latest: string, current: string): boolean {
  if (!isStableRelease(latest)) return false
  const c = CORE_RE.exec(current)
  if (!c || /^0\.0\.0(?:-|$)/.test(current)) return false
  const l = latest.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const a = l[i] ?? 0
    const b = Number(c[i + 1])
    if (a !== b) return a > b
  }
  // same x.y.z: the release is newer than its own pre-release
  return current.includes('-')
}
