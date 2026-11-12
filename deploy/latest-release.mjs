#!/usr/bin/env node
// Writes deploy/latest-release.json, the file every Spoor server's update check reads from main
// (docs/operations.md "Update check", "Releasing"). The release workflow's `latest` job runs it with what is really
// published, and the file is written only when the npm package and the GHCR image both carry the tag's version:
// a half-published release is never announced.
//
//   node deploy/latest-release.mjs --version 0.7.0 --npm "$(npm view spoor-memory dist-tags.latest)" \
//     --image 0.7.0 [--released-at 2026-11-12T10:00:00Z] [--out deploy/latest-release.json]
//
// --image is the version whose image tag exists (empty when it does not). Exit 0: written, unchanged or skipped
// (the reason is printed); exit 1: bad arguments. No dependencies: it runs before `pnpm install`.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const REPO = 'SPECTADO/spoor-memory'
const STABLE_RE = /^\d+\.\d+\.\d+$/

const isStable = (v) => typeof v === 'string' && STABLE_RE.test(v) && v !== '0.0.0'

/** Problems with a parsed file (schema 1); empty when it is valid. The server checks the same rules. */
export function validate(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return ['not an object']
  const problems = []
  if (file.schema !== 1) problems.push('schema must be 1')
  for (const k of ['version', 'npm', 'image']) {
    if (!isStable(file[k])) problems.push(`${k} must be a stable x.y.z release`)
  }
  if (file.npm !== file.version || file.image !== file.version)
    problems.push('npm and image must equal version')
  if (typeof file.released_at !== 'string' || Number.isNaN(Date.parse(file.released_at)))
    problems.push('released_at must be an ISO date')
  if (typeof file.url !== 'string' || !file.url.startsWith('https://github.com/SPECTADO/'))
    problems.push('url must be on https://github.com/SPECTADO/')
  return problems
}

/**
 * The file for `version`, or why there is none: a pre-release, or npm / the image not (yet) at this version.
 * `previous` is the current file: re-running for the same version keeps its `released_at`, so nothing changes.
 */
export function latestRelease({ version, npm, image, releasedAt, previous }) {
  if (!isStable(version)) return { skip: `${version} is not a stable x.y.z release` }
  if (npm !== version) return { skip: `npm latest is ${npm || 'unknown'}, not ${version}` }
  if (image !== version) return { skip: `the image ${version} is not on GHCR` }
  const keep = previous && previous.version === version && validate(previous).length === 0
  const file = {
    schema: 1,
    version,
    npm,
    image,
    released_at: keep ? previous.released_at : (releasedAt ?? new Date().toISOString()),
    url: `https://github.com/${REPO}/releases/tag/v${version}`,
  }
  const problems = validate(file)
  if (problems.length > 0) return { skip: problems.join('; ') }
  return { file }
}

export const fileText = (file) => `${JSON.stringify(file, null, 2)}\n`

function readPrevious(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: 'string' },
      npm: { type: 'string', default: '' },
      image: { type: 'string', default: '' },
      'released-at': { type: 'string' },
      out: { type: 'string', default: fileURLToPath(new URL('latest-release.json', import.meta.url)) },
    },
  })
  if (!values.version) {
    log('usage: latest-release.mjs --version x.y.z --npm <npm latest> --image <image version> [--out file]')
    return 1
  }
  const out = resolve(values.out)
  const previous = readPrevious(out)
  const r = latestRelease({
    version: values.version.replace(/^v/, ''),
    npm: values.npm.trim(),
    image: values.image.trim(),
    releasedAt: values['released-at'],
    previous,
  })
  if (r.skip) {
    log(`latest-release.json not written: ${r.skip}`)
    return 0
  }
  const text = fileText(r.file)
  if (previous && fileText(previous) === text) {
    log(`latest-release.json already says ${r.file.version}`)
    return 0
  }
  writeFileSync(out, text)
  log(`latest-release.json now says ${r.file.version}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main())
