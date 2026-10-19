# Research: local ONNX embeddings in Node 22 (multilingual-e5-small)

Date: 2026-10-19. Verified with `npm view`, HF API, package source, and a real run
(Node v22.19.0, macOS arm64, 14 cores, @huggingface/transformers 4.3.1).

## Versions (release-age rule: published <= 2026-10-16)

| package | version | released | note |
|---|---|---|---|
| @huggingface/transformers | 4.3.1 (latest) | 2026-10-06 | OK (13 days old). 4.3.0 = 2026-09-16. 3.8.1 = 2025-12-02 (last 3.x) |
| onnxruntime-node (transitive, exact pin) | 1.30.0 | (not looked up; pulled in by transformers) | native binaries, linux x64+arm64 |
| js-tiktoken (optional) | 1.0.21 | 2025-08-09 | only if a GPT-style estimator is wanted |

transformers 4.3.1 deps: sharp ^0.35.4, onnxruntime-web 1.31.0-dev (pinned dev build, ships even in Node),
onnxruntime-node 1.30.0, @huggingface/jinja ^0.5.10, @huggingface/tokenizers ^0.2.0.
Source: `npm view @huggingface/transformers@4.3.1 dependencies`, `npm view ... time --json`.
Gotcha: install pulls `sharp` and the web ORT dev build (unneeded in a server); install size is large.
Pin exact versions (`4.3.1`, no caret) and use a lockfile.

## Model repo and file sizes

Use `Xenova/multilingual-e5-small` (transformers.js-compatible; config, tokenizer.json, `onnx/` folder).
Source: https://huggingface.co/api/models/Xenova/multilingual-e5-small/tree/main/onnx

| dtype option | file | bytes |
|---|---|---|
| fp32 (default on CPU) | onnx/model.onnx | 470,268,533 (~470 MB) |
| fp16 | onnx/model_fp16.onnx | 235,336,732 (~235 MB) |
| q8 | onnx/model_quantized.onnx | 118,308,185 (~118 MB) |
| int8 / uint8 | model_int8.onnx / model_uint8.onnx | 118,054,593 / 118,054,630 |
| q4, q4f16, bnb4 | | 398.6 MB, 204.8 MB, 397.3 MB (q4 is not smaller than fp16 here; skip) |

Plus tokenizer.json 17.1 MB, sentencepiece.bpe.model 5.1 MB, config files. Last modified 2025-07-22.
intfloat/multilingual-e5-small itself has an `onnx/` folder (model.onnx 470 MB, model_O4 235 MB,
model_qint8_avx512_vnni 118 MB) but not in transformers.js layout; use Xenova.
`dtype` -> suffix map (dtypes.js): fp32 '', fp16 '_fp16', int8 '_int8', q8 '_quantized'.
Default dtype on Node/CPU is fp32 (`DEFAULT_DEVICE_DTYPE = fp32`), so ALWAYS pass `dtype` explicitly.
Model license: MIT (intfloat). HF API reports no license tag on the Xenova repo; base model is MIT.

## Model facts

- 384 dims (config hidden_size 384), 12 layers, vocab 250,037, BERT arch with XLMRobertaTokenizer.
- Max sequence 512 tokens (max_position_embeddings 512, tokenizer model_max_length 512). Longer input is
  truncated by the pipeline; so chunks must stay <= ~510 tokens (400 target is safe).
- Prefixes (mandatory, even non-English), from intfloat README: "Each input text should start with
  "query: " or "passage: ", even for non-English texts." Use `query: ` for search queries and `passage: `
  for stored chunks. For symmetric tasks (near-duplicate check) use `query: ` on both sides
  (README FAQ: "Use "query: " prefix for symmetric tasks such as semantic similarity"), or at least the
  same prefix on both. Decision for Spoor: chunks `passage: `, search queries `query: `, dedupe compares
  passage-vs-passage (same prefix both sides is fine).
- Pooling: mean over attention mask, then L2 normalize. Pass `{ pooling: 'mean', normalize: true }`.
  Verified output norm = 1.0000, so cosine == dot product (pgvector `<=>` or inner product fine).
  Repo's 1_Pooling/config.json is not present in Xenova repo; the options must be passed explicitly.
- Model name tag for the DB: `Xenova/multilingual-e5-small@q8` (dtype changes vectors slightly; q8 and
  fp32 vectors are not interchangeable for the 0.92 dedupe threshold, so tag dtype too).

## Pre-download at build time, run offline

transformers.js does NOT read HF_HUB_CACHE / HF_HOME (grep of src/env.js: no process.env use).
Control is via the `env` object: `allowRemoteModels`, `allowLocalModels` (default true on Node),
`localModelPath` (default `<pkg>/models/`), `cacheDir` (default `<pkg>/.cache/`), `useFSCache`.
Source: node_modules/@huggingface/transformers/src/env.js (lines 203-267).
Two workable patterns:

