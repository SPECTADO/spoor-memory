---
spoor_id: 98f5905c-4a2a-40fc-b919-7045d37fc2e2
---
# ADR-0013: The CLI is published as one esbuild bundle, and a v* tag releases the npm package and the image together

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** the owner (Ladislav Soukup) by delegation at the phase 5 checkpoint; Claude (Opus 5.5), release-readiness step
- **Tags:** packaging, release, ci, cli

## Context

The `spoor` CLI lives in `packages/cli` and is published to npm as `spoor-memory` (BRIEF.md, cli-and-hooks.md §1). It imports
`@spoor/shared`, a private workspace package, and was built with plain `tsc`, so a published tarball would have declared
`"@spoor/shared": "workspace:*"`, which npm cannot install; its `VERSION` was a hard-coded `0.0.0` (deviations.md H7). The
install doc of a server pins the CLI to the server's own version (`npm i -g spoor-memory@<server version>`, and the same version
in the hooks' `npx` fallback), so the image and the npm package must carry one version and be released together (I30). There was
no release workflow (H14), and the Playwright layer was not a CI job (H15). House rules: fewest dependencies, release-age delay
on every package, exact pins.

## Decision

We will bundle the CLI with **esbuild** (`packages/cli/scripts/build.mjs`): one ESM file, `dist/bin.js`, with `@spoor/shared`
compiled in from its TypeScript source (an esbuild alias, so the bundle never depends on `shared/dist`). The package's declared
runtime dependencies (`yaml`, `zod`, exact pins) stay external and are installed by npm; `@spoor/shared` moves to
`devDependencies`. esbuild 0.28.2 (published 2026-08-08) was already in the lockfile through `tsx`, so the only new entry is the
direct devDependency. `tsc --noEmit` still type-checks the build. The package ships only `dist/`, `README.md`, `LICENSE` (a copy
of the repo's, checked byte-equal) and `package.json` (`bin.spoor`, `engines.node >=22`). `VERSION` is read at runtime from the
package's own `package.json`, one level above both `src/` and `dist/`, exactly as the server reads its version.

`scripts/pack-smoke.mjs` (`pnpm --filter spoor-memory test:pack`) packs the package as published (`pnpm pack`, which rewrites
`workspace:` ranges), requires that the tarball and `npm pack --dry-run` both list only those four files, checks the packed
manifest, and runs the packed bin's `--help` and `--version` outside the workspace, where `@spoor/shared` cannot resolve. CI runs
it offline; the release runs it with a real `npm install` of the tarball and then publishes that same tarball.

We will release from **`.github/workflows/release.yml` on `v*` tags only**: (1) the tag, `packages/server/package.json` and
`packages/cli/package.json` must carry one version, or nothing runs; (2) the whole of `ci.yml` runs as a reusable workflow (lint,
typecheck, unit, server integration, server e2e, Playwright e2e, the pack smoke test); (3) the npm job publishes the tested
tarball with `npm publish --provenance` (`id-token: write`, secret `NPM_TOKEN`), setting `repository.url` from the GitHub
repository at publish time because provenance requires it to match; (4) only then the image job pushes the multi-arch
(`linux/amd64`, `linux/arm64`) image to GHCR, tagged `x.y.z`, `x.y` and `latest`. A pre-release tag (`v1.2.0-rc.1`) publishes npm
dist-tag `next` and only the `x.y.z-…` image tag. `ci.yml` no longer pushes images.

## Consequences

- `npm i -g spoor-memory@X` installs one file plus two small dependencies; the published artifact is the one that was tested.
- The CLI's version, User-Agent and device `client_name` follow `package.json`; a release bumps both server and CLI versions in
  one commit before tagging (docs/operations.md, "Releasing").
- npm is published before the image, so an image whose install doc pins `spoor-memory@X` is never pullable while `X` is missing
  on npm. If the image job fails, re-running the workflow skips the npm publish (that version already exists) and retries the image.
- Workspace code changes reach the CLI only through a rebuild; there is no `dist/` of the CLI's own modules any more, so nothing
  can import `packages/cli/dist/*.js` except `bin.js` (the server's e2e test only runs `bin.js`).
- Bundling `yaml` and `zod` too would remove the runtime dependencies, but would put third-party code (and its licence notices)
  inside our file; we keep them external.

## Alternatives considered

- **Publish `@spoor/shared` as its own npm package** - two packages to version, publish and keep compatible for one internal
  helper set; rejected.
- **Copy `packages/shared/dist` into the CLI at build time** and rewrite the import - works without a bundler, but needs an
  import rewrite step and still ships a second module tree; esbuild does both in one call and was already installed.
- **tsup or rollup** - wrappers around the same job; new packages under the release-age rule for no gain.
- **Bundle everything (zero runtime dependencies)** - see Consequences; possible later if install time matters.
- **Stamp the version from the tag in CI** instead of a bump commit - convenient, but the tagged source would then say `0.0.0`
  and a local build of a tag would differ from the published one.
- **Publish npm and the image in parallel** - faster, but a failed npm job would leave a pullable image whose install doc points at
  a missing CLI version (I30).

**Update 2026-10-20:** `latest` no longer comes from tags only. `ci.yml` pushes it from `main` after the full CI, and a release
moves it only when the tag is still `main`'s head. See [ADR-0017](0017-latest-image-follows-main.md).

**Update 2026-10-19 (phase 5 review, review-log-phase5 A1, D2):** until the first `v*` release the name `spoor-memory` is not on
npm, so the SessionStart `npx` fallback would ask the public registry for a name anyone could register. Since this review the hook
renders the `npx` fallback only for a released version (`x.y.z`, not `0.0.0`); a source-built server renders `|| exit 0`, and its
install.md describes the source install. Registering the npm name (or moving to a scoped name) before the first release is an
owner action listed in docs/operations.md §10.

