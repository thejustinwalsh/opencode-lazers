import type { EffectRow } from "../store.ts"
import type { RunnerTransitionRecord } from "../runtime-helpers.ts"
import { RETAINED_REPAIR_FENCE_FAILURE_REASON } from "../interrupted-continuation.ts"

export type RetainedRepairRecoveryReservation = {
  operationID: string
  messageID: string
  previousMessageID: string
  nativeInputID: string
  nativeAssignmentID?: string
  sessionID: string
  workspace: string
  workerObservation: string
}

export type RetainedRepairRecoveryAttempt = {
  id: string
  task_id: string
  message_id: string
  session_id: string
  workspace: string
}

type TransitionPayload = Record<string, unknown>

export type UnpromptedFenceEvidence = {
  kind: "unprompted"
  nativeInputID: string
  failedMessageID: string
  unpromptedMessageIDs: string[]
  reservationTransitionID: number | null
  blockedTransitionID: number
  cancelledTransitionID: number
}

export type RetainedRepairReservationChain = {
  messageIDs: string[]
  transitionID: number | null
}

function payloadOf(transition: RunnerTransitionRecord): TransitionPayload | undefined {
  try {
    const value: unknown = JSON.parse(transition.payload)
    return typeof value === "object" && value !== null ? (value as TransitionPayload) : undefined
  } catch {
    return undefined
  }
}

function effectPayload(effect: EffectRow): TransitionPayload | undefined {
  try {
    const value: unknown = JSON.parse(effect.payload)
    return typeof value === "object" && value !== null ? (value as TransitionPayload) : undefined
  } catch {
    return undefined
  }
}

function effectReceipt(effect: EffectRow): TransitionPayload | undefined {
  try {
    const value: unknown = JSON.parse(effect.receipt ?? "null")
    return typeof value === "object" && value !== null ? (value as TransitionPayload) : undefined
  } catch {
    return undefined
  }
}

function storedWorkerObservationMatches(
  repair: RetainedRepairRecoveryReservation,
  attempt: RetainedRepairRecoveryAttempt,
  taskID: string,
  projectID: string,
  inputID: string,
): boolean {
  try {
    const captured = JSON.parse(repair.workerObservation) as TransitionPayload
    const turn =
      typeof captured.turn === "object" && captured.turn !== null
        ? (captured.turn as TransitionPayload)
        : undefined
    const messages = Array.isArray(captured.messages) ? captured.messages : []
    return (
      captured.id === attempt.session_id &&
      captured.projectID === projectID &&
      captured.directory === attempt.workspace &&
      captured.attemptID === attempt.id &&
      captured.busy === false &&
      captured.pendingInput === false &&
      captured.observationUnstable === false &&
      captured.pendingPermissions === 0 &&
      captured.pendingForms === 0 &&
      captured.archived === false &&
      captured.outcome === "succeeded" &&
      turn?.inputID === inputID &&
      turn.state === "completed" &&
      Number(captured.runningShells ?? 0) === 0 &&
      Number(captured.activeChildren ?? 0) === 0 &&
      messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as TransitionPayload).id === inputID,
      ) &&
      repair.sessionID === attempt.session_id &&
      repair.workspace === attempt.workspace &&
      taskID === attempt.task_id
    )
  } catch {
    return false
  }
}

function predecessorPromptReceipt(
  repair: RetainedRepairRecoveryReservation,
  repairTransition: RunnerTransitionRecord,
  attempt: RetainedRepairRecoveryAttempt,
  taskID: string,
  effects: readonly EffectRow[],
  history: readonly RunnerTransitionRecord[],
): boolean {
  const matches = effects.filter((effect) => {
    const payload = effectPayload(effect)
    return (
      effect.attempt_id === attempt.id &&
      effect.task_id === taskID &&
      effect.kind === "prompt" &&
      payload?.messageID === repair.previousMessageID
    )
  })
  if (matches.length !== 1) return false
  const effect = matches[0]!
  const payload = effectPayload(effect)
  const receipt = effectReceipt(effect)
  if (
    effect.state !== "completed" ||
    payload?.sessionID !== attempt.session_id ||
    payload.workspace !== attempt.workspace ||
    receipt?.messageID !== repair.previousMessageID ||
    receipt.taskID !== taskID
  )
    return false

  const operationID = payload.repairID
  if (operationID === undefined) return receipt.repairID === undefined
  if (typeof operationID !== "string" || receipt.repairID !== operationID) return false
  return history.some((transition) => {
    if (
      transition.task_id !== taskID ||
      transition.event !== "RETAINED_REPAIR_REQUESTED" ||
      transition.id >= repairTransition.id
    )
      return false
    const prior = payloadOf(transition)
    return (
      prior?.operationID === operationID &&
      prior.messageID === repair.previousMessageID &&
      prior.attemptID === attempt.id &&
      prior.sessionID === attempt.session_id &&
      prior.workspace === attempt.workspace
    )
  })
}

