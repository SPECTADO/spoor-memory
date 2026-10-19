import { NotFound } from '../ui'

// Route elements of the page groups (item, review, settings, admin). Each group wraps its pages in
// React.lazy + Suspense in its own index.tsx, so every page is still its own chunk. Single-module pages
// (login, dashboard, space list, search, wikilink, …) are `lazy:` routes in router.tsx instead.

export {
  AdminAuditPage,
  AdminInvitesPage,
  AdminJobsPage,
  AdminProjectsPage,
  AdminUsersPage,
} from './admin'
export { EditorNewPage, HistoryPage, ItemEditPage, ItemPage } from './item'
export { ReviewPage } from './review'
export { AuditPage, MembersPage, SettingsPage, TokensPage } from './settings'
export const NotFoundPage = () => <NotFound />
