# @spoor/web

The browser UI: React 19, Vite 8, Tailwind 4, TanStack Query 5, react-router 7 (data mode). Design:
[docs/design/web-ui.md](../../docs/design/web-ui.md); every endpoint it calls: [docs/design/api.md](../../docs/design/api.md);
pinned libraries: [docs/research/web-stack.md](../../docs/research/web-stack.md).

```
pnpm dev          # Vite on :5173, proxies /api, /p/ and /healthz to the server on :3000
pnpm build        # tsc + vite build → dist/ (served by the server)
pnpm test         # vitest + testing-library (jsdom)
pnpm test:e2e     # Playwright against the built server + SPA (build first; `pnpm e2e` at the root does both)
pnpm typecheck    # pnpm lint at the repo root runs Biome
```

## Layout

```
src/
  main.tsx  router.tsx  queryClient.ts  index.css (design tokens)
  api/         client.ts (fetch wrapper, ApiError) · types.ts · endpoints.ts · keys.ts · hooks.ts
  ui/          primitives + MarkdownView, MarkdownEditor (CodeMirror, lazy), DiffView; import from '../ui'
  components/  shell (AppShell, Nav, AccountMenu, ProjectSwitcher), guards (AuthGuard, RequireRole, ProjectScope), RouteError
  pages/       one module per route, one chunk per page: single-module pages are `lazy:` routes in router.tsx; the
               groups item/, review/, settings/, admin/ lazy-load theirs in their own index.tsx (re-exported by pages/index.tsx)
  lib/         paths.ts, roles.ts, wikilinks.ts (remark plugin), diff.ts, format.ts
  test/        setup.ts, utils.tsx (fetch mock, app renderer)
e2e/           Playwright specs; support/ has the server launcher (server.mjs), env.ts (port, databases, admin) and db.ts (SQL)
```

## API layer (`src/api`)

- **Never call `fetch` directly.** `api()` in `client.ts` is the only caller: same-origin `/api/v1` paths only,
  `credentials: 'same-origin'`, JSON bodies get `Content-Type: application/json`, `FormData` goes as multipart, bodyless
  POSTs (item actions, logout) send no body. Any non-2xx throws `ApiError` with `status`, `code` (`body.error`), `message`,
  `hint`, `details`, `requestId` and `issues` (the `invalid_input` list); a network failure is `status 0` / `code 'network'`.
  Use `isApiError(e, 'revision_conflict')` to branch on a code.
- `endpoints.ts` has one typed function per endpoint (path segments go through `seg()`). `types.ts` re-exports every type
  `@spoor/shared` defines (some under the SPA's older names as plain aliases, e.g. `LoginBody = LoginRequest`,
  `DeviceLookup = DeviceLookupResponse`; enums derive from the shared constants) and never keeps a local copy; only shapes the
  server does not export yet are declared there, mirroring its route handlers. Move a type to shared when the server exports it.
- `keys.ts` (`qk.*`) is the only place that builds query keys. Keys are prefix hierarchies: `qk.items(slug)` covers every
  space and filter, `qk.item(slug)` every item page of the project, `qk.review(slug)` the counts and all sections.
- `hooks.ts` has one hook per endpoint. Reads are `useQuery`, cursor lists `useInfiniteQuery` (`flattenPages(data)`,
  "Load more" via `fetchNextPage`). Writes are `useMutation` and **own their cache policy**: components never invalidate.
  The policy is web-ui.md §3: `invalidateItemScope(qc, slug, {counts})` after any content write or item action.
- Optimistic updates (all rolled back on error): pin/unpin (`pinned`), token revoke, invite revoke, member role change and
  removal, `PATCH me` (name), and review-row removal through `useReviewAction(slug, section, run, notify)` / `useReviewBulk`.
  Put toasts for those in `notify` (they run on the mutation): a `mutate(…, {onSuccess})` callback is dropped when removing
  the last row unmounts the component that called it.
- Conflicts: `usePatchItem` rejects with the 409; `revisionConflict(error)` returns `{current_revision, current}`.
- Session: `createQueryClient({onUnauthenticated})` routes every later 401 `unauthenticated` to `/login?next=` (main.tsx),
  and `AuthGuard`'s route loader checks `GET /me` before protected pages render. Login, invite accept and logout clear the
  whole cache. Retries: none for 4xx, once for network/5xx, every 5 s for 503 `starting`.
- Device lookups never refetch by themselves: every server-side miss counts toward a 10-minute lock.

## UI (`src/ui`)

