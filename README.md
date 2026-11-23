# secretmgr

Keep secrets out of AI agent chats. A local vault, a dashboard, shell integration and an MCP server.

Instead of pasting `DATABASE_URL=...` into Claude Code, you store it once. The agent writes
`PGPASSWORD="$PG_PASS" psql ...`, the shell expands the variable, and the value never appears in the
conversation. Output is redacted on the way back.

## Quick start

Requires Node 22 or newer.

```bash
npm install
npm run build:dashboard        # builds the React UI into dashboard/dist
npm link                       # puts `secretmgr` on your PATH (optional)
secretmgr init                 # vault + shell hooks + Claude Code hook and MCP server (asks first)
secretmgr dashboard            # prints a one-time URL; open it
```

Open a **new** terminal afterwards. `secretmgr uninstall` removes every hook; your vault is left alone.

## How it works

| Piece | What it does |
|---|---|
| **Vault** | `~/.secretmgr/vault.enc`, AES-256-GCM. Names and values are both encrypted. The master key lives in the OS keychain (libsecret / macOS Keychain / Windows DPAPI) and falls back to a `0600` file. |
| **Groups and environments** | A group (a project) holds environments (`dev`, `uat`, `prod`, add your own). Every variable has one value per environment and one agent access level per environment: `none`, `use`, `write`. |
| **Your terminals** | `secretmgr install` adds a hook. On every prompt it compares one line in `~/.secretmgr/version` using shell built-ins, and calls `secretmgr` only when something changed. `secretmgr use uat` switches environment. cmd has no prompt hook: type `sm`. |
| **Agent Bash commands** | A Claude Code `PreToolUse` hook wraps each command. Inside an isolated subshell it strips inherited secrets, loads the active environments, and pipes output through the redactor. The original command stays visible in permission prompts. |
| **MCP server** | `activate_env`, `deactivate_env`, `list_envs`, `list_vars`, `set_var`, `status`, `run_with_secrets`. Tools return variable **names** only, never values. |
| **Kill switch** | Dashboard button or `secretmgr kill`. Clears active environments, empties terminals on their next prompt, and agent commands run with nothing loaded. |

### Two environments at once
Every active environment exposes suffixed names (`PG_PASS__DEV`, `PG_PASS__PROD`). The primary environment also
exposes the plain name (`PG_PASS`).

### Guidance per environment
Each environment has a guidance level the agent is told when it calls `activate_env`, and which every command
banner repeats (`[secretmgr env=dev:FULL*,prod:READ-ONLY]`):

- **Read-only**: only read; change nothing; stop and ask.
- **Write**: may write; no destructive operations.
- **Full**: may operate; ask before anything destructive.

With **Enforce** on, the Bash hook also blocks commands that reference that environment's variables and look
mutating (read-only) or destructive (write): SQL, redis-cli, kubectl, terraform, helm, docker, git push, aws,
curl with a write method, migration tools. Full only advises.

## Commands

```
secretmgr init | install | uninstall | dashboard
secretmgr use <env> [group]        (shell function) load an environment into this terminal
secretmgr unload                   (shell function)
secretmgr shell --env <env>        subshell with an environment loaded
secretmgr set KEY --env dev        value from a hidden prompt or stdin, never argv
secretmgr import .env --env dev [--dry-run] [--delete-source]
secretmgr export --env dev         (interactive terminals only)
secretmgr reveal KEY --env dev     (interactive terminals only)
secretmgr list --env dev | group create <name> | group list | status
secretmgr kill [--off]
```

## What this protects against, and what it does not

It prevents **accidental** exposure and prompt-injection-driven exfiltration through the chat. It is not a sandbox.

- The agent runs as your OS user. A determined agent could try to read the key file or the keychain. Keep `prod` at
  `none` for agents, use read-only database users, and turn on approval for sensitive environments.
- Redaction matches known values and their base64, URL-encoded and JSON-escaped forms. A command that transforms a value
  (`echo $X | rev`) can defeat it. The Bash hook blocks the obvious print commands (`env`, `printenv`, `echo $SECRET`,
  reads of `~/.secretmgr`), but that list is a heuristic.
- Guidance enforcement is a heuristic over the command text. It cannot see SQL inside a file, or a script that does
  something harmful. Use real permissions (database roles, IAM) for hard guarantees.
- `secretmgr env`, `reveal` and `export` refuse to run without an interactive terminal, so the agent's Bash tool cannot call them.
- The dashboard binds to `127.0.0.1`, needs a one-time bearer token, and checks `Host` and `Origin` headers.
- Output is only redacted for secrets the vault knows. A secret you pasted into the chat earlier is already in the context.

## Status

Tested on Linux (bash, zsh) with automated tests (`npm test`): vault, redaction, policy, Bash wrapper, hook,
shell hooks, installer, API, MCP over stdio, guidance rules.
**Written but not tested on real systems:** macOS Keychain, Windows DPAPI, PowerShell, fish, cmd (`sm`), the
macOS and Windows terminal launchers for "Open shell".

Claude Code hook behaviour to verify on your version (`claude --debug`): the hook returns `updatedInput`
nested inside `hookSpecificOutput`. By default it does **not** set `permissionDecision`, so your normal permission
prompts stay in charge. To auto-approve wrapped commands, set `{"hookAutoApprove": true}` in `~/.secretmgr/config.json`.

## Releasing

Releases are published by GitHub Actions with npm trusted publishing (no stored token) and signed provenance:

```bash
npm version patch          # or minor / major: bumps package.json, commits, tags
git push --follow-tags     # the tag triggers .github/workflows/release.yml
```

## Development

```bash
npm test                              # unit and end-to-end tests (isolated temp HOME)
secretmgr dashboard --no-open         # API on :7777
npm run dev -w dashboard              # Vite dev server on :5173 with /api proxy
```
