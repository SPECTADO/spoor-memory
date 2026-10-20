---
spoor_id: b5a8408b-f8ee-49b2-8539-b282e8ad5d7f
adr: 16
title: Keep the global CLI install; the SessionStart digest warns when the CLI version differs from the server's
status: proposed
date: 2026-10-20
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m21]
tags: [cli, release, hooks]
anchors: [packages/cli/src/cmd/session.ts, packages/server/src/modules/search/routes.ts, docs/design/cli-and-hooks.md]
---
# Keep the global CLI install; the SessionStart digest warns when the CLI version differs from the server's

## Context
A global npm install of the CLI never updates itself, so after a server upgrade a teammate's CLI drifts out of step with the server. Hook latency is the main constraint: a cached `npx` run measured about 0.65 s against about 0.1 s for a global binary, which would add roughly 0.5 s to every Write/Edit (PostToolUse). This refines ADR-0013.

## Decision
We will keep the global CLI install. The context request sends the server's version, and when it differs from the CLI's release version, the SessionStart digest prints one line asking the user to install the matching global version and then run `spoor init`.

## Consequences
- The hooks keep the fast global binary, so per-edit latency is unchanged.
- Trade-off: Each machine must be upgraded by hand, and teammates see a warning rather than an automatic update.
- The warning stays silent for servers that do not send the version header and for 0.0.0 source builds.
- `spoor init` also moves the `npx` fallback pin to the new version.

## Alternatives considered
- Pin all three hooks to `npx` at the server's version with no global install. This gives one-commit team upgrades, but adds about 0.5 s to every Write/Edit (PostToolUse).
