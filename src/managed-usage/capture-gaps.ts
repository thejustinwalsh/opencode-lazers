import type { Database } from "bun:sqlite"
import type { ManagedUsageLocation } from "./native-location.ts"

const MANAGED_USAGE_GAP_KINDS = new Set([
  "listener-started",
  "stream-failed",
  "stream-ended",
  "listener-stopped",
  "authority-changed",
  "observation-failed",
  "unidentified-event",
  "unsequenced-event",
  "buffer-overflow",
])

type ManagedUsageGapInput = {
  listenerID: string
  sessionID: string
  kind: string
  nativeLocation?: ManagedUsageLocation | null
  recordedAt?: number
}

type ManagedUsageCoverageInput = Omit<ManagedUsageGapInput, "sessionID"> & {
  scope: { kind: "project" } | { kind: "location"; nativeLocation: ManagedUsageLocation }
}

function assertGapKind(kind: string) {
  if (!MANAGED_USAGE_GAP_KINDS.has(kind)) throw new Error("Invalid managed usage gap kind")
}

function insertGap(
  db: Database,
  projectDirectory: string,
  input: ManagedUsageGapInput,
  nativeLocation: ManagedUsageLocation | null,
) {
  db.query(
    `INSERT OR IGNORE INTO managed_usage_capture_gaps(
      project_directory,listener_id,session_id,kind,native_directory,workspace_id,recorded_at
    ) VALUES(?,?,?,?,?,?,?)`,
  ).run(
    projectDirectory,
    input.listenerID,
    input.sessionID,
    input.kind,
    nativeLocation?.directory ?? null,
    nativeLocation?.workspaceID ?? null,
    input.recordedAt ?? Date.now(),
  )
  return (db.query("SELECT changes() AS count").get() as { count: number }).count
}

function sessionsInScope(
  db: Database,
  projectDirectory: string,
  scope: ManagedUsageCoverageInput["scope"],
) {
  if (scope.kind === "project")
    return db
      .query<{ session_id: string }, [string]>(
        `SELECT DISTINCT session_id FROM managed_usage_boundaries
         WHERE project_directory=? ORDER BY session_id LIMIT 100_000`,
      )
      .all(projectDirectory)
  return db
    .query<{ session_id: string }, [string, string, string | null]>(
      `SELECT DISTINCT session_id FROM managed_usage_boundaries
       WHERE project_directory=? AND native_directory=? AND workspace_id IS ?
       ORDER BY session_id LIMIT 100_000`,
    )
    .all(projectDirectory, scope.nativeLocation.directory, scope.nativeLocation.workspaceID)
}

export function insertManagedUsageGap(
  db: Database,
  projectDirectory: string,
  input: ManagedUsageGapInput,
) {
  assertGapKind(input.kind)
  return insertGap(db, projectDirectory, input, input.nativeLocation ?? null) > 0
}

export function insertManagedUsageCoverageGaps(
  db: Database,
  projectDirectory: string,
  input: ManagedUsageCoverageInput,
) {
  assertGapKind(input.kind)
  const nativeLocation = input.scope.kind === "location" ? input.scope.nativeLocation : null
  let changedCount = 0
  for (const { session_id: sessionID } of sessionsInScope(db, projectDirectory, input.scope))
    changedCount += insertGap(db, projectDirectory, { ...input, sessionID }, nativeLocation)
  return changedCount
}
