# spoor-memory (CLI and Claude Code hooks)

The `spoor` command: device login, repo setup, the ADR/doc mirror, client-side ADR drafting and the three
Claude Code hooks. Behaviour is specified in [`docs/design/cli-and-hooks.md`](../../docs/design/cli-and-hooks.md)
(implementation notes in its section 11); the reasons are in ADRs 0006, 0008, 0009 and 0010.

## Quick start (one repository)

Your Spoor admin gives you the server URL and the project slug; the project's install doc
`<server>/p/<slug>/install.md` has the same steps with the values filled in.

```sh
npm i -g spoor-memory@<server version>        # Node 22 or later; global: the hooks look for spoor on the PATH
cd <your repo>                                # every command runs from the repo root
spoor login --server https://spoor.example.com --project acme --no-browser
```

`spoor login` prints a URL and an 8-letter code. Open the URL, log in, type the code and press **Approve** (or
**Approve read-only** for an agent that should only read). The command then:

1. writes `SPOOR_URL`, `SPOOR_PROJECT` and the token `SPOOR_TOKEN` into `.claude/settings.local.json` (mode 0600, other
   keys kept) and refuses to run if that file or `.spoor/` is tracked by git (`--untrack` runs `git rm --cached` for you);
2. adds `.claude/settings.local.json` and `.spoor/` to `.gitignore`;
3. runs `spoor init`: merges the project's `.mcp.json` (the MCP server `spoor`, token only as `${SPOOR_TOKEN}`) and
   `.claude/settings.json` (the three hooks and the `mcp__spoor` permission). It renders these blocks itself from
   `SPOOR_URL`, the slug and the server version of `<server>/p/<slug>/install.json`; nothing else from the server ends up
   in a committed file. Init also writes a managed Spoor block to `AGENTS.md`, adds an `@AGENTS.md` import to `CLAUDE.md` and,
   when the project's memory is exclusive (the default, ADR-0015), sets `autoMemoryEnabled: false` in an untracked
   `.claude/settings.local.json`, so Claude Code auto-memory is off for that user.

**Keeping the CLI up to date.** A global install does not update itself. When the server is upgraded, the next session's
digest starts with a line that names the new version: run `npm i -g spoor-memory@<server version>`, then `spoor init` in
each repo (it moves the version the SessionStart hook pins; commit the changed `.claude/settings.json`). `spoor --version`
shows what is installed.

Before the first npm release (a server at version `0.0.0`) build the CLI from a source checkout instead:
`pnpm install && pnpm --filter "spoor-memory..." build && npm i -g ./packages/cli`.

Device tokens expire after 90 days; `spoor login` prints the date and `spoor status` shows it. Without a browser on the
machine, create a token in the web UI (Project → Tokens) and run
`printf '%s' "<token>" | spoor login --token - --server … --project …`.

Then restart Claude Code (or run `/mcp`), approve the `spoor` MCP server, and import what the repo already has:

```sh
spoor adr import      # docs/adr/*.md → decisions; writes spoor_id into each file (commit that)
spoor docs import     # ARCHITECTURE.md, GLOSSARY.md, docs/*.md (minus docs/adr/) → docs
spoor status --remote # project, role, token expiry (asks the server), push conflicts, queued pushes
spoor context --git   # the digest an agent gets at session start
```

Commit `.mcp.json`, `.claude/settings.json`, the ADR files and `spoor.config.json` (if you made one). Never commit
`.claude/settings.local.json` or `.spoor/`. A teammate on an already set-up repo only installs the CLI and runs
`spoor login`.

### What happens while you work (Claude Code)

- **Session start**: the digest of the project memory (pinned items, accepted decisions of the last 30 days, items
  anchored to the files you are changing, recently verified items) is added to the context. Queued pushes are replayed.
- **Write/Edit of an ADR or a mirrored doc**: the file is pushed to Spoor at once. If someone edited that item in the
  web UI since your last push, the push is refused and the agent is told; resolve it by hand (`spoor adr push --force`
  needs a terminal and a typed `y`).
- **Turn end (Stop)**: decisions the agent recorded with `spoor_decide` are drafted into `docs/adr/NNNN-slug.md` as
  `status: proposed` by a cheap model on your machine (`claude -p --model haiku …`, in the background) and pushed. Accept
  a draft by changing `status:` to `accepted` in the file; until then the digest shows the decision memory instead.
  If the session changed files but recorded nothing in Spoor, the agent is asked once per session to record decisions
  or say there were none.
- **Server down or token rejected**: one notice line at session start; hooks never block and always exit 0. After a
  network failure the hooks skip the network for 5 minutes.

### Environment and configuration

| variable | effect |
|---|---|
| `SPOOR_URL`, `SPOOR_PROJECT`, `SPOOR_TOKEN` | override `.claude/settings.local.json` (flags `--server`, `--project`, `--token` override both) |
| `SPOOR_DRAFT_CMD` (or `SPOOR_DRAFT_COMMAND`) | shell command that drafts an ADR: gets the instruction as its last argument and the note on stdin, prints Markdown (or `claude --output-format json`) |
| `SPOOR_DISABLE=1` | every hook and `adr draft` do nothing |
| `SPOOR_DRAFTING=1` | set by the CLI for the drafting child, so its own hooks do nothing |
| `CI` | drafting is skipped unless `spoor.config.json` sets `draft.in_ci: true` |

`spoor.config.json` (committed, optional, every key optional): `server`, `project` (never the token), `adr_dir`
(default `docs/adr`), `docs.{include, exclude, write_back}`, `draft.{enabled, command, timeout_s, max_per_run, deadline_s,
in_ci}`, `context.{max_tokens, max_files}`. Details: [cli-and-hooks.md](../../docs/design/cli-and-hooks.md) §2.

