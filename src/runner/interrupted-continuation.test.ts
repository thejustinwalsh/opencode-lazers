import { expect, test } from "bun:test"
import type { HostSession } from "./host.ts"
import {
  resolveRetainedRepairInputLineage,
  terminalWorkerContinuationProblem,
  type RetainedRepairContinuationTransition,
  type TerminalWorkerContinuationFacts,
} from "./interrupted-continuation.ts"

const route = { providerID: "openai", id: "test-model", variant: "high" }
const attemptID = "attempt-current"
const taskID = "task-current"
const sessionID = "worker-current"
const inputID = "msg-interrupted"
const workspace = "/workspace/task"

const repairLineage = {
  operationID: "repair-current",
  attemptID,
  originalMessageID: "msg-repair-input",
  assignedMessageID: "msg-repair-continuation",
  owner: "architect-current",
  ownerEpoch: 7,
}

test("retained repair continuation resolves only one owner-authorized interrupted input lineage", () => {
  const receipt: RetainedRepairContinuationTransition = {
    attemptID,
    previousMessageID: repairLineage.originalMessageID,
    messageID: repairLineage.assignedMessageID,
    terminalInputID: repairLineage.originalMessageID,
    interruptedInputID: repairLineage.originalMessageID,
    terminalOutcome: "interrupted",
    retainedRepairContinuation: {
      schema: "lazers-retained-repair-continuation/v1",
      operationID: repairLineage.operationID,
      owner: repairLineage.owner,
      ownerEpoch: repairLineage.ownerEpoch,
    },
  }
  expect(
    resolveRetainedRepairInputLineage({
      ...repairLineage,
      allowLegacyReceipt: false,
      transitions: [receipt],
    }),
  ).toEqual({
    status: "continued",
    nativeInputID: repairLineage.originalMessageID,
    terminalOutcome: "interrupted",
  })
  expect(
    resolveRetainedRepairInputLineage({
      ...repairLineage,
      assignedMessageID: repairLineage.originalMessageID,
      allowLegacyReceipt: false,
      transitions: [],
    }),
  ).toEqual({ status: "direct", nativeInputID: repairLineage.originalMessageID })

  expect(
    resolveRetainedRepairInputLineage({
      ...repairLineage,
      allowLegacyReceipt: true,
      transitions: [
        {
          attemptID,
          previousMessageID: repairLineage.originalMessageID,
          messageID: repairLineage.assignedMessageID,
          terminalInputID: repairLineage.originalMessageID,
          interruptedInputID: repairLineage.originalMessageID,
          terminalOutcome: "interrupted",
        },
      ],
    }),
  ).toEqual({
    status: "continued",
    nativeInputID: repairLineage.originalMessageID,
    terminalOutcome: "interrupted",
  })
})

test("a retained-repair recovery receipt links its unprompted reservation to the observed old input", () => {
  const firstContinuation: RetainedRepairContinuationTransition = {
    attemptID,
    previousMessageID: repairLineage.originalMessageID,
    messageID: "msg-unprompted-reservation",
    terminalInputID: repairLineage.originalMessageID,
    interruptedInputID: repairLineage.originalMessageID,
    terminalOutcome: "interrupted",
  }
  const recovery: RetainedRepairContinuationTransition = {
    attemptID,
    previousMessageID: "msg-unprompted-reservation",
    messageID: repairLineage.assignedMessageID,
    terminalInputID: repairLineage.originalMessageID,
    interruptedInputID: repairLineage.originalMessageID,
    terminalOutcome: "interrupted",
    retainedRepairRecovery: {
      schema: "lazers-retained-repair-recovery/v1",
      operationID: repairLineage.operationID,
      failedMessageID: "msg-unprompted-reservation",
      interruptedInputID: repairLineage.originalMessageID,
      owner: repairLineage.owner,
      ownerEpoch: repairLineage.ownerEpoch,
      failedResumeTransitionID: 18,
      blockedTransitionID: 20,
      cancelledTransitionID: 21,
    },
  }
  expect(
    resolveRetainedRepairInputLineage({
      ...repairLineage,
      allowLegacyReceipt: true,
      transitions: [firstContinuation, recovery],
    }),
  ).toEqual({
    status: "continued",
    nativeInputID: repairLineage.originalMessageID,
    terminalOutcome: "interrupted",
  })

  for (const mutate of [
    (value: RetainedRepairContinuationTransition) => {
      value.terminalInputID = "msg-foreign-input"
    },
    (value: RetainedRepairContinuationTransition) => {
      value.retainedRepairRecovery = {
        ...(value.retainedRepairRecovery as Record<string, unknown>),
        ownerEpoch: repairLineage.ownerEpoch + 1,
      }
    },
    (value: RetainedRepairContinuationTransition) => {
      value.retainedRepairRecovery = {
        ...(value.retainedRepairRecovery as Record<string, unknown>),
        cancelledTransitionID: 19,
      }
    },
  ]) {
    const invalidRecovery = structuredClone(recovery)
    mutate(invalidRecovery)
    expect(
      resolveRetainedRepairInputLineage({
        ...repairLineage,
        allowLegacyReceipt: true,
        transitions: [firstContinuation, invalidRecovery],
      }).status,
    ).toBe("invalid")
  }

  expect(
    resolveRetainedRepairInputLineage({
      ...repairLineage,
      allowLegacyReceipt: false,
      transitions: [firstContinuation],
    }).status,
  ).toBe("invalid")
  expect(
    resolveRetainedRepairInputLineage({
      ...repairLineage,
      allowLegacyReceipt: true,
      transitions: [firstContinuation, firstContinuation],
    }).status,
  ).toBe("invalid")
})

