/**
 * TanStack Query hooks: one per endpoint of endpoints.ts. Reads are `useQuery` / `useInfiniteQuery` (cursor
 * lists, "Load more"), writes are `useMutation` and own their cache policy, which is the invalidation table of
 * docs/design/web-ui.md §3 implemented once in `invalidateItemScope` and friends. Components never call
 * `queryClient.invalidateQueries` themselves.
 */
import {
  type InfiniteData,
  keepPreviousData,
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ApiError } from './client'
import * as E from './endpoints'
import { qk } from './keys'
import type {
  AuditFilters,
  ContextParams,
  InviteCreateBody,
  InviteFilters,
  InviteJson,
  ItemAction,
  ItemCreateBody,
  ItemJson,
  ItemListFilters,
  ItemPatchBody,
  MemberJson,
  MeResponse,
  Page,
  ProjectCreateRequest,
  ProjectJson,
  ProjectPatchRequest,
  ProjectRole,
  RelationKind,
  RestoreBody,
  ReviewBulkBody,
  ReviewRowOf,
  ReviewSection,
  RevisionConflictDetails,
  SearchParams,
  Space,
  SupersedeBody,
  TokenCreateRequest,
  TokenJson,
  UserFilters,
  UserPatchBody,
} from './types'

// ---- helpers -----------------------------------------------------------------------------------------

type Cursor = string | undefined

/** All rows of an infinite list, in order. */
export function flattenPages<T>(data: InfiniteData<Page<T>> | undefined): T[] {
  return data ? data.pages.flatMap((p) => p.items) : []
}

const nextCursor = <T>(last: Page<T>): Cursor => last.next_cursor ?? undefined

/** `details` of a 409 `revision_conflict`, or null for any other error. */
export function revisionConflict(e: unknown): RevisionConflictDetails | null {
  if (!(e instanceof ApiError) || e.code !== 'revision_conflict') return null
  const d = e.details as Partial<RevisionConflictDetails> | undefined
  return d && typeof d.current_revision === 'number' && d.current ? (d as RevisionConflictDetails) : null
}

/**
 * After any content write or item action (web-ui.md §3): lists, item pages, revisions, edges, dashboard,
 * review queue and search of the project; `counts` also refreshes the project list (its counts and badges).
 */
export function invalidateItemScope(qc: QueryClient, slug: string, opts: { counts?: boolean } = {}) {
  for (const queryKey of [
    qk.items(slug),
    qk.item(slug),
    qk.revisions(slug),
    qk.edges(slug),
    qk.dashboard(slug),
    qk.review(slug),
    qk.search(slug),
  ]) {
    void qc.invalidateQueries({ queryKey })
  }
  if (opts.counts) void qc.invalidateQueries({ queryKey: qk.projects() })
}

/** Put a fresh item into the cache under the ref the page used and under its handle. */
function storeItem(qc: QueryClient, slug: string, item: ItemJson, ref?: string) {
  qc.setQueryData(qk.item(slug, item.handle), item)
  if (ref && ref !== item.handle) qc.setQueryData(qk.item(slug, ref), item)
}

// ---- auth, me, instance ------------------------------------------------------------------------------

export const meQueryOptions = () =>
  queryOptions({ queryKey: qk.me(), queryFn: ({ signal }) => E.getMe({ signal }), staleTime: 60_000 })

export const useMe = () => useQuery(meQueryOptions())

export const useInstance = () =>
  useQuery({
    queryKey: qk.instance(),
    queryFn: ({ signal }) => E.getInstance({ signal }),
    staleTime: 5 * 60_000,
  })

/** On success the whole cache is dropped: nothing of a previous user may survive a login. */
export function useLogin() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: E.login, onSuccess: () => qc.clear() })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: E.logout, onSettled: () => qc.clear() })
}

export function usePatchMe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: E.patchMe,
    onMutate: async ({ name }) => {
      await qc.cancelQueries({ queryKey: qk.me() })
      const prev = qc.getQueryData<MeResponse>(qk.me())
      if (prev) qc.setQueryData<MeResponse>(qk.me(), { ...prev, user: { ...prev.user, name } })
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.me(), ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.me() }),
  })
}

export const useChangePassword = () => useMutation({ mutationFn: E.changePassword })

// ---- invites -----------------------------------------------------------------------------------------

