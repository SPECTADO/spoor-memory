---
spoor_id: 73cea0de-6a6c-49b3-8079-4b724cf3c18c
adr: 32
title: 'Near-copies: a per-model refusal band (dedupe.refuse_threshold) plus a "Possible duplicates" review section'
status: proposed
date: 2026-11-12
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m53]
tags: [dedupe, review, mcp]
anchors: [packages/shared/src/settings.ts, packages/server/src/modules/items/service.ts]
---
# Near-copies: a per-model refusal band (dedupe.refuse_threshold) plus a "Possible duplicates" review section

## Context
The ADR-0025 dedupe works as designed, but a benchmark found 0 of 10 reworded duplicates refused. On e5-small, different facts score as high as duplicates (up to 0.957), so no single cut-off is safe. Refusing at the existing note threshold would reverse ADR-0025 and lose about 1 in 40 different facts.

## Decision
We will add a per-model `dedupe.refuse_threshold` setting. An MCP create scoring at or above it, with no differing values and the same space and type, is refused with a DUPLICATE reply, and `allow_duplicate` still overrides. The default is 0.90 for embeddinggemma and off for every other model. We will also record saved near-copies (at or above `dedupe.threshold` with matching values) as pairs and show them in a "Possible duplicates" review section with Supersede and Not a duplicate actions.

## Consequences
- Automatic refusal applies only to embeddinggemma by default, so other models still save copies unless a user enables the band.
- Reviewers get one place to resolve saved near-copies.
- Trade-off: a different fact that scores at or above the band is refused until the caller passes `allow_duplicate`.
- Trade-off: the review section adds a queue that someone has to work through.
- Follow-up: implementation is in progress on `feat/0.7-release-prep`, in `packages/shared/src/settings.ts` and `packages/server/src/modules/items/service.ts`.

## Alternatives considered
- Refuse band only: does nothing for e5-small.
- Review queue only: never stops a copy from being saved.
- Refuse at the note threshold: reverses ADR-0025 and loses about 1 in 40 different facts.
