---
spoor_id: b6b30870-1110-4663-b67b-80fd2bfa90c1
adr: 21
title: "Graph view: one project-wide graph endpoint rendered as d3-force SVG with focus mode, read-only canvas plus side card"
status: proposed
date: 2026-10-21
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m31]
tags: [web, graph, links, api, dependencies]
anchors: [packages/server/src/modules/items/graph.ts, packages/server/src/modules/items/routes.ts, packages/web/src/pages/graph/GraphPage.tsx, packages/web/src/lib/graphLayout.ts, BRIEF.md]
---
# Graph view: one project-wide graph endpoint rendered as d3-force SVG with focus mode, read-only canvas plus side card

- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1)

## Context

Spoor already stored a link graph: the `edges` table holds seven kinds (`refines`, `supports`, `depends_on`,
`conflicts_with`, `supersedes`, `drafted_from`, `wikilink`), and each item page lists its outgoing and incoming edges
(`GET …/items/:ref/edges`). Nobody could see the graph as a whole: which items are isolated, which wikilinks point at nothing,
how decisions, docs and memories hang together. The MVP brief had put graph visualisation out of scope ("phase 2").

On 2026-10-21 the owner and Claude went through twelve questions, one at a time; the owner took the recommended answer each
time. The result is the BRIEF.md amendment "Graph view and link suggestions". Constraints carried in from earlier decisions:

- The web UI is React 19 with SVG and CSS tokens for light and dark mode, tested in jsdom (no layout engine) and Playwright.
- Every dependency is pinned exactly and passes the release-age check (ADR-0001).
- Visibility must match the per-item edges endpoint: a project member sees the project, its links into `_shared`, and on
  `_shared` only backlinks from projects they belong to (ADR-0005).
- The shared space can be large and is not the user's project; it must not be loaded as a whole.

## Decision

**Endpoint.** `GET /api/v1/projects/:slug/graph`, cookie auth, `project.read` (any member; `_shared` is readable by every
user). It is read-only. Query parameters (strict, unknown ones are 400 `invalid_input`):

| param | values | default |
|---|---|---|
| `spaces` | csv of `memories,decisions,docs,library` | all four |
| `kinds` | csv of the seven edge kinds | all seven |
| `lifecycle` | csv of `active,stale,archived` | `active,stale` |
| `include_superseded` | `true` \| `false` | `false` (hides `superseded` and `deprecated`) |
| `unlinked` | `true` \| `false` | `false`; whole-project mode only |
| `focus` | an item ref (handle, `S:` handle, slug, uuid) | none |
| `depth` | `1` \| `2` | `2`; only with `focus` |

`depth` without `focus`, and `unlinked=true` with `focus`, are 400 `invalid_input`. An unknown focus is 404, an ambiguous one 409.
The response is `{ nodes, edges, meta }`: nodes are a lean `ItemSummary` subset with viewer-relative handles plus `degree_in`,
`degree_out` and `ghost`; edges are `{ id, kind, src, dst, dst_ref?, editable }` (`dst` is null for a dangling wikilink, which is
not a node; the map draws one hollow node per distinct `dst_ref`); meta is `{ truncated, node_cap, total_nodes, unlinked_count,
dangling_count }`. A migration adds `edges_project_idx` on `edges(project_id)`.

**Core and ghost nodes.** Core nodes are the viewed project's items that pass the filters. An item outside the filters or in
another space (a shared item seen from a project, a project item seen from `_shared`) is a ghost: it is returned only because a
kept edge joins it to a core node. A kept edge needs at least one core end, so edges between two ghosts are never returned and
the rest of the shared space is never loaded. A regular project also sees edges stored in `_shared`, which matters only in focus
mode on a shared item. On `_shared`, backlinks from projects are kept only for the viewer's member projects (all for an instance
admin).

**Focus mode.** With `focus`, a breadth-first walk over visible edges in both directions up to `depth` hops. A reached item that
passes the filters is core and is walked further; any other reached item is a ghost and is not walked through. The focus item is
always core, even when the filters would hide it.

