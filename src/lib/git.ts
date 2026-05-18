/**
 * src/lib/git.ts
 *
 * Minimal git helpers used by switch, git-hooks, and merge commands.
 */

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

/** Returns the current git branch name, or null if not in a git repo. */
export function currentGitBranch(): string | null {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })
  if (r.status !== 0) return null
  const branch = r.stdout.trim()
  return branch === "HEAD" ? null : branch   // detached HEAD
}

/** Returns the root of the git repo, or null. */
export function gitRoot(): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" })
  if (r.status !== 0) return null
  return r.stdout.trim()
}

/** Path to .git/hooks/ for the current repo. */
export function hooksDir(): string | null {
  const root = gitRoot()
  if (!root) return null
  // Support worktrees and custom GIT_DIR
  const hooksPath = path.join(root, ".git", "hooks")
  return fs.existsSync(hooksPath) ? hooksPath : null
}

/** File used to track which git branch the DB was last switched to. */
export function currentBranchFile(): string {
  return path.join(process.cwd(), ".dbtender", "current-branch")
}

export function readTrackedBranch(): string | null {
  const p = currentBranchFile()
  if (!fs.existsSync(p)) return null
  return fs.readFileSync(p, "utf8").trim() || null
}

export function writeTrackedBranch(branch: string): void {
  fs.writeFileSync(currentBranchFile(), branch)
}
