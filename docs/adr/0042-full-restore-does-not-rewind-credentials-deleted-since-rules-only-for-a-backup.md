---
spoor_id: dcee4d82-2034-4f66-8ffd-45b5e97a42cb
adr: 42
title: Full restore does not rewind credentials; "deleted since" rules only for a backup of the same instance (_shared id match)
status: proposed
date: 2026-11-26
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m67]
tags: [backups, restore, security]
anchors: [packages/server/src/modules/backup/restore.ts]
---
# Full restore does not rewind credentials; "deleted since" rules only for a backup of the same instance (_shared id match)

## Context
The full restore epilogue re-applies live credential state: token revocations, `users.disabled_at`, newer password hashes, and invite revocations, including invites used live. Without a guard, restoring a backup from another instance (such as after a server move) would disable every user and revoke every token. Instance identity is inferred from whether the restored database contains the live `_shared` project id.

## Decision
We will apply the "deleted since backup" rules only when the restored database contains the live `_shared` project id. In that case, tokens and invites absent from the live state are revoked, and users absent from the live state are restored disabled. Otherwise those rules are skipped. The logic lives in `packages/server/src/modules/backup/restore.ts`.

## Consequences
- Restoring a backup from the same instance rolls credential state back consistently with the backup.
- Restoring a backup from another instance no longer disables all users or revokes all tokens.
- A `security` warning code is prepared for restore warnings.
- Trade-off: the rule depends on the `_shared` project id being present and stable, so changing that identifier would change restore behavior.
- Follow-up: implementation notes are recorded in ADR-0039.
