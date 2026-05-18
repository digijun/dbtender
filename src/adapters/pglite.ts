/**
 * src/adapters/pglite.ts
 *
 * PGlite adapter.
 * Snapshot strategy: archive the PGDATA directory via dumpDataDir().
 * Branch strategy: restore the archived data dir into a new PGlite directory.
 */

import fs from "node:fs"
import path from "node:path"
import type { IAdapter, AdapterInfo, Snapshot, Branch } from "../lib/types.js"
import {
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
} from "../lib/store.js"

const PGLITE_STATE_PREFIX = "pglite-datadir:"

export interface PGliteAdapterOptions {
  /** Path to the PGlite data directory, e.g. "./mydb" */
  dataDir: string
}

export class PGliteAdapter implements IAdapter {
  private dataDir: string

  constructor(opts: PGliteAdapterOptions) {
    this.dataDir = path.resolve(opts.dataDir)
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async openDb(dataDir = this.dataDir) {
    const { PGlite } = await import("@electric-sql/pglite")
    return PGlite.create({ dataDir })
  }

  private async dumpToFile(dataDir: string, destFile: string): Promise<void> {
    const db = await this.openDb(dataDir)
    const archive = await db.dumpDataDir("gzip")
    await db.close()
    const bytes = Buffer.from(await archive.arrayBuffer())
    fs.writeFileSync(destFile, bytes)
  }

  private async restoreFromFile(dataDir: string, srcFile: string): Promise<void> {
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dataDir), { recursive: true })
    const { PGlite } = await import("@electric-sql/pglite")
    const bytes = fs.readFileSync(srcFile)
    const db = await PGlite.create({
      dataDir,
      loadDataDir: new File([bytes], path.basename(srcFile)),
    })
    await db.close()
  }

  private snapshotArtifactPath(id: string): string {
    return path.join(snapshotDir(id), "data.tgz")
  }

  private resolveSnapshotArtifactPath(id: string): string {
    const archivePath = this.snapshotArtifactPath(id)
    if (fs.existsSync(archivePath)) return archivePath
    const legacyDumpPath = path.join(snapshotDir(id), "dump.sql")
    if (fs.existsSync(legacyDumpPath)) return legacyDumpPath
    throw new Error(`Snapshot "${id}" has no restorable artifact.`)
  }

  // ── IAdapter ───────────────────────────────────────────────────────────────

  async ping(): Promise<void> {
    if (!fs.existsSync(this.dataDir)) {
      throw new Error(
        `PGlite data directory not found: ${this.dataDir}\n` +
        `  Create it first by connecting with PGlite, or run: dbtender init`
      )
    }
    const db = await this.openDb()
    await db.query("SELECT 1")
    await db.close()
  }

  async info(): Promise<AdapterInfo> {
    const db = await this.openDb()
    const r = await db.query<{ version: string }>("SELECT version()")
    await db.close()
    const raw = r.rows[0]?.version ?? "unknown"
    const match = raw.match(/PostgreSQL ([\d.]+)/)
    return {
      type: "pglite",
      version: match?.[1] ?? raw,
      connectionString: `pglite://${this.dataDir}`,
      dataPath: this.dataDir,
    }
  }

  async dumpRaw(): Promise<string> {
    const db = await this.openDb()
    const archive = await db.dumpDataDir("gzip")
    await db.close()
    const bytes = Buffer.from(await archive.arrayBuffer())
    return PGLITE_STATE_PREFIX + bytes.toString("base64")
  }

  async restoreRaw(state: string): Promise<void> {
    if (!state.startsWith(PGLITE_STATE_PREFIX)) {
      if (fs.existsSync(this.dataDir)) fs.rmSync(this.dataDir, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(this.dataDir), { recursive: true })
      const { PGlite } = await import("@electric-sql/pglite")
      const db = await PGlite.create({ dataDir: this.dataDir })
      await db.exec(state)
      await db.close()
      return
    }

    if (fs.existsSync(this.dataDir)) fs.rmSync(this.dataDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(this.dataDir), { recursive: true })
    const bytes = Buffer.from(state.slice(PGLITE_STATE_PREFIX.length), "base64")
    const { PGlite } = await import("@electric-sql/pglite")
    const db = await PGlite.create({
      dataDir: this.dataDir,
      loadDataDir: new File([bytes], "state.tgz"),
    })
    await db.close()
  }

  async snapshotCreate(name: string, notes?: string): Promise<Snapshot> {
    const id = newSnapshotId()
    const snapName = name || autoSnapshotName(id)
    const dest = snapshotDir(id)
    fs.mkdirSync(dest, { recursive: true })
    const dumpFile = this.snapshotArtifactPath(id)

    await this.dumpToFile(this.dataDir, dumpFile)

    const sizeMb = Math.round(fs.statSync(dumpFile).size / 1024 / 1024)
    const snap: Snapshot = { id, name: snapName, createdAt: new Date(), sizeMb, notes }
    saveSnapshot(snap)
    return snap
  }

  async snapshotList(): Promise<Snapshot[]> {
    return listSnapshots()
  }

  async snapshotRestore(idOrName: string, opts: { skipAutoSnapshot?: boolean } = {}): Promise<void> {
    const snap = findSnapshot(idOrName)
    if (!snap) throw new Error(`Snapshot "${idOrName}" not found.`)

    if (!opts.skipAutoSnapshot) {
      await this.snapshotCreate(`pre-restore-${snap.id}`, `Auto-snapshot before restoring "${snap.name}"`)
    }

    await this.restoreFromFile(this.dataDir, this.resolveSnapshotArtifactPath(snap.id))
  }

  async snapshotDelete(idOrName: string): Promise<void> {
    if (!findSnapshot(idOrName)) throw new Error(`Snapshot "${idOrName}" not found.`)
    removeSnapshot(idOrName)
  }

  async branchCreate(name: string, fromSnapshot?: string): Promise<Branch> {
    let snap: Snapshot
    if (fromSnapshot) {
      const s = findSnapshot(fromSnapshot)
      if (!s) throw new Error(`Snapshot "${fromSnapshot}" not found.`)
      snap = s
    } else {
      snap = await this.snapshotCreate(`branch-source-${name}`)
    }

    if (findBranch(name)) throw new Error(`Branch "${name}" already exists.`)

    const bDir = branchDir(name)
    const branchDataDir = path.join(bDir, "data")
    await this.restoreFromFile(branchDataDir, this.resolveSnapshotArtifactPath(snap.id))

    const branch: Branch = {
      name,
      createdFrom: snap.id,
      createdAt: new Date(),
      connectionString: `pglite://${branchDataDir}`,
    }
    saveBranch(branch)
    return branch
  }

  async branchList(): Promise<Branch[]> {
    return listBranches()
  }

  async branchPromote(name: string): Promise<void> {
    const bDir = branchDir(name)
    if (!findBranch(name)) throw new Error(`Branch "${name}" not found.`)
    const branchDataDir = path.join(bDir, "data")

    // Auto-snapshot main before overwriting
    await this.snapshotCreate(`pre-promote-${name}`, `Auto-snapshot before promoting branch "${name}"`)

    // Dump from branch, restore into main
    const tmpDump = path.join(bDir, "promote.tgz")
    await this.dumpToFile(branchDataDir, tmpDump)
    await this.restoreFromFile(this.dataDir, tmpDump)
    fs.unlinkSync(tmpDump)
  }

  async branchDelete(name: string): Promise<void> {
    removeBranch(name)
  }
}