export function retainedRepairPredecessorPromptProven(input: {
  taskID: string
  projectID: string
  repair: RetainedRepairRecoveryReservation
  repairTransition: RunnerTransitionRecord
  attempt: RetainedRepairRecoveryAttempt
  effects: readonly EffectRow[]
  history: readonly RunnerTransitionRecord[]
}): boolean {
  const nativeInputID = input.repair.nativeInputID || input.repair.previousMessageID
  return (
    storedWorkerObservationMatches(
      input.repair,
      input.attempt,
      input.taskID,
      input.projectID,
      nativeInputID,
    ) &&
    predecessorPromptReceipt(
      input.repair,
      input.repairTransition,
      input.attempt,
      input.taskID,
      input.effects,
      input.history,
    )
  )
}

function promptWasConclusivelyNotSent(effect: EffectRow): boolean {
  if (effect.state !== "failed") return false
  return effectReceipt(effect)?.notSent === true
}

function reservationWasNotAdmitted(
  messageID: string,
  attempt: RetainedRepairRecoveryAttempt,
  taskID: string,
  effects: readonly EffectRow[],
  nativeMessageIDs: ReadonlySet<string>,
): boolean {
  if (nativeMessageIDs.has(messageID)) return false
  for (const effect of effects) {
    if (effect.attempt_id !== attempt.id || effect.task_id !== taskID || effect.kind !== "prompt")
      continue
    const payload = effectPayload(effect)
    if (!payload) return false
    if (payload.messageID === messageID && !promptWasConclusivelyNotSent(effect)) return false
  }
  return true
}

export function retainedRepairReservationsRemainUnprompted(
  messageIDs: readonly string[],
  attemptID: string,
  taskID: string,
  effects: readonly EffectRow[],
): boolean {
  const reservations = new Set(messageIDs)
  for (const effect of effects) {
    if (effect.attempt_id !== attemptID || effect.task_id !== taskID || effect.kind !== "prompt")
      continue
    const payload = effectPayload(effect)
    if (!payload || typeof payload.messageID !== "string") return false
    if (reservations.has(payload.messageID) && !promptWasConclusivelyNotSent(effect)) return false
  }
  return true
}

export function traceRetainedRepairReservations(input: {
  operationID: string
  initialMessageID: string
  attempt: RetainedRepairRecoveryAttempt
  taskID: string
  afterTransitionID: number
  throughTransitionID?: number
  effects: readonly EffectRow[]
  history: readonly RunnerTransitionRecord[]
}): RetainedRepairReservationChain | undefined {
  let currentMessageID = input.initialMessageID
  const messageIDs = [currentMessageID]
  let transitionID: number | null = null
  const reservationTransitions = input.history.filter(
    (transition) =>
      transition.task_id === input.taskID &&
      ["ATTEMPT_RESUMED", "PROMPT_NOT_DISPATCHED"].includes(transition.event) &&
      transition.id > input.afterTransitionID &&
      (input.throughTransitionID === undefined || transition.id <= input.throughTransitionID),
  )
  for (const transition of reservationTransitions) {
    const payload = payloadOf(transition)
    if (
      !payload ||
      payload.attemptID !== input.attempt.id ||
      payload.previousMessageID !== currentMessageID ||
      typeof payload.messageID !== "string" ||
      !payload.messageID ||
      payload.messageID === currentMessageID
    )
      return undefined

    if (transition.event === "ATTEMPT_RESUMED") {
      if (
        payload.terminalOutcome !== undefined ||
        payload.terminalInputID !== undefined ||
        payload.interruptedInputID !== undefined ||
        payload.retainedRepairContinuation !== undefined ||
        payload.retainedRepairRecovery !== undefined
      )
        return undefined
    } else {
      if (
        payload.repairID !== input.operationID ||
        payload.sessionID !== input.attempt.session_id ||
        payload.workspace !== input.attempt.workspace ||
        typeof payload.effectID !== "string"
      )
        return undefined
      const promptEffects = input.effects.filter((effect) => effect.id === payload.effectID)
      if (promptEffects.length !== 1) return undefined
      const effect = promptEffects[0]!
      const effectData = effectPayload(effect)
      if (
        effect.kind !== "prompt" ||
        effect.attempt_id !== input.attempt.id ||
        effect.task_id !== input.taskID ||
        effectData?.messageID !== currentMessageID ||
        effectData.sessionID !== input.attempt.session_id ||
        effectData.workspace !== input.attempt.workspace ||
        effectData.repairID !== input.operationID ||
        !promptWasConclusivelyNotSent(effect) ||
        effectReceipt(effect)?.reason !== "Native prompt guard prevented dispatch"
      )
        return undefined
    }
    currentMessageID = payload.messageID
    messageIDs.push(currentMessageID)
    transitionID = transition.id
  }
  return { messageIDs, transitionID }
}

