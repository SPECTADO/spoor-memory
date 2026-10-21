---
spoor_id: 220ceb18-2d3a-488e-b891-de460503635f
adr: 23
title: Related-item floor lives at settings dedupe.related_min_cos (0.50-0.90, default 0.70), read clamped to threshold-0.01
status: proposed
date: 2026-10-21
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m35]
tags: [settings, links]
anchors: [packages/shared/src/settings.ts]
---
# Related-item floor lives at settings dedupe.related_min_cos (0.50-0.90, default 0.70), read clamped to threshold-0.01

- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1)
- **Refines:** [ADR-0022](0022-link-suggestions-are-computed-on-demand-from-existing-embeddings-nothing-stored.md)

## Context

This ADR refines ADR-0022, which ranks related items by cosine and needs a per-project minimum ("default 0.70, always below the
duplicate threshold" in the BRIEF.md amendment). Project settings are one zod schema in `packages/shared/src/settings.ts`, read
through `resolveSettings` with defaults filled, patched with `PATCH /api/v1/projects/:slug` and audited per path. The settings
page has one form group per section. The `dedupe` section already holds `threshold` (0.80 to 0.99, default 0.92): items at or
above it are near-duplicates and answer `DUPLICATE`, so a suggestion at or above it would be a duplicate, not a link.

## Decision

- Store the floor as `dedupe.related_min_cos`: range 0.50 to 0.90, default 0.70, in the existing `dedupe` section. Project
  admins (`settings.manage`) patch it like any setting (`{ "settings": { "dedupe": { "related_min_cos": 0.75 } } }`, audit path
  `dedupe.related_min_cos`). The web form shows it in the Duplicates group as "Related items minimum similarity", step 0.01, with
  `min` and `max` on the input.
- Read it only through `relatedMinCos(settings)` = min(`related_min_cos`, `threshold` − 0.01), rounded to 2 decimals. A write at
  or above the threshold is accepted and stored, and clamped on read: threshold 0.85 with 0.90 stored acts as 0.84.
- The floor is inclusive (`cos >= floor`) and comes from the settings of the item's project, for REST, MCP and the web alike.

## Consequences

- No new settings group, form section or migration; the existing patch, audit and export paths carry the field.
- Suggestions always sit below the near-duplicate band, whatever the two values are, and changing either takes effect on the
  next request (nothing is precomputed).
- Trade-off: the stored value can differ from the effective one, and the form does not warn about it; the hint text says the
  floor is "always kept below the duplicate threshold".
- Any new reader must call `relatedMinCos`, not read the raw field.

## Alternatives considered

- **A new `links` settings section**: an extra form group with the same migration cost, for one number.