export const useInvitePreview = (token: string | null) =>
  useQuery({
    queryKey: qk.invitePreview(token ?? ''),
    queryFn: ({ signal }) => E.previewInvite(token as string, { signal }),
    enabled: !!token,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  })

/** Accepting logs the new user in (Set-Cookie): drop the cache like a login. */
export function useAcceptInvite() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: E.acceptInvite, onSuccess: () => qc.clear() })
}

export const useInvites = (filters: Omit<InviteFilters, 'cursor'> = {}) =>
  useInfiniteQuery({
    queryKey: qk.invites(filters),
    queryFn: ({ pageParam, signal }) => E.listInvites({ ...filters, cursor: pageParam }, { signal }),
    initialPageParam: undefined as Cursor,
    getNextPageParam: nextCursor,
  })

export function useCreateInvite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: InviteCreateBody) => E.createInvite(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invites() }),
  })
}

export function useRevokeInvite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: E.revokeInvite,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.invites() })
      const snapshot = qc.getQueriesData<InfiniteData<Page<InviteJson>>>({ queryKey: qk.invites() })
      const now = new Date().toISOString()
      qc.setQueriesData<InfiniteData<Page<InviteJson>>>({ queryKey: qk.invites() }, (d) =>
        d
          ? {
              ...d,
              pages: d.pages.map((p) => ({
                ...p,
                items: p.items.map((i) => (i.id === id ? { ...i, status: 'revoked', revoked_at: now } : i)),
              })),
            }
          : d,
      )
      return { snapshot }
    },
    onError: (_e, _v, ctx) => {
      for (const [k, d] of ctx?.snapshot ?? []) qc.setQueryData(k, d)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.invites() }),
  })
}

// ---- users (instance admin) --------------------------------------------------------------------------

export const useUsers = (filters: Omit<UserFilters, 'cursor'> = {}) =>
  useInfiniteQuery({
    queryKey: qk.users(filters),
    queryFn: ({ pageParam, signal }) => E.listUsers({ ...filters, cursor: pageParam }, { signal }),
    initialPageParam: undefined as Cursor,
    getNextPageParam: nextCursor,
  })

export const useUser = (id: string) =>
  useQuery({ queryKey: qk.user(id), queryFn: ({ signal }) => E.getUser(id, { signal }) })

export function usePatchUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UserPatchBody }) => E.patchUser(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.users() })
      void qc.invalidateQueries({ queryKey: qk.me() })
    },
  })
}

export function useDeleteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, email }: { id: string; email: string }) => E.deleteUser(id, email),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users() }),
  })
}

// ---- device flow -------------------------------------------------------------------------------------

/**
 * Every 404 of lookup/approve/deny counts as a miss toward a 10-minute lock (api.md §3), so the lookup never
 * refetches by itself: no retry, no refetch on focus or reconnect.
 */
export const useDeviceLookup = (code: string | null) =>
  useQuery({
    queryKey: qk.deviceLookup(code ?? ''),
    queryFn: ({ signal }) => E.deviceLookup(code as string, { signal }),
    enabled: !!code,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

export const useDeviceApprove = () =>
  useMutation({
    mutationFn: ({ code, readOnly }: { code: string; readOnly: boolean }) => E.deviceApprove(code, readOnly),
  })

export const useDeviceDeny = () => useMutation({ mutationFn: (code: string) => E.deviceDeny(code) })

// ---- projects ----------------------------------------------------------------------------------------

export const useProjects = () =>
  useQuery({ queryKey: qk.projects(), queryFn: ({ signal }) => E.listProjects({ signal }) })

export const projectQueryOptions = (slug: string) =>
  queryOptions({ queryKey: qk.project(slug), queryFn: ({ signal }) => E.getProject(slug, { signal }) })

export const useProject = (slug: string | undefined) =>
  useQuery({ ...projectQueryOptions(slug ?? ''), enabled: !!slug })

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ProjectCreateRequest) => E.createProject(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects() }),
  })
}

