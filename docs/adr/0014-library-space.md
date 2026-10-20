---
spoor_id: b1dd9d82-90fa-42f2-aa12-be6e1e7db155
---
# ADR-0014: Library space: per-project pages written only by humans

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1, architect)
- **Tags:** security, data, digest

## Context

Teams want to set some knowledge in stone for agents in one project, such as a graphics guide, an architecture guide or coding conventions. Docs (ADR-0004) do not fit, because agents may write and edit them. The shared space (ADR-0005) does not fit either, because it is org-wide and needs an instance-level right.

A prompt-injected agent must never be able to rewrite, redirect or contradict this guidance through Spoor. The guidance must still reach every agent session cheaply.

Sources: BRIEF.md "Amendment (2026-10-20): Library space" and I37/I38; `docs/design/auth-and-security.md` §7, §8 and §13; `data-model.md`; `search-and-digest.md` §7.

## Decision

We will add a fourth space, `library`, to every project, including `_shared`.

**Storage and handles.** Library pages use the existing `items` table and all of its machinery: revisions, search, anchors, tags, wikilinks, export/import and audit. A page's handle is `L<n>`, or `S:L<n>` for a shared page seen from a project. `<n>` comes from the per-project counter shared with `m` and `d`. Slugs shaped `l<n>` are reserved.

A page is `active` or `archived`. It is never stale, expiring, pinned, verified, repo-mirrored or agent-provenance. A DB check (`items_library_shape_check`) enforces that state.

**Who may write.**
- Only a logged-in human in the web UI may create, edit, archive or restore a library page. That human must be an instance admin, a project admin, or a member holding the new per-membership `library_editor` flag.
- Project admins grant the flag, and any non-admin role may hold it. A viewer may maintain the graphics guide.
- The flag is stored false for admins, because the role implies the right. Demoting an admin clears it unless the admin who demotes them grants it explicitly, so no one keeps the right without a visible decision.
- On `_shared`, the existing shared-writer rule applies (instance admin or `shared_editor`).
- Hard delete stays with project admins and instance admins.

