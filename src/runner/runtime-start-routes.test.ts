import { expect, test } from "bun:test"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"

import type { RunnerHost } from "./host.ts"
import { RunnerStore } from "./store.ts"
import { PlanInput } from "./schema.ts"
import type { WorkerPersona } from "./schema.ts"
import { TaskReads } from "../tasks/read.ts"
import { sharedScheduler, schedulerProjectKey } from "./scheduler-coordinator.ts"
import { ModelMappingStore } from "../models/mapping-store.ts"
import {
  TaskRuntime,
  cleanup,
  codeProject,
  drive,
  fixture,
  holdInterruptedAttempt,
  runPlan,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("shared scheduler routes manual Start through its elected runtime instead of a second lease owner", async () => {
  const f = fixture({ shared: true, startOnly: true, delayed: true })
  const leader = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  const registration = sharedScheduler.register(
    schedulerProjectKey(f.repository.path, f.root, "project"),
    { intervalMs: 2000, run: () => leader.tick() },
  )
  const follower = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    requestTick: () => registration.runNow(),
  })
  try {
    const result = await follower.startTask({
      taskID: f.tasks[0]!.id,
      revision: 1,
      sessionID: "owner",
    })
    expect(result.status).toBe("started")
    expect(f.store.attempts(result.planID)).toHaveLength(1)
    expect(f.events.filter((event) => event.startsWith("start:"))).toHaveLength(1)
    expect(
      f.repository.atomic((db) =>
        db
          .query<{ owner: string }, [string]>(
            "SELECT owner FROM runner_leases WHERE project_directory=?",
          )
          .get(f.root),
      )?.owner,
    ).toBe(leader.owner)
    expect(leader.owner).not.toBe(follower.owner)
  } finally {
    await registration.dispose()
    await leader.stop()
    await follower.stop()
  }
})

test("a disposed follower Start cannot read or reopen its store after the elected drain finishes", async () => {
  const f = fixture({ shared: true, startOnly: true, delayed: true })
  const followerRepository = new TaskRepository(f.repository.path, f.root)
  const followerStore = new RunnerStore(followerRepository)
  const leader = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const running = new Promise<void>((resolve) => {
    entered = resolve
  })
  const key = schedulerProjectKey(f.repository.path, f.root, "project")
  const leaderRegistration = sharedScheduler.register(key, {
    intervalMs: 2000,
    run: async () => {
      entered()
      await gate
      await leader.tick()
    },
  })
  const followerRegistration = sharedScheduler.register(key, {
    intervalMs: 2000,
    run: () => follower.tick(),
  })
  const follower = new TaskRuntime(followerStore, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    requestTick: () => followerRegistration.runNow(),
  })
  let closed = false,
    postCloseReads = 0
  const execution = followerStore.execution.bind(followerStore)
  followerStore.execution = (...args) => {
    if (closed) {
      postCloseReads++
      throw new Error("post-close execution read")
    }
    return execution(...args)
  }
  const start = follower
    .startTask({ taskID: f.tasks[0]!.id, revision: 1, sessionID: "owner" })
    .then(
      () => "returned",
      (error: Error) => error.message,
    )
  try {
    await running
    await followerRegistration.dispose()
    await follower.stop()
    followerRepository.close()
    closed = true
    expect(await start).toBe("Scheduler registration was disposed")
    release()
    await leaderRegistration.dispose()
    expect(postCloseReads).toBe(0)
    expect((followerRepository as unknown as { connection?: unknown }).connection).toBeUndefined()
    expect(f.store.attempts(f.store.execution(f.tasks[0]!.id)!.planID)).toHaveLength(1)
    expect(f.events.filter((event) => event.startsWith("start:"))).toHaveLength(1)
  } finally {
    release()
    await followerRegistration.dispose()
    await leaderRegistration.dispose()
    await follower.stop()
    await leader.stop()
    followerRepository.close()
  }
})

