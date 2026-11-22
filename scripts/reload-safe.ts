import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  reloadObservationDependencies,
  type ReloadObservationDependencies,
} from "../src/runner/reload-observation.ts"
import { reloadSafety, type ReloadObservations } from "../src/runner/reload-safety.ts"

export type ReloadSafeCommandResult = {
  stdout: string
  exitCode: 0 | 1
}

function unavailableResult(reason: string): ReloadSafeCommandResult {
  const detail = reason.replace(/\s+/g, " ").slice(0, 300)
  return {
    stdout: `0 workers running, 0 verifications running, 0 Architect turns in flight, live activity observation unavailable: ${detail}, safe to reload: no\n`,
    exitCode: 1,
  }
}

/**
 * `bun scripts/reload-safe.ts [tasks.sqlite] [opencode.db]`: read-only; exits 0 when a reload is
 * safe, 1 when not. Host session activity and verification processes are observed live, rather
 * than inferred from stored running/intended labels.
 */
export async function runReloadSafe(
  args: readonly string[] = process.argv.slice(2),
  dependencies: ReloadObservationDependencies = reloadObservationDependencies,
): Promise<ReloadSafeCommandResult> {
  const data = join(homedir(), ".local/share/opencode")
  const path = args[0] ?? join(data, "plugins/lazers/tasks.sqlite")
  const opencodePath = args[1] ?? join(data, "opencode.db")
  let db: Database | undefined
  let opencode: Database | undefined
  try {
    db = new Database(path, { readonly: true })
    opencode = existsSync(opencodePath) ? new Database(opencodePath, { readonly: true }) : undefined
    const [sessions, verifications] = await Promise.all([
      dependencies.observeSessions().catch((error: unknown) => ({
        kind: "unavailable" as const,
        reason: error instanceof Error ? error.message : String(error),
      })),
      dependencies.observeVerifications(db).catch((error: unknown) => ({
        kind: "unavailable" as const,
        reason: error instanceof Error ? error.message : String(error),
      })),
    ])
    const observations: ReloadObservations = { sessions, verifications }
    const result = reloadSafety(db, opencode, Date.now(), observations)
    return {
      stdout:
        [
          result.line,
          ...(result.uncertainLine ? [result.uncertainLine] : []),
          ...(result.staleLine ? [result.staleLine] : []),
          ...(result.staleVerificationLine ? [result.staleVerificationLine] : []),
        ].join("\n") + "\n",
      exitCode: result.safe ? 0 : 1,
    }
  } catch (error) {
    return unavailableResult(error instanceof Error ? error.message : String(error))
  } finally {
    db?.close()
    opencode?.close()
  }
}

if (import.meta.main) {
  const result = await runReloadSafe()
  process.stdout.write(result.stdout)
  process.exitCode = result.exitCode
}
