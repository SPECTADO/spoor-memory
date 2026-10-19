import { describe, expect, it } from 'vitest'
import {
  globMatches,
  matchAnchor,
  normalizeFiles,
  normalizePath,
  scoreAnchors,
  staticPrefix,
  validateAnchor,
} from './anchors.js'

describe('normalizePath', () => {
  it('strips ./ and leading /, collapses //, converts backslashes', () => {
    expect(normalizePath('./src//auth/x.ts')).toBe('src/auth/x.ts')
    expect(normalizePath('/src/a.ts')).toBe('src/a.ts')
    expect(normalizePath('src\\auth\\x.ts')).toBe('src/auth/x.ts')
    expect(normalizePath('src/auth/')).toBe('src/auth/')
  })
  it('rejects .., NUL, empty and overlong paths', () => {
    expect(normalizePath('src/../etc')).toBeNull()
    expect(normalizePath('a\0b')).toBeNull()
    expect(normalizePath('')).toBeNull()
    expect(normalizePath('./')).toBeNull()
    expect(normalizePath('a'.repeat(257))).toBeNull()
  })
  it('keeps backslash escapes in globs', () => {
    expect(normalizePath('src/\\*.ts')).toBe('src/\\*.ts')
  })
})

describe('matchAnchor strengths', () => {
  it('exact > glob > directory', () => {
    expect(matchAnchor('src/auth/session.ts', 'src/auth/session.ts')).toBe(3)
    expect(matchAnchor('src/auth/*.ts', 'src/auth/session.ts')).toBe(2)
    expect(matchAnchor('src/auth/', 'src/auth/session.ts')).toBe(1)
    expect(matchAnchor('src/auth', 'src/auth/session.ts')).toBe(1)
  })
  it('directory prefix respects segment boundaries', () => {
    expect(matchAnchor('src/auth', 'src/authz/x.ts')).toBe(0)
    expect(matchAnchor('src/auth/', 'src/authz/x.ts')).toBe(0)
    expect(matchAnchor('src/auth', 'src/auth')).toBe(3)
  })
  it('is case-sensitive', () => {
    expect(matchAnchor('src/Auth.ts', 'src/auth.ts')).toBe(0)
  })
  it('a files entry that is a directory matches anchors inside it with strength 1', () => {
    expect(matchAnchor('src/auth/session.ts', 'src/auth/')).toBe(1)
    expect(matchAnchor('src/auth/', 'src/auth/')).toBe(1)
    expect(matchAnchor('src/auth/**/*.ts', 'src/')).toBe(1)
    expect(matchAnchor('src/**', 'src/auth/')).toBe(0)
    expect(matchAnchor('lib/x.ts', 'src/')).toBe(0)
  })
})

describe('glob grammar', () => {
  it('* stays inside one segment, ** spans segments (incl. zero)', () => {
    expect(globMatches('src/*.ts', 'src/a.ts')).toBe(true)
    expect(globMatches('src/*.ts', 'src/x/a.ts')).toBe(false)
    expect(globMatches('src/**/*.ts', 'src/a.ts')).toBe(true)
    expect(globMatches('src/**/*.ts', 'src/x/y/a.ts')).toBe(true)
    expect(globMatches('**/README.md', 'README.md')).toBe(true)
    expect(globMatches('**/README.md', 'a/b/README.md')).toBe(true)
    expect(globMatches('src/**', 'src/a/b')).toBe(true)
  })
  it('? matches one character', () => {
    expect(globMatches('a?.ts', 'ab.ts')).toBe(true)
    expect(globMatches('a?.ts', 'a.ts')).toBe(false)
  })
  it('classes, negation and ranges', () => {
    expect(globMatches('v[0-9].md', 'v3.md')).toBe(true)
    expect(globMatches('v[0-9].md', 'vx.md')).toBe(false)
    expect(globMatches('v[!0-9].md', 'vx.md')).toBe(true)
    expect(globMatches('[abc].ts', 'b.ts')).toBe(true)
  })
  it('{a,b} alternation', () => {
    expect(globMatches('src/*.{ts,tsx}', 'src/a.tsx')).toBe(true)
    expect(globMatches('src/*.{ts,tsx}', 'src/a.js')).toBe(false)
    expect(globMatches('{lib,src}/x.ts', 'lib/x.ts')).toBe(true)
  })
  it('escapes', () => {
    expect(globMatches('a\\*b', 'a*b')).toBe(true)
    expect(globMatches('a\\*b', 'axb')).toBe(false)
  })
  it('static prefix', () => {
    expect(staticPrefix('src/auth/**/*.ts')).toBe('src/auth/')
    expect(staticPrefix('src/x.ts')).toBe('src/x.ts')
  })
})

describe('scoreAnchors', () => {
  it('takes the max strength and reports the first anchor reaching it', () => {
    const s = scoreAnchors(['src/', 'src/auth/*.ts', 'src/auth/session.ts'], ['src/auth/session.ts'])
    expect(s).toEqual({ strength: 3, matchedFiles: 1, anchor: 'src/auth/session.ts' })
  })
  it('counts matched files for tie-breaks', () => {
    const s = scoreAnchors(['src/auth/'], ['src/auth/a.ts', 'src/auth/b.ts', 'lib/c.ts'])
    expect(s.strength).toBe(1)
    expect(s.matchedFiles).toBe(2)
  })
  it('no match', () => {
    expect(scoreAnchors(['lib/'], ['src/a.ts'])).toEqual({ strength: 0, matchedFiles: 0, anchor: null })
  })
})

describe('normalizeFiles', () => {
  it('drops invalid entries and duplicates', () => {
    expect(normalizeFiles(['./a.ts', 'a.ts', '../x', 'b/'])).toEqual(['a.ts', 'b/'])
  })
})

describe('validateAnchor', () => {
  it('collapses repeated ** segments', () => {
    expect(validateAnchor('src/**/**/x.ts')).toEqual({ ok: true, anchor: 'src/**/x.ts' })
    expect(validateAnchor('./src/a.ts')).toEqual({ ok: true, anchor: 'src/a.ts' })
  })
  it('rejects *** runs, too many stars, too many alternatives, nested braces', () => {
    expect(validateAnchor('src/***.ts').ok).toBe(false)
    expect(validateAnchor('*/*/*/*/*.ts').ok).toBe(false)
    expect(validateAnchor('*/*/*/*.ts').ok).toBe(true)
    expect(validateAnchor('{a,b,c}/{d,e}.ts').ok).toBe(false)
    expect(validateAnchor('{a,{b,c}}').ok).toBe(false)
    expect(validateAnchor('{a,b').ok).toBe(false)
    expect(validateAnchor('../x').ok).toBe(false)
  })
})

describe('linear-time matching', () => {
  it('a pathological anchor against a 256-character path stays under 5 ms', () => {
    const anchor = '*?*?*?*?*?*?#'
    const path = 'a'.repeat(256)
    globMatches(anchor, path) // warm the parse cache
    const start = performance.now()
    for (let i = 0; i < 10; i++) expect(globMatches(anchor, path)).toBe(false)
    expect((performance.now() - start) / 10).toBeLessThan(5)
  })
  it('many ** against a deep path', () => {
    const anchor = '**/a/**/a/**/a/**/b'
    const path = Array.from({ length: 120 }, () => 'a').join('/')
    const start = performance.now()
    expect(globMatches(anchor, path)).toBe(false)
    expect(performance.now() - start).toBeLessThan(5)
  })
})
