/**
 * One-line text hygiene (docs/design/data-model.md section 0, auth-and-security.md section 13).
 * Titles, tags, names and client names lose control characters (Unicode Cc, incl. CR/LF/TAB) and bidi
 * controls (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069) on every write path, so a value can neither fake
 * extra lines in agent output nor hide text behind a direction override.
 */
const CONTROL_RE = /[\p{Cc}‎‏‪-‮⁦-⁩]/gu

export function stripControl(s: string): string {
  return s.replace(CONTROL_RE, '')
}

/** stripControl, then trim. The form every stored one-line name/title goes through. */
export function cleanLine(s: string): string {
  return stripControl(s).trim()
}
