/**
 * src/commands/merge.ts
 *
 * dbtender merge <branch>
 *
 * Compares the schema of a feature branch against the production baseline
 * and reports conflicts. Does not modify anything — purely diagnostic.
 *
 * Conflict model:
 *   - "theirs" = production baseline (already deployed, immutable)
 *   - "yours"  = feature branch (not deployed, modify your migration)
 *
 * Usage:
 *   dbtender merge feature/payments
 *   dbtender merge feature/payments --format=markdown   # for CI / PR comments
 */

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { readConfig } from "../lib/config.js"
import { branchStateExists, loadBranchState } from "../lib/store.js"
import { currentGitBranch } from "../lib/git.js"
import { resolveAdapter } from "../adapters/index.js"

const PGLITE_STATE_PREFIX = "pglite-datadir:"

// ── Schema parsing ────────────────────────────────────────────────────────────

interface SchemaObject {
  type: "table" | "index" | "constraint" | "function" | "view" | "sequence" | "type" | "other"
  name: string       // canonical key, e.g. "TABLE users" or "INDEX idx_users_email"
  definition: string // the full DDL statement
}

function parseSchema(sql: string): SchemaObject[] {
  const objects: SchemaObject[] = []
  // Strip comments and blank lines, then split on statement boundaries
  const statements = sql
    .replace(/--[^\n]*/g, "")
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  for (const stmt of statements) {
    const upper = stmt.toUpperCase()
    // Skip data-only statements
    if (upper.startsWith("COPY ") || upper.startsWith("INSERT INTO") ||
        upper.startsWith("SELECT PG_CATALOG.SETVAL") || upper.startsWith("SET ") ||
        upper.startsWith("SELECT ") || upper.startsWith("--")) continue

    let type: SchemaObject["type"] = "other"
    let name = ""

    if (upper.startsWith("CREATE TABLE") || upper.startsWith("ALTER TABLE")) {
      type = "table"
      name = extractName(stmt, /(?:CREATE TABLE|ALTER TABLE)\s+(?:IF NOT EXISTS\s+)?(\S+)/i)
    } else if (upper.startsWith("CREATE INDEX") || upper.startsWith("CREATE UNIQUE INDEX")) {
      type = "index"
      name = extractName(stmt, /CREATE (?:UNIQUE )?INDEX\s+(?:IF NOT EXISTS\s+)?(\S+)/i)
    } else if (upper.startsWith("CREATE FUNCTION") || upper.startsWith("CREATE OR REPLACE FUNCTION")) {
      type = "function"
      name = extractName(stmt, /CREATE (?:OR REPLACE )?FUNCTION\s+(\S+)/i)
    } else if (upper.startsWith("CREATE VIEW") || upper.startsWith("CREATE OR REPLACE VIEW")) {
      type = "view"
      name = extractName(stmt, /CREATE (?:OR REPLACE )?VIEW\s+(\S+)/i)
    } else if (upper.startsWith("CREATE SEQUENCE")) {
      type = "sequence"
      name = extractName(stmt, /CREATE SEQUENCE\s+(?:IF NOT EXISTS\s+)?(\S+)/i)
    } else if (upper.startsWith("CREATE TYPE")) {
      type = "type"
      name = extractName(stmt, /CREATE TYPE\s+(\S+)/i)
    } else {
      continue // skip SET, GRANT, etc.
    }

    if (name) {
      objects.push({ type, name: `${type.toUpperCase()} ${name}`, definition: stmt })
    }
  }

  return objects
}

