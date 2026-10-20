/**
 * The published tool contract (mcp.md section 5): the tools/list budget (writer session, all nine tools, at
 * most TOOLS_LIST_BUDGET tokens by the search-and-digest.md section 6 estimator), the role-aware tool list, the JSON
 * Schema bounds, description lengths, and the instructions. No database: tools/list never calls a service.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { estimateTokens, MEMORY_RULE } from '@spoor/shared'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import type { McpServices } from './handlers.js'
import { buildMcpServer, toolsFor } from './server.js'
import {
  INSTRUCTIONS,
  instructionsFor,
  READ_ONLY_INSTRUCTIONS,
  READ_TOOLS,
  TOOL_SPECS,
  WRITE_TOOLS,
} from './tools.js'

const services = { logger: pino({ level: 'silent' }) } as unknown as McpServices

/**
 * mcp.md section 5: a regression ceiling for the writer tools/list. Raised from 1,200 to 2,200 (deviations.md H2,
 * ADR 0010) and then re-expressed in the recalibrated estimator (review-log-phase5 A2: 1/2.2 per Latin code point):
 * the same 7,5xx characters now estimate at about 3,420 and measured 3,307 real Claude tokens. Growth beyond the
 * ceiling needs a decision, not a bigger number.
 */
const TOOLS_LIST_BUDGET = 3500

async function listTools(role: 'viewer' | 'editor' | 'admin') {
  const server = buildMcpServer(services, role)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await Promise.all([server.connect(a), client.connect(b)])
  const list = await client.listTools()
  const instructions = client.getInstructions()
  await client.close()
  return { list, instructions }
}

describe('tools/list', () => {
  it('stays within the tools/list token budget for a writer session with all nine tools', async () => {
    const { list } = await listTools('editor')
    expect(list.tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort())
    const tokens = estimateTokens(JSON.stringify(list))
    // the measured number is recorded in ADR 0010 next to the alwaysLoad choice
    console.info(`tools/list (writer): ${tokens} estimated tokens, ${JSON.stringify(list).length} chars`)
    expect(tokens).toBeLessThanOrEqual(TOOLS_LIST_BUDGET)
  })

  it('gives viewers the three read tools only, and instructions without the recording sentence (A4)', async () => {
    const { list, instructions } = await listTools('viewer')
    expect(instructions).toBe(instructionsFor(false, true))
    expect(instructions).not.toContain('spoor_remember')
    expect(instructions).toContain('This token is read-only')
    expect(list.tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort())
    expect(toolsFor(null)).toEqual([...READ_TOOLS])
    expect(toolsFor('admin')).toHaveLength(9)
  })

  it('publishes the documented schemas and annotations', async () => {
    const { list, instructions } = await listTools('admin')
    const tool = (n: string) => list.tools.find((t) => t.name === n) as (typeof list.tools)[number]
    const props = (n: string) => tool(n).inputSchema.properties as Record<string, Record<string, unknown>>

    expect(instructions).toBe(instructionsFor(true, true))
    expect(tool('spoor_context').annotations?.readOnlyHint).toBe(true)
    expect(tool('spoor_verify').annotations?.idempotentHint).toBe(true)
    expect(tool('spoor_search').inputSchema.required).toEqual(['query'])
    expect(tool('spoor_get').inputSchema.required).toEqual(['ids'])
    expect(tool('spoor_remember').inputSchema.required).toEqual(['title'])
    expect(tool('spoor_doc_write').inputSchema.required?.sort()).toEqual(['body', 'title'])
    expect(tool('spoor_supersede').inputSchema.required).toEqual(['old'])
    expect(tool('spoor_relate').inputSchema.required?.sort()).toEqual(['from', 'kind', 'to'])
    expect(tool('spoor_verify').inputSchema.required).toEqual(['ids'])
    for (const t of list.tools)
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)

    expect(props('spoor_context').budget).toMatchObject({ type: 'integer', minimum: 200, maximum: 8000 })
    expect(props('spoor_search').limit).toMatchObject({ minimum: 1, maximum: 20, default: 8 })
    expect(props('spoor_get').ids).toMatchObject({ minItems: 1, maxItems: 5 })
    expect(props('spoor_get').max_chars).toMatchObject({ minimum: 500, maximum: 50000, default: 8000 })
    expect(props('spoor_remember').title).toMatchObject({ minLength: 3, maxLength: 200 })
    expect(props('spoor_remember').type).toMatchObject({
      enum: ['decision', 'fact', 'procedure', 'observation'],
    })
    expect(props('spoor_remember').tags).toMatchObject({ maxItems: 20, items: { maxLength: 40 } })
    expect(props('spoor_remember').anchors).toMatchObject({ maxItems: 20, items: { maxLength: 256 } })
    expect(props('spoor_remember').relations).toMatchObject({ maxItems: 10 })
    expect(props('spoor_doc_write').body).toMatchObject({ maxLength: 200000 })
    expect(props('spoor_verify').ids).toMatchObject({ minItems: 1, maxItems: 20 })
    expect(props('spoor_relate').kind).toMatchObject({
      enum: ['refines', 'supports', 'depends_on', 'conflicts_with'],
    })
    expect(props('spoor_search').space).toMatchObject({ enum: ['memories', 'decisions', 'docs', 'library'] })
  })
})

describe('tool descriptions', () => {
  it('are at most 35 words each', () => {
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
      expect(spec.description.split(/\s+/).length, name).toBeLessThanOrEqual(35)
    }
  })

  it('name the library space and the L handle', () => {
    expect(TOOL_SPECS.spoor_context.description).toContain('library, pinned items')
    expect(TOOL_SPECS.spoor_search.description).toContain('memories, ADRs, docs and library')
    expect(TOOL_SPECS.spoor_get.description).toContain('L3')
  })
})

describe('instructions', () => {
  it('explain the L handle and keep the sentence the read-only variant replaces', () => {
    expect(INSTRUCTIONS).toContain(
      'Ids are handles like m42, ADR-0007, d3, L3; L = library: human-approved project guides, follow them (read-only);',
    )
    expect(READ_ONLY_INSTRUCTIONS).not.toBe(INSTRUCTIONS)
    expect(READ_ONLY_INSTRUCTIONS).toContain('L = library')
    console.info(`instructions: ${estimateTokens(INSTRUCTIONS)} estimated tokens`)
  })

  it('carry the memory rule as the second sentence only when memory.exclusive is on (ADR-0015)', () => {
    expect(instructionsFor(true, false)).toBe(INSTRUCTIONS)
    expect(instructionsFor(false, false)).toBe(READ_ONLY_INSTRUCTIONS)
    const writer = instructionsFor(true, true)
    expect(writer.startsWith(`Spoor is this project's shared team memory. ${MEMORY_RULE} If a`)).toBe(true)
    expect(instructionsFor(false, true)).toContain(MEMORY_RULE)
    expect(instructionsFor(false, true)).toContain('This token is read-only')
    console.info(`instructions (exclusive): ${estimateTokens(writer)} estimated tokens`)
  })
})
