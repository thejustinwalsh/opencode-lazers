import { expect, spyOn, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { git } from "./artifacts.ts"
import type { RunnerCheckReceipt } from "./artifacts.ts"
import { fingerprint } from "../identity.ts"
import type { HostSession } from "./host.ts"
import {
  acceptedMergedFixture,
  cleanupBlockedFixture,
  countTransitions,
  drive,
  driveWithTaskSourceLandings,
  fixture,
  reopenRuntime,
  runPlan,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"
import { canonicalProjectWorktreePath } from "./workspace-location.ts"
import { summarizeCheckReceipt } from "./runtime-helpers.ts"
import {
  forgetVerificationActivity,
  startVerificationActivity,
  verificationActivityKey,
} from "./verification-activities.ts"

useRuntimeFixtureCleanup()

type RunnerFixture = ReturnType<typeof fixture>

async function addGraphCandidate(f: RunnerFixture, planID: string, artifact: string, name: string) {
  const workspace = canonicalProjectWorktreePath(f.root, name)
  await f.host.worktree({ directory: workspace, base: artifact })
  const check = f.input.verification[0]!
  const receipt: RunnerCheckReceipt = {
    id: check.id,
    command: check.command,
    cwd: workspace,
    artifact,
    inputIdentity: artifact,
    environmentIdentity: "{}",
    startedAt: 1,
    endedAt: 2,
    exitCode: 0,
    timedOut: false,
    stdout: "",
    stderr: "",
    processCleanup: {
      state: "settled",
      capability: "process-group",
      rootPID: process.pid,
    },
  }
  f.store.atomic((db) => {
    db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'completed',?,?,1)").run(
      crypto.randomUUID(),
      planID,
      null,
      null,
      "graph-worktree",
      JSON.stringify({ workspace, base: artifact }),
      JSON.stringify({ workspace, base: artifact }),
    )
    db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'completed',?,?,1)").run(
      crypto.randomUUID(),
      planID,
      null,
      null,
      `graph-verify:${check.id}`,
      JSON.stringify({ workspace, artifact, check }),
      JSON.stringify({ check: receipt }),
    )
  })
  return { workspace, check, receipt }
}

function addReceiptlessGraphCheckReplacement(
  f: RunnerFixture,
  planID: string,
  workspace: string,
  artifact: string,
) {
  const checkEffect = f.store
    .effects(planID)
    .find(
      (effect) =>
        effect.kind.startsWith("graph-verify:") &&
        JSON.parse(effect.payload).workspace === workspace,
    )!
  const check = JSON.parse(checkEffect.payload).check as {
    id: string
    command: string
  }
  const sourceGeneration = "repair-generation-1"
  const verificationEpoch = 283
  const reservationPayload = {
    workspace,
    artifact,
    identity: artifact,
    check,
    sourceGeneration,
    verificationEpoch,
  }
  const replacementPayload = {
    ...reservationPayload,
    check: { ...check, timeoutMs: 2_000, inactivityTimeoutMs: 1_000 },
    verificationDeadline: { defaultInactivityTimeoutMs: 1_000 },
  }
  const reservationReceipt = JSON.stringify({
    superseded: true,
    reason: "No settled receipt was recorded; the check re-runs",
    previous: null,
  })
  const checkReceipt: RunnerCheckReceipt = {
    ...JSON.parse(checkEffect.receipt!).check,
    ...check,
    cwd: workspace,
    artifact,
    inputIdentity: artifact,
    exitCode: 0,
    timedOut: false,
    aborted: false,
    phasesComplete: true,
    processCleanup: {
      state: "settled",
      capability: "process-group",
      rootPID: process.pid,
    },
  }
  const replacementID = crypto.randomUUID()
  f.store.atomic((db) => {
    db.query("UPDATE runner_effects SET state='failed',payload=?,receipt=? WHERE id=?").run(
      JSON.stringify(reservationPayload),
      reservationReceipt,
      checkEffect.id,
    )
    db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'completed',?,?,1)").run(
      replacementID,
      planID,
      null,
      null,
      checkEffect.kind,
      JSON.stringify(replacementPayload),
      JSON.stringify({ check: checkReceipt }),
    )
  })
  return {
    reservationID: checkEffect.id,
    reservationPayload: JSON.stringify(reservationPayload),
    reservationReceipt,
    replacementID,
    checkReceipt,
  }
}

test("native cleanup follows verified integration, preserves dirty work, and retries explicitly", async () => {
  const f = fixture({ commit: true })
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await driveWithTaskSourceLandings(f)
  const artifact = f.store.plan(f.receipt.planID)!.artifact!
  const request = (key: string) => ({
    requestID: key,
    planID: f.receipt.planID,
    action: "integrated",
    artifact,
    targetBranch: "main",
    reason: "Reviewed task changes and combined checks",
  })
  await expect(f.runtime.command(request("not-merged"), "owner")).rejects.toThrow()
  git(f.root, ["merge", "--ff-only", artifact])
  const worktree = f.store.attempts(f.receipt.planID)[0]!.workspace
  writeFileSync(join(worktree, "unreviewed.txt"), "preserve this")
  await f.runtime.command(request("merged"), "owner")
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cleanup-blocked")
  expect(readFileSync(join(worktree, "unreviewed.txt"), "utf8")).toBe("preserve this")
  expect(f.store.nodes(f.receipt.planID).every((node) => node.state === "accepted")).toBe(true)
  rmSync(join(worktree, "unreviewed.txt"))
  await f.runtime.command(request("retry-cleanup"), "owner")
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.reason).toBeNull()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("integrated")
  expect(await f.host.worktrees()).toEqual([f.root])
  expect(git(f.root, ["show", "HEAD:b.txt"])).toBe("b")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
})

