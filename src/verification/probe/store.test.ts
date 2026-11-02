import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keyedProposal, validProposal } from "../../../test/proposal.ts"
import { TaskRepository } from "../../storage.ts"
import { RunnerStore } from "../../runner/store.ts"
import { submitTask } from "../../submission.ts"
import { ProbeRepository } from "./store.ts"
import type { ProbeActor, ProbeBasis, ProbeRunStartInput } from "./schema.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []

function databasePath() {
  const path = mkdtempSync(join(tmpdir(), "lazers-probe-"))
  directories.push(path)
  return join(path, "tasks.sqlite")
}

function open(path: string, projectDirectory = "/project") {
  const repository = new TaskRepository(path, projectDirectory)
  repositories.push(repository)
  return repository
}

function taskProvenance(projectDirectory = "/project") {
  return {
    projectID: projectDirectory,
    projectDirectory,
    workspaceDirectory: `${projectDirectory}/authoring-worktree`,
    sessionID: "task-author-session",
    startingRevision: { kind: "unborn" as const },
  }
}

function addTask(
  repository: TaskRepository,
  requestID: string,
  acceptance = validProposal().acceptance,
) {
  const result = submitTask(repository, { ...keyedProposal(requestID), acceptance }, () =>
    taskProvenance(repository.projectDirectory),
  )
  if (result.status !== "submitted") throw new Error("Expected submitted task")
  return repository.get(result.taskID)!
}

