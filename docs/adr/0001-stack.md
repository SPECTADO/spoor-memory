# ADR-0001: Stack: Hono, Drizzle, React/Vite, MCP SDK, pnpm monorepo, Node 22, pinned versions

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1, architect)
- **Tags:** stack, dependencies

## Context

Spoor needs one TypeScript codebase for server, CLI and web UI, shipped as one Docker image and one npm package. Dependency safety requires exact, aged versions: `.npmrc` enforces `minimum-release-age=4320` and nothing newer than 2026-10-16 may be pinned. Several majors are very young (pnpm 12, vitest 5, TypeScript 7). Source: `docs/research/server-stack.md`, `web-stack.md`, `mcp-sdk.md`; design: `docs/design/deployment.md`, `mcp.md`.

## Decision

We will use a pnpm workspace monorepo on Node 22 (`node:22-bookworm-slim`, glibc), TypeScript, ESM. Server: Hono with `@hono/node-server`, the official MCP SDK v1.x using its web-standard streamable transport directly (not `@hono/mcp`), Drizzle ORM with `pg`, zod 4, pino. Web: React 19, Vite 8, Tailwind 4, TanStack Query, react-router 7, CodeMirror. Tests: vitest. All versions are pinned exactly (no `^`) and, for young majors, we take the fallback: pnpm 10.34.7 (not 12), vitest 4.1.12 (not 5), typescript 6.0.3 (not 7), react-router 7.18.4, hono 4.13.x (not the v5 rc). Native build scripts (onnxruntime-node and similar) are allow-listed through `onlyBuiltDependencies`, never by disabling the check. The concrete pins live in `package.json` files and `docs/research/*`; `pnpm audit` is run at the end of each phase. This settles the stack and tooling choices of the scaffold phase.

## Consequences

Reproducible installs and a small supply-chain surface. One language across layers, shared zod schemas. The cost is lagging behind newest majors; each bump is a deliberate change that needs a fresh research date check. The MCP SDK's web-standard transport binds us to its session API (see ADR 0010).

## Alternatives considered

- **pnpm 12 / vitest 5 / TypeScript 7** - released weeks or months ago with unverified ecosystem fit; fallbacks are mature.
- **`@hono/mcp`** - not recommended in `docs/research/mcp-sdk.md` section 5; the SDK transport gives direct control over sessions.
- **Fastify or Express, Prisma, Next.js** - heavier, or hide the raw SQL (pgvector casts, triggers) the design needs.
- **Caret ranges** - violate the exact-pin house rule.
