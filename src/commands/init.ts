/**
 * src/commands/init.ts
 *
 * dbtender init — interactive setup wizard.
 * Writes .dbtender/dbtender.json and validates the connection.
 */

import type { Command } from "commander"
import { spawnSync } from "node:child_process"
import chalk from "chalk"
import ora from "ora"
import enquirer from "enquirer"
import { writeConfig, projectDbEnvDir } from "../lib/config.js"
import { DockerAdapter } from "../adapters/docker.js"
import { PGliteAdapter } from "../adapters/pglite.js"
import { LocalAdapter } from "../adapters/local.js"
import { currentGitBranch } from "../lib/git.js"

const { prompt } = enquirer as unknown as {
  prompt: <T extends Record<string, unknown>>(opts: object) => Promise<T>
}

function detectPostgresContainers(): Array<{ name: string; image: string; port: string }> {
  const r = spawnSync("docker", [
    "ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}",
  ], { encoding: "utf8" })
  if (r.status !== 0) return []
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [name, image, ports] = line.split("\t")
      return { name: name ?? "", image: image ?? "", port: ports ?? "" }
    })
    .filter(c => c.image.toLowerCase().includes("postgres"))
}

function detectGitBranches(): string[] {
  const r = spawnSync("git", ["branch", "--format", "%(refname:short)"], { encoding: "utf8" })
  if (r.status !== 0) return ["main"]
  return r.stdout.trim().split("\n").filter(Boolean)
}

