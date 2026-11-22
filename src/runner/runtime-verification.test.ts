import { expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "./artifacts.ts"
import type { RunnerCheckReceipt } from "./artifacts.ts"

import {
  forgetVerificationActivity,
  startVerificationActivity,
  verificationActivitiesForDatabase,
  verificationActivityKey,
} from "./verification-activities.ts"
import { settleVerification } from "../../test/runner/verification-driver.ts"
import {
  acceptPlan,
  attemptCheck,
  authoredVerifyEffect,
  cleanup,
  drive,
  driveWithTaskSourceLandings,
  expectNoSkillBody,
  fixture,
  includeArtifact,
  prepareInterruptedCombinedCheck,
  recordPlanIntegration,
  registeredPlanCommand,
  reopenRuntime,
  retainedSourceFixture,
  runPlan,
  seedLegacySkillBody,
  skillBodyCanary,
  waitForPath,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("real Git worktrees execute a dependency graph, verify combined content and retain origin", async () => {
  const f = fixture()
  expect(f.store.submit(f.input, "owner")).toEqual(f.receipt)
  expect(() => f.store.submit({ ...f.input, objective: "changed" }, "owner")).toThrow(
    "identity conflict",
  )
  expect(() => f.store.submit({ ...f.input, requestID: "second-plan" }, "owner")).toThrow("UNIQUE")
  expect(f.store.execution(f.tasks[1]!.id)?.waitingOn).toEqual([f.tasks[0]!.id])
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await driveWithTaskSourceLandings(f)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.nodes(f.receipt.planID).map((n) => n.state)).toEqual(["accepted", "accepted"])
  expect(f.events.filter((e) => e.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((e) => e.startsWith("prompt:"))).toHaveLength(2)
  expect(f.store.effects(f.receipt.planID).every((e) => e.state === "completed")).toBe(true)
  const plan = f.store.plan(f.receipt.planID)!
  expect(git(f.root, ["show", `${plan.artifact}:a.txt`])).toBe("a")
  expect(git(f.root, ["show", `${plan.artifact}:b.txt`])).toBe("b")
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(
    f.store.latestTransition<{ head: string }>(
      f.receipt.planID,
      f.tasks[0]!.id,
      "TASK_INTEGRATION_RECORDED",
    )!.head,
  )
  expect(readFileSync(join(f.root, "dirty-sentinel.txt"), "utf8")).toBe("preserve me")
  expect(
    f.inbox
      .get("owner")
      ?.some(
        (entry) =>
          entry.metadata &&
          "lazersPlanID" in entry.metadata &&
          entry.metadata.lazersPlanID === plan.id,
      ),
  ).toBe(true)
  const workers = f.store.attempts(plan.id)
  expect(workers[1]!.base_commit).toBe(workers[0]!.artifact!)
  expect(JSON.parse(workers[0]!.policy).packet).toEqual({
    recipe: "task-tool/1",
    taskID: workers[0]!.task_id,
    tool: "lz-get-task",
  })
  await drive(f.runtime)
  expect(f.events.filter((e) => e.startsWith("create:"))).toHaveLength(2)
})

test.each([false, true])(
  "authorized formatting is committed before verification (shared=%s)",
  async (shared) => {
    const f = fixture({
      shared,
      taskFiles: [{ name: "a", path: "src/result.ts" }],
      checkCommand: "bun fmt --check src/result.ts",
      combinedCheckCommand: "test -f src/result.ts",
    })
    await runPlan(f)
    await drive(f.runtime, 18)
    const plan = f.store.plan(f.receipt.planID)!
    const attempt = f.store.attempts(plan.id)[0]!
    expect(plan.state).toBe("accepted")
    expect(f.store.attempts(plan.id)).toHaveLength(1)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
    const committed = spawnSync("git", ["show", `${attempt.artifact}:src/result.ts`], {
      cwd: f.root,
      encoding: "utf8",
    }).stdout
    expect(committed).toBe(readFileSync(join(attempt.workspace, "src/result.ts"), "utf8"))
    expect(committed).not.toBe("a")
    expect(attempt.artifact).toBeTruthy()
    const preparation = f.store.effects(plan.id).find((effect) => effect.kind === "mechanical-fix")!
    expect(preparation.state).toBe("completed")
    const preparedReceipt = (JSON.parse(preparation.receipt!) as { check: RunnerCheckReceipt })
      .check
    expect(preparedReceipt.preparation?.inputFingerprint).not.toBe(
      preparedReceipt.preparation?.resultingFingerprint,
    )
    const verified = attemptCheck(f, f.tasks[0]!.id, attempt.id)
    expect(verified.artifact).toBe(attempt.artifact!)
    expect(verified.inputIdentity).toBe(attempt.artifact!)
    expect(verified.exitCode).toBe(0)
  },
)

// No per-test timeout literal: this runs `bun fmt --check` repeatedly and takes about 10 s alone
// (9.5-10.7 s over three runs, 11.6 s with three other test files running). A 15 s literal timed
// out under gate load, and the still-running body then hit the torn-down fixture database.
test("a committed shared-checkout correction gets fresh mechanical preparation", async () => {
  const f = fixture({
    shared: true,
    missingEvidence: true,
    taskFiles: [{ name: "a", path: "src/result.ts" }],
    checkCommand: "bun fmt --check src/result.ts",
  })
  await runPlan(f)
  await drive(f.runtime, 12)
  const planID = f.receipt.planID
  expect(f.store.plan(planID)?.reason).toContain("Required evidence missing")
  const attemptID = f.store.attempts(planID)[0]!.id
  writeFileSync(join(f.root, "src/result.ts"), "export const correction=1\n")
  git(f.root, ["add", "src/result.ts"])
  git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Correct the retained candidate",
  ])
  await f.runtime.command(
    {
      requestID: "reconcile-correction",
      planID,
      action: "reconcile",
    },
    "owner",
  )
  await f.runtime.tick()
  const activities = verificationActivitiesForDatabase(f.repository.path)
  expect(activities).toHaveLength(1)
  await activities[0]!.settled
  await f.runtime.tick()
  expect(f.store.effects(planID).filter(authoredVerifyEffect)).toHaveLength(2)
  await drive(f.runtime, 12)
  expect(f.store.plan(planID)?.reason).toContain("Required evidence missing")
  expect(f.store.attempts(planID).map((attempt) => attempt.id)).toEqual([attemptID])
  expect(readFileSync(join(f.root, "src/result.ts"), "utf8")).toContain("correction = 1")
  const effects = f.store.effects(planID).filter((effect) => effect.kind === "mechanical-fix")
  expect(effects.map((effect) => effect.state)).toEqual(["completed", "completed"])
  expect(new Set(effects.map((effect) => JSON.parse(effect.payload).receiptPath)).size).toBe(2)
})

