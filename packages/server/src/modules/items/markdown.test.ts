import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FrontmatterError } from '@spoor/shared'
import { describe, expect, it } from 'vitest'
import {
  canonicalFrontmatter,
  dateFromSection,
  firstH1,
  humanizeFileName,
  numberFromFileName,
  numberFromH1,
  statusFromSection,
  stripAdrPrefix,
  validateFrontmatter,
} from './markdown.js'

describe('validateFrontmatter / canonicalFrontmatter', () => {
  it('validates per space and reports paths', () => {
    expect(validateFrontmatter('decisions', { adr: 7, status: 'accepted' })).toMatchObject({
      adr: 7,
      tags: [],
    })
    try {
      validateFrontmatter('decisions', { status: 'maybe' })
      expect.unreachable()
    } catch (e) {
      expect((e as FrontmatterError).issues[0]?.path).toBe('frontmatter.status')
    }
  })
  it('canonical order: common keys, space keys, extras', () => {
    const fm = canonicalFrontmatter({
      id: 'id',
      space: 'decisions',
      title: 'T',
      tags: [],
      anchors: [],
      type: null,
      confidence: null,
      status: 'accepted',
      adrNumber: 7,
      decidedOn: '2026-10-19',
      extras: { z: 1 },
    })
    expect(Object.keys(fm)).toEqual(['spoor_id', 'title', 'tags', 'anchors', 'adr', 'status', 'date', 'z'])
  })
})

describe('ADR file conventions', () => {
  it('numbers from file name and H1', () => {
    expect(numberFromFileName('docs/adr/0007-use-postgres.md')).toBe(7)
    expect(numberFromFileName('docs/adr/use-postgres.md')).toBeNull()
    expect(numberFromH1('ADR-0012: Something')).toBe(12)
    expect(numberFromH1('3. Use X')).toBe(3)
    expect(numberFromH1('Use X')).toBeNull()
  })
  it('titles: H1 without ADR prefix, else the humanised file name', () => {
    expect(firstH1('```\n# not\n```\n# Real title\n')).toBe('Real title')
    expect(stripAdrPrefix('ADR-0007: Use Postgres')).toBe('Use Postgres')
    expect(stripAdrPrefix('7. Use Postgres')).toBe('Use Postgres')
    expect(humanizeFileName('docs/adr/0007-use-postgres.md', 'decisions')).toBe('Use postgres')
    expect(humanizeFileName('ARCHITECTURE.md', 'docs')).toBe('ARCHITECTURE')
  })
  it('status sections (MADR / adr-tools)', () => {
    expect(statusFromSection('# T\n\n## Status\n\nAccepted\n')).toEqual({
      status: 'accepted',
      original: null,
      supersededBy: null,
    })
    expect(statusFromSection('## Status\n\nRejected because…')).toMatchObject({
      status: 'deprecated',
      original: 'rejected',
    })
    expect(statusFromSection('## Status: Superseded by ADR-0009')).toEqual({
      status: 'superseded',
      original: null,
      supersededBy: 'ADR-0009',
    })
    expect(statusFromSection('* Status: proposed')).toMatchObject({ status: 'proposed' })
  })

  it('reads bold-bullet and emphasised headers (MADR, this repo’s own ADRs; review-log-phase5 D3)', () => {
    expect(
      statusFromSection('# Old\n\n- **Status:** Superseded by ADR-0013\n- **Date:** 2026-01-02\n'),
    ).toEqual({
      status: 'superseded',
      original: null,
      supersededBy: 'ADR-0013',
    })
    expect(statusFromSection('**Status**: Proposed\n')).toMatchObject({ status: 'proposed' })
    expect(statusFromSection('- __Status:__ Deprecated\n')).toMatchObject({ status: 'deprecated' })
    expect(statusFromSection('Status: Deprecated\n')).toMatchObject({ status: 'deprecated' })
    expect(statusFromSection('## **Status**\n\nAccepted\n')).toMatchObject({ status: 'accepted' })
    // every ADR of this repository parses to the status its header says
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../../../docs/adr')
    for (const f of readdirSync(dir).filter((n) => /^\d{4}-.*\.md$/.test(n))) {
      const text = readFileSync(join(dir, f), 'utf8')
      const said = /^- \*\*Status:\*\* (\w+)/m.exec(text)?.[1]?.toLowerCase()
      expect(said, f).toBeDefined()
      expect(statusFromSection(text)?.status, f).toBe(said)
      expect(dateFromSection(text), f).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('dateFromSection: a real YYYY-MM-DD from a Date line or section, else null (D5)', () => {
    expect(dateFromSection('- **Date:** 2026-10-19\n')).toBe('2026-10-19')
    expect(dateFromSection('Date: 2026-10-19 (updated)\n')).toBe('2026-10-19')
    expect(dateFromSection('## Date\n\n2025-02-28\n')).toBe('2025-02-28')
    expect(dateFromSection('Date: 2026-02-30\n')).toBeNull()
    expect(dateFromSection('Date: soon\n')).toBeNull()
    expect(dateFromSection('```\nDate: 2026-10-19\n```\n')).toBeNull()
    expect(dateFromSection('# T\n')).toBeNull()
    expect(statusFromSection('# T\n\nno status here')).toBeNull()
  })
})
