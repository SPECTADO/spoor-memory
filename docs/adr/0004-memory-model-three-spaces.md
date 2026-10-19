# ADR-0004: Memory model: memories, decisions and docs

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1, architect)
- **Tags:** domain-model, data

## Context

Agents need short facts, formal decisions and long documents with different lifecycles, addressable cheaply in a token-limited context. Source: `docs/design/data-model.md`, `cleanup-and-jobs.md`, `search-and-digest.md`; settles I2, I5, I6, I8, I10, I11, I14, I15, I17, I43.

## Decision

We will model three spaces over one `items` table: memories (facts, observations), decisions (ADRs with status `proposed|accepted|superseded|deprecated`) and docs. Agent-facing ids are handles `m42`, `d7`, `ADR-0007` with an `S:` prefix for shared items; the uuid is `spoor_id`, slugs are accepted and immutable (I2, I17). Typed edges (`relates`, plus system `supersedes` and `drafted_from`), `[[wikilinks]]`, and path anchors (exact path > glob > directory prefix, I14) link items. `spoor_supersede` covers memories only; an ADR is superseded by `supersedes: ADR-NNNN` in the new file (I5). Two axes: domain `status` and housekeeping `lifecycle` (`active|stale|archived`). Observations are short-lived and expire. The digest has tiers (pinned, decisions, anchors, query, rest) with budget shares (I37) and shows only accepted ADRs in the decision tier (I10).

## Consequences

One search, edge and revision mechanism for all content, and short handles save tokens. The shared table needs careful scoping rules (I42) and per-space validation. Splitting lifecycle from status adds states to reason about.

## Alternatives considered

- **Separate tables per space** - duplicated search, revision and edge code.
- **Uuids in agent output** - token-expensive and error-prone.
- **Free-form tags only** - no decision status, no supersede chain, no digest tiers.
- **One generic "note" type** - cannot express ADR lifecycle or observation expiry.
