# REST API

Status: design, 2026-10-19. Authority: [auth-and-security.md](auth-and-security.md) (surfaces, roles, CSRF),
[data-model.md](data-model.md) (shapes), [mcp.md](mcp.md) (error codes, write semantics),
[search-and-digest.md](search-and-digest.md) (search, digest), [cleanup-and-jobs.md](cleanup-and-jobs.md)
(review queue). This file adds no behaviour of its own except where marked **new** (listed in
[deviations.md](deviations.md) I23 to I28 and §F; review outcomes in [review-log.md](review-log.md)).

Implementation: Hono routes in `packages/server/src/modules/<name>/routes.ts`, request and response schemas as zod in
`packages/shared/src/api/` (the SPA and the CLI import the same schemas).

## 0. Conventions

### 0.1 Surfaces

| prefix | auth | consumer |
|---|---|---|
| `/api/v1/*` | session cookie; origin check on unsafe methods; a request with an `Authorization` header gets 400 `invalid_input` | SPA |
| `/p/:slug/api/*` | bearer token only; cookies ignored | `spoor` CLI and hooks |
| `/p/:slug/device/*` | public | `spoor login` |
| `/p/:slug/mcp` | bearer token | agents ([mcp.md](mcp.md)) |
| `/p/:slug/install.md`, `/p/:slug/install.json`, `/healthz` | public | humans, `spoor init`, probes |

No CORS headers anywhere. JSON bodies need `Content-Type: application/json` (exception: import upload is
`multipart/form-data`). JSON bodies are capped at 1 MB (413 `payload_too_large`), uploads at 50 MB.
Unknown fields in a request body are rejected (`invalid_input`).
The `Content-Type: application/json` rule of [auth-and-security.md](auth-and-security.md) §4 applies to unsafe requests that carry a
body; bodyless unsafe requests (logout, the item actions of §5.3, `DELETE`) are protected by the origin check alone (I28).

### 0.2 Roles in this file

`public` · `any` (logged-in user) · `V` / `E` / `PA` (project viewer / editor / project admin, an instance admin
counts as `PA` everywhere) · `IA` instance admin · `SE` the `shared_editor` right ·
`UT` user token, `ST` service token (effective role from [mcp.md](mcp.md) §2).
"Member" means any project role. Space writes on the shared project (`_shared`) need `IA` or `SE`
instead of `E`/`PA`; reads need `any`.

### 0.3 Addressing

- Projects are addressed by slug. **The shared space is the project with slug `_shared`**, so every
  `/api/v1/projects/:slug/...` route below also serves it (with the permission swap above). It is not
  in `GET /api/v1/projects`; the SPA links it separately.
- `:ref` (item) accepts a handle (`m42`, `d7`, `ADR-0007`), an item uuid or a slug
  ([data-model.md](data-model.md) §0). The `S:` prefix is not needed here (the project in the path
  already says which space), but is accepted in `to` fields that may point across projects.
  Ambiguous slug: 409 `ambiguous_id` with `details.handles`. Resolution is scoped to the path's project
  (plus `_shared` in `to` fields only); a uuid of another project is 404 `not_found`.
- `:space` is `memories | decisions | docs`.

### 0.4 Errors

One flat shape for every non-2xx JSON response, the same one the auth doc already uses
(`{"error":"invalid_token","hint":"…"}`) and RFC 8628 requires for the device token endpoint:

```json
{ "error": "revision_conflict",
  "message": "Item m42 is at revision 7, request was based on 5.",
  "hint": "Re-read the item and re-apply your change.",
  "details": { "current_revision": 7 },
  "request_id": "01J…" }
```
`error` (stable code, machine) and `request_id` always; `message` (English, human), `hint` and `details` when
useful. No tokens, SQL, stack traces or other users' emails. Validation failures: 400 `invalid_input` with
`details.issues = [{ "path": "tags.0", "message": "…" }]`.

| status | codes |
|---|---|
| 400 | `invalid_input`, `invalid_grant`, `authorization_pending`, `slow_down`, `access_denied`, `expired_token` (device), `unsupported_grant_type` |
| 401 | `unauthenticated` (cookie routes), `invalid_credentials`, `invalid_token` (bearer routes) |
| 403 | `forbidden`, `forbidden_role`, `forbidden_origin`, `read_only_space`, `token_project_mismatch` |
| 404 | `not_found`, `user_not_found` |
| 409 | `revision_conflict`, `revision_required` (a 400), `slug_taken`, `ambiguous_id`, `pushed_over_spoor_edit`, `already_drafted`, `source_path_taken`, `last_admin`, `promote_required`, `edge_not_editable`, `project_not_empty`, `id_collision`, `already_exists`, `mirrored_item` (MCP only) |
| 413 | `payload_too_large`, `zip_limits`, `too_large` (an item body over 200,000 characters after normalisation, `details.limit`; REST and MCP) |
| 422 | `invalid_archive` |
| 503 | `busy` (password hash queue; an import or export already running), `too_many_pending` (device codes), `starting` (before the server is ready) |
| 500 | `internal` |

MCP codes (`wrong_space`, `mirrored_item`, `not_found`, …) keep their meaning on REST; `wrong_space` is 400,
`mirrored_item` is not raised on REST (web edits of mirrored items are allowed and return a warning, §5.2).
`revision_required` is a 400.

Library pages (ADR-0014) use existing codes only: `read_only_space` (403) for any bearer write touching a library page and for a
web user with `item.write` but not `library.write`; `forbidden` (403) for a web user with neither right, for a viewer holding
only the library flag acting on a non-library item, and for a library editor who is not PA or IA hard-deleting; `wrong_space`
(400) for an authorised human who pins, verifies or supersedes a library page, restores it with `promote_to_fact`, or draws a
refused edge (`conflicts_with` with a non-library item, `supersedes` or `drafted_from` into a library page); `invalid_input` for
`pinned: true` on a library page. A slug read naming both an own item and a `_shared` library page is 409 `ambiguous_id`. The DB
backstops map `SPL01` to `wrong_space` and `SPL02` to `read_only_space`.

### 0.5 Pagination and lists

