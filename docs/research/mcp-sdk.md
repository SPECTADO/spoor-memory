# Research: MCP TypeScript SDK (mcp-sdk)

Date 2026-10-19. Cutoff for pins: published on or before 2026-10-16. Verified by `npm view`, reading the
packed tarballs (`npm pack`), and a running smoke test (Hono + SDK, curl) in the scratchpad.

## Versions (npm registry, `npm view <pkg> time --json`)

| package | version | released | note |
|---|---|---|---|
| @modelcontextprotocol/sdk | 1.32.1 | 2026-10-05 | dist-tag `latest`; v1.x line; 1.32.0 = 2026-10-02 |
| hono | 4.13.13 | 2026-10-04 | `latest`; 5.0.0-rc.* exists (Oct 8/10) - do not use |
| @hono/node-server | 2.1.5 | 2026-10-13 | `latest`; SDK dep accepts `^1.19.9 \|\| ^2.0.5` (1.19.17 = 2026-07-27 is `latest-1`) |
| zod | 4.6.7 | 2026-10-12 | SDK peer `^3.25 \|\| ^4.0` |
| @hono/mcp | 0.3.2 | 2026-08-18 | `latest`; NOT recommended (see 5) |

SDK 1.32.1 deps of note: `hono`, `@hono/node-server`, `jose`, `pkce-challenge`, `express` (+`cors`,
`express-rate-limit`; only used by the `server/auth` Express helpers), `ajv`. peer: `zod` (required).
The SDK already depends on Hono, so there is no extra framework cost.
Import paths use `.js` subpaths: `@modelcontextprotocol/sdk/server/mcp.js`,
`.../server/webStandardStreamableHttp.js`, `.../server/streamableHttp.js` (Node req/res wrapper),
`.../types.js`, `.../server/auth/*`.

## 1. Streamable HTTP server, stateless vs session-managed

Source: `dist/esm/server/webStandardStreamableHttp.{d.ts,js}` in 1.32.1; spec
https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

- `WebStandardStreamableHTTPServerTransport` works on Web `Request`/`Response`, so it mounts directly in
  Hono: `transport.handleRequest(c.req.raw, { authInfo, parsedBody? })` returns a `Response`.
  The Node `StreamableHTTPServerTransport` is a thin wrapper over it using `getRequestListener` from
  `@hono/node-server` (so Hono-on-node-server needs no wrapper at all).
- Options: `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`, `enableJsonResponse`,
  `eventStore`, `allowedHosts`, `allowedOrigins`, `enableDnsRebindingProtection`, `retryInterval`,
  `keepAliveMs`, `maxRequestBodySize`.
- **Stateless**: `sessionIdGenerator: undefined`. No `Mcp-Session-Id`, no session validation. Source guard:
  `Stateless transport cannot be reused across requests. Create a new transport per request.`
  So per request: new `McpServer` + new transport + `connect` + `handleRequest`.
- **Session-managed**: `sessionIdGenerator: () => crypto.randomUUID()`. Server returns `Mcp-Session-Id` on
  initialize; unknown id -> 404 `Session not found` (code -32001); missing id on non-initialize -> 400.
  State is in-memory (a Map you keep). Per spec the client must start a new session on 404.
