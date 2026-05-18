/**
 * src/commands/snapshot.ts
 *
 * dbtender snapshot  save / list / restore / delete / info
 */

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import enquirer from "enquirer"
import { table } from "table"
import { resolveAdapter } from "../adapters/index.js"
import { findSnapshot, saveSnapshot } from "../lib/store.js"
import type { Snapshot } from "../lib/types.js"

const { prompt } = enquirer as unknown as {
  prompt: <T extends Record<string, unknown>>(opts: object) => Promise<T>
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function fmtSize(mb: number): string {
  if (mb < 1) return "<1 MB"
  if (mb < 1024) return `${mb} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

function fmtDate(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function renderSnapshotTable(snaps: Snapshot[]): void {
  if (snaps.length === 0) {
    console.log(chalk.dim("  No snapshots yet. Run: dbtender snapshot save\n"))
    return
  }
  const rows = snaps.map(s => [
    chalk.cyan(s.id),
    chalk.bold(s.name),
    fmtDate(s.createdAt),
    fmtSize(s.sizeMb),
    s.notes ? chalk.dim(s.notes.slice(0, 24)) : "",
  ])
  console.log(table(
    [[chalk.dim("ID"), chalk.dim("Name"), chalk.dim("Created"), chalk.dim("Size"), chalk.dim("Notes")], ...rows],
    {
      border: { topBody:"─", topJoin:"┬", topLeft:"┌", topRight:"┐", bottomBody:"─", bottomJoin:"┴", bottomLeft:"└", bottomRight:"┘", bodyLeft:"│", bodyRight:"│", bodyJoin:"│", joinBody:"─", joinLeft:"├", joinRight:"┤", joinJoin:"┼" },
      columns: [{ width: 16 }, { width: 26 }, { width: 16 }, { width: 7, alignment: "right" }, { width: 24 }],
    }
  ))
}

// ── Command registration ───────────────────────────────────────────────────

export function registerSnapshot(program: Command): void {
  const cmd = program.command("snapshot").description("Manage database snapshots")

  // ── save ──────────────────────────────────────────────────────────────────
  cmd
    .command("save [name]")
    .alias("create")
    .description("Save current database state as a snapshot")
    .option("-n, --name <name>", "Snapshot name")
    .option("--notes <text>",    "Optional description")
    .option("--json",            "Output result as JSON")
    .action(async (name: string | undefined, opts: { name?: string; notes?: string; json?: boolean }) => {
      const adapter = resolveAdapter()
      const spinner = opts.json ? null : ora("Connecting…").start()
      try {
        await adapter.ping()
        if (spinner) spinner.text = "Saving snapshot…"
        const snap = await adapter.snapshotCreate(name ?? opts.name ?? "", opts.notes)
        if (opts.json) {
          console.log(JSON.stringify(snap, null, 2))
        } else {
          spinner!.succeed(`Saved: ${chalk.bold(snap.name)} ${chalk.dim(`(${snap.id}, ${fmtSize(snap.sizeMb)})`)}`)
          console.log(chalk.dim(`  Restore with: dbtender snapshot restore ${snap.id}\n`))
        }
      } catch (err) {
        if (spinner) spinner.fail((err as Error).message)
        else console.error(JSON.stringify({ error: (err as Error).message }))
        process.exit(1)
      }
    })

  // ── list ──────────────────────────────────────────────────────────────────
  cmd
    .command("list")
    .alias("ls")
    .description("List all snapshots")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const adapter = resolveAdapter()
      try {
        const snaps = await adapter.snapshotList()
        if (opts.json) { console.log(JSON.stringify(snaps, null, 2)); return }
        console.log(chalk.bold(`\n  Snapshots (${snaps.length})\n`))
        renderSnapshotTable(snaps)
      } catch (err) {
        if (opts.json) console.error(JSON.stringify({ error: (err as Error).message }))
        else console.error(chalk.red((err as Error).message))
        process.exit(1)
      }
    })

  // ── restore ───────────────────────────────────────────────────────────────
  cmd
    .command("restore <id>")
    .description("Restore the database to a snapshot (auto-saves current state first)")
    .option("--skip-auto-snapshot", "Skip the automatic safety snapshot")
    .option("--json", "Output result as JSON")
    .action(async (id: string, opts: { skipAutoSnapshot?: boolean; json?: boolean }) => {
      const adapter = resolveAdapter()
      const spinner = opts.json ? null : ora("Connecting…").start()
      try {
        await adapter.ping()
        if (spinner) spinner.text = `Restoring to ${chalk.bold(id)}…`
        await adapter.snapshotRestore(id, { skipAutoSnapshot: opts.skipAutoSnapshot })
        if (opts.json) {
          console.log(JSON.stringify({ restored: id, ok: true }))
        } else {
          spinner!.succeed(`Restored to ${chalk.bold(id)}`)
          if (!opts.skipAutoSnapshot) {
            console.log(chalk.dim("  Your pre-restore state was auto-saved.\n"))
          }
        }
      } catch (err) {
        if (spinner) spinner.fail((err as Error).message)
        else console.error(JSON.stringify({ error: (err as Error).message }))
        process.exit(1)
      }
    })

  // ── delete ────────────────────────────────────────────────────────────────
  cmd
    .command("delete [id]")
    .alias("rm")
    .alias("remove")
    .description("Delete a snapshot and free its disk space")
    .option("--json", "Output result as JSON")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      const adapter = resolveAdapter()

      if (!id) {
        const snaps = await adapter.snapshotList()
        if (snaps.length === 0) {
          console.log(chalk.dim("  No snapshots to delete.\n"))
          return
        }
        const { selected } = await prompt<{ selected: string }>({
          type: "select",
          name: "selected",
          message: "Select a snapshot to delete:",
          choices: snaps.map(s => ({
            name: s.id,
            message: `${s.name}  ${chalk.dim(`${s.id}  ${fmtDate(s.createdAt)}  ${fmtSize(s.sizeMb)}`)}`,
          })),
        })
        id = selected
      }

      const spinner = opts.json ? null : ora(`Deleting ${id}…`).start()
      try {
        await adapter.snapshotDelete(id)
        if (opts.json) console.log(JSON.stringify({ deleted: id, ok: true }))
        else spinner!.succeed(`Deleted ${chalk.bold(id)}`)
      } catch (err) {
        if (spinner) spinner.fail((err as Error).message)
        else console.error(JSON.stringify({ error: (err as Error).message }))
        process.exit(1)
      }
    })

  // ── info ──────────────────────────────────────────────────────────────────
  cmd
    .command("info <id>")
    .description("Show details about a specific snapshot")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const snap = findSnapshot(id)
      if (!snap) {
        console.error(chalk.red(`  Snapshot "${id}" not found.`))
        process.exit(1)
      }
      if (opts.json) { console.log(JSON.stringify(snap, null, 2)); return }
      console.log()
      console.log(chalk.bold(`  Snapshot: ${snap.name}`))
      console.log()
      console.log(`  ${chalk.dim("id")}         ${snap.id}`)
      console.log(`  ${chalk.dim("name")}       ${snap.name}`)
      console.log(`  ${chalk.dim("created")}    ${fmtDate(snap.createdAt)}`)
      console.log(`  ${chalk.dim("size")}       ${fmtSize(snap.sizeMb)}`)
      if (snap.notes) console.log(`  ${chalk.dim("notes")}      ${snap.notes}`)
      console.log()
    })

  // ── rename ────────────────────────────────────────────────────────────────
  cmd
    .command("rename [id] [newName]")
    .description("Rename a snapshot")
    .option("--json", "Output as JSON")
    .action(async (id: string | undefined, newName: string | undefined, opts: { json?: boolean }) => {
      const adapter = resolveAdapter()

      if (!id) {
        const snaps = await adapter.snapshotList()
        if (snaps.length === 0) {
          console.log(chalk.dim("  No snapshots to rename.\n"))
          return
        }
        const { selected } = await prompt<{ selected: string }>({
          type: "select",
          name: "selected",
          message: "Select a snapshot to rename:",
          choices: snaps.map(s => ({
            name: s.id,
            message: `${s.name}  ${chalk.dim(`${s.id}  ${fmtDate(s.createdAt)}`)}`,
          })),
        })
        id = selected
      }

      const snap = findSnapshot(id)
      if (!snap) {
        console.error(chalk.red(`  Snapshot "${id}" not found.`))
        process.exit(1)
      }

      if (!newName) {
        const r = await prompt<{ name: string }>({
          type: "input",
          name: "name",
          message: "New name:",
          initial: snap.name,
        })
        newName = r.name
      }

      if (opts.json) {
        console.log(JSON.stringify({ id: snap.id, oldName: snap.name, newName, ok: true }))
      } else {
        console.log(chalk.green(`  Renamed "${chalk.bold(snap.name)}" → "${chalk.bold(newName)}"`))
      }

      // Update the .meta.json in-place
      snap.name = newName
      saveSnapshot(snap)
    })

}
