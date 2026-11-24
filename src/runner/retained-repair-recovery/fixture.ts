import { expect } from "bun:test"
import type { AttemptRow } from "../store.ts"
import { acceptedAttemptFixture, reopenRuntime } from "../runtime.fixture.ts"

export async function reproduceUnpromptedRetainedRepairFenceFailure(
  options: { reconciledReservation?: boolean } = {},
) {
  const { f, planID, task, original, artifact, worker } = await acceptedAttemptFixture()
  worker.tokens = 777
  worker.tools = 23
  worker.cost = 2.5
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_attempts SET token_count=?,tool_count=?,cost=? WHERE id=?")
      .run(worker.tokens, worker.tools, worker.cost, original.id),
  )
  await f.runtime.command(
    {
      requestID: "retained-repair-before-admission-fence",
      planID,
      action: "retained-repair",
      taskID: task.id,
      attemptID: original.id,
      artifact,
      reason: "The accepted parser misses the recovery edge case.",
    },
    "owner",
  )
  const repair = f.store.latestRetainedRepair<{
    operationID: string
    messageID: string
    previousMessageID: string
    nativeInputID: string
    owner: string
  }>(planID, task.id)!
  let failedMessageID = repair.messageID
  if (options.reconciledReservation) {
    const replacementMessageID = crypto.randomUUID()
    failedMessageID = replacementMessageID
    const effectID = crypto.randomUUID()
    f.store.atomic((db) => {
      db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'failed',?,?,0)").run(
        effectID,
        planID,
        task.id,
        original.id,
        "prompt",
        JSON.stringify({
          sessionID: original.session_id,
          messageID: repair.messageID,
          workspace: original.workspace,
          repairID: repair.operationID,
          previousMessageID: repair.previousMessageID,
          nativeInputID: repair.nativeInputID,
          repairMessageID: repair.messageID,
        }),
        JSON.stringify({
          notSent: true,
          reason: "Native prompt guard prevented dispatch",
        }),
      )
      db.query("UPDATE runner_attempts SET message_id=? WHERE id=?").run(
        replacementMessageID,
        original.id,
      )
    })
    f.store.record(planID, task.id, "PROMPT_NOT_DISPATCHED", {
      effectID,
      attemptID: original.id,
      sessionID: original.session_id,
      workspace: original.workspace,
      previousMessageID: repair.messageID,
      messageID: replacementMessageID,
      repairID: repair.operationID,
      continuation: "new durable message after native prompt guard",
    })
  }
  const currentRuntime = Reflect.get(f.runtime, "repairRecords") as {
    retainedRepairForAttempt: (candidate: AttemptRow) => unknown
  }
  const currentLookup = currentRuntime.retainedRepairForAttempt
  currentRuntime.retainedRepairForAttempt = () => undefined
  try {
    await f.runtime.tick()
    await f.runtime.tick()
  } finally {
    currentRuntime.retainedRepairForAttempt = currentLookup
  }
  const failedReservation = f.store.attempts(planID)[0]!
  expect(f.store.plan(planID)?.reason).toBe(
    "Retained repair is missing a valid owner/control authorization fence",
  )
  expect(failedReservation).toMatchObject({
    id: original.id,
    state: "cancelled",
    message_id: failedMessageID,
    session_id: original.session_id,
    workspace: original.workspace,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  await f.runtime.stop()
  const reopened = reopenRuntime(f)
  return {
    f,
    planID,
    task,
    original,
    attempt: failedReservation,
    artifact,
    repair,
    worker,
    reopened,
    failedReservation,
  }
}
