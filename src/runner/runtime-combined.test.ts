import { setProjectSetting } from "../projects/settings.ts"
import { expect, test } from "bun:test"
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { combineArtifacts, git } from "./artifacts.ts"
import type { RunnerHost } from "./host.ts"
import { settleVerification } from "../../test/runner/verification-driver.ts"
import {
  TaskRuntime,
  attemptCheck,
  cleanup,
  drive,
  driveWithTaskSourceLandings,
  expectNoSkillBody,
  fixture,
  integrateTaskSource,
  runPlan,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("independent isolated Git branches overlap and combined verification includes every artifact", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  const projection = await f.runtime.readScheduling({
    scope: { kind: "project", sessionID: "owner" },
    limit: 100,
  })
  expect(projection.selectedTaskIDs).toEqual(f.tasks.map((task) => task.id))
  expect(projection.next).toMatchObject({ status: "known", candidate: { taskID: f.tasks[0]!.id } })
  await f.runtime.tick()

  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  expect(attempts.map((attempt) => attempt.task_id)).toEqual(projection.selectedTaskIDs)
  expect(new Set(attempts.map((attempt) => attempt.workspace)).size).toBe(2)
  expect(attempts.every((attempt) => attempt.base_commit === f.base)).toBe(true)
  expect(attempts.every((attempt) => f.sessions.get(attempt.session_id)?.busy)).toBe(true)
  const starts = f.events
    .map((event, index) => ({ event, index }))
    .filter((entry) => entry.event.startsWith("start:"))
  expect(starts).toHaveLength(2)
  const activity = f.store.detail(f.receipt.planID).activity as {
    id: number
    event: string
    payload: string
  }[]
  const dispatchRecords = activity.filter((entry) => entry.event === "WORKER_STARTED")
  expect(dispatchRecords).toHaveLength(2)
  for (const record of dispatchRecords) {
    const identity = JSON.parse(record.payload)
    expect(
      attempts.some(
        (attempt) =>
          attempt.id === identity.attemptID &&
          attempt.session_id === identity.sessionID &&
          attempt.workspace === identity.workspace,
      ),
    ).toBe(true)
  }

  f.completeWorker(attempts[0]!.session_id)
  await settleVerification(f.runtime)
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual(["accepted", "running"])
  const currentActivity = f.store.detail(f.receipt.planID).activity as {
    id: number
    event: string
    payload: string
  }[]
  const lifetimes = currentActivity.filter((entry) =>
    ["WORKER_STARTED", "WORKER_STOPPED"].includes(entry.event),
  )
  const startsBeforeStop = lifetimes.filter((entry) => entry.event === "WORKER_STARTED")
  const firstStop = lifetimes.find((entry) => entry.event === "WORKER_STOPPED")!
  expect(Math.max(...startsBeforeStop.map((entry) => entry.id))).toBeLessThan(firstStop.id)
  f.completeWorker(attempts[1]!.session_id)
  await drive(f.runtime)

  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.state).toBe("accepted")
  expect(git(f.root, ["show", `${plan.artifact}:a.txt`])).toBe("a")
  expect(git(f.root, ["show", `${plan.artifact}:b.txt`])).toBe("b")
  expect(
    await combineArtifacts(
      f.root,
      f.base,
      f.store.nodes(plan.id).map((node) => node.artifact!),
    ),
  ).toBe(plan.artifact!)
  const graphWorkspace = f.store.effects(plan.id).find((effect) => effect.kind === "graph-worktree")
  expect(graphWorkspace?.state).toBe("completed")
  const combinedCheck = f.store
    .effects(plan.id)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(combinedCheck.receipt!).check.artifact).toBe(plan.artifact)
  expect(JSON.parse(combinedCheck.receipt!).check.exitCode).toBe(0)
})

