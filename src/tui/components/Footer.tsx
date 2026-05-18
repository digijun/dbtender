import React from "react"
import { Box, Text } from "ink"

interface KeyHint {
  key: string
  label: string
}

interface Props {
  panel: "branches" | "snapshots"
  confirmMode: boolean
  confirmLabel?: string
}

const BRANCH_KEYS: KeyHint[] = [
  { key: "↑↓",    label: "navigate" },
  { key: "enter",  label: "switch to" },
  { key: "d",      label: "delete state" },
  { key: "tab",    label: "→ snapshots" },
  { key: "q",      label: "quit" },
]

const SNAPSHOT_KEYS: KeyHint[] = [
  { key: "↑↓",    label: "navigate" },
  { key: "enter",  label: "restore" },
  { key: "s",      label: "save now" },
  { key: "d",      label: "delete" },
  { key: "tab",    label: "→ branches" },
  { key: "q",      label: "quit" },
]

export function Footer({ panel, confirmMode, confirmLabel }: Props) {
  if (confirmMode) {
    return (
      <Box borderStyle="single" borderColor="yellow" paddingX={1}>
        <Text color="yellow" bold>{confirmLabel} </Text>
        <Text dimColor>  </Text>
        <KeyHintItem k="y" label="confirm" />
        <Text dimColor>  </Text>
        <KeyHintItem k="n / esc" label="cancel" />
      </Box>
    )
  }

  const hints = panel === "branches" ? BRANCH_KEYS : SNAPSHOT_KEYS
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} gap={2}>
      {hints.map(h => <KeyHintItem key={h.key} k={h.key} label={h.label} />)}
    </Box>
  )
}

function KeyHintItem({ k, label }: { k: string; label: string }) {
  return (
    <Box gap={1}>
      <Text bold inverse> {k} </Text>
      <Text dimColor>{label}</Text>
    </Box>
  )
}