A. Cache dir (what I tested). Build step runs the pipeline once with `env.cacheDir=/opt/spoor/models`;
   files land at `/opt/spoor/models/Xenova/multilingual-e5-small/{config.json,tokenizer.json,
   tokenizer_config.json,onnx/model_quantized.onnx}` (only the requested dtype is downloaded; 593 MB cache
   after running q8 and fp32). Runtime: same `cacheDir`, `allowRemoteModels=false`.
B. Local model dir. Same layout, `env.localModelPath='/opt/spoor/models/'`, `env.allowRemoteModels=false`,
   `env.allowLocalModels=true`, `env.cacheDir=null` (tested, loads offline OK, 2 vectors x 384).

Verified offline snippet (pattern B) ran fine. Add an app env var (e.g. `SPOOR_MODEL_DIR`) and map it
to `env.localModelPath` in code, since library env vars do not exist.

Dockerfile sketch (tested in spirit locally, not built in Docker):
```dockerfile
FROM node:22-bookworm-slim AS deps   # glibc image: onnxruntime-node needs glibc, NOT alpine/musl
...
RUN node scripts/fetch-model.mjs     # downloads into /opt/spoor/models at build
ENV SPOOR_MODEL_DIR=/opt/spoor/models
```
```js
// scripts/fetch-model.mjs
import { pipeline, env } from '@huggingface/transformers';
env.cacheDir = process.env.SPOOR_MODEL_DIR ?? '/opt/spoor/models';
await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' });
```
Gotcha: multi-arch image; onnxruntime-node ships linux x64 and arm64 binaries (not verified in Docker
here; verify in CI build with QEMU). Model files are arch-independent. Alpine/musl: not supported
by prebuilt onnxruntime-node (from ORT docs, unverified here); use bookworm-slim.

## Minimal working snippet (tested)

```js
import { pipeline, env } from '@huggingface/transformers';
env.allowRemoteModels = false; env.allowLocalModels = true;
env.localModelPath = process.env.SPOOR_MODEL_DIR; env.cacheDir = null;
const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small',
  { dtype: 'q8', session_options: { intraOpNumThreads: 2 } });
const out = await extractor(['query: wie viel kostet es', 'passage: Cena je 100 Kč'],
  { pooling: 'mean', normalize: true });
out.dims;            // [2, 384]
out.tolist();        // number[][]; or Array.from(out.data.slice(i*384,(i+1)*384))
```
Tokenizer without model: `extractor.tokenizer(text).input_ids.dims[1]` gives the token count (no
truncation unless `{truncation:true}`; the pipeline itself truncates at 512).
Dispose with `await extractor.dispose()` on shutdown. Use one singleton and a promise queue.

## Performance (measured, this machine: 14-core arm64 Mac, default threads)

Input: one ~605-token passage x 32 batch (truncated to 512 by pipeline).
- q8: 38 ms/chunk (1220 ms per 32), load 4.8 s warm cache, process RSS ~1.55 GB after batch (773 MB
  right after load).
- fp32: 130 ms/chunk, load 19 s, RSS ~1.6 GB.
- single short query (~8 tokens): ~3.3 ms (q8), 3.7 ms (fp32).
Caveats: memory with batch 32 x 512 tokens is dominated by activations; use small batches (4-8) to
bound RSS to roughly 0.8-1 GB. Docker CPU limits will be slower than this laptop; expect 2-4x slower
on 2 vCPU x86. Not measured on x86. q8 is ~3.4x faster than fp32 and 4x smaller; quality loss for
dynamic int8 quantisation on E5 is typically small but was NOT benchmarked here.
Threads: `session_options: { intraOpNumThreads: N }` (onnxruntime-common SessionOptions is camelCase; a snake_case key is ignored, corrected 2026-10-19) is passed through (session.js copies
`options.session_options`); default is ORT picking all cores. Set N = min(cores, 4) and cap
concurrency to 1 inference at a time so the HTTP server stays responsive. Optionally run in a
`worker_threads` worker to keep tokenizer/inference off the event loop (inference in onnxruntime-node
is async on its own threadpool, but tokenization is JS on the main thread).
Sizing guess for compose: mem_limit >= 1.5 GB for the app container with the embedding model loaded.

## Token estimator for digest budget

Measured on 3 short samples (Czech, English, markdown) - tokens by true e5 tokenizer vs chars/4 vs
cl100k (js-tiktoken):
- cs 69 chars: e5 24, chars/4 18, cl100k 25
- en 87 chars: e5 24, chars/4 22, cl100k 18
- md 58 chars: e5 23, chars/4 15, cl100k 19
(e5 counts include 2 special tokens; tiny samples, indicative only.)
The relevant budget is the LLM's context (Claude), not e5. Claude's tokenizer is neither; no offline
exact counter. Recommendation: use a chars/4 heuristic with a safety factor (chars/3.5, i.e. ~15%
conservative, since Czech/diacritics/markdown/ids tokenise worse than English) for `spoor_context`
digest budgeting. It is zero-dependency and deterministic. Use the e5 tokenizer (already loaded) only
for chunking, where the hard 512 limit matters. js-tiktoken 1.0.21 (stale, last release 2025-08) is
not worth the dependency; cl100k does not match Claude either.

