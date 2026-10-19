# Claude Code harness facts (for Spoor install doc, hooks, CLI)

Researched 2026-10-19. Docs fetched from code.claude.com (WebFetch) and cross-checked by experiments
against local Claude Code 2.1.303 (npm `@anthropic-ai/claude-code`: 2.1.302 released 2026-10-16T16:48Z,
2.1.303 released 2026-10-18T21:15Z; dist-tag latest=2.1.303, stable=2.1.292). Tested behaviour is marked
[TESTED]. Everything else is quoted/paraphrased from docs. No npm package is needed for this topic.

## 1. .mcp.json (project scope) and env expansion
Source: https://code.claude.com/docs/en/mcp
```json
{ "mcpServers": { "api-server": {
    "type": "http",
    "url": "${API_BASE_URL:-https://api.example.com}/mcp",
    "headers": { "Authorization": "Bearer ${API_KEY}" } } } }
```
- Syntax: `${VAR}` and `${VAR:-default}` only.
- Expanded in: `command`, `args`, `env`, `url`, `headers`. (`headersHelper` is not in the list.)
- Unset var without default: config still loads, warning in `claude mcp list`, literal `${VAR}` text is sent.
- Gotcha: some names are read as EMPTY in remote `url`/`headers` (Claude's own credentials such as
  ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN, AWS_BEARER_TOKEN_BEDROCK, HTTPS_PROXY, NPM_TOKEN). `SPOOR_TOKEN`
  is fine ("A name outside this set, such as `API_KEY`, expands as written").
- `type` is required for url entries (`--mcp-config` validation skips `url` entries with no `type`).
- Approval: interactive sessions prompt before using project-scoped `.mcp.json` servers
  (`claude mcp reset-project-choices` resets). "In `claude -p` runs ... Claude Code can't show that prompt:
  it loads project-scoped servers without asking." Unapproved: "Pending approval (run `claude` to approve)".
  A repo cannot approve its own servers via committed `enableAllProjectMcpServers` in untrusted folders.
- `headersHelper` (alternative): `"headersHelper": "/opt/bin/get-mcp-auth-headers.sh"`; script prints a JSON
  object of string headers to stdout, 10 s timeout, runs on every connection, re-run on 401/403 and retried
  once, overrides static `headers`; for project .mcp.json it runs only after trust dialog accepted.
  Env given to helper: CLAUDE_CODE_MCP_SERVER_NAME, CLAUDE_CODE_MCP_SERVER_URL. Useful fallback if
  `${SPOOR_TOKEN}` expansion ever fails (helper could read token from a file).
- `alwaysLoad: true` on a server loads its tools upfront (otherwise MCP tools are deferred behind tool
  search, one extra round trip). Startup then waits up to 5 s for that server. Consider for Spoor.

## 2. settings.json / settings.local.json and env
Sources: https://code.claude.com/docs/en/settings , https://code.claude.com/docs/en/env-vars
- Precedence (high to low): managed, `--settings`, `.claude/settings.local.json`, `.claude/settings.json`,
  `~/.claude/settings.json`.
- `.claude/settings.json` = committed, shared. `.claude/settings.local.json` = personal, "Claude Code keeps it
  out of git when it creates the file; if you create it by hand, add it to `.gitignore` yourself". Claude
  Code adds `**/.claude/settings.local.json` to the GLOBAL git excludes (core.excludesFile) the first time it
  writes it, so a repo's own .gitignore may not list it. [TESTED: ignored via ~/.gitignore_global only.]
  => The install doc/CLI must append `.claude/settings.local.json` to the repo `.gitignore` itself.
- `env` key: `{ "env": { "SPOOR_TOKEN": "..." } }`. Docs: "Claude Code reads them directly from the file, so
  they take effect no matter how `claude` was launched"; values copied as written (no shell, no `$HOME`).
  Settings value overrides the same var from the shell in most sessions. A running session applies new/changed
  values on save; removal needs relaunch.