function currentFenceHoldMatches(
  planReason: string | null,
  taskID: string,
  history: readonly RunnerTransitionRecord[],
  fenceTransition: RunnerTransitionRecord,
  cancelTransition: RunnerTransitionRecord,
): boolean {
  const blocked = history
    .filter((transition) => transition.task_id === null && transition.event === "BLOCKED")
    .map((transition) => ({ transition, payload: payloadOf(transition) }))
  const latest = blocked.at(-1)
  if (!latest || latest.payload?.reason !== planReason) return false
  if (planReason === RETAINED_REPAIR_FENCE_FAILURE_REASON)
    return latest.transition.id === fenceTransition.id

  const cancelledTaskReason = `Task ${taskID}: cancelled`
  if (planReason !== cancelledTaskReason || latest.transition.id <= cancelTransition.id)
    return false
  return history.some(
    (transition) =>
      transition.task_id === null &&
      transition.event === "RECONCILE_REQUESTED" &&
      transition.id > cancelTransition.id &&
      transition.id < latest.transition.id,
  )
}

/**
 * Prove that an owner-authorized retained repair reservation never reached the worker, while its
 * predecessor prompt did. A later generic resume may reserve more IDs; each must remain absent
 * from both the native message history and the prompt-effect journal.
 */
export function proveUnpromptedRetainedRepairFenceFailure(input: {
  taskID: string
  projectID: string
  planReason: string | null
  repair: RetainedRepairRecoveryReservation
  repairTransition: RunnerTransitionRecord
  attempt: RetainedRepairRecoveryAttempt
  effects: readonly EffectRow[]
  history: readonly RunnerTransitionRecord[]
  nativeMessageIDs: ReadonlySet<string>
}): UnpromptedFenceEvidence | undefined {
  const {
    taskID,
    projectID,
    planReason,
    repair,
    repairTransition,
    attempt,
    effects,
    history,
    nativeMessageIDs,
  } = input
  const nativeInputID = repair.nativeInputID || repair.previousMessageID
  if (
    repairTransition.task_id !== taskID ||
    repairTransition.event !== "RETAINED_REPAIR_REQUESTED" ||
    payloadOf(repairTransition)?.operationID !== repair.operationID ||
    !repair.operationID ||
    !repair.messageID ||
    !repair.previousMessageID ||
    !nativeInputID ||
    (repair.nativeAssignmentID !== undefined &&
      repair.nativeAssignmentID !== repair.previousMessageID) ||
    payloadOf(repairTransition)?.attemptID !== attempt.id ||
    !retainedRepairPredecessorPromptProven({
      taskID,
      projectID,
      repair,
      repairTransition,
      attempt,
      effects,
      history,
    })
  )
    return undefined

  const reservationChain = traceRetainedRepairReservations({
    operationID: repair.operationID,
    initialMessageID: repair.messageID,
    attempt,
    taskID,
    afterTransitionID: repairTransition.id,
    effects,
    history,
  })
  if (!reservationChain || attempt.message_id !== reservationChain.messageIDs.at(-1))
    return undefined
  if (
    !reservationChain.messageIDs.every((messageID) =>
      reservationWasNotAdmitted(messageID, attempt, taskID, effects, nativeMessageIDs),
    )
  )
    return undefined

  const blockedRows = history
    .filter(
      (transition) =>
        transition.task_id === null &&
        transition.event === "BLOCKED" &&
        transition.id > repairTransition.id,
    )
    .map((transition) => ({ transition, payload: payloadOf(transition) }))
  const fences = blockedRows.filter(
    ({ payload }) =>
      payload?.reason === RETAINED_REPAIR_FENCE_FAILURE_REASON &&
      payload.workerObservation === undefined,
  )
  const fence = fences.findLast(
    ({ transition }) => transition.id > (reservationChain.transitionID ?? repairTransition.id),
  )?.transition
  if (!fence) return undefined
  if (
    blockedRows.some(
      ({ transition, payload }) =>
        transition.id > fence.id &&
        transition.id <
          (history.findLast(
            (candidate) =>
              candidate.task_id === taskID &&
              candidate.event === "CANCEL" &&
              candidate.id > fence.id,
          )?.id ?? Number.MAX_SAFE_INTEGER) &&
        payload?.reason !== RETAINED_REPAIR_FENCE_FAILURE_REASON,
    )
  )
    return undefined

  const cancelTransition = history.findLast(
    (transition) =>
      transition.task_id === taskID && transition.event === "CANCEL" && transition.id > fence.id,
  )
  const cancel = cancelTransition ? payloadOf(cancelTransition) : undefined
  if (
    !cancelTransition ||
    !cancel ||
    !["ready", "running"].includes(cancel.from as string) ||
    cancel.to !== "cancelled" ||
    cancel.reason !== null ||
    history.some(
      (transition) =>
        transition.task_id === null &&
        transition.event === "CANCEL_REQUESTED" &&
        transition.id > repairTransition.id,
    ) ||
    !currentFenceHoldMatches(planReason, taskID, history, fence, cancelTransition)
  )
    return undefined

  return {
    kind: "unprompted",
    nativeInputID,
    failedMessageID: attempt.message_id,
    unpromptedMessageIDs: reservationChain.messageIDs,
    reservationTransitionID: reservationChain.transitionID,
    blockedTransitionID: fence.id,
    cancelledTransitionID: cancelTransition.id,
  }
}
