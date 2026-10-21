# Glossary and domain model

One definition per term. Names are the ones used in code, API and UI. Details: [docs/design/data-model.md](docs/design/data-model.md),
[ARCHITECTURE.md](ARCHITECTURE.md). Terms in **bold** inside a definition are defined here.

## Core terms

**Project**: An isolated body of knowledge, usually one repository, with its own **members**, **tokens**, settings, counters (item numbers, ADR numbers) and embedding model. A project owns many **items**
and is addressed by an immutable slug (`acme`). The **shared space** is stored as one special project (`kind='shared'`, slug `_shared`).

**Space**: One of the four named collections of **items** inside a project: `memories`, `decisions`, `docs` or `library`. The space fixes an item's kind, its allowed statuses and its handle form.

**Item**: The unit of storage: Markdown with YAML frontmatter, belonging to exactly one **project** and one **space**, with a handle, a slug, a title, tags, **anchors**, a current `revision` and operational state
(pinned, lifecycle, last verified, last used). An item is a **memory**, a **decision** or a **doc**; its history is its **revisions**.

**Memory**: An item in the `memories` space: one atomic claim with `type` (`decision`, `fact`, `procedure` or `observation`), `confidence` (`low`, `medium`, `high`) and `status` (`active` or `superseded`). Handle `m42`.
Agents create memories through MCP. A memory of type `observation` carries a hard `expires_at`. A memory of type `decision` is a note, not an **ADR**: it may later be **drafted** into one.

**Decision** (**ADR**): An item in the `decisions` space: an Architecture Decision Record, numbered per project (`adr_number`, handle `ADR-0007`), with `status` `proposed`, `accepted`, `superseded` or `deprecated` and a decision date.
Decisions are mostly **mirrored** from `docs/adr/*.md` files in the repository. They never expire; they are only superseded. Not to be confused with a memory of type `decision`.

**Doc**: An item in the `docs` space: a long-form page (architecture overview, domain model, runbook). Handle `d7`. Docs are written in the web UI or **mirrored** from repository files, and never expire.

**Revision**: An immutable full snapshot of an item's content (title, body, status, canonical frontmatter) with who made it (user, token, `via`, client name) and when. Every content change creates the next revision number;
operational changes (pin, verify, lifecycle, last used) do not. Revisions are append-only and disappear only when a human hard-deletes the item. An update must name the revision it was based on (optimistic concurrency).

**Edge**: A directed link from one **item** to another (or to a not-yet-existing target). Kinds: `refines`, `supports`, `depends_on`, `conflicts_with` (set by agents or humans), `supersedes` and `drafted_from` (set by the system),
and `wikilink` (derived from `[[slug]]` in the body on every revision). The reverse view of an edge is a **backlink**. A project item may point to a **shared** item, never the reverse. A project item may point to a **library page** with `refines`, `supports`, `depends_on` or a wikilink, never with `conflicts_with`, `supersedes` or `drafted_from`; a library page links out to any item as a human choice at save time.

**Anchor**: A repository-relative file path, glob or directory prefix attached to an **item** (`src/auth/`, `packages/*/schema.ts`). The **digest** uses anchors to surface items about the files an agent is touching.
Matching strength: exact path, then glob, then directory.

**Token**: A secret bearer credential (`spr_…`) that lets an agent or CLI use one **project** over MCP and the REST bearer API. It belongs to one user and one project, inherits the user's live role (optionally capped to read-only), and is stored
only as a SHA-256 hash; the plaintext is shown once. Created in the web UI or through the **device code** flow (then it expires after 90 days by default). The CLI sends it only to the server origin stored next to it.

**Service token**: A **token** (`sprs_…`) owned by a project rather than a user, for CI and bots, with a fixed role (`editor` or `viewer`, never admin). Created and revoked by project admins.

**Device code**: A short-lived pair of codes (a secret device code for the CLI, an eight-letter user code for the human) that lets a CLI obtain a **token** after the user types the user code in the browser and approves it (RFC 8628, adapted;
no pre-filled link). Valid for 10 minutes, consumed once.

**Digest**: The budgeted summary an agent receives in one call (`spoor_context`, or the SessionStart hook): one item per line, handle first, assembled in six tiers (**library** pages, pinned, accepted decisions of the last 30 days, **anchored** items,
items relevant to a query, recently verified), with capped shares so the anchored tier is never starved, and guaranteed to fit the token budget (default 1500). It opens with a line saying the notes are data, not instructions. Reading the digest never counts as use.

**Stale**: A **lifecycle** value for a memory that was neither verified, edited nor used for `stale_days` (default 30). Stale memories leave the **digest** but stay searchable (marked) and appear in the review queue.
Only verifying, pinning or editing makes them active again; reading does not, but a stale memory that is still being used is not archived.

**Archived**: A **lifecycle** value for an item taken out of circulation: automatically (a stale memory after `archive_days` more, default 90; an expired observation) or by a human. Archived items are hidden from search and the digest
unless asked for, and can be restored only by a human. Archiving never deletes anything.

