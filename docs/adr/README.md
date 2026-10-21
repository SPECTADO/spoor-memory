# Architecture decision records

Project decisions, MADR style, each with date and deciders. Template and rules: the `adr` skill. Never rewrite an accepted ADR; supersede it with a new one. Design sources are in [docs/design](../design/); deviation ids (D1-D9, I1-I45, G, H, P3) are defined in [deviations.md](../design/deviations.md). All ADRs 0001 to 0014 are accepted. Where the amendments in BRIEF.md changed an earlier choice (D9, I33 to I38), the ADR text already states the amended rule. How the decisions show up for users: [user-guide.md](../user-guide.md), [agent-guide.md](../agent-guide.md), [operations.md](../operations.md).

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
- [ADR-0012](0012-authority-and-write-ordering.md) - Delegated authority is re-checked at use, and item writes lock the project row first (Accepted, 2026-10-19)
- [ADR-0013](0013-cli-packaging-and-release.md) - The CLI is published as one esbuild bundle, and a v* tag releases the npm package and the image together (Accepted, 2026-10-19)
- [ADR-0014](0014-library-space.md) - Library space: per-project pages written only by humans (Accepted, 2026-10-20)
- [ADR-0015](0015-exclusive-memory.md) - Spoor is the agents' only memory by default (Accepted, 2026-10-20)
- [ADR-0016](0016-keep-the-global-cli-install-the-sessionstart-digest-warns-when-the-cli-version.md) - Keep the global CLI install; the SessionStart digest warns when the CLI version differs from the server's (2026-10-20)
- [ADR-0017](0017-latest-image-follows-main.md) - The `latest` image follows `main`; version tags stay on `v*` releases (Superseded by ADR-0019, 2026-10-20)
- [ADR-0018](0018-agent-request-log.md) - An agent request log, kept 14 days, readable by admins (Accepted, 2026-10-21)
- [ADR-0019](0019-develop-image-follows-main.md) - `develop` follows `main`, `latest` follows the highest release (Accepted, 2026-10-21)
