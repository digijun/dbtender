/**
 * src/commands/diff.ts
 *
 * dbtender diff <snapshot-a> <snapshot-b>
 *
 * Shows schema differences between two snapshots.
 * Use "current" as either argument to compare against the live database.
 *
 *   dbtender diff before-auth after-auth
 *   dbtender diff 20260415-120000 current
 */

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { resolveAdapter } from "../adapters/index.js"
import { findSnapshot, snapshotDir } from "../lib/store.js"

const PGLITE_ARTIFACT_HINT =
  "Schema diff is not currently available for PGlite snapshots because they are stored as data-dir archives, not SQL dumps."

function extractSchema(dumpSql: string): string {
  let inCopy = false
  return dumpSql.split("\n").filter(line => {
    if (line.startsWith("COPY ")) { inCopy = true; return false }
    if (inCopy && line.trim() === "\\.") { inCopy = false; return false }
    if (inCopy) return false
    if (line.startsWith("INSERT INTO")) return false
    if (line.startsWith("SELECT pg_catalog.setval")) return false
    return true
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

function getSchemaFromSnapshotId(id: string): string {
  const dumpPath = path.join(snapshotDir(id), "dump.sql")
  if (!fs.existsSync(dumpPath)) {
    const archivePath = path.join(snapshotDir(id), "data.tgz")
    if (fs.existsSync(archivePath)) throw new Error(PGLITE_ARTIFACT_HINT)
    throw new Error(`Snapshot "${id}" has no dump file. Try re-creating the snapshot.`)
  }
  return extractSchema(fs.readFileSync(dumpPath, "utf8"))
}

function colorDiff(raw: string): string {
  return raw.split("\n").map(line => {
    if (line.startsWith("---") || line.startsWith("+++")) return chalk.dim(line)
    if (line.startsWith("@@")) return chalk.cyan(line)
    if (line.startsWith("+")) return chalk.green(line)
    if (line.startsWith("-")) return chalk.red(line)
    return chalk.dim(line)
  }).join("\n")
}

function simpleDiff(aLabel: string, bLabel: string, a: string, b: string): string {
  const aSet = new Set(a.split("\n"))
  const bSet = new Set(b.split("\n"))
  const removed = [...aSet].filter(l => l.trim() && !bSet.has(l))
  const added   = [...bSet].filter(l => l.trim() && !aSet.has(l))
  if (!removed.length && !added.length) return chalk.dim("  No schema differences found.")
  const out: string[] = [chalk.dim(`  --- ${aLabel}`), chalk.dim(`  +++ ${bLabel}`), ""]
  if (removed.length) {
    out.push(chalk.red.bold("  Removed:"))
    removed.slice(0, 60).forEach(l => out.push(chalk.red(`  - ${l}`)))
    if (removed.length > 60) out.push(chalk.dim(`  … and ${removed.length - 60} more`))
    out.push("")
  }
  if (added.length) {
    out.push(chalk.green.bold("  Added:"))
    added.slice(0, 60).forEach(l => out.push(chalk.green(`  + ${l}`)))
    if (added.length > 60) out.push(chalk.dim(`  … and ${added.length - 60} more`))
  }
  return out.join("\n")
}

export function registerDiff(program: Command): void {
  program
    .command("diff <snapshot-a> <snapshot-b>")
    .description(
      "Show schema differences between two snapshots\n" +
      "  e.g. dbtender diff before-auth after-auth\n" +
      "       dbtender diff 20260415-120000 current"
    )
    .option("--raw", "Show raw unified diff output")
    .action(async (idA: string, idB: string, opts: { raw?: boolean }) => {
      const spinner = ora("Loading snapshots…").start()

      const resolve = async (id: string): Promise<{ label: string; schema: string }> => {
        if (id === "current") {
          const adapter = resolveAdapter()
          await adapter.ping()
          const info = await adapter.info()
          if (info.type === "pglite") throw new Error(PGLITE_ARTIFACT_HINT)
          spinner.text = "Snapshotting current state…"
          const snap = await adapter.snapshotCreate("diff-current-temp", "Temporary snapshot for diff")
          const schema = getSchemaFromSnapshotId(snap.id)
          await adapter.snapshotDelete(snap.id)
          return { label: "current", schema }
        }
        const snap = findSnapshot(id)
        if (!snap) throw new Error(`Snapshot "${id}" not found.`)
        return { label: snap.name, schema: getSchemaFromSnapshotId(snap.id) }
      }

      try {
        const a = await resolve(idA)
        const b = await resolve(idB)
        spinner.stop()

        console.log()
        console.log(chalk.bold(`  Schema diff: ${chalk.cyan(a.label)} → ${chalk.cyan(b.label)}`))
        console.log()

        // Try system diff first for proper unified diff output
        const tmpA = `/tmp/dbtender-diff-a-${Date.now()}.sql`
        const tmpB = `/tmp/dbtender-diff-b-${Date.now()}.sql`
        fs.writeFileSync(tmpA, a.schema)
        fs.writeFileSync(tmpB, b.schema)
        const sysResult = spawnSync("diff", ["-u", "--label", a.label, "--label", b.label, tmpA, tmpB], { encoding: "utf8" })
        fs.unlinkSync(tmpA); fs.unlinkSync(tmpB)

        if (sysResult.status !== 2 && sysResult.stdout) {
          console.log(opts.raw ? sysResult.stdout : colorDiff(sysResult.stdout))
        } else {
          console.log(simpleDiff(a.label, b.label, a.schema, b.schema))
        }
        console.log()
      } catch (err) {
        spinner.fail((err as Error).message)
        process.exit(1)
      }
    })
}
