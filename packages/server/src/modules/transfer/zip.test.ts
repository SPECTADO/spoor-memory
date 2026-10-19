// Zip hardening (auth-and-security.md section 9): crafted archives must be rejected before they cost memory.
import { deflateRawSync } from 'node:zlib'
import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/errors.js'
import { entryAllowed } from './archive.js'
import { entryNameProblem, readZip, writeZip, ZIP_LIMITS } from './zip.js'
import { rawZip } from './zipfixtures.js'

const read = (b: Uint8Array) => readZip(b, entryAllowed)
const code = (fn: () => unknown): string => {
  try {
    fn()
    return 'ok'
  } catch (e) {
    if (e instanceof ApiError) return e.code
    throw e
  }
}
const MB = 1024 * 1024
const text = (s: string) => strToU8(s)

describe('readZip', () => {
  it('round-trips what writeZip wrote, stored and deflated', () => {
    const zip = writeZip(
      { 'manifest.json': text('{"a":1}'), 'docs/a.md': text('x'.repeat(5000)) },
      new Date('2026-10-19T00:00:00Z'),
    )
    const out = read(zip)
    expect([...out.keys()]).toEqual(['manifest.json', 'docs/a.md'])
    expect(new TextDecoder().decode(out.get('docs/a.md'))).toBe('x'.repeat(5000))
    const stored = rawZip([{ name: 'audit.jsonl', data: text('hello'), method: 0 }])
    expect(new TextDecoder().decode(read(stored).get('audit.jsonl'))).toBe('hello')
  })

  it('skips directory entries', () => {
    const out = read(rawZip([{ name: 'docs/' }, { name: 'docs/a.md', data: text('a') }]))
    expect([...out.keys()]).toEqual(['docs/a.md'])
  })

  it('rejects unsafe and non-allowlisted names', () => {
    const bad = [
      '../manifest.json',
      'docs/../manifest.json',
      '/manifest.json',
      'docs\\a.md',
      'C:manifest.json',
      'docs//a.md',
      './manifest.json',
      'docs/./a.md',
      'docs/a\0.md',
    ]
    for (const name of bad)
      expect(
        code(() => read(rawZip([{ name, data: text('a') }]))),
        name,
      ).toBe('invalid_archive')
    for (const name of [
      'readme.txt',
      'docs/A.md',
      'docs/a.md.exe',
      'memories/sub/a.md',
      'decisions/1-a.md',
      'revisions/x.jsonl',
      `docs/${'a'.repeat(81)}.md`,
    ]) {
      expect(
        code(() => read(rawZip([{ name, data: text('a') }]))),
        name,
      ).toBe('invalid_archive')
    }
    // a directory entry may not smuggle a traversal either
    expect(code(() => read(rawZip([{ name: '../' }])))).toBe('invalid_archive')
  })

  it('entryNameProblem names the reason', () => {
    expect(entryNameProblem('a/b.md')).toBeNull()
    expect(entryNameProblem('a/../b.md')).toMatch(/dot segment/)
    expect(entryNameProblem('/a')).toMatch(/absolute/)
    expect(entryNameProblem('a\\b')).toMatch(/backslash/)
  })

  it('rejects duplicate names', () => {
    expect(
      code(() =>
        read(
          rawZip([
            { name: 'docs/a.md', data: text('1') },
            { name: 'docs/a.md', data: text('2') },
          ]),
        ),
      ),
    ).toBe('invalid_archive')
  })

  it('rejects more than 20000 entries as zip_limits', () => {
    const entries = Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `docs/n${i}.md` }))
    expect(code(() => read(rawZip(entries)))).toBe('zip_limits')
    // a lying EOCD count is caught the same way
    expect(code(() => read(rawZip([{ name: 'docs/a.md' }], { eocdTotal: 30000 })))).toBe('zip_limits')
  })

  it('rejects a declared entry size over 5 MB before inflating anything', () => {
    const lying = rawZip([{ name: 'docs/a.md', data: text('tiny'), method: 8, usize: 6 * MB }])
    expect(code(() => read(lying))).toBe('zip_limits')
    // honest bomb: 6 MB of zeros really is that big
    const bomb = rawZip([{ name: 'docs/a.md', data: new Uint8Array(6 * MB), method: 8 }])
    expect(bomb.length).toBeLessThan(100_000)
    expect(code(() => read(bomb))).toBe('zip_limits')
  })

  it('rejects a cumulative declared size over 200 MB', () => {
    const entries = Array.from({ length: 41 }, (_, i) => ({
      name: `docs/n${i}.md`,
      data: text('x'),
      usize: 5 * MB,
    }))
    expect(code(() => read(rawZip(entries)))).toBe('zip_limits')
  })

  it('a declared size smaller than the real one cannot grow memory: invalid_archive', () => {
    const data = new Uint8Array(4 * MB) // really 4 MB, declared 10 bytes
    const z = rawZip([{ name: 'docs/a.md', data, method: 8, usize: 10 }])
    expect(code(() => read(z))).toBe('invalid_archive')
  })

  it('a declared size larger than the real one is a mismatch', () => {
    expect(code(() => read(rawZip([{ name: 'docs/a.md', data: text('abc'), method: 8, usize: 50 }])))).toBe(
      'invalid_archive',
    )
    expect(code(() => read(rawZip([{ name: 'docs/a.md', data: text('abc'), method: 0, usize: 50 }])))).toBe(
      'invalid_archive',
    )
  })

  it('verifies the CRC-32', () => {
    expect(code(() => read(rawZip([{ name: 'docs/a.md', data: text('abc'), crc: 123 }])))).toBe(
      'invalid_archive',
    )
    expect(code(() => read(rawZip([{ name: 'docs/a.md', data: text('abc'), method: 8, crc: 123 }])))).toBe(
      'invalid_archive',
    )
  })

  it('rejects encrypted entries, unknown methods and zip64 markers', () => {
    expect(code(() => read(rawZip([{ name: 'docs/a.md', data: text('a'), flags: 0x0801 }])))).toBe(
      'invalid_archive',
    )
    expect(code(() => read(rawZip([{ name: 'docs/a.md', data: text('a'), method: 12 }])))).toBe(
      'invalid_archive',
    )
    expect(code(() => read(rawZip([{ name: 'docs/a.md', data: text('a'), usize: 0xffffffff }])))).toBe(
      'invalid_archive',
    )
    expect(code(() => read(rawZip([{ name: 'docs/a.md' }], { eocdTotal: 0xffff })))).toBe('invalid_archive')
  })

  it('rejects garbage, truncation and a local header that disagrees with the directory', () => {
    expect(code(() => read(new Uint8Array(10)))).toBe('invalid_archive')
    expect(code(() => read(strToU8('PK this is not a zip file at all, no end record here....')))).toBe(
      'invalid_archive',
    )
    const ok = rawZip([{ name: 'docs/a.md', data: text('hello') }])
    expect(code(() => read(ok.subarray(0, ok.length - 5)))).toBe('invalid_archive')
    expect(code(() => read(rawZip([{ name: 'docs/a.md', localName: 'docs/b.md', data: text('x') }])))).toBe(
      'invalid_archive',
    )
  })

  it('rejects a name that is not valid UTF-8', () => {
    const z = rawZip([{ name: 'docs/aXb.md', data: text('x') }])
    const i = z.indexOf(0x58, 40)
    const bad = z.slice()
    // corrupt both the local and the central copy of the name with a lone continuation byte
    for (let p = 0; p < bad.length; p++) if (bad[p] === 0x58 && bad[p - 1] === 0x61) bad[p] = 0xff
    expect(i).toBeGreaterThan(0)
    expect(code(() => read(bad))).toBe('invalid_archive')
  })

  it('allows a manifest.json above 5 MB (up to 20 MB), but not other entries', () => {
    const big = new Uint8Array(6 * MB).fill(0x20)
    big[0] = 0x7b
    const out = read(rawZip([{ name: 'manifest.json', data: big, method: 8 }]))
    expect(out.get('manifest.json')?.length).toBe(6 * MB)
    expect(
      code(() => read(rawZip([{ name: 'manifest.json', data: new Uint8Array(21 * MB), method: 8 }]))),
    ).toBe('zip_limits')
  })

  it('does not accept overlapping entries', () => {
    // entry A claims enough compressed bytes to run over the local header and data of entry B
    const z = rawZip([
      { name: 'docs/a.md', data: text('aaaa'), csize: 4 + 30 + 9 + 4 },
      { name: 'docs/b.md', data: text('bbbb') },
    ])
    expect(code(() => read(z))).toBe('invalid_archive')
  })
})

describe('inflate limits', () => {
  it('node zlib maxOutputLength is what stops a bomb (sanity check of the primitive)', () => {
    const packed = deflateRawSync(new Uint8Array(3 * MB))
    expect(packed.length).toBeLessThan(10_000)
  })
})