test("protected candidate changes are not mechanically modified", async () => {
  const f = fixture({
    outside: true,
    protectedScope: ["escape.txt"],
    taskFiles: [{ name: "a", path: "src/result.ts", scope: ["src/**"] }],
    checkCommand: "bun fmt --check src/result.ts",
  })
  await runPlan(f)
  await drive(f.runtime, 8)
  const plan = f.store.plan(f.receipt.planID)!
  const attempt = f.store.attempts(plan.id)[0]!
  expect(plan.state).toBe("blocked")
  expect(readFileSync(join(attempt.workspace, "src/result.ts"), "utf8")).toBe("a")
  expect(f.store.effects(plan.id).some((effect) => effect.kind === "mechanical-fix")).toBe(false)
})

test("an accepted plan that will never be integrated can be cancelled and releases its workers' worktrees", async () => {
  const f = fixture()
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await driveWithTaskSourceLandings(f)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  const workspaces = f.store.attempts(f.receipt.planID).map((attempt) => attempt.workspace)
  expect(workspaces.length).toBeGreaterThan(0)

  expect(
    await f.runtime.command(
      { requestID: "cancel-accepted", planID: f.receipt.planID, action: "cancel" },
      "owner",
    ),
  ).toMatchObject({ status: "cancelling" })
  await drive(f.runtime, 6)

  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  expect(f.store.dispatchReservations()).toEqual([])
  // Non-forced cleanup removes merged worktrees and preserves any holding unmerged commits.
  const removals = f.store.effects(f.receipt.planID).filter((e) => e.kind === "worktree-remove")
  expect(removals.length).toBe(workspaces.length)
  for (const workspace of workspaces) {
    const removal = removals.find((e) => JSON.parse(e.payload).workspace === workspace)!
    expect(existsSync(workspace)).toBe(removal.state !== "completed")
    expect(["completed", "held"]).toContain(removal.state)
  }
  expect(removals.some((e) => e.state === "completed")).toBe(true)
})

test("stale attempts of blocked plans and accepted nodes stop holding dispatch reservations", async () => {
  let clock = Date.now()
  const f = fixture({ delayed: true, independent: true, now: () => clock })
  await runPlan(f)
  await f.runtime.tick()
  const [first, second] = f.store.attempts(f.receipt.planID)
  expect(first).toBeDefined()
  expect(second).toBeDefined()
  expect(f.store.dispatchReservations().length).toBeGreaterThan(0)

  // A blocked plan whose worker session is still live keeps its reservation.
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_plans SET state='blocked',reason='held' WHERE id=?")
      .run(f.receipt.planID),
  )
  await f.runtime.tick()
  clock += 61_000
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]!.state).not.toBe("failed")

  // Once the session is gone the attempt settles, with an event, and retry stays available.
  f.sessions.delete(first!.session_id)
  clock += 61_000
  await f.runtime.tick()
  const settled = f.store.attempts(f.receipt.planID).find((a) => a.id === first!.id)!
  expect(settled.state).toBe("failed")
  expect(
    f.store.latestTransition(f.receipt.planID, first!.task_id, "ATTEMPT_STALE_SETTLED"),
  ).toMatchObject({
    attemptID: first!.id,
    to: "failed",
    cause: "session-absent",
  })

  // A node accepted by an older retained acceptance settles its verifying attempt.
  {
    f.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET state='verifying' WHERE id=?").run(second!.id)
      db.query(
        "UPDATE runner_nodes SET state='accepted',artifact='deadbeef' WHERE plan_id=? AND task_id=?",
      ).run(f.receipt.planID, second!.task_id)
    })
    await f.runtime.tick()
    expect(f.store.attempts(f.receipt.planID).find((a) => a.id === second!.id)).toMatchObject({
      state: "accepted",
    })
  }
})

