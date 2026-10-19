/**
 * Hardened zip reading and plain zip writing (auth-and-security.md section 9).
 *
 * Reading never trusts fflate for safety: the central directory is parsed here, every limit is checked on
 * the DECLARED sizes before anything is inflated, and each entry is then inflated with `node:zlib` under
 * `maxOutputLength` = the declared size, so a lying header cannot grow memory past the cap. The result must
 * have exactly the declared size and the central-directory CRC-32 (`zlib.crc32`). Nothing touches the disk;
 * entries go to memory and then to the database.
 */

import { posix } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { zipSync } from 'fflate'
import { invalidArchive, shortName, zipLimits } from './errors.js'

export const ZIP_LIMITS = {
  maxEntries: 20_000,
  maxEntryBytes: 5 * 1024 * 1024,
  /** `manifest.json` is allowed to be larger (data-model.md section 8: at most 20 MB). */
  maxManifestBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
} as const

const SIG_EOCD = 0x06054b50
const SIG_CD = 0x02014b50
const SIG_LOCAL = 0x04034b50

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Why an entry name is unsafe, or `null` when it is fine (directory entries: pass the name without `/`). */
export function entryNameProblem(name: string): string | null {
  if (name === '') return 'empty name'
  if (name.includes('\\')) return 'backslash in name'
  if (name.includes('\0')) return 'NUL in name'
  if (/^[A-Za-z]:/.test(name)) return 'drive letter in name'
  if (name.startsWith('/')) return 'absolute path'
  for (const seg of name.split('/')) {
    if (seg === '') return 'empty path segment'
    if (seg === '.' || seg === '..') return 'dot segment in path'
  }
  if (posix.normalize(name) !== name) return 'path is not normalised'
  return null
}

interface CdEntry {
  name: string
  flags: number
  method: number
  crc: number
  csize: number
  usize: number
  localOffset: number
}

function u16(b: Uint8Array, o: number): number {
  return (b[o] as number) | ((b[o + 1] as number) << 8)
}
function u32(b: Uint8Array, o: number): number {
  return (
    ((b[o] as number) |
      ((b[o + 1] as number) << 8) |
      ((b[o + 2] as number) << 16) |
      ((b[o + 3] as number) << 24)) >>>
    0
  )
}

function findEocd(buf: Uint8Array): number {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) === SIG_EOCD && i + 22 + u16(buf, i + 20) === buf.length) return i
  }
  throw invalidArchive('Not a zip file (no end-of-central-directory record).')
}

/**
 * Read every file entry of `buf`. `allow` decides which names are acceptable; any other name rejects the
 * whole archive. Directory entries are skipped. Returns name to content in archive order.
 */
