# ADR-0009: Repo mirror is push-only

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1, architect)
- **Tags:** sync, repo

## Context

ADRs and docs live both in the repo and in Spoor. Two-way sync needs merge logic and risks last-writer-wins data loss. Source: `docs/design/data-model.md` section 7, `cli-and-hooks.md`; settles I3, I4, I27, I44, I41, X6.

## Decision

We will mirror push-only: import once, then push on change (PostToolUse and the SessionStart sweep by hash), never pull. ADRs get `spoor_id` written back into the file; docs match on `source_path` and do not (I27, `docs.write_back:false`). A push fast-forwards only when nobody edited the item in Spoor since the last push; otherwise the server answers 409 `pushed_over_spoor_edit`, sets `push_conflict_at`, shows it in the review queue, at SessionStart and in `spoor status` (I3, I44). `spoor adr push --force` is the human override and needs an interactive TTY. MCP edits to mirrored items are rejected with `mirrored_item`: the agent edits the file and the hook pushes (I4). Web edits stay allowed and cause the conflict on the next push. Push applies content keys only; operational keys (`pinned`, `last_verified`) apply on create; `superseded` is sticky; imported revisions are never a fast-forward base (I41).

## Consequences

The repo stays the source of truth for mirrored files with no silent overwrite either way. Humans must resolve conflicts explicitly, and web edits of mirrored items are friction. Renaming a doc file creates a new Spoor doc.

## Alternatives considered

- **Bidirectional sync** - merge complexity, hidden data loss.
- **Last-writer-wins** - rejected by the brief.
- **Allow MCP edits and overwrite files** - agents would race the working tree.
- **Server-side git access** - needs repo credentials on the server.