test("dependencies wait for accepted inputs and wildcard ancestor scopes serialize", async () => {
  const dependent = fixture({ delayed: true })
  await runPlan(dependent)
  await dependent.runtime.tick()
  expect(dependent.store.attempts(dependent.receipt.planID)).toHaveLength(1)
  expect(dependent.store.execution(dependent.tasks[1]!.id)?.waitingOn).toEqual([
    dependent.tasks[0]!.id,
  ])
  const predecessor = dependent.store.attempts(dependent.receipt.planID)[0]!
  dependent.completeWorker(predecessor.session_id)
  await settleVerification(dependent.runtime)
  await dependent.runtime.tick()
  expect(dependent.store.attempts(dependent.receipt.planID)).toHaveLength(1)
  expect(dependent.store.nodes(dependent.receipt.planID)[1]!.state).toBe("queued")
  await integrateTaskSource(dependent, dependent.receipt.planID, dependent.tasks[0]!.id)
  await settleVerification(dependent.runtime)
  expect(dependent.store.attempts(dependent.receipt.planID)).toHaveLength(2)
  const successor = dependent.store.attempts(dependent.receipt.planID)[1]!
  expect(successor.base_commit).toBe(
    dependent.store.attempts(dependent.receipt.planID)[0]!.artifact!,
  )
  expect(dependent.events.indexOf(`stop:${predecessor.session_id}`)).toBeLessThan(
    dependent.events.indexOf(`start:${successor.session_id}`),
  )
  dependent.completeWorker(successor.session_id)
  await drive(dependent.runtime)
  expect(dependent.store.plan(dependent.receipt.planID)!.state).toBe("accepted")

  const scopes = fixture({
    independent: true,
    delayed: true,
    allowScopeOverlap: true,
    taskFiles: [
      { name: "a", path: "src/a.txt", scope: ["src/**"] },
      { name: "b", path: "src/b/b.txt", scope: ["src/b/**"] },
    ],
  })
  await runPlan(scopes)
  await scopes.runtime.tick()
  expect(scopes.store.attempts(scopes.receipt.planID)).toHaveLength(1)
  const first = scopes.store.attempts(scopes.receipt.planID)[0]!
  scopes.completeWorker(first.session_id)
  await settleVerification(scopes.runtime)
  await scopes.runtime.tick()
  const second = scopes.store.attempts(scopes.receipt.planID)[1]!
  expect(second.base_commit).toBe(scopes.base)
  expect(scopes.events.indexOf(`stop:${first.session_id}`)).toBeLessThan(
    scopes.events.indexOf(`start:${second.session_id}`),
  )
  scopes.completeWorker(second.session_id)
  await drive(scopes.runtime)
  expect(scopes.store.plan(scopes.receipt.planID)!.state).toBe("accepted")
})

test("independent plans overlap while a second reconciler cannot duplicate dispatch", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: [{ name: "a", path: "src/a.txt", scope: ["src/**"] }],
  })
  const taskB = f.createTask("b", "src/b/b.txt", ["src/b/**"])
  const planBInput = {
    ...f.inputFor([taskB], { requestID: "plan-b" }),
    dispositions: [
      {
        taskID: taskB.id,
        otherTaskID: f.tasks[0]!.id,
        relation: "supplements" as const,
        rationale: "Serialize overlapping source scopes across plans.",
      },
    ],
  }
  const planB = f.store.submit(planBInput, "owner")
  const taskC = f.createTask("c", "other/c.txt")
  const planC = f.store.submit(f.inputFor([taskC], { requestID: "plan-c" }), "owner")
  await runPlan(f, f.receipt.planID, "run-a")
  await runPlan(f, planB.planID, "run-b")
  await runPlan(f, planC.planID, "run-c")

  const secondReconciler = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  try {
    await Promise.all([f.runtime.tick(), secondReconciler.tick()])
    const attemptsA = f.store.attempts(f.receipt.planID)
    const attemptsB = f.store.attempts(planB.planID)
    const attemptsC = f.store.attempts(planC.planID)
    expect(attemptsA).toHaveLength(1)
    expect(attemptsB).toHaveLength(0)
    expect(attemptsC).toHaveLength(1)
    expect(attemptsA[0]!.workspace).not.toBe(attemptsC[0]!.workspace)
    expect(f.sessions.get(attemptsA[0]!.session_id)?.busy).toBe(true)
    expect(f.sessions.get(attemptsC[0]!.session_id)?.busy).toBe(true)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
    secondReconciler.stop()

    f.completeWorker(attemptsA[0]!.session_id)
    await settleVerification(f.runtime)
    const attemptsBAfterA = f.store.attempts(planB.planID)
    expect(attemptsBAfterA).toHaveLength(1)
    expect(f.sessions.get(attemptsBAfterA[0]!.session_id)?.busy).toBe(true)
    expect(f.events.indexOf(`stop:${attemptsA[0]!.session_id}`)).toBeLessThan(
      f.events.indexOf(`start:${attemptsBAfterA[0]!.session_id}`),
    )

    f.completeWorker(attemptsBAfterA[0]!.session_id)
    f.completeWorker(attemptsC[0]!.session_id)
    await drive(f.runtime)
    expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
    expect(f.store.plan(planB.planID)!.state).toBe("accepted")
    expect(f.store.plan(planC.planID)!.state).toBe("accepted")
  } finally {
    secondReconciler.stop()
  }
})

