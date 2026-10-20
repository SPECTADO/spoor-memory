import { describe, expect, it } from 'vitest'
import {
  AGENTS_BLOCK_END,
  agentsMdBlock,
  claudeMdImportsAgents,
  currentAgentsBlock,
  MEMORY_RULE,
  mergeAgentsMd,
  mergeClaudeMd,
} from './agents-md.js'

describe('AGENTS.md block', () => {
  it('carries the memory rule only when exclusive', () => {
    expect(agentsMdBlock(true)).toContain(MEMORY_RULE)
    expect(agentsMdBlock(false)).not.toContain(MEMORY_RULE)
    expect(agentsMdBlock(false)).toContain('`spoor_context`')
  })

  it('creates, appends and replaces in place, idempotently', () => {
    expect(mergeAgentsMd('', true)).toBe(`${agentsMdBlock(true)}\n`)
    const own = '# Rules\n\nUse tabs.\n'
    const added = mergeAgentsMd(own, true)
    expect(added).toBe(`${own}\n${agentsMdBlock(true)}\n`)
    expect(mergeAgentsMd(added, true)).toBe(added)
    const flipped = mergeAgentsMd(`${added}\n## After\n`, false)
    expect(flipped).toBe(`${own}\n${agentsMdBlock(false)}\n\n## After\n`)
  })

  it('replaces a block from another CLI version and leaves an unterminated one alone', () => {
    const old = 'x\n<!-- spoor:begin v0 -->\nold text\n<!-- spoor:end -->\ny\n'
    expect(mergeAgentsMd(old, true)).toBe(`x\n${agentsMdBlock(true)}\ny\n`)
    const broken = 'x\n<!-- spoor:begin -->\nno end\n'
    expect(mergeAgentsMd(broken, true)).toBe(`${broken}\n${agentsMdBlock(true)}\n`)
  })

  it('reads the current block, CRLF tolerated', () => {
    const text = `a\r\n${agentsMdBlock(true).replace(/\n/g, '\r\n')}\r\nb\r\n`
    expect(currentAgentsBlock(text)).toBe(agentsMdBlock(true))
    expect(currentAgentsBlock('nothing here')).toBeUndefined()
    expect(currentAgentsBlock(AGENTS_BLOCK_END)).toBeUndefined()
  })
})

describe('CLAUDE.md import', () => {
  it('adds @AGENTS.md once', () => {
    expect(mergeClaudeMd('')).toBe('@AGENTS.md\n')
    expect(mergeClaudeMd('# Notes')).toBe('# Notes\n\n@AGENTS.md\n')
    expect(mergeClaudeMd('# Notes\n@./AGENTS.md\n')).toBe('# Notes\n@./AGENTS.md\n')
    expect(claudeMdImportsAgents('see @AGENTS.md inline')).toBe(false)
  })
})
