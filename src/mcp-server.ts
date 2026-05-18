/**
 * src/mcp-server.ts
 *
 * dbtender MCP Server — exposes all dbtender operations as MCP tools so AI
 * coding assistants (Cursor, Claude Code, etc.) can manage your dev
 * database from the editor.
 *
 * Started via: dbtender mcp
 *
 * Add to your MCP client config (.cursor/mcp.json etc.):
 *   {
 *     "mcpServers": {
 *       "dbtender": { "command": "npx", "args": ["dbtender", "mcp"] }
 *     }
 *   }
 */

import { resolveAdapter } from "./adapters/index.js"
import { findSnapshot, snapshotDir, listSnapshots, listBranches } from "./lib/store.js"
import fs from "node:fs"
import path from "node:path"

const PGLITE_ARTIFACT_HINT =
  "Schema diff is not currently available for PGlite snapshots because they are stored as data-dir archives, not SQL dumps."

// ── Minimal MCP types (no external library needed) ────────────────────────────

interface Tool {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, { type: string; description: string }>
    required?: string[]
  }
}

interface McpRequest {
  jsonrpc: "2.0"
  id: string | number
  method: string
  params?: { name?: string; arguments?: Record<string, string> }
}

// ── Tool catalogue ────────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "dbtender_status",
    description: "Show current database connection info, Postgres version, snapshot count, and active branches. Call this first to confirm dbtender is configured.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dbtender_snapshot_save",
    description: "Save the current database state as a named snapshot. Always call this before running migrations or destructive changes.",
    inputSchema: {
      type: "object",
      properties: {
        name:  { type: "string", description: "Snapshot name, e.g. 'before-user-auth-migration'. Auto-generated if omitted." },
        notes: { type: "string", description: "Optional description." },
      },
    },
  },
  {
    name: "dbtender_snapshot_list",
    description: "List all snapshots with their IDs, names, creation dates, and sizes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dbtender_snapshot_restore",
    description: "Restore the database to a previous snapshot. Automatically saves the current state first as a safety net.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Snapshot ID or name." },
      },
      required: ["id"],
    },
  },
  {
    name: "dbtender_snapshot_delete",
    description: "Delete a snapshot by ID or name to free disk space.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Snapshot ID or name." },
      },
      required: ["id"],
    },
  },
  {
    name: "dbtender_branch_create",
    description: "Create an isolated database branch for safe testing. Returns a DATABASE_URL connection string.",
    inputSchema: {
      type: "object",
      properties: {
        name:         { type: "string", description: "Branch name, e.g. 'test-add-indexes'." },
        fromSnapshot: { type: "string", description: "Optional snapshot ID to branch from. Uses current state if omitted." },
      },
      required: ["name"],
    },
  },
  {
    name: "dbtender_branch_list",
    description: "List all active branches with their connection strings.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dbtender_branch_promote",
    description: "Merge a branch's database state back into the main development database.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Branch name to promote." },
      },
      required: ["name"],
    },
  },
  {
    name: "dbtender_branch_delete",
    description: "Delete a branch and free its resources.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Branch name to delete." },
      },
      required: ["name"],
    },
  },
  {
    name: "dbtender_diff",
    description: "Show schema differences between two snapshots. Use 'current' to compare against the live database.",
    inputSchema: {
      type: "object",
      properties: {
        snapshotA: { type: "string", description: "First snapshot ID/name (older). Use 'current' for live db." },
        snapshotB: { type: "string", description: "Second snapshot ID/name (newer). Use 'current' for live db." },
      },
      required: ["snapshotA", "snapshotB"],
    },
  },
]

// ── Tool execution ────────────────────────────────────────────────────────────

