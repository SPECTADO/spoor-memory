---
spoor_id: d280d5a4-c3c7-45be-ad99-7b5bafdd7b13
adr: 22
title: Link suggestions are computed on demand from existing embeddings; nothing stored, no server-side LLM, surfaced to agents on write and get and to humans on the item page
status: proposed
date: 2026-10-21
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m32]
tags: [mcp, links, search, embeddings, web, agents]
anchors: [packages/server/src/modules/search/service.ts, packages/server/src/modules/mcp/handlers.ts, packages/server/src/modules/mcp/format.ts, packages/web/src/pages/item/LinksPanel.tsx, packages/shared/src/settings.ts]
---
# Link suggestions are computed on demand from existing embeddings; nothing stored, no server-side LLM, surfaced to agents on write and get and to humans on the item page

- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1)
- **Refined by:** [ADR-0023](0023-related-item-floor-lives-at-settings-dedupe-related-min-cos-0-50-0-90-default-0.md) (the floor setting), [ADR-0024](0024-mcp-tools-list-budget-raised-to-4-000-estimated-tokens-for-relations-on-all.md) (the tools/list budget)

## Context

Every item is already chunked and embedded under its project's active model (ADR-0003), with a partial HNSW index per model
tag. The vectors served search and the near-duplicate check (`dedupe.threshold`, default 0.92, which answers `DUPLICATE`), but
nothing told an agent or a person which existing items a new one *relates* to. Links were therefore rare: only `spoor_remember`
took `relations`, `spoor_relate` needed a handle the agent had to find first, and `spoor_get` printed bare handles in its
`links:` line.

The same grilling of 2026-10-21 as ADR-0021 settled how to help (the owner picked all four linking improvements offered).
Constraints:

- **No server-side LLM calls** (BRIEF.md, out of scope by design). Ranking has to use the stored vectors only.
- **No new stored state** unless it pays for itself: a suggestion table needs a lifecycle, a review queue and cleanup.
- **Token cost**: every MCP tool description is paid by every session (`tools/list`, then at most 3,500 estimated tokens);
  reply lines are paid per call.
- **No change to the AGENTS.md block or the Stop hook**: either would change `spoor init` output in every connected repository.
- A write must never fail because of a hint: the item is already committed when the hint is computed.

## Decision

**Related query.** `GET /api/v1/projects/:slug/items/:ref/related?limit=N` (cookie auth, `project.read`; `limit` 1 to 20,
default 5) returns `{ items: [{ item: ItemSummary, cos }], note? }`, `cos` rounded to 3 decimals, sorted by `cos` desc, then
`updated_at` desc, then `id`. One search-module method (`SearchPort.relatedCandidates`) serves REST, MCP and the web:

- Probe: up to 32 chunks of the item (`RELATED_PROBE_MAX`, the first by ordinal) under the project's active model.
- Per probe chunk, the K nearest **eligible** chunks are fetched, K = max(100, limit × 20) (`RELATED_KNN` = 100,
  `RELATED_KNN_PER_RESULT` = 20; 100 to 400 for limit 1 to 20), with HNSW iterative scan (`relaxed_order`, `ef_search` 100).
  Eligible means: same model tag; in scope (the project's four spaces, plus `_shared` when its active model tag is the same; for
  an item in `_shared`, only `_shared`); not the item; not linked to it by any edge kind in either direction; not in `excludeIds`
  (items linked in the same MCP call); not archived, superseded, deprecated or expired. Stale items are eligible. The exclusions
  run inside the nearest-neighbour search, so excluded items never use up its slots.
- Each candidate item scores its best chunk: the max cosine over those (probe chunk, candidate chunk) pairs. Then the floor
  (ADR-0023) and `limit` apply.
- The ranking is approximate by design. Beyond HNSW recall, an eligible item is missed only when, for every probe chunk, at least
  K chunks of other eligible items are nearer than all of its own (for example an unlinked long doc with more than K near
  chunks). A larger `limit` raises K.
