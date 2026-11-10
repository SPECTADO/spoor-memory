---
adr: 28
title: Dedupe defaults follow the project's active embedding model (0.75 and 0.50 for embeddinggemma); wider setting ranges
status: proposed
date: 2026-11-10
deciders: [ladislav.soukup@gmail.com]
tags: [settings, dedupe, embeddings, ollama, calibration]
anchors: [packages/shared/src/settings.ts, packages/server/src/modules/projects/service.ts, packages/server/src/modules/items/service.ts, docs/design/search-and-digest.md]
---
# Dedupe defaults follow the project's active embedding model (0.75 and 0.50 for embeddinggemma); wider setting ranges

- **Deciders:** Ladislav Soukup (owner; "Yes, add defaults" on 2026-11-10, after his benchmark of the `ollama` provider), Claude (the numbers and the mechanism)
- **Refines:** [ADR-0025](0025-near-duplicates-are-saved-with-a-note-only-the-same-text-is-refused.md), [ADR-0023](0023-related-item-floor-lives-at-settings-dedupe-related-min-cos-0-50-0-90-default-0.md), ADR-0026 (the opt-in `ollama` provider)

## Context

`dedupe.threshold` (0.87) and `dedupe.related_min_cos` (0.70) were calibrated for `multilingual-e5-small` q8 and were the defaults of every project. The `ollama` provider (ADR-0026) embeds with `embeddinggemma`, whose cosines sit lower. The owner's benchmark after enabling it (spoor-bench, 10 reworded duplicates written through MCP into the hosted server) showed the consequence: the "similar to" note fired for 0 of 10, and related suggestions thinned out. The range of `dedupe.threshold` started at 0.80, so a project admin could not even set a value that fits the model. ADR-0026 left "no per-model defaults yet" as a known gap and told operators to tune each project by hand.

A separate, larger measurement on 2026-11-10, offline through the real `OllamaProvider` and chunker (256-item spoor-bench corpus, 40 reworded duplicates and 40 different facts on the same topics, title-only probes against title + body items). Its counts are of this sample, not of the owner's 10:

- Every duplicate had its item as nearest neighbour, at 0.65 to 0.94 (median 0.85).
- After the values guard, different facts scored at most 0.65, apart from two whose claim is stated in the matched item's body (0.72 and 0.91).
- The note names the right item for 12 of 40 duplicates at 0.87, 32 at 0.80, 35 at 0.75, 39 at 0.72, 40 at 0.65. It fires for 1 of 40 different facts from 0.72 up, 2 from 0.65, 6 at 0.60.
- Unrelated gold items pair below 0.53 (99th percentile 0.45); `depends_on` pairs score 0.34 to 0.66; same-topic facts 0.42 to 0.91.

## Decision

1. **The two dedupe defaults are a function of the project's active model.** `dedupeDefaults(modelTag)` in `packages/shared/src/settings.ts` looks up `<provider>:<model family>` (parsed from the tag by `embeddingModelKey`) in a table in code. One entry: `ollama:embeddinggemma` gives threshold **0.75** and related floor **0.50**. Every other model takes the existing 0.87 and 0.70.
2. **Resolution, not storage.** `resolveProjectSettings(stored, modelTag)` fills a `dedupe` key that nobody stored from the model's defaults; a stored key always wins. `projects.settings` still holds only what an admin set, and there is no migration. Every reader of `dedupe` passes the tag: `ItemService.projectSettings` (duplicate check, related items, push) and `ProjectService.get` (the API and the settings form show the resolved value).
3. **The key is the active model** (`projects.embedding_model`), not `settings.embedding.provider`: the duplicate check and the related query read the active model's vectors, so during a re-embed the old defaults apply until the cut-over and the new ones from then on.
4. **Wider ranges:** `dedupe.threshold` 0.60 to 0.99 (was 0.80 to 0.99), `dedupe.related_min_cos` 0.40 to 0.90 (was 0.50 to 0.90), for every project.
5. **0.75, not lower.** It leaves 0.10 above the highest different fact that the guard does not catch, and the note carries a `spoor_supersede` hint, so a wrong note costs more than a missed one.

## Consequences

- A project on embeddinggemma gets the similar-item note and a useful related list with no tuning, and a project that switches model gets the right defaults at the cut-over.
- A value a project saved is kept and is not rescaled when the model changes. An admin who had saved 0.87 on e5 and then switches keeps 0.87. The docs tell them to check; nothing in the product warns.
- A new model with another scale needs a row in the table and a calibration run. An unknown model silently takes the e5 defaults, as before.
- The table is keyed by provider and family, so `embeddinggemma` served by another provider, or a quantisation with a different scale, is not covered.
- The wider ranges let an e5 project set a threshold (0.60) at which nearly every write gets a note. The ranges are a guard against typos, not a calibration.
- Evidence is one synthetic corpus and one run, with 60 of the 80 pairs written by Claude for this measurement. e5 was not re-measured on them.

## Alternatives considered

- **Tell operators to tune each project** (the state after ADR-0026): the benchmark showed nobody does, and the range floor made the right value impossible.
- **Store the defaults into `settings` when the provider changes**: turns a default into a stored value that later default changes cannot reach, and needs a rule for values the admin had set.
- **Rescale stored values on a model switch**: there is no sound mapping between two models' cosine scales.
- **A second vector with the `task: sentence similarity` prompt** (AUC 0.95 against 0.83 in the earlier run): doubles embedding work and storage for the duplicate check alone. Kept as the next step if 0.75 proves too coarse.
- **Key by `settings.embedding.provider`**: wrong during a re-embed, and blind to the model behind `ollama`.
- **Threshold 0.72 or 0.65** (39 and 40 of 40 duplicates): 0.65 flags 2 of 40 different facts and sits on top of the highest unguarded one; 0.72 leaves a margin of 0.07 on a sample this small.
