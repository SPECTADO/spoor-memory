# Spoor Memory

Spoor is a self-hosted, team-shared memory for coding agents and the people who work with them. Agents read and write it
over MCP with very few tokens; humans browse, edit and administer it in a web UI. One Docker deployment (the app image plus
Postgres with pgvector) serves many isolated projects and one org-wide shared space. It is single tenant by design.

## Features

- **Four spaces per project**: `memories` (atomic claims: decision, fact, procedure, observation), `decisions` (numbered
  ADRs, `ADR-0001`), `docs` (long-form pages) and `library` (human-written guides agents read but cannot change, `L<n>`). Every item is Markdown with YAML frontmatter, versioned in append-only
  revisions, linked by `[[wikilinks]]` and typed edges, with backlinks in the UI.
- **A map of the links**: every project (and the shared space) as an interactive graph with filters, a focus mode for one
  item's neighbourhood, a list view and link-health counts. **Suggested links** rank unlinked items by meaning, computed on
  demand from the stored embeddings, for people in the UI and for agents after each write.
- **A shared space** every project token can read, written only by humans in the web UI.
- **Cheap for agents**: a budgeted digest (about 1,500 tokens by default) at session start, hybrid search (full text plus
  vectors, reciprocal rank fusion), handles instead of ids, one short text block per tool result. Nine MCP tools.
- **Local embeddings**: multilingual-e5-small runs inside the app container, no API key. OpenAI, Voyage or your own Ollama server (embeddinggemma) are optional.
- **Claude Code integration**: `spoor login` (device approval in the browser), a committed `.mcp.json`, three hooks (session
  start digest, push of edited ADR and doc files, one gentle "record your decisions" nudge), ADR drafting on your own machine.
- **Self-cleaning**: unverified memories become stale, then archived; observations expire; humans review and hard-delete.
- **Web UI**: dashboard, map, filters, search, rendered Markdown, CodeMirror editor with live preview, revision history with diff,
  review queue, audit log, tokens, members, invites, settings, jobs.
- **Export and import** of a project as a zip of Markdown files with full history, re-importable losslessly.

## Quick start (about five minutes)

You need Docker with the compose plugin.

```sh
git clone <this repository> spoor-memory && cd spoor-memory
cp .env.example .env
```

Edit `.env` and set at least:

| variable | value |
|---|---|
| `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD` | two random URL-safe strings: `openssl rand -hex 24` |
| `SPOOR_ADMIN_EMAIL` | your email, the bootstrap admin login |
| `SPOOR_ADMIN_PASSWORD` | at least 12 characters |
| `SPOOR_PUBLIC_URL` | the URL people will type, `http://localhost:3000` for a local trial |

```sh
docker compose up -d --build     # builds the image from this checkout and tags it spoor-memory:local (SPOOR_IMAGE)
curl -s localhost:3000/healthz   # {"status":"ok",...} once migrations ran and the embedding model loaded (up to two minutes)
```

**Published images.** To pull instead of building, set `SPOOR_IMAGE` in `.env` and run `docker compose pull && docker compose up -d`.
`ghcr.io/spectado/spoor-memory` has these tags:

| tag | what it is |
|---|---|
| `x.y.z`, `x.y` (e.g. `0.2.0`, `0.2`) | a release, pushed by a `v*` tag. Use this in production |
| `latest` | the highest release (the same image as the newest `x.y.z`) |
| `develop` | the newest commit on `main` that passed CI. Between releases it reports the last released version while running newer code |
| `sha-<short>` | one specific `main` build, for pinning or rolling back |

A `main` build is pushed only once the CLI of its server version is on npm, so a version bump gets `develop` from its release
([ADR-0019](docs/adr/0019-develop-image-follows-main.md)).

1. **First login.** Open `SPOOR_PUBLIC_URL`, log in with `SPOOR_ADMIN_EMAIL` and `SPOOR_ADMIN_PASSWORD`. The bootstrap admin is
   created only while the user table is empty.
2. **Create a project.** Projects, New project: a name and a slug (`acme`; the slug is permanent). Invite teammates under
   Admin, Invites (a copyable link, no email) and give them a role on the project (admin, editor or viewer).
3. **Point Claude Code at the install doc.** In the repository you want to give a memory, tell Claude Code:

   > Set up Spoor memory by following `https://spoor.example.com/p/acme/install.md`

   The page is public and secret-free. It tells the agent to install the CLI, run `spoor login` (you approve a code in the
   browser; it ends with `spoor init`, which writes `.mcp.json`, the hooks, `.gitignore` entries, the `AGENTS.md` block and `CLAUDE.md` import, and turns Claude Code auto-memory off for you), run `spoor adr import`
   and `spoor docs import` to bring existing ADRs and docs in, and finally ask you to restart Claude Code and approve the
   `spoor` MCP server.

   **Until the first npm release** the CLI is not on npm (`spoor-memory@0.0.0` does not exist there); install.md of a
   source-built server says so. Install it from this checkout on the developer's machine first:
   `pnpm install && pnpm --filter "spoor-memory..." build && npm i -g ./packages/cli` (Node 22, pnpm 10).

