import { expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { meterReads } from "./read-meter.fixture.ts"
import {
  drive,
  fixture,
  holdFailedAttempt,
  registeredPlanCommand,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

async function reconciledFailedTask() {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const command = await registeredPlanCommand(f.runtime)
  const { planID, attempt, worker } = await holdFailedAttempt(f)
  const originalMessageID = attempt.message_id

  await command.execute({
    requestID: "reconcile-failed-terminal-worker",
    planID,
    action: "reconcile",
  })
  await drive(f.runtime)

  const latestBlocked = f.store.latestTransition<{ reason?: string; workerObservation?: unknown }>(
    planID,
    null,
    "BLOCKED",
  )
  expect(latestBlocked?.reason).toContain(`Task ${attempt.task_id}:`)
  expect(latestBlocked).not.toHaveProperty("workerObservation")
  expect(f.store.plan(planID)?.state).toBe("blocked")

  return { f, command, planID, attempt, worker, originalMessageID }
}

test("public reconcile and scheduler rehold retain the exact failed worker for explicit resume", async () => {
  const { f, command, planID, attempt, worker, originalMessageID } = await reconciledFailedTask()
  const editedPath = join(attempt.workspace, "a.txt")
  expect(readFileSync(editedPath, "utf8")).toBe("a")
  writeFileSync(editedPath, "retained worker edit")
  const promptsBefore = f.events.filter((event) => event.startsWith("prompt:")).length
  const meter = meterReads(f.store)
  const resumed = await command.execute({
    requestID: "resume-reconciled-failed-terminal-worker",
    planID,
    action: "resume",
    taskID: attempt.task_id,
    attemptID: attempt.id,
    reason: "Continue the exact failed native worker after reconciliation",
  })
  meter.stop()

  expect(JSON.parse(String(resumed.content))).toMatchObject({ status: "resuming" })
  const terminalLookup = meter.statements.find((statement) =>
    statement.includes("$.workerObservation.attemptID"),
  )
  expect(terminalLookup).toContain("LIMIT 1")
  expect(terminalLookup).toContain("a.task_id=?")
  // Preparation and reservation each revalidate the same exact attempt independently.
  expect(meter.of(/workerObservation\.attemptID/).rows).toBe(2)

  const continuation = f.store.attempts(planID)
  expect(continuation).toHaveLength(1)
  expect(continuation[0]).toMatchObject({
    id: attempt.id,
    state: "preparing",
    session_id: attempt.session_id,
    workspace: attempt.workspace,
    base_commit: attempt.base_commit,
    policy: attempt.policy,
  })
  expect(continuation[0]?.message_id).not.toBe(originalMessageID)
  expect(readFileSync(editedPath, "utf8")).toBe("retained worker edit")
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptsBefore)
  expect(worker.outcome).toBe("failed")
  const event = f.store
    .activity(planID, attempt.task_id)
    .find((entry) => entry.event === "ATTEMPT_RESUMED")!
  expect(JSON.parse(event.payload)).toMatchObject({
    attemptID: attempt.id,
    previousMessageID: originalMessageID,
    terminalInputID: originalMessageID,
    terminalOutcome: "failed",
    usageRetained: true,
  })
})

test.each(["unrelated-hold", "stale-native-input", "stale-terminal-observation"] as const)(
  "reconciled failed-worker continuation rejects %s",
  async (condition) => {
    const { f, command, planID, attempt, worker } = await reconciledFailedTask()
    if (condition === "unrelated-hold") {
      f.store.record(planID, null, "BLOCKED", { reason: "A separate plan hold" })
    } else if (condition === "stale-native-input") {
      worker.turn = { inputID: "foreign-input", state: "completed" }
    } else {
      const row = f.store.read((db) =>
        db
          .query<{ id: number; payload: string }, [string, string]>(
            `SELECT id,payload FROM runner_transitions
             WHERE plan_id=? AND task_id IS NULL AND event='BLOCKED'
               AND json_extract(payload,'$.workerObservation.attemptID')=?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(planID, attempt.id),
      )!
      const payload = JSON.parse(row.payload) as {
        workerObservation: { attemptID: string }
      }
      payload.workerObservation.attemptID = "stale-attempt"
      f.store.atomic((db) =>
        db
          .query("UPDATE runner_transitions SET payload=? WHERE id=?")
          .run(JSON.stringify(payload), row.id),
      )
    }

    const before = f.store.attempts(planID)[0]!
    await expect(
      command.execute({
        requestID: `reject-reconciled-failed-${condition}`,
        planID,
        action: "resume",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        reason: "Resume only with matching current terminal evidence",
      }),
    ).rejects.toThrow()
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: before.id,
      state: "failed",
      message_id: before.message_id,
      session_id: before.session_id,
      workspace: before.workspace,
    })
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  },
)

test("reconciliation history cannot resume a failed worker after the plan is cancelled", async () => {
  const { f, command, planID, attempt } = await reconciledFailedTask()
  await command.execute({
    requestID: "cancel-reconciled-failed-terminal-worker",
    planID,
    action: "cancel",
    reason: "Cancel rather than continue the failed task",
  })
  await drive(f.runtime)
  expect(f.store.plan(planID)?.state).toBe("cancelled")

  await expect(
    command.execute({
      requestID: "resume-cancelled-failed-terminal-worker",
      planID,
      action: "resume",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      reason: "A cancelled plan cannot be revived by an old terminal observation",
    }),
  ).rejects.toThrow()
  expect(f.store.attempts(planID)).toMatchObject([
    { id: attempt.id, state: "failed", session_id: attempt.session_id },
  ])
})
