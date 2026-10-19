# Phase 5 review log (adversarial review: security, DoD compliance, agent UX)

Status: 2026-10-19. The fixer (Claude) checked every finding of the phase 5 review against the code, BRIEF.md (with its
amendments and Definition of done), the design files and the ADRs, then fixed every confirmed blocker and major at the root
cause with a regression test, applied the cheap minors and closed the four gaps phase 4 left. Design files, READMEs, guides,
ARCHITECTURE.md, CHANGELOG.md and [dod-status.md](dod-status.md) were updated in the same work; where the code now differs from
what a design file said, [deviations.md](deviations.md) §R has a row. Nothing was committed.

Totals: 31 findings (4 blockers, 14 majors, 13 minors) and 4 phase-4 gaps. **All 4 blockers and 14 majors fixed**; 11 minors
applied, 2 applied in part (A11, A12: the rest rejected with a reason); gaps a, c, d closed, gap b was already closed. Owner
decisions that remain are at the end.

Checks after the fixes (all green): `pnpm lint` (Biome), `pnpm typecheck`, `pnpm build`, `pnpm test` (shared 87, cli 142, web 131,
server 1,167 passed + 1 skipped real-model test, including the CLI end-to-end walk of 11 tests on the `pnpm test:db:up` database),
`pnpm e2e` (Playwright, 22 passed), `pnpm --filter spoor-memory test:pack`, `actionlint` on both workflows, and the new compose smoke
steps run locally (`.env.example` with only the required values, `docker compose up -d --build --wait`, `/healthz` ok, bootstrap
admin login 200).

Legend: S = security, D = DoD compliance, A = agent UX, G = phase-4 gap. B / M / m = blocker / major / minor.

## Security

