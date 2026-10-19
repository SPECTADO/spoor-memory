// Builds the published CLI (ADR 0013): one ESM file, dist/bin.js, with @spoor/shared bundled in from its TypeScript
// source. The runtime dependencies in package.json (yaml, zod) stay external, so npm installs them; nothing else may
// be imported at runtime. `--watch` rebuilds on change.
import { chmodSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build, context } from 'esbuild'

const dir = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const pkg = JSON.parse(readFileSync(dir('../package.json'), 'utf8'))
const outfile = dir('../dist/bin.js')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [dir('../src/bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // workspace code is compiled in from source; the declared runtime dependencies are not
  alias: { '@spoor/shared': dir('../../shared/src/index.ts') },
  external: Object.keys(pkg.dependencies ?? {}),
  logLevel: 'warning',
  plugins: [
    {
      name: 'executable',
      setup(b) {
        b.onEnd((r) => {
          if (r.errors.length === 0) chmodSync(outfile, 0o755)
        })
      },
    },
  ],
}

rmSync(dir('../dist'), { recursive: true, force: true })
if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('spoor-memory: watching src/ and ../shared/src/')
} else {
  await build(options)
}
