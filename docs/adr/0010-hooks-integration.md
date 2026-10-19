# ADR-0010: Claude Code integration through hooks and a committed .mcp.json

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1, architect)
- **Tags:** hooks, mcp, cli

## Context

Memory only helps if it loads at session start and decisions get recorded, without ever blocking the agent. The MCP server must also know which client is calling. Source: `docs/design/cli-and-hooks.md`, `mcp.md` sections 3 and 5, `docs/research/claude-code-harness.md`; settles D7, I23, I25, I26, I35, I45, X1, X2, X9 and the session-managed transport topic of `deviations.md` section D.

## Decision

We will integrate through three hooks and a committed `.mcp.json`. `spoor init`, run at the end of `spoor login`, writes `.mcp.json` (literal URL and slug, token only as `${SPOOR_TOKEN}`), the `.claude/settings.json` hooks and the `mcp__spoor` permission from a secret-free `GET /p/<slug>/install.json` (I35). SessionStart (7 s deadline) fetches the digest, replays the queue and sweeps mirrored files, capped at 9,500 characters; PostToolUse pushes mirrored files; Stop nags once per session when files changed without Spoor writes (checked via `GET /p/:slug/api/activity`, I23, I26) and then spawns drafting (ADR 0008). Hooks always exit 0, use a 5-minute circuit breaker and treat missing `settings.local.json` as opt-out (I45). `alwaysLoad` is used with a unit-tested `tools/list` size budget. install.md gives `curl -s` first and WebFetch second (D7). The MCP endpoint is session-managed, not stateless: the SDK exposes `clientInfo` only in session mode, so each session has its own `McpServer`, a token-bound id, 30-minute idle TTL and per-token limits.

## Consequences

Near-zero setup and no blocking. We depend on Claude Code hook semantics (Stop at every turn end, `alwaysLoad`, `mcp__spoor` rule), which were partly unverified at decision time. Verified on 2026-10-19 against the docs and with the real Claude Code 2.1.303 in `-p` mode (docs/design/harness-verification.md): Stop fires at every stop attempt (again with `stop_hook_active: true` after a block), `alwaysLoad` keeps the Spoor tools out of tool search, `mcp__spoor` allows all nine tools, and `${SPOOR_TOKEN}` expands from `settings.local.json`; the committed `permissions.allow` entry only applies once the folder is trusted. Session state is in memory and lost on restart; clients re-initialize on 404.

`alwaysLoad` costs context in every session: the writer `tools/list` (all nine tools) measured **2,145 estimated tokens** (7,505 characters, search-and-digest.md §6 estimator) at the phase 3 integration, 2026-10-19. The design had budgeted 1,200; the documented tool descriptions and input schemas alone are about 1,880, and the MCP SDK adds `$schema` and `execution.taskSupport` to every tool. Decided 2026-10-19 by the orchestrator for the owner (deviations.md H2): keep the tool contract as designed and raise the budget in mcp.md §5 to 2,200, because shrinking the descriptions would cut the guidance that makes agents call the tools correctly, and about 2k tokens is still small next to the digest. The unit test in `packages/server/src/modules/mcp/tools.test.ts` keeps 2,200 as a regression ceiling, so further growth needs a new decision.

## Alternatives considered

- **Stateless MCP transport** - cannot capture the client name.
- **Instructions in CLAUDE.md only** - no digest, no enforcement.
- **More hooks (UserPromptSubmit)** - outside the brief's three.
- **Tokens in `.mcp.json`** - committed secrets (ADR 0006).

**Update 2026-10-19 (phase 5 review, review-log-phase5 A2):** measured with Claude's own tokenizer, the same writer
`tools/list` is **3,307 tokens**, not 2,145: the estimator's Latin weight (1/3.5) undercounted by about 45 %. The
estimator now weighs Latin at 1/2.2 and the regression ceiling is 3,500 estimated tokens (the contract did not change).
Whether `alwaysLoad` is still worth about 3.3k tokens per session, or the schemas should be slimmed, is an open owner
question (review-log-phase5).
