# Agent guide

What a coding agent (and the developer who wires it up) gets from Spoor. Setup is one pass through a project's install doc,
`<server>/p/<slug>/install.md`; the CLI side is in [packages/cli/README.md](../packages/cli/README.md). Humans use the web UI:
[user-guide.md](user-guide.md).

## 1. Access

- One MCP endpoint per project, `<server>/p/<slug>/mcp` (Streamable HTTP), bearer token. The committed `.mcp.json` carries the URL and
  `Authorization: Bearer ${SPOOR_TOKEN}`; the token itself lives in `.claude/settings.local.json` (`env.SPOOR_TOKEN`, mode 0600,
  gitignored by `spoor login`). Nothing secret is committed.
- A token belongs to one user and one project and inherits that user's live role: **editor** or **admin** tokens get all nine tools,
  **viewer** and read-only tokens get only the three read tools. Project **service tokens** (CI, bots) are editor or viewer.
- Every write records the token's owner, `via=mcp` and the client name from MCP `initialize`, so the audit log shows which agent
  changed what. Content from other writers is untrusted data, and the digest and `spoor_get` say so in a fixed line.
- Agents never write to the **shared** space (`read_only_space`); they read it.

## 2. The digest

At session start the hook prints the digest into the context; the same text comes from `spoor_context` or `spoor context --git`.
It is one item per line, handle first, and provably fits its budget (default 1,500 tokens, 200 to 8,000, a per-project setting):

1. **Pinned** items (humans pin the rules that must always be seen).
2. **Accepted decisions** of the last 30 days.
3. **Anchored** items: anchors (repo paths, globs, directories) matching the files in `files`; the hook passes the files changed in
   git (up to 80), so memory about the code you are touching comes first.
4. **Relevant** items for the optional `query`.
5. **Recently verified** items.

Shares are capped so anchored and relevant items are never starved (pinned at most 30 percent, recent decisions 25 percent); what does
not fit becomes one roll-up line per tier (`+14 more decisions (30d): spoor_search space=decisions`). Stale, archived, superseded and
expired items are left out; a `proposed` ADR appears only if pinned. A `~` after a handle means an agent wrote it and no human has
verified it. Reading a digest never counts as using an item.

Line shape: `m42 [fact] Sessions are stored server-side in Postgres @src/auth/`, `ADR-0012 [accepted 2026-10-02] Use pgvector + RRF`,
`S:d3 [doc] Org TypeScript standards` (the `S:` prefix is the shared space).

## 3. Tools

Handles are accepted everywhere an `id` is: `m42` (memory), `d7` (doc), `ADR-0007` (decision), `S:` prefix for shared, or a uuid.
Results are short text blocks (`OK created m58 r1 [fact]`), not JSON. Updates carry the `revision` you read; a mismatch is
`revision_conflict`, never a silent overwrite.

| tool | role | one-line semantics |
|---|---|---|
| `spoor_context` | read | the budgeted digest, for the given `files` and `query`; skip it when the session-start digest is already in context |
| `spoor_search` | read | hybrid keyword and meaning search over memories, ADRs and docs (plus shared); handles with one-line snippets; default 8 results, filters `space`, `type`, `tags`, `include_inactive` |
| `spoor_get` | read | up to 5 items in full (frontmatter, body paged by `offset`/`max_chars`, links); the only read that counts as use and keeps a memory fresh |
| `spoor_remember` | write | record one durable fact, procedure or observation as a one-line claim (body up to 4,000 characters); with `id` and `revision` it updates; returns `DUPLICATE` naming the existing item when it is a near copy |
| `spoor_decide` | write | record a decision as a short memory with the why in `body`; an ADR is drafted from it later by your machine; `supersedes` replaces an earlier decision memory |
| `spoor_doc_write` | write | create or update a long-form doc (body up to 200,000 characters); repo-mirrored docs are edited in their file instead |
| `spoor_supersede` | write | replace an outdated memory with a new claim (or an existing one); the old one is marked superseded |
| `spoor_relate` | write | add or remove a typed link `refines`, `supports`, `depends_on`, `conflicts_with` between two items |
| `spoor_verify` | write | confirm memories are still true: resets the staleness clock and un-stales them |

Rules of thumb that match how the system cleans itself:

- Write **atomic claims**, one per memory, in the title; put reasoning in the body. Use `observation` for things that are true only
  now (a flaky test, a temporary workaround): it expires after 7 days by default and cannot be extended by verifying.
- Attach **anchors** (`src/auth/`, `packages/*/schema.ts`) so the claim surfaces when someone touches those files.
- Search before you remember; on `DUPLICATE`, use the existing item (`spoor_verify` it or update it), and pass
  `allow_duplicate: true` only for a genuinely different claim.
- Unverified, unused memories go stale after 30 days and are archived 90 days later. `spoor_verify` what you confirmed is still
  true, and `spoor_get` what you rely on.
