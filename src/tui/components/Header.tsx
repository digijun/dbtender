import React from "react"
import { Box, Text } from "ink"
import type { AdapterInfo } from "../../lib/types.js"

interface Props {
  info: AdapterInfo | null
  gitBranch: string | null
  productionBranch: string
  isSynced: boolean
}

export function Header({ info, gitBranch, productionBranch, isSynced }: Props) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">dbtender</Text>
        {info && (
          <Text dimColor>
            {info.type} · postgres {info.version}
          </Text>
        )}
      </Box>
      <Box gap={3}>
        <Box gap={1}>
          <Text dimColor>branch</Text>
          <Text bold color={isSynced ? "green" : "yellow"}>
            {gitBranch ?? "—"}
          </Text>
          {!isSynced && gitBranch && (
            <Text color="yellow">(unsynced — press S to sync)</Text>
          )}
        </Box>
        <Box gap={1}>
          <Text dimColor>production</Text>
          <Text>{productionBranch}</Text>
        </Box>
      </Box>
    </Box>
  )
}
