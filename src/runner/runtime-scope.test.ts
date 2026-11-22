import { expect, test } from "bun:test"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { HostSession } from "./host.ts"
import { RunnerStore } from "./store.ts"
import type { RunnerCheckReceipt } from "./artifacts.ts"
import { EffectReconciliation } from "./effect-reconciliation.ts"
import { getTaskDetail } from "../tasks/stream-query.ts"
import { taskInstructions } from "../tasks/instructions.ts"
import { settleVerification } from "../../test/runner/verification-driver.ts"
import {
  TaskRuntime,
  acceptedScope,
  cleanup,
  drive,
  fixture,
  runPlan,
  taskEvents,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("active scope amendments durably update the same worker after it fetched old instructions and survive reopen", async () => {
  const f = fixture({
    delayed: true,
    outside: true,
    repair: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(planID)[0]!
  const original = f.repository.get(attempt.task_id)
  const fetched = taskInstructions(await getTaskDetail(f.repository, { taskID: attempt.task_id }))
  expect(fetched).not.toContain("escape.txt")
  const command = {
    requestID: "allow-test",
    planID,
    action: "amend-scope",
    taskID: attempt.task_id,
    scopeAdditions: ["escape.txt"],
    reason: "Keep the reviewed legitimate dependency test.",
  }
  const result = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(result)
  const effects = f.store.effects(planID).filter((effect) => effect.kind === "scope-instruction")
  expect(effects).toHaveLength(1)
  expect(effects[0]!.state).toBe("intended")
  expect(f.instructions.size).toBe(0)
  expect(f.store.attempts(planID)).toHaveLength(1)
  await f.runtime.stop()
  const repository = new TaskRepository(f.repository.path, f.root)
  const store = new RunnerStore(repository)
  store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const runtime = new TaskRuntime(store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  try {
    await drive(runtime, 3)
    const effect = store.effects(planID).find((item) => item.id === effects[0]!.id)!
    expect(effect.state).toBe("completed")
    expect(JSON.parse(effect.receipt!)).toMatchObject({
      nativeEntryConfirmed: true,
      modelConsumption: "unknown",
    })
    const entries = [...f.instructions.get(attempt.session_id)!.values()]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain(attempt.task_id)
    expect(entries[0]).toContain(attempt.id)
    expect(entries[0]).toContain('["a.txt","escape.txt"]')
    expect(entries[0]).toContain("original acceptance and verification")
    expect(f.sessions.get(attempt.session_id)!.busy).toBe(true)
    expect(
      f.events.filter(
        (event) =>
          event.startsWith("create:") || event.startsWith("prompt:") || event.startsWith("stop:"),
      ),
    ).toHaveLength(2)
    expect(store.attempts(planID)).toHaveLength(1)
    expect(repository.get(attempt.task_id)).toEqual(original)
    f.completeWorker(attempt.session_id)
    await drive(runtime, 5)
    expect(store.plan(planID)!.state).toBe("accepted")
    expect(store.attempts(planID)).toHaveLength(1)
    const progress = store.progressFacts([attempt.id])
    expect(progress.map((fact) => fact.kind)).toContain("artifact")
    expect(progress.map((fact) => fact.kind)).toContain("verification")
    expect(progress.some((fact) => JSON.parse(fact.payload).outcome === "accepted")).toBe(true)
    expect(JSON.parse(progress.find((fact) => fact.kind === "verification")!.payload).result).toBe(
      "passed",
    )
  } finally {
    await runtime.stop()
    repository.close()
  }
})

test("failed and lost scope-update replies recover keyed delivery without workers, repairs or wait churn", async () => {
  for (const lostResponse of [false, true]) {
    const f = fixture({ delayed: true, repair: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const planID = f.receipt.planID
    await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
    await drive(f.runtime, 2)
    const attempt = f.store.attempts(planID)[0]!
    const originalUpdate = f.host.updateInstruction
    let unavailable = true
    f.host.updateInstruction = async (input) => {
      if (!unavailable || lostResponse) await originalUpdate(input)
      if (unavailable) throw new Error("Native update response unavailable")
    }
    await f.runtime.command(
      {
        requestID: "allow-test",
        planID,
        action: "amend-scope",
        taskID: attempt.task_id,
        scopeAdditions: ["dependency.test.ts"],
        reason: "Reviewed test.",
      },
      "owner",
    )
    await f.runtime.tick()
    const blocked = f.store.plan(planID)!
    expect(blocked.state).toBe("blocked")
    expect(f.store.effects(planID).at(-1)!.state).toBe("uncertain")
    expect(f.instructions.size).toBe(Number(lostResponse))
    await drive(f.runtime, 3)
    expect(f.store.plan(planID)!.version).toBe(blocked.version)
    unavailable = false
    await f.runtime.stop()
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
      autoResumeInterrupted: false,
    })
    try {
      await drive(reopened, 2)
      expect(f.store.effects(planID).at(-1)!.state).toBe("completed")
      expect(f.events.filter((event) => event.startsWith("instruction:"))).toHaveLength(1)
      await reopened.command(
        {
          requestID: "resume-after-receipt",
          planID,
          action: "reconcile",
        },
        "owner",
      )
      expect(f.store.plan(planID)!.state).toBe("running")
      expect(f.store.attempts(planID)).toHaveLength(1)
      expect(f.store.attempts(planID)[0]!.id).toBe(attempt.id)
      expect(
        f.events.filter((event) => event.startsWith("create:") || event.startsWith("prompt:")),
      ).toHaveLength(2)
      expect(
        f.store.activity(planID, attempt.task_id).filter((event) => event.event === "REPAIR"),
      ).toHaveLength(0)
      expect(f.sessions.get(attempt.session_id)!.busy).toBe(true)
    } finally {
      await reopened.stop()
    }
  }
})

test("cancellation suppresses a pending scope instruction rather than waking a stopped worker", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  await f.runtime.command(
    {
      requestID: "allow-test",
      planID,
      action: "amend-scope",
      taskID: f.tasks[0]!.id,
      scopeAdditions: ["dependency.test.ts"],
      reason: "Reviewed test.",
    },
    "owner",
  )
  await f.runtime.command(
    {
      requestID: "cancel",
      planID,
      action: "cancel",
    },
    "owner",
  )
  await drive(f.runtime, 4)
  expect(f.instructions.size).toBe(0)
  const effect = f.store.effects(planID).find((item) => item.kind === "scope-instruction")!
  expect(effect.state).toBe("completed")
  expect(JSON.parse(effect.receipt!).skipped).toBe(true)
  expect(f.store.attempts(planID)).toHaveLength(1)
})

test("task integration records a reviewed landing without finalizing the plan or disturbing active dependencies", async () => {
  const f = fixture({ delayed: true })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  const first = f.store.attempts(planID)[0]!
  f.completeWorker(first.session_id)
  await drive(f.runtime, 3)
  const node = f.store.nodes(planID)[0]!
  const successorTaskID = f.tasks[1]!.id
  expect(node.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.execution(successorTaskID)?.waitingOn).toEqual([node.task_id])
  const command = {
    requestID: "land-first",
    planID,
    action: "integrated",
    taskID: node.task_id,
    artifact: node.artifact!,
    targetBranch: "main",
    reason: "Reviewed accepted task and passing checks.",
  }
  await expect(f.runtime.command(command, "other")).rejects.toThrow(
    "A live Architect session of this project must command the plan",
  )
  await expect(f.runtime.command({ ...command, taskID: successorTaskID }, "owner")).rejects.toThrow(
    "accepted task",
  )
  await expect(f.runtime.command({ ...command, artifact: f.base }, "owner")).rejects.toThrow(
    "accepted task artifact",
  )
  await expect(f.runtime.command({ ...command, targetBranch: "other" }, "owner")).rejects.toThrow(
    "reviewed target branch",
  )
  await expect(f.runtime.command(command, "owner")).rejects.toThrow()
  git(f.root, ["merge", "--ff-only", node.artifact!])
  expect(f.store.attempts(planID)).toHaveLength(1)
  const before = structuredClone({
    plan: f.store.plan(planID),
    nodes: f.store.nodes(planID),
    attempts: f.store.attempts(planID),
    sessions: [...f.sessions],
    events: f.events,
  })
  const result = await f.runtime.command(command, "owner")
  expect(result).toMatchObject({
    status: "task-integration-recorded",
    version: before.plan!.version + 1,
  })
  expect(await f.runtime.command(command, "owner")).toEqual(result)
  expect(f.store.plan(planID)).toEqual({ ...before.plan!, version: before.plan!.version + 1 })
  expect(f.store.nodes(planID)).toEqual(before.nodes)
  expect(f.store.attempts(planID)).toEqual(before.attempts)
  expect([...f.sessions]).toEqual(before.sessions)
  expect(f.events).toEqual(before.events)
  expect(existsSync(first.workspace)).toBe(true)
  expect(f.store.execution(successorTaskID)?.waitingOn).toEqual([])
  expect(
    f.store
      .activity(planID, node.task_id)
      .filter((event) => event.event === "TASK_INTEGRATION_RECORDED"),
  ).toHaveLength(1)
  await f.runtime.tick()
  expect(f.store.attempts(planID)).toHaveLength(2)
  expect(f.store.attempts(planID)[1]!.base_commit).toBe(git(f.root, ["rev-parse", "HEAD"]))
})

test("a new file beside the scoped file is accepted with no hold and shown in the acceptance notice", async () => {
  const f = fixture({ outside: true, repair: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await drive(f.runtime, 5)
  expect(f.store.plan(planID)!.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(taskEvents(f, planID, task.id, "SCOPE_DECISION_REQUIRED")).toHaveLength(0)
  const scope = acceptedScope(f, planID)!
  expect(scope.created).toEqual([{ path: "escape.txt", class: "allowed-new" }])
  expect(scope.divergences).toEqual([])
})

test("a created file named in createScope is expected, and an expected file never created is noted", async () => {
  const f = fixture({
    outside: true,
    createScope: [
      { path: "escape.txt", purpose: "the escape helper" },
      { path: "never.txt", purpose: "not created" },
    ],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await drive(f.runtime, 5)
  expect(f.store.plan(planID)!.state).toBe("accepted")
  const scope = acceptedScope(f, planID)!
  expect(scope.created).toEqual([
    { path: "escape.txt", class: "expected-new", purpose: "the escape helper" },
  ])
  expect(scope.missingExpected).toEqual([{ path: "never.txt", purpose: "not created" }])
})

test("a protected change holds without spending repair; naming the exact path releases it", async () => {
  const f = fixture({
    outside: true,
    repair: true,
    protectedScope: ["escape.txt"],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await drive(f.runtime, 4)
  const blocked = f.store.plan(planID)!
  const first = f.store.attempts(planID)[0]!
  expect(blocked.state).toBe("blocked")
  expect(blocked.reason).toContain("protected paths")
  expect(blocked.reason).toContain("escape.txt")
  expect(first.state).toBe("verifying")
  expect(taskEvents(f, planID, task.id, "REPAIR")).toHaveLength(0)
  expect(taskEvents(f, planID, task.id, "SCOPE_DECISION_REQUIRED")[0]!.payload).toContain(
    '"kind":"protected"',
  )
  const history = f.store.activity(planID, task.id)
  await drive(f.runtime, 5)
  expect(f.store.plan(planID)!.version).toBe(blocked.version)
  expect(f.store.activity(planID, task.id)).toEqual(history)
  // A glob does not release protection; an exact reviewed path does.
  await f.runtime.command(
    {
      requestID: "authorize-dependency",
      planID,
      action: "amend-scope",
      taskID: task.id,
      scopeAdditions: ["escape.txt"],
      reason: "Reviewed dependency belongs to this implementation.",
    },
    "owner",
  )
  await drive(f.runtime, 2)
  await f.runtime.command({ requestID: "review-candidate", planID, action: "reconcile" }, "owner")
  await drive(f.runtime, 5)
  expect(f.store.plan(planID)!.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
})

test("an edit to an existing file outside the scope does not block: the Architect accepts it with a recorded amendment", async () => {
  const f = fixture({
    writes: [{ path: "seed.txt", content: "changed by the worker\n" }],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await drive(f.runtime, 4)
  // Checks ran on the whole change and passed; only the decision is outstanding.
  const blocked = f.store.plan(planID)!
  const attempt = f.store.attempts(planID)[0]!
  expect(blocked.state).toBe("blocked")
  expect(blocked.reason).toStartWith("Scope divergence needs a decision")
  expect(blocked.reason).toContain("seed.txt (existing file, modified")
  expect(attempt.state).toBe("verifying")
  expect(f.store.nodes(planID)[0]!.state).toBe("verifying")
  expect(
    f.store
      .effects(planID)
      .some((effect) => effect.kind === "verify:content" && effect.state === "completed"),
  ).toBe(true)
  expect(taskEvents(f, planID, task.id, "REPAIR")).toHaveLength(0)
  const required = JSON.parse(
    taskEvents(f, planID, task.id, "SCOPE_DECISION_REQUIRED").at(-1)!.payload,
  )
  expect(required).toMatchObject({ kind: "divergence", paths: ["seed.txt"] })
  const detail = f.store.detail(planID) as { delivery: { payload: string }[] }
  const notice = detail.delivery
    .map((row) => JSON.parse(row.payload))
    .findLast((p) => p.status === "blocked")
  expect(notice.allowedActions).toEqual(
    expect.arrayContaining(["amend-scope", "retained-repair", "reconcile", "cancel"]),
  )
  // It waits, with no churn.
  const history = f.store.activity(planID, task.id)
  await drive(f.runtime, 5)
  expect(f.store.plan(planID)!.version).toBe(blocked.version)
  expect(f.store.activity(planID, task.id)).toEqual(history)
  // It is recoverable from the bundle while nobody answers.
  const { RecoveryBundles } = await import("./recovery-bundle.ts")
  const bundles = new RecoveryBundles({
    store: f.store,
    host: f.host,
    directory: f.root,
    projectID: "project",
    owner: "owner",
    now: () => Date.now() + 3 * 60 * 60 * 1000,
    validArchitect: (session): session is HostSession =>
      Boolean(session && !session.archived && session.agent === "architect"),
    ensureArchitectOwner: async () => f.sessions.get("owner")!,
  })
  const items = await bundles.collect()
  expect(items.find((item) => item.planID === planID)).toMatchObject({
    holdFamily: "scope-divergence",
    recommendation: { action: "amend-scope" },
  })
  await f.runtime.command(
    {
      requestID: "accept-divergence",
      planID,
      action: "amend-scope",
      taskID: task.id,
      scopeAdditions: ["seed.txt"],
      reason: "The seed file needs the matching change.",
    },
    "owner",
  )
  // The amendment is the decision: the verified candidate continues with no separate reconcile.
  await drive(f.runtime, 5)
  expect(f.store.plan(planID)!.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  const scope = acceptedScope(f, planID)!
  expect(scope.divergences).toEqual([])
  expect(scope.accepted).toEqual([
    { path: "seed.txt", reason: "The seed file needs the matching change." },
  ])
})

test("an additive scope amendment after preparation and checks continues the same candidate", async () => {
  const f = fixture({
    taskFiles: [{ name: "a", path: "src/change.ts" }],
    writes: [{ path: "seed.ts", content: "export const seed=1\n" }],
    checkCommand: "bun fmt --check src/change.ts seed.ts",
    combinedCheckCommand: "true",
  })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  await runPlan(f)
  await drive(f.runtime, 5)

  const blocked = f.store.plan(planID)!
  const attempt = f.store.attempts(planID)[0]!
  const preparation = f.store.effects(planID).filter((effect) => effect.kind === "mechanical-fix")
  const checks = f.store.effects(planID).filter((effect) => effect.kind === "verify:content")
  expect(blocked.state).toBe("blocked")
  expect(blocked.reason).toStartWith("Scope divergence needs a decision")
  expect(attempt.state).toBe("verifying")
  expect(preparation).toHaveLength(1)
  expect(preparation[0]!.state).toBe("completed")
  expect(checks).toHaveLength(1)
  expect(checks[0]!.state).toBe("completed")
  const prompts = f.events.filter((event) => event.startsWith("prompt:")).length
  const workerSessionID = attempt.session_id

  await f.runtime.command(
    {
      requestID: "amend-after-verified-candidate",
      planID,
      action: "amend-scope",
      taskID: task.id,
      scopeAdditions: ["seed.ts"],
      reason: "The verified seed adjustment is needed by the implementation.",
    },
    "owner",
  )
  const receiptCheck = (JSON.parse(preparation[0]!.receipt!) as { check: RunnerCheckReceipt }).check
  const reconciliation = Reflect.get(f.runtime, "effectReconciliation") as EffectReconciliation
  expect(
    await reconciliation.checkReceiptMatchesEffect(
      preparation[0]!,
      JSON.parse(preparation[0]!.payload),
      receiptCheck,
    ),
  ).toBe(true)
  await drive(f.runtime, 6)

  expect(f.store.plan(planID)!.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]!.id).toBe(attempt.id)
  expect(f.store.effects(planID).filter((effect) => effect.kind === "mechanical-fix")).toHaveLength(
    1,
  )
  expect(f.store.effects(planID).filter((effect) => effect.kind === "verify:content")).toHaveLength(
    1,
  )
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(prompts)
  expect(f.store.attempts(planID)[0]!.session_id).toBe(workerSessionID)
  expect(acceptedScope(f, planID)?.accepted).toEqual([
    {
      path: "seed.ts",
      reason: "The verified seed adjustment is needed by the implementation.",
    },
  ])
})

test("an additive scope amendment cannot reuse preparation after the candidate input changes", async () => {
  const f = fixture({
    taskFiles: [{ name: "a", path: "src/change.ts" }],
    writes: [{ path: "seed.ts", content: "export const seed=1\n" }],
    checkCommand: "bun fmt --check src/change.ts seed.ts",
    combinedCheckCommand: "true",
  })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  await runPlan(f)
  await drive(f.runtime, 5)
  const attempt = f.store.attempts(planID)[0]!
  expect(f.store.plan(planID)!.state).toBe("blocked")
  expect(f.store.effects(planID).find((effect) => effect.kind === "mechanical-fix")?.state).toBe(
    "completed",
  )
  expect(f.store.effects(planID).find((effect) => effect.kind === "verify:content")?.state).toBe(
    "completed",
  )
  writeFileSync(join(attempt.workspace, "src/change.ts"), "export const changedAfterCheck = 1\n")

  await f.runtime.command(
    {
      requestID: "amend-after-candidate-input-change",
      planID,
      action: "amend-scope",
      taskID: task.id,
      scopeAdditions: ["seed.ts"],
      reason: "Accept the seed file, but do not accept changes after its checks.",
    },
    "owner",
  )
  await drive(f.runtime, 4)

  expect(f.store.plan(planID)!.state).toBe("blocked")
  expect(f.store.plan(planID)!.reason).toContain(
    "Mechanical candidate changed after its authorized fix receipt",
  )
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.effects(planID).filter((effect) => effect.kind === "mechanical-fix")).toHaveLength(
    1,
  )
  expect(f.store.effects(planID).filter((effect) => effect.kind === "verify:content")).toHaveLength(
    1,
  )
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test("a divergence rides in the one combined repair with the failing check and is cleared when moved back", async () => {
  const marker = join(tmpdir(), `lazers-scope-tries-${crypto.randomUUID()}`)
  cleanup.push(() => rmSync(marker, { force: true }))
  const f = fixture({
    repair: true,
    writes: [
      { path: "seed.txt", content: "changed by the worker\n", attempt: 1 },
      { path: "seed.txt", content: "baseline\n", attempt: 2 },
    ],
    taskFiles: [{ name: "a", path: "a.txt" }],
    checkCommand: (_name, path) =>
      `[ -f '${marker}' ] || { touch '${marker}'; echo first-try-fails; exit 7; }; test "$(cat ${path})" = "a"`,
  })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await f.runtime.tick()
  await settleVerification(f.runtime)
  const repairs = taskEvents(f, planID, task.id, "REPAIR")
  expect(repairs).toHaveLength(1)
  expect(JSON.stringify(repairs[0])).toContain(
    "Scope divergence: 1 change(s) outside the task's scope",
  )
  const attempts = f.store.attempts(planID)
  expect(attempts).toHaveLength(2)
  await f.runtime.tick()
  const prompt = f.sessions.get(attempts[1]!.session_id)!.messages[0]!.text
  expect(prompt).toContain("first-try-fails")
  expect(prompt).toContain(
    "These changes are outside the task's scope: move/remove them or say why they are needed.",
  )
  expect(prompt).toContain("seed.txt (existing file, modified")
  f.completeWorker(attempts[1]!.session_id)
  await settleVerification(f.runtime)
  await drive(f.runtime, 3)
  expect(f.store.plan(planID)!.state).toBe("accepted")
  expect(taskEvents(f, planID, task.id, "SCOPE_DECISION_REQUIRED")).toHaveLength(0)
})

test("a divergence alone holds for the Architect with the repair unspent and the worker's reason quoted", async () => {
  const f = fixture({
    repair: true,
    writes: [{ path: "seed.txt", content: "kept on purpose\n" }],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await f.runtime.tick()
  const session = f.store.attempts(planID)[0]!.session_id
  f.sessions.get(session)!.messages.push({
    id: "final",
    text: "Done. seed.txt changed because the seed must match a.txt.",
  })
  await settleVerification(f.runtime)
  await drive(f.runtime, 3)
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(taskEvents(f, planID, task.id, "REPAIR")).toHaveLength(0)
  const plan = f.store.plan(planID)!
  expect(plan.state).toBe("blocked")
  expect(plan.reason).toStartWith("Scope divergence needs a decision")
  expect(plan.reason).toContain("seed must match a.txt")
  expect(plan.reason).toContain("(final message)")
})

test("a held divergence says no reason given when the worker gave none", async () => {
  const f = fixture({
    repair: true,
    writes: [{ path: "seed.txt", content: "x\n" }],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await drive(f.runtime, 4)
  expect(f.store.plan(f.receipt.planID)!.reason).toContain("Worker's reason: no reason given")
})

test("retained-repair sends a held divergence back through the one repair; it then clears or returns to the Architect", async () => {
  for (const keeps of [false, true]) {
    const f = fixture({
      repair: true,
      writes: [
        { path: "seed.txt", content: "changed\n", attempt: 1 },
        { path: "seed.txt", content: keeps ? "changed again\n" : "baseline\n", attempt: 2 },
      ],
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    const planID = f.receipt.planID
    const task = f.tasks[0]!
    await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
    await drive(f.runtime, 4)
    const held = f.store.attempts(planID)[0]!
    expect(f.store.plan(planID)!.state).toBe("blocked")
    await f.runtime.command(
      {
        requestID: "send-back",
        planID,
        action: "retained-repair",
        taskID: task.id,
        attemptID: held.id,
        artifact: held.artifact!,
        reason: "Keep the seed file untouched.",
      },
      "owner",
    )
    expect(taskEvents(f, planID, task.id, "SCOPE_SENT_BACK")).toHaveLength(1)
    await f.runtime.tick()
    const attempts = f.store.attempts(planID)
    expect(attempts).toHaveLength(2)
    const prompt = f.sessions.get(attempts[1]!.session_id)!.messages[0]!.text
    expect(prompt).toContain(
      "These changes are outside the task's scope: move/remove them or say why they are needed.",
    )
    expect(prompt).toContain("seed.txt (existing file, modified")
    expect(prompt).toContain("Architect: Keep the seed file untouched.")
    f.completeWorker(attempts[1]!.session_id)
    await settleVerification(f.runtime)
    await drive(f.runtime, 4)
    const plan = f.store.plan(planID)!
    if (!keeps) expect(plan.state).toBe("accepted")
    else {
      // Back with the Architect: accept or cancel remain; a second send-back is refused.
      expect(plan.state).toBe("blocked")
      expect(plan.reason).toStartWith("Scope divergence needs a decision")
      await expect(
        f.runtime.command(
          {
            requestID: "send-back-again",
            planID,
            action: "retained-repair",
            taskID: task.id,
            attemptID: attempts[1]!.id,
            artifact: f.store.attempts(planID)[1]!.artifact!,
            reason: "Again.",
          },
          "owner",
        ),
      ).rejects.toThrow("one repair is spent")
      await f.runtime.command(
        {
          requestID: "accept",
          planID,
          action: "amend-scope",
          taskID: task.id,
          scopeAdditions: ["seed.txt"],
          reason: "Needed after all.",
        },
        "owner",
      )
      await drive(f.runtime, 5)
      expect(f.store.plan(planID)!.state).toBe("accepted")
    }
  }
})

test("reservations include created paths, so two tasks creating in one folder run serially", async () => {
  const options = {
    delayed: true,
    independent: true,
    taskFiles: [
      { name: "a", path: "a.txt" },
      { name: "b", path: "b.txt" },
    ],
  }
  const free = fixture(options)
  await free.runtime.command(
    { requestID: "run", planID: free.receipt.planID, action: "run" },
    "owner",
  )
  await drive(free.runtime, 3)
  expect(free.store.attempts(free.receipt.planID).length).toBe(2)
  const f = fixture({ ...options, createScope: [{ path: "shared/", purpose: "new shared code" }] })
  expect(f.store.effectiveReservationScope(f.tasks[0]!.id)).toEqual(["a.txt", "shared/**"])
  expect(f.store.effectiveWriteScope(f.tasks[0]!.id)).toEqual(["a.txt"])
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await drive(f.runtime, 3)
  expect(f.store.attempts(f.receipt.planID).length).toBe(1)
})

test("scope amendments preserve the specification and recover dependency edits in the same attempt", async () => {
  const f = fixture({ outside: true, delayed: true })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  const original = f.repository.get(task.id)
  await f.runtime.command({ requestID: "scope-run", planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(planID)[0]!
  expect(attempt.state).toBe("running")
  const command = {
    requestID: "allow-dependency",
    planID,
    action: "amend-scope" as const,
    taskID: task.id,
    scopeAdditions: ["escape.txt"],
    reason: "The existing implementation needs this dependency file.",
  }
  await expect(f.runtime.command(command, "other-owner")).rejects.toThrow(
    "A live Architect session of this project must command the plan",
  )
  await expect(
    f.runtime.command({ ...command, scopeAdditions: ["../outside"] }, "owner"),
  ).rejects.toThrow()
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  expect(f.repository.get(task.id)).toEqual(original)
  expect(f.store.effectiveWriteScope(task.id)).toEqual(["a.txt", "escape.txt"])
  const reopenedRepository = new TaskRepository(f.repository.path, f.root)
  try {
    const reopened = new RunnerStore(reopenedRepository)
    expect(reopened.effectiveWriteScope(task.id)).toEqual(["a.txt", "escape.txt"])
    expect(reopenedRepository.get(task.id)).toEqual(original)
  } finally {
    reopenedRepository.close()
  }
  expect(taskInstructions(await getTaskDetail(f.repository, { taskID: task.id }))).toContain(
    "Authorized execution scope",
  )
  expect(
    f.store.activity(planID, task.id).filter((event) => event.event === "SCOPE_AMENDED"),
  ).toHaveLength(1)
  const now = f.store.plan(planID)!.version
  const unchanged = await f.runtime.command({ ...command, requestID: "duplicate-path" }, "owner")
  expect(unchanged).toMatchObject({ status: "scope-unchanged", version: now })
  f.completeWorker(attempt.session_id)
  await drive(f.runtime, 2)
  expect(f.store.nodes(planID)[0]!.state).toBe("accepted")
  expect(f.store.attempts(planID).filter((item) => item.task_id === task.id)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("stop:"))).toHaveLength(1)
  expect(f.store.effectiveWriteScope(f.tasks[1]!.id)).toEqual(["b.txt"])
  await expect(
    f.runtime.command(
      {
        ...command,
        requestID: "too-late",
        scopeAdditions: ["another.txt"],
      },
      "owner",
    ),
  ).rejects.toThrow("unfinished work")
})

test("scope amendment rejects active overlap and reserves amended scope before later dispatch", async () => {
  const f = fixture({ independent: true, delayed: true })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "scope-run", planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  expect(f.store.attempts(planID)).toHaveLength(2)
  const version = f.store.plan(planID)!.version
  await expect(
    f.runtime.command(
      {
        requestID: "conflicting-amendment",
        planID,
        action: "amend-scope",
        taskID: f.tasks[0]!.id,
        scopeAdditions: ["b.txt"],
        reason: "Would overlap active work.",
      },
      "owner",
    ),
  ).rejects.toThrow("conflicts with active task")
  expect(f.store.plan(planID)!.version).toBe(version)
  expect(f.store.effectiveWriteScope(f.tasks[0]!.id)).toEqual(["a.txt"])

  const queued = fixture({ independent: true, delayed: true })
  const queuedPlan = queued.receipt.planID
  await queued.runtime.command(
    {
      requestID: "queued-amendment",
      planID: queuedPlan,
      action: "amend-scope",
      taskID: queued.tasks[0]!.id,
      scopeAdditions: ["b.txt"],
      reason: "Reserve dependency before dispatch.",
    },
    "owner",
  )
  await queued.runtime.command(
    { requestID: "queued-run", planID: queuedPlan, action: "run" },
    "owner",
  )
  await drive(queued.runtime, 2)
  expect(queued.store.attempts(queuedPlan)).toHaveLength(1)
  expect(queued.store.attempts(queuedPlan)[0]!.task_id).toBe(queued.tasks[0]!.id)
})

test("scope amendment requires this plan's unfinished task and explicit additive authorization", async () => {
  const f = fixture({ delayed: true })
  const planID = f.receipt.planID
  const command = {
    requestID: "invalid-scope",
    planID,
    action: "amend-scope",
    taskID: crypto.randomUUID(),
    scopeAdditions: ["dependency.ts"],
    reason: "Authorize dependency.",
  }
  await expect(f.runtime.command(command, "owner")).rejects.toThrow("unfinished work")
  await expect(
    f.runtime.command(
      {
        requestID: command.requestID,
        planID,
        action: "amend-scope",
        taskID: f.tasks[0]!.id,
        scopeAdditions: command.scopeAdditions,
      },
      "owner",
    ),
  ).rejects.toThrow("requires task")
  await expect(
    f.runtime.command({ ...command, taskID: f.tasks[0]!.id, scopeAdditions: [] }, "owner"),
  ).rejects.toThrow()
  expect(f.store.plan(planID)!.version).toBe(1)
})

test("a write-scope overlap during mechanical preparation is a warning and never a hold", async () => {
  const f = fixture({
    taskFiles: [{ name: "a", path: "src/result.ts" }],
    checkCommand: "bun fmt --check src/result.ts",
    combinedCheckCommand: "test -f src/result.ts",
  })
  // Another active attempt reserves an overlapping scope.
  ;(
    Reflect.get(f.runtime, "dispatchModule") as {
      preparationAllowed: (attempt: { state: string }) => boolean
    }
  ).preparationAllowed = (attempt) => attempt.state !== "verifying"
  await runPlan(f)
  await drive(f.runtime, 18)
  const plan = f.store.plan(f.receipt.planID)!
  const attempt = f.store.attempts(plan.id)[0]!
  expect(plan.state).toBe("accepted")
  expect(plan.reason ?? "").not.toContain("scope reservation")
  expect(f.store.latestTransition(plan.id, attempt.task_id, "SCOPE_OVERLAP_WARNING")).toMatchObject(
    {
      attemptID: attempt.id,
    },
  )
})
