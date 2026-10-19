# Phase 2 review log (server core)

Status: 2026-10-19. The fixer (Claude) checked each finding of the phase 2 code review (lenses: security, data
lifecycle, spec compliance, consolidation) against the code in `packages/server` and `packages/shared`, the
design files and BRIEF.md. Confirmed blockers and majors were fixed at the root cause with a regression test;
minors were applied where cheap. Design files, ARCHITECTURE.md, README.md and `packages/server/README.md` were
updated in the same work. The authority and lock-order rules are recorded in
[ADR-0012](../adr/0012-authority-and-write-ordering.md) (proposed, for the owner to confirm). Open owner
questions are at the end and in [deviations.md](deviations.md) §G.

Totals: 34 findings (2 blockers, 20 majors, 12 minors). **32 fixed**, **1 deferred** to phase 3/4 as planned
(SC2), **1 fixed in part** with the rest rejected (D-restore has no deterministic race test). Checks after the
fixes: `pnpm -r typecheck`, `biome check .`, server suite 1014 passed / 1 skipped (the real-model test), shared
86, web 2, cli 21, all green against the test database on port 55432.

Legend: S = security, D = data lifecycle, SC = spec compliance, C = consolidation. B / M / m = blocker / major /
minor.

## Security

| # | sev | finding | disposition | regression test | where |
|---|---|---|---|---|---|
| S1 | B | Open invites keep the privileges of a demoted, disabled, removed or deleted creator | **fixed**. One SQL predicate `creatorBacks` (creator exists, enabled, and is IA, or the invite has no instance flag, is no reset and the creator still administers every granted project that exists) is part of the preview, the accept pre-check and the single-use gate `UPDATE`. Disable, demotion and delete of a user, and a PA's demotion or removal, revoke the open invites the user no longer backs (`revokeUnbackedInvites`, `data.invites_revoked` in the audit row) | `invites.integration.test.ts` "the creator must still back an invite" (4 cases: demoted IA incl. reset invite, gate without revocation for deleted/disabled creator, removed/demoted PA, per-project revocation) | `auth/invites.ts`, `auth/service.ts`, `projects/members.ts`; auth-and-security §5, api §2.1, ADR-0012 |
| S2 | M | A shared item's `superseded_by` leaks another project's item (supersedes edge into `_shared` via import) | **fixed**. Folder import resolves `supersedes` / `drafted_from` only inside the archive (shared refs are listed as unresolved); lossless import keeps such edges dangling; `supersededBy()` counts only superseders of the item's own project (defence in depth) | `transfer.integration.test.ts` "supersedes / drafted_from never resolve into the shared space", "a lossless supersedes edge into the shared space is kept dangling" | `transfer/import.ts`, `items/rows.ts`; data-model §3 §8 |
| S3 | M | Removing a member does not revoke their tokens; re-adding revives them | **fixed**. `MemberService.remove` revokes the user's tokens for the project in the same transaction (`data.tokens_revoked`). User disable still only refuses tokens while disabled (disable is reversible by design; delete cascades) | `members.integration.test.ts` "removing a membership makes the user's project tokens unusable at once" (now re-adds the user) | `projects/members.ts`; auth-and-security §5, api §4.2 |
| S4 | M | Malformed but well-encoded cursors reach SQL casts: 500 | **fixed**. `decodeTypedCursor(cursor, kinds)` in `lib/pagination.ts` checks every part (timestamp round-trip, uuid, int4, string) and is used by every list (items, revisions, users, invites, review, audit) | `pagination.test.ts` "decodeTypedCursor", `items.integration.test.ts` "malformed cursors are 400, not 500" | `lib/pagination.ts` and callers; api §0.5 |
| S5 | m | `job_runs.error` stores drizzle's `Failed query: <SQL> params: <values>` | **fixed**. `jobErrorMessage(err)` stores `database error <SQLSTATE>` for database errors (cleanup and scheduler); `errorText` strips any `Failed query:` tail as a backstop | `jobs/store.test.ts` | `jobs/store.ts`, `cleanup.ts`, `scheduler.ts`; cleanup-and-jobs §4 |
| S6 | m | `id_collision` lists existing uuids of projects the importer cannot see | **fixed**. The error carries no ids and no count | `transfer.integration.test.ts` id-collision test asserts no `details` | `transfer/import.ts`; api §9 |

## Data lifecycle

