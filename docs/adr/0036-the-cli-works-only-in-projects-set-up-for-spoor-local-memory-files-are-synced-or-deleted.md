---
adr: 36
title: "The CLI works only in projects set up for Spoor (spoor.config.json), never in the home directory; memory files from before Spoor are synced both ways or imported and deleted"
status: accepted
date: 2026-11-16
deciders: [ladislav.soukup@gmail.com]
tags: [cli, hooks, mirror, memory]
anchors: [packages/cli/src/config.ts, packages/cli/src/local-memory.ts, packages/cli/src/cmd/setup.ts, packages/server/src/modules/mirror/service.ts]
---
# The CLI works only in projects set up for Spoor, never in the home directory; memory files from before Spoor are synced both ways or imported and deleted

## Context
Three problems came from the same place, the CLI not knowing where a project ends.

- The repo root was "the nearest ancestor with `.git` or `.claude`". In a directory without either, the walk reached `~/.claude`, which is Claude Code's global configuration, and took the home directory for the repo. A `spoor login` there on 2026-10-22 wrote the three hooks into the user-level `~/.claude/settings.json` and put `AGENTS.md`, `CLAUDE.md`, `.mcp.json` and `.spoor/` into `~`. From then on the hooks ran in every project on the machine, and `~/AGENTS.md` was loaded in projects that have nothing to do with Spoor.
- Nothing told a hook whether the project it ran in uses Spoor. It wrote `.spoor/notice-day`, session markers and `last-run.log` into any directory.
- A repo that gets Spoor later keeps the memory files of the tools it used before (`.memory/PROJECT_MEMORY.md`, `MEMORY.md`, a Cline memory bank). With exclusive memory (ADR-0015) agents stop reading them, so they rot next to the real memory and nobody decides what to do with them.

## Decision
Decided by Ladislav Soukup on 2026-11-16.

1. **The root is never the home directory.** The walk for `.git` / `.claude` stops below `~`; with no marker on the way the root is the working directory. `spoor login` and `spoor init` refuse to run when the root is the home directory, also when `CLAUDE_PROJECT_DIR` names it.
2. **A project is set up for Spoor when its root holds `spoor.config.json`.** `spoor init` creates it with `server` and `project`, and it is committed. A repo set up by an older CLI still counts through a `.mcp.json` with a `spoor` server. Anywhere else hooks exit 0 with no output, no request and no file, and every command except `login` and `init` exits 1. `AGENTS.md` and `CLAUDE.md` are only ever the ones in that root.
3. **Memory files from before Spoor: the team answers once, `spoor init` asks.** Files matching `local_memory.paths` (default `MEMORY.md`, `.memory/**`, `memory-bank/**`, `.claude/memory/**`, `.cursor/memory/**`, Markdown only) are found by `spoor init`. On a terminal it asks; `--local-memory sync|delete` answers without a prompt; the answer is stored in the committed `spoor.config.json` as `local_memory.mode`. Until someone answers, the SessionStart digest tells the agent, at most once a day, to ask the user.
   - `sync`: the files stay and are synced **both ways** with items of the docs space, keyed by path. File to Spoor is the existing mirror. Spoor to file is new: `GET /p/:slug/api/pull?source_path=…` returns the item's revision and body, and a file that is unchanged since its last push takes a newer body (its frontmatter block stays). A file changed on both sides is never overwritten; it becomes a push conflict that a human resolves with `spoor memory sync --take-server` or `--take-local`.
   - `delete`: each file is pushed to the docs space and deleted only after the server answered that it holds the text. Nothing is deleted when the server is unreachable, refuses the file, or nobody is logged in. A hook never deletes.

## Consequences
- Existing repos keep working through `.mcp.json`; the next `spoor init` adds `spoor.config.json`, which should be committed.
- A machine where the home directory was set up by mistake needs a one-time cleanup of `~` (CHANGELOG, Fixed). The fixed CLI ignores those leftovers, but the user-level hooks keep starting it until they are removed.
- ADR-0009 (the repo mirror is push-only) still holds for ADRs and docs. Local memory files in `sync` mode are the one exception, and only for the body text of a file with no local change.
- `spoor.config.json` gets a new key. A CLI older than this change rejects the file as having an unknown key and falls back to defaults in hooks, so the CLI has to be updated on every machine before a team chooses.
- After `delete`, the imported docs keep their `source_path`, so the web UI still shows them as mirrored from a file that no longer exists. Editing them there works, with the usual `mirrored_item` warning.
- An opted-out teammate (no login) is still told once a day that the repo uses Spoor; that notice now needs the marker, so it no longer appears in unrelated projects.
- Follow-up, the agent's choices awaiting owner review: `spoor.config.json` (not a new dot file) as the marker, the default path list, and docs (not memories) as the space the files go to.

## Alternatives considered
- A marker inside `.spoor/`. Rejected because `.spoor/` is gitignored local state: a teammate's fresh clone would look like a project without Spoor.
- Only the `.mcp.json` entry as the marker. Rejected as the long-term answer because it is another tool's file and carries no project settings; it stays as the fallback for older installs.
- Push-only sync for local memory files, in line with ADR-0009. The owner chose two-way sync: these files are edited by people and by tools that do not know Spoor, and edits made in the web UI should reach them.
- Delete without importing. Rejected by the owner: the content would survive only in git history.
- Splitting a memory file into individual memories on import. Rejected because it needs a model call and judgment; the file goes in whole as a doc, and people can promote parts of it later.
