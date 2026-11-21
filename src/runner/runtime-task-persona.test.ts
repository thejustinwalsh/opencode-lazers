import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { ModelMappingStore } from "../models/mapping-store.ts"
import type { StartTaskInput, StartTaskResult } from "../tasks/contract.ts"
import { Tasks } from "../tasks/contract.ts"
import { registerTaskReads } from "../tasks/rpc.ts"
import type { WorkerPersona, PlanInput } from "./schema.ts"
import type { TaskRuntime as ProductionTaskRuntime } from "./runtime.ts"
import { fixture, useRuntimeFixtureCleanup } from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

function insertTaskPersona(f: ReturnType<typeof fixture>, persona: WorkerPersona) {
  const source = f.tasks[0]!
  return f.repository.insert({
    ...source,
    id: crypto.randomUUID(),
    proposal: { ...source.proposal, persona },
  })
}

function suppressFixtureWorkerPrompt(f: ReturnType<typeof fixture>) {
  // These dispatch tests inspect route admission, not the fixture's simulated file writes.
  f.host.prompt = async () => {}
}

async function registeredStart(f: ReturnType<typeof fixture>, input: StartTaskInput) {
  let invoke: ((input: StartTaskInput) => Effect.Effect<StartTaskResult, Error>) | undefined
  const ctx = {
    rpc: {
      register: (
        contract: unknown,
        methods: { start: (input: StartTaskInput) => Effect.Effect<StartTaskResult, Error> },
      ) => {
        if ((contract as { id?: string }).id === Tasks.id) invoke = methods.start
        return Effect.succeed({
          dispose: Effect.void,
          events: { emit: () => Effect.void },
        })
      },
    },
    permission: { assert: () => Effect.void },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission">

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerTaskReads(ctx, f.repository, f.runtime as unknown as ProductionTaskRuntime)
      }),
    ),
  )
  if (!invoke) throw new Error("Task Start RPC was not registered")
  return Effect.runPromise(invoke(input))
}

test("manual Start routes the saved persona through the live mapping without native fallback", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  const task = insertTaskPersona(f, "systems")
  const mappings = new ModelMappingStore(f.repository)
  const beforeStart = {
    providerID: "task-persona-provider",
    id: "task-persona-model",
    variant: "future/effort-before-start",
  }
  const current = {
    ...beforeStart,
    variant: "future/effort-current",
  }
  expect(
    mappings.update({
      target: { scope: "task", taskID: task.id },
      persona: "systems",
      expectedRevision: 0,
      route: beforeStart,
    }).status,
  ).toBe("updated")
  expect(
    mappings.update({
      target: { scope: "task", taskID: task.id },
      persona: "systems",
      expectedRevision: 1,
      route: current,
    }).status,
  ).toBe("updated")

  f.host.workerModel = async () => undefined
  suppressFixtureWorkerPrompt(f)
  const nativeModels: NonNullable<PlanInput["workerModel"]>[] = []
  const create = f.host.create
  f.host.create = async (input) => {
    nativeModels.push(input.model)
    await create(input)
  }
  const startSessionID = "ses_task_persona"
  f.sessions.set(startSessionID, {
    ...f.sessions.get("owner")!,
    id: startSessionID,
  })

  const result = await registeredStart(f, {
    taskID: task.id,
    revision: 1,
    sessionID: startSessionID,
  })
  const plan = f.store.plan(result.planID)!
  const attempt = f.store.attempts(result.planID)[0]!
  const originalPolicy = attempt.policy
  expect(result.status).toBe("started")
  expect(JSON.parse(plan.body)).toMatchObject({
    nodes: [{ taskID: task.id, revision: 1, persona: "systems" }],
  })
  expect(JSON.parse(plan.body)).not.toHaveProperty("workerModel")
  expect(plan.model).toBeNull()
  expect(nativeModels).toEqual([current])
  expect(JSON.parse(originalPolicy)).toMatchObject({
    model: current,
    persona: "systems",
    routeDecision: {
      schemaVersion: 1,
      status: "resolved",
      persona: "systems",
      source: "task-mapping",
      route: current,
      provenance: {
        target: { scope: "task", projectDirectory: f.root, taskID: task.id },
        revision: 2,
      },
    },
  })

  expect(
    mappings.update({
      target: { scope: "task", taskID: task.id },
      persona: "systems",
      expectedRevision: 2,
      route: { ...current, variant: "future/effort-after-dispatch" },
    }).status,
  ).toBe("updated")
  expect(f.store.attempts(result.planID)[0]!.policy).toBe(originalPolicy)
  expect(f.sessions.get(attempt.session_id)?.model).toEqual(current)
  expect(nativeModels).toEqual([current])
})

test("manual Start inherits native fallback without storing it as an explicit plan selection", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  const task = insertTaskPersona(f, "ui")
  const fallback = {
    providerID: "native-fallback-provider",
    id: "native-fallback-model",
    variant: "native/effort",
  }
  f.host.workerModel = async () => fallback
  suppressFixtureWorkerPrompt(f)

  const result = await f.runtime.startTask({
    taskID: task.id,
    revision: 1,
    sessionID: "owner",
  })
  const plan = f.store.plan(result.planID)!
  const attempt = f.store.attempts(result.planID)[0]!
  expect(JSON.parse(plan.body)).toMatchObject({
    nodes: [{ taskID: task.id, persona: "ui" }],
  })
  expect(JSON.parse(plan.body)).not.toHaveProperty("workerModel")
  expect(JSON.parse(attempt.policy)).toMatchObject({
    model: fallback,
    persona: "ui",
    routeDecision: {
      source: "native-implementor-selection",
      route: fallback,
      provenance: null,
    },
  })
  expect(JSON.parse(attempt.policy).routeDecision.source).not.toBe("explicit-plan-selection")
})

test("ordinary authored plan persona stays authoritative over task metadata", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  const task = insertTaskPersona(f, "ui")
  const mappings = new ModelMappingStore(f.repository)
  const uiRoute = { providerID: "ui-provider", id: "ui-model", variant: "ui-effort" }
  const systemsRoute = {
    providerID: "systems-provider",
    id: "systems-model",
    variant: "systems-effort",
  }
  for (const [persona, route] of [
    ["ui", uiRoute],
    ["systems", systemsRoute],
  ] as const) {
    expect(
      mappings.update({
        target: { scope: "shared" },
        persona,
        expectedRevision: 0,
        route,
      }).status,
    ).toBe("updated")
  }
  f.host.workerModel = async () => undefined
  suppressFixtureWorkerPrompt(f)
  const receipt = f.store.submit(
    {
      requestID: "authored-plan-persona",
      objective: "Preserve explicit authored plan persona.",
      baseCommit: f.base,
      workspaceMode: "shared",
      nodes: [{ taskID: task.id, revision: 1, persona: "systems" }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: task.proposal.verification,
      acceptance: task.proposal.acceptance,
    },
    "owner",
  )
  await f.runtime.command(
    { requestID: "run-authored-plan-persona", planID: receipt.planID, action: "run" },
    "owner",
  )
  await f.runtime.tick()

  const plan = f.store.plan(receipt.planID)!
  const attempt = f.store.attempts(receipt.planID)[0]!
  expect(task.proposal.persona).toBe("ui")
  expect(JSON.parse(plan.body).nodes[0].persona).toBe("systems")
  expect(JSON.parse(attempt.policy)).toMatchObject({
    model: systemsRoute,
    persona: "systems",
    routeDecision: { source: "shared-mapping", route: systemsRoute },
  })
  expect(JSON.parse(attempt.policy).model).not.toEqual(uiRoute)
})
