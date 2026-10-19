import { describe, expect, it } from 'vitest'
// Validation and matching as the server's write paths and the `?anchor=` filter use them (moved from the
// items module's adapter, which is gone: one normaliser for files, phase-2 review C4).
import {
  matchAnchor as anchorStrength,
  bestStrength,
  globMatches as globMatch,
  normalizeFilePath,
  normalizeFiles,
  normalizePath,
  scoreAnchors,
  validateAnchor,
} from './anchors.js'

const ok = (s: string) => {
  const r = validateAnchor(s)
  if (!r.ok) throw new Error(r.reason)
  return r.anchor
}
const bad = (s: string) => {
  const r = validateAnchor(s)
  return r.ok ? null : r.reason
}

describe('normalizePath / normalizeAnchor', () => {
  it('strips ./ and leading /, collapses //', () => {
    expect(ok('./src//auth/session.ts')).toBe('src/auth/session.ts')
    expect(ok('/src/auth/')).toBe('src/auth/')
    expect(ok('././a')).toBe('a')
  })
  it('rejects .., NUL, empty and long paths', () => {
    expect(bad('src/../etc')).toMatch(/"\.\."/)
    expect(bad('a\0b')).toMatch(/repo-relative path/)
    expect(bad('  ')).toMatch(/repo-relative path/)
    expect(bad(`a/${'x'.repeat(300)}`)).toMatch(/256/)
  })
  it('collapses ** runs and limits tokens', () => {
    expect(ok('src/**/**/x.ts')).toBe('src/**/x.ts')
    expect(ok('src/**/**')).toBe('src/**')
    expect(bad('src/***.ts')).toMatch(/consecutive/)
    expect(bad('*/*/*/*/*.ts')).toMatch(/at most 4/)
    expect(bad('{a,b}{c,d}{e,f}{g,h}{i,j}')).toMatch(/alternatives/)
    expect(bad('src/{a,b')).toMatch(/\{/)
  })
  it('validates exactly like the digest matcher (search-and-digest.md section 8)', () => {
    // at most 4 `{…}` alternatives per anchor, as the design says
    expect(ok('src/{a,b,c,d}/x.ts')).toBe('src/{a,b,c,d}/x.ts')
    expect(bad('src/{a,b,c,d,e}/x.ts')).toMatch(/alternatives/)
    // an unclosed `[` is a literal, like in the matcher
    expect(ok('src/[abc')).toBe('src/[abc')
    expect(anchorStrength('src/[abc', 'src/[abc')).toBe(2)
    // anchors without glob syntax get POSIX separators
    expect(ok('src\\auth\\x.ts')).toBe('src/auth/x.ts')
  })
  it('files: backslashes always become /, also next to glob characters (review C4)', () => {
    expect(normalizeFilePath('src\\auth\\x.ts')).toBe('src/auth/x.ts')
    expect(normalizePath('..')).toBeNull()
    // the same Windows path matches in the ?anchor= filter and in the digest
    for (const f of ['src\\[id]\\page.tsx', 'src\\a{b}.ts']) {
      const file = normalizeFilePath(f) as string
      expect(file.includes('\\')).toBe(false)
      expect(bestStrength(['src/'], file)).toBe(1)
      expect(normalizeFiles([f])).toEqual([file])
      expect(scoreAnchors(['src/'], normalizeFiles([f])).strength).toBe(1)
    }
  })
})

describe('globMatch', () => {
  it('* and ? stay inside a segment', () => {
    expect(globMatch('src/*.ts', 'src/a.ts')).toBe(true)
    expect(globMatch('src/*.ts', 'src/a/b.ts')).toBe(false)
    expect(globMatch('src/?.ts', 'src/a.ts')).toBe(true)
    expect(globMatch('src/?.ts', 'src/ab.ts')).toBe(false)
  })
  it('** spans zero or more segments', () => {
    expect(globMatch('packages/**/schema.ts', 'packages/schema.ts')).toBe(true)
    expect(globMatch('packages/**/schema.ts', 'packages/server/src/db/schema.ts')).toBe(true)
    expect(globMatch('**', 'a/b/c')).toBe(true)
  })
  it('classes, negation, alternation, escapes', () => {
    expect(globMatch('src/[a-c].ts', 'src/b.ts')).toBe(true)
    expect(globMatch('src/[!a-c].ts', 'src/b.ts')).toBe(false)
    expect(globMatch('src/*.{ts,tsx}', 'src/a.tsx')).toBe(true)
    expect(globMatch('src/*.{ts,tsx}', 'src/a.js')).toBe(false)
    expect(globMatch('src/\\*.ts', 'src/*.ts')).toBe(true)
    expect(globMatch('src/\\*.ts', 'src/a.ts')).toBe(false)
  })
  it('a pathological anchor is linear, not backtracking', () => {
    const anchor = ok('*?*?*?*?#')
    const path = `${'a'.repeat(250)}`
    const t = performance.now()
    expect(globMatch(anchor, path)).toBe(false)
    expect(performance.now() - t).toBeLessThan(50)
  })
})

describe('anchorStrength', () => {
  it('exact 3, glob 2, directory 1', () => {
    expect(anchorStrength('src/auth/session.ts', 'src/auth/session.ts')).toBe(3)
    expect(anchorStrength('src/auth/*.ts', 'src/auth/session.ts')).toBe(2)
    expect(anchorStrength('src/auth/', 'src/auth/session.ts')).toBe(1)
    expect(anchorStrength('src/auth', 'src/auth/session.ts')).toBe(1)
    expect(anchorStrength('src/auth', 'src/authz/x.ts')).toBe(0)
  })
  it('a directory file matches anchors inside it', () => {
    expect(anchorStrength('src/auth/session.ts', 'src/')).toBe(1)
    expect(anchorStrength('src/auth/**/*.ts', 'src/auth/')).toBe(1)
    expect(anchorStrength('lib/x.ts', 'src/')).toBe(0)
  })
  it('bestStrength takes the max', () => {
    expect(bestStrength(['src/', 'src/a.ts'], 'src/a.ts')).toBe(3)
    expect(bestStrength([], 'src/a.ts')).toBe(0)
  })
})
