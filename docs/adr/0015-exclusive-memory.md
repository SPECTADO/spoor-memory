---
spoor_id: 0c68c0bb-4172-49a0-8dd6-5d4b9d9056ed
---
# ADR-0015: Spoor is the agents' only memory by default

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** Ladislav Soukup (owner), Claude (Opus 5.5)
- **Tags:** agents, cli, mcp, settings

## Context

Agents in a Spoor repo often have other memory too: Claude Code auto-memory (`MEMORY.md` under `~/.claude/projects/`),
other memory MCP servers, or memory notes kept in repo files. Then the team's knowledge splits. Facts land wherever
the agent happened to write them, teammates never see them, and the digest misses them.

Spoor told agents how to use Spoor, but never that it replaces the rest. The `AGENTS.md` lines for clients without
hooks lived only as text in install.md, so nothing put them into a repo or checked that they were still there.

Sources: BRIEF.md "Amendment (2026-10-20): Exclusive memory"; `cli-and-hooks.md` §4.9 and §5.1; `mcp.md`;
`api.md` §11.1a.

## Decision

By default, Spoor is the only memory an agent uses in a Spoor project. Every channel that reaches the agent says so,
and `spoor init` writes it into the repo.

**One switch.** The project setting `memory.exclusive` defaults to true. Project admins change it in the web UI under
Settings → Memory. The setting lives on the server, not in `spoor.config.json`, because the MCP instructions come
from the server, and clients without hooks never see the repo config.

**One rule text.** `MEMORY_RULE` in `@spoor/shared`: "Spoor replaces every other memory: unless the user asks, do not
read or write other memory stores (Claude Code auto-memory or MEMORY.md, other memory MCP servers, memory notes in
files)." It goes to the agent through four channels:
- **MCP instructions.** When the setting is on, the rule is the second sentence, for writers and read-only sessions
  alike. The setting is read when a session starts.
- **AGENTS.md.** `spoor init` writes a managed block between `<!-- spoor:begin … -->` and `<!-- spoor:end -->`.
  The block holds the rule (exclusive projects only) and the four Spoor usage lines, under "When the `spoor` MCP
  tools are available". That condition keeps it harmless for teammates who never logged in. A second run replaces
  the block in place and never touches text outside the markers.
- **CLAUDE.md.** `spoor init` adds an `@AGENTS.md` import line, so Claude Code loads the block even when the repo
  has its own CLAUDE.md. A CLAUDE.md that is a symlink to AGENTS.md needs no import.
- **SessionStart.** The bearer context endpoint sends `Spoor-Memory-Mode: exclusive|shared`. When the digest loads,
  the hook checks that AGENTS.md holds the current block for that mode and that CLAUDE.md imports it. If not, it
  tells the agent to ask the user for `spoor init`. In an exclusive project it also adds the rule for that session.
  The hook never edits committed files.

**Auto-memory off for logged-in users.** When the project is exclusive, `spoor init` sets `autoMemoryEnabled: false`
(a Claude Code setting) in `.claude/settings.local.json`. It does so only if that per-user, gitignored file exists
and is untracked, which in practice means after `spoor login`. Teammates who never logged in keep their auto-memory.
Turning the setting off later does not remove the key, because the CLI cannot tell whether the user set it
themselves. Init prints a hint instead.

**The server picks, the CLI writes.** Init takes one boolean from install.json, `memory_exclusive`, and only an
explicit `false` turns the rule off. The block text is the CLI's own. The server still cannot put content of its own
into committed files (review-log-phase5 S4).

## Consequences

- Claude Code users get the strongest form: auto-memory is switched off by a setting, not just by instruction.
  Agents in other clients and other memory MCP servers get instructions, which a model may still ignore.
- With the rule, writer INSTRUCTIONS grow from 291 to 376 estimated tokens. They are always loaded (ADR-0010), so
  every exclusive-project session pays this once. The tools/list is unchanged (3,440 estimated).
- `spoor init` now writes two more committed files, AGENTS.md and CLAUDE.md. A team needs to commit them once.
  Editing text inside the markers makes the SessionStart check report the block as out of date, so edits go outside
  the markers.
- Older servers send no header and no `memory_exclusive`. The new CLI treats them as exclusive, which is the default.
- Repos that keep their own memory files (this repo's `.memory/PROJECT_MEMORY.md`) should move that content into
  Spoor, or turn the setting off.

## Alternatives considered

- **Repo-level `exclusive_memory` in `spoor.config.json`**: only the CLI paths would see it. MCP instructions would
  have to hedge ("unless AGENTS.md says otherwise"), and clients without hooks would get mixed signals.
- **No opt-out**: it is the smallest change, but a team that deliberately keeps a second memory would have to edit
  around the managed block forever.
- **Hook repairs AGENTS.md itself**: it is fully automatic, but a hook would change tracked files without anyone
  asking. The notice plus the per-session rule gives the same protection.
- **Write `autoMemoryEnabled: false` into the committed `.claude/settings.json`**: it would also switch off memory
  for teammates who never logged in, leaving them with none.
- **AGENTS.md only, or CLAUDE.md only**: Claude Code reads AGENTS.md only when there is no CLAUDE.md, and other
  clients read only AGENTS.md. The block plus the import covers both.
