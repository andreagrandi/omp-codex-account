# omp-codex-account

**omp-codex-account** for [Oh My Pi](https://ohmy.pi) (OMP) — save, switch, inspect, and manage multiple OpenAI Codex (ChatGPT) OAuth accounts.

This [fork](https://github.com/andreagrandi/omp-codex-account) is based on [fadilsflow/pi-codex-account](https://github.com/fadilsflow/pi-codex-account). It adds Oh My Pi (OMP) credential storage support and is maintained independently.

## Problem

Your AI coding agent stores one `openai-codex` login at a time. If you have multiple Codex accounts — work, personal, team — switching between them means re-authenticating every time. This extension saves named snapshots of your Codex OAuth credentials and swaps the active login on demand.

## Storage

**omp-codex-account** uses the OMP SQLite credential store:

- Active credentials are saved in `~/.omp/agent/agent.db`.
- Named account snapshots are saved as JSON files in `~/.omp/codex-accounts/`.

Optional environment variables can override these OMP locations:

- `OMP_AGENT_DB_PATH` — OMP agent database path (default `~/.omp/agent/agent.db`)
- `OMP_CODEX_ACCOUNTS_DIR` — account snapshot directory (default `~/.omp/codex-accounts`)

## Install

### From GitHub (Oh My Pi)

```bash
omp plugin install https://github.com/andreagrandi/omp-codex-account
```

### From a local checkout

```bash
git clone https://github.com/andreagrandi/omp-codex-account.git
cd omp-codex-account
omp plugin install .
```

After installing or updating the extension, reload OMP:

```text
/reload
```

## Commands

Use `/codex` without arguments to open the interactive account picker.

| Command | What it does |
|---|---|
| `/codex save <label>` | Save the current Codex login under a label. |
| `/codex switch <label>` | Switch to a saved login and reload OMP. |
| `/codex list` | List all saved logins. |
| `/codex current` | Show the active (in-use) login. |
| `/codex usage` | Query usage for the active login from ChatGPT's usage endpoint. |
| `/codex status` | Show active logins and storage backend details. |
| `/codex debug-db` | Inspect internal credential rows in the OMP agent database. |
| `/codex rename <old> <new>` | Rename a saved login. |
| `/codex remove <label>` | Delete a saved login. |

`/codex-account` is also a registered alias.
`/codex switch` (or `/codex use`) will try to match an unknown token as a label, so `/codex personal` is a shortcut for `/codex switch personal`.

Short aliases: `ls` = `list`, `mv` = `rename`, `rm`/`delete` = `remove`, `active` = `current`, `use` = `switch`.

## Typical flow — two accounts

```text
/login openai-codex
/codex save work

/login openai-codex   ← authenticate with your personal account
/codex save personal

/codex switch work    ← back to work credentials
/codex current        ← verify active login
```

Now you can flip between both accounts any time with `/codex switch work` or `/codex switch personal`.

## Diagnostics

### /codex status

Shows the active storage backend, how many credentials are stored, and which label is currently active.

### /codex debug-db

When running on OMP, shows SQLite table names, column names, and the `openai-codex` row count. It intentionally does **not** print OAuth token values.

### Usage check

If `/codex usage` reports an expired token, send one model request first to let the agent refresh the credentials, then run `/codex usage` again.

## Security

The OMP credential store contains OAuth tokens that grant access to your OpenAI Codex account. **Never** commit, share, or copy `~/.omp/agent/agent.db` or files in `~/.omp/codex-accounts/` to untrusted machines.

### Backups

Before every SQLite write, the OMP backend creates:

```text
~/.omp/agent/agent.db.bak.<timestamp>
```

Named snapshots are plain JSON files in `~/.omp/codex-accounts/`. To restore them, place the files back in that directory and run `/reload` in OMP.

## Acknowledgments

This project builds on [fadilsflow/pi-codex-account](https://github.com/fadilsflow/pi-codex-account). The upstream project is credited for the original account-switching extension; the OMP-specific changes in this fork are maintained here.

## Development

```bash
git clone https://github.com/andreagrandi/omp-codex-account.git
cd omp-codex-account
bun install
omp plugin install .
bun run typecheck    # TypeScript type checks
bun test             # Run test suite
```

The Pi extension manifest lives in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Compatibility

Legacy Pi JSON credential storage remains supported for existing installations; OMP SQLite is the primary documented storage backend.
