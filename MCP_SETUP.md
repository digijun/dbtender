# dbtender MCP Server

`dbtender mcp` starts an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server over stdio. Once configured, AI coding assistants can manage your dev database directly from the editor — creating snapshots before migrations, listing and restoring state, and diffing schemas.

## Setup

### Cursor

Create or edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "dbtender": {
      "command": "npx",
      "args": ["dbtender", "mcp"]
    }
  }
}
```

### Claude Code

Add to your MCP config (usually `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "dbtender": {
      "command": "npx",
      "args": ["dbtender", "mcp"]
    }
  }
}
```

### Any MCP-compatible client

The server speaks MCP 2024-11-05 over stdio with `Content-Length` framing. Start it with:

```bash
npx dbtender mcp
```

---

## Available tools

| Tool | Description |
|------|-------------|
| `dbtender_status` | Connection info, Postgres version, snapshot count, active branches |
| `dbtender_snapshot_save` | Save current database state as a named snapshot |
| `dbtender_snapshot_list` | List all snapshots |
| `dbtender_snapshot_restore` | Restore to a snapshot (auto-saves current state first) |
| `dbtender_snapshot_delete` | Delete a snapshot |
| `dbtender_branch_create` | Create isolated branch, returns DATABASE_URL |
| `dbtender_branch_list` | List active branches with connection strings |
| `dbtender_branch_promote` | Merge branch back to main |
| `dbtender_branch_delete` | Delete a branch |
| `dbtender_diff` | Schema diff between two snapshots (`current` for live db) |

---

## Example prompts

Once configured you can tell your AI assistant things like:

> "Save a dbtender snapshot called pre-auth-refactor before you run any migrations"

> "Show me the schema diff between the last two snapshots"

> "Create a dbtender branch called test-indexes and give me the connection string"

> "The migration failed — restore to the pre-auth-refactor snapshot"

The assistant will call the appropriate `dbtender_*` tools automatically.

---

## Requirements

- `dbtender init` must have been run in the project (creates `.dbtender/dbtender.json`)
- For Docker adapter: the Postgres container must be running
- For PGlite adapter: the data directory must exist