| # | sev | finding | disposition | regression test | where |
|---|---|---|---|---|---|
| D1 | B | Push fast-forward decided outside the transaction; a concurrent web edit is overwritten | **fixed**. The write uses `expected: match.revision` (the revision the decision was made on); a `revision_conflict` re-runs the decision on the fresh row (fast-forward only if the new revision came from the CLI, otherwise 409 `pushed_over_spoor_edit` with `push_conflict_at`) | `push.integration.test.ts` "push races": web edit during the embedding call is a 409 (verified to fail without the fix), CLI push meanwhile is still a fast-forward | `items/push.ts`; data-model §7 |
| D2 | M | Inconsistent lock order (project row vs item rows) deadlocks concurrent writers (40P01 → 500) | **fixed**. Rule: project row first. Creates take it via `allocate`; update, supersede of an existing item, restore, delete, push update and pass 2, and the consistency sweep call `lockProjectForWrite` (FOR SHARE) before any item lock | `app.integration.test.ts` "a supersede and a PATCH of the same memory ... do not deadlock" (verified to fail without the fix) | `lib/db.ts`, `items/service.ts`, `items/push.ts`, `search/jobs.ts`; server README, ADR-0012 |
| D3 | M | `already_drafted` is check-then-act outside the create transaction | **fixed**. Checked again inside the create transaction after the project row lock, and the `drafted_from` edges are inserted in that transaction | `push.integration.test.ts` "two concurrent drafts of one memory: one ADR, one 409" | `items/push.ts`; data-model §7 |
| D4 | M | Import chunks built in an in-memory background task at the archive revision; stale chunks overwrite new ones; none right after import | **fixed**. The import transaction writes NULL-embedding chunk rows for every model of the locked set (FTS at once); `embed-pending` is nudged after the commit. The background rebuild (and `whenIdle`/shutdown drain) is removed | `app.integration.test.ts` export/import test asserts chunk rows (all pending) right after the 200 and FTS finds the item | `transfer/import.ts`, `transfer/service.ts`, `index.ts`; data-model §8, ARCHITECTURE §3.9 |
| D5 | M | Folder import stores a future `last_verified`; item never goes stale | **fixed**. Clamped to the import time (like push); lossless manifests clamp `last_verified_at`, `last_used_at`, `updated_at` with `least(x, now())` | `transfer.integration.test.ts` "a future last_verified is clamped" | `transfer/import.ts`; data-model §8 |
| D6 | M | Folder import into a non-empty project never claims existing dangling wikilinks | **fixed**. `claimExistingLinks` re-resolves every existing wikilink edge whose `dst_ref` is a new item's slug or handle against the full ref index (dangling claim and slug takeover in one pass) | `transfer.integration.test.ts` "a folder import claims the target project's dangling links" | `transfer/import.ts`; data-model §8 |
| D7 | m | `checkState` allows `pinned` + `stale` | **fixed**. Rejected as `invalid_archive`; future timestamps are clamped (D5) | `archive.test.ts` "a pinned item cannot be stale" | `transfer/archive.ts`; data-model §8 |
| D8 | m | Restore decides promotion from an `expired` read outside the transaction | **fixed in part**. The decision is re-made on the row locked inside the transaction (`promote_required` thrown there; a pending chunk set when no embedding was prepared). Rejected part: no regression test, because the race needs a hook between the pre-check and the transaction that the service does not have; existing restore tests cover both paths | — | `items/service.ts` |
| D9 | m | `conflicts_with` reverse check is SELECT-then-INSERT; concurrent a→b / b→a store both | **fixed**. A transaction advisory lock on the unordered pair serialises the check and the insert (no migration; canonical ordering is impossible because a project item may conflict with a shared one) | `edges.integration.test.ts` "concurrent relate(a, b) and relate(b, a) store one edge" | `items/links.ts`; data-model §3 |

## Spec compliance

