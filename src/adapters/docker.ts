/**
 * src/adapters/docker.ts
 *
 * Docker Postgres adapter.
 * Snapshot strategy: logical dump via pg_dump (plain SQL, --clean).
 * Branch strategy: spin up a new postgres container, restore the dump into it.
 */

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import net from "node:net"
import { spawnSync, execSync } from "node:child_process"
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

export interface DockerAdapterOptions {
  containerName: string
  port?: number
  user?: string
  password?: string
  database?: string
}

export class DockerAdapter implements IAdapter {
  private containerName: string
  private port: number
  private user: string
  private password: string
  private database: string

  constructor(opts: DockerAdapterOptions) {
    this.containerName = opts.containerName
    this.port = opts.port ?? 5432
    this.user = opts.user ?? "postgres"
    this.password = opts.password ?? "postgres"
    this.database = opts.database ?? "postgres"
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private get connString(): string {
    return `postgresql://${this.user}:${this.password}@localhost:${this.port}/${this.database}`
  }

  /** Run a shell command inside the container as the postgres user. */
  private exec(cmd: string): string {
    const r = spawnSync("docker", ["exec", "-u", "postgres", this.containerName, "sh", "-c", cmd], { encoding: "utf8" })
    if (r.status !== 0) throw new Error(`Container exec failed: ${r.stderr || r.stdout}`)
    return r.stdout.trim()
  }

  private async waitForPostgres(containerName: string, maxMs = 30_000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      const r = spawnSync("docker", ["exec", containerName, "pg_isready", "-U", "postgres"], { encoding: "utf8" })
      if (r.status === 0) return
      await new Promise(res => setTimeout(res, 500))
    }
    throw new Error(`Timed out waiting for Postgres in container "${containerName}"`)
  }

  private async findFreePort(from: number): Promise<number> {
    for (let p = from; p < from + 100; p++) {
      const free = await new Promise<boolean>(resolve => {
        const server = net.createServer()
        server.once("error", () => resolve(false))
        server.once("listening", () => { server.close(); resolve(true) })
        server.listen(p, "127.0.0.1")
      })
      if (free) return p
    }
    throw new Error(`No free port found in range ${from}–${from + 99}`)
  }

  /** Dump the target database inside the container, copy the file out.
   *  Uses --clean --if-exists so the dump contains DROP IF EXISTS for each object.
   *  The restore process handles full database recreation separately, avoiding
   *  FK / constraint dependency errors. */
  private dumpToFile(containerName: string, destFile: string): void {
    const tmp = `/tmp/dbtender-dump-${Date.now()}.sql`
    const r = spawnSync("docker", [
      "exec", "-u", "postgres", containerName,
      "pg_dump", "-U", this.user, "--clean", "--if-exists", "--no-owner", "--no-acl", "-d", this.database, "-f", tmp,
    ], { encoding: "utf8" })
    if (r.status !== 0) throw new Error(`pg_dump failed: ${r.stderr}`)
    execSync(`docker cp ${containerName}:${tmp} "${destFile}"`)
    spawnSync("docker", ["exec", containerName, "rm", tmp])
  }