function facts(): TerminalWorkerContinuationFacts {
  const owner: HostSession = {
    id: "architect-current",
    projectID: "project-current",
    directory: "/workspace",
    agent: "architect",
    archived: false,
    busy: false,
    tokens: 0,
    tools: 0,
    cost: null,
    messages: [],
  }
  const worker: HostSession = {
    id: sessionID,
    projectID: "project-current",
    directory: workspace,
    agent: "lazers-implementor",
    metadata: { lazersAttemptID: attemptID },
    model: route,
    archived: false,
    busy: false,
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    outcome: "interrupted",
    turn: { inputID, state: "interrupted" },
    background: {
      state: "unknown",
      source: "experimental.idle",
      reason: "replacement process has no idle-hook report",
    },
    tokens: 50,
    tools: 3,
    cost: null,
    messages: [],
  }
  return {
    plan: {
      state: "blocked",
      owner: owner.id,
      model: JSON.stringify(route),
      artifact: null,
    },
    node: { task_id: taskID, state: "running" },
    attempt: {
      id: attemptID,
      task_id: taskID,
      state: "running",
      session_id: sessionID,
      message_id: inputID,
      workspace,
      policy: JSON.stringify({ model: route }),
    },
    latestAttemptID: attemptID,
    commandTaskID: taskID,
    commandAttemptID: attemptID,
    caller: owner.id,
    owner,
    worker,
    projectID: "project-current",
    taskCurrent: true,
    assignedInputMatches: true,
    backgroundInputMatches: false,
    stopObservation: {
      attemptID,
      sessionID,
      workspace,
      outcome: "interrupted",
      inputID,
    },
    planHoldObservation: {
      kind: "terminal-worker-observation",
      attemptID,
      sessionID,
      workspace,
      inputID,
      outcome: "interrupted",
      turnState: "interrupted",
      busy: false,
      pendingInput: false,
      pendingPermissions: 0,
      pendingForms: 0,
      observationUnstable: false,
      background: worker.background,
    },
    retainedSession: true,
    retainedPrompt: true,
    hasUnresolvedEffects: false,
    reservationAvailable: true,
  }
}

test("unknown background remains explicit while the exact interrupted assignment may continue", () => {
  expect(terminalWorkerContinuationProblem(facts())).toBeUndefined()
})

test("an exact failed input can resume after an older adapter recorded its hold as pending", () => {
  const value = facts()
  value.worker!.outcome = "failed"
  value.worker!.turn = { inputID, state: "completed" }
  value.stopObservation!.outcome = "failed"
  value.planHoldObservation!.outcome = "failed"
  value.planHoldObservation!.turnState = "pending"
  expect(terminalWorkerContinuationProblem(value)).toBeUndefined()
  value.assignedInputMatches = false
  expect(terminalWorkerContinuationProblem(value)).toContain("input lineage")
})

test("a stopped verifying attempt can continue without a running-turn hold record", () => {
  const value = facts()
  value.node!.state = "verifying"
  value.attempt!.state = "verifying"
  value.worker!.outcome = "succeeded"
  value.worker!.turn = { inputID, state: "completed" }
  value.stopObservation = undefined
  value.planHoldObservation = undefined
  expect(terminalWorkerContinuationProblem(value)).toBeUndefined()

  value.hasUnresolvedEffects = true
  expect(terminalWorkerContinuationProblem(value)).toContain("uncertain effects")
  value.hasUnresolvedEffects = false
  value.worker!.busy = true
  expect(terminalWorkerContinuationProblem(value)).toContain("active")
  value.worker!.busy = false
  value.assignedInputMatches = false
  expect(terminalWorkerContinuationProblem(value)).toContain("input lineage")
})

