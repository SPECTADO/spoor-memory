---
adr: 27
title: Imports are a resumable client queue; the server defers embeddings for imports and limits concurrent pushes
status: proposed
date: 2026-11-10
deciders: [ladislav.soukup@gmail.com]
tags: [import, cli, push, embeddings]
anchors: [packages/server/src/modules/items/push.ts, packages/server/src/modules/items/admission.ts, packages/server/src/modules/items/service.ts, packages/cli/src/import-queue.ts, packages/cli/src/backoff.ts]
---
# Imports are a resumable client queue; the server defers embeddings for imports and limits concurrent pushes

- **Deciders:** Ladislav Soukup (owner; decided on 2026-11-10 to fix both the CLI and the server, and that imports may be stored at once and embedded later), Claude

## Context

`spoor adr import` and `spoor docs import` on an existing project made the production server answer 500 (`spoor: server unreachable (500 …)`). The CLI was already sequential, so the load was the work done per request. The diagnosis, confirmed against the code:

- **Inline embedding.** Every file was chunked and embedded inside the request, on the local e5 model: one process-wide serial queue, two threads. `POST /api/adr/import` carried up to 100 files / 900 KiB and answered only after all of them. The CLI waited 30 s per batch, and only 6 s per docs push (`pushFile` overrode the client's 30 s with the hook timeout).
- **Zombie requests.** The server does not notice that the client gave up, so a timed-out request kept running. A re-run, or a hook sweep, then overlapped it on the same project. `withTimeout` on the embed call does not cancel the abandoned embed loop either; the `embed-pending` job later did the same work again.
- **Deadlocks and pool waits.** Two overlapping writers produced deadlock `40P01` between two pass-2 transactions (`FOR UPDATE` on its own item against the foreign-key `KEY SHARE` on the other), or pool connect timeouts: `pushUpdate` and the supersede step took a second pooled connection (`projectSettings(this.db)`) while holding the transaction's connection (pool max 10, connect timeout 5 s).
- **One bad file failed the batch.** In `adrImport` both catch blocks called `toPushError`, which rethrows anything that is not an `ApiError`. One transient error turned the whole batch into 500 `internal`, although earlier files were already committed, and the CLI then wrote back nothing.
- **A client that gave up too easily and talked wrongly.** No retry, no backoff, no `Retry-After`; the first failure aborted; a 429 in `docs import` was counted as a file error and the loop went on at once; a re-run sent everything again; the message said "It will retry on the next session", which is true for hooks and false for an import.

## Decision

Both sides change. The wire stays compatible both ways: no body or response schema changes, no new route.

**Server**

1. **Header flags, not body fields.** `pushRequest`, `adrImportRequest` and `spacePushRequest` are `z.strictObject`, so every server version answers an unknown body field with 400. The flags are request headers, which an older server ignores: no negotiation and no fallback request. `Spoor-Defer-Embedding: 1` (on `push`, `adr/push`, `docs/push`, `adr/import`) and `Spoor-Import-Edges: defer` (`adr/import` only).
2. **Deferred embedding is done in `ItemService`, with no port change.** With the header, `prepare` returns chunks with a NULL embedding and never calls the model, also for the re-index of an item that a `supersedes` reference marks superseded (the transaction no longer prepares anything). The `embed-pending` job is nudged and the result carries the existing `embedding_pending` warning. An `adr/import` of **more than 10 files** is deferred without the header: the new CLI never sends more than 10, so a larger request is an old CLI's 100-file batch, which was the overload. Requests of 1 to 10 files and `/push` without the header embed inline as before.
3. **503 `busy` with `Retry-After: 5`, not 429.** `push`, `adr/push`, `docs/push` and `adr/import` share one in-process limiter: `SPOOR_PUSH_CONCURRENCY` (default 3) requests in flight per project, and `max(SPOOR_PUSH_CONCURRENCY, SPOOR_DB_POOL_MAX - 2)` over all projects, which leaves two connections for auth, MCP, the web UI and jobs. The check runs after the token and role checks and before body validation, and a request stays counted until its handler returns, also when the client is gone. It is 503 because CLI 0.5.1 and older stop on 5xx but carry on at once after a 4xx.
4. **One file never fails a batch.** An unexpected error in pass 1 becomes that file's result `{error:"internal", message:"Internal error."}` (logged with the real error); in pass 2 it becomes an `edges_failed` warning. After 3 unexpected errors in one request the rest is not attempted (`not processed`), so a sick database is not hammered by the remaining files. Because pass 2 of the other files now runs after a pass-1 failure, a ref to the number of a file that failed pass 1 in the same request stays `unresolved_*` instead of resolving to another item holding that number.
5. **Deadlocks are retried.** `40P01` and `40001` in the push and import write transactions are retried three times with a jittered delay of about 25 to 200 ms (`retryTransient`, `withTxRetry`). The push paths use the open transaction instead of a second pooled connection.
6. **Two-pass import with `edges_deferred`.** The number map `{repo number → assigned number}` is per request. With 10-file requests, references between ADRs often point into another request, and `resolveRef` then falls back to the project: an item with `renumbered_from = N` makes the reference `ambiguous_ref`, otherwise the item numbered N. That is only right once every file is on the server. So pass 1 (`Spoor-Import-Edges: defer`) stores content only and marks files with edge work `edges_deferred`; pass 2 sends those files again, and the server resolves against the complete set. A file that names the number of a repo ADR that did not make it to the server (pending or failed) is held back in `edges` until a later run imports that ADR. Re-sending unchanged content answers `unchanged` and still applies the edges.
7. **Lost renumber answer.** A file without `spoor_id` that matches by `source_path` an item whose `renumbered_from` equals the file's number gets `renumbered {from,to}` again instead of `number_mismatch`, so a client that lost the creating request's answer renames the file when it re-sends. `reserve_above` is sent in every request, and `next_adr_number` always lies above every held number, so collisions in different requests get different numbers.
8. `embed-pending` takes 16 chunks per batch with the local model (it must finish inside `EMBED_TIMEOUT_MS` and not hold the queue that query embeddings share) and 64 with remote providers.

**CLI**

9. **A local queue.** `.spoor/import-queue.json` (written atomically, one entry per file: `pending`, `edges`, `done`, `failed`) and `.spoor/import.lock` (a pid lock; single flight per checkout). A re-run skips files whose content hash equals the base hash in `state.json` or a `done` entry, and ends with done / remaining. `--all` sends every file.
10. **Small, size-aware batches.** ADR requests of at most 10 files and 128 KiB, `docs import` one file per request. The request timeout is 30 s plus 250 ms per KiB, at most 120 s (`SPOOR_IMPORT_TIMEOUT_MS` replaces it); the 6 s override of docs import is gone. The server limits (100 files, 400,000 characters, 256-character paths, 1 MiB) are checked locally, because one bad file makes the whole request a 400.
11. **Backoff.** Timeouts, 5xx, 429 and 503 `busy`/`starting` are retried: exponential from 2 s capped at 60 s, jittered between half and full, at least `Retry-After` (integer seconds, at most 60 s), at least 15 s after a timeout because the server may still be working on the request (re-sending is safe: unchanged content answers `unchanged`). A timeout or 5xx halves the batch. Give up after 5 failures in a row or 300 s of waiting. While the server signals pressure, requests are paced 1, 2, then 4 s apart. A 429 is back-pressure, not a file error. `503 busy` does not trip the 5-minute breaker of the hooks.
12. **Hooks step aside.** While an import holds the lock (refreshed every minute while held), PostToolUse queues the file and SessionStart skips the replay and the sweep; PostToolUse, the replay and the sweep leave files of an unfinished import to the import for 7 days. A file refused for its content (too large, a per-file 4xx) does not keep an import unfinished until it changes. Messages say how many files remain and to run the same command again; "will retry on the next session" stays for hooks and pushes.
13. **Compatibility.** A new CLI against a server without these changes gets inline embedding and both passes in every request, and copes through small batches, size-based timeouts, backoff and a second pass for `unresolved_*` warnings. An older CLI against the new server sends no headers; its large batches are deferred by rule 2.

## Consequences

- Imported items are searchable by keyword at once and by meaning only after `embed-pending` has run (every minute, 16 chunks per batch with the local model). Results carry `embedding_pending` meanwhile. This needs `SPOOR_JOBS=on` in at least one container.
- An old CLI that meets `503 busy` stops its import (exit 3) and its hooks pause for 5 minutes (the breaker). Accepted: it only happens while the limit is hit.
- The limit is per process. Several app containers each allow `SPOOR_PUSH_CONCURRENCY` pushes per project.
- Hook pushes of files that belong to an unfinished import wait for up to 7 days or until the import finishes.
- A lost `import-queue.json` is harmless for files not yet imported, but files that waited for pass 2 then look imported and their links are not sent until `spoor adr import --all`.
- On a server without these changes, a forward reference to an ADR number the server already holds for a different, non-repo ADR may link to that ADR (it could already happen for imports of more than 100 files), and a renumber answer lost to a timeout stays a `number_mismatch` warning.
- More requests per import (10 files each) and a second pass; the cost is small next to the embedding that moved out of the request.

## Alternatives considered

- **A body field instead of headers, with a fallback request.** An older server rejects the unknown field with 400, so the CLI would need a probe or a second request. Headers cost nothing on old servers.
- **429 for the limit.** CLI 0.5.1 and older treat a 4xx as a per-file answer and continue at once; 503 makes them stop.
- **A server-side import job** (accept the files, return a job id, poll). The most robust shape, but a new table, routes, lifecycle and cleanup for a one-time operation; the queue on the client is enough.
- **Cancellable embedding** (stop the abandoned embed loop after its timeout). It needs a change of the `EmbeddingProvider` port in files with other uncommitted work and cannot be tested without the model. Deferral takes most of the embedding out of the request instead.
- **Ordering the locks to avoid deadlocks** instead of retrying them. It would touch every write path; a short retry of `40P01` / `40001` covers the observed case.
- **A read-only check in the hooks, or a shared mirror lock,** instead of the import lock that makes hooks queue their files. A read-only check does not stop overlapping writes; a shared lock couples the hooks to the import's duration.
- **Keep inline embedding with tiny batches, and a CLI queue only.** Smaller batches and retries on the client leave the per-request model work, the zombie requests and the batch-wide 500 in place, and an old CLI would still overload the server.
