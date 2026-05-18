# dbtender

> Local-first database environment manager — snapshot, branch, and restore your dev database before migrations.

Modern ORMs like Prisma and Drizzle don't roll back migrations. `dbtender` fills that gap with Git-like snapshots and branches for your development database. One command saves your state before a migration; one command brings it back if something goes wrong.

Works with **Docker Postgres** and **PGlite**. ORM-agnostic.

---

## Install

```bash
npm install -g dbtender
# or run without installing:
npx dbtender
```

---

## Setup

### 1. Make sure your database is running

**Docker Postgres:** your container must be running. Check with:

```bash
docker ps
```

The container name is in the rightmost NAMES column. If the output is truncated, try:

```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}"
```

**PGlite:** your data directory must exist (created by your app on first run).

### 2. Initialize

```bash
dbtender init
```

This walks you through:

1. **Which type of database?** — Docker Postgres or PGlite.
2. **Select a running Postgres container** — dbtender auto-detects running Postgres containers and shows a list to pick from. Choose **"Enter a container name manually…"** if yours isn't listed.
3. **Enable git integration?** (Yes/No) — auto-save/restore DB state on `git checkout`.
4. If git integration is enabled: **What is your main development branch?** — the branch you merge feature work into (e.g. `develop`, `main`). Pre-selects your current git branch.

After init, `.dbtender/dbtender.json` is created in your project root. Commit this file so teammates don't have to run `dbtender init`.

### 3. Install git hooks (optional)

If you enabled git integration, install the post-checkout hook:

```bash
dbtender git-hooks install
```

Now your DB state automatically saves/restores when you `git checkout`. To disable:

```bash
dbtender git-hooks uninstall
```

---

## Daily use

### Save a snapshot before a migration

```bash
dbtender snapshot save --name "before-user-auth"
dbtender snapshot save --name "add-email-index" --notes "added users.email index"
```

If you omit `--name`, an auto-generated name like `snapshot-20260515-143201` is used.

### Run a migration safely

```bash
# Wrapper: auto-saves a snapshot, runs your command, prints restore hint on failure
dbtender run npx drizzle-kit push
dbtender run npx drizzle-kit migrate
dbtender run npx prisma migrate dev
dbtender run --name pre-deploy npx prisma migrate deploy
```

Or add to your `package.json` scripts:

```json
{
  "scripts": {
    "db:migrate": "dbtender run --name pre-migration npx drizzle-kit migrate",
    "db:push": "dbtender run npx drizzle-kit push",
    "db:prisma": "dbtender run --name pre-prisma npx prisma migrate dev"
  }
}
```

### List and restore

```bash
dbtender snapshot list              # table view: ID, name, date, size, notes
dbtender snapshot info 20260515-143201  # full details for one snapshot
dbtender snapshot restore before-user-auth  # rollback (auto-saves current state first)
dbtender snapshot delete before-user-auth  # free disk space
```

### Check status

```bash
dbtender status
```

Shows: adapter type, Postgres version, connection string, git branch sync status, snapshot count, active branches.

---

## Git integration

When git integration is enabled and hooks are installed, switching branches automatically saves your current DB state and restores the target branch's state. Each git branch gets its own DB schema — like having a dedicated database per branch, but using a single instance.

```bash
# Manual switch (without hooks)
dbtender switch feature/payments

# Install / uninstall auto-switching
dbtender git-hooks install
dbtender git-hooks uninstall

# Check sync status
dbtender status
```

Manual switch saves the **current** branch's DB state under its name, then restores the **target** branch's saved state. If the target branch has no saved state yet, the DB is left as-is.

---

## Database branches (isolated copies)

Separate from git branches. `dbtender branch` creates a **real separate database instance** — a new Docker container or PGlite data directory — for safe testing.

```bash
# Create an isolated copy
dbtender branch create test-new-schema

# Get its connection string
dbtender branch url test-new-schema

# Point your ORM at it
DATABASE_URL=$(dbtender branch url test-new-schema) npx prisma migrate dev

# Merge back to main when happy
dbtender branch promote test-new-schema

# Or discard
dbtender branch delete test-new-schema

# List all branches
dbtender branch list
```

Branch from a specific snapshot instead of current state:

```bash
dbtender branch create test-rollback --from 20260515-143201
```

### Branch vs Switch

