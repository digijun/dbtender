/**
 * src/commands/switch.ts
 *
 * dbtender switch <branch>
 *
 * Saves the current DB state under the current git branch name, then
 * restores the target branch's saved state (if one exists).
 * Called automatically by the post-checkout git hook when git integration
 * is enabled.
 */

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { resolveAdapter } from "../adapters/index.js"
import { readConfig } from "../lib/config.js"
import {
  branchStateExists,
  saveBranchState,
  loadBranchState,
} from "../lib/store.js"
import {
  currentGitBranch,
  readTrackedBranch,
  writeTrackedBranch,
} from "../lib/git.js"

export async function runSwitch(targetBranch: string, opts: { quiet?: boolean } = {}): Promise<void> {
  const log = (msg: string) => { if (!opts.quiet) console.log(msg) }

  const config = readConfig()
  if (!config) throw new Error("No .dbtender/dbtender.json found. Run: dbtender init")

  const adapter = resolveAdapter()
  await adapter.ping()

  // Determine the current branch to save state for
  const currentBranch = readTrackedBranch() ?? currentGitBranch()
  if (!currentBranch) throw new Error("Could not determine current branch. Are you in a git repo?")

  if (currentBranch === targetBranch) {
    log(chalk.dim(`  Already on branch "${targetBranch}", nothing to do.`))
    return
  }

  // Save current DB state
  const saveSpinner = opts.quiet ? null : ora(`Saving DB state for "${currentBranch}"…`).start()
  try {
    const sql = await adapter.dumpRaw()
    saveBranchState(currentBranch, sql)
    saveSpinner?.succeed(`Saved DB state for "${currentBranch}"`)
  } catch (err) {
    saveSpinner?.fail(`Failed to save state for "${currentBranch}": ${(err as Error).message}`)
    throw err
  }

  // Restore target branch state (if it exists)
  if (branchStateExists(targetBranch)) {
    const restoreSpinner = opts.quiet ? null : ora(`Restoring DB state for "${targetBranch}"…`).start()
    try {
      const sql = loadBranchState(targetBranch)
      await adapter.restoreRaw(sql)
      restoreSpinner?.succeed(`Restored DB state for "${targetBranch}"`)
    } catch (err) {
      restoreSpinner?.fail(`Failed to restore state for "${targetBranch}": ${(err as Error).message}`)
      throw err
    }
  } else {
    log(chalk.dim(`  No saved state for "${targetBranch}" — DB left as-is.`))
  }

  writeTrackedBranch(targetBranch)
}

export function registerSwitch(program: Command): void {
  program
    .command("switch <branch>")
    .description("Save current DB state and restore the target branch's state")
    .option("-q, --quiet", "Suppress output (used by git hooks)")
    .action(async (branch: string, opts: { quiet?: boolean }) => {
      try {
        await runSwitch(branch, opts)
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`))
        process.exit(1)
      }
    })
}
