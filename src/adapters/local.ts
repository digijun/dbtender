/**
 * src/adapters/local.ts
 *
 * Local PostgreSQL adapter — connects to a native Postgres install
 * (Homebrew, Postgres.app, Linux package, etc.) via TCP or Unix socket.
 *
 * Snapshot strategy: logical dump via pg_dump (plain SQL, --clean).
 * Restore strategy: DROP + CREATE DATABASE for a clean slate (same as Docker).
 * Branch strategy: CREATE DATABASE with branch name on the same server.
 */

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import type { IAdapter, AdapterInfo, Snapshot, Branch } from "../lib/types.js"
import { snapshotStoreDir, branchStoreDir } from "../lib/config.js"
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

export interface LocalAdapterOptions {
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
}

export class LocalAdapter implements IAdapter {
  private host: string
  private port: number
  private user: string
  private password: string
  private database: string

  constructor(opts: LocalAdapterOptions) {
    this.host = opts.host ?? "localhost"
    this.port = opts.port ?? 5432
    this.user = opts.user ?? process.env.USER ?? process.env.USERNAME ?? "postgres"
    this.password = opts.password ?? "postgres"
    this.database = opts.database ?? "postgres"
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private get connString(): string {
    return `postgresql://${this.user}:${this.password}@${this.host}:${this.port}/${this.database}`
  }

  private psql(args: string[], opts?: { stdin?: string }): ReturnType<typeof spawnSync> {
    const env: Record<string, string> = {}
    if (this.password) env.PGPASSWORD = this.password
    if (this.host) env.PGHOST = this.host
    if (this.port) env.PGPORT = String(this.port)
    const r = spawnSync("psql", ["-U", this.user, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      input: opts?.stdin,
    })
    return r
  }

  private pgDump(args: string[]): ReturnType<typeof spawnSync> {
    const env: Record<string, string> = {}
    if (this.password) env.PGPASSWORD = this.password
    if (this.host) env.PGHOST = this.host
    if (this.port) env.PGPORT = String(this.port)
    return spawnSync("pg_dump", ["-U", this.user, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    })
  }

  private branchDbName(name: string): string {
    return `${this.database}_dbtender_branch_${name}`
  }

  private dbUrlFor(database: string): string {
    return `postgresql://${this.user}:${this.password}@${this.host}:${this.port}/${database}`
  }

  /** Dump the target database and write to a file. */
  private dumpToFile(destFile: string): void {
    const r = this.pgDump([
      "--clean", "--if-exists", "--no-owner", "--no-acl",
      "-d", this.database, "-f", destFile,
    ])
    if (r.status !== 0) throw new Error(`pg_dump failed: ${r.stderr}`)
  }

  /** Restore a dump file into the target database.
   *
   *  Drops and recreates the database from scratch first, avoiding
   *  FK/constraint dependency ordering issues. */
  private restoreFromFile(srcFile: string): void {
    const escapedDb = this.database.replace(/'/g, "''")

    // Strip any database-level DROP/CREATE DATABASE + \connect preamble
    let sql = fs.readFileSync(srcFile, "utf8")
    sql = sql
      .replace(/^\s*DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?\S+;\s*\n/i, "")
      .replace(/^\s*CREATE\s+DATABASE\s+\S+[^;]*;\s*\n/i, "")
      .replace(/^\s*\\connect\s+\S+\s*\n/i, "")

    // Terminate connections to the target database
    try {
      this.psql(["-d", "postgres", "-c",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${escapedDb}' AND pid <> pg_backend_pid()`
      ])
    } catch { /* connections may already be dead */ }

    // Drop database (separate call — DROP DATABASE can't run in a transaction)
    const dropResult = this.psql([
      "-v", "ON_ERROR_STOP=1", "-d", "postgres",
      "-c", `DROP DATABASE IF EXISTS "${escapedDb}";`,
    ])
    if (dropResult.status !== 0) {
      throw new Error(`Failed to drop database "${this.database}": ${dropResult.stderr}`)
    }

    // Create database
    const createResult = this.psql([
      "-v", "ON_ERROR_STOP=1", "-d", "postgres",
      "-c", `CREATE DATABASE "${escapedDb}";`,
    ])
    if (createResult.status !== 0) {
      throw new Error(`Failed to create database "${this.database}": ${createResult.stderr}`)
    }

    // Restore into the fresh database
    const r = this.psql(["-v", "ON_ERROR_STOP=1", "-d", this.database, "-f", srcFile])
    if (r.status !== 0) throw new Error(`psql restore failed: ${r.stderr}`)
  }

  // ── IAdapter ───────────────────────────────────────────────────────────────

  async ping(): Promise<void> {
    const r = this.psql(["-d", this.database, "-c", "SELECT 1"], { stdin: "" })
    if (r.status !== 0) {
      throw new Error(
        `Cannot connect to Postgres at ${this.host}:${this.port}/${this.database}\n` +
        `  ${String(r.stderr || r.stdout || "Unknown error").trim()}`
      )
    }
  }

  async info(): Promise<AdapterInfo> {
    const r = this.psql(["-d", this.database, "-tAc", "SHOW server_version"])
    const version = String(r.stdout ?? "").trim() || "unknown"
    return { type: "local", version, connectionString: this.connString }
  }

  async dumpRaw(): Promise<string> {
    const tmp = path.join(os.tmpdir(), `dbtender-raw-${Date.now()}.sql`)
    this.dumpToFile(tmp)
    const content = fs.readFileSync(tmp, "utf8")
    fs.unlinkSync(tmp)
    return content
  }

  async restoreRaw(sql: string): Promise<void> {
    const tmp = path.join(os.tmpdir(), `dbtender-raw-${Date.now()}.sql`)
    fs.writeFileSync(tmp, sql)
    this.restoreFromFile(tmp)
    fs.unlinkSync(tmp)
  }

  async snapshotCreate(name: string, notes?: string): Promise<Snapshot> {
    const id = newSnapshotId()
    const snapName = name || autoSnapshotName(id)
    const dest = snapshotDir(id)
    fs.mkdirSync(dest, { recursive: true })
    const dumpFile = path.join(dest, "dump.sql")

    this.dumpToFile(dumpFile)

    const sizeBytes = fs.statSync(dumpFile).size
    const sizeMb = Math.round(sizeBytes / 1024 / 1024)
    const snap: Snapshot = { id, name: snapName, createdAt: new Date(), sizeMb, notes }
    saveSnapshot(snap)

    if (sizeBytes < 10240) {
      const content = fs.readFileSync(dumpFile, "utf8")
      const hasUserTable = /CREATE TABLE (?!pg_catalog\.|information_schema\.)/.test(content)
      if (!hasUserTable) {
        console.warn(`\n  Warning: dump contains no user tables (${sizeBytes} bytes).`)
        console.warn(`  You may have selected the wrong database during init.`)
        console.warn(`  Run: dbtender init   then try again.\n`)
      }
    }

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

    this.restoreFromFile(path.join(snapshotDir(snap.id), "dump.sql"))
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

    const branchDb = this.branchDbName(name)

    // Create the branch database fresh, then restore the snapshot
    const createResult = this.psql([
      "-v", "ON_ERROR_STOP=1", "-d", "postgres",
      "-c", `CREATE DATABASE "${branchDb}";`,
    ])
    if (createResult.status !== 0) {
      throw new Error(`Failed to create branch database "${branchDb}": ${createResult.stderr}`)
    }

    // Copy the snapshot dump and modify the CONNECT/database to target the branch DB
    const srcDump = path.join(snapshotDir(snap.id), "dump.sql")
    const tmpDump = path.join(branchDir(name), "branch-init.sql")
    fs.mkdirSync(branchDir(name), { recursive: true })
    let sql = fs.readFileSync(srcDump, "utf8")
    sql = sql
      .replace(/^\s*DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?\S+;\s*\n/i, "")
      .replace(/^\s*CREATE\s+DATABASE\s+\S+[^;]*;\s*\n/i, "")
      .replace(/^\s*\\connect\s+\S+\s*\n/i, "")
    fs.writeFileSync(tmpDump, sql)

    const r = this.psql(["-v", "ON_ERROR_STOP=1", "-d", branchDb, "-f", tmpDump])
    if (r.status !== 0) throw new Error(`Branch init restore failed: ${r.stderr}`)

    const branch: Branch = {
      name,
      createdFrom: snap.id,
      createdAt: new Date(),
      connectionString: this.dbUrlFor(branchDb),
    }
    saveBranch(branch)
    return branch
  }

  async branchList(): Promise<Branch[]> {
    return listBranches()
  }

  async branchPromote(name: string): Promise<void> {
    const branch = findBranch(name)
    if (!branch) throw new Error(`Branch "${name}" not found.`)

    await this.snapshotCreate(`pre-promote-${name}`, `Auto-snapshot before promoting branch "${name}"`)

    // Dump the branch database
    const branchDb = this.branchDbName(name)
    const tmpDump = path.join(branchDir(name), "promote.sql")
    const dumpResult = this.pgDump([
      "--clean", "--if-exists", "--no-owner", "--no-acl",
      "-d", branchDb, "-f", tmpDump,
    ])
    if (dumpResult.status !== 0) throw new Error(`pg_dump for branch promote failed: ${dumpResult.stderr}`)

    // Restore into main (this handles DROP + CREATE DATABASE internally)
    this.restoreFromFile(tmpDump)
    fs.unlinkSync(tmpDump)
  }

  async branchDelete(name: string): Promise<void> {
    const branchDb = this.branchDbName(name)

    try {
      this.psql([
        "-d", "postgres", "-c",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${branchDb}' AND pid <> pg_backend_pid()`
      ])
    } catch {}

    this.psql([
      "-v", "ON_ERROR_STOP=1", "-d", "postgres",
      "-c", `DROP DATABASE IF EXISTS "${branchDb}";`,
    ])
    removeBranch(name)
  }
}
