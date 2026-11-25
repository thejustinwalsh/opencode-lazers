import type { HostSession } from "./host.ts"
import { ModelPolicy } from "./schema.ts"
import type { AttemptRow } from "./store.ts"
import { isWorkerAgent } from "./worker-agent.ts"

export type AttemptSettlementObservation = {
  schema: "lazers-attempt-settlement-observation/v1"
  kind: "completed-idle-assignment-without-outcome"
  attemptID: string
  sessionID: string
  projectID: string
  workspace: string
  inputID: string
  turnState: "completed"
  outcome: null
  idleAt: number
  busy: false
  pendingInput: false
  pendingPermissions: 0
  pendingForms: 0
  observationUnstable: false
  runningShells: number
  activeChildren: number
}

/**
 * A blocked attempt may be settled when the native turn is demonstrably complete but
 * OpenCode supplied no session outcome. This is not a substitute for an explicit
 * success, failure, interruption, or unresolved native wait.
 */
export function completedIdleAttemptSettlementObservation(input: {
  attempt: AttemptRow
  session: HostSession
  projectID: string
  matchesWorkerInput: (inputID: string) => boolean
  sameModel: (left: ModelPolicy | undefined, right: ModelPolicy | undefined) => boolean
}): AttemptSettlementObservation | undefined {
  const { attempt, session, projectID } = input
  const idleAt = session.idleAt
  const runningShells = session.runningShells ?? 0
  const activeChildren = session.activeChildren ?? 0
  const inputID = session.turn?.inputID

  if (
    typeof idleAt !== "number" ||
    !Number.isFinite(idleAt) ||
    idleAt <= 0 ||
    idleAt < attempt.started_at
  )
    return undefined

  if (
    session.id !== attempt.session_id ||
    session.projectID !== projectID ||
    session.directory !== attempt.workspace ||
    !isWorkerAgent(session.agent) ||
    session.archived ||
    session.metadata?.lazersAttemptID !== attempt.id ||
    session.busy ||
    session.pendingInput !== false ||
    session.pendingPermissions !== 0 ||
    session.pendingForms !== 0 ||
    session.observationUnstable ||
    runningShells !== 0 ||
    activeChildren !== 0 ||
    session.outcome !== undefined ||
    session.turn?.state !== "completed" ||
    typeof inputID !== "string" ||
    !inputID ||
    !input.matchesWorkerInput(inputID)
  )
    return undefined

  try {
    const policy = ModelPolicy.safeParse(JSON.parse(attempt.policy).model)
    if (!policy.success || !input.sameModel(session.model, policy.data)) return undefined
  } catch {
    return undefined
  }

  return {
    schema: "lazers-attempt-settlement-observation/v1",
    kind: "completed-idle-assignment-without-outcome",
    attemptID: attempt.id,
    sessionID: session.id,
    projectID,
    workspace: attempt.workspace,
    inputID,
    turnState: "completed",
    outcome: null,
    idleAt,
    busy: false,
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    observationUnstable: false,
    runningShells,
    activeChildren,
  }
}