test("inspector Start admits one real runtime plan and returns record-backed task state", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  const task = f.tasks[0]!
  const input = { taskID: task.id, revision: 1 as const, sessionID: "owner" }
  const [first, concurrent] = await Promise.all([
    f.runtime.startTask(input),
    f.runtime.startTask(input),
  ])
  expect(first).toMatchObject({ status: "started" })
  expect(["running", "verifying"]).toContain(first.state)
  expect(concurrent.planID).toBe(first.planID)
  const second = await f.runtime.startTask(input)
  expect(second).toMatchObject({ status: "existing", planID: first.planID })
  expect(f.store.plans()).toHaveLength(1)
  expect(f.store.attempts(first.planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)

  await drive(f.runtime)
  expect(f.store.execution(task.id)?.state).toBe("accepted")
  expect(
    new TaskReads(f.repository)
      .query({ includeCompleted: true })
      .tasks.find((item) => item.taskID === task.id),
  ).toMatchObject({ status: "accepted", reason: null })
  const detail = new TaskReads(f.repository).get({ taskID: task.id })
  expect(detail).toMatchObject({
    status: "found",
    execution: { planID: first.planID, state: "accepted" },
    attempts: [{ state: "accepted" }],
  })
  if (detail.status === "found")
    expect(detail.activity?.map((event) => event.event)).toContain("ACCEPT")
})

test("Start recovers a lost native continuation-create response after restart", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  f.sessions.get("owner")!.agent = "build"
  const create = f.host.createArchitect
  let calls = 0
  f.host.createArchitect = async (input) => {
    calls++
    if (calls === 1) throw new Error("native create interrupted before commit")
    await create(input)
  }
  const input = { taskID: f.tasks[0]!.id, revision: 1 as const, sessionID: "owner" }
  await expect(f.runtime.startTask(input)).rejects.toThrow(
    "native create interrupted before commit",
  )
  const draft = f.store.plans()[0]!
  const continuation = f.store.continuation(draft.id)!
  expect(draft.state).toBe("draft")
  expect(f.sessions.get(continuation.session_id)).toBeUndefined()

  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  cleanup.push(() => reopened.stop())
  await drive(reopened)
  expect(f.store.plan(draft.id)?.state).toBe("accepted")
  expect(f.store.plan(draft.id)?.owner).toBe(continuation.session_id)
  expect(calls).toBe(2)
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.store.attempts(draft.id)[0]?.session_id).toBeTruthy()
  expect(f.sessions.get(f.store.attempts(draft.id)[0]!.session_id)?.parentID).toBe(
    continuation.session_id,
  )
})

test("run authorizes and validates the original command before creating a continuation", async () => {
  for (const kind of ["foreign"] as const) {
    const f = fixture({ shared: true })
    f.sessions.get("owner")!.agent = "build"
    const before = f.store.plan(f.receipt.planID)!
    await expect(
      f.runtime.command(
        {
          requestID: "denied-run",
          planID: before.id,
          action: "run",
        },
        kind === "foreign" ? "not-the-owner" : "owner",
      ),
    ).rejects.toThrow("A live Architect session of this project must command the plan")
    expect(f.store.plan(before.id)).toEqual(before)
    expect(f.store.continuation(before.id)).toBeNull()
    expect(f.events).toEqual([])
    expect(f.store.attempts(before.id)).toHaveLength(0)
  }
})

test("Start admits an existing queued plan, keeps its selected worker route and respects dependencies", async () => {
  const selected = { providerID: "openai", id: "gpt-6-luna", variant: "max" }
  const f = fixture({ shared: true, workerModel: selected, delayed: true })
  f.sessions.get("owner")!.model = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" }
  const result = await f.runtime.startTask({
    taskID: f.tasks[1]!.id,
    revision: 1,
    sessionID: "owner",
  })
  expect(result.planID).toBe(f.receipt.planID)
  expect(f.store.plans()).toHaveLength(1)
  expect(f.store.plan(result.planID)!.state).toBe("running")
  expect(JSON.parse(f.store.plan(result.planID)!.model!)).toEqual(selected)
  expect(f.store.attempts(result.planID).map((attempt) => attempt.task_id)).toEqual([
    f.tasks[0]!.id,
  ])
  const again = await f.runtime.startTask({
    taskID: f.tasks[1]!.id,
    revision: 1,
    sessionID: "owner",
  })
  expect(again.planID).toBe(result.planID)
  expect(f.store.attempts(result.planID)).toHaveLength(1)
})

