import { expect, spyOn, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RunnerCheckReceipt } from "../artifacts.ts"
import { git } from "../artifacts.ts"
import {
  drive,
  fixture,
  registeredPlanCommand,
  reopenRuntime,
  runPlan,
  useRuntimeFixtureCleanup,
} from "../runtime.fixture.ts"
import { UNCERTAIN_EFFECT_RECEIPT_SCHEMA } from "../startup-recovery.ts"
import { verificationActivitiesForDatabase } from "../verification-activities.ts"

useRuntimeFixtureCleanup()

async function retainedCandidateFixture() {
  const f = fixture({
    shared: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "shared.txt" }],
  })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id)
  const artifact = git(attempt.workspace, ["rev-parse", "HEAD"])
  const effectID = crypto.randomUUID()
  f.store.move(f.receipt.planID, attempt.task_id, "VERIFY")
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='verifying',artifact=? WHERE id=?").run(
      artifact,
      attempt.id,
    )
    db.query("UPDATE runner_nodes SET artifact=? WHERE task_id=?").run(artifact, attempt.task_id)
    db.query(
      "UPDATE runner_plans SET state='blocked',reason='Retained check is uncertain' WHERE id=?",
    ).run(f.receipt.planID)
    const receiptPath = join(f.root, "retained-check.json")
    const verification = f.tasks[0]!.proposal.verification[0]!
    const interrupted = {
      id: verification.id,
      command: verification.command,
      cwd: attempt.workspace,
      artifact,
      inputIdentity: "retained-check",
      environmentIdentity: "retained-check",
      startedAt: 1,
      endedAt: 2,
      exitCode: null,
      timedOut: false,
      aborted: true,
      stdout: "",
      stderr: "",
    }
    writeFileSync(receiptPath, JSON.stringify(interrupted))
    db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'uncertain',?,?,0)").run(
      effectID,
      f.receipt.planID,
      attempt.task_id,
      attempt.id,
      "verify:content",
      JSON.stringify({
        workspace: attempt.workspace,
        artifact,
        check: verification,
        identity: "retained-check",
        receiptPath,
      }),
      JSON.stringify({
        schema: UNCERTAIN_EFFECT_RECEIPT_SCHEMA,
        error: "Verification was interrupted before completion",
        result: { check: interrupted },
      }),
    )
  })
  return { ...f, retained: f.store.attempts(f.receipt.planID)[0]!, artifact }
}

test("registered verify-retained recovery after receipt-producer loss keeps deadline provenance", async () => {
  const f = await retainedCandidateFixture()
  // Keep the publication boundary under explicit test control; recovery is advanced after reopen.
  Reflect.set(f.runtime, "requestTick", async () => {})

  const plan = f.store.plan(f.receipt.planID)!
  const task = f.tasks[0]!
  const tool = await registeredPlanCommand(f.runtime)
  const request = {
    requestID: "retained-receipt-publication-recovery",
    planID: plan.id,
    action: "verify-retained" as const,
    projectID: "project",
    planRevision: plan.revision,
    taskID: task.id,
    taskRevision: task.revision,
    attemptID: f.retained.id,
    artifact: f.artifact,
    reason: "Recover the exact retained check receipt after its producer stops",
  }
  const originalRename = fsPromises.rename.bind(fsPromises)
  const published: Array<{ path: string; receipt: RunnerCheckReceipt }> = []
  let simulatedProducerLoss = false
  const renameSpy = spyOn(fsPromises, "rename").mockImplementation(async (source, destination) => {
    await originalRename(source, destination)
    const path = String(destination)
    if (
      !simulatedProducerLoss &&
      path.includes("retained-verification") &&
      path.endsWith(".json")
    ) {
      simulatedProducerLoss = true
      published.push({
        path,
        receipt: JSON.parse(readFileSync(path, "utf8")) as RunnerCheckReceipt,
      })
      // The final path is durable, but the activity loses its producer before returning a result.
      throw new Error("Simulated producer loss immediately after receipt publication")
    }
  })

  try {
    await tool.execute(request)
    const operation = f.store.atomic((db) =>
      db.query<{ id: string }, []>("SELECT id FROM runner_retained_verifications LIMIT 1").get(),
    )!
    await f.runtime.tick()

    const activityDeadline = Date.now() + 10_000
    let activity = verificationActivitiesForDatabase(f.store.repository.path).find(
      (candidate) =>
        candidate.metadata.kind === "retained" && candidate.metadata.operationID === operation.id,
    )
    while ((!activity || activity.state === "running") && Date.now() < activityDeadline) {
      await Bun.sleep(10)
      activity = verificationActivitiesForDatabase(f.store.repository.path).find(
        (candidate) =>
          candidate.metadata.kind === "retained" && candidate.metadata.operationID === operation.id,
      )
    }
    expect(activity?.state).toBe("failed")
    await activity?.settled
    expect(published).toHaveLength(1)
    const { path, receipt: observedAtPublication } = published[0]!
    expect(observedAtPublication).toMatchObject({
      id: "content",
      artifact: f.artifact,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      verificationDeadline: {
        timingPolicyVersion: 2,
        authoredTimeoutMs: 1_000,
        effectiveHardTimeoutMs: 1_000,
      },
    })
    expect(
      f.store.atomic((db) =>
        db
          .query<{ state: string; receipt: string | null }, [string]>(
            "SELECT state,receipt FROM runner_retained_verification_checks WHERE operation_id=?",
          )
          .get(operation.id),
      ),
    ).toEqual({ state: "intended", receipt: null })

    const reopened = reopenRuntime(f)
    await drive(reopened.runtime, 8)

    const recovered = reopened.store.atomic((db) =>
      db
        .query<{ state: string; cleanup_state: string; receipt: string | null }, [string]>(
          "SELECT state,cleanup_state,receipt FROM runner_retained_verification_checks WHERE operation_id=?",
        )
        .get(operation.id),
    )!
    expect(recovered.state).toBe("completed")
    expect(recovered.cleanup_state).toBe("complete")
    expect(JSON.parse(recovered.receipt!)).toEqual(observedAtPublication)
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(observedAtPublication)
    expect(
      reopened.store.atomic((db) =>
        db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM runner_retained_verifications WHERE id=?",
          )
          .get(operation.id),
      ),
    ).toMatchObject({ payload: expect.stringContaining('"state":"accepted"') })
    expect(reopened.store.attempts(plan.id)).toHaveLength(1)
    expect(published).toHaveLength(1)
  } finally {
    renameSpy.mockRestore()
  }
})