- Gotcha: "most `env` values apply only after each teammate trusts the folder" (permissions.allow etc. too).
- [TESTED 2.1.303] `.claude/settings.local.json` `env.SPOOR_TOKEN`:
  - IS visible to hook commands (SessionStart hook `echo $SPOOR_TOKEN` printed the value).
  - IS used for `${SPOOR_TOKEN}` expansion in .mcp.json headers (local server saw
    `Authorization: Bearer tok-from-settings-local` and `${SPOOR_NOPE:-dflt}` -> `dflt`). Test used
    `--mcp-config .mcp.json`; a plain project-scoped load in `-p` connected lazily/too late to observe, so
    re-verify the plain project path once in an interactive session (see Gotchas).
  - `claude mcp get` prints headers unexpanded (`Bearer ${SPOOR_TOKEN}`), so tokens do not leak there.
- Variables ignored in project/local `env`: telemetry exporters, CLAUDE_CONFIG_DIR etc. Not relevant to us.

## 3. Hooks
Source: https://code.claude.com/docs/en/hooks
Config locations: `~/.claude/settings.json` (not shareable), `.claude/settings.json` (committable),
`.claude/settings.local.json` (gitignored), managed policy, plugin `hooks/hooks.json`, skill/agent frontmatter.
=> Commit hooks in `.claude/settings.json`; token in settings.local.json env.
```json
{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit",
    "hooks": [ { "type": "command",
      "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/check-style.sh", "args": [], "timeout": 30 } ] } ] } }
```
- Hook types: command (stdin JSON), http (POST body), mcp_tool, prompt, agent. A hook process inherits the
  parent env (plus settings `env`, TESTED). `CLAUDE_PROJECT_DIR` = project root. `async: true` exists for command hooks.
- Matcher: `"*"`, `""` or omitted = all. Only `[A-Za-z0-9_- ,|]` = exact name or list split on `|` or `,`
  (`Edit|Write`). Any other char = unanchored JS regex (`^Notebook`, `mcp__memory__.*`). Matches tool_name
  (tool events); Stop/UserPromptSubmit take no matcher.
- Timeout: seconds per handler; defaults 600 (command/http/mcp_tool; 30 on UserPromptSubmit), 30 prompt, 60 agent.
- Common stdin fields: `session_id`, `transcript_path` (written async, may lag), `cwd`, `hook_event_name`,
  also `prompt_id`, `permission_mode`, `effort`, `agent_id`, `agent_type`, `scratchpad_dir`.
- SessionStart extra: `source` = startup|resume|clear|compact|fork; optional `model`, `agent_type`, `session_title`.
- Stop: `stop_hook_active` (true when already continuing because of a stop hook), `last_assistant_message`,
  `background_tasks`, `session_crons`. Example:
```json
{ "session_id":"abc123","transcript_path":"~/.claude/projects/.../x.jsonl","cwd":"/Users/...",
  "permission_mode":"default","hook_event_name":"Stop","stop_hook_active":true,
  "last_assistant_message":"I've completed the refactoring..." }
```
- PostToolUse: `tool_name`, `tool_input` (Write: `file_path`, `content`; paths always absolute), `tool_response`
  (Write: `{filePath,type}`), `tool_use_id`, `duration_ms`. Fires only after success.
```json
{ "hook_event_name":"PostToolUse","tool_name":"Write",
  "tool_input":{"file_path":"/path/to/file.txt","content":"..."},
  "tool_response":{"filePath":"/path/to/file.txt","type":"create"} }
```
- UserPromptSubmit: `prompt` (a typed `/cmd args` arrives as typed, not expanded).
- Adding context:
  - Plain stdout is added to Claude's context for SessionStart, UserPromptSubmit, UserPromptExpansion,
    PostModelSwitch ("A hook that only adds context can print it without building JSON"). For other events
    stdout goes only to debug log. [TESTED: SessionStart stdout appears as hook_response output.]
  - JSON: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`; same shape for
    PostToolUse/Stop/UserPromptSubmit. Each string capped at 10,000 chars. Phrase as facts, not commands.
- Blocking Stop: exit 0 + `{"decision":"block","reason":"..."}` (reason required, shown to Claude), or exit 2 with
  stderr as the reason. "Choose one approach per hook." Stop may instead give non-error
  `hookSpecificOutput.additionalContext`. Cap: after 8 consecutive stop-hook continuations the next block is
  overridden (env CLAUDE_CODE_STOP_HOOK_BLOCK_CAP). Check `stop_hook_active` to avoid loops; Spoor also uses a marker file.
- PostToolUse can return `decision:"block"`, `additionalContext`, `updatedToolOutput`; exit 2 only shows stderr.
- Gotcha: a hook that shells out to `claude -p` re-triggers project hooks (SessionStart/Stop) in the child
  session -> recursion risk. See section 6 for safe flags.

## 4. `claude mcp add` (HTTP + header)
```bash
claude mcp add --transport http spoor https://HOST/p/<slug>/mcp \
  --header "Authorization: Bearer $SPOOR_TOKEN" --scope project