Cursor pagination on every unbounded list: `?limit=` (default 50, max 200) and `?cursor=` (opaque). Response:
```json
{ "items": [ … ], "next_cursor": "eyJ…" | null }
```
Bounded lists (projects visible to the user, project members, tokens of one project, review counts, search)
return `{ "items": [ … ] }` or their own shape and say so. Sort orders are stable and tie-break on id, so
cursors never skip or repeat. Timestamps are ISO 8601 UTC strings. A cursor that decodes but whose parts do not
have the expected types (timestamp, uuid, integer) is 400 `invalid_input`, never a database error
(`decodeTypedCursor` in `lib/pagination.ts`, used by every list).

### 0.6 Shared JSON shapes

`ItemSummary` (lists, search, review):
```json
{ "id": "uuid", "handle": "m42", "project": "acme", "space": "memories", "number": 42, "adr_number": null,
  "slug": "session-store", "title": "…", "type": "fact", "status": "active", "lifecycle": "active",
  "confidence": "medium", "tags": ["auth"], "anchors": ["src/auth/"], "pinned": false, "revision": 3,
  "provenance": "agent", "decided_on": null, "source_path": null, "push_conflict_at": null,
  "last_verified_at": "…", "last_used_at": null,
  "expires_at": null, "stale_since": null, "archived_at": null, "archive_reason": null,
  "created_at": "…", "updated_at": "…", "updated_by": "ann@example.com", "client_name": "claude-code/2.1.303" }
```
`updated_by` (and `Item.created_by.label`) are the stored labels (`updated_by_label`), so they survive user
deletion and import; imported rows read `imported: ann@example.com`.
`handle` of a shared item has the `S:` prefix when it is seen from a regular project (search with shared
results, an edge or conflict end); responses about `_shared` itself (its lists, review queue, item pages) use
plain handles, so a handle always resolves in the project of the URL. `type` and `confidence` are `null` outside memories,
`adr_number` and `decided_on` only on decisions.

`Item` = `ItemSummary` + `body`, `extra` (the unknown-frontmatter object), `created_by`
(`{id|null, label}`), `superseded_by` (handle or null).

`Actor` in history and audit: `{ "user_id": "uuid|null", "label": "ann@example.com | service:ci | system", "via": "web|mcp|cli|import|system", "client_name": "…|null" }`.

## 1. Auth

| method | path | auth | request | response |
|---|---|---|---|---|
| POST | `/api/v1/auth/login` | public (origin-checked) | `{email, password}` | 200 `{user}` and `Set-Cookie`. 401 `invalid_credentials` (unknown email, wrong password and disabled user look the same), 503 `busy` |
| POST | `/api/v1/auth/logout` | any | none | 204, session row deleted, cookie cleared |
| GET | `/api/v1/me` | any | | 200 `{user:{id,email,name,is_admin,shared_editor}, memberships:[{project:{id,slug,name}, role}]}`. 401 `unauthenticated` is how the SPA detects a missing session |
| PATCH | `/api/v1/me` | any | `{name}` | 200 `{user}` |
| POST | `/api/v1/me/password` | any | `{current_password, new_password}` | 204. Deletes every other session of the user. 401 `invalid_credentials` |
| GET | `/api/v1/instance` | public | | 200 `{version, public_url, providers:[{name,tag,dims,remote}], default_provider}` for the login page footer and the settings page |

Password rules: 12–256 characters after NFKC, no composition rules.
Unauthenticated calls to any other `/api/v1` route return 401 `unauthenticated`; routes the user may not use
return 403 `forbidden` (never 404, except for projects the user cannot see, which return 404 `not_found`, so a
non-member learns nothing about the project; the slug itself is not secret, [auth-and-security.md](auth-and-security.md) §1).

## 2. Invites and users

### 2.1 Invites

| method | path | auth / role | request | response |
|---|---|---|---|---|
| POST | `/api/v1/invites/preview` | public (origin-checked) | `{token}` | 200 `{email|null, is_admin, shared_editor, reset:boolean, grants:[{project:{slug,name}, role}], expires_at}`. 404 `not_found` for unknown, used, revoked or expired. The token is in the body, never in the URL |
| POST | `/api/v1/invites/accept` | public (origin-checked) | `{token, name, email?, password}` | 201 `{user}` and `Set-Cookie` (logs the user in). `email` is required unless the invite is locked to one; a locked invite ignores a different one with 400. A **reset** invite (`reset_user_id` set) sets the new password of exactly that user, deletes all their sessions and, if `reset_revoke_tokens`, revokes their tokens; `name`/`email` are ignored. Any other invite whose email (locked or supplied) belongs to an existing user: 409 `already_exists`, nothing written, invite still unused. 404 `not_found` when the single-use gate fails, including an invite its creator no longer backs (deleted, disabled, demoted, or no longer admin of a granted project; [auth-and-security.md](auth-and-security.md) §5); `preview` answers the same 404 |
| GET | `/api/v1/invites` | IA (all); creator (own); PA (invites with **non-empty** grants, all on projects they administer, and not `is_admin`, `shared_editor` or reset) | `?status=open|used|expired|revoked&cursor&limit` | 200 list of `{id, email, is_admin, shared_editor, reset:boolean, reset_user_id, grants:[{project:{slug,name}, role}], status:"open"|"used"|"expired"|"revoked", created_by:uuid|null, created_at, expires_at, used_at, used_by:uuid|null, revoked_at}`, newest first (cursor on `created_at, id`); grants on deleted projects are left out |
| POST | `/api/v1/invites` | IA; PA with a **non-empty** `grants` list, all on own projects | `{email?, grants:[{project:"slug", role}], is_admin?, shared_editor?, reset_user_id?, reset_revoke_tokens?, expires_in_hours?}` | 201 `{invite (as in GET), token:"spi_…", link:"<PUBLIC_URL>/invite#spi_…"}`. Grants must name existing regular projects, each at most once (400 `invalid_input`). The token appears **only here**. `expires_in_hours` 1–720, default 168. `is_admin`, `shared_editor`, `reset_user_id` need IA (403 `forbidden` otherwise); a PA request with `grants:[]` is 400 `invalid_input`. `reset_user_id` locks the invite to that user's email, requires `grants:[]` and no instance flags; `reset_revoke_tokens` defaults to true |
| DELETE | `/api/v1/invites/:id` | creator, IA, or PA under the same rule as GET | | 204 (sets `revoked_at`); revoking twice is a no-op 204 |

