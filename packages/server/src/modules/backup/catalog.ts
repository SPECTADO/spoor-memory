/**
 * The backup directory is the catalog (ADR-0038): no DB table, so a full restore can never rewind the list.
 *
 *   <SPOOR_BACKUP_DIR>/backups/<id>/{backup.json, database.dump, projects/<slug>.zip}
 *   <SPOOR_BACKUP_DIR>/.tmp/<id>/        a bundle being written (swept after 24 h)
 *
 * A directory is a bundle only when its name is a backup id and its backup.json parses and names the same id;
 * anything else is never listed, never pruned and never deleted by the app. Every path is built from an id
 * that passed `isBackupId` (no traversal). Directories are 0700, files 0600.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { type BackupManifest, backupManifestSchema, isBackupId } from '@spoor/shared'

export const BACKUPS_DIR = 'backups'
export const TMP_DIR = '.tmp'
export const MANIFEST_FILE = 'backup.json'
export const DUMP_FILE = 'database.dump'
export const PROJECTS_DIR = 'projects'
/** A `.tmp/<id>` left by a crashed run is removed after this long. */
export const TMP_MAX_AGE_MS = 24 * 3_600_000

export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

/** One bundle of the catalog. */
export interface BundleEntry {
  id: string
  /** Absolute directory of the bundle. */
  dir: string
  manifest: BackupManifest
  /** Sum of the manifest's files. */
  sizeBytes: number
}

export const backupsDir = (root: string) => join(root, BACKUPS_DIR)
export const tmpDir = (root: string) => join(root, TMP_DIR)

/** The directory of a bundle; throws on anything that is not a backup id (callers 404 before). */
export function bundleDir(root: string, id: string): string {
  if (!isBackupId(id)) throw new Error('not a backup id')
  return join(root, BACKUPS_DIR, id)
}

export function tmpBundleDir(root: string, id: string): string {
  if (!isBackupId(id)) throw new Error('not a backup id')
  return join(root, TMP_DIR, id)
}

/** Create `backups/` and `.tmp/` (0700). Throws when the directory is not writable. */
export async function ensureLayout(root: string): Promise<void> {
  await mkdir(backupsDir(root), { recursive: true, mode: DIR_MODE })
  await mkdir(tmpDir(root), { recursive: true, mode: DIR_MODE })
}

/** Parse a bundle's backup.json; null when it is missing, invalid or names another id. */
export async function readManifest(dir: string, id: string): Promise<BackupManifest | null> {
  let text: string
  try {
    text = await readFile(join(dir, MANIFEST_FILE), 'utf8')
  } catch {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = backupManifestSchema.safeParse(raw)
  if (!parsed.success || parsed.data.id !== id) return null
  return parsed.data
}

const sizeOf = (m: BackupManifest) => m.files.reduce((n, f) => n + f.size, 0)

/** One bundle by id; null for a non-id, a missing directory or an invalid backup.json. */
export async function readBundle(root: string, id: string): Promise<BundleEntry | null> {
  if (!isBackupId(id)) return null
  const dir = bundleDir(root, id)
  const manifest = await readManifest(dir, id)
  if (!manifest) return null
  return { id, dir, manifest, sizeBytes: sizeOf(manifest) }
}

/** Every valid bundle, newest first. A missing `backups/` is an empty catalog. */
export async function listBundles(root: string): Promise<BundleEntry[]> {
  let names: string[]
  try {
    names = await readdir(backupsDir(root))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const entries = await Promise.all(names.filter(isBackupId).map((id) => readBundle(root, id)))
  return entries
    .filter((e): e is BundleEntry => e !== null)
    .sort(
      (a, b) =>
        Date.parse(b.manifest.created_at) - Date.parse(a.manifest.created_at) || (a.id < b.id ? 1 : -1),
    )
}

/** fsync a file or a directory (durability of a rename needs the parent directory synced). */
export async function fsyncPath(path: string): Promise<void> {
  const fh = await open(path, 'r')
  try {
    await fh.sync()
  } catch (err) {
    // some file systems refuse fsync on a directory; the data files themselves were synced
    if ((err as NodeJS.ErrnoException).code !== 'EINVAL' && (err as NodeJS.ErrnoException).code !== 'EISDIR')
      throw err
  } finally {
    await fh.close()
  }
}

/** Replace a bundle's backup.json atomically: a sibling temp file, fsync, rename, fsync of the directory. */
export async function writeManifest(dir: string, manifest: BackupManifest): Promise<void> {
  const checked = backupManifestSchema.parse(manifest)
  const tmp = join(dir, `.${MANIFEST_FILE}.${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(tmp, `${JSON.stringify(checked, null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' })
    await fsyncPath(tmp)
    await rename(tmp, join(dir, MANIFEST_FILE))
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
  await fsyncPath(dir)
}

/** Remove a bundle directory (the caller checked it is a valid bundle). */
export async function removeBundle(root: string, id: string): Promise<void> {
  await rm(bundleDir(root, id), { recursive: true, force: true })
}

/** Remove `.tmp/*` entries older than `maxAgeMs` (crashed runs). Returns the removed names. */
export async function sweepTmp(root: string, now: Date, maxAgeMs = TMP_MAX_AGE_MS): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(tmpDir(root))
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    const p = join(tmpDir(root), name)
    try {
      const st = await stat(p)
      if (now.getTime() - st.mtimeMs > maxAgeMs) {
        await rm(p, { recursive: true, force: true })
        removed.push(name)
      }
    } catch {
      // vanished meanwhile
    }
  }
  return removed
}

/** Free bytes for an unprivileged writer on the volume of `path`; null when unknown. */
export async function freeBytes(path: string): Promise<number | null> {
  try {
    const s = await statfs(path)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** sha256 (hex) and size of a file, streamed. */
export async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256')
  let size = 0
  await pipeline(createReadStream(path), async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      size += chunk.length
      hash.update(chunk)
    }
  })
  return { sha256: hash.digest('hex'), size }
}