export function usePatchProject(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ProjectPatchRequest) => E.patchProject(slug, body),
    onSuccess: (project, body) => {
      // the PATCH answer may lack the caller-specific `role`; keep the cached one
      const prev = qc.getQueryData<ProjectJson>(qk.project(slug))
      qc.setQueryData<ProjectJson>(qk.project(slug), {
        ...prev,
        ...project,
        role: project.role ?? prev?.role,
      })
      void qc.invalidateQueries({ queryKey: qk.project(slug) })
      void qc.invalidateQueries({ queryKey: qk.projects() })
      if (body.settings?.embedding?.provider !== undefined)
        void qc.invalidateQueries({ queryKey: qk.jobs(slug) })
    },
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (slug: string) => E.deleteProject(slug),
    onSuccess: (_r, slug) => {
      for (const prefix of [
        'project',
        'dashboard',
        'items',
        'item',
        'review',
        'members',
        'tokens',
        'audit',
      ]) {
        qc.removeQueries({ queryKey: [prefix, slug] })
      }
      void qc.invalidateQueries({ queryKey: qk.projects() })
      void qc.invalidateQueries({ queryKey: qk.me() })
    },
  })
}

export const useDashboard = (slug: string) =>
  useQuery({ queryKey: qk.dashboard(slug), queryFn: ({ signal }) => E.getDashboard(slug, { signal }) })

/** Digest preview: runs only when `params` is set (the form was submitted). */
export const useContextPreview = (slug: string, params: ContextParams | null) =>
  useQuery({
    queryKey: qk.context(slug, params ?? {}),
    queryFn: ({ signal }) => E.getContextPreview(slug, params ?? {}, { signal }),
    enabled: params !== null,
    staleTime: 0,
  })

// ---- members -----------------------------------------------------------------------------------------

export const useMembers = (slug: string) =>
  useQuery({ queryKey: qk.members(slug), queryFn: ({ signal }) => E.listMembers(slug, { signal }) })

function invalidateMembers(qc: QueryClient, slug: string) {
  void qc.invalidateQueries({ queryKey: qk.members(slug) })
  void qc.invalidateQueries({ queryKey: qk.project(slug) })
  void qc.invalidateQueries({ queryKey: qk.me() })
}

export function useAddMember(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { email: string; role: ProjectRole; library_editor?: boolean }) =>
      E.addMember(slug, body),
    onSettled: () => invalidateMembers(qc, slug),
  })
}

/**
 * Change a member's role and/or library right. Optimistic, rolled back on error. The server may change the
 * flag implicitly (admin implies it, leaving admin clears it), so the members and project are refetched after.
 */
export function useSetMember(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, ...patch }: { userId: string; role?: ProjectRole; library_editor?: boolean }) =>
      E.setMember(slug, userId, patch),
    onMutate: async ({ userId, role, library_editor }) => {
      await qc.cancelQueries({ queryKey: qk.members(slug) })
      const prev = qc.getQueryData<{ items: MemberJson[] }>(qk.members(slug))
      if (prev) {
        qc.setQueryData(qk.members(slug), {
          items: prev.items.map((m) => {
            if (m.user.id !== userId) return m
            const next = { ...m, role: role ?? m.role }
            if (library_editor !== undefined) next.library_editor = library_editor
            else if (role !== undefined && role !== m.role && (role === 'admin' || m.role === 'admin'))
              next.library_editor = false
            return next
          }),
        })
      }
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.members(slug), ctx.prev)
    },
    onSettled: () => invalidateMembers(qc, slug),
  })
}

export function useRemoveMember(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => E.removeMember(slug, userId),
    onMutate: async (userId) => {
      await qc.cancelQueries({ queryKey: qk.members(slug) })
      const prev = qc.getQueryData<{ items: MemberJson[] }>(qk.members(slug))
      if (prev) qc.setQueryData(qk.members(slug), { items: prev.items.filter((m) => m.user.id !== userId) })
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.members(slug), ctx.prev)
    },
    onSettled: () => {
      invalidateMembers(qc, slug)
      // removing a member revokes their tokens of the project
      void qc.invalidateQueries({ queryKey: qk.tokens(slug) })
    },
  })
}

// ---- tokens ------------------------------------------------------------------------------------------

export const useTokens = (slug: string, includeRevoked = false) =>
  useQuery({
    queryKey: qk.tokens(slug, includeRevoked),
    queryFn: ({ signal }) => E.listTokens(slug, includeRevoked, { signal }),
  })

/** Token lists of several projects at once (the account page's "My tokens"). */
export const useTokensAcross = (slugs: string[]) =>
  useQueries({
    queries: slugs.map((slug) => ({
      queryKey: qk.tokens(slug, false),
      queryFn: ({ signal }: { signal: AbortSignal }) => E.listTokens(slug, false, { signal }),
    })),
  })

