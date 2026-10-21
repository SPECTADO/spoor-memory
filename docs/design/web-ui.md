# Web UI

Status: implemented (phase 4), 2026-10-19. Minimal on purpose: a browse, read, edit, review and administer tool for people. English only, no graph view
(BRIEF). Every call it makes is in [api.md](api.md); permissions are enforced by the server, the UI only hides what a user cannot do.
Stack ([docs/research/web-stack.md](../research/web-stack.md)): React 19.3.1, Vite 8.3.4, Tailwind 4.3.3, TanStack Query 5.104.3,
react-router 7.18.4 (data router, single `react-router` package), `@uiw/react-codemirror` 4.25.12 + `@codemirror/lang-markdown`,
`react-markdown` 10.1.0 + `remark-gfm` 4.0.1, `diff` 9.0.0, `lucide-react` 1.58.0. No component library, no new package.

## 1. Layout of `packages/web`

```
src/
  main.tsx  router.tsx  queryClient.ts  index.css (design tokens)
  api/        client.ts (fetch wrapper + ApiError) · types.ts · endpoints.ts (one function per endpoint) · keys.ts (query keys) · hooks.ts (one hook per endpoint)
  ui/         primitives of §4, MarkdownView, MarkdownEditor (CodeMirror, lazy-loaded), DiffView
  components/ shell and guards of §4 (AppShell, Nav, AccountMenu, ProjectSwitcher, AuthGuard, RequireRole, ProjectScope, RouteError) and the composite components
  pages/      one module per route of §2, one chunk per page: single-module pages are `lazy:` routes in router.tsx; the page groups
              item/, review/, settings/, admin/ wrap theirs in React.lazy + Suspense in their own index.tsx (re-exported by pages/index.tsx)
  lib/        paths.ts, roles.ts, wikilinks.ts (remark plugin), diff.ts, format.ts, listFilters.ts, useSearchParamsState.ts
```
Conventions (API layer, UI primitives, tests) are written down in [packages/web/README.md](../../packages/web/README.md).
Types and zod schemas come from `packages/shared` (`ItemSummary`, `Item`, frontmatter, the wikilink regex, `slugify`, the anchor normaliser).
Production: `vite build` → `packages/web/dist`, served by the server (`/assets/*` immutable, everything else falls back to `index.html`,
unknown `/api/*` stays JSON 404). The CSP forbids inline scripts and external resources: no CDN fonts, no analytics, no remote images in rendered
Markdown (`img-src 'self' data:`; a blocked image shows its alt text as a link).

## 2. Routes

SPA routes live under `/projects/...`, `/shared/...`, `/admin/...`, `/login`, `/invite`, `/device`, `/account`; `/p/*` and `/api/*` belong to the server.
`/shared/*` is the same route tree as `/projects/:slug/*` with the slug fixed to `_shared` (one `projectRoutes` array mounted twice; `useProjectSlug()` returns
`params.slug ?? '_shared'`; a `projectPath(slug, …)` helper emits the right prefix).

