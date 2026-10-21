---
spoor_id: fbdbdbc7-82b6-4ed0-9bf7-05c3078c062d
---
# ADR-0019: `develop` follows `main`, `latest` follows the highest release

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** Ladislav Soukup (owner), Claude (Opus 5.5)
- **Tags:** release, ci, image
- **Supersedes:** [ADR-0017](0017-latest-image-follows-main.md)

## Context

ADR-0017 made `ghcr.io/spectado/spoor-memory:latest` the newest green commit on `main`. Someone who pulls `latest` therefore gets
unreleased code that reports the last release's version. The owner wants `latest` to mean the newest release again and wants a
separate tag for `main`.

The constraint from ADR-0013 (I30) still holds: no image may be pullable while the CLI of its server version is missing on npm.

## Decision

- Version tags do not change: `release.yml` pushes `x.y.z` and `x.y` after npm (a pre-release gets only `x.y.z-…`).
- `latest` is pushed only by `release.yml`, and only when the tag is the highest `vX.Y.Z` tag without a pre-release suffix on
  `origin` (`git ls-remote --tags`, `sort -V`). A patch on an older line or a pre-release never moves `latest` back.
- `develop` replaces the old `latest` behaviour. `ci.yml` pushes `develop` and `sha-<short>` on every green push to `main`, once
  `spoor-memory@<server version>` is on npm. Pull requests only build.
- `release.yml` also pushes `develop` and `sha-<short>` when the tagged commit is still the head of `main`. This covers the release
  bump commit, which `ci.yml` only builds because npm does not have the version yet.

## Consequences

- `latest` and the highest `x.y.z` are always the same image. Users who want `main` pull `develop`.
- `develop` reports the last released version while running newer code. The CLI version warning (ADR-0016) stays quiet for it.
- When this ADR was accepted, `main` was at `v0.3.0`, so the `latest` already on GHCR was the 0.3.0 image. Nothing had to be retagged.
- Production should still pin `x.y.z` (docs/operations.md).

## Alternatives considered

- **Keep ADR-0017 (`latest` = `main`)**: `latest` then does not mean a release, which the owner rejected.
- **`latest` on every non-pre-release tag**: simpler, but a patch release on an older line would move `latest` back.
- **`edge` or `main` instead of `develop`**: the owner chose `develop`.
