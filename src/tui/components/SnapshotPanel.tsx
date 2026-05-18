import React from "react"
import { Box, Text } from "ink"
import type { Snapshot } from "../../lib/types.js"

interface Props {
  items: Snapshot[]
  selectedIndex: number
  focused: boolean
  status: string | null
}

function formatAgo(date: Date): string {
  const diff = Date.now() - date.getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(mins / 60)
  const days  = Math.floor(hours / 24)
  if (days > 0)  return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (mins > 0)  return `${mins}m ago`
  return "just now"
}

export function SnapshotPanel({ items, selectedIndex, focused, status }: Props) {
  const borderColor = focused ? "cyan" : "gray"

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
      flexGrow={1}
    >
      <Box marginBottom={1}>
        <Text bold color={focused ? "cyan" : undefined}>Snapshots</Text>
        <Text dimColor> ({items.length})</Text>
      </Box>

      {items.length === 0 && (
        <Text dimColor>No snapshots yet. Press s to save one.</Text>
      )}

      {items.map((snap, i) => {
        const isSelected = focused && i === selectedIndex
        const bg = isSelected ? "cyan" : undefined
        const fg = isSelected ? "black" : undefined
        const isAuto = snap.name.startsWith("pre-restore-") ||
                       snap.name.startsWith("pre-promote-") ||
                       snap.name.startsWith("branch-source-") ||
                       snap.name.startsWith("snapshot-")

        return (
          <Box key={snap.id} gap={1}>
            <Box flexGrow={1}>
              <Text
                bold={isSelected && !isAuto}
                dimColor={isAuto}
                backgroundColor={bg}
                color={isAuto ? undefined : fg}
              >
                {snap.name.padEnd(30)}
              </Text>
            </Box>
            <Text dimColor>{formatAgo(snap.createdAt)}</Text>
            <Text dimColor>{snap.sizeMb}MB</Text>
          </Box>
        )
      })}

      {status && (
        <Box marginTop={1}>
          <Text color="yellow">{status}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>dimmed = auto-generated snapshots</Text>
      </Box>
    </Box>
  )
}
