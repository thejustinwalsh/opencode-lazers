import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keyedProposal, validProposal } from "../../../test/proposal.ts"
import { TaskRepository } from "../../storage.ts"
import { RunnerStore } from "../../runner/store.ts"
import { submitTask } from "../../submission.ts"
import { ProbeRepository } from "../probe/store.ts"
import type { ProbeActor, ProbeRun } from "../probe/schema.ts"
import { FilesystemFixtureAdapter } from "./fixture.ts"
import type { OwnedResourceAdapter } from "./fixture.ts"
import type { OwnedResource, ResourceObservation, ResourceRegistrationInput } from "./schema.ts"
import { OwnedProbeLifecycle } from "./lifecycle.ts"
import { ResourceRepository } from "./store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-resource-life-"))
  directories.push(directory)
  return directory
}

function open(path: string, projectDirectory = "/project") {
  const repository = new TaskRepository(path, projectDirectory)
  repositories.push(repository)
  return repository
}

function taskProvenance(projectDirectory: string) {
  return {
    projectID: projectDirectory,
    projectDirectory,
    workspaceDirectory: `${projectDirectory}/authoring-worktree`,
    sessionID: "task-author-session",
    startingRevision: { kind: "unborn" as const },
  }
}

function addRun(repository: TaskRepository, label: string) {
  const proposal = {
    ...keyedProposal(`resource-task-${label}`),
    acceptance: validProposal().acceptance,
  }
  const submitted = submitTask(repository, proposal, () =>
    taskProvenance(repository.projectDirectory),
  )
  if (submitted.status !== "submitted") throw new Error("Expected task submission")
  const task = repository.get(submitted.taskID)!
  const runner = new RunnerStore(repository)
  const baseCommit = "a".repeat(40)
  const plan = runner.submit(
    {
      requestID: `resource-plan-${label}`,
      objective: "Run an owned fixture probe",
      baseCommit,
      nodes: [{ taskID: task.id, revision: task.revision }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: task.proposal.verification,
      acceptance: task.proposal.acceptance,
    },
    "architect-session",
  )
  const actor: ProbeActor = { sessionID: `worker-session-${label}`, agent: "lazers-implementor" }
  const attemptID = crypto.randomUUID()
  const workspace = `${repository.projectDirectory}/candidate-worktree`
  repository.atomic((db) => {
    db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
       VALUES(?,?,?,?,?,?,?,?,?,'running',?)`,
    ).run(
      attemptID,
      plan.planID,
      task.id,
      1,
      actor.sessionID,
      `message-${attemptID}`,
      workspace,
      baseCommit,
      JSON.stringify({ route: "fixture" }),
      Date.now(),
    )
  })

  const probes = new ProbeRepository(repository)
  const definition = probes.define(
    {
      requestID: `resource-definition-${label}`,
      target: { kind: "task", taskID: task.id },
      scenarios: [
        {
          id: "resource-fixture",
          summary: "Exercise the product with an owned disposable fixture",
          acceptanceIDs: task.proposal.acceptance.map((assertion) => assertion.id),
          procedure: { recordID: "runbook:resource-fixture", revision: "1" },
        },
      ],
      notApplicable: [],
    },
    { sessionID: "architect-session", agent: "architect" },
  )
  if (definition.status === "conflict") throw new Error("Expected probe definition")
  const started = probes.startRun(
    {
      requestID: `resource-run-${label}`,
      definitionID: definition.definition.definitionID,
      definitionRevision: definition.definition.revision,
      scenarioID: "resource-fixture",
      attemptID,
      candidate: { revision: "b".repeat(40), workspace },
      inputs: { recordID: "fixtures:request", revision: "1" },
      environment: { recordID: "desktop-profile:isolated", revision: "1" },
      capabilities: ["filesystem-fixture"],
      setupReferences: ["runbook:resource-fixture#setup"],
      fixtureReferences: ["fixture:resource-fixture"],
      actions: [],
      observations: [],
      evidenceReferences: [],
      timing: { startedAt: null, finishedAt: null, elapsedMs: null },
      usage: { tokens: null, toolCalls: null, costUsd: null },
      cleanupState: "pending",
    },
    actor,
  )
  if (started.status === "conflict") throw new Error("Expected probe run")
  return { actor, probes, run: started.run }
}

function lifecycleFor(
  repository: TaskRepository,
  probes: ProbeRepository,
  adapter: OwnedResourceAdapter,
) {
  return new OwnedProbeLifecycle(new ResourceRepository(repository), probes, adapter)
}

function resourceInput(
  requestID: string,
  name: string,
  generation = 1,
  contents = "fixture payload",
) {
  return { requestID, name, generation, contents }
}

class CountingAdapter implements OwnedResourceAdapter {
  creates = 0
  removes = 0
  observations = 0
  createFailure: "before" | "after" | undefined
  removeFailure: "before" | "after" | undefined
  observeOverride: ((resource: OwnedResource) => ResourceObservation) | undefined
  beforeCreate: ((resource: OwnedResource) => void) | undefined

  constructor(readonly inner: FilesystemFixtureAdapter) {}

  describe(input: ResourceRegistrationInput) {
    return this.inner.describe(input)
  }

  path(resource: OwnedResource) {
    return this.inner.path(resource)
  }

  reserve(resource: OwnedResource, coordinatorID: string) {
    this.inner.reserve(resource, coordinatorID)
  }

  observe(resource: OwnedResource, coordinatorID: string) {
    this.observations++
    return this.observeOverride?.(resource) ?? this.inner.observe(resource, coordinatorID)
  }

  create(resource: OwnedResource, coordinatorID: string) {
    this.creates++
    this.beforeCreate?.(resource)
    if (this.createFailure === "before") {
      this.createFailure = undefined
      throw new Error("fixture setup failed")
    }
    this.inner.create(resource, coordinatorID)
    if (this.createFailure === "after") {
      this.createFailure = undefined
      throw new Error("fixture setup failed after create")
    }
  }

  remove(resource: OwnedResource, coordinatorID: string) {
    this.removes++
    if (this.removeFailure === "before") {
      this.removeFailure = undefined
      throw new Error("simulated teardown failure")
    }
    this.inner.remove(resource, coordinatorID)
    if (this.removeFailure === "after") {
      this.removeFailure = undefined
      throw new Error("simulated lost teardown receipt")
    }
  }

  release(resource: OwnedResource, coordinatorID: string) {
    this.inner.release(resource, coordinatorID)
  }
}

function ownerFor(repository: TaskRepository, run: ProbeRun) {
  return {
    projectDirectory: repository.projectDirectory,
    runID: run.runID,
    taskID: run.taskID,
    planID: run.planID,
    attemptID: run.attemptID,
    sessionID: run.sessionID,
    producer: run.producer,
    candidate: run.candidate,
    environment: run.environment,
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("committed registration precedes fixture creation; exact replay is inert and changed content conflicts", async () => {
  const directory = temporaryDirectory()
  const databasePath = join(directory, "tasks.sqlite")
  const root = join(directory, "fixtures")
  mkdirSync(root)
  const repository = open(databasePath)
  const { actor, probes, run } = addRun(repository, "registered-effects")
  const adapter = new CountingAdapter(new FilesystemFixtureAdapter(root))
  const lifecycle = lifecycleFor(repository, probes, adapter)
  adapter.beforeCreate = (resource) => {
    expect(resource.state).toBe("creating")
    expect(lifecycle.resources.resource(resource.resourceID)?.state).toBe("creating")
    expect(lifecycle.resources.claimed(resource.resourceKey)?.resourceID).toBe(resource.resourceID)
    expect(lifecycle.resources.execution(run.runID)?.phase).toBe("preparing")
  }
  const input = resourceInput("fixture-request", "owned-fixture")
  let callbacks = 0

  const result = await lifecycle.withOwnedResources(
    { runID: run.runID, actor, resources: [input] },
    (fixtures) => {
      callbacks++
      expect(existsSync(fixtures[0]!.path)).toBe(true)
      expect(readFileSync(join(fixtures[0]!.path, "fixture.txt"), "utf8")).toBe(input.contents)
      const records = lifecycle.resources.resourcesForRun(run.runID)
      expect(records).toMatchObject([{ state: "active", owner: { runID: run.runID } }])
      expect(lifecycle.resources.execution(run.runID)).toMatchObject({ phase: "probing" })
      return { verdict: "passed", value: "observed fixture" }
    },
  )

  expect(result).toMatchObject({
    status: "executed",
    value: "observed fixture",
    run: { lifecycle: "completed", verdict: "passed", cleanupState: "complete" },
  })
  expect(callbacks).toBe(1)
  expect(adapter.creates).toBe(1)
  expect(adapter.removes).toBe(1)
  expect(existsSync(join(root, input.name))).toBe(false)
  expect(lifecycle.resources.cleanupReceiptCount(run.runID)).toBe(1)

  const replay = await lifecycle.withOwnedResources(
    { runID: run.runID, actor, resources: [input] },
    () => {
      callbacks++
      throw new Error("passed probe callback must not replay")
    },
  )
  expect(replay).toMatchObject({
    status: "replayed",
    run: { verdict: "passed", cleanupState: "complete" },
  })
  expect(callbacks).toBe(1)
  expect(adapter.creates).toBe(1)
  expect(adapter.removes).toBe(1)

  await expect(
    lifecycle.withOwnedResources(
      { runID: run.runID, actor, resources: [{ ...input, contents: "changed payload" }] },
      () => ({ verdict: "passed", value: "unreachable" }),
    ),
  ).rejects.toThrow("registration failed")
  await expect(
    lifecycle.withOwnedResources(
      {
        runID: run.runID,
        actor,
        resources: [resourceInput("late-resource", "too-late")],
      },
      () => ({ verdict: "passed", value: "unreachable" }),
    ),
  ).rejects.toThrow("after it starts")
  expect(callbacks).toBe(1)
  expect(adapter.creates).toBe(1)
})

test("success, product failure, setup failure and cancellation all attempt owned teardown", async () => {
  const directory = temporaryDirectory()
  const repository = open(join(directory, "tasks.sqlite"))
  const root = join(directory, "fixtures")
  mkdirSync(root)
  const cases = [
    {
      label: "success",
      verdict: "passed" as const,
      setupFailure: false,
      cancelInProbe: false,
      callbackFailure: false,
    },
    {
      label: "product-failure",
      verdict: "product-failed" as const,
      setupFailure: false,
      cancelInProbe: false,
      callbackFailure: false,
    },
    {
      label: "setup-failure",
      verdict: null,
      setupFailure: true,
      cancelInProbe: false,
      callbackFailure: false,
    },
    {
      label: "cancelled",
      verdict: null,
      setupFailure: false,
      cancelInProbe: true,
      callbackFailure: false,
    },
    {
      label: "callback-error",
      verdict: null,
      setupFailure: false,
      cancelInProbe: false,
      callbackFailure: true,
    },
  ]
  for (const scenario of cases) {
    const { actor, probes, run } = addRun(repository, `automatic-${scenario.label}`)
    const adapter = new CountingAdapter(new FilesystemFixtureAdapter(root))
    if (scenario.setupFailure) adapter.createFailure = "after"
    const lifecycle = lifecycleFor(repository, probes, adapter)
    const input = resourceInput(`automatic-${scenario.label}`, `fixture-${scenario.label}`)
    const controller = new AbortController()
    const result = await lifecycle.withOwnedResources(
      {
        runID: run.runID,
        actor,
        resources: [input],
        ...(scenario.cancelInProbe ? { signal: controller.signal } : {}),
      },
      () => {
        if (scenario.cancelInProbe) controller.abort()
        if (scenario.callbackFailure) throw new Error("probe callback interrupted")
        return { verdict: scenario.verdict ?? "passed", value: scenario.label }
      },
    )
    if (scenario.setupFailure) {
      expect(result).toMatchObject({
        status: "blocked",
        run: { verdict: "environment-blocked", cleanupState: "complete" },
      })
      expect(adapter.creates).toBe(1)
      expect(adapter.removes).toBe(1)
    } else if (scenario.cancelInProbe) {
      expect(result).toMatchObject({
        status: "cancelled",
        run: { lifecycle: "cancelled", verdict: null, cleanupState: "complete" },
      })
      expect(adapter.creates).toBe(1)
      expect(adapter.removes).toBe(1)
    } else if (scenario.callbackFailure) {
      expect(result).toMatchObject({
        status: "interrupted",
        run: { lifecycle: "interrupted", verdict: null, cleanupState: "complete" },
      })
      expect(adapter.creates).toBe(1)
      expect(adapter.removes).toBe(1)
    } else {
      expect(result.run).toMatchObject({
        lifecycle: "completed",
        verdict: scenario.verdict,
        cleanupState: "complete",
      })
      expect(adapter.creates).toBe(1)
      expect(adapter.removes).toBe(1)
    }
    expect(existsSync(join(root, input.name))).toBe(false)
    expect(lifecycle.resources.cleanupReceiptCount(run.runID)).toBe(1)
  }
})

test("failed cleanup is durable and retry does not replay the callback or change a passed verdict", async () => {
  const directory = temporaryDirectory()
  const repository = open(join(directory, "tasks.sqlite"))
  const root = join(directory, "fixtures")
  mkdirSync(root)
  const { actor, probes, run } = addRun(repository, "retry-cleanup")
  const adapter = new CountingAdapter(new FilesystemFixtureAdapter(root))
  adapter.removeFailure = "before"
  const lifecycle = lifecycleFor(repository, probes, adapter)
  const input = resourceInput("retry-cleanup-request", "retry-fixture")
  let callbacks = 0

  const first = await lifecycle.withOwnedResources(
    { runID: run.runID, actor, resources: [input] },
    () => {
      callbacks++
      return { verdict: "passed", value: "pass" }
    },
  )
  expect(first.run).toMatchObject({ verdict: "passed", cleanupState: "failed" })
  expect(existsSync(join(root, input.name))).toBe(true)
  expect(lifecycle.resources.claimed(adapter.inner.describe(input).resourceKey)).toBeDefined()

  const retried = lifecycle.retryCleanup(run.runID, actor)
  expect(retried).toMatchObject({
    run: { verdict: "passed", cleanupState: "complete" },
    cleanupState: "complete",
  })
  expect(callbacks).toBe(1)
  expect(adapter.creates).toBe(1)
  expect(adapter.removes).toBe(2)
  expect(existsSync(join(root, input.name))).toBe(false)
  expect(lifecycle.resources.cleanupReceiptCount(run.runID)).toBe(1)
})

test("reopened cleanup with a different filesystem root stays uncertain until the original root returns", async () => {
  const directory = temporaryDirectory()
  const databasePath = join(directory, "tasks.sqlite")
  const originalRoot = join(directory, "original-fixtures")
  const wrongRoot = join(directory, "wrong-fixtures")
  mkdirSync(originalRoot)
  mkdirSync(wrongRoot)
  let repository = open(databasePath)
  const { actor, probes, run } = addRun(repository, "wrong-root-cleanup")
  const originalAdapter = new CountingAdapter(new FilesystemFixtureAdapter(originalRoot))
  originalAdapter.removeFailure = "before"
  let lifecycle = lifecycleFor(repository, probes, originalAdapter)
  const input = resourceInput("wrong-root-cleanup-input", "root-bound-fixture")
  let callbacks = 0

  const first = await lifecycle.withOwnedResources(
    { runID: run.runID, actor, resources: [input] },
    () => {
      callbacks++
      return { verdict: "passed", value: "passed once" }
    },
  )
  expect(first.run).toMatchObject({
    lifecycle: "completed",
    verdict: "passed",
    cleanupState: "failed",
  })
  expect(existsSync(join(originalRoot, input.name))).toBe(true)
  expect(lifecycle.resources.cleanupReceiptCount(run.runID)).toBe(0)

  const persisted = lifecycle.resources.resourcesForRun(run.runID)[0]!
  const coordinatorID = lifecycle.resources.coordinatorID()
  const wrongAdapter = new CountingAdapter(new FilesystemFixtureAdapter(wrongRoot))
  expect(wrongAdapter.inner.observe(persisted, coordinatorID)).toMatchObject({
    state: "unknown",
    authoritative: false,
  })
  expect(() => wrongAdapter.inner.reserve(persisted, coordinatorID)).toThrow("another fixture root")
  expect(() => wrongAdapter.inner.create(persisted, coordinatorID)).toThrow()
  expect(() => wrongAdapter.inner.remove(persisted, coordinatorID)).toThrow()
  expect(() => wrongAdapter.inner.release(persisted, coordinatorID)).toThrow("another fixture root")

  repository.close()
  repository = open(databasePath)
  lifecycle = lifecycleFor(repository, new ProbeRepository(repository), wrongAdapter)
  const wrongRootRetry = lifecycle.retryCleanup(run.runID, actor)
  expect(wrongRootRetry).toMatchObject({
    run: { lifecycle: "completed", verdict: "passed", cleanupState: "failed" },
    cleanupState: "failed",
  })
  expect(lifecycle.resources.resourcesForRun(run.runID)).toMatchObject([{ state: "uncertain" }])
  expect(lifecycle.resources.claimed(persisted.resourceKey)?.resourceID).toBe(persisted.resourceID)
  expect(lifecycle.resources.cleanupReceiptCount(run.runID)).toBe(0)
  expect(existsSync(join(originalRoot, input.name))).toBe(true)
  expect(existsSync(join(wrongRoot, input.name))).toBe(false)
  expect(readdirSync(wrongRoot)).toEqual([])
  expect(wrongAdapter.removes).toBe(0)
  expect(callbacks).toBe(1)

  lifecycle = lifecycleFor(
    repository,
    new ProbeRepository(repository),
    new CountingAdapter(new FilesystemFixtureAdapter(originalRoot)),
  )
  const correctRootRetry = lifecycle.retryCleanup(run.runID, actor)
  expect(correctRootRetry).toMatchObject({
    run: { lifecycle: "completed", verdict: "passed", cleanupState: "complete" },
    cleanupState: "complete",
  })
  expect(callbacks).toBe(1)
  expect(existsSync(join(originalRoot, input.name))).toBe(false)
  expect(existsSync(join(wrongRoot, input.name))).toBe(false)
  expect(lifecycle.resources.cleanupReceiptCount(run.runID)).toBe(1)
  expect(lifecycle.resources.claimed(persisted.resourceKey)).toBeUndefined()
})

test("reopen reconciles before-create and after-create-before-receipt cuts without duplicate creation", async () => {
  const directory = temporaryDirectory()
  const databasePath = join(directory, "tasks.sqlite")
  const root = join(directory, "fixtures")
  mkdirSync(root)
  let repository = open(databasePath)
  let { actor, run } = addRun(repository, "restart-before-create")
  let store = new ResourceRepository(repository)
  const adapter = new CountingAdapter(new FilesystemFixtureAdapter(root))
  const beforeInput = resourceInput("restart-before-create-input", "before-create")
  const beforeDescriptor = adapter.describe(beforeInput)
  expect(store.registerBatch(ownerFor(repository, run), [beforeDescriptor]).status).toBe("reserved")
  expect(existsSync(join(root, beforeInput.name))).toBe(false)
  repository.close()

  repository = open(databasePath)
  const reopenedProbes = new ProbeRepository(repository)
  const lifecycle = lifecycleFor(repository, reopenedProbes, adapter)
  let callbacks = 0
  const before = await lifecycle.withOwnedResources(
    { runID: run.runID, actor, resources: [beforeInput] },
    () => {
      callbacks++
      return { verdict: "passed", value: "resumed before create" }
    },
  )
  expect(before).toMatchObject({
    status: "executed",
    run: { verdict: "passed", cleanupState: "complete" },
  })
  expect(adapter.creates).toBe(1)
  expect(callbacks).toBe(1)

  const second = addRun(repository, "restart-after-create")
  actor = second.actor
  run = second.run
  store = new ResourceRepository(repository)
  const afterInput = resourceInput("restart-after-create-input", "after-create")
  const afterDescriptor = adapter.describe(afterInput)
  const reservation = store.registerBatch(ownerFor(repository, run), [afterDescriptor])
  if (reservation.status === "conflict") throw new Error("Expected reservation")
  const record = reservation.resources[0]!
  expect(store.claimPreparation(run.runID)).toBe(true)
  adapter.reserve(record, reservation.coordinatorID)
  store.setState(record.resourceID, "creating", "Simulated committed create intent")
  adapter.create(record, reservation.coordinatorID)
  expect(store.resource(record.resourceID)?.state).toBe("creating")
  repository.close()

  repository = open(databasePath)
  const secondReopenedProbes = new ProbeRepository(repository)
  const restartedAdapter = adapter
  const restarted = lifecycleFor(repository, secondReopenedProbes, restartedAdapter)
  const waiting = await restarted.withOwnedResources(
    { runID: run.runID, actor, resources: [afterInput] },
    () => {
      callbacks++
      return { verdict: "passed", value: "resumed after create" }
    },
  )
  expect(waiting).toMatchObject({ status: "replayed", cleanupState: "pending" })
  expect(existsSync(join(root, afterInput.name))).toBe(true)
  expect(callbacks).toBe(1)
  expect(() => restarted.retryCleanup(run.runID, actor)).toThrow(
    "explicit stopped-worker reconciliation",
  )
  expect(() => restarted.reconcile(run.runID, actor)).toThrow("Confirm the prior worker stopped")

  const after = restarted.reconcile(run.runID, actor, { workerStopped: true })
  expect(after).toMatchObject({
    status: "interrupted",
    run: { lifecycle: "interrupted", verdict: null, cleanupState: "complete" },
  })
  expect(adapter.creates).toBe(2)
  expect(callbacks).toBe(1)
  expect(existsSync(join(root, afterInput.name))).toBe(false)
})

test("a concurrent replay cannot duplicate probe behavior or clean up another active invocation", async () => {
  const directory = temporaryDirectory()
  const repository = open(join(directory, "tasks.sqlite"))
  const root = join(directory, "fixtures")
  mkdirSync(root)
  const { actor, probes, run } = addRun(repository, "concurrent-replay")
  const adapter = new CountingAdapter(new FilesystemFixtureAdapter(root))
  const lifecycle = lifecycleFor(repository, probes, adapter)
  const input = resourceInput("concurrent-replay-input", "concurrent-fixture")
  let callbackStarted!: () => void
  let finishProbe!: () => void
  const started = new Promise<void>((resolve) => (callbackStarted = resolve))
  const held = new Promise<void>((resolve) => (finishProbe = resolve))
  let callbacks = 0
  const first = lifecycle.withOwnedResources(
    { runID: run.runID, actor, resources: [input] },
    async () => {
      callbacks++
      callbackStarted()
      await held
      return { verdict: "passed", value: "completed once" }
    },
  )
  await started

  const replay = await lifecycle.withOwnedResources(
    { runID: run.runID, actor, resources: [input] },
    () => {
      callbacks++
      return { verdict: "passed", value: "must not replay" }
    },
  )
  expect(replay).toMatchObject({ status: "replayed", cleanupState: "pending" })
  expect(callbacks).toBe(1)
  expect(adapter.creates).toBe(1)
  expect(adapter.removes).toBe(0)
  expect(existsSync(join(root, input.name))).toBe(true)
  expect(() => lifecycle.retryCleanup(run.runID, actor)).toThrow(
    "explicit stopped-worker reconciliation",
  )

  finishProbe()
  const completed = await first
  expect(completed.run).toMatchObject({ verdict: "passed", cleanupState: "complete" })
  expect(callbacks).toBe(1)
  expect(adapter.removes).toBe(1)
  expect(existsSync(join(root, input.name))).toBe(false)
})

test("reopen after delete-before-receipt accepts only authoritative absence and preserves pass", async () => {
  const directory = temporaryDirectory()
  const databasePath = join(directory, "tasks.sqlite")
  const root = join(directory, "fixtures")
  mkdirSync(root)
  let repository = open(databasePath)
  const { actor, probes, run } = addRun(repository, "restart-after-delete")
  const adapter = new CountingAdapter(new FilesystemFixtureAdapter(root))
  adapter.removeFailure = "after"
  let lifecycle = lifecycleFor(repository, probes, adapter)
  const input = resourceInput("restart-after-delete-input", "after-delete")
  let callbacks = 0
  const first = await lifecycle.withOwnedResources(
    { runID: run.runID, actor, resources: [input] },
    () => {
      callbacks++
      return { verdict: "passed", value: "already passed" }
    },
  )
  expect(first.run).toMatchObject({ verdict: "passed", cleanupState: "failed" })
  expect(existsSync(join(root, input.name))).toBe(false)
  expect(lifecycle.resources.cleanupReceiptCount(run.runID)).toBe(0)
  repository.close()

  repository = open(databasePath)
  const reopenedProbes = new ProbeRepository(repository)
  lifecycle = lifecycleFor(repository, reopenedProbes, adapter)
  const reconciled = lifecycle.retryCleanup(run.runID, actor)
  expect(reconciled.run).toMatchObject({
    lifecycle: "completed",
    verdict: "passed",
    cleanupState: "complete",
  })
  expect(callbacks).toBe(1)
  expect(lifecycle.resources.cleanupReceiptCount(run.runID)).toBe(1)
})

test("unknown observations stay claimed and foreign fixture content is never removed", async () => {
  const directory = temporaryDirectory()
  const repository = open(join(directory, "tasks.sqlite"))
  const root = join(directory, "fixtures")
  mkdirSync(root)

  const unknown = addRun(repository, "unknown-observation")
  const unknownAdapter = new CountingAdapter(new FilesystemFixtureAdapter(root))
  unknownAdapter.observeOverride = () => ({
    state: "unknown",
    authoritative: false,
    reason: "simulated uncertain read",
  })
  const unknownLifecycle = lifecycleFor(repository, unknown.probes, unknownAdapter)
  const unknownInput = resourceInput("unknown-observation-input", "unknown-fixture")
  let unknownCallbacks = 0
  const unknownResult = await unknownLifecycle.withOwnedResources(
    { runID: unknown.run.runID, actor: unknown.actor, resources: [unknownInput] },
    () => {
      unknownCallbacks++
      return { verdict: "passed", value: "must not run" }
    },
  )
  expect(unknownResult.run).toMatchObject({
    verdict: "environment-blocked",
    cleanupState: "failed",
  })
  expect(unknownCallbacks).toBe(0)
  expect(unknownLifecycle.resources.resourcesForRun(unknown.run.runID)).toMatchObject([
    { state: "uncertain" },
  ])
  expect(
    unknownLifecycle.resources.claimed(unknownAdapter.inner.describe(unknownInput).resourceKey),
  ).toBeDefined()

  const nonauthoritative = addRun(repository, "nonauthoritative-absence")
  const nonauthoritativeAdapter = new CountingAdapter(new FilesystemFixtureAdapter(root))
  nonauthoritativeAdapter.observeOverride = () => ({
    state: "absent",
    authoritative: false,
    reason: "simulated weak absence",
  })
  const nonauthoritativeLifecycle = lifecycleFor(
    repository,
    nonauthoritative.probes,
    nonauthoritativeAdapter,
  )
  const weakInput = resourceInput("weak-absence-input", "weak-absence-fixture")
  const weakResult = await nonauthoritativeLifecycle.withOwnedResources(
    { runID: nonauthoritative.run.runID, actor: nonauthoritative.actor, resources: [weakInput] },
    () => ({ verdict: "passed", value: "must not run" }),
  )
  expect(weakResult.run).toMatchObject({ verdict: "environment-blocked", cleanupState: "failed" })
  expect(
    nonauthoritativeLifecycle.resources.resourcesForRun(nonauthoritative.run.runID),
  ).toMatchObject([{ state: "uncertain" }])
  expect(existsSync(join(root, weakInput.name))).toBe(false)

  const foreign = addRun(repository, "foreign-content")
  const foreignName = "foreign-fixture"
  mkdirSync(join(root, foreignName))
  writeFileSync(join(root, foreignName, "unowned.txt"), "keep this data")
  const foreignAdapter = new CountingAdapter(new FilesystemFixtureAdapter(root))
  const foreignLifecycle = lifecycleFor(repository, foreign.probes, foreignAdapter)
  const foreignResult = await foreignLifecycle.withOwnedResources(
    {
      runID: foreign.run.runID,
      actor: foreign.actor,
      resources: [resourceInput("foreign-content-input", foreignName)],
    },
    () => ({ verdict: "passed", value: "must not run" }),
  )
  expect(foreignResult.run).toMatchObject({
    verdict: "environment-blocked",
    cleanupState: "failed",
  })
  expect(readFileSync(join(root, foreignName, "unowned.txt"), "utf8")).toBe("keep this data")
  expect(foreignAdapter.removes).toBe(0)
  expect(foreignLifecycle.resources.resourcesForRun(foreign.run.runID)).toMatchObject([
    { state: "uncertain" },
  ])
})

test("shared and independent coordinators fail closed across canonical root aliases", async () => {
  const directory = temporaryDirectory()
  const databasePath = join(directory, "shared.sqlite")
  const independentDatabase = join(directory, "independent.sqlite")
  const root = join(directory, "fixtures")
  const rootAlias = join(directory, "fixture-alias")
  mkdirSync(root)
  symlinkSync(root, rootAlias, "dir")
  const local = open(databasePath)
  const foreignProject = open(databasePath, "/foreign-project")
  const independent = open(independentDatabase, "/independent-project")
  const first = addRun(local, "shared-owner")
  const firstAdapter = new CountingAdapter(new FilesystemFixtureAdapter(root))
  const firstLifecycle = lifecycleFor(local, first.probes, firstAdapter)
  let callbackStarted!: () => void
  let finishProbe!: () => void
  const started = new Promise<void>((resolve) => (callbackStarted = resolve))
  const held = new Promise<void>((resolve) => (finishProbe = resolve))
  const firstRun = firstLifecycle.withOwnedResources(
    {
      runID: first.run.runID,
      actor: first.actor,
      resources: [resourceInput("shared-owner-input", "shared-device")],
    },
    async () => {
      callbackStarted()
      await held
      return { verdict: "passed", value: "done" }
    },
  )
  await started

  const sharedCompetitor = addRun(foreignProject, "shared-competitor")
  const sharedAdapter = new CountingAdapter(new FilesystemFixtureAdapter(rootAlias))
  const sharedLifecycle = lifecycleFor(foreignProject, sharedCompetitor.probes, sharedAdapter)
  let sharedCallback = false
  await expect(
    sharedLifecycle.withOwnedResources(
      {
        runID: sharedCompetitor.run.runID,
        actor: sharedCompetitor.actor,
        resources: [resourceInput("shared-competitor-input", "SHARED-DEVICE")],
      },
      () => {
        sharedCallback = true
        return { verdict: "passed", value: "wrong" }
      },
    ),
  ).rejects.toThrow("registration failed")
  expect(sharedCallback).toBe(false)
  expect(sharedAdapter.creates).toBe(0)

  const independentCompetitor = addRun(independent, "independent-competitor")
  const independentAdapter = new CountingAdapter(new FilesystemFixtureAdapter(rootAlias))
  const independentLifecycle = lifecycleFor(
    independent,
    independentCompetitor.probes,
    independentAdapter,
  )
  let independentCallback = false
  const independentResult = await independentLifecycle.withOwnedResources(
    {
      runID: independentCompetitor.run.runID,
      actor: independentCompetitor.actor,
      resources: [resourceInput("independent-competitor-input", "shared-device")],
    },
    () => {
      independentCallback = true
      return { verdict: "passed", value: "wrong" }
    },
  )
  expect(independentResult.run).toMatchObject({
    verdict: "environment-blocked",
    cleanupState: "failed",
  })
  expect(independentCallback).toBe(false)
  expect(independentAdapter.creates).toBe(0)
  expect(existsSync(join(root, "shared-device"))).toBe(true)

  finishProbe()
  const completed = await firstRun
  expect(completed.run).toMatchObject({ verdict: "passed", cleanupState: "complete" })
  expect(existsSync(join(root, "shared-device"))).toBe(false)
})

test("unsafe fixture paths and failed registration prevent filesystem creation", async () => {
  const directory = temporaryDirectory()
  const repository = open(join(directory, "tasks.sqlite"))
  const root = join(directory, "fixtures")
  mkdirSync(root)
  const { actor, probes, run } = addRun(repository, "unsafe-path")
  const adapter = new CountingAdapter(new FilesystemFixtureAdapter(root))
  const lifecycle = lifecycleFor(repository, probes, adapter)
  expect(() => adapter.describe(resourceInput("unsafe-path-input", "../outside"))).toThrow()
  expect(() => adapter.describe(resourceInput("nested-path-input", "nested/fixture"))).toThrow()
  expect(() =>
    adapter.describe(
      resourceInput("secret-fixture-input", "secret-fixture", 1, "Bearer abcdefghijklmnop"),
    ),
  ).toThrow()

  lifecycle.resources.coordinatorID()
  repository.atomic((db) =>
    db.exec(`CREATE TRIGGER reject_fixture_registration BEFORE INSERT ON owned_resources
      BEGIN SELECT RAISE(ABORT, 'registration denied'); END`),
  )
  let callbacks = 0
  await expect(
    lifecycle.withOwnedResources(
      {
        runID: run.runID,
        actor,
        resources: [resourceInput("registration-denied", "never-created")],
      },
      () => {
        callbacks++
        return { verdict: "passed", value: "unreachable" }
      },
    ),
  ).rejects.toThrow("registration denied")
  expect(callbacks).toBe(0)
  expect(adapter.creates).toBe(0)
  expect(existsSync(join(root, "never-created"))).toBe(false)
})