test("a lost continuation-create response is reconciled by stable native session ID", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  f.sessions.get("owner")!.agent = "build"
  const create = f.host.createArchitect
  let calls = 0
  f.host.createArchitect = async (input) => {
    calls++
    await create(input)
    if (calls === 1) throw new Error("create response lost")
  }
  const result = await f.runtime.startTask({
    taskID: f.tasks[0]!.id,
    revision: 1,
    sessionID: "owner",
  })
  const plan = f.store.plan(result.planID)!
  const continuation = f.store.continuation(plan.id)!
  expect(result).toMatchObject({ status: "started", state: "running" })
  expect(plan.owner).toBe(continuation.session_id)
  expect(calls).toBe(1)

  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  cleanup.push(() => reopened.stop())
  await drive(reopened)
  expect(f.store.plan(plan.id)?.state).toBe("accepted")
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
})

test("a missing task owner gets a same-project continuation without foreign parent context", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  codeProject(f, "ONS")
  const originalOwner = f.sessions.get("owner")!
  f.sessions.delete("owner")
  f.sessions.set("ses_starter", {
    ...originalOwner,
    id: "ses_starter",
    agent: "build",
  })
  const create = f.host.createArchitect
  let nativeInput: Parameters<RunnerHost["createArchitect"]>[0] | undefined
  f.host.createArchitect = async (input) => {
    nativeInput = input
    await create({ ...input, model: input.model ?? originalOwner.model })
  }

  const result = await f.runtime.startTask({
    taskID: f.tasks[0]!.id,
    revision: 1,
    sessionID: "ses_starter",
  })
  const plan = f.store.plan(result.planID)!
  const continuation = f.store.continuation(plan.id)!
  const owner = f.sessions.get(continuation.session_id)!
  expect(result).toMatchObject({ status: "started", state: "running" })
  expect(nativeInput?.title).toStartWith("ONS · continue ")
  expect(nativeInput?.parentID).toBeUndefined()
  expect(nativeInput?.model).toBeUndefined()
  expect(continuation.parent_id).toBeNull()
  expect(owner).toMatchObject({
    projectID: "project",
    directory: f.root,
    agent: "architect",
    parentID: undefined,
    model: originalOwner.model,
  })
  expect(owner.metadata?.lazersSourceSessionID).toBe("owner")
  await drive(f.runtime)
  expect(f.store.plan(plan.id)?.state).toBe("accepted")
})

test("Start admits the configured route independently of the Architect model", async () => {
  const f = fixture({
    shared: true,
    commit: true,
    startOnly: true,
  })
  const selected = { providerID: "custom-provider", id: "selected-model", variant: "careful" }
  f.host.workerModel = async () => selected
  f.sessions.get("owner")!.model = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" }
  const task = f.tasks[0]!
  const result = await f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "owner" })
  expect(result).toMatchObject({ status: "started", state: "running" })
  expect(JSON.parse(f.store.plan(result.planID)!.model!)).toEqual(selected)
  expect(JSON.parse(f.store.plan(result.planID)!.body).workerModel).toBeUndefined()
  const attempt = f.store.attempts(result.planID)[0]!
  expect(JSON.parse(attempt.policy)).not.toHaveProperty("routeDecision")
  expect(f.sessions.get(attempt.session_id)?.model).toEqual(selected)

  const noModel = fixture({ shared: true, commit: true, startOnly: true })
  noModel.host.workerModel = async () => undefined
  const noModelTask = noModel.tasks[0]!
  expect(noModelTask.proposal.classification).toEqual({
    taxonomy: "task-kind/v1",
    primaryKind: "feature-implementation",
  })
  const irrelevantPersonaMapping = new ModelMappingStore(noModel.repository).update({
    target: { scope: "task", taskID: noModelTask.id },
    persona: "systems",
    expectedRevision: 0,
    route: { providerID: "mapped-provider", id: "mapped-model", variant: "future/effort" },
  })
  expect(irrelevantPersonaMapping.status).toBe("updated")
  await expect(
    noModel.runtime.startTask({
      taskID: noModelTask.id,
      revision: 1,
      sessionID: "owner",
    }),
  ).rejects.toThrow("Select an implementor model")
  expect(noModel.store.plans()).toHaveLength(0)
  expect(noModel.events).toEqual([])
})

