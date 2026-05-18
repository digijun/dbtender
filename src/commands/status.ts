/**
 * src/commands/status.ts
 *
 * dbtender status — show connection info, git branch context, and environment summary.
 */

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { resolveAdapter } from "../adapters/index.js"
import { readConfig } from "../lib/config.js"
import { listBranchStates } from "../lib/store.js"
import { currentGitBranch, readTrackedBranch } from "../lib/git.js"

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show connection info and environment summary")
    .action(async () => {
      const config = readConfig()
      if (!config) {
        console.error(chalk.red("\n  No .dbtender/dbtender.json found. Run: dbtender init\n"))
        process.exit(1)
      }

      const adapter = resolveAdapter()
      const spinner = ora("Connecting…").start()

      try {
        await adapter.ping()
        const info     = await adapter.info()
        const snaps    = await adapter.snapshotList()
        const branches = await adapter.branchList()
        spinner.stop()

        const gitBranch     = currentGitBranch()
        const trackedBranch = readTrackedBranch()
        const branchStates  = listBranchStates()

        console.log()
        console.log(chalk.bold("  dbtender status"))
        console.log()

        // ── Connection ────────────────────────────────────────────────────────
        console.log(`  ${chalk.dim("adapter")}        ${info.type}`)
        console.log(`  ${chalk.dim("postgres")}       ${info.version}`)
        console.log(`  ${chalk.dim("connection")}     ${chalk.cyan(info.connectionString)}`)
        if (info.dataPath) console.log(`  ${chalk.dim("data path")}      ${info.dataPath}`)
        console.log()

        // ── Git integration ───────────────────────────────────────────────────
        if (config.gitIntegration) {
          const displayBranch = gitBranch ?? trackedBranch ?? chalk.dim("unknown")
          const inSync = gitBranch && trackedBranch && gitBranch === trackedBranch
          const syncStatus = !gitBranch ? "" : inSync ? chalk.green(" ✓") : chalk.yellow(" (DB not synced — run: dbtender switch " + gitBranch + ")")
          console.log(`  ${chalk.dim("git branch")}     ${chalk.bold(displayBranch)}${syncStatus}`)
          console.log(`  ${chalk.dim("production")}     ${config.productionBranch ?? "main"}`)
          if (branchStates.length > 0) {
            console.log(`  ${chalk.dim("saved states")}   ${branchStates.length}`)
            branchStates.slice(0, 5).forEach(s => {
              const isActive = s.branch === (gitBranch ?? trackedBranch)
              const marker   = isActive ? chalk.green("→ ") : "  "
              const ago      = formatAgo(s.savedAt)
              console.log(`  ${marker}${chalk.bold(s.branch)} ${chalk.dim(`saved ${ago}, ${s.sizeMb}MB`)}`)
            })
            if (branchStates.length > 5) {
              console.log(chalk.dim(`  … and ${branchStates.length - 5} more`))
            }
          }
          console.log()
        } else {
          console.log(`  ${chalk.dim("git integration")} ${chalk.dim("off")}  ${chalk.dim("(run: dbtender git-hooks install)")}`)
          console.log()
        }

        // ── Snapshots ─────────────────────────────────────────────────────────
        console.log(`  ${chalk.dim("snapshots")}      ${snaps.length > 0 ? chalk.bold(snaps.length) : chalk.dim("none")}`)
        if (snaps[0]) {
          console.log(`  ${chalk.dim("latest")}         ${snaps[0].name} ${chalk.dim(`(${snaps[0].id})`)}`)
        }
        console.log()

        // ── Parallel branches ─────────────────────────────────────────────────
        if (branches.length > 0) {
          console.log(`  ${chalk.dim("branches")}       ${chalk.bold(branches.length)}`)
          branches.forEach(b => {
            console.log(`    ${chalk.bold(b.name)}  ${chalk.cyan(b.connectionString)}`)
          })
          console.log()
        }

      } catch (err) {
        spinner.fail((err as Error).message)
        process.exit(1)
      }
    })
}

function formatAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const mins  = Math.floor(diffMs / 60_000)
  const hours = Math.floor(mins / 60)
  const days  = Math.floor(hours / 24)
  if (days > 0)  return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (mins > 0)  return `${mins}m ago`
  return "just now"
}
