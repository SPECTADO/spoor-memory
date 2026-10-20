---
spoor_id: c56c51df-ceb5-4271-af79-5a979f8379a5
---
# ADR-0008: ADR drafting happens client-side

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1, architect)
- **Tags:** cli, adr, llm

## Context

Recorded decisions should become ADR files in the repo, but the server must not hold LLM credentials or make model calls. Source: `docs/design/cli-and-hooks.md`, `mcp.md`; settles D2, I29, I34, X1, X6, X7, I26.

## Decision

We will draft ADRs on the developer's machine through a configurable command, default `claude -p --model haiku --safe-mode --no-session-persistence --tools ""` with `SPOOR_DRAFTING=1` set in the child environment; every Spoor hook exits early when it is set (D2, recursion guard; `--bare` is unusable with subscription logins). The Stop hook spawns drafting detached behind `.spoor/draft.lock` (at most 2 ADRs per run, 120 s). Drafts are pushed as `status: proposed` (I34), one ADR per decision memory (`already_drafted`), validated with a fallback template; title, H1 and file name always use the memory's title. Drafting is skipped when `CI` is set. The number is `max(local files + 1, whoami.next_adr_number)`; the server renumbers collisions and the CLI renames only the numeric prefix (X6, X7, I29). The server never calls an LLM.

## Consequences

No server-side secrets or cost; works with the user's own Claude login. Quality depends on the local model and CLI flags that must be rechecked per Claude Code release (`--safe-mode`, stdin plus argument behaviour are unverified). Drafts need human acceptance before entering the digest.

## Alternatives considered

- **Server-side drafting** - needs an API key and sends content to a vendor.
- **The brief's `claude --model haiku -p`** - re-fires project hooks in the child (D2).
- **Auto-accepted drafts** - unreviewed text becomes authoritative (I34).
- **Synchronous drafting in the hook** - blocks the agent.