test("reopening verification reruns only the interrupted check", async () => {
  const invocationDirectory = mkdtempSync(join(tmpdir(), "lazers-check-reuse-"))
  const beforeInvocations = join(invocationDirectory, "before.log")
  const contentInvocations = join(invocationDirectory, "content.log")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const f = fixture({
    taskFiles: [{ name: "a", path: "a.txt" }],
    beforeCheck: `printf x >> ${quote(beforeInvocations)}; true`,
    checkCommand: (_name, _path, root) =>
      `printf x >> ${quote(contentInvocations)}; touch '${root}/check-started'; while [ ! -f '${root}/check-release' ]; do sleep 0.02; done`,
    useProjectVerificationDefaults: true,
    verificationTimeoutDefaults: { inactivityTimeoutMs: 10_000, hardTimeoutMs: 20_000 },
  })
  cleanup.push(() => rmSync(invocationDirectory, { recursive: true, force: true }))
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id)
  await f.runtime.tick()
  const first = verificationActivitiesForDatabase(f.repository.path).find(
    (activity) => activity.metadata.planID === f.receipt.planID,
  )!
  await first.settled
  await f.runtime.tick()
  const legacyBefore = f.store
    .effects(f.receipt.planID)
    .find((effect) => effect.kind === "verify:before")!
  if (legacyBefore.state !== "completed" || !legacyBefore.receipt)
    throw new Error("The first task check did not complete before interruption")
  const beforeReceipt = legacyBefore.receipt
  const legacyPayload = JSON.parse(legacyBefore.payload) as Record<string, unknown>
  delete legacyPayload.authoredCheck
  delete legacyPayload.verificationDeadline
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_effects SET payload=? WHERE id=?")
      .run(JSON.stringify(legacyPayload), legacyBefore.id),
  )
  await waitForPath(join(f.root, "check-started"), 3_000)
  await f.runtime.stop()

  const reopened = reopenRuntime(f, {
    inactivityTimeoutMs: 15_000,
    hardTimeoutMs: 30_000,
  })
  writeFileSync(join(f.root, "check-release"), "release\n")
  await drive(reopened.runtime, 8)
  const effects = reopened.store.effects(f.receipt.planID)
  expect(effects.filter((effect) => effect.kind === "verify:before")).toHaveLength(1)
  expect(effects.filter((effect) => effect.kind === "verify:content")).toHaveLength(2)
  const reusedBefore = effects.find((effect) => effect.kind === "verify:before")!
  expect(reusedBefore.receipt).toBe(beforeReceipt)
  expect(readFileSync(beforeInvocations, "utf8")).toBe("x")
  expect(readFileSync(contentInvocations, "utf8")).toBe("xx")
  expect(reopened.store.plan(f.receipt.planID)?.state).toBe("accepted")
})

test("completed legacy combined checks survive changed defaults across reopen without rerunning", async () => {
  const invocationDirectory = mkdtempSync(join(tmpdir(), "lazers-combined-reuse-"))
  const firstInvocations = join(invocationDirectory, "first.log")
  const secondInvocations = join(invocationDirectory, "second.log")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const state = await prepareInterruptedCombinedCheck({
    combinedCheckCommand: `printf x >> ${quote(firstInvocations)}; true`,
    additionalCombinedCheckCommand:
      `printf x >> ${quote(secondInvocations)}; touch .lazers-combined-started; ` +
      "while [ ! -f .lazers-combined-release ]; do sleep 0.02; done; exit 0",
    verificationTimeoutDefaults: { inactivityTimeoutMs: 10_000, hardTimeoutMs: 20_000 },
    reopenTimeoutDefaults: { inactivityTimeoutMs: 15_000, hardTimeoutMs: 30_000 },
    interruptedCheckID: "combined-second",
    legacyCompletedCheckID: "combined",
  })
  cleanup.push(() => rmSync(invocationDirectory, { recursive: true, force: true }))

  expect(state.legacyReceipt).toBeString()
  const first = state.reopened.store
    .effects(state.planID)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(first.state).toBe("completed")
  expect(first.receipt).toBe(state.legacyReceipt)
  expect(JSON.parse(first.payload).authoredCheck).toBeUndefined()
  expect(JSON.parse(first.payload).check.inactivityTimeoutMs).toBe(10_000)
  expect(readFileSync(firstInvocations, "utf8")).toBe("x")
  // The interrupted check is superseded and runs again; the completed one is never repeated.
  expect(state.interrupted.state).toBe("failed")
  expect(JSON.parse(state.interrupted.receipt!).superseded).toBe(true)
  expect(readFileSync(secondInvocations, "utf8").length).toBeGreaterThanOrEqual(1)
  expect(
    state.reopened.store
      .effects(state.planID)
      .filter((effect) => effect.kind === "graph-verify:combined"),
  ).toHaveLength(1)
})

