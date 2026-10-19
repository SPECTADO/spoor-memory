# Harness verification (2026-10-19)

What the install templates (`packages/server/src/modules/install/templates.ts`) and the CLI (`packages/cli`: `init`, `login`,
`hook *`) assume about the agent harnesses, checked against the vendors' current docs and, for Claude Code, against the real
`claude` 2.1.303 binary. Closes deviations.md §C (project-scope `${SPOOR_TOKEN}` expansion) and the harness rows of §E.3.

## 1. Docs check (WebFetch, 2026-10-19)

| client | what we render | current docs | result |
|---|---|---|---|
| Claude Code `.mcp.json` | `{"mcpServers":{"spoor":{"type":"http","url":…,"headers":{"Authorization":"Bearer ${SPOOR_TOKEN}"},"alwaysLoad":true}}}` | code.claude.com/docs/en/mcp: `type: "http"` + `url` + `headers`; `${VAR}` and `${VAR:-default}` expand in `url` and `headers`; an entry with `url` and no `type` is read as stdio and skipped; `alwaysLoad` is a field of `http`/`ws` entries. Credential names (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, cloud provider keys, `NPM_TOKEN`, `HTTPS_PROXY`, …) are read as empty in a remote server's `url`/`headers`; other names "expand as written" | matches; `SPOOR_TOKEN` is not a covered name (confirmed in §2) |
| Claude Code permissions | `permissions.allow: ["mcp__spoor"]` | code.claude.com/docs/en/permissions: "`mcp__puppeteer` matches any tool provided by the `puppeteer` server"; `mcp__<server>__*` is the same; rules with parentheses on `mcp__` are skipped | matches |
| Claude Code hooks block | `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","timeout":15,"command":…}]}],"PostToolUse":[{"matcher":"Write\|Edit",…}],"Stop":[…]}}` | code.claude.com/docs/en/hooks: event → matcher groups → handlers; `timeout` in seconds (default 600 for `command`); a matcher of letters/`\|` is a list of exact tool names | matches |
| SessionStart contract | stdin `session_id`, `source`, `cwd`; stdout plain text | `source` ∈ `startup`, `resume`, `clear`, `compact`, `fork`; "Claude Code adds a SessionStart hook's plain-text stdout to Claude's context" | matches (`clear` is treated like `startup`, `resume`/`fork` print nothing, as designed) |
| Stop contract | stdin `session_id`, `stop_hook_active`; stdout `{"decision":"block","reason":…}` or nothing | same fields plus `last_assistant_message`, `background_tasks`, `session_crons`; `decision: "block"` with a required `reason`; Claude Code overrides a ninth consecutive block | matches |
| PostToolUse contract | stdin `tool_name`, `tool_input.file_path`, `tool_response.filePath`, `cwd`; stdout `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":…}}` | same; Write's `tool_response` has `filePath` and `type` | matches |
| hook output cap | the CLI cuts at 9,500 characters | plain stdout and each `additionalContext` are capped at 10,000 characters; above it Claude Code stores the text in a file and passes a 2,000-character preview | matches (margin kept) |
| Cursor | `.cursor/mcp.json`: `{"mcpServers":{"spoor":{"url":…,"headers":{"Authorization":"Bearer ${env:SPOOR_TOKEN_<SLUG>}"}}}}` | cursor.com/docs/context/mcp: project `.cursor/mcp.json`, global `~/.cursor/mcp.json`; remote entries are `url` + `headers` without `type`; `${env:NAME}` is resolved in `command`, `args`, `env`, `url` and `headers` | matches |
| Codex CLI | was: `~/.codex/config.toml`, `[mcp_servers.spoor-<slug>]`, `url`, `bearer_token_env_var` | learn.chatgpt.com/docs/extend/mcp (the old developers.openai.com/codex/mcp redirects there): `~/.codex/config.toml` by default, and "you can also scope MCP servers to a project with `.codex/config.toml` (trusted projects only)"; Streamable HTTP keys `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`; no experimental flag | keys match; **fixed**: the install doc now offers the project-scoped `.codex/config.toml` (trusted projects only) first, since it tells users to prefer project-scoped files |
| Gemini CLI | `.gemini/settings.json`: `{"mcpServers":{"spoor":{"httpUrl":…,"headers":{"Authorization":"Bearer $SPOOR_TOKEN_<SLUG>"}}}}` | geminicli.com/docs/tools/mcp-server and /docs/reference/configuration: project `.gemini/settings.json`, user `~/.gemini/settings.json`; `httpUrl` = Streamable HTTP, `url` = SSE; `headers` for both; "String values within your settings.json … can reference environment variables" (`$VAR` or `${VAR}`); no underscores in server names | matches. Note: the site's banner says Gemini CLI "was replaced by Antigravity CLI on June 18th, 2026" for unpaid-tier and Google One users; we keep the Gemini CLI snippet (paid tiers still use it) and do not document Antigravity CLI yet |