```
`--header` short form `-H`. `--scope project` writes `.mcp.json`, but then the literal token (or, if the shell
does not expand, `${SPOOR_TOKEN}` when single-quoted) is written; to keep secrets out of the file, quote it
`'Authorization: Bearer ${SPOOR_TOKEN}'` or just write `.mcp.json` directly (recommended, deterministic).
Related: `claude mcp get|list|remove`, `claude mcp reset-project-choices`, `claude mcp add-json`.
Source: https://code.claude.com/docs/en/mcp , https://code.claude.com/docs/en/cli-reference

## 5. OAuth for remote HTTP MCP, token reuse
- `/mcp` -> follow browser steps; shell: `claude mcp login <name>` (`--no-browser` over SSH, paste redirect URL),
  `claude mcp logout <name>`. Random callback port unless `--callback-port`; `--client-id/--client-secret` for
  servers without DCR. "Authentication tokens are stored securely and refreshed automatically"; on 401 it
  refreshes and retries once. Docs do not state the MCP token file; client secrets live in the macOS keychain
  or a credentials file (this machine has both a keychain entry and ~/.claude/.credentials.json for Claude's own login).
- If `Authorization` is set via `headers`/`headersHelper`, a 401/403 is reported as a failed connection, no OAuth
  flow is started. So Spoor's static bearer token and Claude's OAuth are independent.
- Reuse by hooks/CLI: NO documented API; token is private to Claude Code. Hooks cannot read it. Spoor must hold
  its own token (device login -> `env.SPOOR_TOKEN`). Confirms the BRIEF design.

## 6. `claude -p` one-shot drafting
Sources: https://code.claude.com/docs/en/headless , https://code.claude.com/docs/en/cli-reference
```bash
git diff | claude -p --model haiku --output-format json "prompt"   # stdin piped, cap 10MB
claude -p ... --output-format json | jq -r '.result'                # also session_id, total_cost_usd
```
- `--output-format`: `text` (default) | `json` | `stream-json` (needs `--verbose`). `--json-schema` gives
  `structured_output`. `--model` aliases: sonnet, opus, haiku, fable, or full id. Exit 0 ok, non-zero on failure;
  auth failures print as result on stdout.
- Useful: `--no-session-persistence`, `--max-turns`, `--tools ""` (no tools), `--max-budget-usd`,
  `--append-system-prompt`, `--permission-prompts none`.
- Recursion/side effects: without `--bare`, `-p` loads the project's hooks, `.mcp.json`, CLAUDE.md. `--bare`
  skips them but "never reads OAuth credentials or the system keychain": needs `ANTHROPIC_API_KEY`, so it
  breaks for subscription users. `--safe-mode` disables hooks/MCP/CLAUDE.md/skills yet keeps auth.
  [TESTED 2.1.303] `echo ... | claude -p --model haiku --safe-mode --no-session-persistence --tools "" --output-format json "Reply OK"`
  works with subscription login, cost ~US$0.0004. Check `--safe-mode` exists on the user's version (docs show no
  min version; present in 2.1.303); fall back to env guard `SPOOR_DRAFTING=1` that every Spoor hook early-exits on.
- Default configurable command in BRIEF (`claude --model haiku -p`) should become
  `claude -p --model haiku --safe-mode --no-session-persistence --tools ""` plus the recursion guard env.

## 7. Slash commands and skills (ship `/spoor-*`)
Source: https://code.claude.com/docs/en/skills
- "Custom commands have been merged into skills." `.claude/commands/x.md` and `.claude/skills/x/SKILL.md`
  both create `/x`; both keep working. Project skills: `.claude/skills/<name>/SKILL.md`, "Commit it so your team
  gets it too"; discovered from cwd up to repo root.
- Frontmatter (all optional): `name`, `description`, `when_to_use`, `argument-hint`,
  `disable-model-invocation`, `user-invocable`, `allowed-tools`. `$ARGUMENTS`, `$N` placeholders.
- Shell injection: ``!`cmd` `` or a ```! fenced block runs before the prompt is sent (disable with
  `disableSkillShellExecution`). Example: `!`spoor context --query "$ARGUMENTS"``.