test("integrated cleanup removes historical graph candidates from their own settled receipts", async () => {
  const { f, plan } = await acceptedMergedFixture()
  const oldArtifact = plan.artifact!
  const oldCandidate = await addGraphCandidate(f, plan.id, oldArtifact, "combined-old-candidate")
  const oldWorkspace = oldCandidate.workspace

  const historicalCheck = {
    ...oldCandidate.receipt,
    id: "historical-procedure",
    command: "exit 7",
    cwd: oldWorkspace,
    artifact: oldArtifact,
    inputIdentity: oldArtifact,
    exitCode: 7,
    timedOut: false,
  }
  f.store.atomic((db) =>
    db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'completed',?,?,1)").run(
      crypto.randomUUID(),
      plan.id,
      null,
      null,
      "graph-verify:historical-procedure",
      JSON.stringify({
        workspace: oldWorkspace,
        artifact: oldArtifact,
        check: { id: "historical-procedure", command: "exit 7" },
      }),
      JSON.stringify({ check: historicalCheck }),
    ),
  )

  writeFileSync(join(f.root, "later.txt"), "newer integrated candidate\n")
  git(f.root, ["add", "later.txt"])
  git(f.root, ["commit", "-m", "Newer combined candidate"])
  const newerArtifact = git(f.root, ["rev-parse", "HEAD"])
  const newerCandidate = await addGraphCandidate(
    f,
    plan.id,
    newerArtifact,
    "combined-newer-candidate",
  )
  const newerWorkspace = newerCandidate.workspace
  f.store.atomic((db) => {
    db.query("UPDATE runner_plans SET artifact=? WHERE id=?").run(newerArtifact, plan.id)
  })

  const removed: string[] = []
  const nativeRemove = f.host.removeWorktree
  f.host.removeWorktree = async (workspace) => {
    removed.push(workspace)
    await nativeRemove(workspace)
  }
  const checksBefore = f.store
    .effects(plan.id)
    .filter((effect) => effect.kind.startsWith("graph-verify:"))
    .map((effect) => [effect.id, effect.state, effect.receipt])

  await f.runtime.command(
    {
      requestID: "integrate-newer-candidate",
      planID: plan.id,
      action: "integrated",
      artifact: newerArtifact,
      targetBranch: "main",
      reason: "Integrate the newer combined candidate",
    },
    "owner",
  )
  await f.runtime.tick()

  expect(f.store.plan(plan.id)).toMatchObject({ state: "integrated", reason: null })
  expect(removed).toContain(oldWorkspace)
  expect(removed).toContain(newerWorkspace)
  expect(await f.host.worktrees()).not.toContain(oldWorkspace)
  expect(await f.host.worktrees()).not.toContain(newerWorkspace)
  expect(
    f.store
      .effects(plan.id)
      .filter((effect) => effect.kind.startsWith("graph-verify:"))
      .map((effect) => [effect.id, effect.state, effect.receipt]),
  ).toEqual(checksBefore)
})

test("integrated cleanup removes a receipt-less graph reservation across verification generations", async () => {
  const { f, plan, integrate } = await acceptedMergedFixture()
  const artifact = plan.artifact!
  const candidate = await addGraphCandidate(
    f,
    plan.id,
    artifact,
    "combined-receiptless-reservation",
  )
  const reservation = addReceiptlessGraphCheckReplacement(f, plan.id, candidate.workspace, artifact)
  const replacement = f.store
    .effects(plan.id)
    .find((effect) => effect.id === reservation.replacementID)!
  const replacementPayload = JSON.parse(replacement.payload) as Record<string, unknown>
  replacementPayload.sourceGeneration = "later-repair-generation"
  replacementPayload.verificationEpoch = 284
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_effects SET payload=? WHERE id=?")
      .run(JSON.stringify(replacementPayload), replacement.id),
  )
  const checksBefore = f.store
    .effects(plan.id)
    .filter((effect) => effect.kind.startsWith("graph-verify:"))
    .map((effect) => [effect.id, effect.state, effect.payload, effect.receipt])
  const removed: string[] = []
  const nativeRemove = f.host.removeWorktree
  f.host.removeWorktree = async (workspace) => {
    removed.push(workspace)
    await nativeRemove(workspace)
  }

  await integrate("integrate-receiptless-graph-check")
  await f.runtime.tick()

  expect(f.store.plan(plan.id)).toMatchObject({ state: "integrated", reason: null })
  expect(removed).toContain(candidate.workspace)
  expect(await f.host.worktrees()).not.toContain(candidate.workspace)
  expect(
    f.store
      .effects(plan.id)
      .filter((effect) => effect.kind.startsWith("graph-verify:"))
      .map((effect) => [effect.id, effect.state, effect.payload, effect.receipt]),
  ).toEqual(checksBefore)
})

