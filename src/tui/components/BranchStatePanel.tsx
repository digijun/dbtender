import React from "react"
import { Box, Text } from "ink"

export interface BranchStateItem {
  branch: string
  savedAt: Date
  sizeMb: number
  isCurrentGit: boolean
  isCurrentDb: boolean
}

interface Props {
  items: BranchStateItem[]
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

export function BranchStatePanel({ items, selectedIndex, focused, status }: Props) {
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
        <Text bold color={focused ? "cyan" : undefined}>Branch States</Text>
        <Text dimColor> ({items.length})</Text>
      </Box>

      {items.length === 0 && (
        <Text dimColor>No saved states yet.</Text>
      )}

      {items.map((item, i) => {
        const isSelected = focused && i === selectedIndex
        const bg = isSelected ? "cyan" : undefined
        const fg = isSelected ? "black" : undefined

        return (
          <Box key={item.branch} gap={1}>
            {/* Git / DB state indicators */}
            <Text color="green">{item.isCurrentGit ? "▶" : " "}</Text>
            <Text color="cyan">{item.isCurrentDb  ? "●" : " "}</Text>

            <Box flexGrow={1}>
              <Text bold={isSelected} backgroundColor={bg} color={fg}>
                {item.branch.padEnd(28)}
              </Text>
            </Box>

            <Text dimColor>{formatAgo(item.savedAt)}</Text>
            <Text dimColor>{item.sizeMb}MB</Text>
          </Box>
        )
      })}

      {status && (
        <Box marginTop={1}>
          <Text color="yellow">{status}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>▶ current git branch  ● current db state</Text>
      </Box>
    </Box>
  )
}
