# User guide (web UI)

For people who browse, edit and administer a Spoor instance. English UI, works at phone width, follows your system light or dark
mode. Terms are defined in [GLOSSARY.md](../GLOSSARY.md). Agents have their own guide: [agent-guide.md](agent-guide.md).

## 1. Signing in

- **First admin**: the account made from `SPOOR_ADMIN_EMAIL` and `SPOOR_ADMIN_PASSWORD` (see [operations.md](operations.md)).
- **Everyone else** gets an invite link (`/invite#spi_...`) from an admin. Open it, choose a name and password. There is no
  email: the admin copies the link to you. An invite for an email that already has an account is refused; ask to be added to the
  project instead. A forgotten password is fixed by an instance admin creating a reset invite for you.
- Sessions last 30 days and end after 14 idle days. Account (top right menu): your name, password and every API token you hold.
- The bottom of the left menu shows the versions, for example `Web 0.5.1 · Server 0.5.1`. If they differ after an upgrade, reload
  the page to get the current web UI.

## 2. Roles

| role | scope | can |
|---|---|---|
| viewer | one project | read everything in it, search, preview the digest |
| editor | one project | also create and edit items, pin, verify, archive, restore, relate, use the review queue; create their own tokens |
| admin (project) | one project | also hard-delete items, members, service tokens, invites for the project, settings, export and import; always edit the library; grant the library editor flag |
| instance admin | whole instance | everything, plus users, projects, invites, jobs and the shared space |
| shared editor | right on a user | write the shared space without being an instance admin |
| library editor | flag on a membership | create and edit **library pages** of that project; any non-admin role can hold it, a viewer too |

The library editor flag is granted by project admins on the Members page. Admins always hold the right, so their flag is not shown as a choice; demoting an admin removes it unless you tick it during the demotion. A viewer with the flag can edit library pages but nothing else.

A project you are not a member of does not exist for you (404). Buttons you cannot use are hidden; the server enforces the rules.

## 3. Projects

**Projects** lists the projects you can see as cards with item counts, a review badge and your role, plus a card for the shared
knowledge. Instance admins create projects (New project: name, description, slug; the slug is permanent and becomes part of every
URL and handle). The **dashboard** of a project shows counts per space (active, stale, archived; the library never stale), the five review sections, the last
15 changes and **Agent activity**: when an agent last read and last wrote, who, with which agent and which tool. Under the
counts, a **link health** line such as `12 items without links · 3 dangling references` counts the active and stale items (not
superseded or deprecated) that have no link of any kind in either direction, and the distinct `[[refs]]` in such items that point at
nothing yet. The first part opens the map with **Unlinked only**, the second the whole map. Each part shows only when its count is
above 0 (`1 item without links`, `1 dangling reference`), and the line is hidden when both are 0. The **Connect** box
gives every member the two commands that connect a repository (install the CLI, `spoor login` with this server and project filled in),
the install guide (`/p/<slug>/install.md`) and token creation; it says how a new teammate gets in (project admins: Members; others:
ask a project admin) and how a new project is made (instance admins: Projects). **Preview digest** shows what an agent would receive,
optionally for a query and a list of files, with the token estimate.

**Request log** (project navigation, project admins and instance admins only) lists every agent request of the last 14 days: each
MCP tool call and each call of the spoor CLI and its hooks. A row shows the time, the person (or service token), the token name and
prefix, the agent (for example `claude-code/2.1.303`), read or write, the tool or CLI route, the space and memory type, the items read
or written, the search or digest query (first 200 characters), the outcome and the duration. Filter by kind, via (`mcp` or `cli`),
actor/token/agent text and dates. Rows older than 14 days are deleted. Editors and viewers cannot open it; they see only the last
read and write on the dashboard. Web UI edits are not in it: they are in the **Audit log**.

## 4. Spaces and items

Each project has four spaces, listed in the navigation:

- **Memories**: one atomic claim each, with a type (`decision`, `fact`, `procedure`, `observation`) and a confidence. Handle `m42`.
  Mostly written by agents; you may add your own. A memory of type `decision` is a quick note, not an ADR.
- **Decisions**: ADR documents, numbered `ADR-0007` per project, status `proposed`, `accepted`, `superseded` or `deprecated`.
  Mostly mirrored from `docs/adr/*.md` in the repository, or written here. A `proposed` ADR (for example one drafted by an agent's
  machine) waits for you: **Accept** it on the item page.
- **Docs**: long-form pages (architecture, domain model, runbooks). Handle `d7`.
- **Library**: guides and conventions that agents must follow, such as a graphics guide or an architecture guide. Handle `L3`.
  Only people with the library right (instance admins, project admins and library editors) can create or change a page, and only
  in the web UI. Agents see every active page in their digest and can read it, but never change it (`read_only_space`). A page has
  no status, pin, verify or supersede; it is active or archived, and it is never stale and never expires. Only people with the
  right edit, archive and restore a page; deleting needs a project admin. Without the right you can read a page and see a notice.
  A library page may link to any item with `[[slug]]` or a typed link (a link to a slug that does not exist yet stays unresolved
  until a new library page takes that slug); `conflicts_with` is not available on library pages. Other items link to a library
  page with `refines`, `supports`, `depends_on` or a wikilink. Library pages are not part of the review queue.

Lists filter by type, status, lifecycle, tags and anchor path, sort by date, and keep their filters in the URL, so you can paste a
link. Rows have quick actions for editors: Pin, Verify, Archive. **Search** (box in the top bar) is hybrid full-text plus meaning
search over the current project and the shared space; "Include inactive" adds stale and archived items.

An **item page** shows rendered Markdown, badges (type, status, lifecycle, `pinned`, `agent-written`, `mirrors <path>`), tags,
anchors (repository paths or globs the item is about), dates, who changed it and from where, and the links panel: outgoing and
incoming edges (`refines`, `supports`, `depends_on`, `conflicts_with`, `supersedes`, `drafted_from`, wikilinks). Write
`[[slug]]`, `[[ADR-0007]]`, `[[ref|label]]` or `[[shared:slug]]` in a body to link; a link to nothing shows a **create** button.
**Open in map** (top of the Details panel) shows the item's neighbourhood on the [map](#5-the-map). Opening an item never counts as
using it.

**Suggested links** (bottom of the links panel) lists up to 5 items whose text is closest in meaning to this one and that are not
linked to it yet, in either direction. Candidates are the four spaces of the project, plus the shared space when it uses the same
embedding model (for a shared item, only the shared space). Archived, superseded, deprecated and expired items are left out; stale
ones are not. Each row shows `similar 0.81`: the cosine of the best-matching passages. People who can add relations (editors, admins,
and library editors on library pages) pick a kind (refines, supports, depends on, conflicts with; default refines; a library page
offers no conflicts with) and press **Link**; the button stays disabled after the click and the row disappears on refresh. Readers
see the list without controls. Below the project's minimum similarity (Settings, Duplicates) nothing is shown: **No suggestions
yet**. An item that is not embedded yet shows `embedding pending: related items appear once the item is embedded`; a failed lookup
shows **Suggestions unavailable** with Retry. Suggestions are computed each time from the stored embeddings and never saved
([ADR-0022](adr/0022-link-suggestions-are-computed-on-demand-from-existing-embeddings-nothing-stored.md)).

Item URLs use handles (`/projects/acme/i/m42`), so they stay valid and are safe to paste into chat or an ADR.

## 5. The map

**Map** (project navigation, after Library) draws a project's items as nodes and their links as arrows: `/projects/<slug>/graph`,
and `/shared/graph` for the shared space. Every role can open it. The map itself only reads; you link items from its side card
([ADR-0021](adr/0021-graph-view-one-project-wide-graph-endpoint-rendered-as-d3-force-svg-with-focus.md)).