test("manual Start supports legacy unclassified tasks without inventing persona provenance", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  const proposal = validProposal()
  delete proposal.classification
  const task = f.repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory: f.root,
      workspaceDirectory: f.root,
      sessionID: "owner",
      startingRevision: { kind: "git", commit: f.base },
    },
    proposal,
  })
  const selected = { providerID: "legacy-provider", id: "legacy-model", variant: "native" }
  f.host.workerModel = async () => selected

  const result = await f.runtime.startTask({
    taskID: task.id,
    revision: 1,
    sessionID: "owner",
  })
  const plan = f.store.plan(result.planID)!
  const attempt = f.store.attempts(result.planID)[0]!
  expect(result).toMatchObject({ status: "started", state: "running" })
  expect(task.proposal.classification).toBeUndefined()
  expect(JSON.parse(plan.body).workerModel).toBeUndefined()
  expect(JSON.parse(attempt.policy)).toMatchObject({ model: selected })
  expect(JSON.parse(attempt.policy)).not.toHaveProperty("routeDecision")
  expect(f.sessions.get(attempt.session_id)?.model).toEqual(selected)
})

test("Go and configured routes reach native execution unchanged alongside independent personas", async () => {
  const choices: { persona: WorkerPersona; model: NonNullable<PlanInput["workerModel"]> }[] = [
    {
      persona: "ui",
      model: { providerID: "opencode-go", id: "qwen3.8-flash", variant: "xhigh" },
    },
    {
      persona: "ui",
      model: { providerID: "custom-provider", id: "configured-model", variant: "careful" },
    },
    {
      persona: "systems",
      model: { providerID: "custom-provider", id: "configured-model", variant: "careful" },
    },
    {
      persona: "systems",
      model: { providerID: "private-provider", id: "unlisted-model", variant: "medium" },
    },
    {
      persona: "small-refactoring",
      model: { providerID: "private-provider", id: "unlisted-model", variant: "medium" },
    },
    {
      persona: "small-refactoring",
      model: { providerID: "opencode-go", id: "qwen3.8-flash", variant: "xhigh" },
    },
  ]
  const overlayText: Record<WorkerPersona, string> = {
    ui: "Use the existing UI primitives and tokens.",
    systems: "Trace the existing contract before editing.",
    "small-refactoring": "Preserve behavior outside the request.",
  }

  for (const choice of choices) {
    const f = fixture({
      shared: true,
      workerModel: choice.model,
      personas: [choice.persona],
    })
    const nativeModels: NonNullable<PlanInput["workerModel"]>[] = []
    const create = f.host.create
    f.host.create = async (input) => {
      nativeModels.push(input.model)
      await create(input)
    }

    await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
    await f.runtime.tick()

    const plan = f.store.plan(f.receipt.planID)!
    const attempt = f.store.attempts(plan.id)[0]!
    const prompt = f.sessions.get(attempt.session_id)!.messages[0]!.text
    expect(JSON.parse(plan.model!)).toEqual(choice.model)
    expect(JSON.parse(plan.body).nodes[0].persona).toBe(choice.persona)
    expect(JSON.parse(attempt.policy)).toMatchObject({
      model: choice.model,
      persona: choice.persona,
    })
    expect(nativeModels).toEqual([choice.model])
    expect(prompt).toContain(
      `Selected ${choice.persona === "ui" ? "UI" : choice.persona === "systems" ? "Systems" : "Small task / refactoring"} persona`,
    )
    expect(prompt).toContain(overlayText[choice.persona])
    expect(prompt.match(/Selected .* persona/g)).toHaveLength(1)
  }
})

