import type { HostSession } from "./host.ts"
import { ModelPolicy } from "./schema.ts"
import type { AttemptRow, NodeRow, PlanRow } from "./store.ts"

type WorkerStopObservation = {
  attemptID?: unknown
  sessionID?: unknown
  workspace?: unknown
  outcome?: unknown
  inputID?: unknown
}

export type TerminalWorkerHold = {
  kind: "terminal-worker-observation"
  attemptID?: unknown
  sessionID?: unknown
  workspace?: unknown
  inputID?: unknown
  outcome?: unknown
  turnState?: unknown
  idleAt?: unknown
  busy?: unknown
  pendingInput?: unknown
  pendingPermissions?: unknown
  pendingForms?: unknown
  observationUnstable?: unknown
  background?: HostSession["background"]
}

export type TerminalWorkerContinuationFacts = {
  plan: Pick<PlanRow, "state" | "owner" | "model" | "artifact">
  node: Pick<NodeRow, "task_id" | "state"> | undefined
  attempt:
    | Pick<
        AttemptRow,
        "id" | "task_id" | "state" | "session_id" | "message_id" | "workspace" | "policy"
      >
    | undefined
  latestAttemptID: string | undefined
  commandTaskID: string | undefined
  commandAttemptID: string | undefined
  caller: string
  owner: HostSession | null | undefined
  worker: HostSession | null | undefined
  projectID: string
  taskCurrent: boolean
  assignedInputMatches: boolean
  backgroundInputMatches: boolean
  stopObservation: WorkerStopObservation | undefined
  planHoldObservation: TerminalWorkerHold | undefined
  retainedSession: boolean
  retainedPrompt: boolean
  hasUnresolvedEffects: boolean
  reservationAvailable: boolean
}

function sameRoute(left: unknown, right: unknown): boolean {
  const first = ModelPolicy.safeParse(left)
  const second = ModelPolicy.safeParse(right)
  return (
    first.success &&
    second.success &&
    first.data.providerID === second.data.providerID &&
    first.data.id === second.data.id &&
    first.data.variant === second.data.variant
  )
}

function storedRoute(value: string | null): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function policyModel(policy: string): unknown {
  try {
    return (JSON.parse(policy) as { model?: unknown }).model
  } catch {
    return undefined
  }
}

/** Return the fail-closed reason, or undefined when the exact terminal assignment may continue. */
export function terminalWorkerContinuationProblem(
  facts: TerminalWorkerContinuationFacts,
): string | undefined {
  const { plan, node, attempt, owner, worker, stopObservation, planHoldObservation } = facts

  if (facts.caller !== plan.owner || !owner || owner.id !== plan.owner || owner.archived)
    return "Terminal worker continuation requires the current plan owner"
  if (owner.projectID !== facts.projectID || owner.agent !== "architect")
    return "Terminal worker continuation requires the same-project Architect owner"
  if (
    !attempt ||
    !node ||
    facts.commandTaskID !== attempt.task_id ||
    node.task_id !== attempt.task_id
  )
    return "Terminal worker continuation must name a task with its retained attempt"
  if (!facts.commandAttemptID || facts.commandAttemptID !== attempt.id)
    return "Terminal worker continuation requires the exact attemptID"
  if (facts.latestAttemptID !== attempt.id)
    return "Terminal worker continuation must name the exact latest task attempt"
  if (plan.state !== "blocked" || plan.artifact !== null)
    return "Only blocked, non-integrated work can continue"
  if (!facts.taskCurrent) return "Task revision or project lineage changed since plan admission"
  if (facts.hasUnresolvedEffects) return "Reconcile uncertain effects first"
  if (!facts.retainedSession || !facts.retainedPrompt)
    return "The retained worker session and assigned input need completed native receipts"
  if (!facts.reservationAvailable)
    return "A conflicting active worker or plan effect prevents continuation"

  const nativeOutcome = worker?.outcome
  const validState =
    ((nativeOutcome === "interrupted" || nativeOutcome === "succeeded") &&
      node.state === "running" &&
      attempt.state === "running") ||
    (nativeOutcome === "failed" &&
      ((node.state === "running" && attempt.state === "running") ||
        (node.state === "failed" && attempt.state === "failed")))
  if (
    !validState ||
    !planHoldObservation ||
    planHoldObservation.kind !== "terminal-worker-observation" ||
    planHoldObservation.attemptID !== attempt.id ||
    planHoldObservation.sessionID !== attempt.session_id ||
    planHoldObservation.workspace !== attempt.workspace ||
    planHoldObservation.outcome !== nativeOutcome ||
    planHoldObservation.busy !== false ||
    planHoldObservation.pendingInput !== false ||
    planHoldObservation.pendingPermissions !== 0 ||
    planHoldObservation.pendingForms !== 0 ||
    planHoldObservation.observationUnstable !== false ||
    !stopObservation ||
    stopObservation.attemptID !== attempt.id ||
    stopObservation.sessionID !== attempt.session_id ||
    stopObservation.workspace !== attempt.workspace ||
    stopObservation.outcome !== nativeOutcome
  )
    return "Plan is not held for this attempt's matching terminal worker observation"

  if (
    !worker ||
    worker.id !== attempt.session_id ||
    worker.projectID !== facts.projectID ||
    worker.directory !== attempt.workspace ||
    worker.agent !== "lazers-implementor" ||
    worker.archived ||
    worker.metadata?.lazersAttemptID !== attempt.id
  )
    return "Native worker session is not the owned attempt"
  if (
    !plan.model ||
    !sameRoute(policyModel(attempt.policy), storedRoute(plan.model)) ||
    !sameRoute(worker.model, policyModel(attempt.policy))
  )
    return "Native worker route does not match the retained attempt policy"
  if (
    worker.busy ||
    worker.pendingInput === true ||
    worker.observationUnstable ||
    (worker.pendingPermissions ?? 0) !== 0 ||
    (worker.pendingForms ?? 0) !== 0
  )
    return "Native worker has active, pending, approval or unstable activity"
  const expectedTurnState = nativeOutcome === "interrupted" ? "interrupted" : "completed"
  if (
    (nativeOutcome !== "interrupted" &&
      nativeOutcome !== "failed" &&
      nativeOutcome !== "succeeded") ||
    worker.turn?.state !== expectedTurnState ||
    !worker.turn.inputID ||
    !facts.assignedInputMatches
  )
    return "Terminal worker outcome does not match the current assigned input lineage"
  if (
    stopObservation.inputID !== worker.turn.inputID ||
    planHoldObservation.inputID !== worker.turn.inputID ||
    planHoldObservation.turnState !== worker.turn.state
  )
    return "Terminal worker hold does not match the current assigned input lineage"

  if (worker.background?.state === "observed") {
    if (worker.background.count > 0)
      return "Known background work must finish before the terminal attempt can continue"
    if (
      worker.background.count !== 0 ||
      !facts.backgroundInputMatches ||
      worker.background.inputID !== worker.turn.inputID
    )
      return "Native idle background observation does not match the current worker input lineage"
  }
  const heldBackground = planHoldObservation.background
  if (
    heldBackground?.state === "observed" &&
    heldBackground.count > 0 &&
    (worker.background?.state !== "observed" ||
      worker.background.count !== 0 ||
      !facts.backgroundInputMatches ||
      worker.background.inputID !== worker.turn.inputID)
  )
    return "Known background work has no matching cleared observation"

  return undefined
}