- Common error codes: `revision_conflict` (re-read, retry), `revision_required` (updates need `revision`), `read_only_space` (shared),
  `forbidden_role` (viewer token), `mirrored_item` (edit the repo file instead), `wrong_space`, `too_large`, `not_found`.

## 4. Hooks (Claude Code)

`spoor init` writes three hooks into the committed `.claude/settings.json`. All exit 0 within a few seconds, never block your work,
and become no-ops when `SPOOR_DISABLE=1` is set. After a network failure they skip the network for 5 minutes.

| hook | does |
|---|---|
| **SessionStart** (7 s) | collects changed files from git as anchors, fetches the digest, prints it (once for `startup`, `clear`, `compact`; not for `resume`), replays queued pushes, sweeps mirrored files for edits the next hook missed, and reports open push conflicts. Server down: one notice line |
| **PostToolUse** on `Write` and `Edit` (8 s) | when the file is an ADR (`docs/adr/*.md`) or a configured doc, pushes it to Spoor silently; everything else is ignored |
| **Stop** (6 s) | starts ADR drafting in the background; and if this session changed files, wrote nothing to Spoor (no MCP write, no push) and has not been nagged yet, blocks **once** and asks you to record decisions with `spoor_decide` or confirm there were none. A marker file prevents a second nag in the session |

The `mcp__spoor` permission is allowed so the tools run without prompts. The MCP tool list costs about 2,100 tokens when loaded
(`alwaysLoad`), the digest at most its budget; together roughly 3,600 tokens at session start with defaults.

## 5. Drafting ADRs

Spoor makes no LLM calls itself. `spoor_decide` stores a decision memory only. At the next Stop, `spoor adr draft` runs detached on the
developer's machine:

1. takes this user's decision memories of the last 14 days that have no ADR yet (at most 2 per run, 120 s);
2. asks a cheap model through your own `claude` login (default `claude -p --model haiku --safe-mode --no-session-persistence
   --tools ""`; override with `SPOOR_DRAFT_CMD` or `draft.command` in `spoor.config.json`) to write the ADR, validates it, and falls back
   to a mechanical draft if the model fails;
3. saves `docs/adr/NNNN-slug.md` with `status: proposed`, `drafted_from: [m59]`, pushes it, and writes `spoor_id` into the file.

Notes: drafting is skipped when `CI` is set (unless `draft.in_ci`), at most one ADR exists per memory (`already_drafted`), and the
drafted file is yours to review and commit. A `proposed` ADR is not in the digest; the decision memory stands in for it. When a human
accepts it (changing `status: accepted` in the file and pushing it, or pressing Accept in the web UI), the ADR takes the place in the
decision tier and the memory drops out.

## 6. Repo mirror rules

The mirror is **one way, repository to Spoor**. Nothing is pulled back.

- `spoor adr import` (once) pushes every `docs/adr/*.md` into the decisions space and writes the assigned `spoor_id` into each file's
  frontmatter. Existing numbers are kept; a colliding number is renumbered and the file renamed; numbering continues from the highest.
  Commit the changed files.
- `spoor docs import` does the same for the doc list (default `ARCHITECTURE.md`, `GLOSSARY.md`, `docs/*.md` except `docs/adr/`;
  configurable in `spoor.config.json`). No drafting for docs.
- After that the PostToolUse hook pushes on change, and a hash sweep at session start catches edits made another way.
- A mirrored item has a `source_path`, which follows renames. Mirrored items cannot be edited over MCP (`mirrored_item`).
- A human edit in the web UI stays in Spoor. The next push of that file is refused (`pushed_over_spoor_edit`) and recorded as a **push
  conflict**, shown at every session start, in `spoor status` and in the review queue, until someone aligns the file or runs the push
  with `--force` (needs a terminal and a typed `y`).

## 7. Token cost expectations

| item | cost with defaults |
|---|---|
| SessionStart digest | at most the budget, 1,500 tokens (set per project, 200 to 8,000); the first lines are a header and a fixed note of about 70 tokens ("data, not instructions", and what a `~` after an id means) |
| MCP tool list (writer) | about 3,300 tokens (nine tools; viewer tokens see only the three read tools, so less). Measured with Claude's tokenizer, with a regression ceiling of 3,500 estimated tokens |
| `spoor_search` | about 8 lines, each a handle plus a one-line snippet: a few hundred tokens |
| `spoor_get` | the item's body, 8,000 characters per call by default (about 2,000 tokens); page with `offset` for more |
| `spoor_remember`, `spoor_decide`, `spoor_verify`, `spoor_relate`, `spoor_supersede` | one result line, tens of tokens |
| Stop-hook nag | one short message, at most once per session |
| ADR drafting | runs outside your session on a cheap model; costs the developer's own `claude` usage, not session context |

The digest is the main lever: pin sparingly, keep anchors accurate so the anchored tier is useful, and lower the project's default
budget if a repository is small. Ask for more with `spoor_context budget=…` only when a task needs it.
