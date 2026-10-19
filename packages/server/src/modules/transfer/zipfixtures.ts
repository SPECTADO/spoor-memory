/** Test helper: build zip files by hand so tests can lie in headers (declared sizes, CRC, names, flags). */
import { crc32, deflateRawSync } from 'node:zlib'

export interface RawEntry {
  name: string
  /** Uncompressed content (default empty). */
  data?: Uint8Array
  /** 0 stored, 8 deflate (default 0). */
  method?: number
  flags?: number
  /** Override what the central directory declares. */
  crc?: number
  usize?: number
  csize?: number
  /** Name written in the local header (default = name). */
  localName?: string
  /** Bytes written as the entry data instead of `data` (already compressed for method 8). */
  rawData?: Uint8Array
}

const enc = new TextEncoder()

function le16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff]
}
function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}

export function rawZip(
  entries: RawEntry[],
  opts: { eocdTotal?: number; cdOffsetOverride?: number } = {},
): Uint8Array {
  const parts: Uint8Array[] = []
  const cd: Uint8Array[] = []
  let offset = 0
  const push = (a: ArrayLike<number>) => {
    const u = Uint8Array.from(a as number[])
    parts.push(u)
    offset += u.length
  }
  for (const e of entries) {
    const data = e.data ?? new Uint8Array(0)
    const method = e.method ?? 0
    const body = e.rawData ?? (method === 8 ? deflateRawSync(data) : data)
    const name = enc.encode(e.name)
    const localName = enc.encode(e.localName ?? e.name)
    const crc = e.crc ?? crc32(data)
    const csize = e.csize ?? body.length
    const usize = e.usize ?? data.length
    const flags = e.flags ?? 0x0800
    const localOffset = offset
    push([
      ...le32(0x04034b50),
      ...le16(20),
      ...le16(flags),
      ...le16(method),
      ...le16(0),
      ...le16(0x21),
      ...le32(crc),
      ...le32(csize),
      ...le32(usize),
      ...le16(localName.length),
      ...le16(0),
      ...localName,
    ])
    push(body)
    cd.push(
      Uint8Array.from([
        ...le32(0x02014b50),
        ...le16(20),
        ...le16(20),
        ...le16(flags),
        ...le16(method),
        ...le16(0),
        ...le16(0x21),
        ...le32(crc),
        ...le32(csize),
        ...le32(usize),
        ...le16(name.length),
        ...le16(0),
        ...le16(0),
        ...le16(0),
        ...le16(0),
        ...le32(0),
        ...le32(localOffset),
        ...name,
      ]),
    )
  }
  const cdOffset = offset
  for (const c of cd) push(c)
  const cdSize = offset - cdOffset
  const total = opts.eocdTotal ?? entries.length
  push([
    ...le32(0x06054b50),
    ...le16(0),
    ...le16(0),
    ...le16(total),
    ...le16(total),
    ...le32(cdSize),
    ...le32(opts.cdOffsetOverride ?? cdOffset),
    ...le16(0),
  ])
  const out = new Uint8Array(offset)
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}