**Cap and truncation.** `GRAPH_NODE_CAP` = 1,500 nodes. Degrees, `total_nodes`, `unlinked_count` and `dangling_count` are counted
before the cap. When nodes exceed it, the server keeps the focus node, then core before ghosts, then pinned first, then higher
degree, newer `updated_at`, and `id`; it then drops edges with a cut end and ghosts left without an edge, and sets
`truncated`. With `unlinked=true` the node list is only the core nodes of degree 0 (picked over all kept edges before the cap, so
the cap only ever cuts among unlinked nodes), `edges` is empty and meta still describes the full filtered graph.

**Rendering.** A Map page at `/projects/:slug/graph` and `/shared/graph`, one nav entry after Library, its own lazy chunk.
`d3-force` **3.0.0** is the only new dependency (plus `@types/d3-force` 3.0.10 for development), pinned exactly. It is the
current release, published in 2021 and so far past the release-age delay, has no install scripts and only three small d3
dependencies, and does nothing but the force math. A pure function `layoutGraph` runs the simulation synchronously for a fixed
number of ticks (300, fewer above 200 nodes) and returns positions; d3-force's seeded random source makes it deterministic, so
it is unit-tested without a DOM. React owns the SVG and uses the existing CSS tokens. Pan and zoom are hand-rolled on the
`viewBox`: drag on the empty canvas, wheel zoom around the pointer (line and page wheel modes converted to pixels, at most ×2 per
event), buttons, and keys; nodes and edges are memoised layers, so a pan does not re-render them.

**Visual and accessible.** Shape gives the space (memories circles, decisions diamonds, docs squares, library hexagons), size the
degree; a dashed outline marks a ghost, a hollow node a dangling `[[ref]]`, an outer ring a pin, fading stale and archived items.
Each edge kind has its own stroke and dash; `conflicts_with` has arrows at both ends. A Legend explains everything in text. Every
node is a focusable button with a full accessible name; a list view (`view=list`) gives nodes and links as tables.

**URL state.** All state lives in the URL (`useSearchParamsState`, history replace): `spaces`, `kinds`, `lifecycle`,
`superseded=1`, `unlinked=1`, `q` (a client-side highlight), `focus`, `depth`, `view=list`. Defaults are left out of the URL and
the request, so the default map has one cache key.

**Side card, no drag-to-link.** Clicking a node opens a side card: handle and title, badges, degree, links by kind, suggested
links (ADR-0022), **Add relation** with the item page's dialog, **Open item** and **Focus here**. The canvas never edits:
there is no drag-to-link, and removing an edge stays on the item page. The item page gets **Open in map** (`?focus=<handle>&depth=2`).

**Link health.** The dashboard gets one line, `N items without links · M dangling references`, linking to the map with
`unlinked=1` and to the whole map; the map's status line shows `meta.unlinked_count` and `meta.dangling_count`.

## Consequences

- One read endpoint serves the whole-project map, focus mode, the dashboard's link to it and `spoor_get depth` (ADR-0022), which
  reuses the focus walk with the default filters.
- Large projects see a truncated map with a notice; the counts stay right because they are taken before the cap, and "unlinked
  only" is a server filter for the same reason.
- The layout is computed in the browser on every new response. 1,500 nodes stay interactive because ticks scale down, but very
  dense maps are cluttered; the answer is filtering or focus, not a bigger cap.
- Linking from the map needs two clicks (card, then Add relation or a suggestion's Link). Accepted: it keeps the canvas simple
  and avoids accidental edges.
- Follow-ups: anchors or files as nodes, and drag-to-link, are left for a later version. `sqlTextArray` in `items/links.ts` still
  binds one parameter per element; the graph's own id lists are bound as one `uuid[]` parameter.

## Alternatives considered

- **A full graph toolkit** (cytoscape, sigma, react-force-graph): heavy, canvas or WebGL rendering that is hard to theme with the
  CSS tokens and hard to test in jsdom.
- **No dependency, our own force simulation**: smaller, but a simulation needs tuning that d3-force already has.
- **Anchor-sharing edges or file nodes**: useful, but they are not stored links; deferred to a later version.
- **Loading the whole shared space** into a project map: large and mostly unrelated; only shared items reached by an edge appear.
- **Drag-to-link editing** on the canvas: easy to misfire, and hard to make accessible.
- **Only a neighbourhood panel** on the item page: does not show isolated items or the project's shape.