| # | sev | finding | disposition | regression test | where |
|---|---|---|---|---|---|
| S1 | B | `spoor adr import` writes to any server-named `source_path` (path traversal, arbitrary prepend outside the repo) | **fixed**, confirmed by reading the code (the reviewer's repro matches it). Root cause: the CLI applied server answers to server-chosen paths. Import results now apply only to a path the batch itself sent, each at most once; anything else is a protocol error that touches no file. `applyPushResult`, `pushFile`, `readFileText` and the drafting `dropDuplicate` resolve every path and refuse one outside the repo (`insideRoot`); a queued path outside the repo is dropped | `mirror.test.ts` "adr import ignores a result for a path the batch did not send and leaves files outside the repo alone", "a queued path outside the repo is never read or pushed" | `packages/cli/src/safety.ts` (new), `mirror.ts`, `cmd/mirror.ts`, `cmd/draft.ts`; cli-and-hooks.md §4.2 |
| S2 | B | `renumbered.to` unvalidated: rename out of the repo | **fixed**. A push or import result is applied only when `pushResultProblem` passes (`renumbered` = two integers 1-99999, `spoor_id` uuid, `handle` a handle, `revision` ≥ 1); an invalid answer is `invalid_response` and nothing is written. The rename target must also be an ADR path in `adr_dir` and inside the repo | `mirror.test.ts` "adr push ignores a renumber to a non-number and never moves the file out of adr_dir" | `safety.ts`, `mirror.ts` |
| S3 | M | `spoor_id` written into the file text unescaped (frontmatter injection) | **fixed** twice: results with a non-uuid `spoor_id` are refused before any write (S2), and `insertSpoorId` itself throws on a non-uuid; a local-rename base key that is not a uuid is not used | `mirror.test.ts` "adr push refuses a spoor_id that would inject frontmatter lines"; `writeback.test.ts` "refuses an id that is not a uuid" | `writeback.ts`, `mirror.ts` |
| S4 | M | `spoor init` writes whatever the public install.json says (MCP servers, hook commands, permissions, gitignore negations) | **fixed**. The three blocks moved to `@spoor/shared` `install.ts` (`mcpJsonBlock`, `settingsJsonBlock`, `INSTALL_GITIGNORE_LINES`); the server's templates call them, and `spoor init` renders them itself from its own `SPOOR_URL`, the slug and install.json's `version` (strict pattern; `project` must match). Nothing else from the answer reaches a committed file | `setup.test.ts` "writes only its own rendering of the blocks, whatever install.json says", "refuses an install.json with an unsafe version or another project"; server `templates.test.ts` unchanged and green | `packages/shared/src/install.ts`, `server/src/modules/install/templates.ts`, `cli/src/cmd/setup.ts`; cli-and-hooks.md §4.9, auth-and-security.md §10, ARCHITECTURE.md §3.4 |
| S5 | M | `spoor login` opens the server's `verification_uri` (local apps, `file:`, phishing) | **fixed**. The CLI prints and opens only its own `<SPOOR_URL>/device` | `setup.test.ts` "opens and prints only its own <server>/device, never the verification_uri of the answer" | `cmd/setup.ts`; cli-and-hooks.md §4.1, auth-and-security.md §6 |
| S6 | m | server strings reach the terminal raw (ESC/OSC) | **applied**. `runtimeOf` filters everything printed, written to stderr or asked (C0 except TAB/LF, DEL, C1, bidi); `user_code` must be `XXXX-XXXX` or the login stops | `runtime.test.ts` (new), `setup.test.ts` "refuses a user code that is not the 8-letter shape" | `runtime.ts`, `cmd/setup.ts` |
| S7 | m | `SPOOR_TRUST_PROXY=private` plus an app port published on `0.0.0.0` lets LAN clients forge the device page's requester IP | **applied (docs)**. The documented caddy example already binds 127.0.0.1; `.env.example` and operations.md §4 now say plainly that `private` needs `SPOOR_HTTP_BIND=127.0.0.1`. The compose default bind stays `0.0.0.0`, because plain HTTP on one port is the BRIEF's default deployment and a 127.0.0.1 default would break it; a fixed compose subnet is an owner option (questions) | docs only (no behaviour change) | `.env.example`, `docs/operations.md` §4 |
| S8 | m | committed `.mcp.json` URL never compared with `SPOOR_URL`; the design over-claims | **applied**. `mcpUrlMismatch` warns in `spoor status` and as a SessionStart status line when `mcpServers.spoor.url` is not `<SPOOR_URL>/p/<slug>/mcp`; auth-and-security.md §12 now names committed `.mcp.json` and hooks as trusted inputs | `info.test.ts` "warns when the committed .mcp.json sends the token to another URL"; `hooks.test.ts` "warns about a .mcp.json that sends the token to another URL" | `ctx.ts`, `cmd/info.ts`, `cmd/session.ts`; auth-and-security.md |

## DoD compliance

| # | sev | finding | disposition | regression test | where |
|---|---|---|---|---|---|
| D1 | B | the README quick start fails: default image `ghcr.io/OWNER/...` is not a valid Docker reference | **fixed**, reproduced the reasoning (`docker compose config` now resolves `spoor-memory:local`). Default `SPOOR_IMAGE` is the local tag `spoor-memory:local` in compose and `.env.example`; published images are documented as `ghcr.io/<owner>/spoor-memory:<version>` (lowercase). New `ci.yml` job `compose-smoke` (also run by releases) does what an operator does and closes H13; its steps passed locally with the real image | `ci.yml` job `compose-smoke` (run locally: up `--wait` exit 0, `/healthz` ok, login 200) | `docker-compose.yml`, `.env.example`, `.github/workflows/ci.yml`; operations.md §2-3, deployment.md §3/§5/§6.1, README, dod-status DoD 1 and 7 |
| D2 | B | the install doc cannot be followed: `spoor-memory@0.0.0` is not on npm | **fixed for what code can fix**: a non-release server version (`0.0.0`) renders install.md with the source install (`pnpm install && pnpm --filter spoor-memory build && npm i -g ./packages/cli`) and no `npm i -g spoor-memory@0.0.0`; the README and CLI README describe the same pre-release path; dod-status DoD 2 says "blocked on the first npm publish" for the npm path. Publishing (bump to 0.1.0, `NPM_TOKEN`, tag) is an owner action | `templates.test.ts` "a development server (0.0.0) explains the source install and renders no npx fallback" | `install/templates.ts`, `shared/install.ts` `isReleaseVersion`; README, cli README, dod-status |
| D3 | M | `- **Status:** …` (this repo's own ADR header) not parsed: superseded/proposed ADRs import as accepted | **fixed**. One body-field reader `bodyField(body, key)` allows `*`/`_` emphasis around the key and the colon (inline, list item or heading form, or a `## Key` section); `statusFromSection` uses it | `markdown.test.ts` "reads bold-bullet and emphasised headers" (also parses every ADR of `docs/adr/` to the status its header names); `push.integration.test.ts` "bold-bullet ADR headers" | `server/src/modules/items/markdown.ts` |
| D4 | M | install doc offers `npm i -D` but PostToolUse and Stop have no fallback for a local install | **fixed by removing the option** from install.md, cli-and-hooks.md §1 and §9 (rather than adding `./node_modules/.bin` fallbacks: one supported path, and no hook executing code from `node_modules` of whatever checkout it runs in). install.md says to install globally because the hooks look for `spoor` on the PATH | `templates.test.ts` "offers no dev-dependency install" | `install/templates.ts`; cli-and-hooks.md |
| D5 | M | imported ADRs never reach "Decisions (30d)": `decided_on` only from a `date:` key | **fixed**. Without a `date` key, push and `adr/import` take the first real `YYYY-MM-DD` of a `Date:` line or `## Date` section (`dateFromSection`) | `markdown.test.ts` "dateFromSection"; `push.integration.test.ts` "bold-bullet ADR headers" asserts `decided_on` and the digest's `## Decisions (30d)` with the accepted ADR and without the superseded and proposed ones | `items/markdown.ts`, `items/push.ts` |
| D6 | m | dod-status DoD 4 overstates component-test coverage | **applied**. The gap column now lists exactly which admin pages have component tests and which only server tests; new component tests for the export/import panel and the undrafted tab; a Playwright step re-imports the exported zip into a new empty project. Audit pages, embedding panel, admin projects and invites still have no component test (stated) | `ExportImportPanel.test.tsx` (new, 4 tests); `fullstack.spec.ts` "the export re-imports into a new, empty project from the settings page" | dod-status.md |
| D7 | m | the import panel points to "create a new project from the archive", which the UI cannot do; folder imports blocked on non-empty projects | **applied**. The panel text now says to create an empty project first; the unused `importNewProject` / `useImportNewProject` helpers were removed (the API stays, operations.md §6 says it is API-only); folder imports: gap c | covered by `ExportImportPanel.test.tsx` | `ExportImportPanel.tsx`, `api/endpoints.ts`, `api/hooks.ts`; operations.md |
| D8 | m | `spoor status` prints no role and "expiry unknown" for a token without expiry | **applied** (with A7). `spoor login` stores the whoami role and `no_expiry`; `spoor status` prints `role … (at login; --remote asks the server)` and `no expiry`; `--remote` adds the expiry; install.md step 5 and the READMEs point at `spoor status --remote` | `info.test.ts` "shows the role and no expiry recorded at login", "--remote adds whoami with the expiry" | `cmd/setup.ts`, `cmd/info.ts`, `state.ts` |

## Agent UX

| # | sev | finding | disposition | regression test | where |
|---|---|---|---|---|---|
| A1 | M | SessionStart `npx --yes spoor-memory@<v>` fallback asks the public registry for an unregistered name | **fixed in code**: the `npx` fallback is rendered only for a release version (`x.y.z`, not `0.0.0`); otherwise `|| exit 0`. Registering the name (or a scoped name) before the first release is an owner action, now in operations.md §10 and ADR 0013's update note. `--yes` is kept: npx assumes it anyway without a TTY | `templates.test.ts` (dev server has no `npx`), `setup.test.ts` "a development server (0.0.0) gets no npx fallback" | `shared/install.ts`; operations.md §10, ADR 0013 |
| A2 | M | the token estimator undercounts Claude tokens by ~45 % | **fixed at the root**: the Latin weight is now 1/2.2 (was 1/3.5), calibrated on the reviewer's measured samples (digest 4,980 chars = 2,204 Claude tokens, tools/list 7,497 chars = 3,307); the new weight slightly over-counts both, so `est ≤ budget` holds in real tokens. The tools/list regression ceiling becomes 3,500 estimated (same contract). The digest at budget 1500 now holds about two thirds of the lines it did; whether to raise the default budget, and whether `alwaysLoad` is worth ~3.3k tokens, are owner questions | `tokens.test.ts` "counts ASCII at 1/2.2", "never undercounts the measured Claude samples"; `tools.test.ts` ceiling 3,500; `digest.test.ts` (all guarantees still hold) | `shared/src/tokens.ts`; search-and-digest.md §6/§7/Measured, mcp.md §5, cli-and-hooks.md §7.1, ADR 0010 update, agent-guide §7 |
| A3 | M | the CLI's own pushes (drafting, replay, sweep) suppress the Stop nag | **fixed**. Those pushes send the User-Agent `spoor-cli/<v> (auto)` (stored as the client name); `activity` skips `via='cli'` rows whose client name ends in ` (auto)`. A PostToolUse push after the agent's Edit still counts (the agent did record) | `mirror.integration.test.ts` "does not count the CLI's own automatic pushes"; `hooks.test.ts` (replay and sweep send `(auto)`); `draft.test.ts` (drafting sends `(auto)`); e2e "a draft the CLI pushes on its own does not count as recording: the next Stop still nags" | `cli/src/ctx.ts`, `cmd/session.ts`, `cmd/draft.ts`, `server/src/modules/mirror/service.ts`; api.md §7.2, cli-and-hooks.md §5.2 |
| A4 | M | a viewer token is nagged and told to record; MCP instructions tell viewers to record | **fixed**. Login stores the role; Stop does nothing (no nag, no drafting) for a `viewer` login; read-only MCP sessions get `READ_ONLY_INSTRUCTIONS` without the recording sentence; the login and install.md hint now steer agents that should record away from read-only | `hooks.test.ts` "a read-only (viewer) login gets no nag and no drafting"; `tools.test.ts` "gives viewers the three read tools only, and instructions without the recording sentence" | `cmd/session.ts`, `cmd/setup.ts`, `mcp/tools.ts`, `mcp/server.ts`; mcp.md §3 |
| A5 | M | `spoor_remember` without `type` fails with a misleading error | **fixed**: an MCP create without `type` is a `fact` (REST keeps requiring it); the description says "(type, default fact)" | `mcp.integration.test.ts` "observations expire; a create without type is a fact" | `mcp/handlers.ts`, `mcp/tools.ts`; mcp.md |
| A6 | M | the generic-client section omits `SPOOR_PROJECT` and the `claude` drafting default; the notice does not name the missing variable | **fixed**. install.md §10 renders `export SPOOR_URL=… SPOOR_PROJECT=… SPOOR_TOKEN=$SPOOR_TOKEN_<SLUG>` (or a committed `spoor.config.json`) and says to set `SPOOR_DRAFT_CMD` without Claude Code; the notice is `not configured for this repo (missing SPOOR_PROJECT)` | `templates.test.ts` (generic section), `info.test.ts` "names only the missing values" | `install/templates.ts`, `cli/src/ctx.ts`; cli-and-hooks.md §3.2/§9 |
| A7 | m | `spoor status` reports "network ok" without contacting the server | **applied** with D8: the line is `breaker  closed (hooks use the network)` / `open until …`; reachability is `--remote` | `info.test.ts` | `cmd/info.ts`; cli-and-hooks.md §4.10 |
| A8 | m | install doc: restart before imports, verify and commit; "Ask the agent" in an agent doc | **applied**: login → import → verify the CLI → commit → restart and approve, then call `spoor_context` | `templates.test.ts` "keeps the section order of the outline: everything the CLI does comes before the restart" | `install/templates.ts`; cli-and-hooks.md §9 |
| A9 | m | login reports "unchanged .gitignore" after creating it; no next step | **applied**: login prints `wrote .claude/settings.local.json (mode 0600, never commit it)`, `created|updated .gitignore` and `Next: spoor adr import && spoor docs import` | `setup.test.ts` device-flow test | `cmd/setup.ts` |
| A10 | m | the `~` marker is explained nowhere | **applied**: the framing line ends `A ~ after an id: agent-written, not yet reviewed.` and the MCP instructions say the same | `format.test.ts`, `mcp.integration.test.ts`, `search.integration.test.ts`, `digest.test.ts` (budget of the header-only test raised for the longer line) | `search/digest.ts`, `mcp/tools.ts`; mcp.md, search-and-digest.md, cli-and-hooks.md, auth-and-security.md |
| A11 | m | `spoor_get` / `spoor_search` spend tokens on redundant content | **applied in part**: `spoor_get` drops `spoor_id` (the header has `id=`), `lifecycle` when `active` and empty `tags`/`anchors`. **Rejected**: flow-style lists (the serializer is shared with the export format, which must stay byte-stable) and stripping headings from search snippets (snippets come from chunk text, where the heading path is the context of the hit; low value against a search-ranking change) | `format.test.ts`, `mcp.integration.test.ts` "spoor_get: framing line, frontmatter, …" | `mcp/format.ts`; mcp.md §4 |
| A12 | m | drafts ignore the repo's ADR style; renumbering leaves a stale numbered H1 | **applied in part**: the renumber write-back rewrites `# <n>.` and `ADR-<n>` in the body H1 (no more warning). **Rejected for now**: a style hint in the drafting prompt, because cli-and-hooks.md §6.1 fixes the instruction as exact text and the validator requires the `# Title` / `## Decision` shape; changing that contract is an owner decision (questions) | `mirror.test.ts` import test now expects `# ADR-0004: Second`; `writeback.test.ts` "rewriteAdrH1" | `writeback.ts`, `mirror.ts`; cli-and-hooks.md §4.2 |
| A13 | m | drafted ADRs arrive silently | **applied**: SessionStart prints one status line per new draft (`… waits for a human to accept (status: proposed): <path> (ADR-n) [fallback template: needs writing]`), once (`state.drafted.announced`) | `hooks.test.ts` "announces new ADR drafts once, flagging fallback templates"; e2e SessionStart test | `cmd/session.ts`, `cmd/draft.ts`, `state.ts`; cli-and-hooks.md §5.1 |

## Gaps left by phase 4

| # | gap | disposition | test | where |
|---|---|---|---|---|
| Ga | cookie endpoint for undrafted decisions and a review-queue section | **closed**: `GET /api/v1/projects/:slug/decisions/undrafted` (any member, `mine` defaults to `false`; same service as the bearer list, now typed `UndraftedDecisionsResponse` in `@spoor/shared`), and a read-only "Undrafted decisions" tab in the review queue | `routes.integration.test.ts` "GET /api/v1/projects/:slug/decisions/undrafted (cookie twin, review queue)"; `ReviewPage.test.tsx` "the Undrafted decisions tab …" | `jobs/review.ts`, `jobs/routes.ts`, `shared/api/review.ts`, `web/src/pages/review/ReviewPageImpl.tsx`, `api/{endpoints,keys,hooks}.ts`; api.md §8, web-ui.md §7 |
| Gb | dashboard "Preview digest" | **already closed** before this review: `pages/DigestPreview.tsx`, `DashboardPage.test.tsx` and `fullstack.spec.ts` "the dashboard counts the items and previews the digest" (both green) | existing | — |
| Gc | import UI: manifest-less archive into a non-empty project; lossless only into an empty one | **closed**: the form is always offered; the server keeps refusing a full export into a non-empty project (409 `project_not_empty`), which the panel explains | `ExportImportPanel.test.tsx` (4 tests) | `ExportImportPanel.tsx`; web-ui.md §8, user-guide |
| Gd | web README and `types.ts` re-export `@spoor/shared` types | **closed**: every shared type is re-exported or aliased (`LoginBody = LoginRequest`, `DeviceLookup = DeviceLookupResponse`, enums from the shared constants, `REVIEW_SECTIONS` re-exported); no local copy remains | `pnpm typecheck` (web) | `web/src/api/types.ts`, `web/README.md` |

## Readiness notes

| note | disposition |
|---|---|
| workflows never ran on GitHub (no remote, no commit) | not a defect; owner action (push a branch). `actionlint` passes on both files |
| `NPM_TOKEN`, version bump to 0.1.0, GHCR visibility | owner actions, operations.md §10 (now also: register the npm name first) |
| no `repository` field committed (set at publish) | by design (ADR 0013) |
| root `pnpm exec playwright` fails | by design; ci.yml and deployment.md §6.1 use `--filter @spoor/web` |
| release.yml on tags only | by design, recorded in deployment.md §6.2 |
| H11 went one step further | kept (tested) |
| `pnpm pack` rewrites the `@spoor/shared` devDependency to `0.0.0` | rejected as a defect: devDependencies are never installed by consumers |
| concurrent whole-file writes by other nodes | every edit in this review was a targeted replacement on the current file |
| H13 compose smoke | **fixed** (D1: `compose-smoke` job) |
| `permissions.allow` in settings.local.json | owner question (bypasses the trust dialog on purpose or not) |
| interactive session after the trust dialog untested | unchanged; needs a person |
| only Claude Code run for real; Gemini CLI replaced by Antigravity CLI for unpaid users | owner question (whether to add Antigravity to install.md; nothing here was verified against it) |
| SessionStart `npx` pins `0.0.0` (H7) | **fixed** (A1) |
| H7, H14, H15, H16 | already fixed by phase 5 (deviations §H) |
| ADR-0012 still Proposed | owner decision |
| no "import as a new project" screen | documented as API-only (D7) |
| deployment.md read as design | status line updated; §6.1 lists the compose job |
| digest e5 count above `est`; the "15 % below" claim | resolved by A2 (calibrated to Claude's tokenizer; claim removed) |
| anchored tier gets only 6-7 lines at 1500 with many pinned items | owner question (tier shares, I37); A2 makes every tier smaller at the same budget |
| budget 2500 fills only 64-88 % | not a defect (tier caps run out of candidates) |
| tools/list larger than the digest | owner question (`alwaysLoad`, A2) |
| dedupe title-only probe 8/10 | informational, no change |
| shared test container left up | still up after this review's runs (`pnpm test:db:down` when no other session needs it) |

## Questions for the owner

1. Register the npm name `spoor-memory` (or move to a scoped name) now, then do the first release (versions to 0.1.0, `NPM_TOKEN`,
   tag, GHCR visibility). Until then a teammate needs the source install, and DoD 2's npm path is blocked.
2. Token budget after the calibration (A2): keep the default digest budget at 1,500 real tokens (about two thirds of the earlier
   content) or raise the project default (for example to 2,200, the old real cost)?
3. `alwaysLoad` costs about 3,300 Claude tokens per session (writer tool list): keep, slim the descriptions and schemas, or let
   Claude Code defer the tools?
4. `SPOOR_TRUST_PROXY` (S7): keep the documentation fix, or give the compose network a fixed subnet and trust only Caddy's address?
5. Drafting style (A12): may the exact drafting instruction (cli-and-hooks.md §6.1) change to follow the repo's newest ADR's
   heading style?
6. Should `spoor login` add `mcp__spoor` to `permissions.allow` in `.claude/settings.local.json` (lets `claude -p` in untrusted
   checkouts use the tools without the trust dialog)?
7. Add Antigravity CLI to install.md's generic-client section (unverified here)?
8. Accept ADR-0012 (still Proposed) and decide G12 (export cap above the import cap).
