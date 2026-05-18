/**
 * src/commands/git-hooks.ts
 *
 * dbtender git-hooks install   — writes .git/hooks/post-checkout
 * dbtender git-hooks uninstall — removes the dbtender section from post-checkout
 */

import type { Command } from "commander"
import chalk from "chalk"
import fs from "node:fs"
import path from "node:path"
import { readConfig, writeConfig } from "../lib/config.js"
import { hooksDir } from "../lib/git.js"

// ── Hook script ───────────────────────────────────────────────────────────────

// Wrapped in a marker block so we can surgically remove it on uninstall
// without touching any other hooks the user may have.
const MARKER_START = "# dbtender:start"
const MARKER_END   = "# dbtender:end"

const HOOK_BLOCK = `\
${MARKER_START}
# Auto-managed by dbtender — do not edit this block manually.
# Run "dbtender git-hooks uninstall" to remove.
if [ "\${3}" = "1" ]; then
  NEW_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  dbtender switch "$NEW_BRANCH" --quiet
fi
${MARKER_END}`

function buildHookContent(existing: string): string {
  // Remove any previously installed dbtender block first
  const stripped = removeHookBlock(existing)
  // Ensure the file starts with a shebang
  const base = stripped.trim() ? stripped : "#!/bin/sh"
  return base + "\n\n" + HOOK_BLOCK + "\n"
}

function removeHookBlock(content: string): string {
  const start = content.indexOf(MARKER_START)
  const end   = content.indexOf(MARKER_END)
  if (start === -1 || end === -1) return content
  return (content.slice(0, start) + content.slice(end + MARKER_END.length)).replace(/\n{3,}/g, "\n\n").trim()
}

// ── Install ───────────────────────────────────────────────────────────────────

function install(): void {
  const hooks = hooksDir()
  if (!hooks) {
    console.error(chalk.red("  Not inside a git repository (or .git/hooks not found)."))
    process.exit(1)
  }

  const hookFile = path.join(hooks, "post-checkout")
  const existing = fs.existsSync(hookFile) ? fs.readFileSync(hookFile, "utf8") : ""

  if (existing.includes(MARKER_START)) {
    console.log(chalk.dim("  dbtender hook already installed. Re-installing to update…"))
  }

  const content = buildHookContent(existing)
  fs.writeFileSync(hookFile, content)
  fs.chmodSync(hookFile, 0o755)

  // Persist the setting in project config
  const config = readConfig()
  if (config) writeConfig({ ...config, gitIntegration: true })

  console.log(chalk.green(`  ✓  Hook installed: ${hookFile}`))
  console.log(chalk.dim("  dbtender switch will now run automatically on git checkout.\n"))
}

// ── Uninstall ─────────────────────────────────────────────────────────────────

function uninstall(): void {
  const hooks = hooksDir()
  if (!hooks) {
    console.error(chalk.red("  Not inside a git repository (or .git/hooks not found)."))
    process.exit(1)
  }

  const hookFile = path.join(hooks, "post-checkout")
  if (!fs.existsSync(hookFile)) {
    console.log(chalk.dim("  No post-checkout hook found — nothing to remove."))
    return
  }

  const existing = fs.readFileSync(hookFile, "utf8")
  if (!existing.includes(MARKER_START)) {
    console.log(chalk.dim("  No dbtender block found in post-checkout hook."))
    return
  }

  const stripped = removeHookBlock(existing).trim()
  if (stripped === "#!/bin/sh" || stripped === "") {
    // Hook is now empty — remove the file entirely
    fs.unlinkSync(hookFile)
    console.log(chalk.green("  ✓  Hook removed (file was empty after removal)."))
  } else {
    fs.writeFileSync(hookFile, stripped + "\n")
    console.log(chalk.green(`  ✓  dbtender block removed from ${hookFile}`))
  }

  // Update config
  const config = readConfig()
  if (config) writeConfig({ ...config, gitIntegration: false })
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerGitHooks(program: Command): void {
  const cmd = program
    .command("git-hooks")
    .description("Manage git hooks for automatic DB state switching")

  cmd
    .command("install")
    .description("Install post-checkout hook — auto-runs dbtender switch on git checkout")
    .action(install)

  cmd
    .command("uninstall")
    .description("Remove the dbtender block from post-checkout hook")
    .action(uninstall)
}