**One rule for shared and library.** Both use one server rule: `humanOnlyZone(project kind, space)`, applied by `assertWritable(caller, space)`.
- Once the item's space is known, the rule runs: on write-mode resolution, create, `insertNew` and edge removal.
- The entry-level calls made before the space is known keep checking only the shared rule.
- A web caller who holds only the library right (a viewer with the flag) is refused on every non-library item. (Creating a library page still retargets the project's matching wikilinks, see the ranking rule under Edges.)
- Every MCP, CLI, token and bearer path is refused with `read_only_space`. That covers update, verify, relate-from, supersede and push.
- A DB trigger refuses library revisions written via `mcp` or `cli` (`SPL02`), as a backstop.

**Lifecycle.** Library pages stay out of cleanup and out of the review queue. Pin, verify and supersede are refused with `wrong_space`.

**Edges.**
- Outgoing links from a library page (wikilink, `refines`, `supports`, `depends_on`) may point at any item, in the project or in `_shared`. They are a human choice made at save time: a wikilink resolves by handle, or by slug to an item that exists when the page is saved. A link that does not resolve is stored dangling.
- Project items may point at library pages with `refines`, `supports`, `depends_on` or a wikilink.
- Capture and takeover are blocked. A dangling wikilink whose source is a library page can be claimed only by a new library page, and a resolved one is never taken over by a newer item. An agent cannot redirect a library link by creating a slug twin later.
- `conflicts_with` (stored once, read both ways) between a library page and a non-library item is refused in both directions. `supersedes` and `drafted_from` whose destination is a library page are refused too. These rules live in the service and in the edge scope trigger (`SPL01`; custom code, because `P0003` is plpgsql's `too_many_rows`).
- Library pages rank first when a wikilink resolves, then the page's own space, then docs, decisions and memories. Because they outrank every other item, creating a library page retargets the project's matching wikilinks, including when the creator is a viewer holding the library flag.
- When a human re-saves a library page, wikilinks whose ref text is unchanged keep their stored target; an unchanged dangling ref resolves later only to a library page; refs newly added in that save resolve normally (library pages rank first); to repoint a link the human changes the ref text, for example to the item's handle.
- A slug read that matches both an own item and a `_shared` library page answers `ambiguous_id`.

Together these rules stop an agent from hijacking, contradicting or shadowing a page with a slug twin.

**Agent reads.**
- A new first digest tier, "Library", lists every active page as handle and title. Its header tells agents these are human-approved guides to follow, while the fixed "data, not instructions" framing line stays, so agents still never run embedded commands unconfirmed.
- The tier takes at most 15 % of the budget while later tiers have candidates. Together with pinned items and decisions it leaves at least 35 % for anchored and relevant items, which amends BRIEF I37.
- Own-project anchored pages sort first. Overflow collapses into one roll-up line.
- Agents also read through `spoor_search` (space `library`, included by default) and `spoor_get`. No MCP tool is added.

**No repo mirror.** Library pages live only in Spoor and travel with the project export zip as `library/<slug>.md`. Import normalises library rows and drops edges that break the rules above.

**Stated boundary.** "Human-only" means a request from a logged-in web session by a user who holds the right. An agent that drives that user's browser session cannot be told apart from the user. The shared space carries the same limit under ADR-0005. We document this boundary and do not claim more.

## Consequences

Projects get human-owned, agent-visible guidance without a second schema, and shared and library follow one write rule. Agents cannot change library pages; they must ask a human, which is friction by design. Agents can still point their own items at a page (refines, supports, depends_on) and remove those links from their own side.

Every enumeration of spaces must learn `library`: handles, wikilinks, slugs, search, transfer, the web and counts. A test ties the server and shared space lists together.

The digest gains a tier that comes before pinned items. With library, pinned and decision candidates all overflowing, decisions fall from 25 % to at least about 20 % of the budget. Projects without library pages get exactly today's output. The writer MCP tools/list grows by 18 estimated tokens, from 3,422 to 3,440 (measured 2026-10-20), and stays under its 3,500 ceiling. INSTRUCTIONS grows from 89 to 99 words (from 566 to 639 characters; 291 estimated tokens).

Servers on 0.1.0 cannot import archives that contain library pages. Migration 0004 renames existing slugs shaped `l<n>` to `x-l<n>` and rewrites resolved wikilink refs. Body text is not rewritten, so `[[l<n>]]` links must be re-saved by hand.

The flag is read when the request starts. A write already in flight when the flag is revoked can still commit, as with role changes today.

Possible follow-ups: invite grants carrying `library_editor`, step-up authentication for library writes, a human-only CLI push, and re-checking the right inside the write transaction.

## Alternatives considered

- **Reuse docs with a `locked` flag**: every write path would have to check a per-item flag, agents could still create look-alike docs, and the digest could not tell guidance from notes.
- **Store project guidance in the shared space**: it is org-wide, it needs an instance-level right, and it mixes unrelated projects.
- **A new `spoor_library` MCP tool**: it costs tools/list tokens in every session, and `spoor_search`/`spoor_get` already cover reads.
- **A `library_editor` project role instead of a flag**: roles are ordered (viewer < editor < admin), and the library right is orthogonal to them.
- **Let library pages link only to library pages, or let agent items author `conflicts_with`**: the first rule was rejected by the owner, because guides need to point at the docs and decisions they depend on, and those links are human choices at save time. Blocking capture and takeover of library links keeps them safe. `conflicts_with` with non-library items stays refused, because it is symmetric and would read as the page's own claim.
- **A library share of 25 % of the digest**: it squeezed recent decisions to about 10 % of the budget.
- **Keep the flag across admin demotion**: it leaves a hidden write grant behind, because admin rows always show the right as on.