- No vector yet (the item is not embedded under the active model): `{ "items": [], "note": "embedding pending: related items
  appear once the item is embedded" }`. An empty list without a note means nothing reached the floor.
- Nothing is stored, and no embedding provider is called on this path.

**MCP formats.** Short titles are cleaned like every other title line (control and bidi characters removed, whitespace
collapsed), cut to 40 code points with `…`, wrapped in double quotes (an inner `"` becomes `'`). Agent-written items carry `~`
after the handle, as in the digest and `spoor_search`.

- `spoor_remember`, `spoor_decide` and `spoor_doc_write` all take `relations` (at most 10 `{kind, to}`), described once in the
  same words: `links to add: refines = narrows or details, supports = evidence for, depends_on = requires, conflicts_with =
  contradicts (symmetric)`. Create replies echo `note: linked <kind>→<handle>` per created link, as updates already did.
- After a create, or an update that changed content, the reply may end with one line of up to 3 related items:
  `related: m30~ [fact] "Refresh tokens rotate" (0.81) · d2 "Auth overview" (0.74) · link: spoor_relate from=m57 to=<handle>
  kind=refines|supports|depends_on|conflicts_with`. Memories show `[type]`; shared items `S:` handles. It is left out when there
  is nothing, while the item is pending, for `OK unchanged`, and when the reload or lookup fails (logged as a warning; the reply is
  the plain `OK`).
- `spoor_get` prints titles in `links:` (`refines→m12 "Title" · supports←m50~ "Title" · wikilink→?ref`) and a `see also:` line of
  up to 3 related unlinked items. A new `depth` input (0 to 2, default 0) appends a `graph:` block: the focus walk of ADR-0021 with
  the map's default filters, one `hop N:` line per hop, an edge in the hop of its farther end, at most 400 estimated tokens for
  the block, then `+N more edges`.

**Where the hints appear.** Agents: the `related:` line after writes, `see also:` and `depth` on `spoor_get`. People: **Suggested
links** in the item page's Links panel and in the map's side card, each with a kind choice and a one-click **Link**; the dashboard's
link-health line (ADR-0021).

**Guidance placement.** The rules for choosing a kind live in a **Links** section of the agent guide and, in short form, in the
`relations` describe text. The server instructions' recording sentence gains one clause: "link them to related items (relations,
or spoor_relate)". The AGENTS.md block, the Stop hook and the CLI do not change. There is no new MCP tool.

## Consequences

- Agents get related items at the moment they can act on them, with a ready command, at the cost of one line per write. Humans
  get the same list in the UI.
- No new table, job or review state; suggestions always reflect the current items, links and settings.
- Each lookup costs one kNN query per probe chunk (up to 32) at request time. HNSW keeps it in tens of milliseconds on tested
  sizes; on small tables, or K = 400 on a few thousand chunks, Postgres may choose a plain scan instead (about 200 ms measured).
- Quality depends on the embedding model and the floor; the hint is advisory, and the agent guide says not to link on similarity
  alone.
- An agent may copy a handle with its trailing `~` from a `related:` or `graph:` line; refs do not accept `~`. Tolerating it in
  ref resolution would be a separate change.
- `tools/list` grew from 3,440 to 3,932 estimated tokens, so its ceiling moved to 4,000 (ADR-0024).
- Follow-up: if on-demand ranking proves too slow or too noisy, revisit a stored suggestion job.

## Alternatives considered

- **A background job storing suggested edges for approval**: new state, a review queue and cleanup; stale as soon as items change.
- **Server-side LLM ranking or judging**: forbidden by the brief, and it would add cost and latency to every write.
- **A new `spoor_related` tool**: one more description in every session's `tools/list`; `depth` and `see also` on `spoor_get` cover
  the read side.
- **Changing the AGENTS.md block or the Stop hook** to ask for links: changes `spoor init` output in every repository.
- **Applying exclusions after a fixed kNN** (the first implementation): a linked or archived long doc with 100 or more near
  chunks could use up every slot and return nothing.