- **What is drawn**: the project's items that pass the filters, and the links between them of the seven kinds (`refines`,
  `supports`, `depends_on`, `conflicts_with`, `supersedes`, `drafted_from`, wikilinks). Anchors are not links. An item outside the
  filters, or in another space (a shared item seen from a project, a project item seen from the shared space), appears as a
  **ghost** with a dashed outline when a link joins it to a drawn item; links between two ghosts are not drawn and the rest of the
  shared space is not loaded. A `[[ref]]` to an item that does not exist yet is a hollow node labelled `[[ref]]`. On the shared map,
  links from projects show only for projects you are a member of (instance admins see all).
- **Filters** (above the map): checkbox groups for **Spaces** (all), **Lifecycle** (active and stale) and **Link kinds** (all); the
  last ticked box of a group cannot be unticked. **Include superseded and deprecated** (off by default), **Unlinked only**, and
  **Highlight**, a text box that outlines matching items and dims the rest without hiding anything. **Reset filters** shows when
  something is filtered; it keeps the focus, depth and view.
- **The URL holds the view**, so a pasted link shows the same map. Keys: `spaces`, `kinds`, `lifecycle` (comma lists, for example
  `?spaces=memories,decisions`), `superseded=1`, `unlinked=1`, `q` (the highlight), `focus` (a handle), `depth=1` (2 is the
  default), `view=list`. Defaults are left out; unknown values fall back to the default.
- **Unlinked only** shows the items that have no link under the current filters (a `[[ref]]` to nothing counts as a link). The
  server picks them before the size cap, so the result is right on a large project. It works on the whole-project map only: in a
  neighbourhood the box is disabled with the hint "Whole project only". When there is nothing to show: **No items without links**.
- **Status line**: `N items · M links · K items without links · J dangling references`, plus the number of matches while you
  highlight and `updating…` while it reloads. The without-links and dangling counts cover the whole filtered project before the cap,
  so they can be larger than what is drawn.
- **Size cap**: a map shows at most 1,500 items. Above that, **The map is cut short** ("Showing 1,500 of N items") asks you to
  narrow the spaces, link kinds or lifecycle, or to focus on one item. Items of the project are kept before ghosts, then pinned
  items, items with more links and recently updated items.
- **Focus mode** (`?focus=m12&depth=2`) shows one item's neighbourhood: the items up to 1 or 2 links away, in either direction. A
  strip reads "Neighbourhood of m12" with a Depth choice (1 hop, 2 hops) and **Show whole project**. You get there from **Open in
  map** on an item page or **Focus here** on the side card, which opens the item's card too. Ghosts are shown but not walked
  through, and the focused item is always shown, even when the filters would hide it.
- **Legend** (open below the map) explains every mark in text. Shapes give the space, so colour is never the only cue: memories
  are circles, decisions diamonds, docs squares, library pages hexagons. Bigger nodes have more links. Dashed outline: a ghost.
  Hollow and labelled `[[ref]]`: a link to nothing. Outer ring: pinned. Faded: stale (archived more so). `~` after a handle:
  agent-written, not yet reviewed. Links: `refines`, `supports` and `depends_on` are solid lines in their own colours,
  `conflicts_with` has arrows at both ends, `supersedes` is dashed, `drafted_from` dotted, wikilinks thin and muted.
- **Moving around**: drag the empty canvas to pan (a press on a node never pans), turn the mouse wheel to zoom around the pointer,
  or use **Zoom in**, **Zoom out** and **Fit to screen** at the top right. A click on the empty background closes the card; a drag
  keeps it open.