test("integrated combined cleanup accepts a completed legacy check after defaults change", async () => {
  const f = fixture({
    taskFiles: [{ name: "a", path: "a.txt" }],
    useProjectVerificationDefaults: true,
    verificationTimeoutDefaults: { inactivityTimeoutMs: 10_000, hardTimeoutMs: 20_000 },
  })
  const { plan } = await acceptPlan(f, f.receipt.planID)
  const completedCheck = f.store
    .effects(plan.id)
    .find((effect) => effect.kind === "graph-verify:combined")!
  const graphWorkspace = JSON.parse(completedCheck.payload).workspace as string
  const legacyPayload = JSON.parse(completedCheck.payload) as Record<string, unknown>
  delete legacyPayload.authoredCheck
  delete legacyPayload.verificationDeadline
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_effects SET payload=? WHERE id=?")
      .run(JSON.stringify(legacyPayload), completedCheck.id),
  )

  await f.runtime.stop()
  const reopened = reopenRuntime(f, {
    inactivityTimeoutMs: 15_000,
    hardTimeoutMs: 30_000,
  })
  f.runtime = reopened.runtime
  f.store = reopened.store
  includeArtifact(f, plan.artifact!)
  await recordPlanIntegration(f, f.receipt.planID)
  await f.runtime.tick()

  expect(f.store.plan(plan.id)?.state).toBe("integrated")
  expect(existsSync(graphWorkspace)).toBe(false)
})

