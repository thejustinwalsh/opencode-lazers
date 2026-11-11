import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { z } from "zod"
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
  review_input_json?: string | null
}

export const SourceReviewBinding = z.strictObject({
  inputID: z.string().min(1).max(200),
  requestID: z.string().min(1).max(200),
})
export type SourceReviewBinding = z.infer<typeof SourceReviewBinding>

export const SourceQuarantineVerificationBindingSchema = z.strictObject({
  requestID: z.string().min(1).max(200),
  reviewInput: SourceReviewBinding.nullable(),
})
export type SourceQuarantineVerificationBinding = z.infer<
  typeof SourceQuarantineVerificationBindingSchema
>

export function sourceReviewBinding(row: Pick<SourceQuarantine, "review_input_json">) {
  return row.review_input_json == null
    ? undefined
    : SourceReviewBinding.parse(JSON.parse(row.review_input_json))
}

type GuardEntry = { installed: boolean; databasePath?: string; projectDirectory: string }
type GuardState = { current: string; registrations: Map<string, GuardEntry> }
const registryKey = Symbol.for("lazers.runner.source-quarantine.guards.v3")
const shared = globalThis as unknown as Record<symbol, Map<string, GuardState> | undefined>
const guards = (shared[registryKey] ??= new Map())
function physicalWorkspace(path: string): string {
  let ancestor = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync(ancestor), ...missing)
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT") ||
        lstatSync(ancestor, { throwIfNoEntry: false }) !== undefined
      )
        throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

export const samePhysicalWorkspace = (left: string, right: string) => {
  try {
    return physicalWorkspace(left) === physicalWorkspace(right)
  } catch {
    return true
  }
}
type GuardStore = Pick<RunnerStore, "repository">
const key = (workspace: string) => resolve(workspace)

export type SourceGuardRegistration = {
  registrationID: string
  install(store: GuardStore): void
  dispose(): void
}

/** A replacement reserves its identity before hooks install; old scopes cannot bless it. */
export function beginSourceGuard(location: {
  directory: string
  projectDirectory: string
}): SourceGuardRegistration {
  const identity = key(location.directory)
  const registrationID = crypto.randomUUID()
  let state = guards.get(identity)
  if (!state) guards.set(identity, (state = { current: registrationID, registrations: new Map() }))
  state.current = registrationID
  const entry: GuardEntry = {
    installed: false,
    projectDirectory: resolve(location.projectDirectory),
  }
  state.registrations.set(registrationID, entry)
  return {
    registrationID,
    install(store) {
      if (entry.projectDirectory !== resolve(store.repository.projectDirectory))
        throw new Error("Source guard project binding changed")
      if (state.registrations.has(registrationID)) {
        entry.databasePath = resolve(store.repository.path)
        entry.installed = true
      }
    },
    dispose() {
      state.registrations.delete(registrationID)
      if (state.current === registrationID) {
        const remaining = [...state.registrations]
        state.current =
          remaining.findLast(([, value]) => value.installed)?.[0] ??
          remaining.at(-1)?.[0] ??
          registrationID
      }
      if (!state.registrations.size && guards.get(identity) === state) guards.delete(identity)
    },
  }
}

/** Useful when a caller already owns the installed hook's lifetime. */
export function registerSourceGuard(store: GuardStore, workspace: string) {
  const registration = beginSourceGuard({
    directory: workspace,
    projectDirectory: store.repository.projectDirectory,
  })
  registration.install(store)
  return Object.assign(() => registration.dispose(), {
    registrationID: registration.registrationID,
  })
}

export function sourceGuardInstalled(store: GuardStore, workspace: string) {
  const state = guards.get(key(workspace))
  const entry = state?.registrations.get(state.current)
  return Boolean(
    entry?.installed &&
    entry.databasePath === resolve(store.repository.path) &&
    entry.projectDirectory === resolve(store.repository.projectDirectory) &&
    [...state!.registrations.values()].every((value) => value.installed),
  )
}

export function sourceGuardMatches(store: GuardStore, workspace: string, registrationID: string) {
  return (
    guards.get(key(workspace))?.current === registrationID && sourceGuardInstalled(store, workspace)
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
  if (destination.mode !== "isolated" || !["running", "verifying"].includes(attempt.state))
    return false
  const quarantine = sourceQuarantine(store, attempt.id)
  if (quarantine) {
    try {
      sourceReviewBinding(quarantine)
    } catch {
      return false
    }
  }
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

/** Bind retained checks to the exact sealed source quarantine and installed guard. */
export function sourceQuarantineVerificationBinding(
  store: RunnerStore,
  input: {
    planID: string
    owner: string
    attempt: Pick<
      AttemptRow,
      "id" | "plan_id" | "state" | "artifact" | "session_id" | "message_id" | "workspace"
    >
    artifact: string
  },
): SourceQuarantineVerificationBinding | undefined {
  const { attempt } = input
  const quarantine = sourceQuarantine(store, attempt.id)
  if (
    !quarantine ||
    attempt.plan_id !== input.planID ||
    attempt.state !== "verifying" ||
    attempt.artifact !== input.artifact ||
    quarantine.plan_id !== input.planID ||
    quarantine.requested_owner !== input.owner ||
    quarantine.session_id !== attempt.session_id ||
    quarantine.assigned_message_id !== attempt.message_id ||
    quarantine.workspace !== attempt.workspace ||
    quarantine.phase !== "sealed" ||
    quarantine.hold_reason !== null ||
    !sourceGuardInstalled(store, quarantine.workspace)
  )
    return undefined

  try {
    return SourceQuarantineVerificationBindingSchema.parse({
      requestID: quarantine.request_id,
      reviewInput: sourceReviewBinding(quarantine) ?? null,
    })
  } catch {
    return undefined
  }
}

export function sourceQuarantineVerificationBindingMatches(
  store: RunnerStore,
  input: Parameters<typeof sourceQuarantineVerificationBinding>[1] & {
    expected: SourceQuarantineVerificationBinding
  },
): boolean {
  const current = sourceQuarantineVerificationBinding(store, input)
  return Boolean(
    current &&
    current.requestID === input.expected.requestID &&
    JSON.stringify(current.reviewInput) === JSON.stringify(input.expected.reviewInput),
  )
}

const quarantineReads = new Set([
  // Native Code Mode re-enters tool hooks for each nested call; retain the inner guards.
  "execute",
  "read",
  "grep",
  "glob",
  "skill",
  "lz-get-task",
  "lz-query-tasks",
  "lz-inspect-trajectory",
  "lz-query-audits",
  "lz-get-audit",
  "lz-report-progress",
  "lz-verify-handoff",
  "lz-submit-handoff",
])

export function sourceQuarantineToolError(store: RunnerStore, sessionID: string, tool: string) {
  if (quarantineReads.has(tool) || !quarantinedSession(store, sessionID)) return undefined
  return "This retained worker's source workspace is quarantined. Read or submit its handoff; source repair requires an active runtime assignment in an independent workspace."
}
