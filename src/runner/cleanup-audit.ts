import { isWorkerAgent } from "./worker-agent.ts"
import type { PlanRow, AttemptRow } from "./store.ts"
import type { HostSession } from "./host.ts"
import type { RuntimeCore } from "./runtime-core.ts"

const cleanupObservationStages = [
  "session-read",
  "session-id",
  "project-id",
  "directory",
  "agent",
  "attempt-id",
  "foreground",
  "pending-input",
  "observation-stability",
  "pending-permissions",
  "pending-forms",
  "running-shells",
  "active-children",
] as const
type CleanupObservationStage = (typeof cleanupObservationStages)[number]
type CleanupObservationCheck = {
  stage: CleanupObservationStage
  status: "passed" | "blocked" | "not-evaluated"
  code?: string
}
type CleanupSessionObservation =
  | { kind: "unavailable"; error: unknown }
  | { kind: "absent" }
  | { kind: "observed"; session: HostSession }
type CleanupWorkerClassification = {
  binding: {
    projectID: string
    planID: string
    attemptID: string
    sessionID: string
    workspace: string
    assignedMessageID: string
  }
  firstBlocker: { stage: CleanupObservationStage; code: string } | null
  stages: CleanupObservationCheck[]
}
export type CleanupAuditDiagnostics = {
  diagnosticOnly: true
  planID: string
  planVersion: number
  sampledAt: number
  workspace: string
  workers: Array<
    CleanupWorkerClassification & {
      planVersion: number
      sampledAt: number
    }
  >
}

/**
 * The cleanup audit: reads a worker's session and classifies, stage by stage, whether it is
 * safe to clean up. Diagnostic only. Moved out of `TaskRuntime` without rewriting; the private
 * aliases below keep the member bodies identical to what they were.
 */
export class CleanupAudit {
  constructor(private readonly core: RuntimeCore) {}

  private get store() {
    return this.core.store
  }

  private get host() {
    return this.core.host
  }

  private get projectID() {
    return this.core.projectID
  }

  private get now() {
    return this.core.now
  }

  private async observeCleanupSession(attempt: AttemptRow): Promise<CleanupSessionObservation> {
    try {
      const session = await this.host.session(attempt.session_id, { messages: true })
      return session ? { kind: "observed", session } : { kind: "absent" }
    } catch (error) {
      return { kind: "unavailable", error }
    }
  }

  private classifyCleanupWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    observation: CleanupSessionObservation,
  ): CleanupWorkerClassification {
    const binding = {
      projectID: this.projectID,
      planID: plan.id,
      attemptID: attempt.id,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      assignedMessageID: attempt.message_id,
    }
    const stages: CleanupObservationCheck[] = []
    const fail = (stage: CleanupObservationStage, code: string) => {
      stages.push({ stage, status: "blocked", code })
      const index = cleanupObservationStages.indexOf(stage)
      for (const later of cleanupObservationStages.slice(index + 1))
        stages.push({ stage: later, status: "not-evaluated" })
      return { binding, firstBlocker: { stage, code }, stages }
    }
    const pass = (stage: CleanupObservationStage) => stages.push({ stage, status: "passed" })

    if (observation.kind === "unavailable") return fail("session-read", "read-unavailable")
    if (observation.kind === "absent") {
      // Current cleanup permits authoritative native absence, not a failed read.
      stages.push({ stage: "session-read", status: "passed", code: "session-absent" })
      for (const stage of cleanupObservationStages.slice(1))
        stages.push({ stage, status: "not-evaluated" })
      return { binding, firstBlocker: null, stages }
    }
    pass("session-read")

    const session = observation.session
    if (session.id !== attempt.session_id) return fail("session-id", "session-id-mismatch")
    pass("session-id")
    if (session.projectID !== this.projectID) return fail("project-id", "project-id-mismatch")
    pass("project-id")
    if (session.directory !== attempt.workspace) return fail("directory", "directory-mismatch")
    pass("directory")
    if (!isWorkerAgent(session.agent)) return fail("agent", "agent-mismatch")
    pass("agent")
    if (session.metadata?.lazersAttemptID !== attempt.id)
      return fail("attempt-id", "attempt-id-mismatch")
    pass("attempt-id")
    if (session.busy !== false) return fail("foreground", "foreground-busy")
    pass("foreground")
    if (session.pendingInput === true) return fail("pending-input", "pending-input")
    pass("pending-input")
    if (session.observationUnstable) return fail("observation-stability", "observation-unstable")
    pass("observation-stability")
    if ((session.pendingPermissions ?? 0) !== 0)
      return fail("pending-permissions", "pending-permissions")
    pass("pending-permissions")
    if ((session.pendingForms ?? 0) !== 0) return fail("pending-forms", "pending-forms")
    pass("pending-forms")
    if ((session.runningShells ?? 0) !== 0) return fail("running-shells", "running-shells")
    pass("running-shells")
    if ((session.activeChildren ?? 0) !== 0) return fail("active-children", "active-children")
    pass("active-children")
    return { binding, firstBlocker: null, stages }
  }

  async cleanupAuditDiagnostics(plan: PlanRow): Promise<CleanupAuditDiagnostics | undefined> {
    if (plan.state !== "cleanup-blocked") return undefined
    const effects = this.store.effects(plan.id)
    let workspace: string | undefined
    for (const effect of [...effects].reverse()) {
      if (effect.kind !== "worktree-remove" || !["held", "uncertain"].includes(effect.state))
        continue
      try {
        const payload = JSON.parse(effect.payload) as { workspace?: unknown }
        if (typeof payload.workspace === "string") {
          workspace = payload.workspace
          break
        }
      } catch {
        // Malformed cleanup receipts cannot establish a worker binding.
      }
    }
    if (!workspace) return undefined
    const source = effects.find((effect) => {
      if (!["worktree", "worktree-recovery"].includes(effect.kind) || effect.state !== "completed")
        return false
      try {
        return JSON.parse(effect.receipt ?? "{}").workspace === workspace
      } catch {
        return false
      }
    })
    if (!source) return undefined
    const attempts = this.store
      .attempts(plan.id)
      .filter((attempt) => attempt.workspace === workspace)
    if (!attempts.length) return undefined

    const sampledAt = this.now()
    const workers: CleanupAuditDiagnostics["workers"] = []
    for (const attempt of attempts) {
      const observation = await this.observeCleanupSession(attempt)
      const workerSampledAt = this.now()
      const classification = this.classifyCleanupWorker(plan, attempt, observation)
      workers.push({
        ...classification,
        planVersion: plan.version,
        sampledAt: workerSampledAt,
      })
      // Cleanup stops at the first worker that is not conclusively quiescent.
      if (classification.firstBlocker) break
    }
    return {
      diagnosticOnly: true,
      planID: plan.id,
      planVersion: plan.version,
      sampledAt,
      workspace,
      workers,
    }
  }
}