function detectDatabases(containerName: string): string[] {
  const r = spawnSync("docker", [
    "exec", containerName,
    "psql", "-U", "postgres", "-tAc",
    "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres' ORDER BY datname",
  ], { encoding: "utf8" })
  if (r.status !== 0) return []
  return r.stdout.trim().split("\n").filter(Boolean).map(s => s.trim())
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Set up dbtender for this project")
    .action(async () => {
      console.log(chalk.bold("\n  dbtender init\n"))
      console.log("  Creates .dbtender/dbtender.json in your project root.\n")

      // ── Adapter type ───────────────────────────────────────────────────────

      const { adapter } = await prompt<{ adapter: string }>({
        type: "select",
        name: "adapter",
        message: "Which type of database?",
        choices: [
          { name: "docker",  message: "Docker Postgres container" },
          { name: "local",   message: "Local Postgres     (native install — Homebrew, Postgres.app, etc.)" },
          { name: "pglite",  message: "PGlite             (embedded WASM Postgres)" },
        ],
      })

      let adapterConfig: { adapter: "docker"; containerName: string; database?: string }
                       | { adapter: "local"; host?: string; port?: number; user?: string; password?: string; database?: string }
                       | { adapter: "pglite"; pgliteDir: string }

      if (adapter === "docker") {
        const containers = detectPostgresContainers()
        let containerName: string

        if (containers.length > 0) {
          const choices = containers.map(c => ({
            name: c.name,
            message: `${c.name}  ${chalk.dim(`(${c.image})`)}`,
          }))
          choices.push({ name: "__manual__", message: chalk.dim("Enter a container name manually…") })

          const { selected } = await prompt<{ selected: string }>({
            type: "select",
            name: "selected",
            message: "Select a running Postgres container:",
            choices,
          })

          if (selected === "__manual__") {
            const { name } = await prompt<{ name: string }>({
              type: "input",
              name: "name",
              message: "Docker container name?",
              initial: "postgres",
            })
            containerName = name
          } else {
            containerName = selected
          }
        } else {
          const { name } = await prompt<{ name: string }>({
            type: "input",
            name: "name",
            message: "Docker container name?",
            initial: "postgres",
          })
          containerName = name
        }

        // ── Database name ───────────────────────────────────────────────────

        const databases = detectDatabases(containerName)
        let database: string

        if (databases.length > 0) {
          const { selected } = await prompt<{ selected: string }>({
            type: "select",
            name: "selected",
            message: "Which database?",
            choices: databases.map(d => ({ name: d, message: d })),
            initial: 0,
          })
          database = selected
        } else {
          database = "postgres"
        }

        // ── Connect ────────────────────────────────────────────────────────

        const spinner = ora("Connecting…").start()
        try {
          const a = new DockerAdapter({ containerName, database })
          await a.ping()
          const info = await a.info()
          spinner.succeed(`Connected — Postgres ${info.version}  ${chalk.dim(`(${database})`)}`)
        } catch (err) {
          spinner.fail(`Cannot connect: ${(err as Error).message}`)
          process.exit(1)
        }

        adapterConfig = { adapter: "docker", containerName, database }

      } else if (adapter === "local") {
        const { host } = await prompt<{ host: string }>({
          type: "input",
          name: "host",
          message: "Postgres host?",
          initial: "localhost",
        })
        const { port } = await prompt<{ port: string }>({
          type: "input",
          name: "port",
          message: "Port?",
          initial: "5432",
        })
        const { user } = await prompt<{ user: string }>({
          type: "input",
          name: "user",
          message: "User?",
          initial: process.env.USER ?? "postgres",
        })
        const { password } = await prompt<{ password: string }>({
          type: "password",
          name: "password",
          message: "Password?",
        })
        const { database } = await prompt<{ database: string }>({
          type: "input",
          name: "database",
          message: "Database name?",
          initial: "postgres",
        })

        const spinner = ora("Connecting…").start()
        try {
          const a = new LocalAdapter({ host, port: Number(port), user, password, database })
          await a.ping()
          const info = await a.info()
          spinner.succeed(`Connected — Postgres ${info.version}  ${chalk.dim(`(${database})`)}`)
        } catch (err) {
          spinner.fail(`Cannot connect: ${(err as Error).message}`)
          process.exit(1)
        }

        adapterConfig = { adapter: "local", host, port: Number(port), user, password, database }

      } else {
        const { pgliteDir } = await prompt<{ pgliteDir: string }>({
          type: "input",
          name: "pgliteDir",
          message: "Path to PGlite data directory?",
          initial: "./mydb",
        })

        const spinner = ora("Connecting…").start()
        try {
          const a = new PGliteAdapter({ dataDir: pgliteDir })
          await a.ping()
          const info = await a.info()
          spinner.succeed(`Connected — Postgres ${info.version}`)
        } catch (err) {
          spinner.fail(`Cannot connect: ${(err as Error).message}`)
          process.exit(1)
        }

        adapterConfig = { adapter: "pglite", pgliteDir }
      }

      // ── Git integration ────────────────────────────────────────────────────

      const { gitIntegration } = await prompt<{ gitIntegration: string }>({
        type: "select",
        name: "gitIntegration",
        message: "Enable git integration? (auto-save/restore DB on branch switch)",
        choices: [
          { name: "yes", message: "Yes" },
          { name: "no",  message: "No" },
        ],
        initial: 0,
      })

      let productionBranch = "main"
      if (gitIntegration === "yes") {
        const branches = detectGitBranches()
        const current = currentGitBranch()
        const preferred = current ?? branches.find(b => b === "main" || b === "master")
        const initialIndex = preferred ? branches.indexOf(preferred) : 0

        const r = await prompt<{ productionBranch: string }>({
          type: "select",
          name: "productionBranch",
          message: "What is your main development branch?",
          choices: branches.map(b => ({ name: b, message: b })),
          initial: initialIndex,
        })
        productionBranch = r.productionBranch
      }

      const enableGit = gitIntegration === "yes"

      // ── Write config ───────────────────────────────────────────────────────

      writeConfig({
        version: 1,
        adapter: adapterConfig,
        gitIntegration: enableGit,
        productionBranch,
      })

      const dir = projectDbEnvDir()
      console.log(chalk.green(`\n  ✓  ${dir}/dbtender.json created`))
      if (enableGit) {
        console.log(chalk.dim("  Run: dbtender git-hooks install   to activate auto-switching"))
      }
      console.log(chalk.dim("  Tip: add .dbtender/snapshots/ .dbtender/branches/ to .gitignore, or commit them.\n"))
      console.log("  Next steps:")
      console.log(chalk.cyan("    dbtender snapshot save --name initial-state"))
      console.log(chalk.cyan("    dbtender status\n"))
    })
}