export function readZip(buf: Uint8Array, allow: (name: string) => boolean): Map<string, Uint8Array> {
  if (buf.length < 22) throw invalidArchive('Not a zip file (too short).')
  const eocd = findEocd(buf)
  const disk = u16(buf, eocd + 4)
  const cdDisk = u16(buf, eocd + 6)
  const total = u16(buf, eocd + 10)
  const onDisk = u16(buf, eocd + 8)
  const cdSize = u32(buf, eocd + 12)
  const cdOffset = u32(buf, eocd + 16)
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total)
    throw invalidArchive('Multi-disk zip files are not supported.')
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw invalidArchive('Zip64 archives are not supported.')
  }
  if (total > ZIP_LIMITS.maxEntries)
    throw zipLimits(`The archive has more than ${ZIP_LIMITS.maxEntries} entries.`)
  if (cdOffset + cdSize > eocd) throw invalidArchive('The central directory is out of bounds.')

  // 1. central directory: structure, names, declared sizes. Nothing is inflated yet.
  const entries: CdEntry[] = []
  const seen = new Set<string>()
  let p = cdOffset
  let declared = 0
  for (let i = 0; i < total; i++) {
    if (p + 46 > cdOffset + cdSize || u32(buf, p) !== SIG_CD)
      throw invalidArchive('Corrupt central directory.')
    const flags = u16(buf, p + 8)
    const method = u16(buf, p + 10)
    const crc = u32(buf, p + 16)
    const csize = u32(buf, p + 20)
    const usize = u32(buf, p + 24)
    const nlen = u16(buf, p + 28)
    const elen = u16(buf, p + 30)
    const clen = u16(buf, p + 32)
    const localOffset = u32(buf, p + 42)
    const end = p + 46 + nlen + elen + clen
    if (end > cdOffset + cdSize) throw invalidArchive('Corrupt central directory.')
    let name: string
    try {
      name = utf8.decode(buf.subarray(p + 46, p + 46 + nlen))
    } catch {
      throw invalidArchive('An entry name is not valid UTF-8.')
    }
    p = end
    const isDir = name.endsWith('/')
    const problem = entryNameProblem(isDir ? name.slice(0, -1) : name)
    if (problem)
      throw invalidArchive(`Unsafe entry name: ${problem}.`, [{ path: shortName(name), message: problem }])
    if (isDir) continue // directory entries carry no data
    if (seen.has(name))
      throw invalidArchive('Duplicate entry name.', [{ path: shortName(name), message: 'duplicate' }])
    seen.add(name)
    if (!allow(name)) {
      throw invalidArchive('The archive contains an entry that is not allowed.', [
        { path: shortName(name), message: 'name not in the allowlist' },
      ])
    }
    if (flags & 0x1)
      throw invalidArchive('Encrypted entries are not supported.', [
        { path: shortName(name), message: 'encrypted' },
      ])
    if (method !== 0 && method !== 8) {
      throw invalidArchive('Unsupported compression method.', [
        { path: shortName(name), message: `method ${method}` },
      ])
    }
    if (csize === 0xffffffff || usize === 0xffffffff) throw invalidArchive('Zip64 entries are not supported.')
    const cap = name === 'manifest.json' ? ZIP_LIMITS.maxManifestBytes : ZIP_LIMITS.maxEntryBytes
    if (usize > cap) throw zipLimits(`An entry declares more than ${cap} bytes.`)
    declared += usize
    if (declared > ZIP_LIMITS.maxTotalBytes)
      throw zipLimits(`The archive declares more than ${ZIP_LIMITS.maxTotalBytes} bytes in total.`)
    entries.push({ name, flags, method, crc, csize, usize, localOffset })
  }
  if (p !== cdOffset + cdSize) throw invalidArchive('Corrupt central directory (size mismatch).')

  // 2. local headers: bounds, same name, no overlapping data
  const ranges: [number, number][] = []
  const located = entries.map((e) => {
    const lo = e.localOffset
    if (lo + 30 > cdOffset || u32(buf, lo) !== SIG_LOCAL) {
      throw invalidArchive('Corrupt local header.', [
        { path: shortName(e.name), message: 'bad local header' },
      ])
    }
    const nlen = u16(buf, lo + 26)
    const elen = u16(buf, lo + 28)
    const start = lo + 30 + nlen + elen
    const end = start + e.csize
    if (end > cdOffset || end > buf.length) {
      throw invalidArchive('Entry data is out of bounds.', [
        { path: shortName(e.name), message: 'out of bounds' },
      ])
    }
    let local: string
    try {
      local = utf8.decode(buf.subarray(lo + 30, lo + 30 + nlen))
    } catch {
      throw invalidArchive('An entry name is not valid UTF-8.')
    }
    if (local !== e.name) {
      throw invalidArchive('Local and central entry names differ.', [
        { path: shortName(e.name), message: 'name mismatch' },
      ])
    }
    ranges.push([lo, end])
    return { e, start, end }
  })
  ranges.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < ranges.length; i++) {
    if ((ranges[i] as [number, number])[0] < (ranges[i - 1] as [number, number])[1]) {
      throw invalidArchive('Overlapping entries.')
    }
  }

  // 3. inflate each entry under its declared size; verify length and CRC-32
  const out = new Map<string, Uint8Array>()
  for (const { e, start, end } of located) {
    const data = buf.subarray(start, end)
    let content: Uint8Array
    if (e.method === 0) {
      if (e.csize !== e.usize)
        throw invalidArchive('Stored entry size mismatch.', [
          { path: shortName(e.name), message: 'size mismatch' },
        ])
      content = data
    } else {
      try {
        content = inflateRawSync(data, { maxOutputLength: Math.max(1, e.usize) })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        const msg =
          code === 'ERR_BUFFER_TOO_LARGE' ? 'inflates to more than the declared size' : 'corrupt deflate data'
        throw invalidArchive(`Entry cannot be inflated: ${msg}.`, [{ path: shortName(e.name), message: msg }])
      }
    }
    if (content.length !== e.usize) {
      throw invalidArchive('Entry size differs from the declared size.', [
        { path: shortName(e.name), message: 'size mismatch' },
      ])
    }
    if (crc32(content) !== e.crc) {
      throw invalidArchive('Entry CRC-32 mismatch.', [{ path: shortName(e.name), message: 'crc mismatch' }])
    }
    out.set(e.name, new Uint8Array(content))
  }
  return out
}

/** Zip `files` (name to bytes). Names are written as given; the caller keeps them to the allowlist. */
export function writeZip(files: Record<string, Uint8Array>, mtime: Date): Uint8Array {
  return zipSync(files, { level: 6, mtime })
}