## Commands

| command | mode | what it does |
|---|---|---|
| `spoor login [--server URL] [--project SLUG] [--token T\|-] [--no-browser] [--no-init] [--untrack]` | human | device flow (or a pasted token), writes `env.SPOOR_URL/PROJECT/TOKEN` into `.claude/settings.local.json` (0600, other keys kept), adds `.gitignore` lines, runs `init` |
| `spoor init [--dry-run]` | human | reads the server version from `/p/<slug>/install.json`, merges `.mcp.json`, `.claude/settings.json` (hooks, `mcp__spoor`) and `.gitignore`, writes the `AGENTS.md` block and `CLAUDE.md` import and sets `autoMemoryEnabled` in `.claude/settings.local.json` (ADR-0015), with blocks it renders itself (`@spoor/shared` install.ts); idempotent |
| `spoor whoami [--json]`, `spoor status [--remote]` | human | identity; local config, push conflicts, queue, orphans, breaker |
| `spoor context [--query T] [--files a,b \| --git] [--budget N] [--no-shared] [--json]` | agent | prints the digest |
| `spoor adr import [--dir D] [--dry-run]`, `spoor docs import [--dry-run]` | human | one-time push of existing files |
| `spoor adr push <file> [--force]`, `spoor docs push <file>` | agent | push one file (`--force` needs a TTY and a typed `y`) |
| `spoor adr draft [--since ISO] [--max N] [--dry-run] [--session ID]` | agent | drafts proposed ADRs from undrafted decision memories |
| `spoor hook session-start\|stop\|post-tool-use` | hook | always exit 0 within 7 / 6 / 8 s |

Exit codes (human mode): 0 ok, 1 usage or config, 2 conflict or partial failure, 3 server unreachable or token rejected.
Agent-facing commands print one notice on stderr and exit 0 for server down / token rejected / not configured
(`--strict` restores the human codes). Hooks exit 0 always; `SPOOR_DISABLE=1` or `SPOOR_DRAFTING=1` makes them no-ops.

## Layout

```
src/
  bin.ts              entry: hard exit 0 after a hook's deadline, explicit exit
  cli.ts              argument parsing and dispatch; hook runner (deadline race, runHook)
  commands.ts         command table and help text
  runtime.ts          Io seam (stdout, stderr, env, cwd, stdin, clock, spawn, browser) and Deadline; strips terminal
                      control characters from everything printed
  ctx.ts              per-run context: config (config.ts), spoor.config.json (repo-config.ts), HTTP client, notices
  config.ts           SPOOR_URL / SPOOR_PROJECT / SPOOR_TOKEN resolution and token origin binding
  http.ts             fetch client with User-Agent and the 5-minute circuit breaker
  hook-guard.ts       runHook: SPOOR_DRAFTING / SPOOR_DISABLE guard, exceptions swallowed
  state.ts            .spoor/state.json (bases, drafted, pending, conflicts) under .spoor/state.lock
  mirror.ts           mirrored-file lists, push + result handling, import batches, queue replay, sweep, orphans
  safety.ts           checks on server answers before they touch files (uuid spoor_id, paths inside the repo, ADR numbers)
  writeback.ts        spoor_id / adr: frontmatter edits that keep the file byte-identical otherwise
  settings-files.ts   pure merges of .mcp.json, settings.json, settings.local.json, .gitignore; dry-run diff
  git.ts              git calls with timeouts (anchors, changed files, tracked-file guard); paths relative to the repo root
  fsutil.ts           atomic writes, pid lock files, last-run.log, once-a-day notices
  cmd/                setup.ts (login, init), info.ts (whoami, status, context), mirror.ts (import, push),
                      draft.ts (adr draft), session.ts (the three hooks)
  testing/harness.ts  fake HTTP server, temp repos and an in-memory Io for the tests (not built)
scripts/
  build.mjs           esbuild bundle → dist/bin.js (--watch for dev)
  pack-smoke.mjs      packed-tarball check (test:pack)
```

Local files live in `<repo>/.spoor/` (gitignored by `spoor login`): `state.json`, `session/<id>.json|.nagged`,
`offline-until`, `draft.lock`, `notice-day`, `last-run.log`.

## Development

```
pnpm --filter spoor-memory test       # vitest: every command and hook against a fake HTTP server
pnpm --filter spoor-memory typecheck
pnpm --filter "spoor-memory..." build      # tsc --noEmit, then esbuild: one file, dist/bin.js, @spoor/shared bundled in
pnpm --filter spoor-memory test:pack  # pack as published; only dist/bin.js, README.md, LICENSE, package.json; run its bin --help
```

Packaging (ADR 0013): `scripts/build.mjs` bundles `src/bin.ts` with `@spoor/shared` compiled in from `packages/shared/src`;
the `dependencies` (`yaml`, `zod`, exact pins) stay external and are the only runtime imports besides `node:*`. `@spoor/shared`
is a devDependency (types and tests). `VERSION` comes from this `package.json`. `LICENSE` is a copy of the repo's (the smoke test
checks they are equal). `scripts/pack-smoke.mjs --install` installs the tarball with npm instead of linking the dependencies; the
release workflow runs it and publishes that tarball (docs/operations.md §10).

Tests never need the Postgres test database: each one starts a local fake server (`src/testing/harness.ts`) and a temp
repo (with `git init` where git matters). Drafting tests point `SPOOR_DRAFT_CMD` at a generated shell script.

The built CLI is also driven end to end against the real server by `packages/server/test/e2e/harness.e2e.test.ts`
(`pnpm build`, then `pnpm --filter @spoor/server test:e2e`; needs the server's test database).
