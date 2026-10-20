---
spoor_id: 88e46d59-ba86-4df4-8c91-5fe3c311bfbd
---
# ADR-0003: Local multilingual embeddings with a re-embed job

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1, architect)
- **Tags:** search, embeddings

## Context

Teams write Czech and English, search must work offline-capable and without sending text to third parties by default, and the provider must be swappable per project. Source: `docs/design/search-and-digest.md`, `data-model.md`, `docs/research/embeddings-node.md`; settles D1, D4, D6, I19, I36.

## Decision

We will embed locally with `Xenova/multilingual-e5-small` at `dtype: 'q8'` (118 MB versus 470 MB fp32) via `@huggingface/transformers`, baked into the image at a pinned revision under `SPOOR_MODEL_DIR` and loaded offline (D4, glibc base). The model tag includes dtype and dims (`local:Xenova/multilingual-e5-small@q8/384`) because q8 and fp32 vectors are not interchangeable. `chunks.embedding` is an untyped `vector` with a `dims` column; each model tag has its own partial expression HNSW index `(embedding::vector(N)) ... WHERE model='<tag>'`, created by migration for the default and by the re-embed job for others (D1). Providers are pluggable (remote keys only in env, I22). Re-embedding is atomic: writers take `FOR SHARE` on the project row, the cut-over takes `FOR UPDATE`, so no chunk commits for a replaced model. Search is hybrid: FTS `simple` + `unaccent` with prefix queries (I19) fused with vectors by RRF, k=60. During a default-model upgrade the image holds only the new model, so affected projects search full text only and skip dedupe until cut-over (I36). Near-duplicates return the existing item above `dedupe.threshold` (default 0.92) unless `allow_duplicate: true` (D6).

## Consequences

Flexible providers and no vendor dependency by default; 1.5 GB app memory. Vector SQL must inline the cast; the re-embed job runs index DDL. q8 recall and the 0.92 threshold are unverified and must be calibrated in phase 2/5. Image build needs a network fetch from Hugging Face.

## Alternatives considered

- **`vector(384)` fixed column** - blocks 768/1024/1536-dim providers without a column migration (D1).
- **fp32 weights** - 3.4x slower, 4x larger (D4).
- **Shipping the previous model for one release** - rejected for image size (I36).
- **Remote-only embeddings** - privacy and offline cost.
- **Czech stemmer in FTS** - none exists in Postgres; vectors cover inflection.
