#!/usr/bin/env node
/**
 * src/cli.ts
 *
 * dbtender — local-first database environment manager
 *
 * Commands:
 *   init                        Interactive setup, writes .dbtender/dbtender.json
 *   status                      Connection info + git branch + environment summary
 *   snapshot save               Save current state
 *   snapshot list               List all snapshots
 *   snapshot restore <id>       Restore to a snapshot
 *   snapshot delete <id>        Delete a snapshot
 *   snapshot info <id>          Show snapshot details
 *   branch create <n>           Create an isolated parallel branch
 *   branch list                 List active branches
 *   branch promote <n>          Promote branch state back to main
 *   branch delete <n>           Delete a branch
 *   branch url <n>              Print branch connection string
 *   run <command...>            Save snapshot, run command, print restore hint on failure
 *   switch <branch>             Save current DB state, restore target branch state
 *   git-hooks install           Install post-checkout hook for auto-switching
 *   git-hooks uninstall         Remove the dbtender hook
 *   merge <branch>              Check for schema conflicts before merging
 *   diff <a> <b>                Schema diff between two snapshots
 *   mcp                         Start MCP server for AI assistant integration
 */

import { Command } from "commander"
import chalk from "chalk"
import { registerInit }      from "./commands/init.js"
import { registerStatus }    from "./commands/status.js"
import { registerSnapshot }  from "./commands/snapshot.js"
import { registerBranch }    from "./commands/branch.js"
import { registerRun }       from "./commands/run.js"
import { registerSwitch }    from "./commands/switch.js"
import { registerGitHooks }  from "./commands/git-hooks.js"
import { registerMerge }     from "./commands/merge.js"
import { registerDiff }      from "./commands/diff.js"

const program = new Command()
program.enablePositionalOptions()

program
  .name("dbtender")
  .description(
    chalk.bold("dbtender") + " — local-first database environment manager\n\n" +
    "  Snapshot, branch, and restore your dev database before migrations.\n" +
    "  Git-aware: DB state follows your git branch automatically.\n" +
    "  Works with Docker Postgres and PGlite. ORM-agnostic.\n\n" +
    "  Quick start:\n" +
    "    dbtender init\n" +
    "    dbtender git-hooks install\n" +
    "    # now DB state switches automatically with git checkout\n\n" +
    "  Before merging:\n" +
    "    dbtender merge feature/payments"
  )
  .version("0.1.0")

registerInit(program)
registerStatus(program)
registerSnapshot(program)
registerBranch(program)
registerRun(program)
registerSwitch(program)
registerGitHooks(program)
registerMerge(program)
registerDiff(program)

// TUI — loaded lazily (heavy React/ink deps)
program
  .command("tui")
  .description("Open the interactive terminal UI")
  .action(async () => {
    const { startTui } = await import("./tui/index.js")
    await startTui()
  })

// MCP server — loaded lazily so it doesn't affect startup time of normal commands
program
  .command("mcp")
  .description("Start the MCP server for AI assistant integration (Cursor, Claude Code, etc.)")
  .action(async () => {
    await import("./mcp-server.js")
  })

// Show help when no command is given
if (process.argv.length < 3) {
  program.help()
}

program.parse(process.argv)