test("a completed model turn can continue unfinished work without establishing task completion", () => {
  const value = facts()
  value.worker!.outcome = "succeeded"
  value.worker!.turn = { inputID, state: "completed" }
  value.stopObservation!.outcome = "succeeded"
  value.planHoldObservation!.outcome = "succeeded"
  value.planHoldObservation!.turnState = "completed"

  expect(terminalWorkerContinuationProblem(value)).toBeUndefined()
  expect(value.worker!.background?.state).toBe("unknown")
  value.node!.state = "accepted"
  expect(terminalWorkerContinuationProblem(value)).toBeDefined()
})

test("a genuinely failed native outcome with its completed assigned turn stays failed and may continue", () => {
  const value = facts()
  value.worker!.outcome = "failed"
  value.worker!.turn = { inputID, state: "completed" }
  value.node!.state = "failed"
  value.attempt!.state = "failed"
  value.stopObservation!.outcome = "failed"
  value.planHoldObservation!.outcome = "failed"
  value.planHoldObservation!.turnState = "completed"

  expect(terminalWorkerContinuationProblem(value)).toBeUndefined()
})

test.each([
  [
    "another caller",
    (value: TerminalWorkerContinuationFacts) => {
      value.caller = "other"
    },
  ],
  [
    "an archived owner",
    (value: TerminalWorkerContinuationFacts) => {
      value.owner!.archived = true
    },
  ],
  [
    "a foreign owner",
    (value: TerminalWorkerContinuationFacts) => {
      value.owner!.projectID = "other"
    },
  ],
  [
    "a stale attempt",
    (value: TerminalWorkerContinuationFacts) => {
      value.latestAttemptID = "older"
    },
  ],
  [
    "a wrong attempt ID",
    (value: TerminalWorkerContinuationFacts) => {
      value.commandAttemptID = "older"
    },
  ],
  [
    "an unrelated hold",
    (value: TerminalWorkerContinuationFacts) => {
      value.planHoldObservation = undefined
    },
  ],
  [
    "an unresolved effect",
    (value: TerminalWorkerContinuationFacts) => {
      value.hasUnresolvedEffects = true
    },
  ],
  [
    "a conflicting reservation",
    (value: TerminalWorkerContinuationFacts) => {
      value.reservationAvailable = false
    },
  ],
  [
    "a foreign worker",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.projectID = "other"
    },
  ],
  [
    "an archived worker",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.archived = true
    },
  ],
  [
    "a wrong worker attempt",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.metadata = {}
    },
  ],
  [
    "a wrong worker route",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.model = { ...route, id: "other" }
    },
  ],
  [
    "a different interrupted input",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.turn!.inputID = "msg-old"
    },
  ],
  [
    "a failed outcome without its current-input stop record",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.outcome = "failed"
      value.worker!.turn = { inputID, state: "completed" }
      value.node!.state = "failed"
      value.attempt!.state = "failed"
    },
  ],
  [
    "a failed outcome with an earlier failure input",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.outcome = "failed"
      value.worker!.turn = { inputID, state: "completed" }
      value.node!.state = "failed"
      value.attempt!.state = "failed"
      value.stopObservation!.outcome = "failed"
      value.stopObservation!.inputID = "msg-old"
      value.planHoldObservation!.outcome = "failed"
      value.planHoldObservation!.turnState = "completed"
    },
  ],
  [
    "a completed turn without a failed native outcome",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.outcome = "succeeded"
      value.worker!.turn = { inputID, state: "completed" }
      value.node!.state = "failed"
      value.attempt!.state = "failed"
      value.stopObservation!.outcome = "succeeded"
      value.planHoldObservation!.outcome = "succeeded"
      value.planHoldObservation!.turnState = "completed"
    },
  ],
  [
    "a busy worker",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.busy = true
    },
  ],
  [
    "pending input",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.pendingInput = true
    },
  ],
  [
    "an approval",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.pendingPermissions = 1
    },
  ],
  [
    "an unstable observation",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.observationUnstable = true
    },
  ],
  [
    "known background work",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.background = {
        state: "observed",
        source: "experimental.idle",
        observedAt: 1,
        inputID,
        executionStartSequence: 1,
        eventSequence: 2,
        count: 1,
        kinds: { shell: 1, subagent: 0, image: 0 },
      }
      value.backgroundInputMatches = true
    },
  ],
  [
    "a mismatched known-idle report",
    (value: TerminalWorkerContinuationFacts) => {
      value.worker!.background = {
        state: "observed",
        source: "experimental.idle",
        observedAt: 1,
        inputID: "msg-old",
        executionStartSequence: 1,
        eventSequence: 2,
        count: 0,
        kinds: { shell: 0, subagent: 0, image: 0 },
      }
      value.backgroundInputMatches = false
    },
  ],
] as const)("rejects %s", (_label, mutate) => {
  const value = facts()
  mutate(value)
  expect(terminalWorkerContinuationProblem(value)).toBeString()
})
