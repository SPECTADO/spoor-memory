---
spoor_id: 996798d5-a87e-4c45-b398-ecd0220caf87
---
# ADR-0017: The `latest` image follows `main`; version tags stay on `v*` releases

- **Status:** Superseded by ADR-0019
- **Date:** 2026-10-20
- **Deciders:** Ladislav Soukup (owner), Claude (Opus 5.5)
- **Tags:** release, ci, image
- **Refines:** [ADR-0013](0013-cli-packaging-and-release.md)

## Context

ADR-0013 pushes images only from `release.yml` on a `v*` tag, `latest` included, and `ci.yml` only builds the image. Commits on
`main` therefore never reach GHCR: after `v0.1.0`, eleven commits sat on `main` while `ghcr.io/spectado/spoor-memory:latest` still
served 0.1.0. The owner wants `latest` to be the newest commit on `main`.

The constraint from ADR-0013 (I30) still holds: the install doc of a server pins `spoor-memory@<server version>`, so no image may be
pullable while its CLI version is missing on npm.

## Decision

- `ci.yml` job `image` runs after every other CI job. On a push to `main` it pushes `latest` and `sha-<short sha>`. It pushes only
  when `spoor-memory@<packages/server version>` is already on npm. Otherwise it only builds. Pull requests only build, as before.
- `release.yml` keeps pushing `x.y.z` and `x.y` after npm. It pushes `latest` only when the tagged commit is still the head of
  `main` and the version is not a pre-release. This covers the release bump commit, which `ci.yml` builds before npm has the
  version, and keeps an older tag from moving `latest` back.

## Consequences

- `latest` is the newest green commit on `main`. Between releases it reports the last released version (for example 0.2.0) while
  running newer code. The CLI version warning (ADR-0016) therefore stays quiet for those images.
- `sha-<short>` tags allow pinning or rolling back to any pushed `main` build. GHCR keeps them until someone prunes them by hand.
- A version bump on `main` without its tag leaves `latest` where it was until the release publishes npm.
- Production should pin `x.y.z` (docs/operations.md). `latest` is for trying out `main`.
- `ci.yml`'s image job declares `packages: write`, so `release.yml` grants it to the `ci` call even though it skips that job.

## Alternatives considered

- **Keep `latest` on tags only (ADR-0013)**: `latest` stays a release, but the owner wants `main` published.
- **A separate `edge` or `main` tag, with `latest` kept on releases**: the conventional split, but the owner chose `latest` itself.
- **A `workflow_run` workflow after CI**: separate permissions, but it builds the image a second time and reads the commit from
  event data. Pushing from the existing image job reuses its build.
- **Push from `main` without the npm check**: simpler, but it breaks I30 whenever a bump commit lands before its release.