test("Start of explicitly persona-bearing plans honors mappings for every persona", async () => {
  const personas: WorkerPersona[] = ["ui", "systems", "small-refactoring"]
  const scopes = ["shared", "project", "task"] as const
  const makeRoute = (name: string) => ({
    providerID: `runtime-provider-${name}`,
    id: `runtime-model-${name}`,
    variant: `native-effort/${name}/uncatalogued`,
  })

  for (const persona of personas) {
    for (const scope of scopes) {
      const f = fixture({ shared: true, personas: [persona] })
      const task = f.tasks[0]!
      const mappings = new ModelMappingStore(f.repository)
      const routes = {
        shared: makeRoute(`${persona}-shared`),
        project: makeRoute(`${persona}-project`),
        task: makeRoute(`${persona}-task`),
      }
      const fallback = makeRoute(`${persona}-native-fallback`)
      f.host.workerModel = async () => fallback
      const shared = mappings.update({
        target: { scope: "shared" },
        persona,
        expectedRevision: 0,
        route: routes.shared,
      })
      expect(shared.status).toBe("updated")
      if (scope !== "shared")
        expect(
          mappings.update({
            target: { scope: "project" },
            persona,
            expectedRevision: 0,
            route: routes.project,
          }).status,
        ).toBe("updated")
      if (scope === "task")
        expect(
          mappings.update({
            target: { scope: "task", taskID: task.id },
            persona,
            expectedRevision: 0,
            route: routes.task,
          }).status,
        ).toBe("updated")

      const nativeRoutes: NonNullable<PlanInput["workerModel"]>[] = []
      const create = f.host.create
      f.host.create = async (input) => {
        nativeRoutes.push(input.model)
        await create(input)
      }
      await f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "owner" })

      const attempt = f.store.attempts(f.receipt.planID)[0]!
      const expectedRoute = routes[scope]
      const source = `${scope}-mapping` as const
      const target =
        scope === "shared"
          ? { scope: "shared" as const }
          : scope === "project"
            ? { scope: "project" as const, projectDirectory: f.root }
            : { scope: "task" as const, projectDirectory: f.root, taskID: task.id }
      expect(nativeRoutes).toEqual([expectedRoute])
      expect(JSON.parse(attempt.policy)).toMatchObject({
        model: expectedRoute,
        persona,
        routeDecision: {
          schemaVersion: 1,
          status: "resolved",
          persona,
          source,
          route: expectedRoute,
          provenance: { target, revision: 1 },
        },
      })
      expect(JSON.parse(f.store.plan(f.receipt.planID)!.body).workerModel).toBeUndefined()
    }
  }
})