**Side card.** Click a node, or Tab to it and press Enter or Space. The card shows the handle and title, the badges, where the item
lives (for example "in the shared space"), its number of links (outgoing, incoming) and its links grouped by kind with the item
page's labels (Refines and Refined by, Supports and Supported by, and so on); each linked item is a button that selects it on the
map. Actions: **Open item**, **Focus here**, and for people who can relate items **Add relation** (**Add link** on a library page),
the same dialog as on the item page. **Suggested links** in the card work as on the item page: pick a kind and press **Link**, and
the map, the links and the suggestions refresh. A shared ghost on a project map opens in the shared space and has no suggestions
or write actions there. A `[[ref]]` node says "No item has this reference yet." and offers editors **Create it as a doc**. Close
the card with **Close details** or Escape (focus returns to the node). There is no drag-to-link, and links are removed on the item
page.

**List view and keyboard.** **Map** and **List** in the page header switch views (`view=list`). The list has two tables: **Nodes on
the map** (item, space, number of links, state, and **Details**, which opens the card) and **Links** (from, kind, to); matching rows
are marked while you highlight. On the map every node is a focusable button whose name says its handle, title, space, state and
number of links. While focus is in the map, the arrow keys pan, `+` or `=` zooms in, `-` zooms out and `0` fits the map to the
screen. A **Show the map as a list** button appears when you Tab into the map. Links on the map are drawn for the eye only; the
card and the list carry the same information as text.

## 6. Item lifecycle: active, stale, archived

Lifecycle is separate from status. Library pages are only active or archived and are never stale. Every project has three settings (project Settings, defaults in brackets): `stale_days` (30),
`archive_days` (90) and `observation_days` (7).

1. **Active**: in the digest, in search.
2. **Stale**: a memory that was not verified, edited or used for `stale_days` leaves the digest, stays searchable (marked "stale")
   and appears in the **review queue**. Pinned items never go stale. *Verify*, *Pin* or *edit* makes it active again; merely
   reading does not.
3. **Archived**: a stale memory is archived after another `archive_days`, but only if it has not been used in the last `stale_days`
   (a stale memory that agents still fetch stays in the queue). An observation is archived the moment it expires (it also vanishes
   from reads immediately). A human can archive anything by hand. Archived items are hidden unless you ask, and only humans restore
   them (an expired observation must first be **promoted to a fact**).
4. **Deleted**: only a project admin (or, in the shared space, an instance admin or shared editor) can hard-delete, with a
   confirmation that asks you to type the handle. Nothing else ever deletes. Decisions and docs never expire; they are superseded.

The cleanup runs hourly; changed day counts apply at the next run.

### Review queue

`Review` in the project navigation has five tabs with counts:

| tab | what is in it | actions |
|---|---|---|
| Stale | memories gone stale, with days left before auto-archive and a "used since stale" badge | Verify, Edit, Supersede (pick or write the replacement), Archive now, Delete |
| Recently archived | the last 30 days, with the reason (`stale`, `expired`, `manual`) | Restore (promote first for `expired`), Delete |
| Observations expiring | those expiring within 48 hours | Promote to fact, Archive now |
| Conflicts | pairs of memories linked `conflicts_with`, side by side | Keep A, Keep B (supersedes the other), Remove relation, Verify both |
| Push conflicts | mirrored ADRs or docs whose repository push was refused because you edited them here | shows the terminal command to force the push, and a link to the history |

Tick rows for bulk Verify or Archive now. Viewers see the queue without actions.

## 7. Editing and history

**New** (in a space list) or **Edit** (on an item) opens the editor: fields for title, type and confidence (memories), status and
date (decisions), tags, anchors (one per line) and slug (only at creation), then a CodeMirror Markdown editor with live preview
(Write and Preview toggle on small screens). Leaving with unsaved changes asks first and can keep a draft in your browser. Creating a
memory or doc that closely resembles an existing one shows a "similar item exists" warning (not when the two state different numbers
or identifiers, such as `60` and `600`); you can tick "Skip the duplicate check".

Saves always carry the revision you started from. If an agent or colleague saved in between you get the **conflict dialog**, never a
silent overwrite: Compare shows a diff, Keep editing keeps your text, "Save my version over rN" re-sends only the fields you changed
on top of their revision, Discard mine reloads.