test("single-task acceptance coalesces its task handoff while another plan worker stays active", async () => {
  const f = fixture({ independent: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const b = f.createTask("b", "other/b.txt")
  const planB = f.store.submit(f.inputFor([b], { requestID: "other-plan" }), "owner")
  const notifications: Parameters<RunnerHost["notify"]>[0][] = []
  const notify = f.host.notify
  f.host.notify = async (input) => {
    notifications.push(input)
    await notify(input)
  }
  f.sessions.get("owner")!.busy = true
  await runPlan(f)
  await runPlan(f, planB.planID, "run-other")
  await f.runtime.tick()
  const a = f.store.attempts(f.receipt.planID)[0]!
  const other = f.store.attempts(planB.planID)[0]!
  f.completeWorker(a.session_id)
  await settleVerification(f.runtime)
  expect(f.sessions.get(other.session_id)?.busy).toBe(true)
  expect(f.store.plan(planB.planID)?.state).toBe("running")
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  const combined = notifications.find((input) => input.text.includes('"status":"accepted"'))!
  expect(combined.resume).toBe(true)
  expect(combined.text).toContain("Review and merge")
  expect(notifications.some((input) => input.text.includes('"status":"task-accepted"'))).toBe(false)
  const delivery = f.store.detail(f.receipt.planID).delivery as {
    payload: string
    state: string
    metadata: string
  }[]
  expect(delivery).toHaveLength(2)
  expect(delivery.find((row) => JSON.parse(row.payload).status === "task-accepted")?.state).toBe(
    "superseded",
  )
  expect(delivery.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe(
    "delivered",
  )
  expect(
    f.inbox
      .get("owner")
      ?.filter(
        (entry) =>
          entry.metadata &&
          "lazersPlanID" in entry.metadata &&
          entry.metadata.lazersPlanID === f.receipt.planID,
      ),
  ).toHaveLength(1)
  const ids = notifications.map((input) => input.id)
  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  cleanup.push(() => reopened.stop())
  await reopened.tick()
  expect(notifications.map((input) => input.id)).toEqual(ids)
  f.completeWorker(other.session_id)
  await drive(reopened)
})

test("a late older retry cannot replace a newer queued plan outcome", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const notifications: Parameters<RunnerHost["notify"]>[0][] = []
  const notify = f.host.notify
  f.host.notify = async (input) => {
    notifications.push(input)
    await notify(input)
  }
  f.sessions.get("owner")!.busy = true
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id)
  await settleVerification(f.runtime)

  const plan = f.store.plan(f.receipt.planID)!
  const current = (f.store.detail(plan.id).delivery as { payload: string }[]).find(
    (row) => JSON.parse(row.payload).status === "accepted",
  )!
  const oldVersion = JSON.parse(current.payload).version - 1
  const oldPayload = {
    planID: plan.id,
    planRevision: plan.revision,
    version: oldVersion,
    status: "task-accepted",
    taskID: f.tasks[0]!.id,
  }
  const metadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: "project",
    lazersProjectDirectory: f.repository.projectDirectory,
    lazersPlanID: plan.id,
    lazersOutboxID: "late-old-outbox",
    lazersMessageID: "msg_late_old_outcome",
    lazersSessionID: plan.owner,
    lazersStatus: "task-accepted",
    lazersVersion: oldVersion,
  }
  f.store.atomic((db) =>
    db
      .query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',1,?,NULL)",
      )
      .run(
        "late-old-outbox",
        plan.id,
        plan.owner,
        "msg_late_old_outcome",
        JSON.stringify(oldPayload),
        JSON.stringify(metadata),
      ),
  )

  await f.runtime.tick()

  const rows = f.store.detail(plan.id).delivery as {
    id: string
    payload: string
    state: string
  }[]
  expect(rows.find((row) => row.id === "late-old-outbox")?.state).toBe("superseded")
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("delivered")
  expect(notifications.some((notice) => notice.id === "msg_late_old_outcome")).toBe(false)
  expect(
    f.inbox
      .get(plan.owner)
      ?.filter((entry) => entry.metadata?.lazersPlanID === plan.id)
      .map((entry) => entry.metadata?.lazersStatus),
  ).toEqual(["accepted"])
})

test("an actionable partial-task outcome wakes review while its sibling worker remains active", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  f.sessions.get("owner")!.busy = true
  f.completeWorker(attempts[0]!.session_id)
  await settleVerification(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("running")
  expect(f.sessions.get(attempts[1]!.session_id)?.busy).toBe(true)
  const partial = f.inbox
    .get("owner")
    ?.filter(
      (entry) =>
        entry.metadata &&
        "lazersPlanID" in entry.metadata &&
        entry.metadata.lazersPlanID === f.receipt.planID,
    )
  expect(partial).toHaveLength(1)
  expect(partial?.[0]?.metadata?.lazersStatus).toBe("task-accepted")
  expect(f.events.some((event) => event === `notify:${partial?.[0]?.id}`)).toBe(true)
})

test("a newer partial result carries all prior reviewable artifacts while a third worker remains active", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: ["a", "b", "c"].map((name) => ({ name, path: `${name}.txt` })),
  })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  const notify = f.host.notify
  let lost = true
  f.host.notify = async (input) => {
    await notify(input)
    if (lost) throw new Error("Lost first partial admission response")
  }
  f.completeWorker(attempts[0]!.session_id)
  await settleVerification(f.runtime)
  // The lost response is read back from the inbox: it was admitted, so it is delivered.
  expect(f.store.outboxForDelivery()).toEqual([])
  expect((f.store.detail(f.receipt.planID).delivery as { state: string }[])[0]!.state).toBe(
    "delivered",
  )
  lost = false
  f.completeWorker(attempts[1]!.session_id)
  await settleVerification(f.runtime)
  const rows = f.store.detail(f.receipt.planID).delivery as { state: string; payload: string }[]
  // The first partial reached the inbox before its response was lost; the newer one replaced it there.
  expect(rows[0]!.state).toBe("delivered")
  expect(rows[1]!.state).toBe("delivered")
  const payload = JSON.parse(rows[1]!.payload)
  expect(payload.status).toBe("task-accepted")
  expect(payload.currentPlan.state).toBe("running")
  expect(payload.reviewableTasks.map((task: { taskID: string }) => task.taskID)).toEqual(
    f.tasks.slice(0, 2).map((task) => task.id),
  )
  expect(
    payload.reviewableTasks.every(
      (task: { artifact: string; attemptID: string }) => task.artifact && task.attemptID,
    ),
  ).toBe(true)
  expect(f.sessions.get(attempts[2]!.session_id)!.busy).toBe(true)
  expect(f.inbox.get("owner")).toHaveLength(1)
})