| route | page | who | data |
|---|---|---|---|
| `/login?next=` | Login form | public | `POST auth/login` |
| `/invite` (token in `#fragment`) | Accept invite | public | `POST invites/preview`, `POST invites/accept` |
| `/device` | Approve a CLI login: the user **types** the code from their terminal (a `?code=` parameter is ignored); shows project, requester IP, age, role and the client name labelled "reported by the requester (unverified)"; buttons **Approve read-only** (default focus), **Approve**, **Deny** ([auth-and-security.md](auth-and-security.md) §6) | logged in, member of the code's project | `GET device/lookup`, `POST device/approve|deny` |
| `/` | redirect to `/projects` | logged in | |
| `/projects` | Project list: cards with counts, review badge, your role; "Shared knowledge" card; "New project" (IA) | logged in | `GET projects` |
| `/projects/:slug` | Dashboard: counts per space (active, stale, archived; a fourth Library card shows active and archived, "never stale"), review counts for all five sections with links, the last 15 changes, "Agent activity" (last agent read and write; project admins also get a link to the request log), a "Connect" box for every member (CLI install and `spoor login` commands with this server's URL and version, install guide, token creation; a new teammate: Members for project admins, "ask a project admin" otherwise; a new project: Projects for IA), "Preview digest"; agent activity and Connect are not shown on `_shared` | member | `GET projects/:slug`, `…/dashboard`, `instance` |
| `/projects/:slug/memories`, `/decisions`, `/docs`, `/library` | Space list with filters, "New" (library: only with the library right) | member | `GET …/spaces/:space/items` (infinite) |
| `/projects/:slug/:space/new` | Editor, create mode | editor (`library`: the library right) | `POST …/spaces/:space/items` |
| `/projects/:slug/i/:ref` | Item view (rendered Markdown, meta, links, actions) | member | `GET …/items/:ref`, `…/edges` |
| `/projects/:slug/i/:ref/edit` | Editor, edit mode | editor (library page: the library right) | `PATCH …/items/:ref` |
| `/projects/:slug/i/:ref/history?rev=&base=` | Revisions and diff | member | `GET …/revisions`, `…/revisions/:n` |
| `/projects/:slug/w/:ref` | Wikilink resolver: resolves, then `replace` navigates to the item (a shared item under `/shared/i/…`) or shows "No item called …" with a "Create doc" button (editors; not for a `shared:` ref) that opens `…/docs/new?title=<ref>`; for `from=library` the button is "Create library page" (`library` gate) and opens `…/library/new?title=<ref>`, because only a library page can claim a library page's dangling link | member | `GET …/resolve?ref=&from=` (`from` is the space of the page holding the link; a library page only sets the rank, so a link to a doc or memory resolves normally) |
| `/projects/:slug/search?q=` | Search | member | `GET …/search` |
| `/projects/:slug/review?section=` | Review queue | member (actions: editor) | `GET …/review`, `…/review/:section`, `…/decisions/undrafted` |
| `/projects/:slug/audit` | Audit log | member | `GET …/audit` (infinite) |
| `/projects/:slug/requests` | Request log (ADR-0018): agent reads and writes of the last 14 days, filters kind, via, actor/token/agent, date range; rows: time, actor (token name and prefix, agent), kind/via/outcome badges, operation and duration, space · type and handle links, query and an expandable `data` | PA (not on `_shared`) | `GET …/requests` (infinite) |
| `/projects/:slug/tokens` | Tokens (own; all for project admin) | member | `GET/POST/DELETE …/tokens` |
| `/projects/:slug/members` | Members, roles and the library editor flag | project admin | `GET/POST/PUT/DELETE …/members` |
| `/projects/:slug/settings` | Settings, export/import, delete | project admin | `PATCH projects/:slug`, `GET …/jobs`, `GET …/export`, `POST …/import` |
| `/account` | Name, password, my API tokens across projects (list, revoke) | logged in | `PATCH me`, `POST me/password`, `GET …/tokens` of every visible project (own user tokens kept), `DELETE …/tokens/:id` |
| `/admin/users` | Users | IA | `GET/PATCH/DELETE users` |
| `/admin/invites` | Invites and reset invites | IA (PA sees own via project members page) | `GET/POST/DELETE invites` |
| `/admin/projects` | Every project with counts and review total, "New project" | IA | `GET/POST projects` |
| `/admin/jobs` | Jobs and recent runs, "Run now" | IA | `GET jobs`, `POST jobs/:name/run` |
| `/admin/audit` | Instance audit (users, invites, projects, jobs) | IA | `GET audit` |
| `*` | Not found | any | |

Shared space: `/shared`, `/shared/memories`, … `/shared/settings` (embedding, export/import for IA); no members, tokens or review actions for non-writers.
Deep links to an item are `…/i/<handle>` (stable) so URLs can be pasted in chat and ADRs.

### 2.1 Auth guard

- The guard route's loader runs `queryClient.ensureQueryData(['me'])` (`GET /api/v1/me`). A 401 `unauthenticated` redirects to
  `/login?next=<current path and query>`. `next` is accepted only if it starts with a single `/`; anything else goes to `/projects`.
- `/login`, `/invite` are outside the guard; `/device` is inside it (outside the shell), so an unauthenticated visitor logs in and returns to `/device`.
- A global `QueryCache`/`MutationCache` `onError` treats any later 401 `unauthenticated` the same way: redirect to `/login?next=`, then clear the cache (the `['me']` query is left to the guard).
- Role gates are `<RequireRole role="editor|admin|ia">` wrappers that read `me` and the project's effective `role` (from `GET projects/:slug`). Failing the gate renders the
  "You do not have access to this page" state, never a blank page. Buttons the user cannot use are not rendered. The server is the real check (403).
- A project the user cannot see returns 404 from the API and renders Not found (slugs do not leak).
- On the shared space the gate for write controls is `me.user.is_admin || me.user.shared_editor`.
- Every library control is gated by `useCan('library')`, which reads `ProjectJson.can_edit_library` from `GET projects/:slug` (true for IA, project admins and members with the flag; on `/shared` for IA and shared editors). It is never derived from the role or from `useCan('editor')`, because a viewer with the flag can edit the library and an editor without it cannot.

## 3. Data fetching

- `api/client.ts`: `fetch` with `credentials: 'same-origin'`; JSON requests set `Content-Type: application/json` when there is a body; downloads use a plain link; the multipart import
  uses `FormData` (no content type set by hand). Non-2xx responses throw `ApiError {status, error, message, hint, details, requestId}` from the flat error shape of [api.md](api.md) §0.4.
- TanStack Query defaults: `staleTime` 30 s, `gcTime` 5 min, `refetchOnWindowFocus` on, `retry` 0 for 4xx and 1 for network errors/5xx (503 `starting`: every 5 s for up to 2 minutes). A network failure is an `ApiError` with status 0 and code `network`. Lists use `useInfiniteQuery` with `next_cursor` ("Load more" button, no infinite scroll).
- Query keys: `['me']`, `['instance']`, `['projects']`, `['project', slug]`, `['dashboard', slug]`, `['items', slug, space, filters]`, `['item', slug, ref]`, `['edges', slug, ref]`,
  `['revisions', slug, ref]`, `['revision', slug, ref, n]`, `['search', slug, params]`, `['review', slug]`, `['review', slug, section]`, `['audit', slug, filters]`, `['members', slug]`,
  `['tokens', slug]`, `['jobs', slug]`, `['users', filters]`, `['invites', filters]`, `['admin-jobs']`; also `['review', slug, 'counts']` (so `['review', slug]` refreshes counts and sections),
  `['context', slug, params]`, `['resolve', slug, ref]`, `['instance-audit', filters]`, `['invite-preview', token]`, `['device-lookup', code]`. All keys come from `api/keys.ts`.
- Invalidation works on prefixes: a content write invalidates `['item', slug]` and `['revisions', slug]` for the whole project rather than one `ref`, because a page may have loaded
  the item by handle, uuid or slug. Revision snapshots (`['revision', slug, ref, n]`) are immutable and never invalidated.
- Invalidation after a mutation (the whole policy):

| mutation | invalidates |
|---|---|
| create / edit item | `['items', slug]`, `['item', slug, ref]`, `['revisions', slug, ref]`, `['edges', slug]`, `['dashboard', slug]`, `['review', slug]`, `['search', slug]` |
| pin, unpin, verify, archive, restore, supersede, delete | the same set, plus `['projects']` (counts); delete removes `['item', slug, ref]` from the cache |
| edge add / remove | `['edges', slug]` |
| review actions | `['review', slug]`, `['dashboard', slug]`, `['items', slug]`, `['projects']` (row removed optimistically, rolled back on error) |
| login, invite accept, logout | the whole cache is cleared |
| members, tokens, settings | their own key, `['project', slug]` |
| settings: provider change | `['project', slug]` and starts polling `['jobs', slug]` every 5 s until `embedding.target` is null |

- Optimistic updates (rolled back on error): pin/unpin, review-row removal, token revoke, invite revoke, member role change and removal, `PATCH me`.
- The device lookup never refetches by itself (no retry, no refetch on focus or reconnect): every server-side miss counts toward the 10-minute lock, and malformed codes are rejected in the browser.
- Search input: 250 ms debounce, the query lives in the URL (`?q=`, with `space=` and `inactive=1` for the space filter and "Include inactive"; hits show space, type, stale/archived badges and the snippet as plain text; a shared hit (`S:` handle) links to `/shared/i/<handle>`), previous results stay visible while the next load (`placeholderData: keepPreviousData`).
- The digest preview (dashboard button "Preview digest", every member; `pages/DigestPreview.tsx`) opens a dialog that loads the default digest at once and reloads it with an optional query and file list (one path per line) typed in a small form; it renders the text in a `<pre>` with the token estimate, item count and how many items the budget left out. Read-only.
- Writes the UI makes are always sent with the `revision` the user last saw; there is no "force" in the UI except the conflict dialog (§5.3).

## 4. Components

Local components only, Tailwind classes on the design tokens of `src/index.css`, native `<dialog>`, `<select>`; icons from `lucide-react`. Primitives live in `src/ui`, the rest in `src/components`.
The account menu is a disclosure (button + list, Esc and outside click close it); the project switcher is a native `<select>`; under the `md` breakpoint the sidebar is a toggled panel.

| group | components |
|---|---|
| shell | `AppShell` (top bar: logo, project switcher, search box for the current project, user menu), `ProjectNav` (Dashboard, Memories, Decisions, Docs, Library (lucide `Library`), Search, Review with count badge, Audit log, Tokens, and for project admins Members, Settings; no Tokens or Members on the shared space, Settings there only for IA), `AdminNav` (IA: Projects → `/admin/projects`, Users, Invites, Jobs, Instance audit), `PageHeader` |
| primitives | `Button`, `IconButton`, `Input`, `Textarea`, `Select`, `Checkbox`, `Badge`, `Tabs`, `Table`, `Dialog`, `ConfirmDialog` (type the handle or slug to confirm), `Toast`, `CopyField` (read-only input + copy button), `Spinner`, `Skeleton` |
| states | `EmptyState`, `ErrorState` (shows `message`, `hint`, request id), `NotFound`, `Forbidden`, `StartingBanner`, `OfflineBanner` |
| content | `MarkdownView`, `ItemHeader` (handle, space, status/lifecycle/type badges, revision, updated by), `ItemMeta` (tags, anchors, dates, source path, client), `LinksPanel`, `ItemActions`, `ItemTable`, `ItemRow`, `FilterBar`, `SnippetList` |
| editing | `ItemEditor` (fields + `MarkdownEditor`), `MarkdownEditor` (CodeMirror), `TagInput`, `AnchorsInput`, `ConflictDialog` |
| history | `RevisionList`, `DiffView`, `FrontmatterDiff` |
| review | `ReviewTabs`, `ReviewRow`, `ConflictRow`, `BulkBar`, `SupersedeDialog`, `PromoteRestoreDialog` |
| admin | `UsersTable`, `InviteDialog`, `InviteResultDialog` (link, shown once), `MembersTable`, `TokenTable`, `TokenCreateDialog`, `SecretOnceDialog`, `SettingsForm`, `EmbeddingPanel`, `ExportImportPanel`, `JobsTable`, `AuditTable` |
| auth | `LoginForm`, `InviteForm`, `DeviceApprove` |

### 4.1 Markdown rendering

`MarkdownView` = `react-markdown` + `remark-gfm` + a ~20-line remark plugin that turns `[[ref]]`, `[[ref|label]]`, `[[ref#heading]]` into links (text nodes only, so code is untouched).
The regex is the shared wikilink grammar ([data-model.md](data-model.md) §3). Targets become `/projects/<slug>/w/<ref>` (a `shared:` prefix is kept in `<ref>`). Raw HTML is not enabled (no `rehype-raw`), the default
`urlTransform` drops `javascript:` URLs, `a` renders react-router `Link` for in-app paths and `<a rel="noreferrer noopener" target="_blank">` for external ones.

### 4.2 Item view (`/projects/:slug/i/:ref`)

- Header: handle (`m42`, `ADR-0007`, `S:d3` in shared), title, badges: space, type, `confidence`, status, lifecycle (`stale`, `archived (expired)`), `pinned`, `mirrors <source_path>`,
  `agent-written` (when `provenance='agent'`: no human has edited, verified or pinned it since an agent wrote it; Verify clears it), `push refused` (when `push_conflict_at` is set).
- Banners: stale ("Unverified for N days; stale since …"; **Verify**), archived (reason; **Restore**), superseded ("Superseded by m60", link), expiring observation ("Expires in 2 days"),
  mirrored item ("Edits here stay in Spoor; the next push from the repo is refused until a human forces it"), push refused (when `push_conflict_at` is set: the
  `spoor adr|docs push --force <file>` command and a link to the history instead of the mirrored banner), and after a create the near-duplicate warning (§5.2).
  The superseded banner (and the side panel) follow the `superseded_by` chain up to five hops ("Superseded by m60 Valkey → m72 Postgres").
- A **library page** shows a "Library · human-maintained" badge instead of the status and lifecycle badges, and has no Pin, Verify, Supersede, promote, expiry or last-verified information. Edit, Archive and Restore need `library`; Delete needs `admin`. Without the right a notice reads "You can read this page. Editing needs the library right; ask a project admin." In its `LinksPanel`, "Add link" needs `library` and the picker offers all spaces; `conflicts_with` is not offered whenever either side is a library page. Backlinks are read-only, each labelled with its source handle (`~` for agent-written sources). A wikilink click resolves with `from=library`.
- Body: `MarkdownView`. Side panel: tags (click → list filtered by tag), anchors (monospace), dates (created, updated, verified, last used), created/updated by and client,
  revision number with link to history; also type, status, confidence, ADR number and date, lifecycle, provenance (`~` for agent-written), expiry, the mirrored
  `source_path`, the slug and the extra frontmatter keys (collapsed).
- `LinksPanel`: outgoing and incoming edges grouped by kind (`refines`, `supports`, `depends_on`, `conflicts_with`, `supersedes`, `drafted_from`, wikilinks), each as handle + title link; dangling wikilinks muted with
  "create" when the user can write; "Add relation" (editor) opens a dialog with kind and a target picker (list filter `q_title`, plus a `S:` toggle for shared); typed edges have a remove button. On a shared item
  the server already filters both directions to the viewer's projects ([api.md](api.md) §5.5).
- `ItemActions` (by role, none for viewers): Edit, **Accept** (a `proposed` decision: `PATCH {revision, status:"accepted"}` with the loaded revision; a conflict reloads the
  item and asks to accept again), Pin/Unpin (pinning also verifies: a stale item becomes active), Verify, Archive (one confirmation; reversible)/Restore (an expired
  observation opens "Promote it to a fact and restore?"), **Supersede** (memories only; the picker offers only memories of the same project, or a new memory written
  inline, which copies the old one's tags and anchors), History, Delete (project admin, `ConfirmDialog` asks for the handle; shared: IA or `shared_editor`).
- Code: `src/pages/item/` (item view, editor, history; each page its own lazy chunk through `pages/item/index.tsx`).
- Reading never bumps `last_used_at`.

### 4.3 Space list

`FilterBar`: type (memories only), status, lifecycle (default "Active and stale"; options Active, Stale, Archived, All), tags (chips; AND), pinned only, sort. Filters live in the URL query (`type`, `status`, `lifecycle`, repeated `tag` (max 5), `pinned=1`, `anchor`, `sort`, `dir`; defaults are omitted; `lib/listFilters.ts` parses and validates them, so an invalid value is dropped instead of sent). A query change is a router navigation that commits a moment later (the auth loader revalidates), so pages that write the query (space list, search, history) use `lib/useSearchParamsState.ts`: each change is an update applied to the newest written query, not the rendered one, and two quick changes (a tag, then "Pinned only") both land; writes replace the history entry.
Also: anchor path filter (same matcher as the digest), status only where the space has a vocabulary (not docs). Rows carry quick actions for editors: Pin/Unpin, Verify, Archive (no confirmation, all reversible; Restore stays on the item page because an expired observation needs a choice); a tag in a row adds it as a filter. `ItemTable` columns: handle, title,
type/status badges, tags, updated, last verified; stale rows tinted. Memories show an "expires" column for observations. "New" button for editors. Empty state per space with one sentence on how items get here
("Agents add memories with spoor_remember. You can add one yourself.", "Decisions come from spoor_decide, ADR files in the repo, or here.", "Docs are pushed from the repo or written here."). The **Library** list (title "Library", subtitle "Guides and conventions that agents read and follow. Only people with the library right can change them.") has the docs columns, offers Active and Archived only in the lifecycle filter, shows "New page" and the Archive/Restore quick actions only with the library right, and on a project ends with a footer "Org-wide library pages live in Shared → Library and appear to agents as S:L…". Its empty state reads "No library pages yet. Write the guides agents must follow, such as a graphics guide, architecture guide or conventions. Agents see every page in their digest and can read it, never change it." with a New page button, or without the right "No library pages yet. A project admin or a library editor can add pages here."

## 5. The editor

Route `…/i/:ref/edit` and `…/:space/new`. One component for both. For `library` it is the docs form (title, slug, body, tags, anchors, the `near_duplicate` warning) gated on `library`; without the right the page renders Forbidden.

### 5.1 Layout

- Fields (a form above the body): title (required, 1–200, one line); memories: type (select) and confidence; decisions: status, date (`decided_on`), ADR number shown read-only after create; all: tags (`TagInput`,
  validated against the tag pattern as you type), anchors (`AnchorsInput`: one per line, normalised and validated with the shared anchor normaliser),
  slug (create only, defaults to the title's slug, immutable afterwards and shown read-only). Extra frontmatter keys are kept unchanged and listed read-only in a collapsed "Extra metadata" block.
  `pinned`, verification and lifecycle are not editor fields; they are item actions.
- Body: `MarkdownEditor` (lazy-loaded chunk; Tab is not captured, so keyboard users can leave the editor) = `@uiw/react-codemirror` with `markdown({ base: markdownLanguage, codeLanguages: languages })`, line wrapping, an `aria-label="Editor"` through `EditorView.contentAttributes`
  (the Playwright smoke test types into `.cm-content`). `codemirror`, `@codemirror/state` and `@codemirror/view` are direct dependencies (one copy each).
- Live preview: a split pane (editor left, `MarkdownView` right, debounced 200 ms); under 1024 px one pane at a time, switched by a Write / Preview toggle-button pair (`aria-pressed`). The preview resolves wikilinks to links but does not fetch.
- Create mode takes `?title=` as the initial title (a dangling wikilink's "create" opens `…/docs/new?title=<ref>`, or `…/library/new?title=<ref>` on a library page). Memories and docs have a "Skip the duplicate
  check" checkbox (`allow_duplicate: true`, off by default); decisions have an optional ADR number (the next free one otherwise).
- Footer: **Save** (disabled until valid and changed), **Cancel**, a character count against the 200,000 limit, and the revision being edited ("editing r3").

### 5.2 Saving

- Create: `POST …/spaces/:space/items`; on success navigate to the item. `warnings` are shown as a banner on the new item: "A similar item exists: m42 (cos 0.95)" with links. Never blocking.
- Edit: `PATCH …/items/:ref` with `revision` = the revision loaded into the form. Only changed fields are sent. Success → item view and a toast "Saved as r4".
- Leaving with unsaved changes is guarded (`useBlocker` plus `beforeunload`); the in-app dialog offers **Stay** (default focus), **Discard changes** and **Keep draft and leave**.
  An unsent draft is kept in `localStorage` under `spoor:draft:<slug>:<id|new:space>` as a per-viewer convenience
  (every access in try/catch; the page works without it) and offered on the next visit ("Restore unsaved draft from 14:02?"). It is removed on save or discard.
  A restored draft keeps the revision it was based on, so saving it over a newer revision goes through the conflict dialog.
- Validation errors from the server (`invalid_input.details.issues`) are mapped to the field by `path`.

### 5.3 Conflict (never last-write-wins)

`409 revision_conflict` carries `details.current` (the full current item). `ConflictDialog` says who changed it and when ("m42 is now r7, saved by ann@example.com via claude-code/2.1.303"), and offers:
1. **Compare**: a diff of their current body against your edit (`DiffView`).
2. **Keep editing**: close the dialog; the form keeps your text and stays based on the old revision, so the next save conflicts again unless option 3 is used.
3. **Save my version over r7**: re-sends `PATCH` with `revision: 7` and the same changed fields (those the user changed against the revision the form was loaded from), so
   fields the user did not touch keep their r7 values: a field-level merge. It is an explicit human choice, and it is still optimistic: if r8 appeared meanwhile the conflict dialog appears again.
4. **Discard mine**: reload from the server.

Mirrored items add a line to the first save confirmation: "Saved in Spoor only. The repo file is unchanged."

## 6. History and diff (`…/i/:ref/history`)

- Left: `RevisionList` (newest first, load more): revision, change kind (`create`, `update`, `status`, `supersede`, `import`, `push`), actor label, via and client name, time. Selecting one sets `?rev=`; `?base=` defaults to the
  previous revision; a select ("Compare with") lets the user pick any older base, or `nothing` (`?base=none`: the selected revision shown whole).
- Right: `DiffView` for the two snapshots (`GET …/revisions/:n`, cached per `n`): title and status as inline old → new, `FrontmatterDiff` as a key-level list (added, removed, changed; tags and anchors as sets), body with
  `diffLines` from `diff` rendered as `<pre>` blocks per part (green added, red removed, unchanged collapsed to context of 3 lines, "show N unchanged lines" expander). A toggle switches to word-level inside changed lines.
  The first revision has no base and is shown whole.
- **Restore this version** (editors; not offered on the current revision): navigates to the editor with that snapshot's title, body, tags, anchors loaded as the form values (passed as router
  navigation state) and the *current* revision as the base; saving creates a new revision. There is no server-side revert.
- Shared and project histories look the same; viewers can read them.

## 7. Review queue (`…/review?section=stale|archived|expiring|conflicts|push_conflicts|undrafted`)

Layout and actions follow [cleanup-and-jobs.md](cleanup-and-jobs.md) §6; endpoints in [api.md](api.md) §8. `ReviewTabs` show counts from `GET …/review` (refetched on window focus). Default section is the first
non-empty one, else Stale. Sections: `stale | archived | expiring | conflicts | push_conflicts`.

- **Stale** rows: checkbox, handle, type, title, stale since, last verified, last used (badge "used since stale"), days to auto-archive. Row actions: **Verify**, **Edit** (opens the editor; saving makes it active), **Supersede**
  (`SupersedeDialog`: pick an existing memory, or write a new one inline), **Archive now**, **Delete** (project admin or IA, type the handle).
- **Recently archived** (30 days): handle, title, reason badge (`stale`, `expired`, `manual`), archived at. **Restore**; for reason `expired` the button opens `PromoteRestoreDialog` ("Its expiry has passed. Promote it to a fact and restore?")
  which sends `restore` with `promote_to_fact: true`. **Delete**.
- **Observations expiring** (48 h): handle, title, expires in. **Promote to fact** (PATCH `type: "fact"` with the loaded revision), **Archive now**, or nothing.
- **Conflicts**: each row shows both items side by side (title, type, confidence, last verified) with **Keep A** / **Keep B** (supersede the other with `new_id`; shown only when both are in this project), **Remove relation**, **Verify both**.
  On `/shared/review` only conflicts between two shared items appear.
- **Push conflicts**: handle, title, source path, who edited it in Spoor (via), refused at. No action button: the row shows the
  terminal command a human runs (`spoor adr push --force <file>`) and a "Compare" link to the item's history.
- Bulk: checkboxes with a sticky `BulkBar` (**Verify**, **Archive now**) calling `review/bulk`; the result toast lists skipped items with reasons.
- Removing a row is optimistic with rollback; a failing action leaves the row and shows the error toast. The success and error toasts hang on the mutation itself
  (`useReviewAction(…, notify)`), not on the `mutate()` call, because removing the last row unmounts the section before the reply arrives. Viewers see the queue without action controls. Nothing here deletes automatically.
- Empty state: "Nothing needs review." with the current stale/archive day settings in small text.
- **Undrafted decisions** (a sixth tab after the five sections of api.md §8, `?section=undrafted`, from `GET …/decisions/undrafted`, the cookie twin of the Stop hook's bearer list): decision memories of the last 14 days that no ADR was drafted from yet, oldest first, with handle, title, recorded, tags. Read-only: the ADR is drafted on a developer's machine (`spoor adr draft`, or the next Stop of a Claude Code session) and arrives as a `proposed` file. The tab's badge is the list length (at most 200).
- Supersede in the review queue takes a memory handle of the project (typed) or a new memory written inline; there is no picker.

## 8. Admin and settings pages

- **Users** (`/admin/users`, IA): search box, table (name, email, flags, projects with roles, disabled). Row menu: toggle instance admin, toggle shared editor, disable/enable, delete (type the email), "Create reset
  invite" (opens `InviteDialog` in reset mode: `reset_user_id` of that user, no grants or flags, checkbox "Also revoke this user's API tokens", checked by default). `last_admin` errors are shown inline.
- **Invites** (`/admin/invites`, IA): filter by status; **New invite** dialog: optional email, grants (rows of project select + role), instance admin and shared editor toggles (IA only), expiry hours (1–720, default 168).
  `InviteResultDialog` shows the link `<origin>/invite#spi_…` in a `CopyField` with "Shown once; copy it now. There is no email." Revoke on open invites. Project admins create invites for their own projects from the
  Members page with the same dialog restricted to their projects, without instance flags, and with at least one grant required. Accepting an invite with the
  email of an existing account shows "An account with this email already exists; ask an admin to add you to the project" (409 `already_exists`).
- **Members** (`/projects/:slug/members`, project admin): table with role `<select>`, a "Library editor" checkbox column (admin rows are checked and disabled, tooltip "Admins can always edit the library"; toggling sends `PUT {library_editor}` with an optimistic update and a rollback toast), remove button, "Add member by email" (with a Library editor checkbox, hidden when the role is admin; shows the `user_not_found` hint with a button "Create an invite instead"), "Invite someone" button.
  The last-admin rule surfaces as an inline message. Changing a role away from admin shows a notice that the demoted admin loses library editing unless the box is ticked, and the panel refetches after any role change.
- **Tokens** (`/projects/:slug/tokens`): table (name, kind, origin badge `device login` / `web`, role cap, prefix, created, last used, expires, revoked). **New token** dialog: name, kind (user token for yourself; service token for project admins), role
  (service: editor or viewer, **viewer preselected**; user: "same as my role" or "read-only"), optional expiry. `SecretOnceDialog` shows the secret in a `CopyField` with the text "This is the only time you can see it", and a checkbox
  "I have copied it" before the dialog can close. **Revoke** with confirmation. Short help text with the `spoor login` command for the project and the install doc link `/p/<slug>/install.md`.
- **Settings** (`/projects/:slug/settings`, project admin): tabs `?tab=general|members|tokens|data|audit|danger` (Members, Tokens and Danger zone are not offered on the shared space; Danger zone only to IA). The tabs reuse the panels of the standalone `/members`, `/tokens` and `/audit` routes. General holds the forms below, each with its own Save that sends only the changed keys: General (name, description; slug read-only), Cleanup (`stale_days`, `archive_days`, `observation_days`, with the
  allowed ranges and the note "applies at the next hourly run"), Digest (default budget, decision window), Duplicates (threshold 0.80–0.99), Memory (one checkbox "Spoor is the agents' only memory", `settings.memory.exclusive`; repos pick up a change at the next `spoor init`), **Embedding** (`EmbeddingPanel`: provider select from `GET instance`; picking a remote
  provider shows "Item text will be sent to <vendor>. Keys stay in the server environment."; after saving, a progress bar from `embedding.remaining` until `embedding.target` is null; search keeps using the old model until
  the switch), **Export/Import** (`ExportImportPanel`: Export button = link to `…/export` with a "without history" checkbox; Import: file input, "Re-create ids" checkbox, always offered: a full Spoor export restores only into an empty project (the server answers 409 `project_not_empty` and the panel says so), a manifest-less Markdown-folder zip may also go into a project with items (api.md §9); result
  summary with dangling edges and notes), **Danger zone** (IA: delete project, type the slug). The shared space shows the same page without Members and Tokens, and only IA sees Import and Delete is absent.
- **Jobs** (`/admin/jobs`): job table (name, cadence, last run, status, last error) and the last 50 runs. **Run now** on `cleanup`, `embed-pending`, `reembed` and `purge-ephemeral` (`POST jobs/:name/run`; a refusal reason is shown in a toast).
- **Projects** (`/admin/projects`, IA, "Projects" in the admin nav): every project with its counts and review total, "New project".
- **Audit** (`/projects/:slug/audit`, `/admin/audit`): `AuditTable` with filters (action prefix, actor, via, date range), infinite "Load more", rows: time, actor (with `via` and client name), action, item handle link (if the item
  still exists, else plain text), summary. `data` is shown in an expandable row as JSON. The action prefixes are `item. edge. member. token. project. device.` per project and
  `user. invite. project. job.` on the instance log (`AuditPanel` / `InstanceAuditPanel` in `pages/settings/AuditPanel.tsx`).

## 9. Error, loading and empty states (global rules)

| situation | UI |
|---|---|
| first load of a query | `Skeleton` rows or blocks of the final shape, no spinners over content |
| background refetch | no indicator beyond a thin top progress bar |
| empty list | `EmptyState`: one sentence, one primary action if the role allows it |
| 400 `invalid_input` on a form | inline field messages from `details.issues`, a summary above the form |
| 401 | redirect to login with `next` |
| 403 | inline "You do not have permission to do that" toast for actions; `Forbidden` page for gated routes |
| 404 | `NotFound` with a link to the project or project list |
| 409 `revision_conflict` | `ConflictDialog` (§5.3); other 409s show the server `message` and `hint` in a toast |
| 413, 422 on import | message plus the issues list from `details` |
| 503 `starting` or network failure | `StartingBanner` or `OfflineBanner` at the top; queries retry (every 5 s while starting); forms keep their content |
| unexpected 5xx | `ErrorState` with the `request_id` to quote to the admin |
| render error | route `errorElement` with a reload button and the error id; the router never shows a white page |

Accessibility baseline: every control has a label, dialogs are native `<dialog>` with focus return, colour is never the only signal (badges carry text), tables are real tables, the editor has an accessible name.
Dark mode follows `prefers-color-scheme`: components use semantic token utilities (`bg-bg`, `text-fg`, `text-muted`, `border-border`, `bg-accent`, …) whose CSS variables are redefined under
`@media (prefers-color-scheme: dark)` in `src/index.css`, so no `dark:` variants are needed; there is no theme switch in the MVP.

## 10. Browser tests (Playwright)

`pnpm e2e` at the repo root builds shared, server and web, then runs `packages/web/e2e` (Playwright, Chromium). `playwright.config.ts` starts the **built**
server (`e2e/support/server.mjs`: `packages/server/dist` wired like `src/index.ts`, with the deterministic fake embedding model instead of e5) on a random
port, on a database of its own (`<test db>_web_e2e_test`, dropped and created on every run, on the server of `pnpm test:db:up` or `DATABASE_URL`), with
`SPOOR_ADMIN_*` set and the built SPA served from `packages/web/dist`.

- `fullstack.spec.ts`, no mocks (BRIEF definition of done item 4, which includes this section's original smoke test): the bootstrap admin logs in and sees the
  project list → creates a project → creates an invite whose link a second browser context accepts → adds that user as a member → writes a memory, a
  decision and a doc in the editor (typing into `.cm-content`), sees them rendered and follows a wikilink → search finds all three → the dashboard
  shows them and "Preview digest" renders the digest → an edit becomes r2 and
  History shows two revisions with the diff → a save based on a revision another user replaced opens the conflict dialog, "Save my version over r3" saves r4
  → an item made 40 days old in SQL goes stale through "Run now" of the cleanup job and shows in the review queue → Verify clears it ("Nothing needs review.")
  → a new token's secret is shown once, cannot be dismissed before "I have copied it", and works on the bearer API → `/device` approves a code requested
  from `POST /p/:slug/device/code` and the next token poll succeeds → "Download export" downloads `spoor-<slug>-<date>.zip`.
- `foundation.spec.ts`, `browse.spec.ts`, `item.spec.ts` mock `/api/v1` in the page (keyboard use, phone width, dark mode, editor details).