## 2. Real run with Claude Code 2.1.303 (`claude -p`)

Setup: `pnpm test:db:up`; the server from source (the e2e boot: real runtime, migrations, scheduler, search, the fake embedding
provider, `SPOOR_ADMIN_EMAIL`/`SPOOR_ADMIN_PASSWORD` set) on a random loopback port against its own `spoor_harness_test`
database; admin login, `POST /api/v1/projects` (`acme`), `POST /api/v1/projects/acme/tokens` (a user token) and one pinned
memory over REST. A temp git repo, then the built CLI: `printf '%s' "$TOKEN" | spoor login --token - --server … --project acme`,
which wrote `.claude/settings.local.json` (mode 0600), `.gitignore`, and through `spoor init` the `.mcp.json` and
`.claude/settings.json` exactly as install.json renders them. `spoor` on the PATH was a shim around `packages/cli/dist/bin.js`
that also logged each hook's stdin, env and stdout. Every `claude` run had `SPOOR_TOKEN`, `SPOOR_URL` and `SPOOR_PROJECT`
removed from its environment, so the token could only come from `settings.local.json`. The folder had never been trusted.

The local claude works non-interactively (logged in; no prompt). One CLI pitfall: `--allowedTools <tools...>` is variadic, so
`claude -p --allowedTools X "prompt"` swallows the prompt ("Error: Input must be provided either through stdin or as a prompt
argument when using --print"). Put the prompt before the flag (as below) or end the list with `--`. The CLI's own drafting
command (`DEFAULT_DRAFT_COMMAND`) is not affected: its last flag before the instruction is `--output-format json`.

| run | command (cwd = the repo) | result |
|---|---|---|
| 1 | `claude -p "Call spoor_context and reply with the first line of its output" --output-format json --allowedTools mcp__spoor__spoor_context` | success, 2 turns, no permission denials. Reply: `Spoor digest acme (spoor_context output) · 1 items · ~87/1500 tok · details: spoor_get <id>`. Debug log: `MCP server "spoor": Successfully connected (transport: http)`, the tool call `completed successfully` (the server answers 401 to a missing or wrong bearer, so the header was expanded) |
| 2 | same with `spoor_search` (`--allowedTools mcp__spoor__spoor_search`) | success; first line `1 result "harness verification test database"` |
| 3 | run 1's prompt without `--allowedTools` | the call was denied (`permission_denials: [mcp__spoor__spoor_context]`); stderr: `Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["<dir>"].hasTrustDialogAccepted: true in ~/.claude.json.` |
| 4 | run 3 with `"permissions":{"allow":["mcp__spoor"]}` added to the (untracked) `.claude/settings.local.json` | success, no denials: the server-level rule `mcp__spoor` allows `mcp__spoor__spoor_context`, and an untracked local file's allow rules apply without trust |
| 5 | `claude -p "<write docs/adr/0001-cache-digests.md with this content…>" --allowedTools Write` | PostToolUse fired with `tool_name: "Write"`, `tool_input.file_path` (absolute), `tool_response` {`type`, `filePath`, `content`, `structuredPatch`, `originalFile`, `userModified`}; the hook pushed the ADR (stdout empty, exit 0) and wrote `spoor_id` into its frontmatter; the agent noticed the file change |
| 6 | `claude -p "<write src/app.txt…>" --allowedTools Write` | Stop fired with `stop_hook_active: false`, `last_assistant_message: "DONE"`; the hook printed `{"decision":"block","reason":"Spoor: this session changed files (src/app.txt) but nothing was recorded in Spoor. …"}`; Claude continued and answered "Nothing worth recording: …"; Stop fired again with `stop_hook_active: true` and the hook printed nothing. Exactly one nag |
| 7 | `printf '%s' "<24,000-char note>" \| claude -p --model haiku --safe-mode --no-session-persistence --tools '' --output-format json "<2,482-char instruction> Reply with exactly: OK"` (the CLI's default drafting command) | `result: "OK"`, about 11k input tokens (the stdin note was read); no hook fired under `--safe-mode` (no recursion into the Stop hook) |

Observed in every run:

- **`${SPOOR_TOKEN}` expansion** from the `env` block of `.claude/settings.local.json` into the project-scope `.mcp.json`
  header works, also in a folder that was never trusted. `-p` loads project-scoped servers without the approval prompt (as the
  docs say).
- **Hooks fire in `-p` mode**, in the untrusted folder, from the committed `.claude/settings.json`. Their environment carried
  `CLAUDE_PROJECT_DIR`, `SPOOR_URL`, `SPOOR_PROJECT` and `SPOOR_TOKEN` (from `settings.local.json`).
- **SessionStart** stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source: "startup"` (no `permission_mode`).
  The hook printed the digest (header line, framing line, `## Pinned`, `m1 [fact] …`) in about 230–330 ms; the transcript stores
  it as a `hook_success` attachment and the model quoted it (run 3 answered from it when the tool was denied).
- **`alwaysLoad`** is honoured: the session's other MCP servers' tools arrived as deferred tools, the `mcp__spoor__*` tools did
  not, and the model called `spoor_context` directly (2 turns, no tool search).
- **Stop** fires at every stop attempt (the end of each turn, and again after a block); the hook ran in about 140–240 ms.
- **Permission rule**: the committed `mcp__spoor` is valid syntax but is dropped until the folder's trust dialog is accepted.
  Not tested: an interactive session after accepting the trust dialog (that needs a person, or editing `~/.claude.json`, which
  this check did not do). The docs say trusted project rules apply.

## 3. Changes made

- `templates.ts` (install.md §10, §11): Codex line offers `.codex/config.toml` in the repo (trusted projects only) or
  `~/.codex/config.toml`; "check against each tool's current docs" replaced by "checked … in October 2026"; troubleshooting:
  an unresolved `${SPOOR_TOKEN}` (or a 401 from the `spoor` server) now points at a missing `SPOOR_TOKEN` in
  `settings.local.json` instead of an untrusted folder (expansion works untrusted), and a new row explains the trust gate on the
  committed `mcp__spoor` rule (accept the trust dialog, or add `mcp__spoor` to `permissions.allow` in `settings.local.json`).
  Tests in `templates.test.ts`.
- The CLI's `init`, `login` and hook code matched the docs and the observed contracts; no change.
- Docs: cli-and-hooks.md §5, §7.1, §7.2, §9 items 11–12; ADR 0010 consequences; deviations.md §C, §E.3, P3-9.

## 4. Decided (owner, 2026-10-20)

- **No**: `spoor login` does not write the permission rule into `.claude/settings.local.json`. The trust decision stays with the user; CI passes `--allowedTools` explicitly. Original question: whether `spoor login` should also write `permissions.allow: ["mcp__spoor"]` into `.claude/settings.local.json`, so the Spoor
  tools run unprompted before the folder is trusted (e.g. `claude -p` in CI or in a fresh clone). Run 4 shows it works. Not done
  here: it widens what an untrusted checkout can do without the user's trust decision, and interactive users see the trust
  dialog on first launch anyway.