export function useCreateToken(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: TokenCreateRequest) => E.createToken(slug, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tokens(slug) })
      void qc.invalidateQueries({ queryKey: qk.project(slug) })
    },
  })
}

/** Optimistic: the row leaves lists without revoked tokens and is marked revoked in the others. */
export function useRevokeToken(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => E.revokeToken(slug, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.tokens(slug) })
      const snapshot = qc.getQueriesData<{ items: TokenJson[] }>({ queryKey: qk.tokens(slug) })
      const now = new Date().toISOString()
      for (const [key, data] of snapshot) {
        if (!data) continue
        const withRevoked = (key[2] as { includeRevoked?: boolean } | undefined)?.includeRevoked === true
        qc.setQueryData(key, {
          items: withRevoked
            ? data.items.map((t) => (t.id === id ? { ...t, revoked_at: t.revoked_at ?? now } : t))
            : data.items.filter((t) => t.id !== id),
        })
      }
      return { snapshot }
    },
    onError: (_e, _v, ctx) => {
      for (const [k, d] of ctx?.snapshot ?? []) qc.setQueryData(k, d)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.tokens(slug) })
      void qc.invalidateQueries({ queryKey: qk.project(slug) })
    },
  })
}

// ---- items -------------------------------------------------------------------------------------------

export const useItems = (slug: string, space: Space, filters: Omit<ItemListFilters, 'cursor'> = {}) =>
  useInfiniteQuery({
    queryKey: qk.items(slug, space, filters),
    queryFn: ({ pageParam, signal }) =>
      E.listItems(slug, space, { ...filters, cursor: pageParam }, { signal }),
    initialPageParam: undefined as Cursor,
    getNextPageParam: nextCursor,
    placeholderData: keepPreviousData,
  })

export const useItem = (slug: string, ref: string | undefined) =>
  useQuery({
    queryKey: qk.item(slug, ref ?? ''),
    queryFn: ({ signal }) => E.getItem(slug, ref as string, { signal }),
    enabled: !!ref,
  })

export function useCreateItem(slug: string, space: Space) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ItemCreateBody) => E.createItem(slug, space, body),
    onSuccess: (res) => {
      storeItem(qc, slug, res.item)
      invalidateItemScope(qc, slug, { counts: true })
    },
  })
}

/**
 * Edit with the revision the form was loaded from. A 409 `revision_conflict` rejects with an ApiError;
 * `revisionConflict(error)` gives `{current_revision, current}` for the conflict dialog.
 */
export function usePatchItem(slug: string, ref: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ItemPatchBody) => E.patchItem(slug, ref, body),
    onSuccess: (res) => {
      storeItem(qc, slug, res.item, ref)
      invalidateItemScope(qc, slug, { counts: true })
    },
  })
}

export function useDeleteItem(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ handle }: { handle: string; ref?: string }) => E.deleteItem(slug, handle),
    onSuccess: (_r, { handle, ref }) => {
      qc.removeQueries({ queryKey: qk.item(slug, handle) })
      if (ref) qc.removeQueries({ queryKey: qk.item(slug, ref) })
      invalidateItemScope(qc, slug, { counts: true })
    },
  })
}

/** pin / unpin / verify / archive. Pin and unpin flip `pinned` optimistically. */
export function useItemAction(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ref, action, note }: { ref: string; action: ItemAction; note?: string }) =>
      E.itemAction(slug, ref, action, note),
    onMutate: async ({ ref, action }) => {
      if (action !== 'pin' && action !== 'unpin') return { prev: undefined }
      await qc.cancelQueries({ queryKey: qk.item(slug, ref) })
      const prev = qc.getQueryData<ItemJson>(qk.item(slug, ref))
      if (prev) qc.setQueryData<ItemJson>(qk.item(slug, ref), { ...prev, pinned: action === 'pin' })
      return { prev }
    },
    onError: (_e, { ref }, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.item(slug, ref), ctx.prev)
    },
    onSuccess: (res, { ref }) => storeItem(qc, slug, res.item, ref),
    onSettled: () => invalidateItemScope(qc, slug, { counts: true }),
  })
}