test("integrated cleanup preserves a receipt-less graph reservation while its process is running", async () => {
  const { f, plan, integrate } = await acceptedMergedFixture()
  const artifact = plan.artifact!
  const candidate = await addGraphCandidate(f, plan.id, artifact, "combined-live-reservation")
  const reservation = addReceiptlessGraphCheckReplacement(f, plan.id, candidate.workspace, artifact)
  const replacement = f.store
    .effects(plan.id)
    .find((entry) => entry.id === reservation.replacementID)!
  const replacementPayload = JSON.parse(replacement.payload) as Record<string, unknown>
  replacementPayload.sourceGeneration = "later-repair-generation"
  replacementPayload.verificationEpoch = 284
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_effects SET payload=? WHERE id=?")
      .run(JSON.stringify(replacementPayload), replacement.id),
  )
  const effect = f.store.effects(plan.id).find((entry) => entry.id === reservation.reservationID)!
  const identity = { effectID: effect.id, payload: effect.payload }
  const activityIdentity = fingerprint(identity)
  let finishActivity!: (receipt: RunnerCheckReceipt) => void
  const pendingActivity = new Promise<RunnerCheckReceipt>((resolve) => {
    finishActivity = resolve
  })
  const activity = startVerificationActivity<RunnerCheckReceipt>({
    databasePath: f.store.repository.path,
    key: verificationActivityKey(f.store.repository.path, effect.id),
    identity: activityIdentity,
    owner: f.runtime.owner,
    metadata: {
      kind: "effect",
      projectDirectory: f.root,
      planID: plan.id,
      effectID: effect.id,
    },
    run: () => pendingActivity,
    summarize: summarizeCheckReceipt,
  }).activity

  try {
    await integrate("integrate-live-receiptless-graph-check")
    await f.runtime.tick()
    expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
    expect(f.store.plan(plan.id)?.reason).toContain("process is not settled")
    expect(await f.host.worktrees()).toContain(candidate.workspace)

    finishActivity!(reservation.checkReceipt)
    await activity.settled
    await f.runtime.tick()

    expect(f.store.plan(plan.id)).toMatchObject({ state: "integrated", reason: null })
    expect(await f.host.worktrees()).not.toContain(candidate.workspace)
  } finally {
    finishActivity(reservation.checkReceipt)
    await activity.settled
    forgetVerificationActivity(activity.key, activityIdentity)
  }
})

test("integrated cleanup preserves uncertain superseded process evidence despite a settled replacement", async () => {
  const { f, plan, integrate } = await acceptedMergedFixture()
  const artifact = plan.artifact!
  const candidate = await addGraphCandidate(f, plan.id, artifact, "combined-uncertain-reservation")
  const reservation = addReceiptlessGraphCheckReplacement(f, plan.id, candidate.workspace, artifact)
  const unsettledCheck = {
    ...reservation.checkReceipt,
    processCleanup: {
      state: "uncertain",
      capability: "process-group",
      rootPID: 28401,
    },
  }
  const supersededReceipt = JSON.stringify({
    superseded: true,
    reason: "No settled receipt was recorded; the check re-runs",
    previous: { result: { check: unsettledCheck } },
  })
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_effects SET receipt=? WHERE id=?")
      .run(supersededReceipt, reservation.reservationID),
  )

  await integrate("integrate-uncertain-receiptless-graph-check")
  await f.runtime.tick()

  expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
  expect(f.store.plan(plan.id)?.reason).toContain("not conclusively complete")
  expect(await f.host.worktrees()).toContain(candidate.workspace)
  expect(
    f.store.effects(plan.id).find((effect) => effect.id === reservation.reservationID)?.receipt,
  ).toBe(supersededReceipt)
})

test("integrated cleanup visibly preserves a receipt-less graph reservation with wrong check lineage", async () => {
  const { f, plan, integrate } = await acceptedMergedFixture()
  const artifact = plan.artifact!
  const candidate = await addGraphCandidate(f, plan.id, artifact, "combined-wrong-lineage")
  const reservation = addReceiptlessGraphCheckReplacement(f, plan.id, candidate.workspace, artifact)
  const replacement = f.store
    .effects(plan.id)
    .find((effect) => effect.id === reservation.replacementID)!
  f.store.atomic((db) => {
    const payload = JSON.parse(replacement.payload) as { check: { command: string } }
    payload.check.command = "different combined check"
    db.query("UPDATE runner_effects SET payload=? WHERE id=?").run(
      JSON.stringify(payload),
      replacement.id,
    )
  })

  await integrate("integrate-mismatched-check-graph-lineage")
  await f.runtime.tick()

  expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
  expect(f.store.plan(plan.id)?.reason).toContain("no matching settled replacement")
  expect(await f.host.worktrees()).toContain(candidate.workspace)
  expect(
    f.store.effects(plan.id).find((effect) => effect.id === reservation.reservationID),
  ).toMatchObject({ state: "failed", receipt: reservation.reservationReceipt })
})

test("historical graph cleanup retries after nested process settlement without rewriting check evidence", async () => {
  const { f, plan, integrate } = await acceptedMergedFixture()
  const artifact = plan.artifact!
  const candidate = await addGraphCandidate(f, plan.id, artifact, "combined-settlement-retry")
  const workspace = candidate.workspace
  const uncertainCheck = {
    ...candidate.receipt,
    id: "historical-unsettled",
    command: "exit 13",
    cwd: workspace,
    artifact,
    inputIdentity: artifact,
    exitCode: 13,
    aborted: true,
    processCleanup: {
      state: "uncertain",
      capability: "process-group",
      rootPID: 123,
    },
  }
  const uncertainEffectID = crypto.randomUUID()
  f.store.atomic((db) =>
    db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'uncertain',?,?,1)").run(
      uncertainEffectID,
      plan.id,
      null,
      null,
      "graph-verify:historical-unsettled",
      JSON.stringify({
        workspace,
        artifact,
        check: { id: "historical-unsettled", command: "exit 13" },
      }),
      JSON.stringify({
        schema: "lazers-uncertain-effect/v1",
        error: "Check journaling was interrupted",
        result: { check: uncertainCheck },
      }),
    ),
  )
  const integrateCurrent = (requestID: string) =>
    f.runtime.command(
      {
        requestID,
        planID: plan.id,
        action: "integrated",
        artifact,
        targetBranch: "main",
        reason: "Retry cleanup after process settlement",
      },
      "owner",
    )

  await integrate("integrate-before-settlement")
  await f.runtime.tick()
  expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
  expect(f.store.plan(plan.id)?.reason).toContain("not conclusively complete")
  expect(await f.host.worktrees()).toContain(workspace)

  const recoveredCheck = { ...uncertainCheck, processCleanup: { ...uncertainCheck.processCleanup } }
  recoveredCheck.processCleanup.state = "terminated"
  const settledEffectReceipt = JSON.stringify({
    schema: "lazers-uncertain-effect/v1",
    error: "Check journaling was interrupted",
    result: { check: recoveredCheck },
  })
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_effects SET receipt=? WHERE id=?")
      .run(settledEffectReceipt, uncertainEffectID),
  )
  await integrateCurrent("integrate-after-settlement")
  await f.runtime.tick()

  const settledEffect = f.store.effects(plan.id).find((effect) => effect.id === uncertainEffectID)!
  expect(f.store.plan(plan.id)).toMatchObject({ state: "integrated", reason: null })
  expect(await f.host.worktrees()).not.toContain(workspace)
  expect(settledEffect.state).toBe("uncertain")
  expect(settledEffect.receipt).toBe(settledEffectReceipt)
  expect(JSON.parse(settledEffect.receipt!).result.check).toMatchObject({
    exitCode: 13,
    aborted: true,
    processCleanup: { state: "terminated" },
  })
})

