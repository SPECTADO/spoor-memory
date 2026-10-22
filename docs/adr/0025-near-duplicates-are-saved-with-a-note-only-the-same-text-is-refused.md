---
spoor_id: 5c87aeb8-2ad2-4c84-b00a-ee0206b93ea7
adr: 25
title: Near-duplicates are saved with a note; only the same text is refused, differing values never count, default threshold 0.87
status: proposed
date: 2026-10-22
deciders: [ladislav.soukup@gmail.com]
tags: [dedupe, mcp, search]
anchors: [packages/server/src/modules/search/values.ts, packages/server/src/modules/items/service.ts, packages/shared/src/settings.ts]
---
# Near-duplicates are saved with a note; only the same text is refused, differing values never count, default threshold 0.87

- **Deciders:** Ladislav Soukup (owner, approved the approach on 2026-10-22), Claude (Opus 5.5)
- **Supersedes in part:** [ADR-0003](0003-local-multilingual-embeddings.md) (the sentence "Near-duplicates return the existing
  item above `dedupe.threshold` (default 0.92) unless `allow_duplicate: true`", deviation D6)

## Context

The MCP write tools refused every create whose chunk 0 had a cosine of at least `dedupe.threshold` (0.92) to an existing item,
answering a non-error `DUPLICATE` and saving nothing. An external benchmark (spoor-bench, 2026-10-22, 10 reworded duplicates and
10 different facts on the same topics) found it refused 3 of 10 different facts and caught 1 of 10 reworded duplicates. An agent
that does not read the `DUPLICATE` reply and retry with `allow_duplicate` loses the fact.

Replaying the pairs with the shipped model (`multilingual-e5-small` q8, `passage:` on both sides):

- reworded duplicates scored 0.878 to 0.957 against their originals; five missed 0.92 by 0.005 or less;
- different facts scored up to 0.957; every wrongly refused one differs from its match in a value: `60` vs `600` requests per
  minute, `1000m`/`4 GiB` vs `250m`/`1 GiB`, `8 hours` vs `14 days`;
- `query:` on both sides (e5's advice for symmetric tasks) did not separate the classes better.

e5 puts most text in a narrow cosine band and barely sees numbers or identifiers, so one cut-off cannot separate the two
classes. The errors also cost differently: a missed duplicate is clutter that cleanup and review handle; a refused fact is lost.

## Decision

1. **Only the same text is refused.** MCP creates refuse a candidate whose title and body equal the new ones, ignoring case and
   runs of whitespace (`sameText`, computed in the dedupe SQL). The reply stays the non-error `DUPLICATE …` block.
2. **Anything else at or above the threshold is saved and reported.** The create succeeds and the reply carries one line,
   `note: similar to m53 r1 cos=0.94 [fact] "…" · same claim → spoor_supersede old="m53" new_id="m65" · different → nothing to do`
   (docs: merge into the existing doc and ask an editor to archive the new one). That item is left out of the `related:` line.
   The request log records `similar` and `similar_values_differ`.
3. **Differing values are never a duplicate.** Numbers, identifiers (`a_b`, `a.b`, `a/b`, `a:b`, camelCase), code spans and quoted
   strings are compared on the two chunk-0 texts. When each side states a value the other lacks, the candidate is a different claim:
   the web shows no `near_duplicate` warning, and MCP names it only when no candidate with matching values reaches the threshold,
   as `… but the values differ (60 vs 600) · replaces it → spoor_supersede …`. A one-sided difference (an elaboration) still counts.
4. **The default threshold is 0.87** (range unchanged, 0.80 to 0.99). Projects that set a threshold keep it.

The web keeps its warning-only check. `allow_duplicate` still skips the whole check.

## Consequences

- No fact is lost to a false duplicate; the worst case of a wrong hit is one note line.
- On the benchmark pairs, the values guard removes all three wrongly refused facts. At 0.87, all ten reworded duplicates are
  reported, and the only different fact still reported ("Android minimum is API 28") is stated verbatim in the matched item's body.
- Real duplicates are now saved too. The agent is asked to supersede, and the review queue and cleanup handle the rest. Clutter
  rises a little where agents ignore the note.
- The guard is lexical and language-neutral but simple: `1,000` and `1000` differ, and prose differences ("admin" vs "public") are
  not values. Twenty pairs are a small sample; the threshold should be re-checked on a larger labelled set.

## Alternatives considered

- **Keep refusing, tune the threshold**: any cut-off trades one error for the other on these scores, and refusals still lose facts.
- **Re-rank candidates with a cross-encoder**: better paraphrase recall, but a second model in the image (hundreds of MB) and more
  latency per write; possible later.
- **Make `DUPLICATE` an error result**: agents might notice it more, but the false refusals remain.