test("an intentional plan route wins mappings and fallback while native fallback keeps honest provenance", async () => {
  const makeRoute = (name: string) => ({
    providerID: `runtime-provider-${name}`,
    id: `runtime-model-${name}`,
    variant: `native-effort/${name}/uncatalogued`,
  })
  const explicit = makeRoute("explicit-plan")
  const fallback = makeRoute("native-fallback")
  const f = fixture({ shared: true, personas: ["systems"], workerModel: explicit })
  const task = f.tasks[0]!
  const mappings = new ModelMappingStore(f.repository)
  for (const target of [
    { scope: "shared" as const },
    { scope: "project" as const },
    { scope: "task" as const, taskID: task.id },
  ])
    expect(
      mappings.update({
        target,
        persona: "systems",
        expectedRevision: 0,
        route: makeRoute(`mapped-${target.scope}`),
      }).status,
    ).toBe("updated")
  f.host.workerModel = async () => fallback
  const nativeRoutes: NonNullable<PlanInput["workerModel"]>[] = []
  const create = f.host.create
  f.host.create = async (input) => {
    nativeRoutes.push(input.model)
    await create(input)
  }

  await f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "owner" })
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  expect(nativeRoutes).toEqual([explicit])
  expect(JSON.parse(attempt.policy)).toMatchObject({
    model: explicit,
    routeDecision: {
      status: "resolved",
      source: "explicit-plan-selection",
      route: explicit,
      provenance: null,
    },
  })

  const inherited = fixture({
    shared: true,
    personas: ["small-refactoring"],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const admittedFallback = makeRoute("admitted-fallback")
  const inheritedFallback = makeRoute("current-inherited-fallback")
  inherited.host.workerModel = async () => admittedFallback
  await runPlan(inherited)
  inherited.host.workerModel = async () => inheritedFallback
  await inherited.runtime.tick()
  const inheritedAttempt = inherited.store.attempts(inherited.receipt.planID)[0]!
  expect(JSON.parse(inheritedAttempt.policy)).toMatchObject({
    model: inheritedFallback,
    routeDecision: {
      status: "resolved",
      persona: "small-refactoring",
      source: "native-implementor-selection",
      route: inheritedFallback,
      provenance: null,
    },
  })
})

test("a route removed after admission blocks dispatch before creating a worker", async () => {
  const f = fixture({
    shared: true,
    personas: ["systems"],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const admittedFallback = {
    providerID: "admitted-provider",
    id: "admitted-model",
    variant: "admitted/native-effort",
  }
  f.host.workerModel = async () => admittedFallback
  const task = f.tasks[0]!
  const mappings = new ModelMappingStore(f.repository)
  const mapping = mappings.update({
    target: { scope: "task", taskID: task.id },
    persona: "systems",
    expectedRevision: 0,
    route: { providerID: "mapped-provider", id: "mapped-model", variant: "future/effort" },
  })
  expect(mapping.status).toBe("updated")

  await runPlan(f)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("running")
  expect(JSON.parse(f.store.plan(f.receipt.planID)!.model!)).toEqual(admittedFallback)
  expect(
    mappings.update({
      target: { scope: "task", taskID: task.id },
      persona: "systems",
      expectedRevision: 1,
      route: null,
    }).status,
  ).toBe("updated")
  f.host.workerModel = async () => undefined

  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    state: "blocked",
    reason: expect.stringContaining("No native worker route"),
  })
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(0)
})