| # | sev | finding | disposition | regression test | where |
|---|---|---|---|---|---|
| SC1 | M | `_shared` audit rows store `S:m1`; `?item=m1` finds nothing after a delete | **fixed**. Handle snapshots are relative to the row's own project (plain in `_shared`) in the item service and the cleanup job | `audit.integration.test.ts` "handle snapshots of _shared rows"; cleanup test updated | `items/service.ts`, `jobs/cleanup.ts`; api §10, data-model §4, cleanup-and-jobs §5 |
| SC2 | M | Several api.md §12 routes answer 501 (dashboard, review bulk, device, activity, MCP, install) | **deferred** to phase 3/4 as deviations.md G16 and the build plan say; the 501 set is now exact and documented identically in G16, ARCHITECTURE §2 and the server README. Owner question below on landing `activity` and `dashboard` earlier | — | deviations G16 |
| SC3 | M | The 501 catch-all swallows unknown paths, wrong methods and anonymous calls | **fixed**. 501 stubs only for the exact missing routes (cookie stubs answer 401 first without a session); everything else falls through to the JSON 404 | `app.test.ts` "is 401/404, not the 501 stub", `app.integration.test.ts` "only the not-yet-built routes are 501" | `app.ts`, `routes/{device,install,mcp}.ts`; api §12 |
| SC4 | m | Digest roll-ups and footer count one item several times | **fixed**. Each left-out item is counted once; roll-up lines are filled after all tiers ran (an item a later tier placed is not "more"); footer = left out and never shown. Pseudocode in search-and-digest §7 updated | `digest.test.ts` "dropped counts" | `search/digest.ts`; search-and-digest §7 |
| SC5 | m | Docs drift: README status, ARCHITECTURE 501 list, missing `docs/install.md` | **fixed**. README status reflects phase 2; ARCHITECTURE §2 lists the G16 set; `docs/install.md` is marked a phase 5 deliverable in ARCHITECTURE §4 | — | README.md, ARCHITECTURE.md |
| SC6 | m | `/healthz` unhealthy path untested; ping without timeout or de-duplication | **fixed**. One in-flight ping shared by concurrent probes, failed after 2 s; pool `connectionTimeoutMillis: 5000` | `app.test.ts` "/healthz after startup" (unhealthy + cache; shared ping + timeout) | `app.ts`, `db/client.ts`; api §11.2 |
| SC7 | m | `.env.example` lacks `NODE_ENV`; deployment.md states image paths as code defaults | **fixed** | — | `.env.example`, deployment §5 |

## Consolidation

