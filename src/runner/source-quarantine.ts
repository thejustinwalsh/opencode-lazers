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

type GuardState = { current: string; registrations: Map<string, boolean> }
const registryKey = Symbol.for("lazers.runner.source-quarantine.guards.v2")
const shared = globalThis as unknown as Record<symbol, Map<string, GuardState> | undefined>
const guards = (shared[registryKey] ??= new Map())
export const samePhysicalWorkspace = (left: string, right: string) => {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return true
  }
}
type GuardStore = Pick<RunnerStore, "repository">
const key = (store: GuardStore, workspace: string) =>
  JSON.stringify([resolve(store.repository.path), resolve(workspace)])

export type SourceGuardRegistration = {
  registrationID: string
  install(): void
  dispose(): void
}

/** A replacement reserves its identity before hooks install; old scopes cannot bless it. */
export function beginSourceGuard(store: GuardStore, workspace: string): SourceGuardRegistration {
  const identity = key(store, workspace)
  const registrationID = crypto.randomUUID()
  let state = guards.get(identity)
  if (!state) guards.set(identity, (state = { current: registrationID, registrations: new Map() }))
  state.current = registrationID
  state.registrations.set(registrationID, false)
  return {
    registrationID,
    install() {
      if (state.registrations.has(registrationID)) state.registrations.set(registrationID, true)
    },
    dispose() {
      state.registrations.delete(registrationID)
      if (!state.registrations.size && guards.get(identity) === state) guards.delete(identity)
    },
  }
}

/** Useful when a caller already owns the installed hook's lifetime. */
export function registerSourceGuard(store: GuardStore, workspace: string) {
  const registration = beginSourceGuard(store, workspace)
  registration.install()
  return Object.assign(() => registration.dispose(), {
    registrationID: registration.registrationID,
  })
}

export function sourceGuardInstalled(store: GuardStore, workspace: string) {
  const state = guards.get(key(store, workspace))
  return Boolean(
    state?.registrations.get(state.current) && [...state.registrations.values()].every(Boolean),
  )
}

export function sourceGuardMatches(store: GuardStore, workspace: string, registrationID: string) {
  return (
    guards.get(key(store, workspace))?.current === registrationID &&
    sourceGuardInstalled(store, workspace)
  )
}

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
    quarantine.hold_reason !== null ||
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