Quick checks: `spoor status --remote` (project, role, token expiry) and `spoor context --git` (the digest an agent will get).

The global CLI does not update itself: after a server upgrade, each session's digest says when the installed CLI differs
and names the commands (`npm i -g spoor-memory@<server version>`, then `spoor init`).

## Optional: better search with Ollama

The built-in model needs nothing. For better recall on reworded and non-English questions, Spoor can embed with
`embeddinggemma` on an [Ollama](https://ollama.com) server instead (paraphrase MRR 0.78 against 0.48 on our benchmark,
[ADR-0026](docs/adr/README.md)). Item text is then sent to that Ollama server and nowhere else.

1. **Add an Ollama service.** Create `docker-compose.override.yml` next to `docker-compose.yml` (compose merges it
   automatically):

   ```yaml
   services:
     ollama:
       image: ollama/ollama:0.40.15
       restart: unless-stopped
       environment:
         OLLAMA_KEEP_ALIVE: "-1" # keep the model loaded, so no search waits for a reload
       volumes:
         - ollama-models:/root/.ollama
       # no ports: only the app reaches it, on the compose network (Ollama has no authentication)

   volumes:
     ollama-models:
   ```

2. **Point Spoor at it.** In `.env`:

   ```sh
   SPOOR_OLLAMA_URL=http://ollama:11434
   ```

   `SPOOR_OLLAMA_EMBED_MODEL` (`embeddinggemma`) and `SPOOR_OLLAMA_EMBED_DIMS` (`768`) already have the right defaults.

3. **Start it and pull the model** (about 620 MB, once; it stays in the `ollama-models` volume):

   ```sh
   docker compose up -d
   docker compose exec ollama ollama pull embeddinggemma
   ```

4. **Switch a project.** In the web UI open the project's Settings, Embedding, choose `ollama` and save. Items are
   re-embedded in the background; search keeps using the old model until the switch. To start new projects on it, also set
   `SPOOR_EMBEDDING_DEFAULT=ollama` in `.env`.

5. **Lower the related-items floor.** In the same project's settings set `dedupe.related_min_cos` to about `0.55`:
   embeddinggemma scores similar texts lower than the built-in model, so the defaults suggest too few links and the
   "similar to" note on writes rarely appears.

Notes:

- **GPU.** The service above runs on CPU, which is slower than the built-in model for bulk re-embedding; its speed has not
  been measured. With an NVIDIA GPU and the NVIDIA container toolkit, add
  `deploy: { resources: { reservations: { devices: [{ driver: nvidia, count: all, capabilities: [gpu] }] } } }` to the
  `ollama` service.
- **macOS.** Docker gives containers no GPU there. Skip step 1, run the Ollama app natively (`ollama pull embeddinggemma`)
  and set `SPOOR_OLLAMA_URL=http://host.docker.internal:11434`.
- **If Ollama is down**, writes still succeed (their embeddings are retried every minute) and search falls back to full text.

Details and other models: [docs/operations.md](docs/operations.md), section 7.

## Documentation

| read | for |
|---|---|
| [docs/operations.md](docs/operations.md) | deploying and running it: env vars, TLS, proxies, backup, restore, upgrades, troubleshooting |
| [docs/user-guide.md](docs/user-guide.md) | the web UI: projects, spaces, the map and suggested links, item lifecycle, editing, tokens, admin |
| [docs/agent-guide.md](docs/agent-guide.md) | what agents get: digest, tools, links, hooks, drafting, mirror rules, token costs |
| [CHANGELOG.md](CHANGELOG.md) | what is in each release |
| [ARCHITECTURE.md](ARCHITECTURE.md), [GLOSSARY.md](GLOSSARY.md) | components, flows, terms |
| [docs/adr/](docs/adr/README.md), [docs/design/](docs/design/) | decisions and the detailed design; [dod-status.md](docs/design/dod-status.md) maps the brief's Definition of done to evidence |
| [BRIEF.md](BRIEF.md) | the contract: scope and amendments |

## Development

Node 22 and pnpm 10.34.7 (`packageManager`). `pnpm install`, then `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`.

The server's integration and end-to-end tests need Postgres with pgvector: `pnpm test:db:up` starts one in Docker on port 55432
(`pnpm test:db:down` removes it), or point `DATABASE_URL` at a database whose name ends in `_test`. `pnpm test` fails fast
with a clear message when it is unreachable; `pnpm --filter @spoor/server test:e2e` walks the CLI against the real server.
`pnpm e2e` builds and runs the Playwright browser tests (once: `pnpm --filter @spoor/web exec playwright install chromium`).
`pnpm --filter "spoor-memory..." build && pnpm --filter spoor-memory test:pack` checks the npm package as it would be published.
Releases are cut with a `v*` tag ([operations §10](docs/operations.md), ADR 0013); every green push to `main` also publishes
the `develop` image (ADR 0019).
Package notes: [server](packages/server/README.md), [web](packages/web/README.md), [CLI](packages/cli/README.md).

## Licence

MIT, see [LICENSE](LICENSE).
