/**
 * One `McpServer` per session (docs/design/mcp.md section 3): the server `instructions`, and the tools the
 * session's role may use. A viewer (or read-only token) session registers only the three read tools, which
 * keeps its tool list small; writers get all nine. Handlers still check the role on every call.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ProjectRole } from '@spoor/shared'
import type { z } from 'zod'
import { roleAtLeast } from '../../lib/auth-context.js'
import { VERSION } from '../../version.js'
import {
  contextTool,
  DOC_WRITE_HINTS,
  decideTool,
  docWriteTool,
  getTool,
  guarded,
  type McpServices,
  REMEMBER_HINTS,
  relateTool,
  rememberTool,
  searchTool,
  supersedeTool,
  verifyTool,
} from './handlers.js'
import { instructionsFor, READ_TOOLS, TOOL_SPECS, type ToolName, WRITE_TOOLS } from './tools.js'

type AnyHandler = (s: McpServices) => (args: never, x: never, note: never) => Promise<unknown>

const HANDLERS: Record<ToolName, { make: AnyHandler; hints?: Partial<Record<string, string>> }> = {
  spoor_context: { make: contextTool as AnyHandler },
  spoor_search: { make: searchTool as AnyHandler },
  spoor_get: { make: getTool as AnyHandler },
  spoor_remember: { make: rememberTool as AnyHandler, hints: REMEMBER_HINTS },
  spoor_decide: { make: decideTool as AnyHandler, hints: REMEMBER_HINTS },
  spoor_doc_write: { make: docWriteTool as AnyHandler, hints: DOC_WRITE_HINTS },
  spoor_supersede: { make: supersedeTool as AnyHandler },
  spoor_relate: { make: relateTool as AnyHandler },
  spoor_verify: { make: verifyTool as AnyHandler },
}

/** The tool names a session of `role` is given (mcp.md section 6). */
export function toolsFor(role: ProjectRole | null): ToolName[] {
  return roleAtLeast(role, 'editor') ? [...READ_TOOLS, ...WRITE_TOOLS] : [...READ_TOOLS]
}

export function buildMcpServer(
  services: McpServices,
  role: ProjectRole | null,
  memoryExclusive = true,
): McpServer {
  const mcp = new McpServer(
    { name: 'spoor', version: VERSION },
    {
      instructions: instructionsFor(roleAtLeast(role, 'editor'), memoryExclusive),
      capabilities: { tools: {} },
    },
  )
  for (const name of toolsFor(role)) {
    const spec = TOOL_SPECS[name]
    const h = HANDLERS[name]
    const handler = guarded(
      name,
      services.logger,
      h.make(services) as Parameters<typeof guarded<z.ZodType>>[2],
      h.hints,
      services.requests,
    )
    mcp.registerTool(
      name,
      {
        description: spec.description,
        inputSchema: spec.inputSchema,
        ...(spec.annotations ? { annotations: spec.annotations } : {}),
      },
      handler as never,
    )
  }
  return mcp
}
