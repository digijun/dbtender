/**
 * src/tui/index.tsx
 *
 * Entry point for the dbtender TUI. Instantiates the adapter and renders the App.
 */

import React from "react"
import { render } from "ink"
import { App } from "./App.js"
import { resolveAdapter } from "../adapters/index.js"
import { readConfig } from "../lib/config.js"

export async function startTui(): Promise<void> {
  const config = readConfig()
  if (!config) {
    console.error("No .dbtender/dbtender.json found. Run: dbtender init")
    process.exit(1)
  }

  const adapter = resolveAdapter()

  try {
    await adapter.ping()
  } catch (err) {
    console.error(`Cannot connect to database: ${(err as Error).message}`)
    process.exit(1)
  }

  const productionBranch = config.productionBranch ?? "main"

  const { waitUntilExit } = render(
    <App adapter={adapter} productionBranch={productionBranch} />,
    { exitOnCtrlC: true }
  )

  await waitUntilExit()
}
