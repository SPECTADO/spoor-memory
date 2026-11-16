---
adr: 37
title: "Prompt recall: an opt-in UserPromptSubmit hook shows the items above a per-model cosine floor"
status: proposed
date: 2026-11-16
deciders: [ladislav.soukup@gmail.com]
tags: [cli, hooks, search, embeddings]
anchors: [packages/cli/src/cmd/session.ts, packages/server/src/modules/search/recall.ts, packages/shared/src/settings.ts]
---
# Prompt recall: an opt-in UserPromptSubmit hook shows the items above a per-model cosine floor

## Context
Agents reach Spoor two ways: the SessionStart digest, which is built from the files being changed, and the MCP tools, which work only when the agent decides to search. A prompt about something the digest did not bring up gets no memory unless the agent calls `spoor_search`, and agents often do not. The owner asked on 2026-11-16 whether a RAG integration makes sense next to MCP and the instructions, and then asked for the UserPromptSubmit hook to be integrated in 0.7.5.

The server already retrieves (full text and vectors, fused by rank). What was missing is retrieval per prompt, and a way to keep it from adding noise: the fused score has no absolute meaning, and the full-text branch ORs every word of a long prompt, so it matches something for any prompt.

## Decision
1. **An opt-in hook, not a separate pipeline.** `spoor init --recall on` sets `recall.enabled` in `spoor.config.json` and installs a UserPromptSubmit hook; `--recall off` removes both. Off by default: it costs a process and a request on every prompt.
2. **A cosine floor per embedding model decides what is shown.** New bearer endpoint `GET /p/:slug/api/recall` runs the hybrid search over digest-eligible items and keeps only hits whose best chunk cosine to the prompt reaches the model's floor: 0.86 for `local` multilingual-e5-small, 0.45 for `ollama` embeddinggemma. A model without a measured floor shows nothing unless the project sets `recall.min_cos`. At most 3 items (5 at most by setting), about 400 tokens, as digest lines under one header.
3. **Nothing is shown twice.** The CLI keeps the handles of the session's digest and of earlier recalls in `.spoor/session/<id>.shown` and sends them as `exclude`.
4. **It cannot hurt the session.** Short prompts, commands and shell escapes are skipped. Every failure is silent, the deadline is 3 s, and the hook never trips the circuit breaker.

## How the floors were measured
On 2026-11-16, embedding only, spoor-bench `corpus.json` (256 items, 110 queries with a known item) plus 25 everyday coding prompts that have nothing to do with the corpus ("rename this variable", "ano, pokračuj", "bump the version"). Item text was title and body with each model's passage prompt, queries with its query prompt.

| model | best item for an unrelated prompt | floor | known item still shown | unrelated prompts with a hit |
|---|---|---|---|---|
| e5-small q8 | median 0.833, max 0.849 | 0.86 | 59 of 110 | 0 of 25 |
| embeddinggemma (Ollama) | median 0.32, max 0.42 | 0.45 | 62 of 110 | 0 of 25 |

The floors favour silence over recall. Exact-wording queries pass almost always (e5 minimum 0.864, gemma 0.53); paraphrases mostly do not (e5 median 0.827, gemma 0.38).

## Consequences
- Most prompts add nothing to the context; a prompt that names a topic in the memory's own words gets up to three lines.
- Recall of paraphrased prompts is low by design. The agent's own `spoor_search` remains the way to find those.
- The corpus is synthetic and small, and the unrelated prompts were written for this measurement. The floors should be rechecked on real projects; `recall.min_cos` lets a project tune without a release.
- A server older than 0.7.5 answers 404 and the hook stays silent.
- `spoor.config.json` gets the key `recall`; a CLI older than 0.7.5 rejects the file as having an unknown key.
- Follow-up, the agent's choices awaiting owner review: the floors, the skip rules for short prompts, three items by default, and that the hook is off by default.

## Alternatives considered
- A fused-score threshold. Rejected: reciprocal-rank scores depend only on rank, so the best hit of an unrelated prompt scores like the best hit of a good one.
- Requiring a full-text match as well. Rejected: the full-text query ORs every word, so any long prompt matches.
- One floor for every model. Rejected: e5-small's cosines sit between 0.75 and 0.94, embeddinggemma's between 0.2 and 0.8.
- Sending the prompt to `GET context?query=`. Rejected: that answer is a whole digest with its fixed tiers, not a few matching items.
- On by default. Rejected for now because of the per-prompt cost and the unverified floors.