| # | sev | finding | disposition | regression test | where |
|---|---|---|---|---|---|
| C1 | M | Two known-key tables disagree on docs `status`; export/import round trip changes status | **fixed**. One table (`COMMON_KEYS`, `SPACE_KEYS`, `knownKeys`, `extrasOf`) in `@spoor/shared`; docs `status` is a known, output-only key (never an extra); export never lets an extra override a known key | `shared/markdown.test.ts` "known keys", `canonical.test.ts` "docs status is a known key" | `shared/src/frontmatter.ts`; data-model §5 |
| C2 | M | Transfer's wikilink extractor has a weaker code stripper and does not dedupe; resolver duplicated | **fixed**. `WIKILINK_RE`, `stripCode`, `extractWikilinks` and the resolution order (`refTarget`, `spaceRank`, `pickRefTarget`) live in `@spoor/shared/wikilinks.ts`; `links.ts` `pick` and `RefIndex` both call `pickRefTarget`; transfer's copies are deleted | `shared/wikilinks.test.ts` (indented, double-backtick, unclosed and longer fences; precedence) | `shared/src/wikilinks.ts`, `items/links.ts`, `transfer/refs.ts`, `transfer/import.ts` |
| C3 | M | `contentFrom` re-implements the item field rules differently (UTF-16 title length, unnormalised anchors, duplicate tags) | **fixed**. `contentFrom` calls the items module's `cleanTitle`, `cleanBody`, `cleanTags`, `cleanAnchors`, `cleanExtras` and maps their errors to `invalid_archive` | `canonical.test.ts` "uses the item cleaners" | `transfer/content.ts`, `items/index.ts` |
| C4 | M | Items' `normalizeFile` and search's `normalizeFiles` disagree on `\` next to glob characters | **fixed**. One `normalizeFilePath` (always `\` → `/`) used by `normalizeFiles`, push and the `?anchor=` filter; `search/anchors.ts` moved to `packages/shared/src/anchors.ts`; `items/anchors.ts` deleted | `shared/anchors-validate.test.ts` "files: backslashes always become /" | `shared/src/anchors.ts`; search-and-digest §8, deviations G4 |
| C5 | M | Two frontmatter splitters and serializers | **fixed**. `splitFrontmatter` / `serializeMarkdown` with a typed `FrontmatterError` and the 16 KB cap in `@spoor/shared/markdown.ts`; push maps the error to `invalid_input`, transfer (`readMarkdown`) to `invalid_archive`; both old copies deleted | `shared/markdown.test.ts` "splitFrontmatter" | `shared/src/markdown.ts`, `transfer/canonical.ts`, `items/markdown.ts` |
| C6 | M | Revision snapshot and equality duplicated; transfer drops `status` and ignores `decidedOn` | **fixed**. Transfer uses the items module's `canonicalFrontmatter` and `sameContent`; an archive edit of only a decision's `date:` appends a revision | `canonical.test.ts` "revision snapshots and equality", `archive.test.ts` "an archive edit of only a decision date" | `transfer/archive.ts`, `transfer/import.ts`, `transfer/content.ts` |
| C7 | M | Two job contexts and an adapter that drops ctx for `chunkSweep` (no abort, no lease renewal) | **fixed**. `SearchJobs`, `BatchContext`, `JobError`, `LeaseLostError` live in `ports.ts`; the jobs `JobContext` extends `BatchContext`; the search job functions take it directly (deadline returns stats, abort or lost lease throws `JobError` with stats) and the sweep checks it between items; `searchJobsFor` and `runtime.test.ts` are gone | `search.integration.test.ts` "the sweep honours the scheduler context", "embed-pending stops at the absolute deadline" | `ports.ts`, `search/jobs.ts`, `search/index.ts`, `jobs/types.ts`, `runtime.ts`; deviations G8 |
| C8 | M | Three hand-copied `ItemSummary` serializers | **fixed**. `items/rows.ts` `summaryJson` is the only one, typed by `ItemSummary` in `@spoor/shared/api/items.ts`; review lists and search REST results load with `loadedColumns` / `loadItems` and call it | existing review and search route tests | `items/rows.ts`, `jobs/review.ts`, `search/format.ts`; deviations G6 |
| C9 | M | `mirrored_item` and `too_large` missing from `ERROR_STATUS`; `MirroredItemError` is not an `ApiError` | **fixed**. `mirrored_item` 409 and `too_large` 413 added; `mirroredItem()` builds an `ApiError`; `cleanBody` throws `too_large` with `details.limit` | `items.integration.test.ts` mirrored-items test, "field limits" | `shared/src/errors.ts`, `items/service.ts`, `items/writes.ts`; api §0.4, deviations G11 |
| C10 | m | Field limits copied in several places, zod copies count UTF-16 units | **fixed**. `ITEM_LIMITS` in `@spoor/shared` used by the frontmatter schema, the item cleaners and transfer; request zod bounds are loose upper bounds and the cleaners apply the exact limit in code points | `items.integration.test.ts` "field limits" (emoji title and body accepted at 150 / 150,000 code points) | `shared/src/frontmatter.ts`, `items/writes.ts`, `items/schemas.ts`, `transfer/schemas.ts` |
| C11 | m | Test-only code in `src/` ships in `dist/`; items suites use a hand-copied app | **fixed**. `items/testing.ts` deleted (suites use `testApp()` = the real `createApp`); `tsconfig.build.json` excludes `*.scenarios.ts` and `zipfixtures.ts`; a clean build has none of them | build output checked | `tsconfig.build.json`, `test/http.ts`; deviations G17 |
| C12 | m | `createApp` silently falls back to `stubPorts()` (fake embedding tag) | **fixed**. `ports` and `modules` are required in `AppDeps`; the fakes moved to `test/ports.ts`; only `NoopSearchPort` stays in `src`. `createAppModules` keeps its defaults for scheduler and search (they are built on the explicit `deps.ports`, so no fake can leak) | typecheck (every caller passes them) | `app.ts`, `ports.ts`, `test/ports.ts` |

## Rejected parts

- D8: the race test (no deterministic hook between the pre-check and the transaction); the fix itself is in.
- S3: revoking tokens on user disable (disable is a reversible state; tokens are already refused while
  disabled, delete cascades). Documented in auth-and-security §5.
- C12: making `createAppModules`' scheduler and search arguments required (tests would have to build both by
  hand; the footgun was the port fallback, which is gone).

## Owner questions

1. `too_large` is 413 (next to `payload_too_large`), on REST as well as MCP; before, an over-long body was a
   400 `invalid_input` on REST. Keep 413?
2. ADR-0012 (invite authority re-checked at use, member removal revokes tokens, project-row-first lock order)
   is Proposed: accept it?
3. SC2: `GET /p/:slug/api/activity` and `GET /api/v1/projects/:slug/dashboard` are plain reads that need no MCP
   work. Build them now with the server core, or keep them in phase 3/4 with the rest of G16?
