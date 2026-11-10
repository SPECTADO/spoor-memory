---
adr: 29
title: Local embedding inference runs in a worker thread; a request that could not get a database connection answers 503 busy
status: proposed
date: 2026-11-10
deciders: [ladislav.soukup@gmail.com]
tags: [embeddings, performance, reliability, errors]
anchors: [packages/server/src/modules/search/providers/local.ts, packages/server/src/modules/search/providers/inference-worker.ts, packages/server/src/modules/search/providers/local-worker.ts, packages/server/src/app.ts, packages/server/src/lib/db.ts]
---
# Local embedding inference runs in a worker thread; a request that could not get a database connection answers 503 busy

- **Deciders:** Ladislav Soukup (owner; asked on 2026-11-10 to find and fix the errors in a production log), Claude (diagnosis and both changes)
- **Refines:** [ADR-0003](0003-local-multilingual-embeddings.md), [ADR-0027](0027-imports-are-a-resumable-client-queue-the-server-defers-embeddings-for-imports-and-limits-concurrent-pushes.md)

## Context

The production log of 2026-11-10 (server 0.6.0) showed, while pushes and ADR imports ran:

- `POST /p/spoor-memory/api/push` answering 500 after 21.9 s, with `Connection terminated due to connection timeout` from `pg-pool` inside the push transaction;
- two web requests answering 500 after 5.0 s with the same error in `loadSession`, and `/healthz` answering 503;
- ordinary requests (`GET …/items/d18`, `…/edges`, `…/dashboard`, `/api/v1/me`) taking 1.3 s, 2.8 s or 4.2 s, which are multiples of about 1.4 s.

The cause is in `onnxruntime-node`: its `InferenceSession.run` is synchronous, and transformers.js calls it inside `setImmediate` (`onnxruntime-node/dist/backend.js`). `LocalE5Provider` ran the pipeline on the main thread, so each batch of 8 chunks held the event loop for its whole inference, and batches queued back to back (a large push, the `embed-pending` job after an import) left the loop about one turn per batch. Every awaited step of every request then cost one batch. A new Postgres connection needs about a dozen turns for its handshake, so it ran into `connectionTimeoutMillis` (5 s).

Reproduced on a developer machine without the model: a loop of 1.4 s busy-waits inside `setImmediate` next to `pg.Pool({ connectionTimeoutMillis: 5000 })` against a local Postgres fails every query with exactly that message; without the loop the same query takes 29 ms. ADR-0027 had already taken embedding out of the import requests, but the deferred work still ran on the same thread.

The error then reached the client as 500 `internal`, which the CLI treats as a server fault, although nothing had been written.

## Decision

1. **The model runs in a worker thread.** `providers/local-worker.ts` loads `AutoModel` with the same options as before and answers `{ id, input }` (a tokenized batch) with mean-pooled, normalised vectors. `InferenceWorker` (`providers/inference-worker.ts`) is the promise API over it: `ready`, `run(input, transfer)`, `closed`. Tensors and vectors are transferred, not copied.
2. **The tokenizer stays on the main thread, and only there.** The chunker calls `countTokens` synchronously, so `LocalE5Provider` loads `AutoTokenizer` itself and also tokenizes each batch (`{ padding: true, truncation: true }`). The worker then runs the model, `mean_pooling` and `normalize(2, -1)`: the steps of transformers.js's feature-extraction pipeline, written out. The tokenizer takes about 230 MB, so a pipeline in the worker (a second tokenizer) was built first and replaced.
3. **A dead worker is replaced.** A crash or failed load rejects the requests in flight (writes then store pending chunks, as for any embedding failure) and the next `ready()` starts a new worker. The worker is unreferenced while idle, so it never keeps the process alive.
4. **No connection means 503.** `isDbUnavailable(err)` recognises a failure to obtain a connection (connect timeout, pool wait timeout, connection refused, `57P03`, `53300`). The app's error handler answers it with 503 `busy` and `Retry-After: 5`, logged at `warn` as `database unavailable`. A connection lost in the middle of a statement stays 500: its outcome is unknown.

## Consequences

- Requests, timers and database handshakes proceed while the model embeds. Throughput of embedding itself is unchanged (still one inference at a time, `SPOOR_EMBED_THREADS` ONNX threads).
- Verified with the real model (q8, pinned revision, M3 Max, 2 ONNX threads): the vectors are bit-identical to the pipeline's on the main thread for the same batch (5 passages as one batch and one at a time, and a query: maximum absolute difference 0), and `countTokens` agrees. While 32 chunks of 449 tokens embedded, the old path let the event loop turn 4 times with a longest stall of 590 to 673 ms; with the worker it turned about 420 times with a longest stall of 10 to 15 ms. Embedding speed is the same (about 590 ms per batch of 8).
- Memory, same runs, resident set on macOS: 0.69 GB loaded and 1.16 GB after the 32 chunks, against 0.64 GB and 0.7 to 1.0 GB before. Not measured in the Linux container against the compose `mem_limit: 2g`.
- The pooling steps are now written in `local-worker.ts` instead of taken from the pipeline. An upgrade of transformers.js that changes the pipeline would no longer reach them; the real-model tests run only where `SPOOR_MODEL_DIR` holds the model, which CI does not.
- The worker script boots in all three run modes: built `.js`, `.ts` under Node's type stripping (vitest), `.ts` under `tsx`.
- `local-worker.ts` must stay free of imports from the server's sources and of non-erasable TypeScript, because under vitest and `tsx` it is started as a `.ts` worker. Running from source needs Node 22.18 or newer; the build is unaffected.
- A client now sees `busy` both for the push limit and for an unreachable database. Both mean "retry later".

## Alternatives considered

- **Smaller batches** (1 or 2 chunks): shortens each stall to a few hundred milliseconds but keeps the loop blocked most of the time during an import.
- **A longer `connectionTimeoutMillis`**: hides the 500s and leaves every request slow.
- **A child process**: the same isolation with slower messaging and its own lifecycle; nothing here needs a process boundary.
- **The whole pipeline in the worker**, with a second tokenizer on the main thread for `countTokens`: identical vectors by construction, but about 290 MB more when loaded (0.93 GB against 0.64). Built first, then replaced once the model was at hand to prove the written-out steps equal.
- **Retrying the connect timeout inside `retryTransient`**: while the loop is blocked a retry fails the same way; with the worker it is no longer needed.