- Auth is per HTTP request in both modes (spec: "authorization MUST be included in every HTTP request ...
  even if they are part of the same logical session"). `authInfo` passed to `handleRequest` reaches
  handlers in EVERY request in both modes (verified), so session mode does not freeze the first token.
- Multi-tenant, bearer token on every request: both fit auth-wise. Key difference is item 3: in stateless
  mode the `initialize` request is a different request/server instance from the later `tools/call`, so
  client name/version is not available in handlers (verified: `getClientVersion()` undefined).
  Recommendation: session-managed (one McpServer+transport per session in a Map), bind each session to the
  (token-hash, project) that created it and reject a mismatching token with 403/404; stateless fallback
  not needed. Server restart drops the Map -> clients get 404 and re-initialize (fine, cheap, no server-
  pushed notifications are used by Spoor). Add idle-session TTL sweep.

## 2. Authorization header per request -> auth context in handlers

Handler `extra` (type `RequestHandlerExtra`, `shared/protocol.d.ts`) has: `authInfo?: AuthInfo`,
`sessionId?`, `requestInfo?: { headers, url }`, `signal`, `requestId`, `_meta`.
`AuthInfo = { token: string; clientId: string; scopes: string[]; expiresAt?: number; resource?: URL; extra?: Record<string, unknown> }`
-> put `{ userId, projectId, role, tokenId }` in `authInfo.extra` (and `clientId` = user id). Verified end to end.

```ts
app.all('/p/:slug/mcp', async (c) => {
  const h = c.req.header('authorization') ?? '';
  if (!h.startsWith('Bearer '))
    return c.json({ error: 'unauthorized' }, 401, {
      'WWW-Authenticate': 'Bearer resource_metadata="https://host/.well-known/oauth-protected-resource/p/demo/mcp"' });
  const ctx = await resolveToken(h.slice(7), c.req.param('slug')); // hash lookup in DB; null -> 401
  const authInfo = { token: '<redacted>', clientId: ctx.userId, scopes: [],
                     extra: { user: ctx.userId, project: ctx.projectId, role: ctx.role } };
  return entry.transport.handleRequest(c.req.raw, { authInfo });
});
// in a tool handler:
async (args, extra) => { const { user, project, role } = extra.authInfo!.extra as AuthCtx; ... }
```
Gotchas: do not store the raw token in `authInfo.token` unless needed (avoid logging). Do the 401 in Hono
BEFORE the transport (transport does not do auth). Enforce read-only viewers inside write tools (return
`isError`) or by registering only read tools per request/session role. `enableJsonResponse: true` returns
plain JSON instead of SSE for POST (simpler for curl/tests; Claude Code accepts both).

## 3. Client name/version from `initialize` inside a tool handler

`Server.getClientVersion(): Implementation | undefined` (`server/index.d.ts`: "information about the
client's name and version" after initialization); `getClientCapabilities()` likewise. From an `McpServer`
use `mcpServer.server.getClientVersion()`. Verified output: `{"name":"claude-code","version":"9.9"}` in
session mode. Capture it in the closure that builds the per-session server:
```ts
const mcp = new McpServer({ name: 'spoor', version });
mcp.registerTool('spoor_remember', {...}, async (args, extra) => {
  const client = mcp.server.getClientVersion(); // { name, version } | undefined
});
```
Also `mcp.server.oninitialized = () => {...}` fires after the handshake. Stateless fallback only: User-Agent
via `extra.requestInfo?.headers['user-agent']`. Treat client name as self-reported, untrusted (audit label only).

## 4. Tool registration, zod input, text content

`registerTool(name, { title?, description?, inputSchema?, outputSchema?, annotations?, _meta? }, cb)`;
`.tool()` is deprecated. `inputSchema` is a raw zod shape (`{ q: z.string() }`) or a zod schema; zod 3.25+ and 4 both work.
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
mcp.registerTool('spoor_search',
  { description: 'Search memory', inputSchema: { query: z.string(), limit: z.number().int().max(20).default(5) },
    annotations: { readOnlyHint: true } },
  async ({ query, limit }, extra) => ({ content: [{ type: 'text', text: '...' }] }));
```
Input is validated before the handler; invalid args do NOT throw a protocol error, they come back as a
tool result (verified): `{"content":[{"type":"text","text":"MCP error -32602: Input validation error: Invalid arguments for tool spoor_whoami: Invalid input: expected string, received number at q"}],"isError":true}`.
Optional `outputSchema` requires `structuredContent` (also send text for compatibility; spec tools page).
Tool names: 1-128 chars, `[A-Za-z0-9_.-]` (spec) - `spoor_*` is fine.

## 5. @hono/mcp vs SDK web-standard transport

`@hono/mcp@0.3.2` exists (2026-08-18; Hono org, author mathuraditya724; README
https://www.npmjs.com/package/@hono/mcp). Exports `StreamableHTTPTransport` (own re-implementation:
`handleRequest(ctx: Context, parsedBody?)`, takes auth from `ctx.get('auth')`), `MemoryEventStore`,
`bearerAuth`, `mcpAuthRouter`, `simpleMcpAuthRouter`, `ProxyOAuthServerProvider`. peerDeps:
`@modelcontextprotocol/sdk ^1.29`, `hono`, `hono-rate-limiter ^0.5.3`, `zod`; dep `pkce-challenge`.
README pattern connects ONE transport once (`if (!mcpServer.isConnected()) connect`), i.e. single-session
shape, wrong for per-session/per-tenant servers. Its permissive `strictAcceptHeader=false` is the only
notable benefit.
Verdict: unnecessary. Since SDK >=1.2x the SDK ships `WebStandardStreamableHTTPServerTransport` that takes a
Hono `c.req.raw` directly and already carries `authInfo` (smoke-tested with hono 4.13.13 +
@hono/node-server 2.1.5). Skip `@hono/mcp`: one fewer package, no lag behind SDK transport fixes, no extra
peer (`hono-rate-limiter`). Using `@hono/node-server` `serve({ fetch: app.fetch })` is just how the Hono app
is hosted on Node; no raw Node req/res involved. Use raw Node `StreamableHTTPServerTransport` only if you
leave Hono.

## 6. MCP OAuth 2.1 (spec 2025-11-25) and SDK server side

Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization . Authorization is
OPTIONAL. MCP server = OAuth 2.1 resource server only:
- MUST serve RFC 9728 Protected Resource Metadata with `authorization_servers`; MUST give it via
  `WWW-Authenticate: Bearer resource_metadata="..."` on 401 and/or at
  `/.well-known/oauth-protected-resource[/path]`. SHOULD add `scope=`; 403 + `error="insufficient_scope"`.
- AS must publish RFC 8414 (`/.well-known/oauth-authorization-server`) or OIDC discovery; clients MUST
  refuse if `code_challenge_methods_supported` absent; PKCE `S256` required; `resource` (RFC 8707) param in
  authorize+token requests; server MUST validate token audience; no query-string tokens; no token passthrough.
- Client registration: pre-registered, Client ID Metadata Documents (SHOULD), or Dynamic Client
  Registration RFC 7591 (MAY, back-compat).
SDK server side (1.32.1 `server/auth/*`): `mcpAuthRouter` (Express; authorize, token, register, revoke,
metadata handlers), `mcpAuthMetadataRouter`, `requireBearerAuth({verifier, requiredScopes,
resourceMetadataUrl, expectedResource})` (sets `req.auth`, emits WWW-Authenticate, checks `expiresAt` -
tokens MUST have numeric `expiresAt`), interface `OAuthServerProvider`/`OAuthTokenVerifier`
(`verifyAccessToken(token): Promise<AuthInfo>`), `ProxyOAuthServerProvider`. All Express-based; @hono/mcp
ports these to Hono. Handlers throw `InvalidTokenError` etc.
Claude Code (https://code.claude.com/docs/en/mcp): for HTTP servers does RFC 9728 discovery, falls back to
RFC 8414, DCR by default, CIMD supported, `/mcp` or `claude mcp login`. With a static `Authorization`
header configured, a 401 does NOT start OAuth (reported as failed). `.mcp.json` supports
`"headers": {"Authorization": "Bearer ${SPOOR_TOKEN}"}` with `${VAR}` / `${VAR:-default}` expansion in
url+headers (verified in docs; avoid names like ANTHROPIC_API_KEY, which expand empty). `claude -p` cannot
do OAuth.
Implication: the brief's static bearer token (device login to token, `${SPOOR_TOKEN}` header) is fully
valid MCP and needs none of the OAuth endpoints. Full MCP OAuth would mean building AS endpoints (DCR/
CIMD, authorize page, token) on top of the existing login: possible later (phase 2) by implementing
`OAuthServerProvider` or a small hand-written Hono AS; PRM endpoint is cheap to add now. Do not add OAuth
to MVP; Spoor tokens can later be accepted as the access tokens (`verifyAccessToken` = token lookup).

## 7. Error conventions (spec tools page 2025-11-25)

- Protocol errors (JSON-RPC `error`): unknown tool, malformed request, server fault (e.g. `-32602`).
- Tool execution errors: result with `isError: true` and text explaining how to fix; clients SHOULD feed
  these to the LLM. Use for validation, conflict, permission (viewer write), not-found, business rules.
```ts
const err = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });
return err('conflict: item mem_42 is at revision 7, you sent 6. Re-read with spoor_get and retry.');
```
- Thrown exceptions in a handler are caught by the SDK and returned as `{content:[{type:'text',text:message}],isError:true}`
  (`createToolError`, mcp.js) - so never throw messages containing secrets/stack data. Only `McpError` with
  `UrlElicitationRequired` is rethrown as a protocol error. Verified: handler-returned isError and the
  zod validation error both arrive as `isError: true`.
- Auth failures are HTTP-level (401/403 + WWW-Authenticate), before MCP, not tool errors.

## Smoke-test facts (verified, hono 4.13.13, sdk 1.32.1, node-server 2.1.5)
- Stateless: `tools/call` without prior initialize works; `extra.authInfo` set; `getClientVersion()` undefined.
- Stateful: session id returned in initialize response header; `authInfo` fresh on each request;
  `getClientVersion()` = initialize clientInfo; unknown session id -> our 404 passthrough.
- Missing bearer -> our 401 before the transport.
- Protocol version header on follow-ups: `mcp-protocol-version: 2025-06-18` used in test; Claude Code sends its own.

## Recommendation

Pin `@modelcontextprotocol/sdk@1.32.1` (2026-10-05), `zod@4.6.7`, `hono@4.13.13`, `@hono/node-server@2.1.5`;
do not add `@hono/mcp`. Mount `WebStandardStreamableHTTPServerTransport` in Hono at `/p/:slug/mcp`
(`app.all`), authenticate the bearer in Hono middleware before the transport (hash lookup, project match,
401 with `WWW-Authenticate`), pass `{ authInfo: { clientId: userId, extra: { user, project, role, tokenId } } }`
to `handleRequest` on every request, and read it in handlers via `extra.authInfo.extra`. Run
session-managed (`sessionIdGenerator: crypto.randomUUID`, one `McpServer` per session in a Map with TTL
sweep, session bound to token hash + project, `onsessionclosed` cleanup) so the initialize `clientInfo` is
retrievable with `mcp.server.getClientVersion()` for the audit log; fall back to the User-Agent if undefined
after a restart (client re-initializes on 404 anyway). Register tools with `registerTool` + zod shapes,
return text content, and signal all expected failures (viewer write, revision conflict, not found) as
`isError: true` results. Defer MCP OAuth (PRM + AS) to phase 2; static bearer headers via `${SPOOR_TOKEN}` in
`.mcp.json` work today in Claude Code.
