/**
 * src/lib/types.ts
 *
 * All shared interfaces and types for dbtender.
 * Adapters, commands, and utilities import from here — never from each other.
 */

// ── Domain types ──────────────────────────────────────────────────────────────

export interface Snapshot {
  id: string          // "20260415-143201"
  name: string        // "before-user-auth-migration"
  createdAt: Date
  sizeMb: number
  notes?: string
}

export interface Branch {
  name: string
  createdFrom: string   // snapshot id this branch was made from
  createdAt: Date
  connectionString: string
}

export interface AdapterInfo {
  type: "docker" | "pglite" | "local"
  version: string
  connectionString: string
  dataPath?: string
}

// ── Adapter contract ──────────────────────────────────────────────────────────

export interface IAdapter {
  /** Verify connectivity. Throws a descriptive error if not ready. */
  ping(): Promise<void>

  /** Return metadata about this connection. */
  info(): Promise<AdapterInfo>

  // ── Snapshots ───────────────────────────────────────────────────────────────

  /** Dump current database state to a named snapshot. */
  snapshotCreate(name: string, notes?: string): Promise<Snapshot>

  /** List all snapshots, newest first. */
  snapshotList(): Promise<Snapshot[]>

  /**
   * Restore the database from a snapshot.
   * Auto-saves current state as "pre-restore-<id>" unless skipAutoSnapshot is true.
   */
  snapshotRestore(idOrName: string, opts?: { skipAutoSnapshot?: boolean }): Promise<void>

  /** Delete a snapshot and free its disk space. */
  snapshotDelete(idOrName: string): Promise<void>

  // ── Raw dump / restore (used by git integration) ────────────────────────────

  /** Dump the current database and return the SQL content as a string. */
  dumpRaw(): Promise<string>

  /** Restore the database from a raw SQL dump string. */
  restoreRaw(sql: string): Promise<void>

  // ── Branches ────────────────────────────────────────────────────────────────

  /**
   * Create an isolated branch from a snapshot (or current state).
   * Returns the branch with a ready-to-use connection string.
   */
  branchCreate(name: string, fromSnapshot?: string): Promise<Branch>

  /** List all active branches. */
  branchList(): Promise<Branch[]>

  /**
   * Promote a branch's current state back into the main environment.
   * Auto-saves current main state before overwriting.
   */
  branchPromote(name: string): Promise<void>

  /** Delete a branch and free its resources. */
  branchDelete(name: string): Promise<void>
}