- Plugins namespace as `/plugin:skill`; project files do not (plain `/spoor-context`). Recommend a project
  skill, e.g. `.claude/skills/spoor-context/SKILL.md` (+ `spoor-decide`, `spoor-status`), with
  `disable-model-invocation: true` for user-only actions. `-p` mode also expands `/skill-name` in the prompt.

## 8. Pointing Claude Code at a hosted install doc
No dedicated mechanism (no URL-based project bootstrap, no `claude install-from-url`). Practical path: user
pastes "Follow https://HOST/p/<slug>/install.md" into Claude; Claude uses the WebFetch tool.
- WebFetch (tool schema in this session): fetches URL, converts to markdown, runs the prompt through a small
  model, so the summary can lose exact snippets: the install doc should be short, with copy-exact code blocks and
  an instruction to write files verbatim. HTTP upgraded to HTTPS; cross-host redirects are returned, not followed;
  fails on localhost/dotless hosts and authenticated URLs; 15 min cache.
- Permission: WebFetch prompts per domain in default mode; allow with rule `WebFetch(domain:HOST)` in
  settings `permissions.allow`. Self-hosted http://localhost or LAN single-label hosts cannot be fetched by
  WebFetch; fallback is `curl -s URL` via Bash (also prompts). Install doc must mention both.
- Alternative: `claude -p` / shell `curl URL | claude` not needed; or ship the install as `npx spoor-memory init`.
  Permission rules reference: https://code.claude.com/docs/en/permissions

## Gotchas summary
1. settings.local.json is gitignored only through the GLOBAL excludes on the creating machine; add it to repo .gitignore.
2. `${SPOOR_TOKEN}` resolves from settings env (tested via --mcp-config); also visible to hooks. Verify plain
   project `.mcp.json` once interactively after approving the server.
3. First use of project `.mcp.json` needs per-server approval and folder trust; env values apply after trust.
4. `claude -p` inside a hook re-fires project hooks; use `--safe-mode` (keeps login) not `--bare` (API key only).
5. Stop hook block cap is 8 consecutive; use `stop_hook_active` plus marker file.
6. SessionStart stdout and `additionalContext` both reach Claude; additionalContext max 10,000 chars.
7. MCP tools are deferred by tool search by default; `alwaysLoad` avoids the lookup.
8. Local Claude Code is 2.1.303 (released 2026-10-18, newer than the 3-day cutoff); behaviour tested there.
   For documented minimums, pin guidance "2.1.302 or later".

## Recommendation
Commit `.mcp.json` (type http, `Authorization: Bearer ${SPOOR_TOKEN}`, optional `alwaysLoad`), hooks in
`.claude/settings.json` (SessionStart plain-stdout digest, Stop JSON `decision:block` with marker file and
`stop_hook_active` check, PostToolUse matcher `Write|Edit` filtering `docs/adr/*.md` and the doc list in the
script), and `.claude/skills/spoor-*/SKILL.md` for `/spoor-*` commands. Keep the token only in
`.claude/settings.local.json` `env.SPOOR_TOKEN` (CLI writes it and appends the file to repo .gitignore); hooks and
MCP headers both see it, and Claude's own MCP OAuth token cannot be reused. Draft ADRs with
`claude -p --model haiku --safe-mode --no-session-persistence --tools "" --output-format json` and a recursion
guard env. Install doc: short, copy-exact blocks, WebFetch-friendly, with a curl fallback and a
`WebFetch(domain:...)` allow hint.
