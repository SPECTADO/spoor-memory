# User guide (web UI)

For people who browse, edit and administer a Spoor instance. English UI, works at phone width, follows your system light or dark
mode. Terms are defined in [GLOSSARY.md](../GLOSSARY.md). Agents have their own guide: [agent-guide.md](agent-guide.md).

## 1. Signing in

- **First admin**: the account made from `SPOOR_ADMIN_EMAIL` and `SPOOR_ADMIN_PASSWORD` (see [operations.md](operations.md)).
- **Everyone else** gets an invite link (`/invite#spi_...`) from an admin. Open it, choose a name and password. There is no
  email: the admin copies the link to you. An invite for an email that already has an account is refused; ask to be added to the
  project instead. A forgotten password is fixed by an instance admin creating a reset invite for you.
- Sessions last 30 days and end after 14 idle days. Account (top right menu): your name, password and every API token you hold.

## 2. Roles

| role | scope | can |
|---|---|---|
| viewer | one project | read everything in it, search, preview the digest |
| editor | one project | also create and edit items, pin, verify, archive, restore, relate, use the review queue; create their own tokens |
| admin (project) | one project | also hard-delete items, members, service tokens, invites for the project, settings, export and import |
| instance admin | whole instance | everything, plus users, projects, invites, jobs and the shared space |
| shared editor | right on a user | write the shared space without being an instance admin |

A project you are not a member of does not exist for you (404). Buttons you cannot use are hidden; the server enforces the rules.

## 3. Projects

**Projects** lists the projects you can see as cards with item counts, a review badge and your role, plus a card for the shared
knowledge. Instance admins create projects (New project: name, description, slug; the slug is permanent and becomes part of every
URL and handle). The **dashboard** of a project shows counts per space (active, stale, archived), the five review sections, the last
15 changes, and for project admins the install hint (`/p/<slug>/install.md`). **Preview digest** shows what an agent would receive,
optionally for a query and a list of files, with the token estimate.

## 4. Spaces and items

Each project has three spaces, listed in the navigation:

- **Memories**: one atomic claim each, with a type (`decision`, `fact`, `procedure`, `observation`) and a confidence. Handle `m42`.
  Mostly written by agents; you may add your own. A memory of type `decision` is a quick note, not an ADR.
- **Decisions**: ADR documents, numbered `ADR-0007` per project, status `proposed`, `accepted`, `superseded` or `deprecated`.
  Mostly mirrored from `docs/adr/*.md` in the repository, or written here. A `proposed` ADR (for example one drafted by an agent's
  machine) waits for you: **Accept** it on the item page.
- **Docs**: long-form pages (architecture, domain model, runbooks). Handle `d7`.

Lists filter by type, status, lifecycle, tags and anchor path, sort by date, and keep their filters in the URL, so you can paste a
link. Rows have quick actions for editors: Pin, Verify, Archive. **Search** (box in the top bar) is hybrid full-text plus meaning
search over the current project and the shared space; "Include inactive" adds stale and archived items.

An **item page** shows rendered Markdown, badges (type, status, lifecycle, `pinned`, `agent-written`, `mirrors <path>`), tags,
anchors (repository paths or globs the item is about), dates, who changed it and from where, and the links panel: outgoing and
incoming edges (`refines`, `supports`, `depends_on`, `conflicts_with`, `supersedes`, `drafted_from`, wikilinks). Write
`[[slug]]`, `[[ADR-0007]]`, `[[ref|label]]` or `[[shared:slug]]` in a body to link; a link to nothing shows a **create** button.
Opening an item never counts as using it.

Item URLs use handles (`/projects/acme/i/m42`), so they stay valid and are safe to paste into chat or an ADR.

## 5. Item lifecycle: active, stale, archived

Lifecycle is separate from status. Every project has three settings (project Settings, defaults in brackets): `stale_days` (30),
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

## 6. Editing and history

**New** (in a space list) or **Edit** (on an item) opens the editor: fields for title, type and confidence (memories), status and
date (decisions), tags, anchors (one per line) and slug (only at creation), then a CodeMirror Markdown editor with live preview
(Write and Preview toggle on small screens). Leaving with unsaved changes asks first and can keep a draft in your browser. Creating a
memory or doc that closely resembles an existing one shows a "similar item exists" warning; you can tick "Skip the duplicate check".

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

## 7. Tokens and device approval

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

## 8. Admin pages (instance admins)

- **Projects**: every project with counts and review total; create a project.
- **Users**: search, make someone instance admin or shared editor, disable, delete (type the email), **Create reset invite**
  (optionally revoking their API tokens). The last admin cannot be removed.
- **Invites**: create a link with optional email, project roles, flags and expiry (default 7 days); copy it, it is shown once; revoke
  open ones. Project admins invite from their project's Members page, for their own project only.
- **Jobs**: the scheduler's jobs (`cleanup`, `embed-pending`, `reembed`, `purge-ephemeral`) with last run, status, last error, and
  **Run now**.
- **Instance audit**: user, invite, project and job events.

Project admins also have **Members** (add by email, change role, remove; the last project admin cannot be demoted), **Settings**
(name, cleanup days, digest budget and decision window, duplicate threshold 0.80 to 0.99, embedding provider with a progress bar
during a re-embed, export, import (a full Spoor export into an empty project; a zip of Markdown files into any project), and for
instance admins delete) and the project **Audit log** (who or which
agent changed what, via which channel, filterable).

## 9. Shared space

`Shared knowledge` (`/shared`) is the org-wide space, with the same three spaces and the same pages. Rules:

- Everyone who can sign in can read it, and every project token can read it (agents see it in digests and searches; handles carry
  an `S:` prefix, `S:d3`).
- Only humans write it, and only instance admins and users with the shared editor right. Every agent or CLI path refuses writes to
  it (`read_only_space`).
- It has no members or tokens. Project items may link to shared items, never the reverse; backlinks on a shared item show only links
  from projects you can see.
- Review actions, pinning, archiving and deleting work for the same writers. Settings and export or import there are for instance
  admins.
- Use it for standards, glossaries and policies that apply across repositories; keep project facts in the project.
