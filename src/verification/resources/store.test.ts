import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keyedProposal, validProposal } from "../../../test/proposal.ts"
import { TaskRepository } from "../../storage.ts"
import { RunnerStore } from "../../runner/store.ts"
import { submitTask } from "../../submission.ts"
import { ProbeRepository } from "../probe/store.ts"
import type { ProbeActor } from "../probe/schema.ts"
import { FilesystemFixtureAdapter } from "./fixture.ts"
import { ResourceRepository } from "./store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-resource-store-"))
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
      `${repository.projectDirectory}/candidate-worktree`,
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
      candidate: {
        revision: "b".repeat(40),
        workspace: `${repository.projectDirectory}/candidate-worktree`,
      },
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

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("resource registrations are durable, idempotent, generation-bound, and project-exclusive", () => {
  const directory = temporaryDirectory()
  const databasePath = join(directory, "tasks.sqlite")
  const root = join(directory, "fixtures")
  mkdirSync(root)
  const local = open(databasePath)
  const foreign = open(databasePath, "/other-project")
  const first = addRun(local, "store-local")
  const second = addRun(foreign, "store-foreign")
  const store = new ResourceRepository(local)
  const adapter = new FilesystemFixtureAdapter(root)
  const owner = {
    projectDirectory: local.projectDirectory,
    runID: first.run.runID,
    taskID: first.run.taskID,
    planID: first.run.planID,
    attemptID: first.run.attemptID,
    sessionID: first.run.sessionID,
    producer: first.run.producer,
    candidate: first.run.candidate,
    environment: first.run.environment,
  }
  const fixture = adapter.describe({
    requestID: "register-first",
    generation: 1,
    name: "shared-fixture",
    contents: "disposable value",
  })

  const registration = store.registerBatch(owner, [fixture])
  expect(registration.status).toBe("reserved")
  if (registration.status === "conflict") throw new Error("Expected reservation")
  expect(registration.resources[0]).toMatchObject({
    runID: first.run.runID,
    owner: { taskID: first.run.taskID, planID: first.run.planID, attemptID: first.run.attemptID },
    state: "reserved",
  })
  expect(store.claimed(fixture.resourceKey)?.resourceID).toBe(registration.resources[0]!.resourceID)
  expect(store.registerBatch(owner, [fixture])).toMatchObject({
    status: "replayed",
    resources: [{ resourceID: registration.resources[0]!.resourceID }],
  })
  expect(store.registerBatch(owner, [{ ...fixture, contents: "changed payload" }])).toMatchObject({
    status: "conflict",
  })

  const foreignOwner = {
    projectDirectory: foreign.projectDirectory,
    runID: second.run.runID,
    taskID: second.run.taskID,
    planID: second.run.planID,
    attemptID: second.run.attemptID,
    sessionID: second.run.sessionID,
    producer: second.run.producer,
    candidate: second.run.candidate,
    environment: second.run.environment,
  }
  expect(
    new ResourceRepository(foreign).registerBatch(foreignOwner, [
      { ...fixture, requestID: "foreign-project-claim" },
    ]),
  ).toMatchObject({ status: "conflict" })

  const current = registration.resources[0]!
  expect(adapter.observe(current, registration.coordinatorID)).toMatchObject({
    state: "absent",
    authoritative: true,
  })
  adapter.release(current, registration.coordinatorID)
  store.setState(current.resourceID, "removed", "Adapter confirmed fixture absence")
  expect(store.cleanupReceiptCount(first.run.runID)).toBe(1)
  expect(
    store.registerBatch(owner, [{ ...fixture, requestID: "stale-generation", generation: 1 }]),
  ).toMatchObject({ status: "conflict", message: expect.stringContaining("generation") })
  expect(
    store.registerBatch(owner, [{ ...fixture, requestID: "next-generation", generation: 2 }]),
  ).toMatchObject({ status: "reserved" })
})

test("registration failure rolls back the whole batch before a caller can create fixtures", () => {
  const directory = temporaryDirectory()
  const path = join(directory, "tasks.sqlite")
  const root = join(directory, "fixtures")
  mkdirSync(root)
  const repository = open(path)
  const { run } = addRun(repository, "store-rollback")
  const store = new ResourceRepository(repository)
  const adapter = new FilesystemFixtureAdapter(root)
  const owner = {
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
  const input = adapter.describe({
    requestID: "trigger-rejected",
    generation: 1,
    name: "never-created",
    contents: "no effect",
  })
  store.coordinatorID()
  repository.atomic((db) =>
    db.exec(`CREATE TRIGGER reject_owned_resource BEFORE INSERT ON owned_resources
      BEGIN SELECT RAISE(ABORT, 'simulated registration failure'); END`),
  )
  expect(() => store.registerBatch(owner, [input])).toThrow("simulated registration failure")
  expect(store.resourcesForRun(run.runID)).toEqual([])
  expect(existsSync(join(root, input.name))).toBe(false)
})