function addAttempt(repository: TaskRepository, taskID: string, sessionID = "worker-session") {
  const task = repository.get(taskID)!
  const runner = new RunnerStore(repository)
  const baseCommit = "a".repeat(40)
  const result = runner.submit(
    {
      requestID: `probe-plan-${taskID}`,
      objective: "Run a scoped probe fixture",
      baseCommit,
      nodes: [{ taskID, revision: task.revision }],
      dependencies: [],
      integrationOrder: [taskID],
      verification: task.proposal.verification,
      acceptance: task.proposal.acceptance,
    },
    "architect-session",
  )
  const attemptID = crypto.randomUUID()
  repository.atomic((db) => {
    db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
       VALUES(?,?,?,?,?,?,?,?,?,'running',?)`,
    ).run(
      attemptID,
      result.planID,
      taskID,
      1,
      sessionID,
      `message-${attemptID}`,
      `${repository.projectDirectory}/candidate-worktree`,
      baseCommit,
      JSON.stringify({ route: "fixture" }),
      Date.now(),
    )
  })
  return {
    attemptID,
    planID: result.planID,
    sessionID,
    workspace: `${repository.projectDirectory}/candidate-worktree`,
  }
}

const architect: ProbeActor = { sessionID: "architect-session", agent: "architect" }
const worker: ProbeActor = { sessionID: "worker-session", agent: "lazers-implementor" }

const procedure: ProbeBasis = { recordID: "runbook:reopen-flow", revision: "3" }
const inputs: ProbeBasis = { recordID: "fixture:submitted-task", revision: "fixture-8" }
const environment: ProbeBasis = { recordID: "desktop-profile:isolated", revision: "profile-2" }

function definitionInput(taskID: string, requestID = "probe-definition") {
  return {
    requestID,
    target: { kind: "task" as const, taskID },
    scenarios: [
      {
        id: "reopen-flow",
        summary: "Retrieve the same task after reopening the database",
        acceptanceIDs: ["reopen"],
        procedure,
      },
    ],
    notApplicable: [],
  }
}

function startInput(attemptID: string, requestID: string): ProbeRunStartInput {
  return {
    requestID,
    definitionID: "00000000-0000-4000-8000-000000000000",
    definitionRevision: 1,
    scenarioID: "reopen-flow",
    attemptID,
    candidate: { revision: "b".repeat(40), workspace: "/project/candidate-worktree" },
    inputs,
    environment,
    capabilities: ["desktop-interaction", "sqlite-inspection"],
    setupReferences: ["runbook:reopen-flow#setup"],
    fixtureReferences: ["fixture:submitted-task"],
    actions: [{ kind: "navigate", summary: "Open the task in the candidate application" }],
    observations: [
      { source: "tool-observation", fact: "The saved task is visible after reopening" },
      { source: "worker-commentary", fact: "The expected acceptance assertion was exercised" },
    ],
    evidenceReferences: [{ kind: "artifact", reference: "artifacts/probe-reopen.png" }],
    timing: { startedAt: null, finishedAt: null, elapsedMs: null },
    usage: { tokens: null, toolCalls: null, costUsd: null },
    cleanupState: "pending",
  }
}

function finishInput(
  runID: string,
  requestID: string,
  expectedVersion: number,
  lifecycle: "interrupted" | "cancelled" | "completed",
  verdict: "passed" | "product-failed" | "environment-blocked" | null,
  cleanupState: "not-required" | "pending" | "complete" | "failed" = "pending",
) {
  return {
    requestID,
    runID,
    expectedVersion,
    lifecycle,
    verdict,
    actions: [{ kind: "inspect" as const, summary: "Inspect the reopened task state" }],
    observations: [{ source: "tool-observation" as const, fact: "The task state was observed" }],
    evidenceReferences: [{ kind: "interaction" as const, reference: "trace:reopen-flow" }],
    timing: { startedAt: 100, finishedAt: lifecycle === "completed" ? 110 : null, elapsedMs: 10 },
    usage: { tokens: 0, toolCalls: 2, costUsd: null },
    cleanupState,
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

test("definitions cover every declared assertion and preserve authenticated Architect policy revisions", () => {
  const path = databasePath()
  const repository = open(path)
  const proposal = validProposal()
  const acceptance = [
    ...proposal.acceptance,
    {
      id: "cleanup",
      assertion: "The disposable fixture is removed and cleanup is confirmed",
      evidence: [{ kind: "artifact" as const, reference: "cleanup-record.txt" }],
    },
  ]
  const task = addTask(repository, "definition-task", acceptance)
  const probes = new ProbeRepository(repository)
  expect(
    repository.atomic((db) =>
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name='probe_definitions'",
        )
        .all(),
    ).length,
  ).toBe(0)

  expect(() => probes.define(definitionInput(task.id), architect)).toThrow(
    "Every acceptance assertion",
  )
  expect(() =>
    probes.define(
      {
        ...definitionInput(task.id),
        notApplicable: [{ acceptanceID: "made-up", reason: "No product surface exists" }],
      },
      architect,
    ),
  ).toThrow("Unknown acceptance assertion")
  expect(() =>
    probes.define(
      {
        ...definitionInput(task.id),
        scenarios: [],
        notApplicable: [
          { acceptanceID: "reopen", reason: "No product surface exists" },
          { acceptanceID: "cleanup", reason: "No product surface exists" },
        ],
      },
      worker,
    ),
  ).toThrow("Only the authenticated Architect")

  const policy = {
    ...definitionInput(task.id),
    notApplicable: [
      { acceptanceID: "cleanup", reason: "This task changes no live product surface" },
    ],
  }
  const first = probes.define(policy, architect)
  expect(first.status).toBe("created")
  if (first.status === "conflict") throw new Error("Expected definition")
  expect(first.definition).toMatchObject({
    schemaVersion: 1,
    revision: 1,
    target: { kind: "task", taskID: task.id },
    notApplicable: [{ acceptanceID: "cleanup" }],
    authoredBy: architect,
  })
  expect(probes.define(policy, architect)).toMatchObject({
    status: "replayed",
    definition: first.definition,
  })
  expect(
    probes.define(
      { ...policy, notApplicable: [{ acceptanceID: "cleanup", reason: "Changed policy" }] },
      architect,
    ),
  ).toMatchObject({ status: "conflict" })

  const revised = probes.define(
    {
      ...policy,
      requestID: "probe-definition-v2",
      definitionID: first.definition.definitionID,
      expectedRevision: 1,
      scenarios: [
        {
          ...policy.scenarios[0]!,
          procedure: { recordID: procedure.recordID, revision: "4" },
        },
      ],
    },
    architect,
  )
  expect(revised.status).toBe("revised")
  if (revised.status === "conflict") throw new Error("Expected revision")
  expect(revised.definition.revision).toBe(2)
  expect(probes.definition(first.definition.definitionID, 1)?.revision).toBe(1)
  expect(probes.definition(first.definition.definitionID)?.revision).toBe(2)
  expect(repository.get(task.id)?.proposal.acceptance).toEqual(acceptance)
  expect(repository.get(task.id)?.status).toBe("submitted")
})

test("task and combined-candidate definitions reject foreign task and plan ownership", () => {
  const path = databasePath()
  const repository = open(path)
  const foreignRepository = open(path, "/other")
  const localTask = addTask(repository, "local-task")
  const foreignTask = addTask(foreignRepository, "foreign-task")
  const foreignAttempt = addAttempt(foreignRepository, foreignTask.id, "foreign-worker-session")
  const probes = new ProbeRepository(repository)

  expect(() => probes.define(definitionInput(foreignTask.id), architect)).toThrow(
    "Task not found in this project",
  )
  expect(() =>
    probes.define(
      {
        requestID: "foreign-plan-definition",
        target: { kind: "combined-candidate", planID: foreignAttempt.planID },
        scenarios: [
          {
            id: "combined-smoke",
            summary: "Exercise the integrated candidate",
            acceptanceIDs: ["reopen"],
            procedure,
          },
        ],
        notApplicable: [],
      },
      architect,
    ),
  ).toThrow("Plan not found in this project")

  const localAttempt = addAttempt(repository, localTask.id)
  const planDefinition = probes.define(
    {
      requestID: "local-combined-definition",
      target: { kind: "combined-candidate", planID: localAttempt.planID },
      scenarios: [
        {
          id: "combined-smoke",
          summary: "Exercise the integrated candidate",
          acceptanceIDs: ["reopen"],
          procedure,
        },
      ],
      notApplicable: [],
    },
    architect,
  )
  expect(planDefinition.status).toBe("created")
  if (planDefinition.status === "conflict") throw new Error("Expected combined definition")
  expect(planDefinition.definition.target).toEqual({
    kind: "combined-candidate",
    planID: localAttempt.planID,
  })

  const foreignTaskAttempt = foreignAttempt
  const foreignCandidateDefinition = probes.define(
    {
      requestID: "task-definition-for-local",
      target: { kind: "task", taskID: localTask.id },
      scenarios: [
        {
          id: "reopen-flow",
          summary: "Retrieve the task after reopening",
          acceptanceIDs: ["reopen"],
          procedure,
        },
      ],
      notApplicable: [],
    },
    architect,
  )
  if (foreignCandidateDefinition.status === "conflict") throw new Error("Expected task definition")
  expect(() =>
    probes.startRun(
      {
        ...startInput(foreignTaskAttempt.attemptID, "foreign-attempt-run"),
        definitionID: foreignCandidateDefinition.definition.definitionID,
      },
      { ...worker, sessionID: foreignTaskAttempt.sessionID },
    ),
  ).toThrow("Attempt not found in this project")
})

test("behavior satisfaction is independent of cleanup while failed and unfinished probes remain unsatisfied", () => {
  const path = databasePath()
  const repository = open(path)
  const task = addTask(repository, "cleanup-not-required-task")
  const attempt = addAttempt(repository, task.id)
  const probes = new ProbeRepository(repository)
  const definition = probes.define(definitionInput(task.id), architect)
  if (definition.status === "conflict") throw new Error("Expected definition")
  const cases = [
    { lifecycle: "completed", verdict: "passed", cleanup: "not-required", satisfied: true },
    { lifecycle: "completed", verdict: "passed", cleanup: "complete", satisfied: true },
    { lifecycle: "completed", verdict: "passed", cleanup: "pending", satisfied: true },
    { lifecycle: "completed", verdict: "passed", cleanup: "failed", satisfied: true },
    {
      lifecycle: "completed",
      verdict: "product-failed",
      cleanup: "not-required",
      satisfied: false,
    },
    {
      lifecycle: "completed",
      verdict: "environment-blocked",
      cleanup: "not-required",
      satisfied: false,
    },
    { lifecycle: "interrupted", verdict: null, cleanup: "not-required", satisfied: false },
    { lifecycle: "cancelled", verdict: null, cleanup: "not-required", satisfied: false },
  ] as const
  const saved = cases.map((scenario, index) => {
    const input = {
      ...startInput(attempt.attemptID, `cleanup-start-${index}`),
      definitionID: definition.definition.definitionID,
      fixtureReferences: [],
    }
    const started = probes.startRun(input, worker)
    if (started.status === "conflict") throw new Error("Expected probe run")
    const finished = probes.updateRun(
      finishInput(
        started.run.runID,
        `cleanup-finish-${index}`,
        1,
        scenario.lifecycle,
        scenario.verdict,
        scenario.cleanup,
      ),
      worker,
    )
    if (finished.status === "conflict") throw new Error("Expected probe update")
    return { input, scenario, runID: finished.run.runID }
  })
  repository.close()
  const reopened = new ProbeRepository(open(path))
  for (const { input, scenario, runID } of saved) {
    expect(
      reopened.eligibility(runID, { candidate: input.candidate, procedure, inputs, environment }),
    ).toMatchObject({
      eligible: true,
      satisfied: scenario.satisfied,
      cleanupState: scenario.cleanup,
      lifecycle: scenario.lifecycle,
      verdict: scenario.verdict,
    })
  }
})

test("SQLite reopen preserves independent, actor-bound probe receipts and cleanup remains separate from pass", () => {
  const path = databasePath()
  const repository = open(path)
  const task = addTask(repository, "durable-run-task")
  const attempt = addAttempt(repository, task.id)
  const probes = new ProbeRepository(repository)
  const definition = probes.define(definitionInput(task.id), architect)
  if (definition.status === "conflict") throw new Error("Expected definition")
  const firstInput = {
    ...startInput(attempt.attemptID, "run-start-one"),
    definitionID: definition.definition.definitionID,
  }
  expect(() =>
    probes.startRun(
      {
        ...firstInput,
        requestID: "forged-architect-observation",
        observations: [
          { source: "architect-judgment", fact: "The worker claims Architect approval" },
        ],
      },
      worker,
    ),
  ).toThrow("cannot claim Architect judgment provenance")
  expect(() =>
    probes.startRun(
      {
        ...firstInput,
        requestID: "foreign-candidate-workspace",
        candidate: { ...firstInput.candidate, workspace: "/other/candidate-worktree" },
      },
      worker,
    ),
  ).toThrow("match the original attempt")
  const first = probes.startRun(firstInput, worker)
  if (first.status === "conflict") throw new Error("Expected run")
  expect(first.run.runID).not.toBe(attempt.attemptID)
  expect(first.run).toMatchObject({
    attemptID: attempt.attemptID,
    sessionID: attempt.sessionID,
    producer: worker,
    target: { kind: "task", taskID: task.id },
    candidate: firstInput.candidate,
    procedure,
    inputs,
    environment,
    capabilities: firstInput.capabilities,
    setupReferences: firstInput.setupReferences,
    fixtureReferences: firstInput.fixtureReferences,
    actions: firstInput.actions,
    observations: firstInput.observations,
    evidenceReferences: firstInput.evidenceReferences,
    lifecycle: "pending",
    verdict: null,
    cleanupState: "pending",
    timing: { startedAt: null, finishedAt: null, elapsedMs: null },
    usage: { tokens: null, toolCalls: null, costUsd: null },
  })
  const replay = probes.startRun(firstInput, worker)
  expect(replay).toMatchObject({ status: "replayed", run: { runID: first.run.runID } })
  expect(
    probes.startRun(
      { ...firstInput, candidate: { ...firstInput.candidate, revision: "c".repeat(40) } },
      worker,
    ),
  ).toMatchObject({ status: "conflict" })
  expect(() =>
    probes.startRun(
      { ...firstInput, requestID: "wrong-session" },
      { ...worker, sessionID: "other-session" },
    ),
  ).toThrow("original attempt session")

  const second = probes.startRun({ ...firstInput, requestID: "run-start-two" }, worker)
  if (second.status === "conflict") throw new Error("Expected independent run")
  expect(second.run.runID).not.toBe(first.run.runID)
  expect(probes.runsForAttempt(attempt.attemptID)).toHaveLength(2)

  repository.close()
  const reopenedRepository = open(path)
  const reopened = new ProbeRepository(reopenedRepository)
  expect(reopened.run(first.run.runID)).toEqual(first.run)
  expect(reopened.run(second.run.runID)).toEqual(second.run)
  const reopenedRuns = reopened.runsForAttempt(attempt.attemptID)
  expect(reopenedRuns).toHaveLength(2)
  expect(reopenedRuns.map((run) => run.runID)).toEqual(
    expect.arrayContaining([first.run.runID, second.run.runID]),
  )
  expect(new ProbeRepository(open(path, "/other")).run(first.run.runID)).toBeUndefined()

  expect(() =>
    reopened.updateRun(finishInput(first.run.runID, "foreign-update", 1, "completed", "passed"), {
      sessionID: "other-session",
      agent: "lazers-implementor",
    }),
  ).toThrow("belongs to another actor")
  const completedInput = finishInput(first.run.runID, "finish-pass", 1, "completed", "passed")
  const completed = reopened.updateRun(completedInput, worker)
  if (completed.status === "conflict") throw new Error("Expected completed receipt")
  expect(completed.run).toMatchObject({
    lifecycle: "completed",
    verdict: "passed",
    cleanupState: "pending",
    usage: { tokens: 0, toolCalls: 2, costUsd: null },
  })
  expect(reopened.updateRun(completedInput, worker)).toMatchObject({
    status: "replayed",
    run: { version: 2, verdict: "passed" },
  })
  expect(reopened.updateRun({ ...completedInput, cleanupState: "complete" }, worker)).toMatchObject(
    { status: "conflict" },
  )
  expect(
    reopened.eligibility(first.run.runID, {
      candidate: firstInput.candidate,
      procedure,
      inputs,
      environment,
    }),
  ).toMatchObject({ eligible: true, satisfied: true, verdict: "passed", cleanupState: "pending" })

  const cleanup = reopened.updateRun(
    finishInput(first.run.runID, "cleanup-confirmed", 2, "completed", "passed", "complete"),
    worker,
  )
  if (cleanup.status === "conflict") throw new Error("Expected cleanup update")
  expect(cleanup.run.runID).toBe(first.run.runID)
  expect(cleanup.run.verdict).toBe("passed")
  expect(reopened.runsForAttempt(attempt.attemptID)).toHaveLength(2)
  expect(
    reopened.eligibility(first.run.runID, {
      candidate: firstInput.candidate,
      procedure,
      inputs,
      environment,
    }),
  ).toMatchObject({ eligible: true, satisfied: true, cleanupState: "complete" })
  expect(() =>
    reopened.updateRun(
      finishInput(first.run.runID, "stale-update", 1, "completed", "passed"),
      worker,
    ),
  ).toThrow("version is stale")
})

test("run lifecycle, verdict, cleanup failures and transactional rollback remain distinct", () => {
  const path = databasePath()
  const repository = open(path)
  const task = addTask(repository, "lifecycle-task")
  const attempt = addAttempt(repository, task.id)
  const probes = new ProbeRepository(repository)
  const definition = probes.define(definitionInput(task.id), architect)
  if (definition.status === "conflict") throw new Error("Expected definition")
  const start = (requestID: string) => {
    const result = probes.startRun(
      {
        ...startInput(attempt.attemptID, requestID),
        definitionID: definition.definition.definitionID,
      },
      worker,
    )
    if (result.status === "conflict") throw new Error("Expected run")
    return result.run
  }

  const interrupted = start("interrupted-run")
  const interruption = probes.updateRun(
    finishInput(interrupted.runID, "interrupt-run", 1, "interrupted", null),
    worker,
  )
  if (interruption.status === "conflict") throw new Error("Expected interruption")
  const cancelled = probes.updateRun(
    finishInput(interrupted.runID, "cancel-run", 2, "cancelled", null),
    worker,
  )
  if (cancelled.status === "conflict") throw new Error("Expected cancellation")
  expect(cancelled.run).toMatchObject({ lifecycle: "cancelled", verdict: null })
  expect(() =>
    probes.updateRun(
      finishInput(interrupted.runID, "uncancel-run", 3, "completed", "passed"),
      worker,
    ),
  ).toThrow("Invalid probe lifecycle transition")

  const productFailure = start("product-failure-run")
  const failed = probes.updateRun(
    finishInput(productFailure.runID, "product-failed", 1, "completed", "product-failed", "failed"),
    worker,
  )
  if (failed.status === "conflict") throw new Error("Expected product failure")
  expect(failed.run).toMatchObject({
    lifecycle: "completed",
    verdict: "product-failed",
    cleanupState: "failed",
  })

  const blockedRun = start("environment-blocked-run")
  const blocked = probes.updateRun(
    finishInput(blockedRun.runID, "environment-blocked", 1, "completed", "environment-blocked"),
    worker,
  )
  if (blocked.status === "conflict") throw new Error("Expected environment blockage")
  expect(blocked.run).toMatchObject({ lifecycle: "completed", verdict: "environment-blocked" })

  const rolledBackInput = {
    ...startInput(attempt.attemptID, "rolled-back-run"),
    definitionID: definition.definition.definitionID,
  }
  let rolledBackID: string | undefined
  expect(() =>
    repository.atomic(() => {
      const result = probes.startRun(rolledBackInput, worker)
      if (result.status === "conflict") throw new Error("Unexpected conflict")
      rolledBackID = result.run.runID
      throw new Error("rollback the surrounding transaction")
    }),
  ).toThrow("rollback the surrounding transaction")
  expect(rolledBackID).toBeDefined()
  expect(probes.run(rolledBackID!)).toBeUndefined()

  repository.atomic((db) =>
    db.exec(`CREATE TRIGGER reject_probe_update BEFORE INSERT ON probe_run_updates
      BEGIN SELECT RAISE(ABORT, 'simulated update persistence failure'); END`),
  )
  const fresh = start("atomic-update-run")
  const update = finishInput(fresh.runID, "atomic-update", 1, "completed", "passed")
  expect(() => probes.updateRun(update, worker)).toThrow("simulated update persistence failure")
  expect(probes.run(fresh.runID)).toMatchObject({ version: 1, lifecycle: "pending", verdict: null })
  repository.atomic((db) => db.exec("DROP TRIGGER reject_probe_update"))
  expect(probes.updateRun(update, worker)).toMatchObject({ status: "updated", run: { version: 2 } })
})

test("durable record revisions invalidate only mismatched receipts without deleting them", () => {
  const path = databasePath()
  const repository = open(path)
  const task = addTask(repository, "eligibility-task")
  const attempt = addAttempt(repository, task.id)
  const probes = new ProbeRepository(repository)
  const definition = probes.define(definitionInput(task.id), architect)
  if (definition.status === "conflict") throw new Error("Expected definition")
  const input = {
    ...startInput(attempt.attemptID, "eligibility-run"),
    definitionID: definition.definition.definitionID,
  }
  const started = probes.startRun(input, worker)
  if (started.status === "conflict") throw new Error("Expected run")
  const current = { candidate: input.candidate, procedure, inputs, environment }
  expect(probes.eligibility(started.run.runID, current)).toMatchObject({
    eligible: true,
    satisfied: false,
    reasons: [],
  })
  expect(
    probes.eligibility(started.run.runID, {
      ...current,
      candidate: { ...current.candidate, revision: "c".repeat(40) },
    }).reasons,
  ).toContain("candidate-changed")
  expect(
    probes.eligibility(started.run.runID, {
      ...current,
      procedure: { recordID: procedure.recordID, revision: "4" },
    }).reasons,
  ).toContain("procedure-changed")
  expect(
    probes.eligibility(started.run.runID, {
      ...current,
      inputs: { recordID: inputs.recordID, revision: "fixture-9" },
    }).reasons,
  ).toContain("inputs-changed")
  expect(
    probes.eligibility(started.run.runID, {
      ...current,
      environment: { recordID: environment.recordID, revision: "profile-3" },
    }).reasons,
  ).toContain("environment-changed")

  const revision = probes.define(
    {
      ...definitionInput(task.id, "procedure-revision"),
      definitionID: definition.definition.definitionID,
      expectedRevision: 1,
      scenarios: [
        {
          ...definitionInput(task.id).scenarios[0]!,
          procedure: { recordID: procedure.recordID, revision: "4" },
        },
      ],
    },
    architect,
  )
  if (revision.status === "conflict") throw new Error("Expected definition revision")
  const stale = probes.eligibility(started.run.runID, current)
  expect(stale).toMatchObject({ eligible: false })
  expect(stale.reasons).toContain("definition-changed")
  expect(stale.reasons).toContain("procedure-definition-changed")
  expect(probes.runsForAttempt(attempt.attemptID)).toHaveLength(1)
  expect(probes.run(started.run.runID)?.procedure).toEqual(procedure)
})