**Library page**: A long-form item in a project's `library` space (handle `L<number>`, `S:L<number>` for a shared page): a guide a human wants set in stone for agents, such as a graphics guide or coding conventions. It is `active` or `archived`, never stale, expiring, pinned, verified or repo-mirrored, and agents can read it but never change it (`read_only_space`). Every active page is listed in the first tier of the **digest**.

**Library editor**: A member (any non-admin role, a viewer included) whose membership carries the `library_editor` flag, granted by a project admin. It lets the person create and edit **library pages** in the web UI. Admins always hold the right, so the flag is stored false for them, and demoting an admin clears it unless the demotion sets it.

**Human-only space**: A space whose writes need a logged-in human in the web UI: the **shared space** (instance admin or **shared editor**) and `library` (instance admin, project admin or **library editor**). Every agent, CLI, token and bearer write is refused with `read_only_space`. A browser-automation agent driving a logged-in session cannot be told apart from the human.

**Shared space**: The org-wide knowledge area with the same four **spaces**, readable by every user and every project **token**, writable only by humans in the web UI: instance admins and **shared editors**. All agent and CLI write paths
reject it (`read_only_space`). Handles carry the prefix `S:` (`S:d3`).

**Shared editor**: A global right on a user (`shared_editor`) that allows writing the **shared space** in the web UI, without being an instance admin and without any project role.

**Mirror**: The one-way copy of repository files into Spoor: ADR files (`docs/adr/*.md`) into the decisions space and a configured list of doc files into the docs space. The CLI imports once and pushes on change (the Write/Edit hook, plus a
sweep of changed files at session start); nothing is ever pulled back. A mirrored item has a `source_path`, which follows renames. Edits made in the web UI stay in Spoor and make the next push a **push conflict** until a human forces it.

**Push conflict**: The state of a **mirrored** item whose repository file could not be pushed because the item was edited in Spoor after the last push (`push_conflict_at`). It is shown at every session start, in `spoor status` and in the
review queue until a human runs the push with `--force` or aligns the file.