test("an interrupted combined check runs again on reopen without a resume or replaying accepted workers", async () => {
  const { f, reopened, interrupted, receiptPath, planID } = await prepareInterruptedCombinedCheck()
  const originalDiskReceipt = readFileSync(receiptPath, "utf8")
  const taskArtifact = reopened.store.nodes(planID)[0]!.artifact
  expect(reopened.store.plan(planID)?.state).toBe("running")
  expect(reopened.store.nodes(planID).map((node) => node.state)).toEqual(["accepted"])
  let fresh: ReturnType<typeof reopened.store.effects>[number] | undefined
  for (let tick = 0; tick < 20 && !fresh; tick++) {
    await reopened.runtime.tick()
    fresh = reopened.store
      .effects(planID)
      .find((effect) => effect.kind === "graph-verify:combined" && effect.id !== interrupted.id)
  }
  if (!fresh) throw new Error("The interrupted combined check did not run again")
  const freshPayload = JSON.parse(fresh.payload) as {
    artifact: string
    workspace: string
    receiptPath: string
  }
  await waitForPath(join(freshPayload.workspace, ".lazers-combined-started"))
  const freshActivity = verificationActivitiesForDatabase(f.repository.path).find(
    (activity) => activity.metadata.effectID === fresh!.id,
  )!
  writeFileSync(join(freshPayload.workspace, ".lazers-combined-release"), "release\n")
  await freshActivity.settled
  rmSync(join(freshPayload.workspace, ".lazers-combined-started"), { force: true })
  rmSync(join(freshPayload.workspace, ".lazers-combined-release"), { force: true })
  await drive(reopened.runtime, 8)

  const plan = reopened.store.plan(planID)!
  const checks = reopened.store
    .effects(planID)
    .filter((effect) => effect.kind === "graph-verify:combined")
  expect(plan.state).toBe("accepted")
  expect(plan.artifact).toBe(freshPayload.artifact)
  expect(checks).toHaveLength(2)
  expect(checks.find((effect) => effect.id === fresh!.id)?.state).toBe("completed")
  expect(freshPayload.artifact).toBe(
    (JSON.parse(interrupted.payload) as { artifact: string }).artifact,
  )
  expect(freshPayload.receiptPath).not.toBe(receiptPath)
  expect(readFileSync(receiptPath, "utf8")).toBe(originalDiskReceipt)
  expect(reopened.store.nodes(planID)[0]?.artifact).toBe(taskArtifact)
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test.each([false, true])(
  "an exit-zero check with uncertain cleanup runs again (stop-before-reconcile=%s)",
  async (stopBeforeReconcile) => {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const f = fixture({
      taskFiles: [{ name: "a", path: "a.txt" }],
      checkCommand: (_name, _path, root) =>
        `printf x >> ${quote(join(root, "check-count"))}; printf "%s" "$$" > ${quote(join(root, "check-pid"))}; sleep 30 >/dev/null 2>&1 & while [ ! -f ${quote(join(root, "check-release"))} ]; do sleep 0.02; done; exit 0`,
      combinedCheckCommand: "true",
    })
    const originalKill = process.kill.bind(process)
    const pidPath = join(f.root, "check-pid")
    const releasePath = join(f.root, "check-release")
    let processGroupID: number | undefined
    const mockedKill = spyOn(process, "kill").mockImplementation(((pid, signal) => {
      if (typeof pid === "number" && processGroupID !== undefined && pid === -processGroupID) {
        if (signal === 0) return true
        if (signal === "SIGKILL") throw new Error("simulated process-group cleanup failure")
      }
      return originalKill(pid, signal)
    }) as typeof process.kill)
    try {
      await runPlan(f)
      await f.runtime.tick()
      const attempt = f.store.attempts(f.receipt.planID)[0]!
      f.completeWorker(attempt.session_id)
      await f.runtime.tick()
      await waitForPath(pidPath)
      processGroupID = Number(readFileSync(pidPath, "utf8"))
      writeFileSync(releasePath, "go\n")
      const effect = f.store
        .effects(f.receipt.planID)
        .find((candidate) => candidate.kind === "verify:content")!
      const activity = verificationActivitiesForDatabase(f.repository.path).find(
        (candidate) => candidate.metadata.effectID === effect.id,
      )!
      await activity.settled
      if (stopBeforeReconcile) {
        expect(activity.state).toBe("completed")
        await expect(f.runtime.stop()).rejects.toThrow("subprocess cleanup remains uncertain")
        const reopened = reopenRuntime(f)
        await drive(reopened.runtime, 4)
      } else await drive(f.runtime, 4)

      // The check finished but its process tree did not settle: it is superseded, the finished
      // result kept as evidence, and the check runs again; the plan is never held on it.
      const first = f.store
        .effects(f.receipt.planID)
        .find((candidate) => candidate.id === effect.id)!
      expect(first.state).toBe("failed")
      expect(JSON.parse(first.receipt!).superseded).toBe(true)
      expect(f.store.plan(f.receipt.planID)?.state).not.toBe("blocked")
      expect(
        f.store.effects(f.receipt.planID).filter((candidate) => candidate.kind === "verify:content")
          .length,
      ).toBeGreaterThanOrEqual(2)
      expect(readFileSync(join(f.root, "check-count"), "utf8").length).toBeGreaterThanOrEqual(2)
    } finally {
      mockedKill.mockRestore()
      if (processGroupID !== undefined) {
        try {
          originalKill(-processGroupID, "SIGKILL")
        } catch {
          // The subprocess tree may have exited while the retained receipt was inspected.
        }
      }
    }
  },
)

test("whole-plan cancellation interrupts busy siblings and settles past an unsettled finished check", async () => {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: ["a", "b", "c"].map((name) => ({ name, path: `${name}.txt` })),
    checkCommand: (_name, _path, root) =>
      `printf "%s" "$$" > ${quote(join(root, "uncertain-pid"))}; sleep 30 >/dev/null 2>&1 & while [ ! -f ${quote(join(root, "uncertain-release"))} ]; do sleep 0.02; done; exit 0`,
  })
  const control = await registeredPlanCommand(f.runtime)
  await runPlan(f)
  await f.runtime.tick()
  const [checked, ...siblings] = f.store.attempts(f.receipt.planID)
  expect(siblings).toHaveLength(2)
  f.completeWorker(checked!.session_id)
  await f.runtime.tick()
  await waitForPath(join(f.root, "uncertain-pid"))
  const pid = Number(readFileSync(join(f.root, "uncertain-pid"), "utf8"))
  const originalKill = process.kill.bind(process)
  const kill = spyOn(process, "kill").mockImplementation(((target, signal) => {
    if (target === -pid) {
      if (signal === 0) return true
      if (signal === "SIGKILL") throw new Error("fixture cannot confirm settlement")
    }
    return originalKill(target, signal)
  }) as typeof process.kill)
  try {
    writeFileSync(join(f.root, "uncertain-release"), "go\n")
    const activity = verificationActivitiesForDatabase(f.repository.path).find(
      (entry) => entry.metadata.attemptID === checked!.id,
    )!
    await activity.settled
    // The activity keeps the settlement fact, not the receipt.
    expect(activity.summary).toEqual({
      settlementProblem: expect.stringContaining(
        "Command exited 0 with timedOut=false; subprocess cleanup remains uncertain",
      ),
    })
    const interrupted: string[] = []
    const interrupt = f.host.interrupt
    f.host.interrupt = async (sessionID) => {
      interrupted.push(sessionID)
      await interrupt(sessionID)
    }
    expect(siblings.every((attempt) => f.sessions.get(attempt.session_id)?.busy)).toBe(true)
    await control.execute({
      requestID: "cancel-uncertain-check-and-siblings",
      planID: f.receipt.planID,
      action: "cancel",
    })
    await f.runtime.tick()
    expect(interrupted.toSorted()).toEqual(siblings.map((attempt) => attempt.session_id).toSorted())
    // The finished check's unsettled process tree does not fence the cancel: its effect is
    // superseded with the finished result kept as evidence, and the plan settles.
    expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
    expect(
      f.store.latestTransition(f.receipt.planID, null, "VERIFICATION_CANCELLATION_UNCERTAIN"),
    ).toBeUndefined()
    expect(
      f.store
        .attempts(f.receipt.planID)
        .filter((attempt) => siblings.some((sibling) => sibling.id === attempt.id))
        .every((attempt) => attempt.state === "cancelled"),
    ).toBe(true)
    const effect = f.store
      .effects(f.receipt.planID)
      .find((entry) => entry.kind === "verify:content")!
    expect(effect.state).toBe("failed")
    const superseded = JSON.parse(effect.receipt!)
    expect(superseded.superseded).toBe(true)
    // The run's own receipt file stays as the evidence of what it finished with.
    const onDisk = JSON.parse(readFileSync(JSON.parse(effect.payload).receiptPath, "utf8"))
    expect(onDisk).toMatchObject({ exitCode: 0, timedOut: false })
    expect(f.notifications.some((notice) => notice.text.includes('"status":"cancelled"'))).toBe(
      true,
    )
  } finally {
    kill.mockRestore()
    try {
      originalKill(-pid, "SIGKILL")
    } catch {
      // The descendant may already have exited while assertions ran.
    }
  }
})

