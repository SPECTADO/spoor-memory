/**
 * The provider registry, built once from env (docs/design/search-and-digest.md section 2): `local` always,
 * `openai` when SPOOR_OPENAI_API_KEY is set, `voyage` when SPOOR_VOYAGE_API_KEY (+ model and dims) is set.
 * SPOOR_EMBEDDING_DEFAULT names the provider new projects get. A project's `settings.embedding.provider`
 * names the provider it uses; search and dedupe read only chunks of `projects.embedding_model`.
 */
import type { Config } from '../../../config.js'
import type { EmbeddingProvider, EmbeddingRegistry } from '../../../ports.js'
import { resolveSettings } from '../../projects/index.js'
import { LocalE5Provider } from './local.js'
import { type FetchFn, OpenAIProvider, VoyageProvider } from './remote.js'

export class ProviderRegistry implements EmbeddingRegistry {
  readonly #providers: EmbeddingProvider[]
  readonly defaultProvider: EmbeddingProvider

  constructor(providers: EmbeddingProvider[], defaultName: string) {
    if (providers.length === 0) throw new Error('no embedding providers')
    this.#providers = providers
    this.defaultProvider =
      providers.find((p) => p.name === defaultName) ?? (providers[0] as EmbeddingProvider)
  }

  byName(name: string): EmbeddingProvider | undefined {
    return this.#providers.find((p) => p.name === name)
  }

  byTag(tag: string): EmbeddingProvider | undefined {
    return this.#providers.find((p) => p.tag === tag)
  }

  list(): EmbeddingProvider[] {
    return [...this.#providers]
  }
}

export function createEmbeddingRegistry(
  config: Pick<
    Config,
    | 'SPOOR_MODEL_DIR'
    | 'SPOOR_EMBED_THREADS'
    | 'SPOOR_EMBEDDING_DEFAULT'
    | 'SPOOR_OPENAI_API_KEY'
    | 'SPOOR_OPENAI_EMBED_MODEL'
    | 'SPOOR_OPENAI_EMBED_DIMS'
    | 'SPOOR_VOYAGE_API_KEY'
    | 'SPOOR_VOYAGE_EMBED_MODEL'
    | 'SPOOR_VOYAGE_EMBED_DIMS'
  >,
  opts: { fetch?: FetchFn } = {},
): ProviderRegistry {
  const providers: EmbeddingProvider[] = [
    new LocalE5Provider({ modelDir: config.SPOOR_MODEL_DIR, threads: config.SPOOR_EMBED_THREADS }),
  ]
  if (config.SPOOR_OPENAI_API_KEY) {
    providers.push(
      new OpenAIProvider({
        apiKey: config.SPOOR_OPENAI_API_KEY,
        model: config.SPOOR_OPENAI_EMBED_MODEL,
        dims: config.SPOOR_OPENAI_EMBED_DIMS,
        fetch: opts.fetch,
      }),
    )
  }
  if (config.SPOOR_VOYAGE_API_KEY && config.SPOOR_VOYAGE_EMBED_MODEL && config.SPOOR_VOYAGE_EMBED_DIMS) {
    providers.push(
      new VoyageProvider({
        apiKey: config.SPOOR_VOYAGE_API_KEY,
        model: config.SPOOR_VOYAGE_EMBED_MODEL,
        dims: config.SPOOR_VOYAGE_EMBED_DIMS,
        fetch: opts.fetch,
      }),
    )
  }
  return new ProviderRegistry(providers, config.SPOOR_EMBEDDING_DEFAULT)
}

/** The provider a project's settings name (falls back to the instance default for an unknown name). */
export function providerForSettings(registry: EmbeddingRegistry, storedSettings: unknown): EmbeddingProvider {
  const name = resolveSettings(storedSettings).embedding.provider
  return registry.byName(name) ?? registry.defaultProvider
}
