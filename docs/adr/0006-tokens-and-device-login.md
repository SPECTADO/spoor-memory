---
spoor_id: 2b531d52-7828-4457-86c6-5502bbcfbd84
---
# ADR-0006: Per-user tokens and device login, no secrets in git

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1, architect)
- **Tags:** security, auth

## Context

Agents authenticate from developer machines and CI, with no SMTP and no OAuth in phase 1. Tokens must never leak into git or logs. Source: `docs/design/auth-and-security.md`, `mcp.md`; settles D5, D8, I16, I24, I33, I38, I39, I40.

## Decision

We will issue per-user tokens `spr_` (service tokens `sprs_`), 32 random bytes base64url, stored hashed, optionally read-only capped and bound to the origin stored with them (the CLI sends a token only to that origin). Login uses an RFC 8628 adaptation (I33): the user types the code (no pre-filled link), the page shows requester IP and age, codes live 10 minutes, device tokens expire after 90 days, "Approve read-only" has default focus. Passwords use `crypto.scrypt` (N=2^17, r=8, p=1); web sessions are DB-backed cookies with a custom Origin / `Sec-Fetch-Site` check. Password reset is an admin-created reset invite (I16). MCP uses a static bearer only; a 401 carries `WWW-Authenticate: Bearer realm="spoor"` and OAuth is deferred (D8). Secrets stay out of git (D5, I24): tokens live in `.claude/settings.local.json`, `spoor login` appends it and `.spoor/` to `.gitignore`, refuses to write when the file is tracked, and `.mcp.json` only references `${SPOOR_TOKEN}`; pino redacts credentials. Memory content is treated as untrusted data with a fixed warning line and provenance marker (I38). Slugs are not secret and non-members learn nothing (I39). The database uses two roles (I40).

## Consequences

Leaked tokens are traceable, revocable and scoped; scrypt costs 256 MiB peak per hash and needs concurrency limiting. Developers do one browser step. No OAuth means clients without static-header support are out until phase 2.

## Alternatives considered

- **Shared project tokens** - no per-person revocation or audit.
- **OAuth/RFC 9728 now** - larger surface; Claude Code skips OAuth when a header is configured.
- **Pre-filled device link** - eases phishing (I33).
- **Argon2 or bcrypt** - extra native dependency; scrypt is built in.
- **Tokens in `.mcp.json`** - committed to git.
