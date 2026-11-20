import type { HostSession } from "../host.ts"
import type { TaskRuntime } from "../runtime.ts"
import type { AttemptRow, EffectRow, PlanRow } from "../store.ts"
import { isWorkerAgent } from "../worker-agent.ts"
import { cleanupWorkerOwnershipBlockers } from "./canonical-ownership.ts"

type WorkerCleanupRuntime = Pick<
  TaskRuntime,
  "backgroundBlockReason" | "directory" | "host" | "projectID" | "store"
>

function workerSessionBlockers(session: HostSession) {
  const blockers: string[] = []
  if (!isWorkerAgent(session.agent)) blockers.push("session is no longer an implementor")
  if (session.busy !== false) blockers.push("worker session is busy")
  if (session.pendingInput === true) blockers.push("worker has pending input")
  if (session.observationUnstable) blockers.push("native worker observation is unstable")
  return blockers
}

function workerPendingInteractionBlockers(session: HostSession) {
  const blockers: string[] = []
  if ((session.pendingPermissions ?? 0) !== 0)
    blockers.push("worker has pending permission requests")
  if ((session.pendingForms ?? 0) !== 0) blockers.push("worker has pending forms")
  return blockers
}

function workerActivityBlockers(runtime: WorkerCleanupRuntime, session: HostSession) {
  const blockers = [...workerSessionBlockers(session), ...workerPendingInteractionBlockers(session)]
  const background = runtime.backgroundBlockReason(session)
  if (background) blockers.push(background)
  return blockers
}

function shouldRetireIntegratedWorker(input: {
  runtime: WorkerCleanupRuntime
  attempt: AttemptRow
  mergedCheckout: boolean
  allowCancelled: boolean
  blockers: string[]
}) {
  return (
    !input.blockers.length &&
    input.mergedCheckout &&
    !input.allowCancelled &&
    input.attempt.state === "accepted" &&
    Boolean(input.runtime.host.retireIntegratedWorker)
  )
}

/** Keep background activity and integrated-worker archival tied to the exact idle proof. */
export async function cleanupWorkerActivityBlockers(input: {
  runtime: WorkerCleanupRuntime
  attempt: AttemptRow
  session: HostSession
  workspace: string
  ownershipBlockers: string[]
  mergedCheckout: boolean
  allowCancelled: boolean
}) {
  const blockers = [
    ...input.ownershipBlockers,
    ...workerActivityBlockers(input.runtime, input.session),
  ]
  if (shouldRetireIntegratedWorker({ ...input, blockers }))
    await input.runtime.host.retireIntegratedWorker!({
      projectID: input.runtime.projectID,
      attemptID: input.attempt.id,
      sessionID: input.attempt.session_id,
      workspace: input.workspace,
    })
  return blockers
}

/** Gather durable and native evidence for this exact worker attempt. */
export async function cleanupAttemptWorkerOwnership(input: {
  runtime: Pick<TaskRuntime, "store" | "projectID" | "directory" | "host">
  plan: PlanRow
  effect: EffectRow
  attempt: AttemptRow
  session: HostSession
  workspace: string
}) {
  const { runtime, plan, effect, attempt, session, workspace } = input
  const attemptProjectDirectory = runtime.store.repository.read(
    (db) =>
      db
        .query<{ project_directory: string | null }, [string, string]>(
          "SELECT project_directory FROM runner_attempts WHERE id=? AND plan_id=?",
        )
        .get(attempt.id, plan.id)?.project_directory,
  )
  const host = runtime.host as TaskRuntime["host"] & {
    nativeProjectCanonicalDirectory?: (projectID: string) => Promise<string | undefined>
  }
  const ownership = {
    expectedProjectID: runtime.projectID,
    observedProjectID: session.projectID,
    expectedProjectDirectory: runtime.directory,
    observedProjectDirectory:
      session.projectID === runtime.projectID ? runtime.directory : undefined,
    attemptProjectDirectory: attemptProjectDirectory ?? undefined,
    expectedSessionID: attempt.session_id,
    observedSessionID: session.id,
    expectedAttemptID: attempt.id,
    effectAttemptID: effect.attempt_id,
    observedAttemptID: session.metadata?.lazersAttemptID,
    expectedWorkspace: workspace,
    attemptWorkspace: attempt.workspace,
    observedWorkspace: session.directory,
    nativeProjectCanonicalDirectory: (projectID: string) =>
      host.nativeProjectCanonicalDirectory?.(projectID) ?? Promise.resolve(undefined),
  }
  const blockers = await cleanupWorkerOwnershipBlockers(ownership)
  if (blockers.length || session.projectID === runtime.projectID) return { blockers, session }

  // Project lookup is a separate native read. Re-read the worker afterward so
  // activity or ownership changes during that lookup cannot pass final cleanup.
  const current = await runtime.host.session(attempt.session_id, { messages: true })
  if (!current) return { blockers: [], session: null }
  if (
    current.id !== session.id ||
    current.projectID !== session.projectID ||
    current.directory !== session.directory ||
    current.metadata?.lazersAttemptID !== session.metadata?.lazersAttemptID
  )
    blockers.push("worker ownership changed during canonical project verification")
  return { blockers, session: current }
}