test("legacy partial notices for distinct tasks cannot silently replace one another", async () => {
  const f = fixture()
  for (const [index, task] of f.tasks.entries()) {
    const payload = {
      planID: f.receipt.planID,
      version: index + 1,
      status: "task-accepted",
      taskID: task.id,
      artifact: `artifact-${index}`,
    }
    f.store.atomic((db) =>
      db
        .query(
          "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,?,?,?,'pending',1)",
        )
        .run(
          `partial-${index}`,
          f.receipt.planID,
          "owner",
          `msg_partial_${index}`,
          JSON.stringify(payload),
        ),
    )
  }
  await f.runtime.tick()
  expect(
    (f.store.detail(f.receipt.planID).delivery as { state: string }[]).map((row) => row.state),
  ).toEqual(["delivered", "delivered"])
  // Distinct tasks are both reported, in the one notice the Architect receives.
  expect(f.inbox.get("owner")).toHaveLength(1)
  expect(f.notifications).toHaveLength(1)
  expect(f.notifications[0]!.text).toContain("artifact-0")
  expect(f.notifications[0]!.text).toContain("artifact-1")
})

test("completed shared plan verifies its exact artifact without touching an advanced shared checkout", async () => {
  const f = fixture({ shared: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const move = f.store.move.bind(f.store)
  let advanced = ""
  f.store.move = (planID, taskID, event, reason) => {
    const result = move(planID, taskID, event, reason)
    if (event === "ACCEPT") {
      writeFileSync(join(f.root, "reviewed-later.txt"), "keep\n")
      git(f.root, ["add", "reviewed-later.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Later reviewed work",
      ])
      advanced = git(f.root, ["rev-parse", "HEAD"])
    }
    return result
  }
  await runPlan(f)
  await drive(f.runtime)
  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.state).toBe("accepted")
  expect(plan.artifact).not.toBe(advanced)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(advanced)
  expect(readFileSync(join(f.root, "reviewed-later.txt"), "utf8")).toBe("keep\n")
  const effect = f.store.effects(plan.id).find((entry) => entry.kind === "graph-worktree")!
  expect(effect.state).toBe("completed")
  const workspace = JSON.parse(effect.receipt!).workspace
  expect(workspace).not.toBe(f.root)
  expect(git(workspace, ["rev-parse", "HEAD"])).toBe(plan.artifact!)
  const check = f.store.effects(plan.id).find((entry) => entry.kind === "graph-verify:combined")!
  expect(JSON.parse(check.receipt!).check).toMatchObject({
    cwd: workspace,
    artifact: plan.artifact,
    exitCode: 0,
  })
})

test("a retry that asks for an isolated workspace leaves the shared checkout", async () => {
  const f = fixture({ shared: true, fail: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const task = f.tasks[0]!
  await runPlan(f)
  await f.runtime.tick()
  const first = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(first.session_id)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(JSON.parse(f.store.plan(f.receipt.planID)!.body).workspaceMode).toBe("shared")

  await f.runtime.command(
    {
      requestID: "retry-isolated",
      planID: f.receipt.planID,
      action: "retry",
      taskID: task.id,
      workspaceMode: "isolated",
      reason: "Do not queue behind other plans in the shared checkout",
    },
    "owner",
  )
  expect(JSON.parse(f.store.plan(f.receipt.planID)!.body).workspaceMode).toBe("isolated")
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID).filter((a) => a.task_id === task.id)
  expect(attempts).toHaveLength(2)
  expect(attempts[1]!.workspace).not.toBe(attempts[0]!.workspace)
  expect(attempts[1]!.workspace).toContain(".worktrees")
})

test.each([1, 3])("shared resume waits for scope, not spare capacity (limit %i)", async (limit) => {
  const f = fixture({ shared: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  setProjectSetting(
    f.store.repository,
    await f.runtime.delegatedAgentCapacity.key(),
    "limit",
    limit,
  )
  await runPlan(f)
  await f.runtime.tick()
  const a = f.store.attempts(f.receipt.planID)[0]!
  Object.assign(f.sessions.get(a.session_id)!, { tokens: 777, tools: 45, cost: 3 })
  await f.runtime.command(
    {
      requestID: "cancel-a",
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
    token_count: 777,
    tool_count: 45,
    cost: 3,
  })
  const b = f.createTask("b", "b.txt")
  const planB = f.store.submit(f.inputFor([b], { requestID: "shared-b" }), "owner")
  await runPlan(f, planB.planID, "run-b")
  await f.runtime.tick()
  const other = f.store.attempts(planB.planID)[0]!
  expect(f.sessions.get(other.session_id)?.busy).toBe(true)
  await f.runtime.command(
    {
      requestID: "resume-a",
      planID: f.receipt.planID,
      action: "resume",
      taskID: a.task_id,
      workspaceMode: "shared",
      reason: "Continue retained shared work",
    },
    "owner",
  )
  expect(await f.runtime.delegatedAgentCapacity.settings()).toMatchObject({
    active: 1,
    queued: 1,
    limit,
  })
  const prompts = f.events.filter((event) => event.startsWith("prompt:")).length
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(prompts)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("preparing")
  if (limit === 3) {
    const helper = await f.runtime.delegatedAgentCapacity.ensureNativeQueued({
      parentSessionID: "scope-independent-helper",
      toolCallID: "spare-slot",
      agent: "research",
      description: "Eligible work must pass a scope-blocked resumed request",
    })
    await f.runtime.delegatedAgentCapacity.waitForNative(helper, AbortSignal.timeout(1000))
    expect(await f.runtime.delegatedAgentCapacity.settings()).toMatchObject({
      active: 2,
      queued: 0,
      limit: 3,
    })
    await f.runtime.delegatedAgentCapacity.releaseNativeRequest(helper)
  }
  f.completeWorker(other.session_id)
  await settleVerification(f.runtime)
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(prompts + 1)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  f.completeWorker(a.session_id)
  await drive(f.runtime)
})

test("reconciliation retains legacy advanced-checkout receipts and verifies the exact artifact afresh", async () => {
  const f = fixture({ shared: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const move = f.store.move.bind(f.store)
  let legacyID = ""
  f.store.move = (planID, taskID, event, reason) => {
    const result = move(planID, taskID, event, reason)
    if (event === "ACCEPT") {
      const artifact = f.store.attempts(planID)[0]!.artifact!
      writeFileSync(join(f.root, "later.txt"), "preserve\n")
      git(f.root, ["add", "later.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Later reviewed work",
      ])
      const check = f.input.verification[0]!
      legacyID = crypto.randomUUID()
      f.store.atomic((db) => {
        db.query("INSERT INTO runner_effects VALUES(?,?,NULL,NULL,?,'completed',?,?,1)").run(
          legacyID,
          planID,
          `graph-verify:${check.id}`,
          JSON.stringify({
            workspace: f.root,
            artifact,
            identity: artifact,
            check,
            receiptPath: "legacy-receipt.json",
          }),
          JSON.stringify({
            check: {
              id: check.id,
              command: check.command,
              cwd: f.root,
              artifact,
              exitCode: 0,
              timedOut: false,
              unchanged: false,
            },
          }),
        )
        db.query(
          "UPDATE runner_plans SET state='blocked',reason='Combined artifact verification failed',version=version+1 WHERE id=?",
        ).run(planID)
      })
    }
    return result
  }
  await runPlan(f)
  await f.runtime.tick()
  await settleVerification(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  await f.runtime.command(
    {
      requestID: "reconcile-legacy",
      planID: f.receipt.planID,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  const effects = f.store
    .effects(f.receipt.planID)
    .filter((effect) => effect.kind === "graph-verify:combined")
  expect(effects).toHaveLength(2)
  expect(effects.find((effect) => effect.id === legacyID)?.state).toBe("completed")
  expect(
    JSON.parse(effects.find((effect) => effect.id === legacyID)!.receipt!).check.unchanged,
  ).toBe(false)
  const fresh = JSON.parse(effects.find((effect) => effect.id !== legacyID)!.receipt!).check
  expect(fresh).toMatchObject({
    artifact: f.store.plan(f.receipt.planID)!.artifact!,
    exitCode: 0,
  })
  expect(fresh.cwd).not.toBe(f.root)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(readFileSync(join(f.root, "later.txt"), "utf8")).toBe("preserve\n")
})

test("explicit reconcile retries conclusive combined checks after environment repair without erasing evidence", async () => {
  const f = fixture({
    shared: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    requireVerifierPreparation: true,
  })
  await runPlan(f)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  const checks = () =>
    f.store.effects(f.receipt.planID).filter((effect) => effect.kind === "graph-verify:combined")
  expect(checks()).toHaveLength(1)
  const failed = checks()[0]!
  expect(JSON.parse(failed.receipt!).check.exitCode).toBe(1)
  await drive(f.runtime)
  expect(checks()).toHaveLength(1)
  writeFileSync(join(dirname(f.repository.path), "verifier-ready"), "prepared\n")
  const command = {
    requestID: "reconcile-prepared-verifier",
    planID: f.receipt.planID,
    action: "reconcile",
    reason: "Repair verifier prerequisites, not implementation",
  }
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(checks()).toHaveLength(2)
  expect(checks().find((effect) => effect.id === failed.id)?.receipt).toBe(failed.receipt)
  const fresh = checks().find((effect) => effect.id !== failed.id)!
  expect(JSON.parse(fresh.payload).verificationEpoch).toBeGreaterThan(0)
  expect(JSON.parse(fresh.receipt!).check).toMatchObject({ exitCode: 0 })
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test("uncertain prompt cannot prevent cancellation of an admitted sibling", async () => {
  const f = fixture({ independent: true, delayed: true })
  const detailedSessionIDs: string[] = []
  const session = f.host.session
  f.host.session = async (id, options) => {
    if (options?.messages) detailedSessionIDs.push(id)
    return session(id, options)
  }
  const prompt = f.host.prompt
  let release!: () => void
  const admitted = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.prompt = async (input) => {
    const attempt = f.store
      .attempts(f.receipt.planID)
      .find((entry) => entry.session_id === input.sessionID)!
    if (attempt.task_id === f.tasks[0]!.id) {
      await admitted
      throw new Error("Prompt admission response unknown")
    }
    await prompt(input)
    release()
  }
  await runPlan(f)
  await f.runtime.tick()
  const b = f.store.attempts(f.receipt.planID).find((entry) => entry.task_id === f.tasks[1]!.id)!
  expect(f.sessions.get(b.session_id)?.busy).toBe(true)
  await f.runtime.command(
    {
      requestID: "cancel-uncertain",
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.events).toContain(`stop:${b.session_id}`)
  expect(f.sessions.get(b.session_id)?.busy).toBe(false)
  expect(f.store.attempts(f.receipt.planID).find((entry) => entry.id === b.id)?.state).toBe(
    "cancelled",
  )
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
  expect(
    f.store
      .effects(f.receipt.planID)
      .some((effect) => effect.kind === "prompt" && effect.state === "uncertain"),
  ).toBe(true)
  expect(detailedSessionIDs).toContain(b.session_id)
})

test("two conflicting shared resumes use current prompt identities and cannot deadlock", async () => {
  const f = fixture({ shared: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const a = f.store.attempts(f.receipt.planID)[0]!
  await f.runtime.command(
    {
      requestID: "cancel-old-a",
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
  await drive(f.runtime, 2)
  const b = f.createTask("b", "b.txt")
  const planB = f.store.submit(f.inputFor([b], { requestID: "second-shared" }), "owner")
  await runPlan(f, planB.planID, "run-old-b")
  await f.runtime.tick()
  const other = f.store.attempts(planB.planID)[0]!
  await f.runtime.command(
    {
      requestID: "cancel-old-b",
      planID: planB.planID,
      action: "cancel",
    },
    "owner",
  )
  await drive(f.runtime, 2)
  for (const [planID, taskID] of [
    [f.receipt.planID, a.task_id],
    [planB.planID, other.task_id],
  ])
    await f.runtime.command(
      {
        requestID: `resume-${taskID}`,
        planID,
        action: "resume",
        taskID,
        workspaceMode: "shared",
        reason: "Continue stopped work",
      },
      "owner",
    )
  const count = f.events.filter((event) => event.startsWith("prompt:")).length
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(count + 1)
  const active = [a.session_id, other.session_id].filter((id) => f.sessions.get(id)?.busy)
  expect(active).toHaveLength(1)
  f.completeWorker(active[0]!)
  await drive(f.runtime, 2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(count + 2)
  const remaining = [a.session_id, other.session_id].filter((id) => f.sessions.get(id)?.busy)
  expect(remaining).toHaveLength(1)
  f.completeWorker(remaining[0]!)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.plan(planB.planID)?.state).toBe("accepted")
})

test("combined worktree completion cannot overwrite a concurrent cancellation", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  for (const attempt of f.store.attempts(f.receipt.planID)) f.completeWorker(attempt.session_id)
  const create = f.host.worktree
  f.host.worktree = async (input) => {
    const actual = await create(input)
    await f.runtime.command(
      {
        requestID: "cancel-during-combine",
        planID: f.receipt.planID,
        action: "cancel",
      },
      "owner",
    )
    expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
    return actual
  }
  await settleVerification(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.artifact).toBeNull()
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("graph-verify:")),
  ).toBe(false)
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
})

test("one failed branch blocks combined acceptance without losing sibling verification or usage", async () => {
  const f = fixture({ independent: true, delayed: true, fail: true })
  await runPlan(f)
  await f.runtime.tick()
  const [first, second] = f.store.attempts(f.receipt.planID)
  if (!first || !second) throw new Error("Expected two isolated workers")
  f.completeWorker(first.session_id)
  f.completeWorker(second.session_id)
  await settleVerification(f.runtime)

  expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual(["failed", "accepted"])
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.token_count)).toEqual([
    100, 100,
  ])
  expect(attemptCheck(f, first.task_id, first.id).exitCode).toBe(7)
  expect(attemptCheck(f, second!.task_id, second!.id).exitCode).toBe(0)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("graph-verify:")),
  ).toBe(false)
})

test("conflicting accepted branches hold integration and preserve both real Git artifacts", async () => {
  const f = fixture({
    independent: true,
    allowScopeOverlap: true,
    taskFiles: [
      { name: "a", path: "shared.txt", scope: ["shared.txt"] },
      { name: "b", path: "shared.txt", scope: ["shared.txt"] },
    ],
  })
  await runPlan(f)
  await drive(f.runtime)

  const plan = f.store.plan(f.receipt.planID)!
  const nodes = f.store.nodes(plan.id)
  expect(plan.state).toBe("blocked")
  expect(plan.reason).toContain("Conflicting accepted artifacts")
  expect(nodes.map((node) => node.state)).toEqual(["accepted", "accepted"])
  expect(nodes.every((node) => node.artifact)).toBe(true)
  expect(git(f.root, ["show", `${nodes[0]!.artifact}:shared.txt`])).toBe("a")
  expect(git(f.root, ["show", `${nodes[1]!.artifact}:shared.txt`])).toBe("b")
  expect(f.store.attempts(plan.id).every((attempt) => existsSync(attempt.workspace))).toBe(true)
  expect(
    f.store
      .effects(plan.id)
      .filter((effect) => effect.kind.startsWith("verify:"))
      .every((e) => e.state === "completed"),
  ).toBe(true)
  expect(f.store.effects(plan.id).some((effect) => effect.kind.startsWith("graph-verify:"))).toBe(
    false,
  )
})

test("lost worktree creation response resumes its own blocked startup after reconciliation", async () => {
  for (const response of [true, "empty-error"] as const) {
    const f = fixture({
      independent: true,
      delayed: true,
      loseWorktreeResponse: response,
    })
    await runPlan(f)
    await f.runtime.tick()
    const effect = f.store.effects(f.receipt.planID).find((item) => item.kind === "worktree")!
    expect(effect.state).toBe("uncertain")
    expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
    expect(f.store.plan(f.receipt.planID)!.reason).toContain(
      response === "empty-error" ? ": Error" : ": worktree response lost",
    )
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
    expect(f.store.attempts(f.receipt.planID).every((item) => item.state === "preparing")).toBe(
      true,
    )
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(0)

    f.runtime.stop()
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
      autoResumeInterrupted: false,
    })
    try {
      await reopened.tick()
      expect(f.store.effects(f.receipt.planID).find((item) => item.id === effect.id)?.state).toBe(
        "completed",
      )
      expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
      // The settled worktree effect lets the same pass prompt both workers.
      expect(f.store.attempts(f.receipt.planID).every((item) => item.state === "running")).toBe(
        true,
      )

      await reopened.tick()
      expect(f.store.attempts(f.receipt.planID).every((item) => item.state === "running")).toBe(
        true,
      )
      expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
      expect(await f.host.worktrees()).toHaveLength(3)
      expect(
        f.store.latestTransition<{ effectID: string }>(
          f.receipt.planID,
          null,
          "WORKTREE_RECOVERY_RESUMED",
        ),
      ).toMatchObject({ effectID: effect.id })
      for (const worker of f.store.attempts(f.receipt.planID)) f.completeWorker(worker.session_id)
      await drive(reopened)
      expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
    } finally {
      reopened.stop()
    }
  }
})

test("a different block reason keeps a reconciled worktree startup blocked", async () => {
  const f = fixture({
    delayed: true,
    loseWorktreeResponse: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const effect = f.store.effects(planID).find((item) => item.kind === "worktree")!
  f.store.atomic((db) =>
    db.query("UPDATE runner_plans SET reason=? WHERE id=?").run("Unrelated blocked reason", planID),
  )

  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  try {
    await reopened.tick()
    expect(f.store.effects(planID).find((item) => item.id === effect.id)?.state).toBe("completed")
    expect(f.store.plan(planID)).toMatchObject({
      state: "blocked",
      reason: "Unrelated blocked reason",
    })
    await reopened.tick()
    expect(f.store.attempts(planID).every((item) => item.state === "cancelled")).toBe(true)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(0)
  } finally {
    reopened.stop()
  }
})

test("cancelling overlapping workers waits for every native session and preserves usage", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  for (const attempt of attempts) f.sessions.get(attempt.session_id)!.tokens = 123
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.token_count)).toEqual([
    123, 123,
  ])

  await f.runtime.command(
    {
      requestID: "cancel-parallel",
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cancelling")
  expect(f.store.attempts(f.receipt.planID).every((attempt) => attempt.state === "running")).toBe(
    true,
  )
  await f.runtime.tick()

  expect(f.store.plan(f.receipt.planID)!.state).toBe("cancelled")
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual([
    "cancelled",
    "cancelled",
  ])
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.state)).toEqual([
    "cancelled",
    "cancelled",
  ])
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.token_count)).toEqual([
    123, 123,
  ])
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("graph-verify:")),
  ).toBe(false)
})

test("reviewed combined merge removes only owned Git worktrees and preserves foreign work", async () => {
  const f = fixture({ independent: true, commit: true })
  const foreignPath = join(tmpdir(), `lazers-foreign-${crypto.randomUUID()}`)
  git(f.root, ["worktree", "add", "--detach", foreignPath, f.base])
  const foreign = realpathSync(foreignPath)
  try {
    await runPlan(f)
    await drive(f.runtime)
    const artifact = f.store.plan(f.receipt.planID)!.artifact!
    const acceptedInbox = f.inbox
      .get("owner")!
      .find(
        (entry) =>
          entry.metadata &&
          "lazersPlanID" in entry.metadata &&
          entry.metadata.lazersPlanID === f.receipt.planID,
      )!
    expect(acceptedInbox.metadata?.lazersStatus).toBe("accepted")
    f.inbox.get("owner")!.push(
      { id: "msg_user_keep", type: "user", delivery: "queue" },
      {
        id: "msg_worker_keep",
        type: "synthetic",
        delivery: "queue",
        metadata: { lazersKind: "worker-prompt", lazersMessageID: "msg_worker_keep" },
      },
      {
        id: "msg_foreign_keep",
        type: "synthetic",
        delivery: "queue",
        metadata: {
          ...acceptedInbox.metadata,
          lazersPlanID: "foreign-plan",
          lazersOutboxID: "foreign-outbox",
          lazersMessageID: "msg_foreign_keep",
        },
      },
    )
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind === "graph-worktree"),
    ).toBe(true)
    git(f.root, ["merge", "--ff-only", artifact])
    await f.runtime.command(
      {
        requestID: "integrate-parallel",
        planID: f.receipt.planID,
        action: "integrated",
        artifact,
        targetBranch: "main",
        reason: "Reviewed every branch and the combined checks",
      },
      "owner",
    )
    await f.runtime.tick()

    expect(f.store.plan(f.receipt.planID)!.state).toBe("integrated")
    const outbox = f.store.detail(f.receipt.planID).delivery as {
      payload: string
      state: string
      message_id: string
    }[]
    // The accepted notice reached the inbox; the integrated one replaced it there.
    expect(outbox.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe(
      "delivered",
    )
    expect(outbox.find((row) => JSON.parse(row.payload).status === "integrated")?.state).toBe(
      "delivered",
    )
    expect(f.inbox.get("owner")?.map((entry) => entry.id)).toEqual([
      "msg_user_keep",
      "msg_worker_keep",
      "msg_foreign_keep",
      outbox.find((row) => JSON.parse(row.payload).status === "integrated")!.message_id,
    ])
    const removals = f.store
      .effects(f.receipt.planID)
      .filter((effect) => effect.kind === "worktree-remove")
    expect(removals).toHaveLength(3)
    expect(removals.every((effect) => JSON.parse(effect.receipt!).native === true)).toBe(true)
    expect(await f.host.worktrees()).toEqual([f.root, foreign])
  } finally {
    if (existsSync(foreign)) git(f.root, ["worktree", "remove", foreign])
  }
})

test("repairing one parallel branch retains its failed check and usage while its sibling is accepted", async () => {
  const f = fixture({ independent: true, delayed: true, wrongFirstA: true, repair: true })
  await runPlan(f)
  await f.runtime.tick()
  const initial = f.store.attempts(f.receipt.planID)
  f.completeWorker(initial[0]!.session_id)
  f.completeWorker(initial[1]!.session_id)
  await settleVerification(f.runtime)
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual(["running", "accepted"])
  expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
  expect(attemptCheck(f, initial[0]!.task_id, initial[0]!.id).exitCode).not.toBe(0)

  await f.runtime.tick()
  const repaired = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === initial[0]!.task_id)
    .at(-1)!
  expect(
    f.store.attempts(f.receipt.planID).filter((attempt) => attempt.task_id === repaired.task_id),
  ).toHaveLength(2)
  f.completeWorker(repaired.session_id)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  const attempts = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === repaired.task_id)
  expect(attempts[0]!.token_count).toBe(100)
  expect(attemptCheck(f, attempts[0]!.task_id, attempts[0]!.id).exitCode).not.toBe(0)
  expect(attemptCheck(f, attempts[1]!.task_id, attempts[1]!.id).exitCode).toBe(0)
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual([
    "accepted",
    "accepted",
  ])
})

test("missing and permission-denied skill suggestions never block admission or dispatch", async () => {
  for (const skillSuggestions of [
    [],
    ["missing-skill — Optional but not installed"],
    ["denied-skill — Optional and may not be permitted"],
  ]) {
    const f = fixture({ skillSuggestions })
    await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
    await driveWithTaskSourceLandings(f)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
    for (const attempt of f.store.attempts(f.receipt.planID)) {
      expectNoSkillBody(attempt.policy)
      expect(
        JSON.parse(JSON.parse(attempt.policy).context).specification.requirements.skills,
      ).toEqual(skillSuggestions)
    }
  }
})