**Draft**: An ADR produced client-side from a decision **memory** by the `spoor adr draft` command (using a cheap model through the user's own `claude` login, in the background after a turn ends), saved as `docs/adr/NNNN-slug.md` in the repository with
`status: proposed` and pushed. The draft links back to its memory with a `drafted_from` **edge**; once a human accepts the ADR, the memory drops out of the **digest**. At most one draft exists per memory (`already_drafted`). A fallback draft is mechanical (no model).

## Supporting terms

**Handle**: The short id agents and humans use instead of uuids: `m<number>` for memories, `d<number>` for docs, `L<number>` for library pages, `ADR-<4 digits>` for decisions, with `S:` for the **shared space**. The uuid is the item's `spoor_id`, which is what repository files carry.

**Lifecycle**: The housekeeping axis of an item: `active`, **stale** or **archived**. It is separate from `status`, the domain axis (`active` or `superseded` for memories and docs, `proposed`, `accepted`, `superseded`, `deprecated` for decisions).

**Supersede**: Replacing an item with a newer one: the new item gets a `supersedes` **edge** to the old, and the old item's status becomes `superseded`. For memories through `spoor_supersede`; for ADRs through `supersedes:` in the new ADR file; docs are edited instead.

**Observation**: A **memory** of type `observation`: a short-lived note with a hard expiry (default 7 days) that cannot be extended by verifying. It leaves reads at once when expired and is archived by the cleanup job.

**Request log**: The record of agent requests: one row per MCP tool call and per spoor CLI call, read or write, with the person, token, agent, items and query. Kept 14 days, readable by project and instance admins (ADR-0018). Not the audit log, which keeps every change forever and holds no reads.

**Backlink**: The incoming side of an **edge**, shown on the target item (who links here). On a shared item only the viewer's own projects' links are shown.

**Map**: The web page that draws a project's **items** as nodes and their **edges** as lines (`/projects/<slug>/graph`, `/shared/graph`; ADR-0021): the whole project, or one item's neighbourhood of one or two hops ("Open in map", "Focus here"). It is read-only apart from adding relations and **suggested links** from its side card, filters by space, edge kind, lifecycle and superseded status, and draws at most 1,500 nodes. Agents get the neighbourhood as text with `spoor_get` `depth`. In the API it is the project graph (`GET …/graph`).

**Ghost node**: A node on the **map** that is not part of the view itself but is joined to it by a shown **edge**: an item of another project (a **shared** item seen from a project, a project item seen from the shared space) or an item of the project outside the active filters. Drawn with a dashed outline; never walked through in a neighbourhood, and an edge between two ghosts is never shown.

**Dangling reference**: A wikilink whose target does not exist yet (`[[auth-flow]]` with no item of that slug or handle): an **edge** with no target item, only its reference text (`dst_ref`). The **map** draws one hollow node per distinct reference, the dashboard counts them, and creating an item with that slug or handle resolves them.

**Unlinked item**: An active or stale item, not superseded or deprecated, with no **edge** of any kind in either direction (an outgoing **dangling reference** counts as a link). The dashboard counts them and links to the **map** with "Unlinked only".

**Related items** (**suggested links**): Up to a few unlinked items whose text is most similar to an item's by embedding cosine (the best **chunk** pair), above the project's floor `dedupe.related_min_cos` (default 0.70, always below the duplicate threshold). Computed on each request from the stored vectors, never stored and with no LLM (ADR-0022). People see them as "Suggested links" on the item page and in the **map**'s side card, with one-click Link; agents see them as the `related:` line after a write and the `see also:` line of `spoor_get`. Linked, archived, superseded, deprecated and expired items are never suggested.

**Chunk**: A piece of an item's text (about 400 tokens, 60 overlap, code fences kept whole) with a vector tagged by embedding model; search runs over chunks and scores an item by its best chunk.

**Embedding model tag**: The string that identifies the model, variant and width that produced a chunk's vector (`local:Xenova/multilingual-e5-small@q8/384`). Search reads only vectors whose tag matches the project's active model; a **re-embed** switches it.

**Review queue**: The human work list of a project, five sections: stale memories, recently archived items, observations about to expire, conflicting memories and **push conflicts**, each with its actions (the last one only names the command to force the push).

**Instance admin**: A user with `is_admin`: manages users, invites and projects, and acts as admin in every project and in the **shared space**. **Project roles** are `admin`, `editor` and `viewer`.

**Invite**: A single-use, expiring link (`/invite#spi_…`) created by an admin; accepting it creates a user and grants project roles. There is no email. Only a **reset invite** (created by an instance admin for one named user) can change an existing
user's password; any other invite for an existing account's email is refused.

**Session**: A web login: a random cookie (`spoor_sid`, `__Host-spoor_sid` over https) whose sha256 is a `sessions` row. It ends at logout, after 30 days, after 14 idle days, or when the user's password is reset or the user is disabled or deleted. Sessions are for the web UI only; agents use **tokens**.

**Effective role**: The project role a request acts with: the membership role (`admin` for an **instance admin** without one), capped by a token's read-only cap. In the **shared space**, which has no members, the web UI shows `admin` for an instance admin, `editor` for a **shared editor** and `viewer` for everyone else.

**Provenance**: Whether an item's current content was last written by an agent through MCP with no human edit, verify or pin since (`agent`, shown as `~` after the handle) or by a human or a reviewed repo file (`human`). Memory content is
treated as untrusted data either way; provenance helps the reader weigh it. Imported history is marked `imported:` and never attributed to live users.

**Export / import**: A project (or the **shared space**) as one zip: `manifest.json`, one Markdown file per **item**, its **revisions** and its audit log, with labels instead of user ids. Importing it is lossless (ids, numbers, history kept, or remapped) into a new or empty project; a plain folder of Markdown files can be imported too. **Chunks** are not exported; they are rebuilt after the import.

**Job**: Background work the server runs itself on a schedule, one holder at a time across containers (a database lease): `cleanup` (stale, archive, expire, plus a chunk consistency sweep), `embed-pending`, `reembed`, `purge-ephemeral`. A write can ask for a job to run soon; an **instance admin** can start one.

**Install doc**: The public, secret-free page `/p/<slug>/install.md` (and its machine form `install.json`) that tells an agent how to set up one repository: install the CLI, `spoor login`, `spoor init`. It carries only the server URL, slug, version, the project's digest budget and its memory mode (ADR-0015).

**Re-embed**: The job that rebuilds a project's vectors under a new **embedding model tag** after the provider or the default model changes; search keeps using the old model until one transaction switches the project over (see [docs/operations.md](docs/operations.md) §7).

**Device token**: A **token** minted by the **device code** flow; it expires after 90 days by default, unlike a token created in the web UI, whose expiry is optional.

## Relationships

- A **project** has many **members** (user plus role), **tokens**, **service tokens** and **items**; the **shared space** is a project without members or tokens.
- A **space** belongs to a project; an **item** belongs to one project and one space; a space is exactly one of memories, decisions, docs, library.
- An item has many **revisions** (the latest is the item's current content), many **chunks** per embedding model, **anchors**, tags, and outgoing and incoming **edges**.
- A **memory** may be **superseded** by another memory; an **ADR** by another ADR; both through `supersedes` **edges**. A **draft** ADR points to its memory by `drafted_from`.
- A **project item** points to a **library page** only with `refines`, `supports`, `depends_on` or a wikilink; a library page is written only by humans (instance admins, project admins and **library editors**) and is never part of the review queue or cleanup.
- A **mirror** connects one repository file to one item (`source_path`), in the direction repository to Spoor only.
- A **token** belongs to one project and either one user or the project (**service token**); a **device code** belongs to one project and ends as one token.
- The **digest** is computed from a project's active items plus the **shared space**; **stale** and **archived** items are excluded.
- The **review queue** lists items by lifecycle (**stale**, **archived**) and by edge (`conflicts_with`); humans move items out of it.
- The **map** shows a project's items and **edges**, plus **ghost nodes** for the other ends and one hollow node per **dangling reference**; **related items** are computed from **chunks** and never become edges until a human or agent links them.
- Every change to an item writes an audit row naming the actor (user or service token, `via`, client name); the audit log outlives deleted items.