test("repair handoffs do not copy legacy skill bodies into a new attempt", async () => {
  const f = fixture({ fail: true, repair: true, skillSuggestions: ["sqlite — Optional helper"] })
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await f.runtime.tick()
  const first = f.store.attempts(f.receipt.planID)[0]!
  seedLegacySkillBody(f, first)
  await settleVerification(f.runtime)
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("running")
  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]!.policy).toContain(skillBodyCanary)
  expectNoSkillBody(attempts[1]!.policy)
})

test("a repair attempt is told about every failing check", async () => {
  const f = fixture({
    repair: true,
    beforeCheck: "echo before-out; echo before-err >&2; exit 3",
    checkCommand: "echo content-out; echo content-err >&2; exit 7",
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await f.runtime.tick()
  await settleVerification(f.runtime)
  const repairs = f.store
    .activity(planID, f.tasks[0]!.id)
    .filter((event) => event.event === "REPAIR")
  expect(repairs).toHaveLength(1)
  expect(JSON.stringify(repairs[0])).toContain(
    "Verification before exited with code 3; Verification content exited with code 7",
  )
  const attempts = f.store.attempts(planID)
  expect(attempts).toHaveLength(2)
  await f.runtime.tick()
  const prompt = f.sessions.get(attempts[1]!.session_id)!.messages[0]!.text
  expect(prompt).toContain("- before: `echo before-out; echo before-err >&2; exit 3` exit 3")
  expect(prompt).toContain("stdout:\n```\nbefore-out\n\n```")
  expect(prompt).toContain("stderr:\n```\nbefore-err\n\n```")
  expect(prompt).toContain("- content: `echo content-out; echo content-err >&2; exit 7` exit 7")
  expect(prompt).toContain("stdout:\n```\ncontent-out\n\n```")
  expect(prompt).toContain("stderr:\n```\ncontent-err\n\n```")
})

test("a single failing check keeps its unchanged failure reason", async () => {
  const f = fixture({ fail: true, repair: true })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await f.runtime.tick()
  await settleVerification(f.runtime)
  const repairs = f.store
    .activity(planID, f.tasks[0]!.id)
    .filter((event) => event.event === "REPAIR")
  expect(repairs).toHaveLength(1)
  expect(JSON.stringify(repairs[0])).toContain("Verification content exited with code 7")
  expect(JSON.stringify(repairs[0])).not.toContain(";")
})

test("an ordinary failure beside a timeout still holds without repair", async () => {
  const f = fixture({
    repair: true,
    beforeCheck: "exit 3",
    checkCommand: "sleep 5",
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await f.runtime.tick()
  await settleVerification(f.runtime)
  expect(f.store.plan(planID)?.reason).toBe("Verification content timed out")
  expect(
    f.store.activity(planID, f.tasks[0]!.id).filter((event) => event.event === "REPAIR"),
  ).toHaveLength(0)
  expect(f.store.attempts(planID)).toHaveLength(1)
})

test("verification failure and scope violations cannot unblock a successor", async () => {
  for (const options of [
    { fail: true },
    { outside: true, protectedScope: ["escape.txt"] },
    { missingEvidence: true },
  ]) {
    const f = fixture(options)
    await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
    await drive(f.runtime, 5)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
    expect(f.store.nodes(f.receipt.planID)[1]!.state).toBe("queued")
    expect(f.events.filter((e) => e.startsWith("create:"))).toHaveLength(1)
    expect(f.store.repository.get(f.tasks[0]!.id)!.status).toBe("submitted")
  }
})

test("an unchanged evidence wait keeps its version and notification stable", async () => {
  const f = fixture({
    missingEvidence: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await drive(f.runtime, 5)
  const blocked = f.store.plan(planID)!
  expect(blocked.state).toBe("blocked")
  const counts = () =>
    f.store.atomic((db) => ({
      blocked: db
        .query("SELECT COUNT(*) AS n FROM runner_transitions WHERE plan_id=? AND event='BLOCKED'")
        .get(planID),
      outcomes: db.query("SELECT COUNT(*) AS n FROM runner_outbox WHERE plan_id=?").get(planID),
    }))
  const before = counts()
  await drive(f.runtime, 4)
  expect(f.store.plan(planID)!.version).toBe(blocked.version)
  expect(counts()).toEqual(before)
})

test("a resumed worker verifies its new commit without reusing older receipts or spending a repair", async () => {
  const f = fixture({
    missingEvidence: true,
    commit: true,
    repair: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await drive(f.runtime, 5)
  const original = f.store.attempts(planID)[0]!
  const originalCheck = f.store.effects(planID).find((effect) => effect.kind === "verify:content")!
  const originalReceipt = originalCheck.receipt
  expect(f.store.plan(planID)?.reason).toContain("correct:evidence/never-produced.md")

  await f.runtime.command(
    {
      requestID: "cancel",
      planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.command(
    {
      requestID: "resume-review-repair",
      planID,
      action: "resume",
      taskID: original.task_id,
      reason: "Continue the existing worker after review",
    },
    "owner",
  )
  await f.runtime.tick()
  // Same attempt, different valid source commit after the resumed worker finishes.
  writeFileSync(join(original.workspace, "a.txt"), "a\n")
  git(original.workspace, ["add", "a.txt"])
  git(original.workspace, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Repair after review",
  ])
  const repaired = git(original.workspace, ["rev-parse", "HEAD"])
  expect(repaired).not.toBe(original.artifact!)
  await drive(f.runtime, 5)

  expect(f.store.attempts(planID).map((attempt) => attempt.id)).toEqual([original.id])
  expect(f.store.plan(planID)?.reason).toContain("correct:evidence/never-produced.md")
  expect(f.store.nodes(planID)[0]).toMatchObject({ state: "verifying", artifact: repaired })
  const checks = f.store.effects(planID).filter((effect) => effect.kind === "verify:content")
  expect(checks).toHaveLength(2)
  expect(checks.find((effect) => effect.id === originalCheck.id)?.receipt).toBe(originalReceipt)
  expect(new Set(checks.map((effect) => JSON.parse(effect.payload).receiptPath)).size).toBe(2)
  for (const effect of checks) {
    const payload = JSON.parse(effect.payload)
    expect(JSON.parse(effect.receipt!).check).toMatchObject({
      artifact: payload.artifact,
      exitCode: 0,
    })
    expect(existsSync(payload.receiptPath)).toBe(true)
  }
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
})

test("a settled verification timeout preserves its attempt and keeps its reservation against a conflicting task", async () => {
  const f = fixture({
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "shared.txt" }],
    checkCommand: (name) => (name === "a" ? "sleep 5" : "true"),
  })
  await runPlan(f)
  await f.runtime.tick()
  const old = f.store.attempts(f.receipt.planID)[0]!
  const next = f.createTask("b", "shared.txt")
  const queued = f.store.submit(f.inputFor([next], { requestID: "after-timed-out-check" }), "owner")
  await runPlan(f, queued.planID, "run-after-timed-out-check")
  f.completeWorker(old.session_id)
  Object.assign(f.sessions.get(old.session_id)!, {
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
  })
  await settleVerification(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.reason).toBe("Verification content timed out")
  await f.runtime.tick()
  expect(f.store.attempts(queued.planID)).toEqual([])
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("verifying")
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.reason).toBe("Verification content timed out")
  expect(readFileSync(join(old.workspace, "shared.txt"), "utf8")).toBe("a")
})

test("a stalled queue requests one Architect review and leaves scheduling decisions with the Architect", async () => {
  let now = Date.now()
  const f = fixture({
    independent: true,
    delayed: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const prerequisite = f.receipt.planID
  const plans = []
  for (const name of ["b", "c"]) {
    const task = f.createTask(name, `${name}.txt`)
    const plan = f.store.submit(
      {
        ...f.inputFor([task], { requestID: `queue-review-${name}` }),
        afterPlans: [prerequisite],
      },
      "owner",
    )
    plans.push(plan.planID)
    await runPlan(f, plan.planID, `run-queue-review-${name}`)
  }
  const review = () =>
    f.notifications.filter((notice) => notice.text.includes('"status":"queue-review"'))
  await runPlan(f)
  await f.runtime.tick()
  expect(f.store.attempts(prerequisite)[0]?.state).toBe("running")
  expect(review()).toHaveLength(0)
  const worker = f.store.attempts(prerequisite)[0]!
  const session = f.sessions.get(worker.session_id)!
  session.busy = false
  await f.runtime.tick()
  await f.runtime.tick()
  expect(review()).toHaveLength(1)
  expect(review()[0]).toMatchObject({ sessionID: "owner", resume: true })
  expect(review()[0]?.text).toContain("Unblock the queue now")
  expect(review()[0]?.text).toContain("Own sequencing, parallelism, and retries")
  for (const planID of plans) {
    expect(review()[0]?.text).toContain(planID)
    expect(f.store.attempts(planID)).toHaveLength(0)
  }

  now += 5 * 60_000
  await f.runtime.tick()
  expect(review()).toHaveLength(1) // The first request still owns its native inbox entry.
  const inbox = f.inbox.get("owner")!
  const delivered = inbox.find((entry) => entry.id === review()[0]!.id)!
  const architect = f.sessions.get("owner")!
  architect.messages.push({
    id: delivered.id,
    type: "synthetic",
    text: "Queue review",
    metadata: delivered.metadata,
  })
  f.inbox.set(
    "owner",
    inbox.filter((entry) => entry.id !== delivered.id),
  )
  architect.pendingForms = 1
  await f.runtime.tick()
  expect(review()).toHaveLength(1)
  architect.pendingForms = 0
  await f.runtime.tick()
  expect(review()).toHaveLength(2)
  await f.runtime.tick()
  expect(review()).toHaveLength(2)
})

test("project timing configuration overrides legacy task and combined timeout metadata", async () => {
  const f = fixture({
    shared: true,
    delayed: true,
    commit: true,
    independent: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    checkCommand: "true",
    combinedCheckCommand: "true",
    useProjectVerificationDefaults: true,
    verificationTimeoutDefaults: { inactivityTimeoutMs: 2_000, hardTimeoutMs: 5_000 },
  })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id)
  await drive(f.runtime)

  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  const receipts = f.store.effects(f.receipt.planID).flatMap((effect) => {
    const authoredCombined =
      effect.kind.startsWith("graph-verify:") && effect.kind !== "graph-verify:fallow-audit"
    if (!authoredVerifyEffect(effect) && !authoredCombined) return []
    if (!effect.receipt) return []
    const envelope = JSON.parse(effect.receipt) as { check?: RunnerCheckReceipt }
    return envelope.check ? [{ kind: effect.kind, check: envelope.check }] : []
  })
  expect(receipts.map(({ kind }) => kind).sort()).toEqual([
    "graph-verify:combined",
    "verify:content",
  ])
  for (const { check } of receipts)
    expect(check).toMatchObject({
      inactivityTimeoutMs: 2_000,
      hardTimeoutMs: 5_000,
      verificationDeadline: {
        authoredTimeoutMs: 1_000,
        effectiveInactivityTimeoutMs: 2_000,
        effectiveHardTimeoutMs: 5_000,
        inactivityProvenance: "project-default",
        hardTimeoutProvenance: "project-default",
      },
    })
})

test("a verification effect with no receipt is superseded and its check re-runs on reconcile", async () => {
  const f = await retainedSourceFixture()
  const planID = f.receipt.planID
  expect(f.store.plan(planID)!.state).toBe("blocked")
  // Drop the durable interrupted receipt: with none recorded, the check is re-runnable.
  rmSync(join(f.root, "retained-check.json"), { force: true })
  f.store.atomic((db) =>
    db.query("UPDATE runner_effects SET receipt=NULL WHERE id=?").run(f.effectID),
  )
  const result = (await f.runtime.command(
    {
      requestID: "reconcile-uncertain-verification",
      planID,
      action: "reconcile",
    },
    "owner",
  )) as { status: string }
  // The uncertain effect is a verification: reconcile no longer refuses.
  expect(result.status).toBe("reconciling")
  await drive(f.runtime, 4)
  const verifications = f.store.effects(planID).filter((effect) => effect.kind === "verify:content")
  const original = verifications.find((effect) => effect.id === f.effectID)!
  expect(original.state).toBe("failed")
  expect(JSON.parse(original.receipt!)).toMatchObject({ superseded: true })
  expect(
    f.store
      .activity(planID, original.task_id!)
      .some((event) => event.event === "EFFECT_SUPERSEDED"),
  ).toBe(true)
})

test("an uncertain task check and an uncertain combined check are run again and the plan is accepted", async () => {
  const f = fixture()
  const runtime = Reflect.get(f.runtime, "checkActivities") as {
    startCheckActivity: (input: { id: string }) => unknown
  }
  const original = runtime.startCheckActivity.bind(runtime)
  const dropped = new Set<string>()
  runtime.startCheckActivity = (input) => {
    const kind = f.store.effects(f.receipt.planID).find((e) => e.id === input.id)?.kind ?? ""
    const family = kind.startsWith("verify:")
      ? "task"
      : kind.startsWith("graph-verify:")
        ? "combined"
        : ""
    // The first run of each kind fails to start: its effect is left uncertain.
    if (family && !dropped.has(family)) {
      dropped.add(family)
      throw new Error("check runner unavailable")
    }
    return original(input as never)
  }
  await runPlan(f)
  await driveWithTaskSourceLandings(f, 24)
  expect([...dropped].sort()).toEqual(["combined", "task"])
  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.reason ?? "").not.toContain("not replayed")
  expect(plan.state).toBe("accepted")
  const superseded = f.store
    .effects(plan.id)
    .filter((e) => e.state === "failed" && JSON.parse(e.receipt ?? "{}").superseded)
  expect(superseded.some((e) => e.kind.startsWith("verify:"))).toBe(true)
  expect(superseded.some((e) => e.kind.startsWith("graph-verify:"))).toBe(true)
})
