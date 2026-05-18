import React, { useState, useEffect, useCallback } from "react"
import { Box, useInput, useApp } from "ink"
import fs from "node:fs"
import path from "node:path"
import { Header } from "./components/Header.js"
import { Footer } from "./components/Footer.js"
import { BranchStatePanel, type BranchStateItem } from "./components/BranchStatePanel.js"
import { SnapshotPanel } from "./components/SnapshotPanel.js"
import type { IAdapter, AdapterInfo, Snapshot } from "../lib/types.js"
import { listBranchStates, branchStateDumpPath } from "../lib/store.js"
import { currentGitBranch, readTrackedBranch, writeTrackedBranch } from "../lib/git.js"
import { runSwitch } from "../commands/switch.js"

type Panel = "branches" | "snapshots"
type ConfirmAction = { type: "switch"; branch: string } | { type: "restore"; snap: Snapshot } | { type: "deleteSnap"; snap: Snapshot } | { type: "deleteBranch"; branch: string }

interface Props {
  adapter: IAdapter
  productionBranch: string
}

export function App({ adapter, productionBranch }: Props) {
  const { exit } = useApp()

  // ── Data state ──────────────────────────────────────────────────────────────
  const [info,           setInfo]           = useState<AdapterInfo | null>(null)
  const [branchStates,   setBranchStates]   = useState<BranchStateItem[]>([])
  const [snapshots,      setSnapshots]      = useState<Snapshot[]>([])
  const [gitBranch,      setGitBranch]      = useState<string | null>(null)
  const [trackedBranch,  setTrackedBranch]  = useState<string | null>(null)

  // ── UI state ────────────────────────────────────────────────────────────────
  const [panel,          setPanel]          = useState<Panel>("branches")
  const [branchIdx,      setBranchIdx]      = useState(0)
  const [snapIdx,        setSnapIdx]        = useState(0)
  const [status,         setStatus]         = useState<{ panel: Panel; msg: string } | null>(null)
  const [confirm,        setConfirm]        = useState<ConfirmAction | null>(null)
  const [loading,        setLoading]        = useState(false)

  // ── Load data ───────────────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    const gb = currentGitBranch()
    const tb = readTrackedBranch()
    setGitBranch(gb)
    setTrackedBranch(tb)

    const rawStates = listBranchStates()
    setBranchStates(rawStates.map(s => ({
      ...s,
      isCurrentGit: s.branch === gb,
      isCurrentDb:  s.branch === (tb ?? gb),
    })))

    const snaps = await adapter.snapshotList()
    setSnapshots(snaps)
  }, [adapter])

  useEffect(() => {
    adapter.info().then(setInfo).catch(() => {})
    refresh()
  }, [adapter, refresh])

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const setMsg = (p: Panel, msg: string) => {
    setStatus({ panel: p, msg })
    setTimeout(() => setStatus(null), 3000)
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  const doSwitch = async (targetBranch: string) => {
    setLoading(true)
    setMsg("branches", `Switching to "${targetBranch}"…`)
    try {
      await runSwitch(targetBranch, { quiet: true })
      await refresh()
      setMsg("branches", `Switched to "${targetBranch}"`)
    } catch (err) {
      setMsg("branches", `Error: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const doRestore = async (snap: Snapshot) => {
    setLoading(true)
    setMsg("snapshots", `Restoring "${snap.name}"…`)
    try {
      await adapter.snapshotRestore(snap.id)
      await refresh()
      setMsg("snapshots", `Restored "${snap.name}"`)
    } catch (err) {
      setMsg("snapshots", `Error: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const doSaveSnapshot = async () => {
    setLoading(true)
    setMsg("snapshots", "Saving snapshot…")
    try {
      const snap = await adapter.snapshotCreate("")
      await refresh()
      setMsg("snapshots", `Saved: ${snap.name}`)
    } catch (err) {
      setMsg("snapshots", `Error: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const doDeleteSnapshot = async (snap: Snapshot) => {
    setLoading(true)
    try {
      await adapter.snapshotDelete(snap.id)
      setSnapIdx(i => Math.max(0, i - 1))
      await refresh()
      setMsg("snapshots", `Deleted "${snap.name}"`)
    } catch (err) {
      setMsg("snapshots", `Error: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const doDeleteBranchState = async (branch: string) => {
    const dumpPath = branchStateDumpPath(branch)
    const dir = path.dirname(dumpPath)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    setBranchIdx(i => Math.max(0, i - 1))
    await refresh()
    setMsg("branches", `Deleted state for "${branch}"`)
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────

  useInput((input, key) => {
    if (loading) return

    // Confirm mode
    if (confirm) {
      if (input === "y") {
        const action = confirm
        setConfirm(null)
        if (action.type === "switch")       doSwitch(action.branch)
        if (action.type === "restore")      doRestore(action.snap)
        if (action.type === "deleteSnap")   doDeleteSnapshot(action.snap)
        if (action.type === "deleteBranch") doDeleteBranchState(action.branch)
      } else {
        setConfirm(null)
      }
      return
    }

    if (input === "q") { exit(); return }
    if (key.tab)       { setPanel(p => p === "branches" ? "snapshots" : "branches"); return }

    if (panel === "branches") {
      const max = branchStates.length - 1
      if (key.upArrow)   setBranchIdx(i => Math.max(0, i - 1))
      if (key.downArrow) setBranchIdx(i => Math.min(max, i + 1))
      if (key.return && branchStates[branchIdx]) {
        const b = branchStates[branchIdx]
        if (b.isCurrentDb) { setMsg("branches", "Already on this branch."); return }
        setConfirm({ type: "switch", branch: b.branch })
      }
      if (input === "d" && branchStates[branchIdx]) {
        setConfirm({ type: "deleteBranch", branch: branchStates[branchIdx].branch })
      }
    }

    if (panel === "snapshots") {
      const max = snapshots.length - 1
      if (key.upArrow)   setSnapIdx(i => Math.max(0, i - 1))
      if (key.downArrow) setSnapIdx(i => Math.min(max, i + 1))
      if (key.return && snapshots[snapIdx]) {
        setConfirm({ type: "restore", snap: snapshots[snapIdx] })
      }
      if (input === "s") doSaveSnapshot()
      if (input === "d" && snapshots[snapIdx]) {
        setConfirm({ type: "deleteSnap", snap: snapshots[snapIdx] })
      }
    }
  })

  // ── Confirm label ─────────────────────────────────────────────────────────

  const confirmLabel = confirm
    ? confirm.type === "switch"       ? `Switch DB to branch "${confirm.branch}"?`
    : confirm.type === "restore"      ? `Restore snapshot "${confirm.snap.name}"?`
    : confirm.type === "deleteSnap"   ? `Delete snapshot "${confirm.snap.name}"?`
    : confirm.type === "deleteBranch" ? `Delete saved state for "${confirm.branch}"?`
    : ""
    : ""

  const isSynced = !gitBranch || gitBranch === (trackedBranch ?? gitBranch)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 24}>
      <Header
        info={info}
        gitBranch={gitBranch}
        productionBranch={productionBranch}
        isSynced={isSynced}
      />

      <Box flexGrow={1} gap={1}>
        <BranchStatePanel
          items={branchStates}
          selectedIndex={branchIdx}
          focused={panel === "branches"}
          status={status?.panel === "branches" ? status.msg : null}
        />
        <SnapshotPanel
          items={snapshots}
          selectedIndex={snapIdx}
          focused={panel === "snapshots"}
          status={status?.panel === "snapshots" ? status.msg : null}
        />
      </Box>

      <Footer
        panel={panel}
        confirmMode={confirm !== null}
        confirmLabel={confirmLabel}
      />
    </Box>
  )
}
