import { priorityFromHigherFirst } from "../../test/legacy-priority.ts"
import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Location } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { validProposal } from "../../test/proposal.ts"
import { git } from "../runner/artifacts.ts"
import type { TaskRuntime } from "../runner/runtime.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository } from "../storage.ts"
import { Tasks } from "./contract.ts"
import type { StartTaskInput, StartTaskResult } from "./contract.ts"
import { registerTaskReads } from "./rpc.ts"
import { getTaskDetail } from "./stream-query.ts"
import { taskInstructions } from "./instructions.ts"
import { registerTaskTools } from "../tools.ts"
import { SchedulingOutput, TasksScheduling } from "./scheduling-contract.ts"
import { TaskSchedulingRead } from "./scheduling-read.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

function toolContext(
  agent: string,
  sessionID = "native-session",
): Parameters<RegisteredTool["execute"]>[1] {
  return { sessionID, agent } as Parameters<RegisteredTool["execute"]>[1]
}

function taskToolDomain(onAdd: (tool: RegisteredTool) => void = () => {}) {
  const editor: ToolEditor = {
    add: onAdd,
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  return {
    transform: (callback: (editor: ToolEditor) => void) =>
      Effect.sync(() => {
        callback(editor)
        return { dispose: Effect.void }
      }),
  }
}

test("fourteen loaded locations publish one project task revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-read-rpc-fanout-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/fanout-project")
  const versions: number[] = []
  const runtime = {
    projectID: "project",
    host: { session: async () => null },
  } as unknown as TaskRuntime
  const ctx = {
    rpc: {
      register: () =>
        Effect.succeed({
          dispose: Effect.void,
          events: {
            emit: (_name: string, event: { version: number }) =>
              Effect.sync(() => {
                versions.push(event.version)
              }),
          },
        }),
    },
    permission: { assert: () => Effect.void },
    tool: taskToolDomain(),
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "tool">
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          for (let i = 0; i < 14; i++) yield* registerTaskReads(ctx, repository, runtime)
          repository.insert({
            schemaVersion: 1,
            id: crypto.randomUUID(),
            revision: 1,
            status: "submitted",
            createdAt: new Date().toISOString(),
            proposal: validProposal(),
            provenance: {
              projectID: "project",
              projectDirectory: repository.projectDirectory,
              workspaceDirectory: "/worker",
              sessionID: "worker",
              startingRevision: { kind: "unborn" },
            },
          })
          yield* Effect.sleep(100)
          expect(versions).toEqual([repository.version()])
        }),
      ),
    )
  } finally {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("RPC invalidations catch independent connections and retry transient read and delivery failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-read-rpc-"))
  const path = join(directory, "tasks.sqlite")
  const repository = new TaskRepository(path, "/project")
  const other = new TaskRepository(path, "/project")
  const versions: number[] = []
  let attempts = 0
  let failRead = false,
    failedReads = 0
  const version = repository.version.bind(repository)
  repository.version = () => {
    if (failRead) {
      failRead = false
      failedReads++
      throw new Error("temporary read failure")
    }
    return version()
  }
  const runtime = {
    host: { session: async () => null },
    projectID: "project",
    startTask: async (): Promise<StartTaskResult> => ({
      status: "started",
      planID: crypto.randomUUID(),
      state: "running",
    }),
  } as unknown as TaskRuntime
  const ctx = {
    rpc: {
      register: () =>
        Effect.succeed({
          dispose: Effect.void,
          events: {
            emit: (_name: string, event: { version: number }) =>
              Effect.sync(() => {
                attempts++
                if (attempts === 1) throw new Error("lost notification")
                versions.push(event.version)
              }),
          },
        }),
    },
    permission: { assert: () => Effect.void },
    tool: taskToolDomain(),
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "tool">
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerTaskReads(ctx, repository, runtime)
          failRead = true
          other.insert({
            schemaVersion: 1,
            id: crypto.randomUUID(),
            revision: 1,
            status: "submitted",
            createdAt: new Date().toISOString(),
            proposal: validProposal(),
            provenance: {
              projectID: "global",
              projectDirectory: "/project",
              workspaceDirectory: "/other-worktree",
              sessionID: "other-session",
              startingRevision: { kind: "unborn" },
            },
          })
          yield* Effect.sleep(2_250)
          expect(attempts).toBeGreaterThanOrEqual(2)
          expect(failedReads).toBe(1)
          expect(versions).toEqual([other.version()])
          expect(() => other.insert({})).toThrow()
        }),
      ),
    )
    const after = attempts
    repository.close()
    await Bun.sleep(1_050)
    expect(attempts).toBe(after)
  } finally {
    other.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("scheduling RPC authorizes exact live project scope before facts and observes cancellation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-scheduling-rpc-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  const sessionID = "ses_scheduling_owner"
  const page = {
    schemaVersion: 1 as const,
    snapshotID: crypto.randomUUID(),
    repositoryVersion: 0,
    scope: { kind: "project" as const, sessionID },
    observedAt: 0,
    coverage: {
      status: "complete" as const,
      planCount: 0,
      coveredPlanCount: 0,
      nodeCount: 0,
      coveredNodeCount: 0,
      activeReservationCount: 0,
      reservationsComplete: true,
      reason: null,
    },
    next: { status: "none" as const },
    selectedTaskIDs: [],
    selectionComplete: true,
    plans: [],
    nextCursor: null,
  }
  const methods = new Map<
    string,
    Record<string, (input: unknown) => Effect.Effect<unknown, never>>
  >()
  const permissionRequests: unknown[] = []
  let projectID = "project"
  let archived = false
  let denied = false
  let readCount = 0
  let abortDuringRead: AbortController | undefined
  const runtime = {
    projectID: "project",
    host: { session: async () => null },
    readScheduling: () => {
      readCount++
      abortDuringRead?.abort()
      return page
    },
  } as unknown as TaskRuntime
  const context = {
    rpc: {
      register: (
        contract: unknown,
        registered: Record<string, (input: unknown) => Effect.Effect<unknown, never>>,
      ) => {
        const id = (contract as { id?: string }).id
        if (id) methods.set(id, registered)
        return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
      },
    },
    permission: {
      assert: (request: unknown) => {
        permissionRequests.push(request)
        return denied ? Effect.fail(new Error("Denied")) : Effect.void
      },
    },
    session: {
      get: ({ sessionID: requested }: { sessionID: string }) =>
        Effect.succeed({
          id: requested,
          projectID,
          agent: "architect",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1, ...(archived ? { archived: 2 } : {}) },
          location: { directory: "/project" },
        }),
    },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session">
  const input = { scope: { kind: "project" as const, sessionID }, limit: 20 }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerTaskReads(context, repository, runtime)
        }),
      ),
    )
    const read = methods.get(TasksScheduling.id)?.read
    expect(read).toBeDefined()
    expect(await Effect.runPromise(read!(input))).toEqual(page)
    expect(readCount).toBe(1)
    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0]).toMatchObject({
      action: "read",
      resources: ["/project"],
    })

    projectID = "foreign-project"
    await expect(Effect.runPromise(read!(input))).rejects.toThrow()
    expect(readCount).toBe(1)
    projectID = "project"
    archived = true
    await expect(Effect.runPromise(read!(input))).rejects.toThrow()
    expect(readCount).toBe(1)
    archived = false
    denied = true
    await expect(Effect.runPromise(read!(input))).rejects.toThrow()
    expect(readCount).toBe(1)
    denied = false

    const before = new AbortController()
    before.abort()
    await expect(Effect.runPromise(read!(input), { signal: before.signal })).rejects.toThrow()
    expect(readCount).toBe(1)

    const during = new AbortController()
    abortDuringRead = during
    await expect(Effect.runPromise(read!(input), { signal: during.signal })).rejects.toThrow()
    expect(readCount).toBe(2)
  } finally {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("registered scheduling RPC bounds large plan waits and coalesces proof refreshes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-scheduling-guard-rpc-"))
  git(directory, ["init", "--initial-branch=main"])
  git(directory, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "base",
  ])
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), directory)
  const store = new RunnerStore(repository)
  const baseCommit = git(directory, ["rev-parse", "HEAD"])
  const sessionID = "ses_scheduling_guard_owner"
  const create = (
    name: string,
    priority: number,
    afterPlans: string[] = [],
    writeScope = [`${name}.ts`],
    ownerSessionID = sessionID,
  ) => {
    const task = repository.insert({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      revision: 1,
      status: "submitted",
      createdAt: new Date().toISOString(),
      provenance: {
        projectID: "project",
        projectDirectory: directory,
        workspaceDirectory: directory,
        sessionID: ownerSessionID,
        startingRevision: { kind: "git", commit: baseCommit },
      },
      proposal: { ...validProposal(), objective: name, writeScope },
    })
    const plan = store.submit(
      {
        requestID: `request-${name}`,
        title: `Plan ${name}`,
        objective: `Implement ${name}`,
        priority: priorityFromHigherFirst(priority),
        ...(afterPlans.length ? { afterPlans } : {}),
        baseCommit,
        workspaceMode: "isolated",
        nodes: [{ taskID: task.id, revision: 1 }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: [],
        acceptance: [{ id: "done", assertion: "Done", evidence: [] }],
      },
      ownerSessionID,
    )
    store.atomic((db) => {
      db.query("UPDATE runner_plans SET state='running' WHERE id=?").run(plan.planID)
      repository.changed()
    })
    return { task, plan }
  }

  let releaseProof = () => {}
  const pendingReads: Promise<unknown>[] = []
  try {
    const prerequisites = Array.from(
      { length: 101 },
      (_, index) => create(`waiting-prerequisite-${index}`, -100).plan.planID,
    )
    const dependent = create("waiting-on-101-plans", 100, prerequisites)
    const parent = create("integrated-proof-parent", -200)
    const proofChild = create("integrated-proof-child", 5, [parent.plan.planID])
    store.atomic((db) => {
      db.query("UPDATE runner_plans SET state='cleaning',artifact=? WHERE id=?").run(
        baseCommit,
        parent.plan.planID,
      )
      db.query("UPDATE runner_nodes SET state='accepted',artifact=? WHERE plan_id=?").run(
        baseCommit,
        parent.plan.planID,
      )
      db.query(
        `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
         VALUES(?,NULL,3,'PLAN_ACCEPTED',?,1),(?,NULL,3,'INTEGRATION_RECORDED',?,2)`,
      ).run(
        parent.plan.planID,
        JSON.stringify({ artifact: baseCommit }),
        parent.plan.planID,
        JSON.stringify({
          artifact: baseCommit,
          head: baseCommit,
          branch: "main",
          reason: "reviewed",
        }),
      )
      repository.changed()
    })
    const winner = create("next-candidate", 50, [], ["shared.ts"])
    create("fallback-next", 40, [], ["fallback.ts"])

    let proofStartedResolve!: () => void
    const proofStarted = new Promise<void>((resolve) => {
      proofStartedResolve = resolve
    })
    let deferred = false
    const proofGate = new Promise<void>((resolve) => {
      releaseProof = resolve
    })

    let activeRead = new TaskSchedulingRead(store, () => 100)
    const runtime = {
      projectID: "project",
      host: { session: async () => null },
      readScheduling: (input: Parameters<TaskSchedulingRead["read"]>[0]) => activeRead.read(input),
    } as unknown as TaskRuntime
    const methods = new Map<
      string,
      Record<string, (input: unknown) => Effect.Effect<unknown, never>>
    >()
    const context = {
      rpc: {
        register: (
          contract: unknown,
          registered: Record<string, (input: unknown) => Effect.Effect<unknown, never>>,
        ) => {
          const id = (contract as { id?: string }).id
          if (id) methods.set(id, registered)
          return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
        },
      },
      permission: { assert: () => Effect.void },
      session: {
        get: ({ sessionID: requested }: { sessionID: string }) =>
          Effect.succeed({
            id: requested,
            projectID: "project",
            agent: "architect",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            location: { directory },
          }),
      },
    } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session">
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerTaskReads(context, repository, runtime)
        }),
      ),
    )
    const read = methods.get(TasksScheduling.id)?.read
    expect(read).toBeDefined()
    const input = { scope: { kind: "project" as const, sessionID }, limit: 100 }

    const beforeReadVersion = repository.version()
    const beforeReadHead = git(directory, ["rev-parse", "HEAD"])
    const initial = SchedulingOutput.parse(await Effect.runPromise(read!(input)))
    expect(initial.next).toMatchObject({
      status: "known",
      candidate: { taskID: winner.task.id },
    })
    const waitingNode = initial.plans
      .find((plan) => plan.planID === dependent.plan.planID)
      ?.nodes.find((node) => node.taskID === dependent.task.id)
    expect(waitingNode).toMatchObject({
      waitingOnPlans: prerequisites.slice(0, 100),
      waitingOnPlansCount: 101,
      waitingOnPlansComplete: false,
    })

    activeRead = new TaskSchedulingRead(
      store,
      () => 101,
      {},
      async (path, args) => {
        if (args[0] === "merge-base" && !deferred) {
          deferred = true
          proofStartedResolve()
          await proofGate
        }
        return git(path, args)
      },
    )
    const firstPending = Effect.runPromise(read!(input))
    pendingReads.push(firstPending)
    await proofStarted
    const unchangedVersion = repository.version()
    const unchangedHead = git(directory, ["rev-parse", "HEAD"])
    expect(repository.version()).toBe(unchangedVersion)
    expect(git(directory, ["rev-parse", "HEAD"])).toBe(unchangedHead)

    const secondPending = Effect.runPromise(read!(input))
    pendingReads.push(secondPending)
    for (let attempt = 0; attempt < 20; attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    // The concurrent reader joins the in-flight projection instead of rebuilding it.
    expect(activeRead.workCounts.projectionBuilds).toBe(1)

    releaseProof()
    const [firstPage, secondPage] = await Promise.all([firstPending, secondPending])
    const firstRefreshed = SchedulingOutput.parse(firstPage)
    const secondRefreshed = SchedulingOutput.parse(secondPage)
    expect(firstRefreshed.next).toMatchObject({
      status: "known",
      candidate: { taskID: winner.task.id },
    })
    expect(secondRefreshed.next).toEqual(firstRefreshed.next)
    const repeated = SchedulingOutput.parse(await Effect.runPromise(read!(input)))
    expect(repeated.next).toEqual(firstRefreshed.next)
    expect(repository.version()).toBe(beforeReadVersion)
    expect(git(directory, ["rev-parse", "HEAD"])).toBe(beforeReadHead)
    expect(proofChild.plan.planID).not.toBe(parent.plan.planID)

    const sessionInput = { scope: { kind: "session" as const, sessionID }, limit: 100 }
    const initialSessionPage = SchedulingOutput.parse(await Effect.runPromise(read!(sessionInput)))
    const sessionDependentPlan = initialSessionPage.plans.find(
      (plan) => plan.planID === dependent.plan.planID,
    )
    expect(sessionDependentPlan).toMatchObject({
      afterPlans: prerequisites,
      afterPlansCount: 101,
      afterPlansComplete: true,
    })

    const largeSessionID = "ses_scheduling_afterplans_large"
    const manyPrerequisites = Array.from({ length: 1_001 }, (_, index) => {
      const name = `afterplans-prerequisite-${index}`
      return create(name, -1_000, [], [`${name}.ts`], largeSessionID).plan.planID
    })
    const manyPrerequisiteIDs = new Set<string>(manyPrerequisites)
    store.atomic((db) => {
      const integratedPlan = db.query(
        "UPDATE runner_plans SET state='integrated',artifact=? WHERE id=?",
      )
      const acceptedNode = db.query(
        "UPDATE runner_nodes SET state='accepted',artifact=? WHERE plan_id=?",
      )
      const recordIntegrations = db.query(
        `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
         VALUES(?,NULL,3,'PLAN_ACCEPTED',?,1),(?,NULL,3,'INTEGRATION_RECORDED',?,2)`,
      )
      for (const planID of manyPrerequisites.slice(0, 1_000)) {
        integratedPlan.run(baseCommit, planID)
        acceptedNode.run(baseCommit, planID)
        recordIntegrations.run(
          planID,
          JSON.stringify({ artifact: baseCommit }),
          planID,
          JSON.stringify({
            artifact: baseCommit,
            head: baseCommit,
            branch: "main",
            reason: "reviewed",
          }),
        )
      }
      repository.changed()
    })
    const exactlyThousand = create(
      "afterplans-exactly-1000",
      200,
      manyPrerequisites.slice(0, 1_000),
      ["afterplans-exactly-1000.ts"],
      largeSessionID,
    )
    const overThousand = create(
      "afterplans-over-1000",
      300,
      manyPrerequisites,
      ["afterplans-over-1000.ts"],
      largeSessionID,
    )
    activeRead = new TaskSchedulingRead(
      store,
      () => 102,
      {},
      async (path, args) => {
        if (args[0] === "branch") return "main"
        if (args[0] === "rev-parse") return baseCommit
        if (args[0] === "merge-base") return ""
        return git(path, args)
      },
    )
    const largeProjectPage = SchedulingOutput.parse(
      await Effect.runPromise(read!({ scope: { kind: "project", sessionID }, limit: 100 })),
    )
    const exactThousandPlan = largeProjectPage.plans.find(
      (plan) => plan.planID === exactlyThousand.plan.planID,
    )
    const overThousandPlan = largeProjectPage.plans.find(
      (plan) => plan.planID === overThousand.plan.planID,
    )
    expect(exactThousandPlan).toMatchObject({
      afterPlans: manyPrerequisites.slice(0, 1_000),
      afterPlansCount: 1_000,
      afterPlansComplete: true,
      decision: "eligible",
    })
    expect(overThousandPlan).toMatchObject({
      afterPlans: manyPrerequisites.slice(0, 1_000),
      afterPlansCount: 1_001,
      afterPlansComplete: false,
      decision: "waiting",
    })
    expect(largeProjectPage.coverage).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("Prerequisite plan references are bounded."),
    })
    expect(largeProjectPage.next).toMatchObject({
      status: "known",
      candidate: { taskID: exactlyThousand.task.id },
    })
    expect(overThousandPlan?.decision).toBe("waiting")
    expect(overThousandPlan?.nodes[0]).toMatchObject({
      waitingOnPlans: manyPrerequisites.slice(0, 100),
      waitingOnPlansCount: 1_001,
      waitingOnPlansComplete: false,
    })

    const finalSessionPage = SchedulingOutput.parse(await Effect.runPromise(read!(sessionInput)))
    expect(finalSessionPage.plans.some((plan) => plan.planID === exactlyThousand.plan.planID)).toBe(
      false,
    )
    expect(finalSessionPage.plans.some((plan) => plan.planID === overThousand.plan.planID)).toBe(
      false,
    )
    expect(
      finalSessionPage.plans.some((plan) =>
        plan.afterPlans.some((planID) => manyPrerequisiteIDs.has(planID)),
      ),
    ).toBe(false)
    expect(
      finalSessionPage.plans.find((plan) => plan.planID === dependent.plan.planID),
    ).toMatchObject({ afterPlansCount: 101, afterPlansComplete: true })

    expect(largeProjectPage.next).not.toMatchObject({
      status: "known",
      candidate: { planID: overThousand.plan.planID, taskID: overThousand.task.id },
    })
  } finally {
    releaseProof()
    await Promise.allSettled(pendingReads)
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("native advice attachment is Architect-only, replay-safe, and returned through task reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-advice-rpc-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  const task = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    proposal: validProposal(),
    provenance: {
      projectID: "project",
      projectDirectory: "/project",
      workspaceDirectory: "/project",
      sessionID: "submitter-session",
      startingRevision: { kind: "unborn" },
    },
  })
  const registeredTools = new Map<string, RegisteredTool>()
  const permissionActions: string[] = []
  let permitted = true
  const ctx = {
    rpc: {
      register: () => {
        return Effect.succeed({
          dispose: Effect.void,
          events: { emit: () => Effect.void },
        })
      },
    },
    permission: {
      assert: ({ action }: { action: string }) => {
        permissionActions.push(action)
        return permitted ? Effect.void : Effect.fail(new Error("native permission denied"))
      },
    },
    tool: taskToolDomain((tool) => registeredTools.set(tool.name, tool)),
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "tool">
  const location = Schema.decodeUnknownSync(Location.Info)({
    directory: "/project",
    project: { id: "project", directory: "/project", canonical: "/project" },
  })
  const taskToolContext = { location, permission: ctx.permission, tool: ctx.tool }
  const runtime = {
    host: { session: async () => null },
    projectID: "project",
    startTask: async () => ({ status: "started", planID: crypto.randomUUID(), state: "running" }),
  } as unknown as TaskRuntime

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerTaskTools(taskToolContext, repository)
          yield* registerTaskReads(ctx, repository, runtime)
        }),
      ),
    )
    const attach = registeredTools.get("lz-attach-task-advice")!
    expect(attach.options).toMatchObject({
      codemode: true,
      permission: "lz-attach-task-advice",
    })
    const original = {
      taskID: task.id,
      specRevision: 1,
      requestID: "native-advice-1",
      expectedRevision: 0,
      findings: ["Find the existing transactional write boundary."],
      implementationAdvice: ["Keep this note advisory and outside TaskSpec."],
      references: [{ kind: "source", reference: "src/tasks/read.ts" }],
    }
    const query = spyOn(Database.prototype, "query")
    const exec = spyOn(Database.prototype, "exec")
    try {
      permitted = false
      for (const input of [
        original,
        original,
        { ...original, implementationAdvice: ["Changed replay content."] },
      ])
        await expect(
          Effect.runPromise(attach.execute(input, toolContext("architect"))),
        ).rejects.toThrow("native permission denied")
      permitted = true
      for (const input of [
        original,
        original,
        { ...original, implementationAdvice: ["Changed replay content."] },
      ])
        await expect(
          Effect.runPromise(attach.execute(input, toolContext("lazers-implementor"))),
        ).rejects.toThrow("restricted to Architect")
      expect(query).not.toHaveBeenCalled()
      expect(exec).not.toHaveBeenCalled()
    } finally {
      query.mockRestore()
      exec.mockRestore()
    }

    const firstResult = await Effect.runPromise(attach.execute(original, toolContext("architect")))
    expect(firstResult).not.toHaveProperty("output")
    const first = JSON.parse(String(firstResult.content))
    expect(first).toMatchObject({
      status: "recorded",
      advice: {
        revision: 1,
        projectDirectory: "/project",
        taskID: task.id,
        provenance: { sessionID: "native-session", agent: "architect" },
      },
    })
    const replayResult = await Effect.runPromise(attach.execute(original, toolContext("architect")))
    expect(JSON.parse(String(replayResult.content)).status).toBe("replayed")
    expect(
      JSON.parse(
        String(
          (
            await Effect.runPromise(
              attach.execute(
                { ...original, implementationAdvice: ["Changed replay content."] },
                toolContext("architect"),
              ),
            )
          ).content,
        ),
      ),
    ).toMatchObject({ status: "conflict" })

    const correction = await Effect.runPromise(
      attach.execute(
        {
          // No specRevision and no expectedRevision: advice attaches to the current
          // specification and appends to the current advice history.
          taskID: task.id,
          requestID: "native-advice-2",
          references: [],
          findings: ["The current advice supersedes the earlier note."],
          implementationAdvice: ["Read the effective advice before implementing."],
        },
        toolContext("architect"),
      ),
    )
    expect(JSON.parse(String(correction.content))).toMatchObject({
      status: "recorded",
      advice: { revision: 2, specRevision: 1 },
    })
    const detail = await getTaskDetail(repository, { taskID: task.id })
    expect(detail).toMatchObject({
      status: "found",
      task: { id: task.id, revision: 1 },
      advice: {
        current: {
          revision: 2,
          findings: ["The current advice supersedes the earlier note."],
        },
        history: [{ revision: 1 }, { revision: 2 }],
      },
    })
    expect(taskInstructions(detail as Parameters<typeof taskInstructions>[0])).toContain(
      "Task-attached advice (advisory, revision 2)",
    )
    expect(taskInstructions(detail as Parameters<typeof taskInstructions>[0])).not.toContain(
      "Find the existing transactional write boundary.",
    )
    repository.close()
    const structured = await Effect.runPromise(
      registeredTools
        .get("lz-get-task")!
        .execute(
          { taskID: task.id, format: "structured" },
          toolContext("lazers-implementor", "current-worker"),
        ),
    )
    expect(structured.output).toMatchObject({
      status: "found",
      advice: {
        current: { revision: 2, provenance: { sessionID: "native-session", agent: "architect" } },
        history: [{ revision: 1 }, { revision: 2 }],
      },
    })
    const readable = await Effect.runPromise(
      registeredTools
        .get("lz-get-task")!
        .execute({ taskID: task.id }, toolContext("lazers-implementor", "current-worker")),
    )
    expect(typeof readable.output).toBe("string")
    expect(readable.output).toContain("Task-attached advice (advisory, revision 2)")
    expect(readable.output).toContain("Read the effective advice before implementing.")
    expect(readable.output).not.toContain("Find the existing transactional write boundary.")
    const replacementReadable = await Effect.runPromise(
      registeredTools
        .get("lz-get-task")!
        .execute({ taskID: task.id }, toolContext("lazers-implementor", "replacement-worker")),
    )
    expect(replacementReadable.output).toBe(readable.output)
    expect(permissionActions).toEqual([
      ...Array(10).fill("lz-attach-task-advice"),
      "lz-get-task",
      "lz-get-task",
      "lz-get-task",
    ])
  } finally {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Start RPC checks actor ownership and native permission before entering runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-start-rpc-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  const taskID = crypto.randomUUID()
  const planID = crypto.randomUUID()
  const checks: unknown[] = []
  let permitted = false
  let starts = 0
  let actor: { id: string; projectID: string; archived: boolean; agent: string } | null = {
    id: "ses_actor",
    projectID: "project",
    archived: false,
    agent: "architect",
  }
  let invokeStart: ((input: StartTaskInput) => Effect.Effect<StartTaskResult, Error>) | undefined
  const ctx = {
    rpc: {
      register: (
        contract: unknown,
        methods: {
          start: (input: StartTaskInput) => Effect.Effect<StartTaskResult, Error>
        },
      ) => {
        if ((contract as { id?: string }).id === Tasks.id) invokeStart = methods.start
        return Effect.succeed({
          dispose: Effect.void,
          events: { emit: () => Effect.void },
        })
      },
    },
    permission: {
      assert: (permission: unknown) => {
        checks.push(permission)
        return permitted ? Effect.void : Effect.fail(new Error("native permission denied"))
      },
    },
    tool: taskToolDomain(),
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "tool">
  const runtime = {
    projectID: "project",
    host: { session: async (sessionID: string) => (sessionID === actor?.id ? actor : null) },
    startTask: async () => {
      starts++
      return { status: "started", planID, state: "running" }
    },
  } as unknown as TaskRuntime
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerTaskReads(ctx, repository, runtime)
        }),
      ),
    )
    const input: StartTaskInput = { taskID, revision: 1, sessionID: "ses_actor" }
    const denied = await Effect.runPromise(invokeStart!(input)).then(
      () => null,
      (error: unknown) => error,
    )
    expect(denied).toBeInstanceOf(Error)
    expect(starts).toBe(0)
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({
      sessionID: "ses_actor",
      agent: "architect",
      action: "lz-start-task",
      resources: [taskID],
    })

    permitted = true
    expect(await Effect.runPromise(invokeStart!(input))).toEqual({
      status: "started",
      planID,
      state: "running",
    })
    expect(starts).toBe(1)

    actor = null
    const missing = await Effect.runPromise(invokeStart!(input)).then(
      () => null,
      (error: unknown) => error,
    )
    expect(missing).toBeInstanceOf(Error)
    expect(checks).toHaveLength(2)
    expect(starts).toBe(1)
  } finally {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
