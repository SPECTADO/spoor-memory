# ADR-0005: Shared space is a special project, written only by humans

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1, architect)
- **Tags:** security, data

## Context

Teams want organisation-wide knowledge (conventions, glossary) visible to every project, but a prompt-injected agent in one repo must not be able to poison all of them. Source: `docs/design/auth-and-security.md` sections 1 and 7, `data-model.md`; settles I1, I11, X5, I38.

## Decision

We will store the shared space as one `projects` row with `kind='shared'` and slug `_shared`, with no memberships or tokens on it (I1). Every valid token can read it, and its items appear in digest tiers 1, 2 and 4 (I11). Writing requires a human session as instance admin (`IA`) or a user with the `shared_editor` flag; the server rejects every agent/MCP write with `read_only_space`. The same rule covers review actions and hard delete on `_shared` (X5). REST addresses it as `_shared`, the SPA as `/shared/...`.

## Consequences

Reuse of all item machinery with no second schema. Agents cannot write shared knowledge directly; they must hand it to a human, which adds friction by design. Every query path must handle the special row, and resolution must stay inside the caller's project plus `_shared` for reads (I42).

## Alternatives considered

- **Separate shared tables** - duplicates code and search.
- **Agent writes with review queue only** - still lets injected content reach all projects.
- **Per-project copies of shared notes** - drift and no single owner.
