/**
 * src/index.ts
 *
 * Library entry point for dbtender.
 * Importable by other Node.js / Electron apps without pulling in CLI dependencies.
 *
 *   import { resolveAdapter, DockerAdapter } from "dbtender"
 */

// ── Adapter factory ───────────────────────────────────────────────────────
export { resolveAdapter } from "./adapters/index.js"

// ── Adapter implementations ───────────────────────────────────────────────
export { DockerAdapter } from "./adapters/docker.js"
export type { DockerAdapterOptions } from "./adapters/docker.js"
export { PGliteAdapter } from "./adapters/pglite.js"
export type { PGliteAdapterOptions } from "./adapters/pglite.js"

// ── Contract types ────────────────────────────────────────────────────────
export type { IAdapter, Snapshot, Branch, AdapterInfo } from "./lib/types.js"

// ── Config ────────────────────────────────────────────────────────────────
export {
  readConfig,
  writeConfig,
  projectDbEnvDir,
  projectId,
  snapshotStoreDir,
  branchStoreDir,
} from "./lib/config.js"
export type {
  AdapterType,
  DockerAdapterConfig,
  PGliteAdapterConfig,
  AdapterConfig,
  ProjectConfig,
} from "./lib/config.js"

// ── Store ─────────────────────────────────────────────────────────────────
export {
  newSnapshotId,
  autoSnapshotName,
  snapshotDir,
  branchDir,
  listSnapshots,
  findSnapshot,
  saveSnapshot,
  removeSnapshot,
  listBranches,
  findBranch,
  saveBranch,
  removeBranch,
  // Branch states (git integration)
  sanitizeBranchName,
  branchStateDumpPath,
  branchStateExists,
  saveBranchState,
  loadBranchState,
  listBranchStates,
} from "./lib/store.js"

// ── Git helpers ───────────────────────────────────────────────────────────
export {
  currentGitBranch,
  gitRoot,
  hooksDir,
  currentBranchFile,
  readTrackedBranch,
  writeTrackedBranch,
} from "./lib/git.js"

// ── Git-aware DB switching ────────────────────────────────────────────────
export { runSwitch } from "./commands/switch.js"
