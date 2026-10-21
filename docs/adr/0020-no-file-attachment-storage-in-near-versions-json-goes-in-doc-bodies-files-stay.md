---
spoor_id: 8d2d262c-c941-477c-8f17-84ca7178df00
adr: 20
title: "No file/attachment storage in near versions: JSON goes in doc bodies, files stay in the repo with anchors"
status: accepted
date: 2026-10-21
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m29]
tags: [scope, attachments, data]
---
# No file/attachment storage in near versions: JSON goes in doc bodies, files stay in the repo with anchors

## Context
Text formats such as JSON, YAML and small configs already fit in item bodies (memory body 4,000 characters, doc body 200,000) and stay searchable. Project files belong in git, and items point to them with path anchors. Binary attachments are hard to justify: uploading through MCP tool arguments would force the model to emit base64 as output tokens (about 270,000 characters for a 200 KB image), images are not searchable without a required caption, and screenshots risk exposing secrets or personal data.

## Decision
We will not add file or attachment storage in the near versions. Text stays in document bodies, and project files stay in the repository and are referenced by path anchors.

## Consequences
- Trade-off: users who need images or binaries alongside items must keep them in git or outside Spoor.
- Storage stays text-only, so search, the digest and the data model remain simple.
- Trade-off: no inline screenshots or design references until attachments are revisited.
- Follow-up: if revisited, use item-bound attachments with a type allow-list and a required caption, written through the CLI or web upload rather than MCP.
- Follow-up: store size-capped, sha256-addressed bytea in Postgres, purged with the item. Revisit when shared design references, incident screenshots or human pastes in the web UI become needed.
