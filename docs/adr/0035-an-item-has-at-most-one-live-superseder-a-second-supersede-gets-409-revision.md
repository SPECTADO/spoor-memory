---
spoor_id: 24accc2d-5afe-406a-b3e4-3f90ec2b083f
adr: 35
title: "An item has at most one live superseder: a second supersede gets 409 revision_conflict, enforced by a partial unique index (migration 0007)"
status: proposed
date: 2026-11-12
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m60]
tags: [supersede, concurrency, data-model]
anchors: [packages/server/src/modules/items/service.ts, packages/server/src/db/migrations/0007_edges_one_superseder.sql]
---
# An item has at most one live superseder: a second supersede gets 409 revision_conflict, enforced by a partial unique index (migration 0007)

## Context
Two simultaneous updates of one note could leave two current versions. Concurrent integration tests on real Postgres confirmed the root cause: `applySupersede` added the edge, then locked the old item, saw it was already superseded, and returned silently. Two supersedes without a revision therefore both succeeded, through REST, `spoor_supersede`, and `create`/`spoor_decide` with `supersedes`. Plain updates with a base revision were already a correct compare-and-set.

## Decision
We will lock the old item `FOR UPDATE` before adding a supersede edge. A different existing successor returns 409 `revision_conflict`, and a retry by the same successor stays a no-op. A partial unique index, `edges_one_superseder_uq` on `edges(dst_id) WHERE kind='supersedes'`, backs this rule for all writers.

## Consequences
- A concurrent or repeated supersede of one item can no longer leave two current versions, and the database enforces this even for writers that bypass the application check.
- Migration 0007 repairs existing data first. The earliest edge per target stays, and later ones become `refines` edges, or are deleted if that `refines` edge already exists. Statuses are untouched, and later successors stay active.
- Push and ADR import save the file without the edge and warn `supersede_conflict` instead of failing.
- Trade-off: a sequential second supersede that used to succeed now returns 409.
- Follow-up: the repair rule and the reuse of `revision_conflict` are the agent's choices and await owner review.

## Alternatives considered
- Make `revision` required on supersede. Rejected because it would break agents and the CLI.
- Check in the application only, without the index. Rejected because other writers could still violate the rule.
