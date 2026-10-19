import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitAnchors, gitDiffNames, gitPrefix, gitStatusPaths, relativeToRoot } from './git.js'
import { gitCommitAll, makeRepo, writeFile } from './testing/harness.js'

describe('relativeToRoot', () => {
  it('keeps paths at the top level unchanged and strips the prefix below it', () => {
    expect(relativeToRoot(['a.ts', 'pkg/b.ts'], '')).toEqual(['a.ts', 'pkg/b.ts'])
    expect(relativeToRoot(['pkg/b.ts', 'other/c.ts', 'pkg', 'pkgx/d.ts', 'pkg/'], 'pkg/')).toEqual(['b.ts'])
  })
})

// deviations H11: the CLI's root (nearest .git or .claude) can be a subdirectory of the git work tree
describe('git paths when the repo root is below the git top level', () => {
  function monorepo() {
    const top = makeRepo({
      git: true,
      files: { 'other/x.ts': 'x', 'pkg/src/a.ts': 'a', 'pkg/.claude/k': '' },
    })
    gitCommitAll(top)
    return { top, root: join(top, 'pkg') }
  }

  it('gitPrefix names the subdirectory, empty at the top, undefined outside a repo', async () => {
    const { top, root } = monorepo()
    expect(await gitPrefix(top)).toBe('')
    expect(await gitPrefix(root)).toBe('pkg/')
    expect(await gitPrefix(makeRepo())).toBeUndefined()
  })

  it('status, diff and anchors are relative to the root and skip files outside it', async () => {
    const { top, root } = monorepo()
    writeFile(top, 'pkg/src/a.ts', 'changed')
    writeFile(top, 'pkg/src/new.ts', 'new')
    writeFile(top, 'other/x.ts', 'changed')
    writeFile(top, 'other/new.ts', 'new')
    expect((await gitStatusPaths(root)).sort()).toEqual(['src/a.ts', 'src/new.ts'])
    expect(await gitDiffNames(root, 'HEAD')).toEqual(['src/a.ts'])
    expect(await gitAnchors(root, 20)).toEqual(['src/a.ts', 'src/new.ts'])

    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: top, encoding: 'utf8' }).trim()
    gitCommitAll(top, 'more')
    expect((await gitDiffNames(root, `${head}..HEAD`)).sort()).toEqual(['src/a.ts', 'src/new.ts'])
    // the top level itself still sees everything
    expect((await gitDiffNames(top, `${head}..HEAD`)).sort()).toEqual([
      'other/new.ts',
      'other/x.ts',
      'pkg/src/a.ts',
      'pkg/src/new.ts',
    ])
  })

  it('outside a git repository every helper is empty', async () => {
    const dir = makeRepo({ files: { 'a.ts': 'a' } })
    expect(await gitStatusPaths(dir)).toEqual([])
    expect(await gitDiffNames(dir, 'HEAD')).toEqual([])
    expect(await gitAnchors(dir, 20)).toEqual([])
  })
})
