/**
 * src/adapters/index.ts
 *
 * resolveAdapter() — reads .dbtender/dbtender.json and returns the right adapter.
 * Commands call this; they never construct adapters directly.
 */

import type { IAdapter } from "../lib/types.js"
import { readConfig } from "../lib/config.js"
import { DockerAdapter } from "./docker.js"
import { PGliteAdapter } from "./pglite.js"
import { LocalAdapter } from "./local.js"

export function resolveAdapter(): IAdapter {
  const config = readConfig()

  if (!config) {
    throw new Error(
      "No .dbtender/dbtender.json found in this project.\n" +
      "  Run: dbtender init"
    )
  }

  switch (config.adapter.adapter) {
    case "docker":
      return new DockerAdapter({
        containerName: config.adapter.containerName,
        port: config.adapter.port,
        user: config.adapter.user,
        password: config.adapter.password,
        database: config.adapter.database,
      })

    case "pglite":
      return new PGliteAdapter({ dataDir: config.adapter.pgliteDir })

    case "local":
      return new LocalAdapter({
        host: config.adapter.host,
        port: config.adapter.port,
        user: config.adapter.user,
        password: config.adapter.password,
        database: config.adapter.database,
      })

    default: {
      const a = config.adapter as { adapter: string }
      throw new Error(`Unknown adapter type: "${a.adapter}"`)
    }
  }
}
