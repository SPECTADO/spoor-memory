/** Join class names, skipping falsy values (a 3-line `clsx`). */
export function cx(...parts: unknown[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' ')
}
