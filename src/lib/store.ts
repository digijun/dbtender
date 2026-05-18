/**
 * src/lib/store.ts
 *
 * Snapshot + branch metadata store.
 *
 * Both snapshots and branches are stored as directories:
 *   .dbtender/snapshots/<id>/
 *   .dbtender/branches/<name>/
 *
 * Each directory contains a .meta.json with the entry's metadata.
 * The actual dump (dump.sql) and branch data live alongside .meta.json.
 * No central manifest — directory scan is the source of truth.
 */

import fs from "node:fs"
import path from "node:path"
import type { Snapshot, Branch } from "./types.js"
import { snapshotStoreDir, branchStoreDir, projectDbEnvDir } from "./config.js"

// ── ID / naming helpers ───────────────────────────────────────────────────────

/** Generate a snapshot ID from the current timestamp: YYYYMMDD-HHmmss */
export function newSnapshotId(): string {
  const n = new Date()
  const p = (v: number) => String(v).padStart(2, "0")
  return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`
}

/** Default name when the user doesn't provide one. */
export function autoSnapshotName(id: string): string {
  return `snapshot-${id}`
}

/** Absolute path to a snapshot's directory. */
export function snapshotDir(id: string): string {
  return path.join(snapshotStoreDir(), id)
}

/** Absolute path to a branch's directory. */
export function branchDir(name: string): string {
  return path.join(branchStoreDir(), name)
}

// ── Snapshot store ────────────────────────────────────────────────────────────

export function listSnapshots(): Snapshot[] {
  const root = snapshotStoreDir()
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root)
    .flatMap(entry => {
      const meta = path.join(root, entry, ".meta.json")
      if (!fs.existsSync(meta)) return []
      try {
        const raw = JSON.parse(fs.readFileSync(meta, "utf8")) as Snapshot
        return [{ ...raw, createdAt: new Date(raw.createdAt) }]
      } catch { return [] }
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

export function findSnapshot(idOrName: string): Snapshot | undefined {
  return listSnapshots().find(s => s.id === idOrName || s.name === idOrName)
}

export function saveSnapshot(snap: Snapshot): void {
  const dir = snapshotDir(snap.id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, ".meta.json"), JSON.stringify(snap, null, 2) + "\n")
}

/** Removes the entire snapshot directory (metadata + dump). */
export function removeSnapshot(idOrName: string): boolean {
  const snap = findSnapshot(idOrName)
  if (!snap) return false
  const d = snapshotDir(snap.id)
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
  return true
}

// ── Branch store ──────────────────────────────────────────────────────────────

export function listBranches(): Branch[] {
  const root = branchStoreDir()
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root)
    .flatMap(entry => {
      const meta = path.join(root, entry, ".meta.json")
      if (!fs.existsSync(meta)) return []
      try {
        const raw = JSON.parse(fs.readFileSync(meta, "utf8")) as Branch
        return [{ ...raw, createdAt: new Date(raw.createdAt) }]
      } catch { return [] }
    })
}

export function findBranch(name: string): Branch | undefined {
  return listBranches().find(b => b.name === name)
}

export function saveBranch(branch: Branch): void {
  const dir = branchDir(branch.name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, ".meta.json"), JSON.stringify(branch, null, 2) + "\n")
}

/** Removes the entire branch directory (metadata + data). */
export function removeBranch(name: string): void {
  const dir = branchDir(name)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

// ── Branch states (git integration) ──────────────────────────────────────────
//
// A branch state is a lightweight DB snapshot tied to a git branch name.
// Stored at .dbtender/branch-states/<sanitized-name>/dump.sql
// No metadata file needed — the dump.sql presence is the state.

function branchStateRoot(): string {
  return path.join(projectDbEnvDir(), "branch-states")
}

/** Sanitise a git branch name to a safe directory name. */
export function sanitizeBranchName(name: string): string {
  return name.replace(/\//g, "-").replace(/[^a-zA-Z0-9._-]/g, "_")
}

export function branchStateDumpPath(gitBranch: string): string {
  return path.join(branchStateRoot(), sanitizeBranchName(gitBranch), "dump.sql")
}

export function branchStateExists(gitBranch: string): boolean {
  return fs.existsSync(branchStateDumpPath(gitBranch))
}

export function saveBranchState(gitBranch: string, dumpContent: string): void {
  const dumpPath = branchStateDumpPath(gitBranch)
  fs.mkdirSync(path.dirname(dumpPath), { recursive: true })
  fs.writeFileSync(dumpPath, dumpContent)
}

export function loadBranchState(gitBranch: string): string {
  const dumpPath = branchStateDumpPath(gitBranch)
  if (!fs.existsSync(dumpPath)) throw new Error(`No saved state for branch "${gitBranch}".`)
  return fs.readFileSync(dumpPath, "utf8")
}

export function listBranchStates(): Array<{ branch: string; savedAt: Date; sizeMb: number }> {
  const root = branchStateRoot()
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root)
    .flatMap(entry => {
      const dumpPath = path.join(root, entry, "dump.sql")
      if (!fs.existsSync(dumpPath)) return []
      const stat = fs.statSync(dumpPath)
      return [{ branch: entry, savedAt: stat.mtime, sizeMb: Math.round(stat.size / 1024 / 1024) }]
    })
    .sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime())
}