Every content change is a new revision (pin, verify and lifecycle changes are not). **History** lists revisions with who, from
where (`web`, `mcp`, `cli`, `import`) and when, and shows a diff against any older revision (line or word level, with frontmatter
changes). **Restore this version** loads an old snapshot into the editor; saving creates a new revision. Revisions disappear only
when a human hard-deletes the item.

**Mirrored items** (ADRs and docs pushed from a repository, badge `mirrors docs/adr/0007-x.md`): you may edit them here, but the
edit stays in Spoor and the repository file is not changed. The next push from the repo is refused (a push conflict) until a human
forces it. Agents cannot edit mirrored items through MCP.

**Supersede** (memories): replace a wrong or outdated memory with a new one (written inline or picked); the old one is marked
`superseded` and links to its replacement. For ADRs, supersede happens in the new ADR file (`supersedes:` in its frontmatter).

## 8. Tokens and device approval

Agents authenticate with bearer tokens, per project. **Tokens** (project navigation) lists them with kind, origin (`device login` or
`web`), role cap, last used, expiry. **New token**: a name, a kind (a user token acts as you with your live role, optionally
read-only; project admins can also make a **service token** for CI and bots, role editor or viewer, viewer preselected) and an
optional expiry. The secret is shown once, with a copy button and a checkbox you must tick before closing. Revoke any time. Admins
see all tokens of the project; everyone sees their own.

**Device approval** is how `spoor login` gets a token without pasting. The command prints a URL and an 8-letter code. Open
`/device`, sign in, type the code and check what the page shows: the project, the requesting address, the code's age and the
self-reported client name (unverified). Then **Approve read-only** (the token can only read; the default focus), **Approve** (the token
follows your role) or **Deny**. Only approve codes you started yourself. Codes last 10 minutes and are single use; device tokens
expire after 90 days. The page does not accept a code from a link, on purpose.

## 9. Admin pages (instance admins)

- **Projects**: every project with counts and review total; create a project.
- **Users**: search, make someone instance admin or shared editor, disable, delete (type the email), **Create reset invite**
  (optionally revoking their API tokens). The last admin cannot be removed.
- **Invites**: create a link with optional email, project roles, flags and expiry (default 7 days); copy it, it is shown once; revoke
  open ones. Project admins invite from their project's Members page, for their own project only.
- **Jobs**: the scheduler's jobs (`cleanup`, `embed-pending`, `reembed`, `purge-ephemeral`) with last run, status, last error, and
  **Run now**.
- **Instance audit**: user, invite, project and job events.

Project admins also have **Members** (add by email, change role, remove; the last project admin cannot be demoted), **Settings**
(name, cleanup days, digest budget and decision window, duplicate threshold 0.80 to 0.99, default 0.87, **Related items minimum similarity**
0.50 to 0.90, default 0.70 (suggested links below it are hidden; it always acts at least 0.01 below the duplicate threshold, so
with threshold 0.85 a saved 0.90 acts as 0.84), embedding provider with a progress bar
during a re-embed, export, import (a full Spoor export into an empty project; a zip of Markdown files into any project), and for
instance admins delete) and the project **Audit log** (who or which
agent changed what, via which channel, filterable).

## 10. Shared space

`Shared knowledge` (`/shared`) is the org-wide space, with the same four spaces (including a shared **Library**, handles `S:L3`, written by instance admins and shared editors) and the same pages. Rules:

- Everyone who can sign in can read it, and every project token can read it (agents see it in digests and searches; handles carry
  an `S:` prefix, `S:d3`).
- Only humans write it, and only instance admins and users with the shared editor right. Every agent or CLI path refuses writes to
  it (`read_only_space`).
- It has no members or tokens. Project items may link to shared items, never the reverse; backlinks on a shared item show only links
  from projects you can see.
- Review actions, pinning, archiving and deleting work for the same writers. Settings and export or import there are for instance
  admins.
- Use it for standards, glossaries and policies that apply across repositories; keep project facts in the project.
