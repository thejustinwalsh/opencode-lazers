import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import type { AttemptRow, RunnerStore } from "./store.ts"

export type SourceQuarantine = {
  attempt_id: string
  plan_id: string
  session_id: string
  assigned_message_id: string
  requested_owner: string
  workspace: string
  request_id: string
  reason: string
  phase: "pending" | "sealed"
  hold_reason: string | null
  created_at: number
  updated_at: number
}

const registryKey = Symbol.for("lazers.runner.source-quarantine.guards.v1")
const shared = globalThis as unknown as Record<symbol, Map<string, Set<symbol>> | undefined>
const guards = (shared[registryKey] ??= new Map())
const samePhysicalWorkspace = (left: string, right: string) => {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return true
  }
}
const key = (store: RunnerStore, workspace: string) =>
  JSON.stringify([resolve(store.repository.path), resolve(workspace)])

/** Advertise only after the native before-tool hook is installed; dispose with its scope. */
export function registerSourceGuard(store: RunnerStore, workspace: string) {
  const identity = key(store, workspace)
  const token = Symbol(identity)
  let registrations = guards.get(identity)
  if (!registrations) guards.set(identity, (registrations = new Set()))
  registrations.add(token)
  return () => {
    registrations.delete(token)
    if (!registrations.size && guards.get(identity) === registrations) guards.delete(identity)
  }
}

export const sourceGuardInstalled = (store: RunnerStore, workspace: string) =>
  Boolean(guards.get(key(store, workspace))?.size)

export function sourceQuarantine(store: RunnerStore, attemptID: string) {
  return store.atomic((db) =>
    db
      .query<SourceQuarantine, [string]>(
        "SELECT * FROM runner_source_quarantines WHERE attempt_id=?",
      )
      .get(attemptID),
  )
}

export function quarantinedSession(store: RunnerStore, sessionID: string) {
  return store.atomic((db) =>
    db
      .query<SourceQuarantine, [string]>(
        "SELECT * FROM runner_source_quarantines WHERE session_id=?",
      )
      .get(sessionID),
  )
}

/** This releases no checkout, check, service or cleanup resource. */
export function sourceReservationExcluded(
  store: RunnerStore,
  attempt: AttemptRow,
  destination: { mode: "shared" | "isolated"; workspace?: string },
) {
  if (destination.mode !== "isolated" || attempt.state !== "verifying") return false
  const quarantine = sourceQuarantine(store, attempt.id)
  if (
    !quarantine ||
    quarantine.phase !== "sealed" ||
    quarantine.plan_id !== attempt.plan_id ||
    quarantine.session_id !== attempt.session_id ||
    quarantine.assigned_message_id !== attempt.message_id ||
    resolve(quarantine.workspace) !== resolve(attempt.workspace) ||
    !sourceGuardInstalled(store, quarantine.workspace)
  )
    return false
  return (
    !destination.workspace || !samePhysicalWorkspace(destination.workspace, quarantine.workspace)
  )
}

const quarantineReads = new Set([
  "read",
  "grep",
  "glob",
  "skill",
  "lz-get-task",
  "lz-get-task-instructions",
  "lz-query-tasks",
  "lz-inspect-trajectory",
  "lz-report-progress",
  "lz-verify-handoff",
  "lz-submit-handoff",
])

export function sourceQuarantineToolError(store: RunnerStore, sessionID: string, tool: string) {
  if (quarantineReads.has(tool) || !quarantinedSession(store, sessionID)) return undefined
  return "This retained worker's source workspace is quarantined. Read or submit its handoff; source repair requires an active runtime assignment in an independent workspace."
}
