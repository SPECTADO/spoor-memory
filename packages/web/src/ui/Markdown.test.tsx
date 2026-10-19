import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { parseWikilink } from '../lib/wikilinks'
import { renderInRouter } from '../test/utils'
import { MarkdownView } from './Markdown'

describe('parseWikilink', () => {
  it('splits ref, heading and label', () => {
    expect(parseWikilink('[[m42]]')).toEqual({ ref: 'm42', heading: null, label: 'm42' })
    expect(parseWikilink('[[ADR-0007|the ADR]]')).toEqual({
      ref: 'ADR-0007',
      heading: null,
      label: 'the ADR',
    })
    expect(parseWikilink('[[shared:style-guide#Naming]]')).toEqual({
      ref: 'shared:style-guide',
      heading: 'Naming',
      label: 'shared:style-guide#Naming',
    })
  })
})

describe('MarkdownView', () => {
  it('turns wikilinks into resolver links, leaving code alone', async () => {
    renderInRouter(
      <MarkdownView
        slug="acme"
        source={
          'See [[m42]], [[ADR-0007|the ADR]] and [[shared:style-guide]].\n\n`[[not-a-link]]`\n\n```\n[[nor-this]]\n```'
        }
      />,
    )
    expect(await screen.findByRole('link', { name: 'm42' })).toHaveAttribute('href', '/projects/acme/w/m42')
    expect(screen.getByRole('link', { name: 'the ADR' })).toHaveAttribute('href', '/projects/acme/w/ADR-0007')
    expect(screen.getByRole('link', { name: 'shared:style-guide' })).toHaveAttribute(
      'href',
      '/projects/acme/w/shared%3Astyle-guide',
    )
    expect(screen.getByRole('link', { name: 'm42' })).toHaveClass('wikilink')
    expect(screen.getByText('[[not-a-link]]').tagName).toBe('CODE')
    expect(screen.getByText('[[nor-this]]')).toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(3)
  })

  it('resolves shared-space wikilinks under /shared', async () => {
    renderInRouter(<MarkdownView slug="_shared" source="[[d3]]" />)
    expect(await screen.findByRole('link', { name: 'd3' })).toHaveAttribute('href', '/shared/w/d3')
  })

  it('renders GFM, opens external links in a new tab and drops javascript: URLs', async () => {
    renderInRouter(
      <MarkdownView
        slug="acme"
        source={
          '| a | b |\n|---|---|\n| 1 | 2 |\n\n[ext](https://example.com) [bad](javascript:alert(1)) [in](/projects/acme/memories) [doc](/p/acme/install.md)'
        }
      />,
    )
    expect(await screen.findByRole('table')).toBeInTheDocument()
    const ext = screen.getByRole('link', { name: 'ext' })
    expect(ext).toHaveAttribute('target', '_blank')
    expect(ext).toHaveAttribute('rel', 'noreferrer noopener')
    expect(screen.getByText('bad').getAttribute('href') ?? '').not.toContain('javascript')
    expect(screen.getByRole('link', { name: 'in' })).not.toHaveAttribute('target')
    expect(screen.getByRole('link', { name: 'doc' })).toHaveAttribute('href', '/p/acme/install.md')
  })

  it('shows remote images as links (CSP allows only same-origin images) and does not render raw HTML', async () => {
    renderInRouter(
      <MarkdownView
        slug="acme"
        source={
          '![diagram](https://cdn.example.com/x.png) ![local](/logo.png)\n\n<script>alert(1)</script><b>bold?</b>'
        }
      />,
    )
    expect(await screen.findByRole('link', { name: 'diagram' })).toHaveAttribute(
      'href',
      'https://cdn.example.com/x.png',
    )
    expect(screen.getByRole('img', { name: 'local' })).toHaveAttribute('src', '/logo.png')
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
  })
})