async function executeTool(name: string, args: Record<string, string>): Promise<string> {
  const adapter = resolveAdapter()

  switch (name) {

    case "dbtender_status": {
      await adapter.ping()
      const info    = await adapter.info()
      const snaps   = await adapter.snapshotList()
      const branches = await adapter.branchList()
      return JSON.stringify({
        adapter: info.type,
        postgres: info.version,
        connectionString: info.connectionString,
        dataPath: info.dataPath ?? null,
        snapshotCount: snaps.length,
        latestSnapshot: snaps[0] ? { id: snaps[0].id, name: snaps[0].name, createdAt: snaps[0].createdAt } : null,
        branchCount: branches.length,
        branches: branches.map(b => ({ name: b.name, connectionString: b.connectionString })),
      }, null, 2)
    }

    case "dbtender_snapshot_save": {
      await adapter.ping()
      const snap = await adapter.snapshotCreate(args["name"] ?? "", args["notes"])
      return JSON.stringify(snap, null, 2)
    }

    case "dbtender_snapshot_list": {
      return JSON.stringify(await adapter.snapshotList(), null, 2)
    }

    case "dbtender_snapshot_restore": {
      if (!args["id"]) throw new Error("id is required")
      await adapter.ping()
      await adapter.snapshotRestore(args["id"])
      return JSON.stringify({ restored: args["id"], ok: true, note: "Pre-restore safety snapshot was saved automatically." })
    }

    case "dbtender_snapshot_delete": {
      if (!args["id"]) throw new Error("id is required")
      await adapter.snapshotDelete(args["id"])
      return JSON.stringify({ deleted: args["id"], ok: true })
    }

    case "dbtender_branch_create": {
      if (!args["name"]) throw new Error("name is required")
      await adapter.ping()
      const branch = await adapter.branchCreate(args["name"], args["fromSnapshot"])
      return JSON.stringify({
        ...branch,
        hint: `Set DATABASE_URL=${branch.connectionString} to use this branch.`,
      }, null, 2)
    }

    case "dbtender_branch_list": {
      return JSON.stringify(await adapter.branchList(), null, 2)
    }

    case "dbtender_branch_promote": {
      if (!args["name"]) throw new Error("name is required")
      await adapter.ping()
      await adapter.branchPromote(args["name"])
      return JSON.stringify({ promoted: args["name"], ok: true, note: "Pre-promotion safety snapshot was saved automatically." })
    }

    case "dbtender_branch_delete": {
      if (!args["name"]) throw new Error("name is required")
      await adapter.branchDelete(args["name"])
      return JSON.stringify({ deleted: args["name"], ok: true })
    }

    case "dbtender_diff": {
      if (!args["snapshotA"] || !args["snapshotB"]) throw new Error("snapshotA and snapshotB are required")

      const getSchema = async (id: string): Promise<{ label: string; schema: string }> => {
        if (id === "current") {
          await adapter.ping()
          const info = await adapter.info()
          if (info.type === "pglite") {
            throw new Error(PGLITE_ARTIFACT_HINT)
          }
          const snap = await adapter.snapshotCreate("mcp-diff-temp", "Temporary snapshot for diff")
          const dumpPath = path.join(snapshotDir(snap.id), "dump.sql")
          if (!fs.existsSync(dumpPath)) {
            await adapter.snapshotDelete(snap.id)
            throw new Error(PGLITE_ARTIFACT_HINT)
          }
          const raw = fs.readFileSync(dumpPath, "utf8")
          await adapter.snapshotDelete(snap.id)
          return { label: "current", schema: raw }
        }
        const snap = findSnapshot(id)
        if (!snap) throw new Error(`Snapshot "${id}" not found.`)
        const dumpPath = path.join(snapshotDir(snap.id), "dump.sql")
        if (!fs.existsSync(dumpPath)) {
          const archivePath = path.join(snapshotDir(snap.id), "data.tgz")
          if (fs.existsSync(archivePath)) throw new Error(PGLITE_ARTIFACT_HINT)
          throw new Error(`Snapshot "${id}" has no diffable SQL dump.`)
        }
        return { label: snap.name, schema: fs.readFileSync(dumpPath, "utf8") }
      }

      const a = await getSchema(args["snapshotA"])
      const b = await getSchema(args["snapshotB"])
      const aLines = new Set(a.schema.split("\n"))
      const bLines = new Set(b.schema.split("\n"))
      const removed = [...aLines].filter(l => l.trim() && !bLines.has(l))
      const added   = [...bLines].filter(l => l.trim() && !aLines.has(l))
      return JSON.stringify({
        from: args["snapshotA"],
        to:   args["snapshotB"],
        summary: removed.length === 0 && added.length === 0
          ? "No schema differences."
          : `${removed.length} lines removed, ${added.length} lines added.`,
        removedLines: removed.slice(0, 100),
        addedLines:   added.slice(0, 100),
      }, null, 2)
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ── MCP stdio transport ───────────────────────────────────────────────────────

function send(obj: unknown): void {
  const msg = JSON.stringify(obj)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`)
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", async (chunk: string) => {
  buf += chunk
  while (true) {
    const end = buf.indexOf("\r\n\r\n")
    if (end === -1) break
    const header = buf.slice(0, end)
    const m = header.match(/Content-Length: (\d+)/i)
    if (!m) { buf = buf.slice(end + 4); break }
    const len = parseInt(m[1]!, 10)
    const start = end + 4
    if (buf.length < start + len) break
    const body = buf.slice(start, start + len)
    buf = buf.slice(start + len)

    let req: McpRequest
    try { req = JSON.parse(body) as McpRequest } catch { continue }

    if (req.method === "initialize") {
      send({ jsonrpc: "2.0", id: req.id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "dbtender", version: "0.1.0" },
      }})
    } else if (req.method === "tools/list") {
      send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } })
    } else if (req.method === "tools/call") {
      const toolName = req.params?.name ?? ""
      const toolArgs = (req.params?.arguments ?? {}) as Record<string, string>
      try {
        const result = await executeTool(toolName, toolArgs)
        send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: result }] } })
      } catch (err) {
        send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true } })
      }
    } else {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } })
    }
  }
})
process.stdin.on("end", () => process.exit(0))