/** Restore an archived item; an expired observation needs `{promote_to_fact: true, revision}`. */
export function useRestoreItem(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ref, body }: { ref: string; body?: RestoreBody }) => E.restoreItem(slug, ref, body),
    onSuccess: (res, { ref }) => storeItem(qc, slug, res.item, ref),
    onSettled: () => invalidateItemScope(qc, slug, { counts: true }),
  })
}

/** Memories only: supersede `ref` with a new memory or an existing one (`new_id`). */
export function useSupersedeItem(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ref, body }: { ref: string; body: SupersedeBody }) => E.supersedeItem(slug, ref, body),
    onSuccess: (res, { ref }) => {
      storeItem(qc, slug, res.old, ref)
      storeItem(qc, slug, res.new)
    },
    onSettled: () => invalidateItemScope(qc, slug, { counts: true }),
  })
}

// ---- revisions ---------------------------------------------------------------------------------------

export const useRevisions = (slug: string, ref: string) =>
  useInfiniteQuery({
    queryKey: qk.revisions(slug, ref),
    queryFn: ({ pageParam, signal }) => E.listRevisions(slug, ref, { cursor: pageParam }, { signal }),
    initialPageParam: undefined as Cursor,
    getNextPageParam: nextCursor,
  })

/** Snapshots are immutable: cached forever per `n`. */
export const useRevision = (slug: string, ref: string, n: number | null) =>
  useQuery({
    queryKey: qk.revision(slug, ref, n ?? 0),
    queryFn: ({ signal }) => E.getRevision(slug, ref, n as number, { signal }),
    enabled: n !== null && n > 0,
    staleTime: Number.POSITIVE_INFINITY,
  })

// ---- edges and links ---------------------------------------------------------------------------------

export const useEdges = (slug: string, ref: string | undefined) =>
  useQuery({
    queryKey: qk.edges(slug, ref ?? ''),
    queryFn: ({ signal }) => E.getEdges(slug, ref as string, { signal }),
    enabled: !!ref,
  })

export function useAddEdge(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ref, kind, to }: { ref: string; kind: RelationKind; to: string }) =>
      E.addEdge(slug, ref, { kind, to }),
    onSettled: (_r, _e, { kind }) => {
      void qc.invalidateQueries({ queryKey: qk.edges(slug) })
      if (kind === 'conflicts_with') void qc.invalidateQueries({ queryKey: qk.review(slug) })
    },
  })
}

export function useRemoveEdge(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (edgeId: string) => E.removeEdge(slug, edgeId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.edges(slug) })
      void qc.invalidateQueries({ queryKey: qk.review(slug) })
    },
  })
}

export const useResolve = (slug: string, ref: string, from?: string) =>
  useQuery({
    queryKey: qk.resolve(slug, ref, from),
    queryFn: ({ signal }) => E.resolveRef(slug, ref, { signal }, from),
    retry: false,
  })

// ---- search ------------------------------------------------------------------------------------------

/** Keeps the previous results visible while the next query loads; idle for an empty `q`. */
export const useSearch = (slug: string, params: SearchParams) =>
  useQuery({
    queryKey: qk.search(slug, params),
    queryFn: ({ signal }) => E.search(slug, params, { signal }),
    enabled: params.q.trim().length > 0,
    placeholderData: keepPreviousData,
  })

// ---- review queue ------------------------------------------------------------------------------------

export const useReviewCounts = (slug: string | undefined) =>
  useQuery({
    queryKey: qk.reviewCounts(slug ?? ''),
    queryFn: ({ signal }) => E.getReviewCounts(slug as string, { signal }),
    enabled: !!slug,
  })

export const useReviewSection = <S extends ReviewSection>(slug: string, section: S) =>
  useInfiniteQuery({
    queryKey: qk.review(slug, section),
    queryFn: ({ pageParam, signal }) => E.listReviewSection(slug, section, { cursor: pageParam }, { signal }),
    initialPageParam: undefined as Cursor,
    getNextPageParam: (last: Page<ReviewRowOf[S]>) => nextCursor(last),
  })

export const useUndraftedDecisions = (slug: string) =>
  useQuery({
    queryKey: qk.undrafted(slug),
    queryFn: ({ signal }) => E.listUndraftedDecisions(slug, { signal }),
  })

/** Identity of a review row: the edge id for conflicts, the handle otherwise. */
export function reviewRowKey(row: ReviewRowOf[ReviewSection]): string {
  return 'edge_id' in row ? row.edge_id : row.handle
}