### 2.2 Users (IA)

| method | path | request | response |
|---|---|---|---|
| GET | `/api/v1/users` | `?q=` (email or name prefix), cursor, limit | list of `{id, email, name, is_admin, shared_editor, disabled_at, created_at, memberships:[{project, role}]}` |
| GET | `/api/v1/users/:id` | | one user as above |
| PATCH | `/api/v1/users/:id` | `{name?, is_admin?, shared_editor?, disabled?: boolean}` | 200 user. Disabling deletes the user's sessions. 409 `last_admin` when it would remove the last instance admin |
| DELETE | `/api/v1/users/:id` | `?confirm=<email>` | 204. Tokens and sessions cascade; authored items keep their history through `actor_label`. 409 `last_admin` as above |

Users are created only through invites.

## 3. Device flow

CLI side, public, slug-scoped (details and rules in [auth-and-security.md](auth-and-security.md) §6):

| method | path | request | response |
|---|---|---|---|
| POST | `/p/:slug/device/code` | `{client_name}` (≤ 64 chars; longer is truncated, control characters stripped) | 200 `{device_code, user_code, verification_uri, expires_in:600, interval:5}` (no `verification_uri_complete`, by design). 404 unknown slug (and for `_shared`); 503 `too_many_pending` only when the instance-wide cap is reached and nothing pending can be evicted |
| POST | `/p/:slug/device/token` | `{grant_type:"urn:ietf:params:oauth:grant-type:device_code", device_code}` | 200 `{access_token:"spr_…", token_type:"Bearer", project, role, token_name}` once. Otherwise 400 with `error` = `authorization_pending` · `slow_down` (only while pending; `details.interval` = the new interval) · `access_denied` (also when the approver lost access to the project before the poll) · `expired_token` · `invalid_grant` (unknown, consumed, or a code of another project) · `unsupported_grant_type`. `Cache-Control: no-store`; unknown slug 404 |