test("a reopened retry preserves the earlier route decision and uses the current mapping variant", async () => {
  const f = fixture({
    shared: true,
    fail: true,
    personas: ["systems"],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const task = f.tasks[0]!
  const mappings = new ModelMappingStore(f.repository)
  const initialRoute = {
    providerID: "uncatalogued-provider",
    id: "uncatalogued-model",
    variant: "future/effort-v1",
  }
  const updatedRoute = { ...initialRoute, variant: "future/effort-v2" }
  mappings.update({
    target: { scope: "task", taskID: task.id },
    persona: "systems",
    expectedRevision: 0,
    route: initialRoute,
  })
  const nativeRoutes: NonNullable<PlanInput["workerModel"]>[] = []
  const create = f.host.create
  f.host.create = async (input) => {
    nativeRoutes.push(input.model)
    await create(input)
  }
  await f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "owner" })
  const planID = f.store.execution(task.id)!.planID
  const first = f.store.attempts(planID)[0]!
  const firstPolicy = first.policy
  expect(nativeRoutes).toEqual([initialRoute])
  expect(JSON.parse(firstPolicy).routeDecision).toMatchObject({
    source: "task-mapping",
    route: initialRoute,
    provenance: { revision: 1 },
  })

  mappings.update({
    target: { scope: "task", taskID: task.id },
    persona: "systems",
    expectedRevision: 1,
    route: updatedRoute,
  })
  expect(first.policy).toBe(firstPolicy)
  expect(nativeRoutes).toEqual([initialRoute])
  expect(f.sessions.get(first.session_id)?.model).toEqual(initialRoute)
  f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner" })
  await f.runtime.command(
    {
      requestID: "reassign-during-route-attempt",
      planID,
      action: "reassign",
      targetSessionID: "new-owner",
      reason: "Transfer plan ownership without retargeting its active attempt",
    },
    "owner",
  )
  expect(f.store.attempts(planID)[0]!.policy).toBe(firstPolicy)

  f.completeWorker(first.session_id)
  await drive(f.runtime)
  expect(f.store.attempts(planID)[0]?.state).toBe("failed")
  expect(f.store.plan(planID)?.state).toBe("blocked")
  await f.runtime.command(
    {
      requestID: "retry-with-updated-mapping",
      planID,
      action: "retry",
      taskID: task.id,
      reason: "Retry using the currently assigned persona route",
    },
    "new-owner",
  )

  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  try {
    await reopened.tick()
  } finally {
    await reopened.stop()
  }
  const attempts = f.store.attempts(planID).filter((attempt) => attempt.task_id === task.id)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]!.policy).toBe(firstPolicy)
  expect(nativeRoutes).toEqual([initialRoute, updatedRoute])
  expect(JSON.parse(attempts[1]!.policy)).toMatchObject({
    model: updatedRoute,
    routeDecision: {
      source: "task-mapping",
      route: updatedRoute,
      provenance: { revision: 2 },
    },
  })
})

test("resuming a mapped attempt preserves its native route after the mapping changes", async () => {
  const f = fixture({
    shared: true,
    delayed: true,
    personas: ["systems"],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  f.host.workerModel = async () => undefined
  const task = f.tasks[0]!
  const mappings = new ModelMappingStore(f.repository)
  const originalRoute = {
    providerID: "resume-provider",
    id: "resume-model",
    variant: "future/resume-v1",
  }
  const updatedRoute = { ...originalRoute, variant: "future/resume-v2" }
  mappings.update({
    target: { scope: "task", taskID: task.id },
    persona: "systems",
    expectedRevision: 0,
    route: originalRoute,
  })
  const nativeRoutes: NonNullable<PlanInput["workerModel"]>[] = []
  const create = f.host.create
  f.host.create = async (input) => {
    nativeRoutes.push(input.model)
    await create(input)
  }

  const { planID, attempt } = await holdInterruptedAttempt(f)
  const originalPolicy = attempt.policy
  expect(f.store.plan(planID)?.model).toBeNull()
  expect(nativeRoutes).toEqual([originalRoute])
  mappings.update({
    target: { scope: "task", taskID: task.id },
    persona: "systems",
    expectedRevision: 1,
    route: updatedRoute,
  })

  await f.runtime.command(
    {
      requestID: "resume-with-retained-route",
      planID,
      action: "resume",
      taskID: task.id,
      attemptID: attempt.id,
      reason: "Continue the exact interrupted native assignment",
    },
    "owner",
  )
  await f.runtime.tick()
  const resumed = f.store.attempts(planID)[0]!
  expect(resumed).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
    state: "running",
  })
  expect(resumed.policy).toBe(originalPolicy)
  expect(nativeRoutes).toEqual([originalRoute])
  expect(f.sessions.get(attempt.session_id)?.model).toEqual(originalRoute)
})

test("a native route failure stays visible and is never retried with a substitute", async () => {
  const selected = { providerID: "custom-provider", id: "selected-model", variant: "max" }
  const f = fixture({ shared: true, workerModel: selected })
  const nativeAttempts: NonNullable<PlanInput["workerModel"]>[] = []
  f.host.create = async (input) => {
    nativeAttempts.push(input.model)
    throw new Error("Native provider rejected selected route")
  }

  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await f.runtime.tick()
  await f.runtime.tick()

  expect(nativeAttempts).toEqual([selected])
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    state: "blocked",
    reason: expect.stringContaining("Native provider rejected selected route"),
  })
  expect(JSON.parse(f.store.attempts(f.receipt.planID)[0]!.policy).model).toEqual(selected)
  expect(JSON.parse(f.store.attempts(f.receipt.planID)[0]!.policy)).not.toHaveProperty(
    "routeDecision",
  )
})

