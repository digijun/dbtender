/**
 * src/commands/run.ts
 *
 * dbtender run <command...>
 *
 * Saves a snapshot before running an arbitrary command, then returns the
 * wrapped command's exit code. If the command fails, prints a restore hint.
 */

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { spawn } from "node:child_process"
import { resolveAdapter } from "../adapters/index.js"

interface RunOptions {
  name?: string
  notes?: string
}

function autoRunSnapshotName(command: string[]): string {
  const base = command.join(" ").trim().slice(0, 48).replace(/\s+/g, "-")
  return `pre-run-${base || "command"}`
}

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("Save a snapshot, run a command, and print a restore hint if it fails")
    .allowUnknownOption(true)
    .argument("<command>", "Command to run")
    .argument("[args...]", "Arguments passed to the command")
    .option("-n, --name <name>", "Snapshot name (auto-generated if omitted)")
    .option("--notes <text>", "Optional snapshot notes")
    .action(async (command: string, args: string[], opts: RunOptions) => {
      const fullCommand = [command, ...args]

      const adapter = resolveAdapter()
      const spinner = ora("Connecting…").start()

      try {
        await adapter.ping()
        spinner.text = "Saving pre-run snapshot…"
        const snapshot = await adapter.snapshotCreate(
          opts.name ?? autoRunSnapshotName(fullCommand),
          opts.notes ?? `Auto-snapshot before: ${fullCommand.join(" ")}`
        )
        spinner.succeed(`Snapshot saved: ${chalk.bold(snapshot.name)} ${chalk.dim(`(${snapshot.id})`)}`)

        const child = spawn(command, args, {
          stdio: "inherit",
          shell: false,
          env: process.env,
        })

        child.on("exit", (code, signal) => {
          if (signal) {
            console.error()
            console.error(chalk.yellow(`  Command terminated by signal ${signal}.`))
            console.error(chalk.dim(`  Restore with: dbtender snapshot restore ${snapshot.id}`))
            process.exit(1)
          }

          if ((code ?? 1) === 0) {
            console.log()
            console.log(chalk.green("  Wrapped command completed successfully."))
            console.log(chalk.dim(`  Snapshot kept: ${snapshot.id}`))
            process.exit(0)
          }

          console.error()
          console.error(chalk.red(`  Wrapped command failed with exit code ${code ?? 1}.`))
          console.error(chalk.dim(`  Restore with: dbtender snapshot restore ${snapshot.id}`))
          process.exit(code ?? 1)
        })

        child.on("error", (err) => {
          console.error()
          console.error(chalk.red(`  Failed to start command: ${err.message}`))
          console.error(chalk.dim(`  Snapshot saved as: ${snapshot.id}`))
          process.exit(1)
        })
      } catch (err) {
        spinner.fail((err as Error).message)
        process.exit(1)
      }
    })
}
