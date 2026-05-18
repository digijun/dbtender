/**
 * src/commands/branch.ts
 *
 * dbtender branch  create / list / promote / delete / url
 */

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { table } from "table"
import { resolveAdapter } from "../adapters/index.js"
import { findBranch } from "../lib/store.js"
import type { Branch } from "../lib/types.js"

function fmtDate(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function renderBranchTable(branches: Branch[]): void {
  if (branches.length === 0) {
    console.log(chalk.dim("  No branches. Run: dbtender branch create <name>\n"))
    return
  }
  const rows = branches.map(b => [
    chalk.bold(b.name),
    fmtDate(b.createdAt),
    chalk.dim(b.createdFrom),
    chalk.cyan(b.connectionString),
  ])
  console.log(table(
    [[chalk.dim("Name"), chalk.dim("Created"), chalk.dim("From snapshot"), chalk.dim("Connection")], ...rows],
    {
      border: { topBody:"─", topJoin:"┬", topLeft:"┌", topRight:"┐", bottomBody:"─", bottomJoin:"┴", bottomLeft:"└", bottomRight:"┘", bodyLeft:"│", bodyRight:"│", bodyJoin:"│", joinBody:"─", joinLeft:"├", joinRight:"┤", joinJoin:"┼" },
    }
  ))
}

export function registerBranch(program: Command): void {
  const cmd = program.command("branch").description("Manage database branches")

  // ── create ────────────────────────────────────────────────────────────────
  cmd
    .command("create <name>")
    .description("Create an isolated branch from current state (or a snapshot)")
    .option("--from <snapshotId>", "Branch from a specific snapshot instead of current state")
    .option("--json", "Output result as JSON")
    .action(async (name: string, opts: { from?: string; json?: boolean }) => {
      const adapter = resolveAdapter()
      const spinner = opts.json ? null : ora("Connecting…").start()
      try {
        await adapter.ping()
        if (spinner) spinner.text = opts.from ? `Branching from ${opts.from}…` : "Snapshotting and branching…"
        const b = await adapter.branchCreate(name, opts.from)
        if (opts.json) {
          console.log(JSON.stringify(b, null, 2))
        } else {
          spinner!.succeed(`Branch ${chalk.bold(name)} created`)
          console.log()
          console.log(`  ${chalk.dim("DATABASE_URL=")}${chalk.cyan(b.connectionString)}`)
          console.log()
          console.log(chalk.dim(`  Point your ORM at this connection string to use the branch.`))
          console.log(chalk.dim(`  dbtender branch promote ${name}  — merge back to main`))
          console.log(chalk.dim(`  dbtender branch delete ${name}   — discard\n`))
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
    .description("List all active branches")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const adapter = resolveAdapter()
      try {
        const branches = await adapter.branchList()
        if (opts.json) { console.log(JSON.stringify(branches, null, 2)); return }
        console.log(chalk.bold(`\n  Branches (${branches.length})\n`))
        renderBranchTable(branches)
      } catch (err) {
        if (opts.json) console.error(JSON.stringify({ error: (err as Error).message }))
        else console.error(chalk.red((err as Error).message))
        process.exit(1)
      }
    })

  // ── promote ───────────────────────────────────────────────────────────────
  cmd
    .command("promote <name>")
    .description("Merge a branch's state back into the main environment")
    .option("--json", "Output result as JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      const adapter = resolveAdapter()
      const spinner = opts.json ? null : ora(`Promoting ${chalk.bold(name)}…`).start()
      try {
        await adapter.ping()
        if (spinner) spinner.text = "Saving safety snapshot then promoting…"
        await adapter.branchPromote(name)
        if (opts.json) console.log(JSON.stringify({ promoted: name, ok: true }))
        else {
          spinner!.succeed(`Branch ${chalk.bold(name)} promoted to main`)
          console.log(chalk.dim("  Pre-promotion state was auto-saved.\n"))
        }
      } catch (err) {
        if (spinner) spinner.fail((err as Error).message)
        else console.error(JSON.stringify({ error: (err as Error).message }))
        process.exit(1)
      }
    })

  // ── delete ────────────────────────────────────────────────────────────────
  cmd
    .command("delete <name>")
    .alias("rm")
    .description("Delete a branch and free its resources")
    .option("--json", "Output result as JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      const adapter = resolveAdapter()
      const spinner = opts.json ? null : ora(`Deleting ${chalk.bold(name)}…`).start()
      try {
        await adapter.branchDelete(name)
        if (opts.json) console.log(JSON.stringify({ deleted: name, ok: true }))
        else spinner!.succeed(`Deleted branch ${chalk.bold(name)}`)
      } catch (err) {
        if (spinner) spinner.fail((err as Error).message)
        else console.error(JSON.stringify({ error: (err as Error).message }))
        process.exit(1)
      }
    })

  // ── url ───────────────────────────────────────────────────────────────────
  cmd
    .command("url <name>")
    .description("Print the connection string for a branch (useful in scripts)")
    .action((name: string) => {
      const b = findBranch(name)
      if (!b) { console.error(chalk.red(`Branch "${name}" not found.`)); process.exit(1) }
      console.log(b.connectionString)
    })
}