test("Start rejects stale, foreign and ended work without changing runtime state", async () => {
  const f = fixture()
  const task = f.tasks[0]!
  f.sessions.set("ses_foreign", {
    ...f.sessions.get("owner")!,
    id: "ses_foreign",
    projectID: "other-project",
    directory: "/other-project",
  })
  await expect(
    f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "missing-session" }),
  ).rejects.toThrow("live session")
  await expect(
    f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "ses_foreign" }),
  ).rejects.toThrow("live session")
  await expect(
    f.runtime.startTask({ taskID: crypto.randomUUID(), revision: 1, sessionID: "owner" }),
  ).rejects.toThrow("not available")
  await expect(
    f.runtime.startTask({ taskID: task.id, revision: 2, sessionID: "owner" } as never),
  ).rejects.toThrow("Stale task revision")
  const foreignTask = f.repository.insert({
    ...task,
    id: crypto.randomUUID(),
    provenance: { ...task.provenance, projectID: "other-project" },
  })
  await expect(
    f.runtime.startTask({ taskID: foreignTask.id, revision: 1, sessionID: "owner" }),
  ).rejects.toThrow("not available in this project")

  await f.runtime.command(
    {
      requestID: "cancel-before-start",
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  const cancelled = await f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "owner" })
  expect(cancelled).toMatchObject({ status: "existing", state: "cancelled" })
  expect(f.store.execution(task.id)?.state).toBe("cancelled")
  expect(f.store.plans()).toHaveLength(1) // the fixture plan only
})

test("worker sessions are titled with the project code", async () => {
  const f = fixture({ delayed: true })
  codeProject(f, "ONS")
  const titles: string[] = []
  const create = f.host.create
  f.host.create = async (input) => {
    titles.push(input.title)
    return create(input)
  }
  await runPlan(f)
  await f.runtime.tick()
  expect(titles.length).toBeGreaterThan(0)
  for (const title of titles) expect(title).toStartWith("ONS · ")
})

test("F-S4-1 admission and dispatch do not invoke the full project audit", async () => {
  const f = fixture({ delayed: true })
  f.store.audit = () => {
    throw new Error("Full audit on dispatch hot path")
  }
  await runPlan(f)
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
  expect(f.store.attempts(f.receipt.planID).length).toBeGreaterThan(0)
})

test("F-S4-2 retirement preserves a live owner's location outside the display window", async () => {
  const f = fixture({ delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.store.atomic((db) => {
    const clone = db.query(`INSERT INTO runner_plans
      SELECT ?,project_directory,owner,revision,version,'integrated',json_set(body,'$.priority',100),model,reason,artifact
      FROM runner_plans WHERE id=?`)
    for (let i = 0; i < 1005; i++) clone.run(`history-${i}`, f.receipt.planID)
    db.query("UPDATE runner_plans SET state='cleanup-blocked' WHERE id=?").run(f.receipt.planID)
  })
  expect(f.store.plans().some((plan) => plan.id === f.receipt.planID)).toBe(true)
  let retired = false
  f.host.retireWorktreeLocation = async () => {
    retired = true
    return "evicted"
  }
  const runtime = f.runtime as unknown as {
    worktreeCleanup: {
      retireCleanedWorktreeLocation(
        plan: { id: string },
        workspace: string,
        current: () => boolean,
      ): Promise<string>
    }
  }
  expect(
    await runtime.worktreeCleanup.retireCleanedWorktreeLocation(
      { id: "another-cleanup" },
      attempt.workspace,
      () => true,
    ),
  ).toBe("reserved-by-other-attempt")
  expect(retired).toBe(false)
})
