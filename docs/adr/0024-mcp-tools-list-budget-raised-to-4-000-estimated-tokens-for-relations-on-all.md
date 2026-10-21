---
spoor_id: 52825ce6-9cc0-4285-9076-9819dc1447fb
adr: 24
title: MCP tools/list budget raised to 4,000 estimated tokens for relations on all write tools and spoor_get depth
status: accepted
date: 2026-10-21
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m37]
tags: [mcp, budget]
anchors: [packages/server/src/modules/mcp/tools.ts, packages/server/src/modules/mcp/tools.test.ts]
---
# MCP tools/list budget raised to 4,000 estimated tokens for relations on all write tools and spoor_get depth

- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1)
- **Refines:** [ADR-0022](0022-link-suggestions-are-computed-on-demand-from-existing-embeddings-nothing-stored.md)

## Context

This ADR refines ADR-0022, whose MCP changes grow the text every session pays for. `tools/list` for a writer token (nine tools)
was 3,440 estimated tokens (7,567 characters) under a regression ceiling of 3,500 in `packages/server/src/modules/mcp/tools.test.ts`,
using the estimator calibrated to Claude's tokenizer. ADR-0022 adds `relations` to `spoor_decide` and `spoor_doc_write`, the same
describe text on all three `relations` arguments, and `depth` on `spoor_get`. The owner allowed modest growth on 2026-10-21. The
describe texts were kept as short as the guidance allows (the `relations` text is 15 words); the details live in the agent guide.

## Decision

- Raise the writer `tools/list` ceiling to **4,000 estimated tokens**, enforced by the test above. Measured after the change:
  3,932 estimated tokens, 8,649 characters.
- The server instructions grow by one clause in the recording sentence, "link them to related items (relations, or
  spoor_relate)": 317 estimated tokens, 402 with `memory.exclusive` on (were 291 and 376). The read-only variant replaces the
  whole sentence and so does not grow.

## Consequences

- Every writer session pays about 490 more tokens at start for `tools/list` and about 26 more for the instructions. The agent
  guide's token-cost table says so.
- Headroom is now about 70 estimated tokens: the next tool argument or longer description needs a deliberate change to the
  ceiling, which is the point of the test.
- Viewer and read-only tokens see only the three read tools; their list grew only by `depth`.

## Alternatives considered

- **Keep 3,500 and shorten other descriptions**: they were already trimmed (mcp.md, at most 35 words each); cutting further would
  remove guidance agents use.