test("scheduler retires an integrated worker without any idle report", async () => {
  const f = fixture({ commit: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await drive(f.runtime)
  const plan = f.store.plan(f.receipt.planID)!
  const attempt = f.store.attempts(plan.id)[0]!
  const worker = f.sessions.get(attempt.session_id)!

  git(f.root, ["merge", "--ff-only", plan.artifact!])
  const retired: string[] = []
  f.host.retireIntegratedWorker = async (input) => {
    expect(input).toMatchObject({
      attemptID: attempt.id,
      workspace: attempt.workspace,
      sessionID: attempt.session_id,
    })
    retired.push(input.sessionID)
    worker.archived = true
  }
  await f.runtime.command(
    {
      requestID: "record-integration-without-historical-idle",
      planID: plan.id,
      action: "integrated",
      artifact: plan.artifact!,
      targetBranch: "main",
      reason: "Merged reviewed artifact",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(retired).toEqual([attempt.session_id, attempt.session_id])
  expect(f.store.plan(plan.id)).toMatchObject({ state: "integrated", reason: null })
  expect(await f.host.worktrees()).not.toContain(attempt.workspace)
})

// Eight command-and-tick rounds over a real git repository: about 5 s on a busy machine.
test("cleanup preserves live worker activity but accepts authoritative worker absence", async () => {
  const f = fixture({ commit: true })
  await runPlan(f)
  await driveWithTaskSourceLandings(f)
  const plan = f.store.plan(f.receipt.planID)!
  const artifact = plan.artifact!
  const attempt = f.store.attempts(plan.id)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const worktree = attempt.workspace
  const checksBefore = f.store
    .effects(plan.id)
    .filter(
      (effect) => effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:"),
    )
    .map((effect) => [effect.id, effect.state, effect.receipt])
  const workerAdmissionsBefore = f.events.filter((event) => /^(create|prompt):/.test(event)).length
  git(f.root, ["merge", "--ff-only", artifact])

  const retryCleanup = async (requestID: string) => {
    await f.runtime.command(
      {
        requestID,
        planID: plan.id,
        action: "integrated",
        artifact,
        targetBranch: "main",
        reason: "Retry cleanup after the worker was observed idle",
      },
      "owner",
    )
    await f.runtime.tick()
    expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
    expect(await f.host.worktrees()).toContain(worktree)
  }

  worker.busy = true
  await retryCleanup("cleanup-busy-worker")
  worker.busy = false
  worker.pendingInput = true
  await retryCleanup("cleanup-pending-input")
  worker.pendingInput = false
  worker.pendingPermissions = 1
  await retryCleanup("cleanup-pending-permission")
  worker.pendingPermissions = 0
  worker.pendingForms = 1
  await retryCleanup("cleanup-pending-form")
  worker.pendingForms = 0
  worker.observationUnstable = true
  await retryCleanup("cleanup-unstable-observation")
  worker.observationUnstable = false
  worker.runningShells = 1
  await retryCleanup("cleanup-running-shell")
  worker.runningShells = 0
  worker.activeChildren = 1
  await retryCleanup("cleanup-active-child")
  worker.activeChildren = 0
  delete worker.pendingInput
  delete worker.pendingPermissions
  delete worker.pendingForms
  // RunnerHost null means the native adapter proved this session is absent;
  // it is not an unavailable observation.
  f.sessions.delete(attempt.session_id)
  await f.runtime.command(
    {
      requestID: "cleanup-after-worker-termination",
      planID: plan.id,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "The merged worker has terminated and its native session is absent",
    },
    "owner",
  )
  await f.runtime.tick()

  expect(f.store.plan(plan.id)?.state).toBe("integrated")
  expect(await f.host.worktrees()).not.toContain(worktree)
  expect(
    f.store
      .effects(plan.id)
      .filter(
        (effect) => effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:"),
      )
      .map((effect) => [effect.id, effect.state, effect.receipt]),
  ).toEqual(checksBefore)
  expect(f.events.filter((event) => /^(create|prompt):/.test(event)).length).toBe(
    workerAdmissionsBefore,
  )
})

test("location retirement uses active project ownership outside the display plan listing", async () => {
  const f = fixture()
  const plan = f.store.plan(f.receipt.planID)!
  const workspace = join(`${f.root}.worktrees`, "active-owner-checkout")
  const attemptID = crypto.randomUUID()
  f.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_attempts(
           id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,
           policy,state,started_at,token_count,tool_count,retry_count,cost
         ) VALUES(?,?,?,?,?,?,?,?,NULL,?,'running',?,NULL,0,0,NULL)`,
      )
      .run(
        attemptID,
        plan.id,
        f.tasks[0]!.id,
        1,
        "ses_cleanup_active_owner",
        "msg_cleanup_active_owner",
        workspace,
        f.input.baseCommit,
        JSON.stringify({}),
        Date.now(),
      ),
  )
  expect(f.store.activeProjectAttempts().map((attempt) => attempt.id)).toContain(attemptID)

  const displayedPlans = spyOn(f.store, "eachPlan").mockImplementation(
    () => [][Symbol.iterator]() as never,
  )
  const originalWorktrees = f.host.worktrees
  let inventoryReads = 0
  let retireCalls = 0
  f.host.worktrees = async () => {
    inventoryReads++
    return originalWorktrees()
  }
  f.host.retireWorktreeLocation = async () => {
    retireCalls++
    return "not-loaded"
  }
  const internals = f.runtime as unknown as {
    worktreeCleanup: {
      retireCleanedWorktreeLocation(
        plan: NonNullable<ReturnType<typeof f.store.plan>>,
        workspace: string,
        cleanupCurrent: () => boolean,
      ): Promise<string>
    }
  }

  await expect(
    internals.worktreeCleanup.retireCleanedWorktreeLocation(plan, workspace, () => true),
  ).resolves.toBe("reserved-by-other-attempt")
  expect(displayedPlans).not.toHaveBeenCalled()
  expect(inventoryReads).toBe(0)
  expect(retireCalls).toBe(0)
})

test("cleanup audit reports the first sampled worker blocker without exposing observed identity details", async () => {
  const { f, planID, attempt, worker } = await cleanupBlockedFixture()
  const valid = structuredClone(worker)
  valid.busy = false
  const sessionCalls: { id: string; options?: { messages?: boolean } }[] = []
  const originalSession = f.host.session
  f.host.session = async (id, options) => {
    sessionCalls.push({ id, options })
    return originalSession(id, options)
  }
  type Diagnostic = {
    binding: {
      projectID: string
      planID: string
      attemptID: string
      sessionID: string
      workspace: string
      assignedMessageID: string
    }
    firstBlocker: { stage: string; code: string } | null
    planVersion: number
    sampledAt: number
    stages: Array<{ stage: string; status: string; code?: string }>
  }
  const auditedWorker = (result: unknown) => {
    const diagnostics = (result as { cleanupDiagnostics?: { workers?: Diagnostic[] } })
      .cleanupDiagnostics
    expect(diagnostics?.workers).toHaveLength(1)
    return diagnostics!.workers![0]!
  }
  const audit = (requestID: string) =>
    f.runtime.command(
      {
        requestID,
        planID,
        action: "audit",
      },
      "observer",
    )
  const sample = async (
    requestID: string,
    change?: (session: HostSession) => void,
  ): Promise<Diagnostic> => {
    const session = structuredClone(valid)
    change?.(session)
    f.sessions.set(attempt.session_id, session)
    return auditedWorker(await audit(requestID))
  }
  const cases: Array<{
    name: string
    stage: string
    code: string
    change?: (session: HostSession) => void
    absent?: boolean
    unavailable?: boolean
  }> = [
    { name: "read failure", stage: "session-read", code: "read-unavailable", unavailable: true },
    {
      name: "session identity",
      stage: "session-id",
      code: "session-id-mismatch",
      change: (session) => (session.id = "foreign-session-detail"),
    },
    {
      name: "project identity",
      stage: "project-id",
      code: "project-id-mismatch",
      change: (session) => (session.projectID = "foreign-project-detail"),
    },
    {
      name: "directory identity",
      stage: "directory",
      code: "directory-mismatch",
      change: (session) => (session.directory = "/foreign/workspace-detail"),
    },
    {
      name: "agent identity",
      stage: "agent",
      code: "agent-mismatch",
      change: (session) => (session.agent = "foreign-agent-detail"),
    },
    {
      name: "attempt identity",
      stage: "attempt-id",
      code: "attempt-id-mismatch",
      change: (session) =>
        (session.metadata = { ...session.metadata, lazersAttemptID: "foreign-attempt-detail" }),
    },
    {
      name: "foreground activity",
      stage: "foreground",
      code: "foreground-busy",
      change: (session) => (session.busy = true),
    },
    {
      name: "pending input",
      stage: "pending-input",
      code: "pending-input",
      change: (session) => (session.pendingInput = true),
    },
    {
      name: "unstable observation",
      stage: "observation-stability",
      code: "observation-unstable",
      change: (session) => (session.observationUnstable = true),
    },
    {
      name: "pending permission",
      stage: "pending-permissions",
      code: "pending-permissions",
      change: (session) => (session.pendingPermissions = 1),
    },
    {
      name: "pending form",
      stage: "pending-forms",
      code: "pending-forms",
      change: (session) => (session.pendingForms = 1),
    },
    {
      name: "running shell",
      stage: "running-shells",
      code: "running-shells",
      change: (session) => (session.runningShells = 1),
    },
    {
      name: "active child session",
      stage: "active-children",
      code: "active-children",
      change: (session) => (session.activeChildren = 1),
    },
  ]

  for (const [index, item] of cases.entries()) {
    if (item.absent) f.sessions.delete(attempt.session_id)
    else {
      const session = structuredClone(valid)
      item.change?.(session)
      f.sessions.set(attempt.session_id, session)
    }
    const read = f.host.session
    if (item.unavailable) {
      f.host.session = async () => {
        throw new Error("Authorization: Bearer private-secret")
      }
    }
    const diagnostic = auditedWorker(
      await audit(`cleanup-audit-stage-${index}-${item.name.replaceAll(" ", "-")}`),
    )
    f.host.session = read
    expect(diagnostic.firstBlocker).toEqual({ stage: item.stage, code: item.code })
    const blockedIndex = diagnostic.stages.findIndex((stage) => stage.stage === item.stage)
    expect(diagnostic.stages[blockedIndex]).toMatchObject({ status: "blocked", code: item.code })
    expect(
      diagnostic.stages.slice(0, blockedIndex).every((stage) => stage.status === "passed"),
    ).toBe(true)
    expect(
      diagnostic.stages.slice(blockedIndex + 1).every((stage) => stage.status === "not-evaluated"),
    ).toBe(true)
    expect(diagnostic.binding).toEqual({
      projectID: "project",
      planID,
      attemptID: attempt.id,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      assignedMessageID: attempt.message_id,
    })
    expect(diagnostic.planVersion).toBe(f.store.plan(planID)!.version)
    expect(diagnostic.sampledAt).toBeGreaterThan(0)
    const serialized = JSON.stringify(diagnostic)
    expect(serialized).not.toContain("foreign-session-detail")
    expect(serialized).not.toContain("foreign-project-detail")
    expect(serialized).not.toContain("foreign/workspace-detail")
    expect(serialized).not.toContain("foreign-agent-detail")
    expect(serialized).not.toContain("foreign-attempt-detail")
    expect(serialized).not.toContain("private-secret")
    if (item.absent) f.sessions.set(attempt.session_id, structuredClone(valid))
  }

  for (const state of ["completed", "interrupted"] as const) {
    const diagnostic = await sample(`cleanup-audit-zero-${state}`, (session) => {
      session.outcome = state === "completed" ? "succeeded" : "interrupted"
      session.turn = { inputID: attempt.message_id, state }
    })
    expect(diagnostic.firstBlocker).toBeNull()
    expect(diagnostic.stages.every((stage) => stage.status === "passed")).toBe(true)
  }
  const auditor = await sample("cleanup-audit-current-auditor", (session) => {
    session.agent = "auditor"
  })
  expect(auditor.firstBlocker).toBeNull()
  f.sessions.delete(attempt.session_id)
  const absent = auditedWorker(await audit("cleanup-audit-authoritative-absence"))
  expect(absent.firstBlocker).toBeNull()
  expect(absent.stages[0]).toEqual({
    stage: "session-read",
    status: "passed",
    code: "session-absent",
  })
  expect(absent.stages.slice(1).every((stage) => stage.status === "not-evaluated")).toBe(true)
  f.sessions.set(attempt.session_id, structuredClone(valid))
  expect(
    sessionCalls.every((call) => call.id === attempt.session_id && call.options?.messages === true),
  ).toBe(true)
})

test("cleanup audit is neutral, receipt-safe, and later requests sample fresh observations", async () => {
  const { f, planID, attempt, worker } = await cleanupBlockedFixture()
  const planBefore = f.store.plan(planID)!
  const detailBefore = f.store.detail(planID)
  const notificationsBefore = f.notifications.length
  const eventsBefore = [...f.events]
  const sessionCalls: { id: string; options?: { messages?: boolean } }[] = []
  let worktreeReads = 0
  let removals = 0
  const originalSession = f.host.session
  const originalWorktrees = f.host.worktrees
  const originalRemove = f.host.removeWorktree
  f.host.session = async (id, options) => {
    sessionCalls.push({ id, options })
    return originalSession(id, options)
  }
  f.host.worktrees = async () => {
    worktreeReads++
    return originalWorktrees()
  }
  f.host.removeWorktree = async (workspace) => {
    removals++
    return originalRemove(workspace)
  }
  const input = {
    requestID: "cleanup-audit-replay",
    planID,
    action: "audit" as const,
  }
  const first = await f.runtime.command(input, "observer")
  const firstDiagnostic = (
    first as {
      cleanupDiagnostics: { diagnosticOnly: true; workers: Array<{ firstBlocker: unknown }> }
    }
  ).cleanupDiagnostics
  expect(firstDiagnostic.diagnosticOnly).toBe(true)
  expect(firstDiagnostic.workers[0]?.firstBlocker).toEqual({
    stage: "foreground",
    code: "foreground-busy",
  })
  const detailAfter = f.store.detail(planID)
  expect(detailAfter.plan).toEqual(detailBefore.plan)
  expect(detailAfter.nodes).toEqual(detailBefore.nodes)
  expect(detailAfter.attempts).toEqual(detailBefore.attempts)
  expect(detailAfter.effects).toEqual(detailBefore.effects)
  expect(detailAfter.adoptions).toEqual(detailBefore.adoptions)
  expect(detailAfter.adoptionChecks).toEqual(detailBefore.adoptionChecks)
  expect(detailAfter.adoptionEvidence).toEqual(detailBefore.adoptionEvidence)
  expect(detailAfter.evidence).toEqual(detailBefore.evidence)
  expect(detailAfter.activity).toEqual(detailBefore.activity)
  expect(detailAfter.delivery).toEqual(detailBefore.delivery)
  expect(f.store.plan(planID)).toEqual(planBefore)
  expect(f.notifications).toHaveLength(notificationsBefore)
  expect(f.events).toEqual(eventsBefore)
  expect(sessionCalls).toEqual([{ id: attempt.session_id, options: { messages: true } }])
  expect(worktreeReads).toBe(0)
  expect(removals).toBe(0)

  const idle = structuredClone(worker)
  idle.busy = false
  f.sessions.set(attempt.session_id, idle)
  expect(await f.runtime.command(input, "observer")).toEqual(first)
  expect(sessionCalls).toHaveLength(1)
  const fresh = await f.runtime.command({ ...input, requestID: "cleanup-audit-fresh" }, "observer")
  expect(
    (fresh as { cleanupDiagnostics: { workers: Array<{ firstBlocker: unknown }> } })
      .cleanupDiagnostics.workers[0]?.firstBlocker,
  ).toBeNull()
  expect(sessionCalls).toHaveLength(2)
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cleanup-blocked")
  expect(worktreeReads).toBe(0)
  expect(removals).toBe(0)
  expect(f.notifications).toHaveLength(notificationsBefore)
})

test("cleanup audit publication rejects a concurrent plan-version change", async () => {
  const { f, planID, attempt, artifact } = await cleanupBlockedFixture()
  const version = f.store.plan(planID)!.version
  let started!: () => void
  let release!: () => void
  const sampleStarted = new Promise<void>((resolve) => (started = resolve))
  const sampleGate = new Promise<void>((resolve) => (release = resolve))
  const originalSession = f.host.session
  let sampled = false
  f.host.session = async (id, options) => {
    if (!sampled) {
      sampled = true
      started()
      await sampleGate
    }
    return originalSession(id, options)
  }
  const auditInput = {
    requestID: "cleanup-audit-stale",
    planID,
    action: "audit" as const,
  }
  const pendingAudit = f.runtime.command(auditInput, "owner")
  await sampleStarted
  await f.runtime.command(
    {
      requestID: "cleanup-audit-race-integrate",
      planID,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Advance the cleanup plan while diagnostics are being sampled",
    },
    "owner",
  )
  release()
  // The plan moved between the runtime's diagnostic read and its transaction: the runtime
  // re-reads the plan, resamples and applies the audit against the new state.
  const audited = await pendingAudit
  expect(audited).toMatchObject({ status: "audited", version: version + 1 })
  expect(f.store.plan(planID)?.state).toBe("cleaning")
  expect(
    f.store.priorCommand("cleanup-audit-stale", { command: auditInput, caller: "owner" }),
  ).toEqual(audited)
  expect(f.store.effects(planID).some((effect) => effect.kind === "worktree-remove")).toBe(true)
  expect(f.store.attempts(planID).some((item) => item.id === attempt.id)).toBe(true)
})

test("a successful cleanup diagnostic cannot bypass changed live worker activity", async () => {
  const { f, planID, attempt, worker, artifact, workspace } = await cleanupBlockedFixture()
  const idle = structuredClone(worker)
  idle.busy = false
  f.sessions.set(attempt.session_id, idle)
  const version = f.store.plan(planID)!.version
  const diagnostic = await f.runtime.command(
    {
      requestID: "cleanup-audit-clear-before-lineage-change",
      planID,
      action: "audit",
    },
    "observer",
  )
  expect(
    (diagnostic as { cleanupDiagnostics: { workers: Array<{ firstBlocker: unknown }> } })
      .cleanupDiagnostics.workers[0]?.firstBlocker,
  ).toBeNull()
  const changed = structuredClone(idle)
  changed.runningShells = 1
  f.sessions.set(attempt.session_id, changed)
  let removals = 0
  const originalRemove = f.host.removeWorktree
  f.host.removeWorktree = async (directory) => {
    removals++
    return originalRemove(directory)
  }
  await f.runtime.command(
    {
      requestID: "cleanup-retry-after-lineage-change",
      planID,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Retry cleanup using a fresh native observation",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cleanup-blocked")
  expect(f.store.plan(planID)?.reason).toContain("running shell")
  expect(existsSync(workspace)).toBe(true)
  expect(removals).toBe(0)
})

test("explicit Luna Max worker selection preserves the stronger Architect model and reaches acceptance", async () => {
  const model = { providerID: "openai", id: "gpt-6-luna", variant: "max" }
  const f = fixture({ shared: true, workerModel: model })
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await driveWithTaskSourceLandings(f)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(JSON.parse(f.store.plan(f.receipt.planID)!.model!)).toEqual(model)
  for (const attempt of f.store.attempts(f.receipt.planID)) {
    expect(f.sessions.get(attempt.session_id)!.model).toEqual(model)
    expect(JSON.parse(attempt.policy).model).toEqual(model)
  }
  expect(f.sessions.get("owner")!.model!.id).toBe("subscription")
})

test("cleanup preserves clean worktrees with commits outside the reviewed integration", async () => {
  const f = fixture({ commit: true })
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await driveWithTaskSourceLandings(f)
  const artifact = f.store.plan(f.receipt.planID)!.artifact!
  git(f.root, ["merge", "--ff-only", artifact])
  const worktree = f.store.attempts(f.receipt.planID)[0]!.workspace
  writeFileSync(join(worktree, "unmerged.txt"), "retain this commit")
  git(worktree, ["add", "unmerged.txt"])
  git(worktree, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Unreviewed follow-up",
  ])
  const unmerged = git(worktree, ["rev-parse", "HEAD"])
  expect(git(worktree, ["status", "--porcelain"])).toBe("")
  await f.runtime.command(
    {
      requestID: "integrate",
      planID: f.receipt.planID,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Reviewed accepted artifact",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cleanup-blocked")
  expect(f.store.plan(f.receipt.planID)!.reason).toContain("unmerged commits")
  expect(git(worktree, ["rev-parse", "HEAD"])).toBe(unmerged)
  expect(await f.host.worktrees()).toContain(worktree)
})

test("cleanup preserves a dirty owned worktree even after its accepted commit was merged", async () => {
  const f = fixture({ independent: true, commit: true })
  await runPlan(f)
  await drive(f.runtime)
  const artifact = f.store.plan(f.receipt.planID)!.artifact!
  git(f.root, ["merge", "--ff-only", artifact])
  const worktree = f.store.attempts(f.receipt.planID)[0]!.workspace
  writeFileSync(join(worktree, "a.txt"), "unreviewed dirty edit")

  await f.runtime.command(
    {
      requestID: "integrate-dirty",
      planID: f.receipt.planID,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Reviewed only the accepted combined artifact",
    },
    "owner",
  )
  await f.runtime.tick()

  expect(f.store.plan(f.receipt.planID)!.state).toBe("cleanup-blocked")
  expect(f.store.plan(f.receipt.planID)!.reason).toContain("worktree is dirty")
  expect(git(worktree, ["status", "--porcelain"])).toContain("a.txt")
  expect(await f.host.worktrees()).toContain(worktree)
})

test("cleanup of a merged, clean, idle worktree needs no idle report and survives a restart", async () => {
  const { f, plan, attempt, integrate } = await acceptedMergedFixture()
  // No hook ever reported for this worker; a restarted scheduler must not wait for one.
  await integrate("integrate-after-restart")
  const reopened = reopenRuntime(f)
  await reopened.runtime.tick()
  expect(reopened.store.plan(plan.id)).toMatchObject({ state: "integrated", reason: null })
  expect(await f.host.worktrees()).not.toContain(attempt.workspace)
})

test("a running shell holds cleanup with a visible reason that clears once the shell ends", async () => {
  const clock = { offset: 0 }
  const { f, plan, attempt, worker, integrate } = await acceptedMergedFixture({ clock })
  worker.runningShells = 1
  await integrate("integrate-with-shell")
  await f.runtime.tick()
  expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
  expect(f.store.plan(plan.id)?.reason).toContain("1 running shell(s)")
  expect(await f.host.worktrees()).toContain(attempt.workspace)

  // Unchanged live activity: no new hold record on later ticks.
  const holds = countTransitions(f, plan.id, "CLEANUP_BLOCKED")
  clock.offset += 6_000
  await f.runtime.tick()
  expect(countTransitions(f, plan.id, "CLEANUP_BLOCKED")).toBe(holds)

  worker.runningShells = 0
  clock.offset += 6_000
  await f.runtime.tick()
  expect(f.store.plan(plan.id)).toMatchObject({ state: "integrated", reason: null })
  expect(await f.host.worktrees()).not.toContain(attempt.workspace)
})

test("an unchanged cleanup blocker records no further CLEANUP_BLOCKED transition or history", async () => {
  const clock = { offset: 0 }
  const { f, plan, attempt, integrate } = await acceptedMergedFixture({ clock })
  writeFileSync(join(attempt.workspace, "uncommitted.txt"), "preserve this")
  await integrate("integrate-dirty")
  await f.runtime.tick()
  expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
  expect(countTransitions(f, plan.id, "CLEANUP_BLOCKED")).toBe(1)
  const removal = () =>
    f.store.effects(plan.id).find((effect) => effect.kind === "worktree-remove")!
  // Observations are child rows; the document only counts them and never grows.
  const history = () => {
    const rows = f.store.atomic((db) =>
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM runner_effect_observations WHERE effect_id=?",
        )
        .get(removal().id),
    )!.n
    expect(JSON.parse(removal().receipt!).observationCount).toBe(rows)
    return rows
  }
  const first = history()
  for (let n = 0; n < 5; n++) {
    clock.offset += 61_000
    await f.runtime.tick()
  }
  expect(countTransitions(f, plan.id, "CLEANUP_BLOCKED")).toBe(1)
  expect(history()).toBe(first)
  // A changed fact (the dirty file is gone) completes the cleanup.
  rmSync(join(attempt.workspace, "uncommitted.txt"))
  clock.offset += 61_000
  await f.runtime.tick()
  expect(f.store.plan(plan.id)?.state).toBe("integrated")
})

test("a cancelled plan's clean worktree is removed once its worker is idle", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  expect(await f.host.worktrees()).toContain(attempt.workspace)
  // The cancelled worker never committed; discard its untracked scratch output.
  git(attempt.workspace, ["clean", "-fd"])
  git(attempt.workspace, ["checkout", "--", "."])
  worker.runningShells = 1
  await f.runtime.command(
    {
      requestID: "cancel-with-shell",
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  // The live shell is a visible wait; the worktree is untouched.
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
  expect(await f.host.worktrees()).toContain(attempt.workspace)
  worker.runningShells = 0
  await f.runtime.tick()
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  expect(await f.host.worktrees()).not.toContain(attempt.workspace)
  expect(
    f.store.effects(f.receipt.planID).find((effect) => effect.kind === "worktree-remove")?.state,
  ).toBe("completed")
})

test("a cancelled plan preserves unmerged commits and reports them", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  writeFileSync(join(attempt.workspace, "partial.txt"), "unmerged work")
  git(attempt.workspace, ["add", "-A"])
  git(attempt.workspace, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "partial work",
  ])
  const head = git(attempt.workspace, ["rev-parse", "HEAD"])
  await f.runtime.command(
    {
      requestID: "cancel-with-commits",
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  expect(f.store.plan(f.receipt.planID)?.reason).toContain("unmerged commits")
  expect(git(attempt.workspace, ["rev-parse", "HEAD"])).toBe(head)
  expect(await f.host.worktrees()).toContain(attempt.workspace)
})
