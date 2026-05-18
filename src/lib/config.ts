/**
 * src/lib/config.ts
 *
 * Reads and writes .dbtender/dbtender.json (per-project config).
 * Provides pure path helpers — callers are responsible for creating directories.
 */

import path from "node:path"
import fs from "node:fs"

// ── Config shapes ─────────────────────────────────────────────────────────────

export type AdapterType = "docker" | "pglite"

export interface DockerAdapterConfig {
  adapter: "docker"
  containerName: string
  port?: number
  user?: string
  password?: string
  database?: string
}

export interface PGliteAdapterConfig {
  adapter: "pglite"
  pgliteDir: string
}

export type AdapterConfig = DockerAdapterConfig | PGliteAdapterConfig

export interface ProjectConfig {
  version: 1
  adapter: AdapterConfig
  /** Whether to auto-save/restore DB state on git branch switch. */
  gitIntegration?: boolean
  /** The git branch that represents the deployed/production baseline. Default: "main" */
  productionBranch?: string
}

// ── Pure path helpers ─────────────────────────────────────────────────────────

const DBTENDER_DIR = ".dbtender"
const CONFIG_FILE = "dbtender.json"

export function projectDbEnvDir(): string {
  return path.join(process.cwd(), DBTENDER_DIR)
}

/**
 * Stable project id derived from cwd — last two path segments, sanitised.
 * e.g.  /home/alice/projects/myapp/backend  →  myapp-backend
 */
export function projectId(): string {
  return process.cwd()
    .split(path.sep)
    .filter(Boolean)
    .slice(-2)
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "_")
}

export function snapshotStoreDir(): string {
  return path.join(process.cwd(), DBTENDER_DIR, "snapshots")
}

export function branchStoreDir(): string {
  return path.join(process.cwd(), DBTENDER_DIR, "branches")
}

// ── Read / write ──────────────────────────────────────────────────────────────

export function readConfig(): ProjectConfig | null {
  const p = path.join(process.cwd(), DBTENDER_DIR, CONFIG_FILE)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, "utf8")) as ProjectConfig
}

export function writeConfig(config: ProjectConfig): void {
  const dir = projectDbEnvDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n")
}