The public endpoints take JSON bodies of at most 16 KB. `requester_ip` is the TCP peer address, or with `SPOOR_TRUST_PROXY` and a trusted peer the right-most `X-Forwarded-For` hop that is not a trusted proxy (deployment.md §5; default off, then behind a reverse proxy it is the proxy's address, deviations.md P3-1).

Browser side (cookie, origin-checked):

| method | path | role | request | response |
|---|---|---|---|---|
| GET | `/api/v1/device/lookup?code=WDJB-MJHT` | member of the code's project, IA | | 200 `{project:{slug,name}, client_name, requester_ip, requested_at, age_s, your_role}`. 404 `not_found` for a wrong or expired code **and** for a code of a project the user is not a member of; after 5 misses in 10 minutes per user, 403 `forbidden` with `hint` for 10 minutes |
| POST | `/api/v1/device/approve` | member of the code's project, IA | `{code, read_only?: boolean}` | 200 `{status:"approved", role_cap}`. `read_only` caps the minted token at `viewer` (`role_cap:"viewer"`); without it `role_cap` is `null` and the token inherits the approver's live role. The minted token has `origin:"device"` and expires after 90 days. 404 as for lookup (also for a code decided meanwhile). Audited as `device.approve` |
| POST | `/api/v1/device/deny` | member of the code's project, IA | `{code}` | 200 `{status:"denied"}`; 404 as for lookup. Audited as `device.deny` |

Only pending, unexpired codes can be looked up, approved or denied. Every 404 of these three routes (bad format, unknown, expired, decided, or not a member) counts as a miss for the lock, and the lock covers all three; the fifth miss already answers 403.

## 4. Projects, memberships, tokens

### 4.1 Projects

| method | path | role | request | response |
|---|---|---|---|---|
| GET | `/api/v1/projects` | any | | 200 `{items:[{slug,name,description,role,counts:{memories,decisions,docs,library}, review_total}]}`. Members only; IA sees all. Not paginated. `counts` are items that are not archived; `review_total` is the sum of the review sections of [cleanup-and-jobs.md](cleanup-and-jobs.md) §6 (stale, archived in the last 30 days, observations expiring within 48 h, open conflicts, push conflicts); library pages are never counted in it |
| POST | `/api/v1/projects` | IA | `{slug, name, description?, settings?}` | 201 project. 409 `slug_taken`. Slug rules in [data-model.md](data-model.md) §6. `settings` is a partial object as in PATCH; without `embedding.provider` the instance default provider is stored. Audited as the instance-level `project.create`. The creator gets no membership (an IA is project admin everywhere) |
| GET | `/api/v1/projects/:slug` | member; any for `_shared` | | 200 `{id, slug, name, description, kind, settings, role, can_edit_library, embedding:{model, target, remaining}, created_at}`. `can_edit_library` is the server's answer to `can('library.write')` (IA, PA, a member with the flag; on `_shared` IA and SE); the SPA gates every library control on it and never recomputes it. `settings` has every default filled in. `role` is the effective role (`admin` for IA); on `_shared` it is `admin` for IA, `editor` for SE and `viewer` for everyone else, for the SPA's role gates. `remaining` is the count of items without target chunks while a re-embed runs |
| PATCH | `/api/v1/projects/:slug` | PA, IA (`_shared`: IA) | `{name?, description?, settings?}` | 200 project. `settings` is a partial object deep-merged and validated ([data-model.md](data-model.md) §2.1); issues are reported under `settings.…`. Changing `embedding.provider` sets `embedding_target` (response `embedding.target`) and nudges the `reembed` job; choosing the active model's provider again clears it; a provider not enabled on the instance is 400. The slug is immutable (sending it is 400). Audited as `project.update` (`data.fields`) and `project.settings` (`data.changed`, the patch) |
| DELETE | `/api/v1/projects/:slug` | IA | `?confirm=<slug>` | 204. The shared project cannot be deleted (403 `forbidden`). One purge transaction: everything of the project cascades and its audit rows are removed with it; an instance-level `project.delete` row remains ([data-model.md](data-model.md) §4) |
| GET | `/api/v1/projects/:slug/dashboard` | member; any for `_shared` | | 200 `{counts:{memories:{active,stale,archived},decisions:{…},docs:{…},library:{…}}, review:{stale,archived,expiring,conflicts,push_conflicts}, recent:[{item:ItemSummary, change, actor:Actor, at}]}` (`DashboardResponse` in `@spoor/shared`). `counts`: items per lifecycle, archived included (`library` is only ever active or archived). `review`: the same numbers as `GET …/review` (all five sections, cleanup-and-jobs.md §6). `recent`: the last 15 content or lifecycle changes of items that still exist, newest first, read from the audit log; `change` is `create`, `update`, `supersede` (this item became superseded), `push`, `stale`, `archive`, `expire` or `restore` (verify and pin are not listed); `item` is the item as it is now |
| GET | `/api/v1/projects/:slug/context` | member; any for `_shared` | same query as §7.1 | the digest, so admins can preview what agents get (cookie twin of the bearer endpoint) |

### 4.2 Memberships

| method | path | role | request | response |
|---|---|---|---|---|
| GET | `/api/v1/projects/:slug/members` | PA, IA | | 200 `{items:[{user:{id,email,name}, role, library_editor, created_at}]}`; `library_editor` is the stored value (false for admins) |
| POST | `/api/v1/projects/:slug/members` | PA, IA | `{email, role, library_editor?}` | 201 member (`library_editor` defaults to false and is stored false for role admin). 404 `user_not_found` with `hint: "create an invite instead"`. 409 `already_exists`. Reveals whether an email has an account, to project admins only. Audited as `member.set` (`data.previous: null`) |
| PUT | `/api/v1/projects/:slug/members/:userId` | PA, IA | `{role?, library_editor?}` (at least one; `memberRoleRequest` is an alias of `memberUpdateRequest`) | 200 member. 409 `last_admin` when demoting the last project admin (this binds IA too). The stored flag is false whenever the role is admin: promoting clears it, demoting an admin sets it to the body's `library_editor` (default false), a viewer/editor change keeps it. Audited as `member.set` with `data.previous`, `data.library_editor` and `data.previous_library_editor`; the summary says "(implied by role change)" when the flag changed without being asked |
| DELETE | `/api/v1/projects/:slug/members/:userId` | PA, IA; a member may remove self | | 204. The user's tokens for the project are revoked in the same transaction (re-adding the user does not revive them), and a removed project admin's open invites into the project are revoked. 409 `last_admin`. Audited as `member.remove` (`data.tokens_revoked`, `data.invites_revoked`) |

The shared project has no members: these routes return 404 for `_shared`, which also has no `library_editor` flag (its library is written by IA and SE).

### 4.3 Tokens

| method | path | role | request | response |
|---|---|---|---|---|
| GET | `/api/v1/projects/:slug/tokens` | member (own user tokens); PA, IA (all) | `?include=revoked` | 200 `{items:[{id, kind, origin:"web"|"device", name, prefix, role, user:{id,label}|null, created_at, last_used_at, expires_at, revoked_at}]}` |
| POST | `/api/v1/projects/:slug/tokens` | member for `kind:"user"` (always the caller's own); PA, IA for `kind:"service"` | `{kind, name, role?, expires_at?}` | 201 `{token:{…as above}, secret:"spr_…"}`; the secret appears **only here**. User tokens: `role` optional cap (`viewer` for read-only). Service tokens: `role` required (`editor|viewer`, never admin). `expires_at` (ISO 8601 with offset) must lie in the future (400). Audited as `token.create` |
| DELETE | `/api/v1/projects/:slug/tokens/:id` | owner, PA, IA | | 204. Revokes (`revoked_at`); the row stays for the audit trail. Effective at the next request. Revoking twice is a no-op 204. A member gets 404 for a token that is not theirs (as in the list). Audited as `token.revoke` |

Tokens never target `_shared` (404).

## 5. Spaces: items, revisions, edges

All under `/api/v1/projects/:slug`. Reads need `V` (or `any` for `_shared`), writes `E` (shared: `IA`/`SE`).

### 5.1 Lists and create

| method | path | notes |
|---|---|---|
| GET | `/spaces/:space/items` | `:space` is `memories`, `decisions`, `docs` or `library`. Filters: `type=fact,procedure`, `status=`, `lifecycle=active,stale` (default `active,stale`; `all`), `tag=` (repeat for AND), `pinned=true`, `anchor=<path>` (items whose anchors match that file, same matcher as the digest), `q_title=` (case-insensitive substring, for pickers), `sort=updated|created|verified|number` with `dir=asc|desc` (default `updated desc`). Returns `{items:ItemSummary[], next_cursor}` |
| POST | `/spaces/:space/items` | create. Body below. 201 `{item, warnings}` |

Create body (all spaces): `title`, `body?` (≤ 200,000 chars), `tags?`, `anchors?`, `pinned?`, `slug?`, `extra?`,
`relations?` (`[{kind,to}]`, typed kinds only, `to` may be `S:` handle), `supersedes?` (ref).
- memories: `type` required, `confidence?` (default `medium`), `allow_duplicate?`. The near-duplicate warning
  never matches the item named in `supersedes`.
- decisions: `status?` (default `proposed`), `adr_number?` (must be free, else 409 `already_exists` with `details.handle`), `decided_on?`. `supersedes` sets the other ADR to `superseded`.
- docs: nothing extra.
- library: nothing extra, but only for callers who hold `library.write` (IA, PA, a member with the flag; `_shared`: IA, SE): others get 403 `read_only_space`, or `forbidden` without `item.write`. `pinned: true` is 400 `invalid_input`; `supersedes` is 400 `wrong_space`. The handle is `L<n>`; the lifecycle is `active` or `archived`, never `stale`.

`warnings` entries: `{code:"near_duplicate", handle, cos, title}` when the near-duplicate check hits (the web
path never blocks, [search-and-digest.md](search-and-digest.md) §5), `{code:"embedding_pending"}`.
409 `slug_taken` carries `details.handle`.

### 5.2 One item

| method | path | request | response |
|---|---|---|---|
| GET | `/items/:ref` | | 200 `Item`. Does not bump `last_used_at` |
| PATCH | `/items/:ref` | `{revision, title?, body?, type?, confidence?, status?, tags?, anchors?, extra?}` | 200 `{item, warnings}`. `revision` is required (400 `revision_required`). 409 `revision_conflict` with `details:{current_revision, current: Item}` and nothing written. Runs the complete content statement of [data-model.md](data-model.md) §3: a stale item returns to `active`, a type change to `observation` sets `expires_at = now() + observation_days`, `provenance` becomes `human`. `warnings` may hold `{code:"mirrored_item", source_path}`: the web edit is saved, and the next repo push will answer `pushed_over_spoor_edit` ([data-model.md](data-model.md) §7) |
| DELETE | `/items/:ref?confirm=<handle>` | | 204. Hard delete, `PA`/`IA` (shared: `IA`/`SE`). `confirm` must equal the handle (400 otherwise). Runs in the purge transaction; the audit row remains |

Library pages follow the same PATCH rules; `pinned` and a status other than `active` are 400 `invalid_input`.

Immutable: `slug`, `space`, `number`, `adr_number` (400 `invalid_input` if sent).

### 5.3 Operational actions (no revision, idempotent, audited with `via='web'`)

`POST /items/:ref/{pin|unpin|verify|archive|restore}`, role `E` (shared: `IA`/`SE`), optional body `{note?}`.
Response 200 `{item}`.

- `verify`: sets `last_verified_at = now()`, stale → active, `provenance='human'`. Archived items return 400 `invalid_input` with `hint: "restore first"`.
- `archive`: `archive_reason='manual'`.
- `restore`: archived → active, clears `archived_*`, `last_verified_at = now()`. For an archived observation whose
  `expires_at` has passed the body must carry `{"promote_to_fact": true, "revision": n}`; otherwise 409
  `promote_required` (400 `revision_required` without `revision`). Promotion is a content revision through the
  §3 statement (`type='fact'`, `expires_at` cleared), checked against `revision`.
- `pin`/`unpin` and `verify` on a library page are 400 `wrong_space` ("Library pages are always in the digest; they are not pinned or verified."); `archive` and `restore` need `library.write` there, and `restore` with `promote_to_fact` is 400 `wrong_space`.
- `pin`/`unpin` apply to every other space. A human pin counts as verification: `pin` also sets `lifecycle='active'`,
  `stale_since=NULL`, `last_verified_at=now()` and `provenance='human'` (a pinned archived item stays archived;
  restore it first).

`POST /items/:ref/supersede`, role `E`, **memories only** (`wrong_space` 400 otherwise, library pages in either position included; decisions use `supersedes`
on the new ADR, docs are edited):
`{new?: {title, body?, type?, confidence?, anchors?, tags?}, new_id?: ref, revision?, reason?}`, exactly one of
`new` / `new_id`. `new_id` must resolve inside the path's project: a shared ref (`S:…`) is 403 `read_only_space`.
On `_shared` itself (IA/SE) both ends are shared. 200 `{new: Item, old: Item}`. Same transaction as
`spoor_supersede` ([mcp.md](mcp.md) §5).

### 5.4 Revisions

| method | path | response |
|---|---|---|
| GET | `/items/:ref/revisions` | `{items:[{revision, title, status, change, actor:Actor, created_at}], next_cursor}`, newest first, no bodies |
| GET | `/items/:ref/revisions/:n` | `{revision, title, body, status, frontmatter, change, actor:Actor, created_at}`, the full snapshot |

Diffs are computed in the browser from two snapshots (web-ui.md). There is no revert endpoint: reverting loads an
old snapshot into the editor and saves it as a new revision with `PATCH`.

### 5.5 Edges and links

| method | path | role | notes |
|---|---|---|---|
| GET | `/items/:ref/edges` | V | `{outgoing:[Edge], incoming:[Edge]}`. `Edge = {id, kind, editable:boolean, other:ItemSummary|null, dst_ref?}`. Dangling wikilinks have `other:null` and `dst_ref`. On a shared item **both** lists (including symmetric `conflicts_with`, which is queried both ways) contain only edges whose other end is in `_shared` or in a project the caller is a member of (IA: all); on a project item all edges of that project plus its links to shared items |
| POST | `/items/:ref/edges` | E | `{kind: refines|supports|depends_on|conflicts_with, to: ref|"S:handle"}` → 201 `{edge}`; idempotent (200 when it exists). `to` in `_shared` only from a project item, never the reverse (403 `read_only_space`). An edge whose source is a library page needs `library.write` (else `read_only_space`) and may point at any item except `conflicts_with` to a non-library item; a project item may point at a library page with `refines`, `supports` or `depends_on`, but `conflicts_with` to one is 400 `wrong_space`. Removing an edge whose source is a library page needs `library.write` |
| DELETE | `/edges/:id` | E | 204. Only the four typed kinds; `supersedes`, `drafted_from` and `wikilink` edges return 409 `edge_not_editable` |
| GET | `/resolve?ref=<text>&from=<space>` | V | resolves wikilink text exactly as stored edges do (`from` is the space of the page the link sits in, default `docs`; for a library source it only sets the rank, it never refuses): canonicalised ([data-model.md](data-model.md) §0: `ADR-0007` → `adr-7`, handles, slug; `shared:` prefix) and the same precedence → 200 `{item:ItemSummary}` or 404. Backs the SPA's `/projects/:slug/w/:ref` route |

## 6. Search

| method | path | role |
|---|---|---|
| GET | `/api/v1/projects/:slug/search?q=…` | V, or `any` for `_shared` |

Query: `q` (1–500 chars, required), `space=` (`memories|decisions|docs|library`), `type=`, `tag=` (repeat, max 5), `limit` (1–50, default 20),
`include_shared` (default true; ignored on `_shared`), `include_inactive` (default false). Without `space`, all four spaces are searched.
Response, not paginated:
```json
{ "items": [ { "item": ItemSummary, "score": 0.0328, "snippet": "…sliding on last_seen_at…" } ],
  "notes": ["vector search unavailable"] }
```
Semantics are exactly [search-and-digest.md](search-and-digest.md) §4: hybrid RRF, stale items included (the item's
`lifecycle` says so), archived/superseded/deprecated only with `include_inactive`. No `last_used_at` bump. The
bearer twin is the MCP `spoor_search` tool; the CLI has no search command.

## 7. Digest (REST for hooks)

### 7.1 `GET /p/:slug/api/context`

Auth: bearer, any role. Cookie twin: §4.1.

Query: `budget` (200–8000, default project setting), `query` (≤ 500), `file` (repeat, ≤ 200 paths of ≤ 256 chars;
keep the URL under 8 KB), `include_shared` (default true), `format=text|json` (default `text`).

- `text`: `200 text/plain; charset=utf-8`, the digest of [search-and-digest.md](search-and-digest.md) §7, byte for byte
  what `spoor_context` returns.
- `json`: `{ "text": "…", "budget": 1500, "est_tokens": 1432, "items": ["ADR-0012","m42"], "dropped": 18 }`.

Response header `Spoor-Memory-Mode: exclusive|shared` (the project's `memory.exclusive`, ADR-0015), in both formats; the SessionStart hook
checks the repo's `AGENTS.md` block against it ([cli-and-hooks.md](cli-and-hooks.md) §5.1). The cookie twin (§4.1) shares the response code
and sends the header too. The bearer route also sends `Spoor-Server-Version: <server version>`; the hook compares it with the
CLI's own version ([cli-and-hooks.md](cli-and-hooks.md) §5.1 step 9).

Never bumps `last_used_at`. The hook asks for `budget=1500` unless the CLI config says otherwise.

### 7.2 Other bearer endpoints for the CLI

| method | path | role | request | response |
|---|---|---|---|---|
| GET | `/p/:slug/api/whoami` | UT, ST (any) | | 200 `{project:{slug,name,next_adr_number}, token:{id,name,kind,prefix,role,expires_at}, user:{label}, server:{version}}`. `role` is the effective role; `expires_at` is ISO 8601 or null (no expiry), shown by `spoor login` and `spoor status`. Used by `spoor login` to validate a pasted token and by `adr draft` for the next ADR number |
| POST | `/p/:slug/api/push` | UT ≥ E, ST[editor] | `{space:"decisions"|"docs", source_path, content, base_revision?, force?}` | see §7.3 |
| POST | `/p/:slug/api/adr/import` | UT ≥ E, ST[editor] | `{files:[{source_path, content}], reserve_above?: int}` (≤ 100 files, whole body ≤ 1 MB; the CLI batches and sends the same `reserve_above` = highest local ADR number with every batch) | 200 `{results:[PushResult|{source_path, error, message}]}`; a bad file does not fail the batch. Matching (`spoor_id`, then `source_path`, then number), numbering, renumbering and in-batch ref resolution as in [data-model.md](data-model.md) §7 |
| GET | `/p/:slug/api/decisions/undrafted` | UT, ST (any) | `?since=<ISO>&mine=true` | 200 `{items:[{handle, spoor_id, title, body, tags, anchors, confidence, created_at}]}`. Decision memories (`type='decision'`, active) with no `drafted_from` edge from a non-superseded ADR, created at or after `since` (default and floor: now minus 14 days), oldest first, at most 200; `mine=true` (default) limits them to the token's owner (service token: items whose `item.create` audit row carries that token's id) |
| GET | `/p/:slug/api/activity` | UT, ST (any) | `?since=<ISO>` | **new** (I23). 200 `{writes: 3}`: audit rows with this token's id, `via IN ('mcp','cli')` and a content or edge write action (`item.create`, `item.update`, `item.supersede`, `edge.add`, `item.verify`, `item.push`) at or after `since` (default: now minus 6 hours), except `via='cli'` rows whose client name ends in ` (auto)`: the CLI marks the pushes it makes on its own (drafting, queue replay, mirror sweep) with the User-Agent `spoor-cli/<v> (auto)`, so they never count as the agent's own recording (review-log-phase5 A3). The Stop hook uses it for "made no Spoor writes". Bearer-only, counts only |
| POST | `/p/:slug/api/adr/push`, `/p/:slug/api/docs/push` | UT ≥ E, ST[editor] | `{source_path, content, base_revision?, force?}` | **new** (deviations.md P3-6): `POST push` with `space` = `decisions` / `docs` taken from the path; same response and errors (§7.3) |

Writes through these endpoints always carry `via='cli'` and `client_name` from the `User-Agent`
(`spoor-cli/0.1.0`, sanitised like the MCP client name). Shared targets are impossible: every lookup is scoped to
the token's project ([data-model.md](data-model.md) §0), so a `spoor_id` of a shared or other project's item is
ignored for matching (warning `foreign_spoor_id`) and never updated.

### 7.3 Push

```json
POST /p/acme/api/push
{ "space": "decisions", "source_path": "docs/adr/0007-use-postgres.md",
  "content": "---\nadr: 7\n…\n---\n# …", "base_revision": 3, "force": false }
```
Response 200:
```json
{ "status": "updated", "handle": "ADR-0007", "spoor_id": "uuid", "space": "decisions", "revision": 4,
  "number": 12, "adr_number": 7, "renumbered": null, "warnings": [] }
```
- `status`: `created | updated | unchanged` (identical content is a no-op and returns the current revision).
- `renumbered`: `{from:7, to:15}` when the number was taken by another item; the CLI renames the file and sets `adr:`.
- `warnings`: `{code:"number_mismatch", file:7, item:8}`, `{code:"unresolved_supersedes", ref:"ADR-0003"}`,
  `{code:"ambiguous_ref", ref, candidates}`, `{code:"foreign_spoor_id"}`, `{code:"status_kept_superseded"}`,
  `{code:"source_path_updated", from}`, `{code:"embedding_pending"}`.
- Matching, fast-forward rules, what a push applies, `supersedes` and `drafted_from` frontmatter: [data-model.md](data-model.md) §7.
- `409 pushed_over_spoor_edit` with `details:{current_revision, edited_by, via}`; nothing written except `push_conflict_at`
  (shown in the review queue). `force:true` writes anyway and records `change='push'` with `data.forced=true` in the audit row.
  The server cannot tell an agent from a human, so the CLI only sends `force` after an interactive TTY confirmation, and no
  agent-facing text names the command.
- `409 already_drafted` with `details:{handle, adr}`: the push would create a second ADR drafted from the same memory; nothing written.
- `409 source_path_taken`: a rename would move the item onto a path another item holds.
- `source_path` must be repo-relative: an absolute path (leading `/` or `\`), a drive letter, a leading `~`, a `..` segment or NUL is 400 `invalid_input`
  (in `adr/import` a per-file `invalid_input`); a leading `./` is dropped.
- Content is parsed server-side with the shared frontmatter schema; frontmatter errors are 400 `invalid_input` with `details.issues`.
  The body of the request is the **file as text**, so the server (not the client) decides titles, slugs and extras.

## 8. Review queue

Role: read `V` (or `any` for `_shared`); actions `E` (hard delete `PA`; shared `IA`/`SE`). Library pages are never listed in any section or count; bulk archive of an authorised library ref is allowed only for holders of `item.write` and `library.write` (a viewer with the flag is `forbidden`). Semantics:
[cleanup-and-jobs.md](cleanup-and-jobs.md) §6.

| method | path | response |
|---|---|---|
| GET | `/api/v1/projects/:slug/review` | `{counts:{stale, archived, expiring, conflicts, push_conflicts}}` |
| GET | `/api/v1/projects/:slug/review/:section` | `section` = `stale | archived | expiring | conflicts | push_conflicts`; `{items:[…], next_cursor}`. Row = `ItemSummary` plus: stale → `days_to_archive`, `used_since_stale`; archived → `archive_reason` (already on the summary), only the last 30 days; expiring → `expires_in_s`; conflicts → `{edge_id, a:ItemSummary, b:ItemSummary}` instead (on `_shared` only edges whose two ends are shared); push_conflicts → mirrored items with `push_conflict_at` set, plus `edited_by` of the Spoor edit |
| GET | `/api/v1/projects/:slug/decisions/undrafted` | `?since=<ISO>&mine=true|false` (default `false`: every member's). The cookie twin of the bearer list (§7.2) for the review queue's "Undrafted decisions" tab: 200 `{items:[{handle, spoor_id, title, body, tags, anchors, confidence, created_at}]}`, decision memories created in the last 14 days (the floor of `since`) that no non-superseded ADR was drafted from, oldest first, at most 200. Read-only for every member (`V`). Types: `UndraftedDecisionsResponse` in `@spoor/shared` (review-log-phase5 gap a) |
| POST | `/api/v1/projects/:slug/review/bulk` | `{action:"verify"|"archive", refs:[…≤100]}` → 200 `{done:[handle], skipped:[{handle, reason}]}`. One transaction and one audit row per item, in request order; a skipped ref is never an error. `reason`: `not_found`, `ambiguous_id`, `read_only_space` (a shared ref from a project), `archived` (verify: restore first), `already_archived` (archive), `wrong_space` (verify of a library page; an authorised library ref is skipped, never an error). `handle` is the ref as sent when it did not resolve. Schemas: `reviewBulkRequest`, `ReviewBulkResponse` in `@spoor/shared` |

Individual actions reuse §5: **Verify** `POST …/verify`, **Edit** `PATCH`, **Supersede** `POST …/supersede`,
**Archive now** `POST …/archive`, **Restore** `POST …/restore` (with `promote_to_fact` when required),
**Promote to fact** `PATCH {type:"fact", revision}`, **Delete** `DELETE`, **Remove relation** `DELETE /edges/:id`,
**Verify both** two `verify` calls through `bulk`. "Supersede one" on a conflict is `supersede` on the loser with
`new_id` = the winner, offered only when both ends are in the same project (a project item that conflicts with a shared
item can only be superseded by another project item, or the relation removed). A push conflict is resolved by a human
running `spoor adr push --force <file>` (or `docs push`) or by bringing the repo file in line with Spoor and pushing.

## 9. Export and import

| method | path | role | notes |
|---|---|---|---|
| GET | `/api/v1/projects/:slug/export` | PA, IA (shared: IA) | `200 application/zip` (library pages go to `library/<slug>.md`; the format stays `spoor-export/1`), `Content-Disposition: attachment; filename="spoor-<slug>-<YYYYMMDD>.zip"`. Layout and manifest: [data-model.md](data-model.md) §8. `?history=0` leaves out `revisions/` and `audit.jsonl` and sets `manifest.history=false` (smaller, history not kept; import synthesises one revision per item). Built on the request thread inside one REPEATABLE READ transaction, with caps: more than 200 MB uncompressed (the same as the import cumulative cap, so every export re-imports), or an entry over 5 MB, or more than 20,000 entries → 413 `payload_too_large` with `hint` to use `history=0`; one import or export at a time per instance (503 `busy`) |
| POST | `/api/v1/projects/import` | IA | `multipart/form-data`: `file` (zip), `slug`, `name`, `remap_ids` (`true|false`). Creates a new project from the archive |
| POST | `/api/v1/projects/:slug/import` | PA, IA (shared: IA) | multipart: `file`, `remap_ids`. The target must be empty (409 `project_not_empty`), except for manifest-less archives, which may target a non-empty project. An archive that contains library pages also needs `library.write`; the rows are normalised and refused edge kinds are dropped and listed ([data-model.md](data-model.md) §8) |

Import response 200:
```json
{ "project": { "slug": "acme" },
  "counts": { "items": 57, "revisions": 133, "edges": 41, "audit": 220 },
  "remapped": false,
  "appended_revisions": ["m12"],
  "dangling_edges": [ { "from": "m3", "dst_ref": "shared:style-guide" } ],
  "notes": ["Repo files carrying the old spoor_id no longer match."] }
```
Errors: 413 `payload_too_large` (50 MB) and `zip_limits`, 422 `invalid_archive` (bad name, bad UTF-8, bad
manifest, CRC-32 or size mismatch; `details.issues`), 409 `id_collision` (without `remap_ids`; no ids and no
count in the body, since they would tell whether chosen uuids exist in projects the importer cannot see), 503 `busy`. One
transaction: all or nothing. Hardening rules: [auth-and-security.md](auth-and-security.md) §9. Imported history is
marked, never attributed to live users ([data-model.md](data-model.md) §8 step 3). The import is audited as
`project.import` with the real importer.

## 10. Audit log and jobs

| method | path | role | notes |
|---|---|---|---|
| GET | `/api/v1/projects/:slug/audit` | V (members), IA; for `_shared`: any | filters `action=` (repeat; a value ending in `.` is a prefix, e.g. `item.`), `item=<ref>`, `actor=<label substring, case-insensitive>`, `via=`, `since=` (inclusive), `until=` (exclusive); cursor on `id desc`. Row `{id, at, actor:Actor, action, item_handle, item_id, summary, data}`; items deleted since keep their handle. `item` resolves inside this project only; a handle that no longer resolves matches the rows' handle snapshot (snapshots are relative to the row's project: plain `m1` in `_shared`, like its item pages); any other unresolved ref returns an empty list |
| GET | `/api/v1/audit` | IA | instance-level rows (`project_id IS NULL`: users, invites, projects), same filters except `item` (400) |
| GET | `/api/v1/projects/:slug/jobs` | PA, IA | `{embedding:{model, target, remaining, providers_enabled}, runs:[{name, started_at, finished_at, status, stats, error}] }` (last 20 runs for the project: `reembed`, `cleanup`) |
| GET | `/api/v1/jobs` | IA | `{scheduler:{enabled}, jobs:[{name, every_s, last_run_at, last_status, last_error, locked_until, locked_by, running_here}], recent:[job_runs, last 50]}`; `locked_until` is null while the lease is free |
| POST | `/api/v1/jobs/:name/run` | IA | **new** (deviations.md G1). Starts `cleanup`, `embed-pending`, `reembed` or `purge-ephemeral` now: takes the lease at once, skipping the due check but never running a job twice. 202 `{name, started:true}`, or 200 `{name, started:false, reason: disabled\|running\|stopped}`; unknown name 404. Audited at instance level as `job.run` |

Audit `data` never contains secrets or bodies.

## 11. `install.md` and health

### 11.1 `GET /p/:slug/install.md`

Public, no cookie, no token. `200 text/markdown; charset=utf-8`, `Cache-Control: no-cache`. Rendered from a template
with exactly these substitutions, all escaped: server URL (`SPOOR_PUBLIC_URL`), project slug, CLI version
(the server's own version), the current default digest budget, the memory mode (`memory.exclusive`, ADR-0015). No project name. It contains the placeholder `spr_…`
only as the string `<paste token>`: no secret, no per-user data. Unknown slug and `_shared`: `404 text/plain`. Outline:
[cli-and-hooks.md](cli-and-hooks.md) §9.

### 11.1a `GET /p/:slug/install.json` (**new**)

Public, secret-free, same substitutions as install.md. `200 application/json`:
`{ "version": "0.1.0", "server": "https://spoor.example.com", "project": "acme", "memory_exclusive": true,
   "mcp_json": { "mcpServers": { "spoor": { … } } }, "settings_json": { "permissions": { … }, "hooks": { … } },
   "gitignore": [".claude/settings.local.json", ".spoor/"] }`
— exactly the blocks of [cli-and-hooks.md](cli-and-hooks.md) §7.1, §7.2 and §7.4 with the literal server URL, slug and
version rendered in. `memory_exclusive` (boolean) only picks the variant of the `AGENTS.md` block, whose text `spoor init` renders itself. `spoor init` (run by `spoor login`) merges them into the repo deterministically, so no agent has
to reproduce JSON from a summarised web page.

### 11.2 `GET /healthz`

Public. One endpoint for probes:
```json
{ "status": "ok", "version": "0.1.0", "checks": { "db": "ok", "migrations": "ok", "embedding": "ok" } }
```
- `200` when the database answers, migrations are applied and the default embedding provider has loaded
  (`provider.ready()`). Otherwise `503` with `status:"starting"` (or `"unhealthy"` when `db` fails after startup)
  and the failing check as `"loading" | "failed"`. The body never carries error text.
- After the first success only the database is re-checked (`SELECT 1`, result cached 5 s). Concurrent probes
  share one ping, which counts as failed after 2 s, so a blackholed database or an exhausted pool reports
  `unhealthy` instead of hanging every probe (the pool's connect timeout is 5 s).
- A remote provider that is down does not make the instance unhealthy; search degrades to full text
  ([search-and-digest.md](search-and-digest.md) §4).
- While `starting`, every other route except `/healthz` answers 503 `starting` (JSON on API routes) with `Retry-After: 5`.

## 12. Route inventory (for the router test)

Every route below is built (the 501 stubs of deviations.md G16 are gone). Any path or method not listed here is a
JSON 404 `not_found`.

```
GET  /healthz                                     GET  /p/:slug/{install.md,install.json}
POST /p/:slug/device/code                         POST /p/:slug/device/token
GET  /p/:slug/api/{whoami,context,decisions/undrafted,activity}
POST /p/:slug/api/{push,adr/import,adr/push,docs/push}  ALL  /p/:slug/mcp
POST /api/v1/auth/{login,logout}                  GET|PATCH /api/v1/me      POST /api/v1/me/password
GET  /api/v1/instance                             GET  /api/v1/{jobs,audit}  POST /api/v1/jobs/:name/run
POST /api/v1/invites/{preview,accept}             GET|POST /api/v1/invites  DELETE /api/v1/invites/:id
GET  /api/v1/users  GET|PATCH|DELETE /api/v1/users/:id
GET  /api/v1/device/lookup                        POST /api/v1/device/{approve,deny}
GET|POST /api/v1/projects                         POST /api/v1/projects/import
GET|PATCH|DELETE /api/v1/projects/:slug           GET  …/:slug/{dashboard,context,audit,jobs,export,resolve,search}
POST …/:slug/import                               GET|POST …/:slug/members  PUT|DELETE …/members/:userId
GET|POST …/:slug/tokens  DELETE …/tokens/:id
GET|POST …/:slug/spaces/:space/items              GET|PATCH|DELETE …/:slug/items/:ref
POST …/items/:ref/{pin,unpin,verify,archive,restore,supersede}
GET  …/items/:ref/{revisions,revisions/:n,edges}  POST …/items/:ref/edges   DELETE …/:slug/edges/:id
GET  …/:slug/review  GET …/review/:section        POST …/review/bulk   GET …/:slug/decisions/undrafted
```