## Chunking markdown at ~400 tokens with overlap

Library not needed; 30 lines of code beat adding langchain-text-splitters. Plan: split on markdown
blocks (headings, blank-line paragraphs, keep fenced code blocks atomic), accumulate blocks until the
token count (e5 tokenizer, `input_ids.dims[1]` or `tokenizer.encode(s).length`) reaches 400, emit,
carry the last ~15% (about 60 tokens, 1-2 trailing blocks) into the next chunk, prefix each chunk with
its heading path (`# Title > ## Section`) which helps retrieval. Items under ~450 tokens = 1 chunk.
Oversize single blocks: hard-split by sentence, then by token windows (decode of token slices).
```ts
function chunk(blocks: string[], count: (s: string) => number, max = 400, overlapTokens = 60) {
  const out: string[] = []; let cur: string[] = [], n = 0;
  for (const b of blocks) {
    const t = count(b);
    if (n + t > max && cur.length) {
      out.push(cur.join('\n\n'));
      const keep: string[] = []; let k = 0;
      for (let i = cur.length - 1; i >= 0 && k < overlapTokens; i--) { keep.unshift(cur[i]); k += count(cur[i]); }
      cur = keep; n = k;
    }
    cur.push(b); n += t;
  }
  if (cur.length) out.push(cur.join('\n\n'));
  return out;
}
```
Counting every block with the real tokenizer is cheap (sub-ms for short strings). Unit-test: no chunk
> 512 tokens, overlap present, code fences never split.

## Alternatives (brief)

- multilingual-e5-base: 768 dims, Xenova repo: fp32 1.11 GB, fp16 555 MB, q8 278.6 MB. ~3x slower
  compute, 2x vector storage; better recall. Same prefixes/pooling, so a drop-in model swap via the
  re-embed job. Good "upgrade" option, not default.
- bge-m3 (BAAI, 568M params, 1024 dims, 8192 ctx): Xenova/bge-m3 onnx fp32 = model.onnx + 2.27 GB
  external `model.onnx_data`; q8 569.7 MB; fp16 1.13 GB. Too heavy for the default image and CPU
  latency; offer only via an optional external provider. Prefixes not required.
- nomic-embed-text-v2-moe: 475M params (305M active), 768 dims (Matryoshka to 256), 512 max tokens,
  prefixes `search_query: ` / `search_document: `, custom_code (nomic_bert) with no verified
  transformers.js ONNX build found. Skip for MVP.
Sources: HF API tree listings at huggingface.co/api/models/{Xenova/multilingual-e5-base,Xenova/bge-m3,
nomic-ai/nomic-embed-text-v2-moe}; nomic README.

## Gotchas

1. Always pass `dtype`; default is fp32 (470 MB, 3.4x slower).
2. HF_HUB_CACHE/HF_HOME are ignored; set `env.*` in code. If `allowRemoteModels` stays true, a missing
   file triggers a network download at runtime (fails in air-gapped installs); set false in production.
3. Prefix omission silently degrades quality; wrap in a single `embed(kind, texts)` helper.
4. Truncation at 512 tokens is silent; chunker must count with the e5 tokenizer.
5. Load time 5 s (q8) at startup: load lazily or at boot with readiness gate; first query otherwise slow.
6. Transitive native + wasm deps (sharp, onnxruntime-web dev build): use `pnpm` with
   `onlyBuiltDependencies` allow-listing for sharp/onnxruntime-node install scripts; keep --ignore-scripts
   elsewhere. Consider `pnpm.overrides` is not needed. Docker image grows ~0.5-0.7 GB with node_modules + q8 model.
7. v4 is a major (published 2026-03-30); v3.8.1 is the conservative alternative but 4.3.1 API was the
   one tested. API used here (`pipeline`, `env`, `dtype`, `session_options`) is unchanged vs 3.x docs.

## Recommendation

Use `@huggingface/transformers` 4.3.1 (2026-10-06) with `Xenova/multilingual-e5-small`, `dtype: 'q8'`
(118 MB, ~38 ms per 512-token chunk on 14 cores, ~3 ms per query), mean pooling plus L2 normalize,
`passage: ` for stored chunks and `query: ` for searches, 384-dim pgvector column, model tag
`Xenova/multilingual-e5-small@q8`. Bake the weights into the image in a build stage via `env.cacheDir`
(or `localModelPath`) on a glibc base (node:22-bookworm-slim), set `allowRemoteModels=false` at runtime,
and expose an app-level `SPOOR_MODEL_DIR`. Run a single serialized embedder with
`intraOpNumThreads` capped (2-4) and small batches; budget ~1-1.5 GB RAM. Write the chunker
yourself (~30 lines, counting with the e5 tokenizer, 400 tokens, ~60 token overlap), and estimate digest
tokens with chars/3.5 instead of adding js-tiktoken. Keep e5-base as the quality upgrade path via the
re-embed job. Open items to verify in CI: linux arm64/x86 Docker build, x86 latency, q8 vs fp32 recall,
whether the 0.92 dedupe threshold needs recalibration for q8.
