---
spoor_id: d000e77f-77bf-4e02-b85b-dc1563cfa71e
adr: 26
title: Opt-in `ollama` embedding provider (embeddinggemma by default); `local` e5-small stays the default; dedupe thresholds are tuned per project
status: proposed
date: 2026-11-10
deciders: [Ladislav Soukup]
drafted_from: [m45]
tags: [embeddings, search, ollama]
anchors: [packages/server/src/modules/search/providers/ollama.ts, packages/server/src/modules/search/providers/registry.ts, packages/server/src/config.ts]
---
# Opt-in `ollama` embedding provider (embeddinggemma by default); `local` e5-small stays the default; dedupe thresholds are tuned per project

- **Deciders:** Ladislav Soukup (owner)
- **Refined by:** [ADR-0028](0028-dedupe-defaults-follow-the-active-embedding-model.md) (dedupe defaults now follow the active model, so the manual tuning below is no longer needed)

## Context
Vector-only benchmarks on the spoor-bench corpus (256 items) showed embeddinggemma clearly outperforming the current e5-small model on paraphrase and Czech queries, while body search was roughly equal. Running it requires a second service, CPU-only speed is unmeasured, and Docker on macOS has no GPU, so it was not made the default. Baking the model into the image was rejected as too large (300 MB+) and slower on CPU.

## Decision
We will add a fourth embedding provider, `ollama`, enabled only when `SPOOR_OLLAMA_URL` is set. It defaults to the `embeddinggemma` model with 768 dimensions and applies each model family's query and document prompts itself. The instance default remains `local`.

## Consequences
- Trade-off: `dedupe.threshold` (0.87) and `dedupe.related_min_cos` (0.70) are calibrated for e5; embeddinggemma scores reworded duplicates lower (0.57 to 0.83), so projects that switch should lower both thresholds, since at the defaults the similar-item note almost never fires. Superseded in practice by [ADR-0028](0028-dedupe-defaults-follow-the-active-embedding-model.md): `ollama:embeddinggemma` projects now default to 0.75 and 0.50.
- Trade-off: item text is sent to the Ollama host, and an Ollama outage leaves embeddings pending, so search falls back to full-text only.
- Trade-off (at the time of this decision): there were no per-model threshold defaults, so switching providers was a manual tuning step. [ADR-0028](0028-dedupe-defaults-follow-the-active-embedding-model.md) added them.
- Easier: projects can opt into better paraphrase and Czech retrieval without changing the default install.

## Alternatives considered
- Make embeddinggemma the default provider.
- Bundle the model into the image via transformers.js.
- Use nomic-embed-text v1.5 as the default (English only).
- Make prompts environment-configurable (prompts are kept in a code table instead).
- Truncate embeddings to 512 or 256 dimensions (paraphrase MRR drops to 0.62 at 512).