  /** Copy a dump file into the container and restore it.
   *
   *  Restore strategy: DROP + CREATE the target database from scratch (via
   *  the 'postgres' maintenance db), then restore into the fresh database.
   *  This avoids FK/constraint dependency ordering issues that arise when
   *  trying to drop individual objects from a populated database.
   *
   *  Handles both old-format dumps (DDL + data only) and dumps that were
   *  created with --create (which have DROP DATABASE / CREATE DATABASE /
   *  \connect at the top). */
  private restoreFromFile(containerName: string, srcFile: string): void {
    const tmp = `/tmp/dbtender-restore-${Date.now()}.sql`
    const escapedDb = this.database.replace(/'/g, "''")

    // Read the dump and strip any database-level DROP/CREATE DATABASE +
    // \connect preamble so we handle DB recreation ourselves. This makes
    // the restore work identically for both old and --create format dumps.
    // We leave SET / SELECT pg_catalog statements intact — they set up the
    // session state for correct restore (e.g. search_path).
    let sql = fs.readFileSync(srcFile, "utf8")
    sql = sql
      // Strip any DROP DATABASE (with optional IF EXISTS)
      .replace(/^\s*DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?\S+;\s*\n/i, "")
      // Strip any CREATE DATABASE statement
      .replace(/^\s*CREATE\s+DATABASE\s+\S+[^;]*;\s*\n/i, "")
      // Strip any \connect command
      .replace(/^\s*\\connect\s+\S+\s*\n/i, "")

    // Terminate connections to the target database so it can be dropped
    const killConnections = `
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${escapedDb}' AND pid <> pg_backend_pid()
    `.replace(/\n/g, " ").trim()
    try {
      spawnSync("docker", [
        "exec", "-u", "postgres", containerName,
        "psql", "-U", this.user, "-d", "postgres", "-c", killConnections,
      ], { encoding: "utf8", timeout: 10000 })
    } catch { /* connections may already be dead */ }

    // Drop and recreate the database from scratch — clean slate, no dependency issues.
    // Must use separate psql calls because DROP DATABASE cannot run in a transaction block,
    // and psql -c wraps everything in a single implicit transaction.
    const dropResult = spawnSync("docker", [
      "exec", "-u", "postgres", containerName,
      "psql", "-v", "ON_ERROR_STOP=1", "-U", this.user, "-d", "postgres",
      "-c", `DROP DATABASE IF EXISTS "${escapedDb}";`,
    ], { encoding: "utf8" })
    if (dropResult.status !== 0) {
      throw new Error(`Failed to drop database "${this.database}": ${dropResult.stderr}`)
    }

    const createResult = spawnSync("docker", [
      "exec", "-u", "postgres", containerName,
      "psql", "-v", "ON_ERROR_STOP=1", "-U", this.user, "-d", "postgres",
      "-c", `CREATE DATABASE "${escapedDb}";`,
    ], { encoding: "utf8" })
    if (createResult.status !== 0) {
      throw new Error(`Failed to create database "${this.database}": ${createResult.stderr}`)
    }

    // Write the stripped SQL, copy into container, restore into the fresh DB
    fs.writeFileSync(tmp, sql)
    execSync(`docker cp "${tmp}" ${containerName}:${tmp}`)
    const r = spawnSync("docker", [
      "exec", "-u", "postgres", containerName,
      "psql", "-v", "ON_ERROR_STOP=1", "-U", this.user, "-d", this.database, "-f", tmp,
    ], { encoding: "utf8" })
    spawnSync("docker", ["exec", containerName, "rm", tmp])
    try { fs.unlinkSync(tmp) } catch {}
    if (r.status !== 0) throw new Error(`psql restore failed: ${r.stderr}`)
  }

  // ── IAdapter ───────────────────────────────────────────────────────────────

  async ping(): Promise<void> {
    const r = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", this.containerName], { encoding: "utf8" })
    if (r.status !== 0 || r.stdout.trim() !== "true") {
      throw new Error(`Container "${this.containerName}" is not running.\n  Tip: docker ps | grep ${this.containerName}`)
    }
    this.exec(`psql -U ${this.user} -c 'SELECT 1' > /dev/null 2>&1`)
  }

  async info(): Promise<AdapterInfo> {
    const version = this.exec(`psql -U ${this.user} -tAc 'SHOW server_version'`)
    return { type: "docker", version, connectionString: this.connString }
  }

  async dumpRaw(): Promise<string> {
    const tmp = path.join(os.tmpdir(), `dbtender-raw-${Date.now()}.sql`)
    this.dumpToFile(this.containerName, tmp)
    const content = fs.readFileSync(tmp, "utf8")
    fs.unlinkSync(tmp)
    return content
  }

  async restoreRaw(sql: string): Promise<void> {
    const tmp = path.join(os.tmpdir(), `dbtender-raw-${Date.now()}.sql`)
    fs.writeFileSync(tmp, sql)
    this.restoreFromFile(this.containerName, tmp)
    fs.unlinkSync(tmp)
  }

  async snapshotCreate(name: string, notes?: string): Promise<Snapshot> {
    const id = newSnapshotId()
    const snapName = name || autoSnapshotName(id)
    const dest = snapshotDir(id)
    fs.mkdirSync(dest, { recursive: true })
    const dumpFile = path.join(dest, "dump.sql")

    this.dumpToFile(this.containerName, dumpFile)

    const sizeBytes = fs.statSync(dumpFile).size
    const sizeMb = Math.round(sizeBytes / 1024 / 1024)
    const snap: Snapshot = { id, name: snapName, createdAt: new Date(), sizeMb, notes }
    saveSnapshot(snap)

    // Warn if dump looks empty — likely the wrong database was selected
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

    this.restoreFromFile(this.containerName, path.join(snapshotDir(snap.id), "dump.sql"))
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

    const branchPort = await this.findFreePort(5433)
    const cName = `dbtender-branch-${name}`

    execSync(
      `docker run -d --name ${cName}` +
      ` -e POSTGRES_PASSWORD=${this.password}` +
      ` -p ${branchPort}:5432` +
      ` postgres:16-alpine`,
      { stdio: "ignore" }
    )
    await this.waitForPostgres(cName)
    this.restoreFromFile(cName, path.join(snapshotDir(snap.id), "dump.sql"))

    // Store branch metadata inside the branch directory
    const branch: Branch = {
      name,
      createdFrom: snap.id,
      createdAt: new Date(),
      connectionString: `postgresql://${this.user}:${this.password}@localhost:${branchPort}/${this.database}`,
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

    // Auto-snapshot main before overwriting
    await this.snapshotCreate(`pre-promote-${name}`, `Auto-snapshot before promoting branch "${name}"`)

    // Dump from branch container into a temp file in the branch dir
    const bDir = branchDir(name)
    const tmpDump = path.join(bDir, "promote.sql")
    this.dumpToFile(`dbtender-branch-${name}`, tmpDump)

    // Restore into main
    this.restoreFromFile(this.containerName, tmpDump)
    fs.unlinkSync(tmpDump)
  }

  async branchDelete(name: string): Promise<void> {
    spawnSync("docker", ["rm", "-f", `dbtender-branch-${name}`], { stdio: "ignore" })
    removeBranch(name)
  }
}
