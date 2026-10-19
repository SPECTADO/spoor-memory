// Bakes the default local embedding model into the image (docs/design/deployment.md section 2).
// 1. Download Xenova/multilingual-e5-small (q8) at the pinned Hugging Face revision.
// 2. Move it to the layout the runtime reads offline: <SPOOR_MODEL_DIR>/Xenova/multilingual-e5-small/.
// 3. Reload it with remote models disabled and embed one string. Any failure fails the image build.
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { env, pipeline } from '@huggingface/transformers'

const MODEL_ID = 'Xenova/multilingual-e5-small'
const DTYPE = 'q8'
const DIMS = 384

const modelDir = process.env.SPOOR_MODEL_DIR
const revision = process.env.MODEL_REVISION
if (!modelDir) throw new Error('SPOOR_MODEL_DIR is not set')
if (!revision) throw new Error('MODEL_REVISION is not set')

// transformers.js caches a non-"main" revision under <cacheDir>/<model>/<revision>/, while the offline
// loader reads <localModelPath>/<model>/. Download into a staging cache, then move the revision folder.
const staging = join(modelDir, '.download')
const target = join(modelDir, MODEL_ID)
await rm(staging, { recursive: true, force: true })
await rm(target, { recursive: true, force: true })

env.allowRemoteModels = true
env.cacheDir = staging
const downloader = await pipeline('feature-extraction', MODEL_ID, { dtype: DTYPE, revision })
await downloader.dispose()

const downloaded = join(staging, MODEL_ID, revision)
if (!existsSync(join(downloaded, 'config.json'))) {
  throw new Error(`download did not produce ${join(downloaded, 'config.json')}`)
}
await mkdir(join(modelDir, 'Xenova'), { recursive: true })
await rename(downloaded, target)
await rm(staging, { recursive: true, force: true })

// Prove the baked files load with no network, exactly as the server will load them.
env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = modelDir
env.cacheDir = null
const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: DTYPE })
const out = await extractor(['passage: Spoor model check.'], { pooling: 'mean', normalize: true })
await extractor.dispose()
if (out.dims[0] !== 1 || out.dims[1] !== DIMS) {
  throw new Error(`unexpected embedding shape ${JSON.stringify(out.dims)}, expected [1, ${DIMS}]`)
}
console.log(
  `model ok: ${MODEL_ID}@${DTYPE} revision ${revision} -> ${target} (${DIMS} dims, offline load verified)`,
)
