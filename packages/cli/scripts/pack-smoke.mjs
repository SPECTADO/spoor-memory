// Packs spoor-memory exactly as it is published and proves the tarball works on its own (ADR 0013):
//   1. `pnpm pack` (rewrites workspace: ranges) and `npm pack --dry-run` both list only package.json, README.md,
//      LICENSE and dist/bin.js;
//   2. the packed package.json: same version as the source, bin, engines node >=22, exact runtime dependencies,
//      no `workspace:` range anywhere, LICENSE identical to the repo's;
//   3. the packed bin runs `--help` and `--version` outside the workspace, where @spoor/shared cannot resolve.
//      Default: the declared dependencies are linked from this package's node_modules (offline). `--install`: a real
//      `npm install <tarball>` into a temp prefix, running the installed `spoor` link (release workflow).
// Usage: node scripts/pack-smoke.mjs [--install] [--out DIR]   (run `pnpm build` first). With --out, keeps the tarball there and prints its path last.
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = join(pkgDir, '..', '..')
const args = process.argv.slice(2)
const install = args.includes('--install')
const outIdx = args.indexOf('--out')
const work = mkdtempSync(join(tmpdir(), 'spoor-pack-'))
const outDir = outIdx >= 0 ? args[outIdx + 1] : join(work, 'out')

const EXPECTED = ['LICENSE', 'README.md', 'dist/bin.js', 'package.json']
const failures = []
const check = (ok, msg) => {
  if (!ok) failures.push(msg)
}
const sh = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

const src = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
if (!existsSync(join(pkgDir, 'dist', 'bin.js'))) {
  console.error('pack-smoke: dist/bin.js is missing; run `pnpm --filter "spoor-memory..." build` first')
  process.exit(1)
}

try {
  // 1. file lists
  mkdirSync(outDir, { recursive: true })
  const tarball = join(outDir, `spoor-memory-${src.version}.tgz`)
  rmSync(tarball, { force: true })
  sh('pnpm', ['pack', '--pack-destination', outDir], { cwd: pkgDir })
  check(existsSync(tarball), `pnpm pack did not write ${tarball}`)
  const packed = sh('tar', ['-tzf', tarball])
    .split('\n')
    .filter((l) => l !== '' && !l.endsWith('/'))
    .map((l) => l.replace(/^package\//, ''))
    .sort()
  check(JSON.stringify(packed) === JSON.stringify(EXPECTED), `tarball files ${JSON.stringify(packed)}`)
  const dry = JSON.parse(sh('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkgDir }))
  const dryFiles = dry[0].files.map((f) => f.path).sort()
  check(
    JSON.stringify(dryFiles) === JSON.stringify(EXPECTED),
    `npm pack --dry-run files ${JSON.stringify(dryFiles)}`,
  )

  // 2. packed manifest and licence
  const extract = join(work, 'extract')
  mkdirSync(extract)
  sh('tar', ['-xzf', tarball, '-C', extract])
  const pkgRoot = join(extract, 'package')
  const manifestText = readFileSync(join(pkgRoot, 'package.json'), 'utf8')
  const m = JSON.parse(manifestText)
  check(m.name === 'spoor-memory', `name ${m.name}`)
  check(m.version === src.version, `version ${m.version} != source ${src.version}`)
  check(m.bin?.spoor === 'dist/bin.js', `bin ${JSON.stringify(m.bin)}`)
  check(m.engines?.node === '>=22', `engines ${JSON.stringify(m.engines)}`)
  check(m.license === 'MIT', `license ${m.license}`)
  check(!manifestText.includes('workspace:'), 'packed package.json still has a workspace: range')
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'])
    for (const [name, range] of Object.entries(m[field] ?? {}))
      check(/^\d+\.\d+\.\d+$/.test(range) && !name.startsWith('@spoor/'), `${field}.${name}: ${range}`)
  check(
    readFileSync(join(pkgRoot, 'LICENSE'), 'utf8') === readFileSync(join(repoRoot, 'LICENSE'), 'utf8'),
    'packages/cli/LICENSE differs from the repo LICENSE',
  )

  // 3. run the packed bin outside the workspace
  const app = join(work, 'app')
  let bin
  if (install) {
    mkdirSync(app)
    sh('npm', ['install', '--prefix', app, '--no-audit', '--no-fund', '--ignore-scripts', tarball], {
      cwd: app,
    })
    bin = join(app, 'node_modules', '.bin', 'spoor')
  } else {
    const nm = join(app, 'node_modules')
    mkdirSync(nm, { recursive: true })
    cpSync(pkgRoot, join(nm, 'spoor-memory'), { recursive: true }) // a copy: node resolves symlinks to real paths
    for (const dep of Object.keys(m.dependencies ?? {}))
      symlinkSync(realpathSync(join(pkgDir, 'node_modules', dep)), join(nm, dep), 'dir')
    bin = join(nm, 'spoor-memory', m.bin.spoor)
  }
  const env = { PATH: process.env.PATH, HOME: work }
  const help = sh(bin, ['--help'], { cwd: work, env })
  check(help.includes('Usage: spoor <command>'), `--help printed: ${help.slice(0, 200)}`)
  const version = sh(bin, ['--version'], { cwd: work, env }).trim()
  check(version === src.version, `--version printed ${version}, expected ${src.version}`)

  if (failures.length > 0) {
    console.error(`pack-smoke: FAILED\n- ${failures.join('\n- ')}`)
    process.exitCode = 1
  } else {
    console.log(`pack-smoke: ok (${install ? 'npm install' : 'linked dependencies'}; ${packed.join(', ')})`)
    if (outIdx >= 0) console.log(tarball)
  }
} catch (e) {
  console.error(`pack-smoke: ${e instanceof Error ? e.message : String(e)}`)
  if (e?.stderr) console.error(String(e.stderr))
  process.exitCode = 1
} finally {
  if (outIdx < 0) rmSync(work, { recursive: true, force: true })
  else rmSync(join(work, 'extract'), { recursive: true, force: true })
}