- Style only with the token utilities from `index.css` (`bg-bg`, `bg-surface`, `text-fg`, `text-muted`, `border-border`,
  `bg-accent`, `text-danger`, `bg-success-soft`, …). Dark mode is the same variables overridden under
  `prefers-color-scheme: dark`; do not use raw palette colours or `dark:` variants.
- Controls carry their label: `<Input label="Email" error={…} hint={…} />` wires `aria-describedby`/`aria-invalid`;
  `hideLabel` keeps it for screen readers only. `issuesByField(err.issues)` maps server issues to fields.
- `Dialog` is the native `<dialog>` (focus trap, Esc, focus return); its content mounts only while open, so forms start
  fresh and `autoFocus` works. `ConfirmDialog typeToConfirm="m42"` for destructive actions. `dismissible={false}` for
  a "shown once" secret until it was copied.
- `useToast()`: `success(message, detail?)`, `error(e)` (renders an ApiError's message, hint and request id).
- States: `SkeletonRows`/`Skeleton` for first loads (no spinners over content), `EmptyState` (one sentence, one action
  if the role allows it), `ErrorState` (message, hint, request id), `NotFound`, `Forbidden`, `PageHeader`.
- `Badge` always has text (colour is never the only signal); `Table` is a real table with a caption.
- `MarkdownView source slug` renders GFM plus `[[ref]]`, `[[ref|label]]`, `[[ref#heading]]`, `[[shared:ref]]` as links to the
  `…/w/<ref>` resolver; no raw HTML, external links open in a new tab, only same-origin images load.
- `MarkdownEditor value onChange label="Editor"`: CodeMirror 6 with Markdown, loaded lazily; Tab is not captured.
- `DiffView oldText newText` (`oldText = null` for the first revision): folded line diff with a word-level toggle.

## Shell, routes and roles

- Build links with `lib/paths.ts`: `projectPath(slug, rest)`, `itemPath`, `wikiPath` (the shared space is `/shared/…`,
  slug `_shared`). Inside project pages `useProjectSlug()`; in the shell `useCurrentProjectSlug()`. `safeNext()` guards `?next=`.
- `ProjectScope` loads `GET /projects/:slug` for every project page (404 → Not found), so pages can read the effective
  role from `useProject(slug)`. Hide controls with `useCan('editor' | 'admin' | 'ia')`; gate a whole page with
  `<RequireRole gate=…>` (renders `Forbidden`). On `_shared` the role is `admin` for IA, `editor` for shared editors.
- New page: create `pages/XPage.tsx` exporting `XPage` and add a route `lazy: page(() => import('./pages/XPage'), 'XPage')`
  in `router.tsx` (wrap the route element in `<RequireRole>` or use `ia(…)` when the whole page is gated). A page inside a
  group (`pages/item/`, …) goes through that group's `index.tsx` instead. Add the nav entry in `components/Nav.tsx`.
- State in the URL query: write it with `useSearchParamsState()` (`lib/useSearchParamsState.ts`), not `setSearchParams`.
  A query change is a navigation that commits a moment later (the auth loader revalidates), and react-router hands
  updaters the rendered params; the hook applies each update to the newest written query, so quick changes all land.

## Tests

- Unit and component tests (`*.test.ts(x)` next to the code): `mockApi({'GET /api/v1/me': [200, body], …})` stubs `fetch`
  (an array of replies is used in order; unknown routes are 404), `renderApp('/path')` mounts the real router, guards and
  providers; `renderInRouter(ui)` for a single component with links. Find elements by role and label. A query change
  is a navigation: before asserting `router.state.location`, wait until `router.state.navigation.state` is `idle`.
- Playwright (`e2e/`, web-ui.md §10): `pnpm e2e` at the repo root builds shared, server and web, then runs every spec against
  the **built** server serving the built SPA. `playwright.config.ts` starts `e2e/support/server.mjs` (the server's `dist/`
  wired like `src/index.ts`, with the deterministic fake embedding model) on a random port (`SPOOR_E2E_PORT` pins it) and a
  database of its own, `<test db>_web_e2e_test`, dropped and created per run on the server of `pnpm test:db:up` (or
  `DATABASE_URL`); the bootstrap admin is `admin@example.com` / `admin-password-e2e`. Needs the test database up and
  Chromium installed once: `pnpm exec playwright install chromium`.
  - `fullstack.spec.ts` walks the real stack with two browser contexts (admin and an invited user), serially. Reach for
    `sql()` from `e2e/support/db.ts` only for state the UI cannot make quickly (old timestamps), and for API calls from a
    page use `page.request` with an `origin` header (the server checks it on unsafe methods).
  - `foundation`, `browse` and `item` specs mock `/api/v1` with `page.route`, so they need no data.
