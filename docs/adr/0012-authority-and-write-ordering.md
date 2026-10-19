# ADR-0012: Delegated authority is re-checked at use, and item writes lock the project row first

- **Status:** Proposed
- **Date:** 2026-10-19
- **Deciders:** Phase 2 review fixer (Claude, Opus 5.5) from the phase 2 review findings S1, S3, D1, D2, D3; for the owner (Ladislav Soukup) to confirm at the phase 2 checkpoint
- **Tags:** security, concurrency, server

## Context

The phase 2 review found two classes of defect. (1) Delegated authority outlived its source: an open invite kept its creator's power after the creator was demoted, disabled, removed from the project or deleted, and a removed member's token revived when the member was re-added. (2) Write decisions were made outside the transaction that acted on them (push fast-forward, `already_drafted`), and content-write transactions took the project row lock and item row locks in different orders, so concurrent writers could overwrite a human edit or deadlock (40P01 surfaced as 500). Sources: `docs/design/review-log-phase2.md`, auth-and-security.md §5, data-model.md §§3 and 7.

## Decision

We will re-check delegated authority at the moment it is used and revoke it when its source goes away. An invite is accepted (and previewed) only while its creator exists, is enabled, and still holds the authority each part of the invite needs (instance admin for instance flags and resets, project admin for each grant); disabling, demoting or deleting a user, and a project admin's demotion or removal, revoke the open invites that user no longer backs. Removing a membership revokes that user's tokens for the project.

We will order item writes the same way everywhere: the project row lock first (`allocate` for creates, `lockProjectForWrite` FOR SHARE otherwise), then item and edge rows; and any check that decides a write is made again inside the write transaction on the locked rows (or enforced by the write itself, as the push does with the revision it decided on).

## Consequences

A demoted or departed admin's links stop working at once, and the invite list shows them as revoked; an instance admin who needs one again creates a new invite. Re-added members create new tokens. Concurrent writers to one project serialise on the project row in a fixed order, so they conflict (409) instead of deadlocking or losing an edit; the cost is less parallelism for writes within one project, which is negligible at the expected team sizes. New write paths must follow the rule (packages/server/README.md "Rules that hold everywhere").

## Alternatives considered

- **Snapshot the creator's authority in the invite** - simpler accept path, but exactly the bug: the snapshot outlives the authority.
- **Retry transactions on 40P01/40001** - hides the symptom; a retry can still interleave and needs every closure to be side-effect free.
- **A separate counter row for number allocation** - removes one lock from the project row, but the chunk model-set lock (`FOR SHARE` on the project row) would still invert the order.
