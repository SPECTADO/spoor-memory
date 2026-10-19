# Architecture decision records

Project decisions, MADR style, each with date and deciders. Template and rules: the `adr` skill. Never rewrite an accepted ADR; supersede it with a new one. Design sources are in [docs/design](../design/); deviation ids (D1-D9, I1-I45, G, H, P3) are defined in [deviations.md](../design/deviations.md). ADRs 0001 to 0011 and 0013 are accepted; ADR-0012 stays **Proposed** until the owner accepts it. Where the amendments in BRIEF.md changed an earlier choice (D9, I33 to I38), the ADR text already states the amended rule. How the decisions show up for users: [user-guide.md](../user-guide.md), [agent-guide.md](../agent-guide.md), [operations.md](../operations.md).

- [ADR-0001](0001-stack.md) - Stack: Hono, Drizzle, React/Vite, MCP SDK, pnpm monorepo, Node 22, pinned versions (Accepted, 2026-10-19)
- [ADR-0002](0002-postgres-pgvector.md) - Postgres with pgvector as the only store (Accepted, 2026-10-19)
- [ADR-0003](0003-local-multilingual-embeddings.md) - Local multilingual embeddings with a re-embed job (Accepted, 2026-10-19)
- [ADR-0004](0004-memory-model-three-spaces.md) - Memory model: memories, decisions and docs (Accepted, 2026-10-19)
- [ADR-0005](0005-shared-space-human-only-writes.md) - Shared space is a special project, written only by humans (Accepted, 2026-10-19)
- [ADR-0006](0006-tokens-and-device-login.md) - Per-user tokens and device login, no secrets in git (Accepted, 2026-10-19)
- [ADR-0007](0007-cleanup-policy.md) - Cleanup policy: stale, archive, expire, human delete (Accepted, 2026-10-19)
- [ADR-0008](0008-client-side-adr-drafting.md) - ADR drafting happens client-side (Accepted, 2026-10-19)
- [ADR-0009](0009-repo-mirror-push-only.md) - Repo mirror is push-only (Accepted, 2026-10-19)
- [ADR-0010](0010-hooks-integration.md) - Claude Code integration through hooks and a committed .mcp.json (Accepted, 2026-10-19)
- [ADR-0011](0011-server-modules-and-ports.md) - Server code is organised as modules behind ports (Accepted, 2026-10-19)
- [ADR-0012](0012-authority-and-write-ordering.md) - Delegated authority is re-checked at use, and item writes lock the project row first (Proposed, 2026-10-19)
- [ADR-0013](0013-cli-packaging-and-release.md) - The CLI is published as one esbuild bundle, and a v* tag releases the npm package and the image together (Accepted, 2026-10-19)