| | `dbtender branch` | `dbtender switch` |
|---|---|---|
| **Runs** | Parallel (all live simultaneously) | Serial (swaps content on single instance) |
| **Use case** | "Test this migration on a copy" | "My DB follows my git branch" |
| **Docker** | New container per branch | Uses main container |
| **PGlite** | New data dir per branch | Swaps main data dir content |

---

## Diff

Compare schemas between snapshots or live database:

```bash
dbtender diff before-auth after-auth
dbtender diff 20260515-120000 current    # snapshot vs live database
dbtender diff before-auth after-auth --raw  # raw unified diff
```

Schema diff requires SQL-backed snapshots (Docker adapter). PGlite snapshots are stored as data-dir archives — diff not available yet for PGlite.

---

## Merge check

Before merging a feature branch, check for schema conflicts against your main development branch:

```bash
dbtender merge feature/payments
dbtender merge feature/payments --format=markdown  # for CI / PR comments
```

---

## How it works

### Docker Postgres

Snapshots use `pg_dump --clean --if-exists` to create a portable SQL dump. Restores run `psql` inside the container. Branches spin up a fresh `postgres:16-alpine` container on a free port and restore the snapshot dump into it.

### PGlite

Snapshots use PGlite's `dumpDataDir("gzip")` to archive the entire data directory. Branches create a new data directory via `loadDataDir`. Restores wipe the current data dir and load the archived state.

### Storage layout

```
.dbtender/                  ← everything lives in your project
  dbtender.json              ← project config (commit this to git)
  current-branch             ← tracks last-switched git branch
  snapshots/
    <snapshot-id>/
      .meta.json             ← snapshot metadata (id, name, date, size, notes)
      dump.sql | data.tgz    ← adapter-specific artifact
  branches/
    <branch-name>/
      .meta.json             ← branch metadata (name, source snapshot, connection string)
      data/                  ← PGlite data dir (PGlite adapter only)
  branch-states/
    <branch-name>/
      dump.sql               ← saved DB state per git branch
```

### Common configs

**Prisma:**
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mydb
```

**Drizzle:**
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mydb
```

---

## .gitignore

Commit `.dbtender/dbtender.json` so teammates don't have to re-init. Snapshot/branch data can be ignored or committed:

```gitignore
.dbtender/snapshots/
.dbtender/branches/
.dbtender/branch-states/
.dbtender/current-branch
```

---

## JSON output

Every command accepts `--json` for scripting / CI:

```bash
dbtender snapshot list --json
dbtender branch create ci-$CI_RUN_ID --json
dbtender snapshot save --name "pre-deploy" --json
```

---

## MCP for AI assistants

Start the MCP server to let AI coding assistants (Cursor, Claude Code) manage your dev database:

```bash
dbtender mcp
```

See [MCP_SETUP.md](./MCP_SETUP.md) for configuration.

---

## Library usage

`dbtender` can be imported as a library in Node.js / Electron apps:

```ts
import {
  resolveAdapter,
  DockerAdapter,
  listSnapshots,
  findSnapshot,
  runSwitch,
} from "dbtender"

const adapter = resolveAdapter()
await adapter.snapshotCreate("pre-electron-migration")
```

See `src/index.ts` for the full API surface.

---

## Project structure

```
src/
  cli.ts                ← entrypoint, wires all commands
  index.ts              ← library entry point
  mcp-server.ts         ← MCP server for AI assistant integration
  lib/
    types.ts            ← IAdapter, Snapshot, Branch, AdapterInfo
    config.ts           ← reads/writes .dbtender/dbtender.json, path helpers
    store.ts            ← snapshot + branch metadata index
    git.ts              ← git branch detection helpers
  adapters/
    docker.ts           ← Docker Postgres implementation
    pglite.ts           ← PGlite implementation
    index.ts            ← resolveAdapter() factory
  commands/
    init.ts             ← interactive setup wizard
    status.ts           ← connection + summary
    snapshot.ts         ← save / list / restore / delete / info
    branch.ts           ← create / list / promote / delete / url
    run.ts              ← auto-snapshot command wrapper
    switch.ts           ← save / restore DB state per git branch
    git-hooks.ts        ← install / uninstall post-checkout hook
    merge.ts            ← schema conflict detection
    diff.ts             ← schema diff
  tui/
    index.tsx           ← Ink/React terminal UI
    App.tsx             ← main TUI component
    components/         ← TUI sub-components
```

---

MIT License