/** Outcome callbacks of a review action. They run on the mutation itself, so they still fire when the
 * optimistic removal of the last row has unmounted the component that started it (a `mutate(…, {onSuccess})`
 * callback would be dropped then). */
export interface ReviewActionNotify<V, R> {
  onSuccess?: (data: R, vars: V) => void
  onError?: (error: Error, vars: V) => void
}

/**
 * Wrap any review-row action (verify, archive, restore, supersede, delete, remove relation…): the rows named
 * by `rowKeys` disappear from the section at once and come back if the call fails (web-ui.md §7).
 */
export function useReviewAction<V extends { rowKeys: string[] }, R = unknown>(
  slug: string,
  section: ReviewSection,
  run: (vars: V) => Promise<R>,
  notify: ReviewActionNotify<V, R> = {},
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: run,
    onMutate: async ({ rowKeys }) => {
      const queryKey = qk.review(slug, section)
      await qc.cancelQueries({ queryKey })
      const prev = qc.getQueryData<InfiniteData<Page<ReviewRowOf[ReviewSection]>>>(queryKey)
      if (prev) {
        const hide = new Set(rowKeys)
        qc.setQueryData(queryKey, {
          ...prev,
          pages: prev.pages.map((p) => ({ ...p, items: p.items.filter((r) => !hide.has(reviewRowKey(r))) })),
        })
      }
      return { prev }
    },
    onSuccess: (data, vars) => notify.onSuccess?.(data, vars),
    onError: (e, vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.review(slug, section), ctx.prev)
      notify.onError?.(e, vars)
    },
    onSettled: () => invalidateItemScope(qc, slug, { counts: true }),
  })
}

type ReviewBulkVars = ReviewBulkBody & { rowKeys: string[] }

/** `review/bulk` with optimistic row removal; skipped items return with the refetch. */
export const useReviewBulk = (
  slug: string,
  section: ReviewSection,
  notify?: ReviewActionNotify<ReviewBulkVars, Awaited<ReturnType<typeof E.reviewBulk>>>,
) =>
  useReviewAction(
    slug,
    section,
    ({ action, refs }: ReviewBulkVars) => E.reviewBulk(slug, { action, refs }),
    notify,
  )

// ---- export / import ---------------------------------------------------------------------------------

export function useImportIntoProject(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, remapIds }: { file: File; remapIds: boolean }) =>
      E.importIntoProject(slug, file, remapIds),
    onSuccess: () => {
      invalidateItemScope(qc, slug, { counts: true })
      void qc.invalidateQueries({ queryKey: qk.audit(slug) })
      void qc.invalidateQueries({ queryKey: qk.project(slug) })
    },
  })
}

// ---- audit and jobs ----------------------------------------------------------------------------------

export const useProjectAudit = (slug: string, filters: Omit<AuditFilters, 'cursor'> = {}) =>
  useInfiniteQuery({
    queryKey: qk.audit(slug, filters),
    queryFn: ({ pageParam, signal }) =>
      E.listProjectAudit(slug, { ...filters, cursor: pageParam }, { signal }),
    initialPageParam: undefined as Cursor,
    getNextPageParam: nextCursor,
  })

export const useInstanceAudit = (filters: Omit<AuditFilters, 'cursor' | 'item'> = {}) =>
  useInfiniteQuery({
    queryKey: qk.instanceAudit(filters),
    queryFn: ({ pageParam, signal }) => E.listInstanceAudit({ ...filters, cursor: pageParam }, { signal }),
    initialPageParam: undefined as Cursor,
    getNextPageParam: nextCursor,
  })

/** Polls every 5 s while a re-embed runs (`embedding.target` set), web-ui.md §3. */
export const useProjectJobs = (slug: string, enabled = true) =>
  useQuery({
    queryKey: qk.jobs(slug),
    queryFn: ({ signal }) => E.getProjectJobs(slug, { signal }),
    enabled,
    refetchInterval: (q) => (q.state.data?.embedding.target ? 5_000 : false),
  })

export const useInstanceJobs = () =>
  useQuery({ queryKey: qk.adminJobs(), queryFn: ({ signal }) => E.getInstanceJobs({ signal }) })

export function useRunJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => E.runJob(name),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.adminJobs() }),
  })
}