function extractName(stmt: string, re: RegExp): string {
  return stmt.match(re)?.[1]?.replace(/["']/g, "").toLowerCase() ?? ""
}

// ── Diff logic ────────────────────────────────────────────────────────────────

interface MergeReport {
  branch: string
  baseline: string
  safeAdditions: SchemaObject[]      // in branch only — will apply cleanly
  baselineAdditions: SchemaObject[]  // in baseline only — branch needs to account for these
  conflicts: Array<{                 // same name, different definition
    name: string
    baselineDefinition: string
    branchDefinition: string
  }>
}

function computeMergeReport(
  branchSql: string,
  baselineSql: string,
  branchName: string,
  baselineName: string
): MergeReport {
  const branchObjects  = parseSchema(branchSql)
  const baselineObjects = parseSchema(baselineSql)

  const branchMap  = new Map(branchObjects.map(o => [o.name, o]))
  const baselineMap = new Map(baselineObjects.map(o => [o.name, o]))

  const safeAdditions: SchemaObject[] = []
  const baselineAdditions: SchemaObject[] = []
  const conflicts: MergeReport["conflicts"] = []

  for (const [name, obj] of branchMap) {
    if (!baselineMap.has(name)) {
      safeAdditions.push(obj)
    } else {
      const baselineObj = baselineMap.get(name)!
      if (normalise(obj.definition) !== normalise(baselineObj.definition)) {
        conflicts.push({
          name,
          baselineDefinition: baselineObj.definition,
          branchDefinition: obj.definition,
        })
      }
    }
  }

  for (const [name, obj] of baselineMap) {
    if (!branchMap.has(name)) {
      baselineAdditions.push(obj)
    }
  }

  return { branch: branchName, baseline: baselineName, safeAdditions, baselineAdditions, conflicts }
}

function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/"/g, "").toLowerCase().trim()
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function renderTerminal(report: MergeReport): void {
  const { branch, baseline, safeAdditions, baselineAdditions, conflicts } = report
  console.log()
  console.log(chalk.bold(`  dbtender merge: ${chalk.cyan(branch)} → ${chalk.cyan(baseline)}`))
  console.log()

  if (conflicts.length === 0 && baselineAdditions.length === 0) {
    console.log(chalk.green("  ✓ No conflicts — safe to merge.\n"))
  }

  if (conflicts.length > 0) {
    console.log(chalk.red.bold(`  ✗ ${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""} — modify your migration:\n`))
    for (const c of conflicts) {
      console.log(chalk.red(`    ~ ${c.name}`))
      console.log(chalk.dim("      Production (immutable):"))
      c.baselineDefinition.split("\n").slice(0, 3).forEach(l => console.log(chalk.dim(`        ${l}`)))
      console.log(chalk.dim("      Your branch:"))
      c.branchDefinition.split("\n").slice(0, 3).forEach(l => console.log(chalk.yellow(`        ${l}`)))
      console.log()
    }
  }

  if (baselineAdditions.length > 0) {
    console.log(chalk.yellow.bold(`  ⚠ ${baselineAdditions.length} production addition${baselineAdditions.length > 1 ? "s" : ""} your branch doesn't have:\n`))
    for (const o of baselineAdditions) {
      console.log(chalk.yellow(`    + ${o.name}`))
    }
    console.log()
    console.log(chalk.dim("  These were added to production after your branch diverged."))
    console.log(chalk.dim("  Your migration must not conflict with them.\n"))
  }

  if (safeAdditions.length > 0) {
    console.log(chalk.green.bold(`  ✓ ${safeAdditions.length} safe addition${safeAdditions.length > 1 ? "s" : ""} (only in your branch):\n`))
    for (const o of safeAdditions) {
      console.log(chalk.green(`    + ${o.name}`))
    }
    console.log()
  }
}

function renderMarkdown(report: MergeReport): void {
  const { branch, baseline, safeAdditions, baselineAdditions, conflicts } = report
  const lines: string[] = [
    `## dbtender merge: \`${branch}\` → \`${baseline}\``,
    "",
  ]

  if (conflicts.length === 0 && baselineAdditions.length === 0) {
    lines.push("✅ **No conflicts — safe to merge.**")
  }

  if (conflicts.length > 0) {
    lines.push(`### ❌ ${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""} — modify your migration`)
    lines.push("")
    lines.push("Production is already deployed and immutable. Update your migration to avoid these:")
    lines.push("")
    for (const c of conflicts) {
      lines.push(`**\`${c.name}\`**`)
      lines.push("```sql")
      lines.push("-- Production (immutable):")
      lines.push(c.baselineDefinition.split("\n").slice(0, 5).join("\n"))
      lines.push("-- Your branch:")
      lines.push(c.branchDefinition.split("\n").slice(0, 5).join("\n"))
      lines.push("```")
      lines.push("")
    }
  }

  if (baselineAdditions.length > 0) {
    lines.push(`### ⚠️ ${baselineAdditions.length} production addition${baselineAdditions.length > 1 ? "s" : ""} not in your branch`)
    lines.push("")
    lines.push("Added to production after your branch diverged — ensure your migration doesn't conflict:")
    lines.push("")
    for (const o of baselineAdditions) {
      lines.push(`- \`${o.name}\``)
    }
    lines.push("")
  }

  if (safeAdditions.length > 0) {
    lines.push(`### ✅ ${safeAdditions.length} safe addition${safeAdditions.length > 1 ? "s" : ""} (only in your branch)`)
    lines.push("")
    for (const o of safeAdditions) {
      lines.push(`- \`${o.name}\``)
    }
    lines.push("")
  }

  console.log(lines.join("\n"))
}

// ── Command ───────────────────────────────────────────────────────────────────

export function registerMerge(program: Command): void {
  program
    .command("merge <branch>")
    .description(
      "Check if a branch's schema conflicts with the production baseline\n" +
      "  e.g. dbtender merge feature/payments\n" +
      "       dbtender merge feature/payments --format=markdown"
    )
    .option("--format <fmt>", "Output format: terminal (default) or markdown", "terminal")
    .option("--baseline <branch>", "Override the production baseline branch (default: from config or 'main')")
    .action(async (branch: string, opts: { format: string; baseline?: string }) => {
      const config = readConfig()
      if (!config) {
        console.error(chalk.red("  No .dbtender/dbtender.json found. Run: dbtender init"))
        process.exit(1)
      }

      const baselineName = opts.baseline ?? config.productionBranch ?? "main"
      const spinner = opts.format === "terminal" ? ora("Loading schemas…").start() : null

      try {
        // Load branch schema
        let branchSql: string
        if (branch === currentGitBranch()) {
          // Branch is current — dump live DB
          spinner && (spinner.text = `Dumping current DB (${branch})…`)
          const adapter = resolveAdapter()
          await adapter.ping()
          branchSql = await adapter.dumpRaw()
        } else if (branchStateExists(branch)) {
          branchSql = loadBranchState(branch)
        } else {
          spinner?.fail(`No saved state for branch "${branch}". Switch to it first: dbtender switch ${branch}`)
          process.exit(1)
        }
        if (branchSql.startsWith(PGLITE_STATE_PREFIX)) {
          spinner?.fail("Schema merge checks are not currently available for PGlite branch states.")
          process.exit(1)
        }

        // Load baseline schema
        let baselineSql: string
        if (baselineName === currentGitBranch()) {
          spinner && (spinner.text = `Dumping current DB (${baselineName})…`)
          const adapter = resolveAdapter()
          await adapter.ping()
          baselineSql = await adapter.dumpRaw()
        } else if (branchStateExists(baselineName)) {
          baselineSql = loadBranchState(baselineName)
        } else {
          spinner?.fail(
            `No saved state for production baseline "${baselineName}".\n` +
            `  Switch to that branch once to save its state: git checkout ${baselineName} && dbtender switch ${baselineName}`
          )
          process.exit(1)
        }
        if (baselineSql.startsWith(PGLITE_STATE_PREFIX)) {
          spinner?.fail("Schema merge checks are not currently available for PGlite branch states.")
          process.exit(1)
        }

        spinner?.stop()

        const report = computeMergeReport(branchSql, baselineSql, branch, baselineName)

        if (opts.format === "markdown") {
          renderMarkdown(report)
        } else {
          renderTerminal(report)
        }

        // Exit with non-zero if conflicts exist — useful for CI
        if (report.conflicts.length > 0) process.exit(1)

      } catch (err) {
        spinner?.fail((err as Error).message)
        process.exit(1)
      }
    })
}
