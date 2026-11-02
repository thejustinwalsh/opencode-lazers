import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import type { OutcomeInboxEntry } from "./inbox.ts"
import { TaskRuntime } from "./runtime.ts"
import { RunnerStore } from "./store.ts"
import { git, verificationEnvironmentIdentity } from "./artifacts.ts"

type Mode = "failed-task" | "blocked-combined"
type TestFixture = ReturnType<typeof fixture>

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fixture(mode: Mode, sharedAssertionID?: string) {
  const root = mkdtempSync(join(tmpdir(), "lazers-adopt-descendant-"))
  const data = mkdtempSync(join(tmpdir(), "lazers-adopt-data-"))
  git(root, ["init", "--initial-branch=main"])
  writeFileSync(join(root, "seed.txt"), "baseline\n")
  git(root, ["add", "seed.txt"])
  git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "baseline",
  ])
  const base = git(root, ["rev-parse", "HEAD"])
  const repositoryPath = join(data, "tasks.sqlite")
  const taskLog = join(data, "task-checks.log")
  const graphLog = join(data, "graph-checks.log")
  const taskGate = join(data, "task-check-gate")
  const taskStarted = join(data, "task-check-started")
  const taskRelease = join(data, "task-check-release")
  const taskTimeoutGate = join(data, "task-check-timeout-gate")
  const mutationGate = join(data, "task-check-mutation-gate")
  const graphGate = join(data, "graph-check-gate")
  const graphStarted = join(data, "graph-check-started")
  const graphRelease = join(data, "graph-check-release")
  const initialValue = mode === "failed-task" ? "bad" : "old"
  const repository = new TaskRepository(repositoryPath, root)
  const store = new RunnerStore(repository)
  const taskCommand =
    mode === "failed-task"
      ? `if [ -f '${taskGate}' ]; then printf started > '${taskStarted}'; while [ ! -f '${taskRelease}' ]; do sleep 0.01; done; fi; if [ -f '${taskTimeoutGate}' ]; then sleep 3; fi; if [ -f '${mutationGate}' ]; then printf mutated > result.txt; exit 0; fi; printf x >> '${taskLog}'; test "$(cat result.txt)" = good`
      : `printf x >> '${taskLog}'; test -s result.txt`
  const graphCommand = `if [ -f '${graphGate}' ]; then printf started > '${graphStarted}'; while [ ! -f '${graphRelease}' ]; do sleep 0.01; done; fi; printf x >> '${graphLog}'; test "$(cat result.txt)" = good`
  const task = (() => {
    const proposal = validProposal()
    proposal.objective = "Verify an adopted committed descendant"
    proposal.writeScope = ["result.txt"]
    proposal.verification = [{ id: "task-check", command: taskCommand, timeoutMs: 1000 }]
    proposal.acceptance = [
      {
        id: "task-result",
        assertion: "The task result satisfies its fresh check",
        evidence: [
          { kind: "verification", verificationID: "task-check" },
          ...(mode === "failed-task" || sharedAssertionID
            ? [{ kind: "human" as const, decision: "Review this exact task artifact" }]
            : []),
        ],
      },
    ]
    if (sharedAssertionID) proposal.acceptance[0]!.id = sharedAssertionID
    proposal.limits.maxRepairAttempts = 0
    return repository.insert({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      revision: 1,
      status: "submitted",
      createdAt: new Date().toISOString(),
      provenance: {
        projectID: "project",
        projectDirectory: root,
        workspaceDirectory: root,
        sessionID: "owner",
        startingRevision: { kind: "git" as const, commit: base },
      },
      proposal,
    })
  })()
  const taskAcceptance = [
    {
      id: sharedAssertionID ?? "combined-result",
      assertion: "The reviewed combined artifact contains the repaired result",
      evidence: [
        { kind: "verification" as const, verificationID: "combined-check" },
        { kind: "human" as const, decision: "Review the exact combined candidate" },
      ],
    },
  ]
  const events: string[] = []
  const sessions = new Map<string, HostSession>()
  const sessionReads: { id: string; messages: boolean }[] = []
  const inbox = new Map<string, OutcomeInboxEntry[]>()
  let loseNextWorktreeResponse = false
  let observationGate:
    | { promise: Promise<HostSession | null>; resolve: (session: HostSession | null) => void }
    | undefined
  let workerSessionHook: { remaining: number; action: () => void } | undefined
  const ownerSession: HostSession = {
    id: "owner",
    projectID: "project",
    directory: root,
    agent: "architect",
    archived: false,
    busy: false,
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    background: {
      state: "observed",
      source: "experimental.idle",
      observedAt: Date.now(),
      inputID: "architect-input",
      executionStartSequence: 1,
      eventSequence: 1,
      count: 0,
      kinds: { shell: 0, subagent: 0, image: 0 },
    },
    model: { providerID: "fixture", id: "architect" },
    tokens: null,
    tools: 0,
    cost: null,
    messages: [],
  }
  sessions.set(ownerSession.id, ownerSession)
  const host: RunnerHost = {
    workerModel: async () => ({ providerID: "fixture", id: "worker" }),
    worktree: async ({ directory, base: commit }) => {
      mkdirSync(dirname(directory), { recursive: true })
      git(root, ["worktree", "add", "--detach", directory, commit])
      const actual = realpathSync(directory)
      events.push(`worktree:${actual}`)
      if (loseNextWorktreeResponse) {
        loseNextWorktreeResponse = false
        throw new Error("worktree response lost after creation")
      }
      return actual
    },
    worktrees: async () =>
      git(root, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length)),
    removeWorktree: async (directory) => {
      git(root, ["worktree", "remove", directory])
      events.push(`remove:${directory}`)
    },
    session: async (id, options) => {
      sessionReads.push({ id, messages: options?.messages === true })
      if (observationGate && id !== "owner") return observationGate.promise
      if (id !== "owner" && workerSessionHook) {
        workerSessionHook.remaining--
        if (workerSessionHook.remaining === 0) {
          const hook = workerSessionHook.action
          workerSessionHook = undefined
          hook()
        }
      }
      const session = structuredClone(sessions.get(id) ?? null)
      if (session && id !== "owner") {
        if (!options?.messages) delete session.turn
        if (session.pendingInput === false) delete session.pendingInput
        if (session.pendingPermissions === 0) delete session.pendingPermissions
        if (session.pendingForms === 0) delete session.pendingForms
      }
      return session
    },
    outcomeInbox: async (sessionID) => structuredClone(inbox.get(sessionID) ?? []),
    architectInputPage: async (sessionID) => ({
      inbox: (inbox.get(sessionID) ?? []).map((entry) => ({
        id: entry.id,
        type: entry.type,
        ...(entry.delivery ? { delivery: entry.delivery } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      })),
      messages: (sessions.get(sessionID)?.messages ?? []).map((message) => ({
        id: message.id,
        type: message.type ?? "user",
        ...(message.metadata ? { metadata: message.metadata } : {}),
      })),
      nextCursor: null,
    }),
    cancelOutcome: async ({ sessionID, inboxID }) => {
      inbox.set(
        sessionID,
        (inbox.get(sessionID) ?? []).filter((entry) => entry.id !== inboxID),
      )
    },
    create: async (input) => {
      events.push(`create:${input.id}`)
      sessions.set(input.id, {
        id: input.id,
        parentID: input.parentID,
        projectID: "project",
        directory: input.directory,
        agent: input.agent,
        metadata: { lazersAttemptID: input.attemptID },
        model: input.model,
        archived: false,
        busy: false,
        pendingInput: false,
        pendingPermissions: 0,
        pendingForms: 0,
        background: {
          state: "observed",
          source: "experimental.idle",
          observedAt: Date.now(),
          inputID: "unassigned-input",
          executionStartSequence: 1,
          eventSequence: 1,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        tokens: null,
        tools: 0,
        cost: null,
        messages: [],
      })
    },
    createArchitect: async () => {
      throw new Error("Adoption must not create an Architect session")
    },
    prompt: async (input) => {
      events.push(`prompt:${input.id}`)
      const session = sessions.get(input.sessionID)!
      writeFileSync(join(input.directory, "result.txt"), `${initialValue}\n`)
      git(input.directory, ["add", "result.txt"])
      git(input.directory, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "initial worker artifact",
      ])
      session.messages.push({ id: input.id, text: input.text })
      session.busy = false
      session.pendingInput = false
      session.outcome = "succeeded"
      session.turn = { inputID: input.id, state: "completed" }
      session.background = {
        state: "observed",
        source: "experimental.idle",
        observedAt: Date.now(),
        inputID: input.id,
        executionStartSequence: 1,
        eventSequence: 2,
        terminalSequence: 2,
        count: 0,
        kinds: { shell: 0, subagent: 0, image: 0 },
      }
    },
    updateInstruction: async () => {
      throw new Error("Adoption must not update worker instructions")
    },
    notify: async (input) => {
      events.push(`notify:${input.id}`)
      const entries = inbox.get(input.sessionID) ?? []
      if (!entries.some((entry) => entry.id === input.id))
        entries.push({
          id: input.id,
          type: "synthetic",
          delivery: "queue",
          ...(input.metadata ? { metadata: input.metadata } : {}),
        })
      inbox.set(input.sessionID, entries)
    },
    interrupt: async (id) => {
      const session = sessions.get(id)
      if (session) {
        session.busy = false
        session.outcome = "interrupted"
      }
    },
  }
  const planInput = {
    requestID: "adoption-test-plan",
    objective: "Verify and accept an explicitly reviewed descendant without another worker turn",
    workspaceMode: "isolated" as const,
    baseCommit: base,
    workerModel: { providerID: "fixture", id: "worker" },
    nodes: [{ taskID: task.id, revision: 1 as const }],
    dependencies: [],
    integrationOrder: [task.id],
    verification: [{ id: "combined-check", command: graphCommand, timeoutMs: 5000 }],
    acceptance: taskAcceptance,
  }
  const submitted = store.submit(planInput, "owner") as { planID: string }
  const f = {
    root,
    data,
    base,
    task,
    taskLog,
    graphLog,
    taskGate,
    taskStarted,
    taskRelease,
    taskTimeoutGate,
    mutationGate,
    graphGate,
    graphStarted,
    graphRelease,
    initialValue,
    repositoryPath,
    repository,
    store,
    events,
    sessions,
    sessionReads,
    host,
    planID: submitted.planID,
    planInput,
    runtime: new TaskRuntime(store, host, "project"),
    get loseNextWorktreeResponse() {
      return loseNextWorktreeResponse
    },
    set loseNextWorktreeResponse(value: boolean) {
      loseNextWorktreeResponse = value
    },
    setObservationGate() {
      let resolve!: (session: HostSession | null) => void
      const promise = new Promise<HostSession | null>((done) => {
        resolve = done
      })
      observationGate = { promise, resolve }
      return (session: HostSession | null) => {
        observationGate?.resolve(session)
        observationGate = undefined
      }
    },
    setWorkerSessionHook(calls: number, action: () => void) {
      workerSessionHook = { remaining: calls, action }
    },
    async reopen() {
      await f.runtime.stop()
      f.repository.close()
      f.repository = new TaskRepository(repositoryPath, root)
      f.store = new RunnerStore(f.repository)
      f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
      f.runtime = new TaskRuntime(f.store, host, "project")
    },
  }
  cleanups.push(async () => {
    await f.runtime.stop()
    try {
      for (const directory of await host.worktrees())
        if (directory !== root && existsSync(directory)) {
          try {
            git(root, ["worktree", "remove", "--force", directory])
          } catch {
            rmSync(directory, { recursive: true, force: true })
          }
        }
    } catch {
      // The temporary repository may already have been removed.
    }
    f.repository.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  })
  return f
}

async function drive(runtime: TaskRuntime, count = 3) {
  for (let index = 0; index < count; index++) await runtime.tick()
}

async function strand(f: TestFixture) {
  await f.runtime.command(
    { requestID: "run-plan", planID: f.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime, 2)
  const node = f.store.nodes(f.planID)[0]!
  const attempt = f.store.attempts(f.planID)[0]!
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  if (f.initialValue === "bad") expect(node.state).toBe("failed")
  else expect(node.state).toBe("accepted")
  expect(attempt.artifact).toBe(node.artifact)
  return { node, attempt }
}

function trackedHistory(f: TestFixture) {
  return {
    transitions: f.store
      .activity(f.planID, f.task.id)
      .filter((entry) => ["ARTIFACT_ACCEPTED", "TASK_INTEGRATION_RECORDED"].includes(entry.event))
      .map((entry) => [entry.event, entry.payload]),
    evidence: f.store.atomic((db) =>
      db.query("SELECT * FROM runner_evidence WHERE plan_id=? ORDER BY id").all(f.planID),
    ),
    receipts: f.store
      .effects(f.planID)
      .filter(
        (effect) => effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:"),
      )
      .map((effect) => [effect.id, effect.state, effect.receipt]),
  }
}

function outboxHistory(f: TestFixture) {
  return f.store.atomic((db) =>
    db
      .query<{ id: string; payload: string; resume: number; metadata: string | null }, [string]>(
        "SELECT id,payload,resume,metadata FROM runner_outbox WHERE plan_id=? ORDER BY rowid",
      )
      .all(f.planID),
  )
}

function expectOutboxPreserved(f: TestFixture, before: ReturnType<typeof outboxHistory>) {
  const current = new Map(outboxHistory(f).map((row) => [row.id, row]))
  for (const row of before) expect(current.get(row.id)).toEqual(row)
}

function landCandidate(f: TestFixture, oldArtifact: string) {
  git(f.root, ["merge", "--ff-only", oldArtifact])
  writeFileSync(join(f.root, "result.txt"), "good\n")
  git(f.root, ["add", "result.txt"])
  git(f.root, [
    "-c",
    "user.name=reviewer",
    "-c",
    "user.email=reviewer@example.invalid",
    "commit",
    "-m",
    "reviewed descendant fix",
  ])
  return git(f.root, ["rev-parse", "HEAD"])
}

async function recordHumanEvidence(
  f: TestFixture,
  adoptionID: string,
  artifact: string,
  includeTask: boolean,
) {
  const expectedVersion = f.store.plan(f.planID)!.version
  if (includeTask)
    await f.runtime.command(
      {
        requestID: `human-task-${adoptionID}`,
        planID: f.planID,
        expectedVersion,
        action: "human-evidence",
        adoptionID,
        taskID: f.task.id,
        assertionID: "task-result",
        artifact,
        reason: "Reviewed the exact descendant task artifact",
      },
      "owner",
    )
  await f.runtime.command(
    {
      requestID: `human-combined-${adoptionID}`,
      planID: f.planID,
      expectedVersion,
      action: "human-evidence",
      adoptionID,
      assertionID: "combined-result",
      artifact,
      reason: "Reviewed the exact combined descendant artifact",
    },
    "owner",
  )
}

async function recordPhaseHumanEvidence(
  f: TestFixture,
  adoptionID: string,
  phase: "task" | "combined",
  assertionID: string,
  artifact: string,
) {
  await f.runtime.command(
    {
      requestID: `human-${phase}-${adoptionID}`,
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "human-evidence",
      adoptionID,
      ...(phase === "task" ? { taskID: f.task.id } : {}),
      assertionID,
      artifact,
      reason: `Reviewed the exact ${phase} adoption artifact`,
    },
    "owner",
  )
}

function adoptionCommand(
  f: TestFixture,
  attemptID: string,
  oldArtifact: string,
  candidate: string,
) {
  return {
    requestID: "adopt-reviewed-descendant",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "adopt-descendant",
    taskID: f.task.id,
    attemptID,
    artifact: oldArtifact,
    descendantCommit: candidate,
    targetBranch: "main",
    reason: "Reviewed and landed the correction on main",
  }
}

function reserveActiveWriter(f: TestFixture, writeScope: string[], label: string) {
  const taskID = crypto.randomUUID()
  const proposal = validProposal()
  proposal.writeScope = writeScope
  const task = f.repository.insert({
    schemaVersion: 1,
    id: taskID,
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
  const receipt = f.store.submit(
    {
      ...f.planInput,
      requestID: `active-writer-${label}`,
      nodes: [{ taskID: task.id, revision: 1 as const }],
      integrationOrder: [task.id],
    },
    "owner",
  )
  const writerPlan = f.store.plan(receipt.planID)!
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
        writerPlan.id,
        task.id,
        1,
        `session-${label}`,
        `message-${label}`,
        join(f.data, `worktree-${label}`),
        f.base,
        JSON.stringify({ source: f.base, model: { providerID: "fixture", id: "worker" } }),
        Date.now(),
      ),
  )
  return { task, plan: writerPlan, attemptID }
}

async function integratePlan(f: TestFixture) {
  const plan = f.store.plan(f.planID)!
  await f.runtime.command(
    {
      requestID: "integrate-adopted-plan",
      planID: f.planID,
      expectedVersion: plan.version,
      action: "integrated",
      artifact: plan.artifact!,
      targetBranch: "main",
      reason: "Reviewed and integrated the fresh combined acceptance",
    },
    "owner",
  )
  await drive(f.runtime, 4)
}

test("failed/READY task adopts only after fresh checks and new task/combined human evidence, including receipt recovery", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  f.store.move(f.planID, f.task.id, "RETRY", "Requeued without starting another worker")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("ready")
  const oldHistory = trackedHistory(f)
  const oldOutcomes = outboxHistory(f)
  const candidate = landCandidate(f, node.artifact!)
  f.loseNextWorktreeResponse = true
  const command = adoptionCommand(f, attempt.id, node.artifact!, candidate)
  const readsBeforeAdoption = f.sessionReads.length
  const requested = (await f.runtime.command(command, "owner")) as { adoptionID: string }
  expect(
    f.sessionReads
      .slice(readsBeforeAdoption)
      .some((read) => read.id === attempt.session_id && read.messages),
  ).toBe(true)
  expect(await f.runtime.command(command, "owner")).toEqual(requested)
  await expect(
    f.runtime.command({ ...command, reason: "changed payload" }, "owner"),
  ).rejects.toThrow("Request identity conflict")
  expect(f.store.execution(f.task.id)).toMatchObject({ state: "blocked" })
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  const countsBefore = f.events.filter((event) => /^(create|prompt):/.test(event)).length

  await f.runtime.tick()
  const uncertain = f.store
    .effects(f.planID)
    .find((effect) => effect.kind === "adoption-task-worktree")!
  expect(uncertain.state).toBe("uncertain")
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("pending")
  const worktreeCount = f.events.filter((event) => event.startsWith("worktree:")).length
  await f.reopen()
  await drive(f.runtime, 2)
  const taskWorkspace = JSON.parse(uncertain.payload).workspace
  expect(f.events.filter((event) => event === `worktree:${taskWorkspace}`)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("worktree:")).length).toBe(worktreeCount + 1)
  const adoption = f.store.adoption(requested.adoptionID)!
  expect(adoption.state).toBe("waiting-human")
  expect(adoption.task_workspace).not.toBeNull()
  expect(adoption.combined_workspace).not.toBeNull()
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("ready")
  expect(f.store.adoptionChecks(adoption.id).every((check) => check.state === "completed")).toBe(
    true,
  )
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.events.filter((event) => /^(create|prompt):/.test(event)).length).toBe(countsBefore)
  expect(trackedHistory(f)).toEqual(oldHistory)
  expectOutboxPreserved(f, oldOutcomes)
  const completedTaskChecks = readFileSync(f.taskLog, "utf8").length
  const completedGraphChecks = readFileSync(f.graphLog, "utf8").length
  expect(completedTaskChecks).toBe(2)
  expect(completedGraphChecks).toBe(1)
  await f.reopen()
  await drive(f.runtime, 1)
  expect(f.store.adoption(adoption.id)?.state).toBe("waiting-human")
  expect(readFileSync(f.taskLog, "utf8").length).toBe(completedTaskChecks)
  expect(readFileSync(f.graphLog, "utf8").length).toBe(completedGraphChecks)

  await recordHumanEvidence(f, adoption.id, candidate, true)
  await drive(f.runtime, 2)
  expect(f.store.adoption(adoption.id)?.state).toBe("accepted")
  expect(f.store.plan(f.planID)).toMatchObject({ state: "accepted", artifact: candidate })
  expect(f.store.nodes(f.planID)[0]).toMatchObject({ state: "accepted", artifact: candidate })
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: attempt.id,
    state: "failed",
    artifact: node.artifact,
  })
  expect(f.store.adoptions(f.planID)).toHaveLength(1)
  expect(
    f.store.adoptionChecks(adoption.id).filter((check) => check.state === "completed"),
  ).toHaveLength(2)
  expect(f.events.filter((event) => /^(create|prompt):/.test(event)).length).toBe(countsBefore)
  expect(trackedHistory(f)).toEqual(oldHistory)
  expectOutboxPreserved(f, oldOutcomes)
  await integratePlan(f)
  expect(f.store.plan(f.planID)?.state).toBe("integrated")
})

test("accepted task with blocked combined check adopts a descendant without rewriting acceptance or landing receipts", async () => {
  const f = fixture("blocked-combined")
  const { node, attempt } = await strand(f)
  expect(
    f.store
      .effects(f.planID)
      .some(
        (effect) =>
          effect.kind.startsWith("graph-verify:") &&
          JSON.parse(effect.receipt ?? "{}").check?.exitCode !== 0,
      ),
  ).toBe(true)
  const oldArtifact = node.artifact!
  git(f.root, ["merge", "--ff-only", oldArtifact])
  const landing = {
    requestID: "record-source-landing",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "integrated",
    taskID: f.task.id,
    artifact: oldArtifact,
    targetBranch: "main",
    reason: "Reviewed and landed the original task result",
  }
  await f.runtime.command(landing, "owner")
  const before = trackedHistory(f)
  const oldOutcomes = outboxHistory(f)
  const candidate = landCandidate(f, oldArtifact)
  const eventsBefore = f.events.filter((event) => /^(create|prompt):/.test(event)).length
  const command = adoptionCommand(f, attempt.id, oldArtifact, candidate)
  const requested = (await f.runtime.command(command, "owner")) as {
    adoptionID: string
    combinedArtifact: string
  }
  expect(requested.combinedArtifact).toBe(candidate)
  await recordHumanEvidence(f, requested.adoptionID, candidate, false)
  await drive(f.runtime)

  expect(f.store.adoption(requested.adoptionID)?.state).toBe("accepted")
  expect(f.store.plan(f.planID)).toMatchObject({ state: "accepted", artifact: candidate })
  expect(f.store.nodes(f.planID)[0]).toMatchObject({ state: "accepted", artifact: candidate })
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: attempt.id,
    state: "accepted",
    artifact: oldArtifact,
  })
  expect(trackedHistory(f)).toEqual(before)
  expectOutboxPreserved(f, oldOutcomes)
  expect(f.events.filter((event) => /^(create|prompt):/.test(event)).length).toBe(eventsBefore)
  expect(readFileSync(f.taskLog, "utf8")).toHaveLength(2)
  expect(readFileSync(f.graphLog, "utf8")).toHaveLength(2)
  expect(f.store.adoptionChecks(requested.adoptionID, "task").map((check) => check.state)).toEqual([
    "completed",
  ])
  expect(
    f.store.adoptionChecks(requested.adoptionID, "combined").map((check) => check.state),
  ).toEqual(["completed"])
  await integratePlan(f)
  expect(f.store.plan(f.planID)?.state).toBe("integrated")
})

test("adoption scope uses the latest reviewed integration baseline, not intervening accepted work", async () => {
  const f = fixture("blocked-combined")
  const { node, attempt } = await strand(f)
  const oldArtifact = node.artifact!
  git(f.root, ["merge", "--ff-only", oldArtifact])
  await f.runtime.command(
    {
      requestID: "record-source-before-intervening-work",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "integrated",
      taskID: f.task.id,
      artifact: oldArtifact,
      targetBranch: "main",
      reason: "Reviewed the accepted task source landing",
    },
    "owner",
  )
  writeFileSync(join(f.root, "reviewed-other.txt"), "independent integrated work\n")
  git(f.root, ["add", "reviewed-other.txt"])
  git(f.root, [
    "-c",
    "user.name=reviewer",
    "-c",
    "user.email=reviewer@example.invalid",
    "commit",
    "-m",
    "independent integrated work",
  ])
  const reviewedBaseline = git(f.root, ["rev-parse", "HEAD"])
  f.store.record(f.planID, null, "INTEGRATION_RECORDED", {
    artifact: reviewedBaseline,
    branch: "main",
    head: reviewedBaseline,
    reason: "An independent accepted plan was integrated",
  })
  const candidate = landCandidate(f, oldArtifact)
  const requested = (await f.runtime.command(
    adoptionCommand(f, attempt.id, oldArtifact, candidate),
    "owner",
  )) as { adoptionID: string }
  expect(f.store.adoption(requested.adoptionID)?.reviewed_baseline).toBe(reviewedBaseline)
  await recordHumanEvidence(f, requested.adoptionID, candidate, false)
  await drive(f.runtime, 3)
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("accepted")
  expect(f.store.plan(f.planID)).toMatchObject({ state: "accepted", artifact: candidate })
})

test("reviewed baseline does not authorize later out-of-scope candidate changes", async () => {
  const f = fixture("blocked-combined")
  const { node, attempt } = await strand(f)
  const oldArtifact = node.artifact!
  git(f.root, ["merge", "--ff-only", oldArtifact])
  await f.runtime.command(
    {
      requestID: "record-task-before-unreviewed-work",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "integrated",
      taskID: f.task.id,
      artifact: oldArtifact,
      targetBranch: "main",
      reason: "Reviewed the accepted task source landing",
    },
    "owner",
  )
  writeFileSync(join(f.root, "reviewed-other.txt"), "independent integrated work\n")
  git(f.root, ["add", "reviewed-other.txt"])
  git(f.root, [
    "-c",
    "user.name=reviewer",
    "-c",
    "user.email=reviewer@example.invalid",
    "commit",
    "-m",
    "independent integrated work",
  ])
  const reviewedBaseline = git(f.root, ["rev-parse", "HEAD"])
  f.store.record(f.planID, null, "INTEGRATION_RECORDED", {
    artifact: reviewedBaseline,
    branch: "main",
    head: reviewedBaseline,
    reason: "An independent accepted plan was integrated",
  })
  writeFileSync(join(f.root, "unreviewed.txt"), "not part of the reviewed baseline\n")
  git(f.root, ["add", "unreviewed.txt"])
  git(f.root, [
    "-c",
    "user.name=reviewer",
    "-c",
    "user.email=reviewer@example.invalid",
    "commit",
    "-m",
    "unreviewed out-of-scope change",
  ])
  writeFileSync(join(f.root, "result.txt"), "good\n")
  git(f.root, ["add", "result.txt"])
  git(f.root, [
    "-c",
    "user.name=reviewer",
    "-c",
    "user.email=reviewer@example.invalid",
    "commit",
    "-m",
    "reviewed task correction",
  ])
  const candidate = git(f.root, ["rev-parse", "HEAD"])
  await expect(
    f.runtime.command(adoptionCommand(f, attempt.id, oldArtifact, candidate), "owner"),
  ).rejects.toThrow("outside the task's authorized scope")
  expect(f.store.adoptions(f.planID)).toHaveLength(0)
})

test("identical task and combined assertion/artifact evidence remains phase- and task-bound", async () => {
  for (const firstPhase of ["task", "combined"] as const) {
    const f = fixture("failed-task", "shared-result")
    const { node, attempt } = await strand(f)
    const candidate = landCandidate(f, node.artifact!)
    const requested = (await f.runtime.command(
      adoptionCommand(f, attempt.id, node.artifact!, candidate),
      "owner",
    )) as { adoptionID: string; combinedArtifact: string }
    expect(requested.combinedArtifact).toBe(candidate)
    await drive(f.runtime, 4)
    expect(f.store.adoption(requested.adoptionID)?.state).toBe("waiting-human")

    await recordPhaseHumanEvidence(f, requested.adoptionID, firstPhase, "shared-result", candidate)
    await drive(f.runtime, 1)
    expect(f.store.adoption(requested.adoptionID)?.state).toBe("waiting-human")
    expect(f.store.plan(f.planID)?.state).toBe("blocked")
    expect(
      f.store.hasAdoptionEvidence(
        requested.adoptionID,
        firstPhase,
        firstPhase === "task" ? f.task.id : null,
        "shared-result",
        candidate,
      ),
    ).toBe(true)
    expect(
      f.store.hasAdoptionEvidence(
        requested.adoptionID,
        firstPhase === "task" ? "combined" : "task",
        firstPhase === "task" ? null : f.task.id,
        "shared-result",
        candidate,
      ),
    ).toBe(false)

    await recordPhaseHumanEvidence(
      f,
      requested.adoptionID,
      firstPhase === "task" ? "combined" : "task",
      "shared-result",
      candidate,
    )
    await drive(f.runtime, 2)
    expect(f.store.adoption(requested.adoptionID)?.state).toBe("accepted")
  }
})

test("restart recovers task and combined check receipt cuts without replaying checks", async () => {
  for (const cutPhase of ["task", "combined"] as const) {
    const f = fixture("failed-task")
    const { node, attempt } = await strand(f)
    const candidate = landCandidate(f, node.artifact!)
    const requested = (await f.runtime.command(
      adoptionCommand(f, attempt.id, node.artifact!, candidate),
      "owner",
    )) as { adoptionID: string }
    const complete = f.store.completeAdoptionCheck.bind(f.store)
    let cut = false
    f.store.completeAdoptionCheck = (adoptionID, phase, checkID, receipt, fence) => {
      if (!cut && phase === cutPhase) {
        cut = true
        throw new Error(`simulated ${phase} receipt database cut`)
      }
      return complete(adoptionID, phase, checkID, receipt, fence)
    }
    await drive(f.runtime, 1)
    expect(cut).toBe(true)
    expect(f.store.adoptionChecks(requested.adoptionID, cutPhase)[0]?.state).toBe("uncertain")
    const checkCountsBeforeRestart = {
      task: existsSync(f.taskLog) ? readFileSync(f.taskLog, "utf8").length : 0,
      combined: existsSync(f.graphLog) ? readFileSync(f.graphLog, "utf8").length : 0,
    }
    const checkRow = f.store.adoptionChecks(requested.adoptionID, cutPhase)[0]!
    expect(existsSync(checkRow.receipt_path)).toBe(true)
    const attemptsBeforeRestart = f.store.attempts(f.planID).length
    const admissionsBeforeRestart = f.events.filter((event) =>
      /^(create|prompt):/.test(event),
    ).length

    await f.reopen()
    await drive(f.runtime, 2)

    expect(f.store.adoption(requested.adoptionID)?.state).toBe("waiting-human")
    expect(
      f.store.adoptionChecks(requested.adoptionID).every((check) => check.state === "completed"),
    ).toBe(true)
    expect(existsSync(f.taskLog) ? readFileSync(f.taskLog, "utf8").length : 0).toBe(
      checkCountsBeforeRestart.task,
    )
    expect(existsSync(f.graphLog) ? readFileSync(f.graphLog, "utf8").length : 0).toBe(
      checkCountsBeforeRestart.combined + (cutPhase === "task" ? 1 : 0),
    )
    expect(f.store.attempts(f.planID)).toHaveLength(attemptsBeforeRestart)
    expect(f.events.filter((event) => /^(create|prompt):/.test(event)).length).toBe(
      admissionsBeforeRestart,
    )
  }
})

test("only active worker reservations with conflicting write scopes block adoption", async () => {
  for (const [label, scope, blocked] of [
    ["unrelated", ["unrelated/**"], false],
    ["conflicting", ["result.txt"], true],
  ] as const) {
    const f = fixture("failed-task")
    const { node, attempt } = await strand(f)
    const candidate = landCandidate(f, node.artifact!)
    reserveActiveWriter(f, [...scope], label)
    const command = adoptionCommand(f, attempt.id, node.artifact!, candidate)
    if (blocked)
      await expect(f.runtime.command(command, "owner")).rejects.toThrow("conflicting worker")
    else {
      const requested = (await f.runtime.command(command, "owner")) as { adoptionID: string }
      expect(f.store.adoption(requested.adoptionID)?.state).toBe("pending")
    }
  }
})

test("irrelevant environment churn is ignored while runtime generations and operation evidence stay isolated", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const firstCommand = adoptionCommand(f, attempt.id, node.artifact!, candidate)
  const first = (await f.runtime.command(firstCommand, "owner")) as { adoptionID: string }
  await drive(f.runtime, 1)
  expect(f.store.adoption(first.adoptionID)?.state).toBe("waiting-human")
  await recordHumanEvidence(f, first.adoptionID, candidate, true)

  const currentEnvironment = verificationEnvironmentIdentity()
  const oldValue = process.env.LAZERS_ADOPTION_TEST_ENV
  process.env.LAZERS_ADOPTION_TEST_ENV = "credential-value-must-not-enter-evidence"
  expect(verificationEnvironmentIdentity()).toBe(currentEnvironment)
  const nextRuntimeIdentity = verificationEnvironmentIdentity("next-runtime-generation")
  expect(nextRuntimeIdentity).not.toBe(currentEnvironment)
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_adoptions SET environment_identity=? WHERE id=?")
      .run(nextRuntimeIdentity, first.adoptionID),
  )
  try {
    await f.runtime.tick()
  } finally {
    if (oldValue === undefined) delete process.env.LAZERS_ADOPTION_TEST_ENV
    else process.env.LAZERS_ADOPTION_TEST_ENV = oldValue
  }
  expect(f.store.adoption(first.adoptionID)?.state).toBe("held")
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")

  const secondCommand = {
    ...adoptionCommand(f, attempt.id, node.artifact!, candidate),
    requestID: "adopt-same-content-new-operation",
  }
  const second = (await f.runtime.command(secondCommand, "owner")) as { adoptionID: string }
  expect(second.adoptionID).not.toBe(first.adoptionID)
  await drive(f.runtime, 1)
  expect(f.store.adoption(second.adoptionID)?.state).toBe("waiting-human")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(
    f.store.adoptionChecks(second.adoptionID).every((check) => check.state === "completed"),
  ).toBe(true)
  expect(f.store.adoptionEvidence(first.adoptionID)).toHaveLength(2)
  expect(f.store.adoptionEvidence(second.adoptionID)).toHaveLength(0)
  expect(readFileSync(f.taskLog, "utf8")).toHaveLength(3)
  expect(readFileSync(f.graphLog, "utf8")).toHaveLength(2)
})

test("changed verification command input invalidates completed adoption receipts", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const requested = (await f.runtime.command(
    adoptionCommand(f, attempt.id, node.artifact!, candidate),
    "owner",
  )) as { adoptionID: string }
  await drive(f.runtime, 1)
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("waiting-human")
  await recordHumanEvidence(f, requested.adoptionID, candidate, true)
  const taskRow = f.store.atomic((db) =>
    db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(f.task.id)!,
  )
  const changedTask = JSON.parse(taskRow.body)
  changedTask.proposal.verification[0].command = "true"
  f.store.atomic((db) =>
    db.query("UPDATE tasks SET body=? WHERE id=?").run(JSON.stringify(changedTask), f.task.id),
  )
  await f.runtime.tick()
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("held")
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.adoptionChecks(requested.adoptionID, "task")[0]?.state).toBe("completed")
  expect(f.store.adoptionChecks(requested.adoptionID, "combined")[0]?.state).toBe("completed")
  expect(readFileSync(f.taskLog, "utf8")).toHaveLength(2)
  expect(readFileSync(f.graphLog, "utf8")).toHaveLength(1)
  expect(f.events.filter((event) => /^(create|prompt):/.test(event))).toHaveLength(2)
})

test("owner-session loss after verification holds instead of publishing acceptance", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const requested = (await f.runtime.command(
    adoptionCommand(f, attempt.id, node.artifact!, candidate),
    "owner",
  )) as { adoptionID: string }
  await drive(f.runtime, 1)
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("waiting-human")
  await recordHumanEvidence(f, requested.adoptionID, candidate, true)
  f.store.atomic((db) =>
    db.query("UPDATE runner_outbox SET state='consumed' WHERE plan_id=?").run(f.planID),
  )
  f.sessions.get("owner")!.archived = true
  await f.runtime.tick()
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("held")
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
})

test("candidate index changes during combined verification invalidate publication", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const requested = (await f.runtime.command(
    adoptionCommand(f, attempt.id, node.artifact!, candidate),
    "owner",
  )) as { adoptionID: string }
  await recordHumanEvidence(f, requested.adoptionID, candidate, true)
  writeFileSync(f.graphGate, "wait\n")
  const tick = f.runtime.tick()
  for (let i = 0; i < 500 && !existsSync(f.graphStarted); i++) await Bun.sleep(10)
  expect(existsSync(f.graphStarted)).toBe(true)
  writeFileSync(join(f.root, "staged-during-verification.txt"), "new input\n")
  git(f.root, ["add", "staged-during-verification.txt"])
  writeFileSync(f.graphRelease, "go\n")
  await tick
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("held")
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(
    f.store.adoptionChecks(requested.adoptionID).every((check) => check.state === "completed"),
  ).toBe(true)
  expect(f.events.filter((event) => /^(create|prompt):/.test(event))).toHaveLength(2)
  expect(f.events.some((event) => event.startsWith("remove:"))).toBe(false)
})

test("dirty candidates, wrong bindings, foreign owners, and worker controls fail closed", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const good = adoptionCommand(f, attempt.id, node.artifact!, candidate)
  await expect(
    f.runtime.command(
      { ...good, expectedVersion: good.expectedVersion - 1, requestID: "stale-version" },
      "owner",
    ),
  ).rejects.toThrow("Stale plan version")
  await expect(
    f.runtime.command({ ...good, attemptID: crypto.randomUUID() }, "owner"),
  ).rejects.toThrow("exact latest task attempt")
  await expect(f.runtime.command({ ...good, artifact: f.base }, "owner")).rejects.toThrow(
    "exact latest attempt and task result",
  )
  await expect(f.runtime.command(good, "foreign-owner")).rejects.toThrow("Only the plan owner")
  const worker = f.sessions.get(attempt.session_id)!
  const workerMetadata = worker.metadata
  worker.metadata = { ...worker.metadata, lazersAttemptID: "replaced-attempt" }
  await expect(
    f.runtime.command({ ...good, requestID: "replaced-worker-session" }, "owner"),
  ).rejects.toThrow("Latest worker session is not the owned attempt")
  worker.metadata = workerMetadata
  worker.pendingPermissions = 1
  await expect(
    f.runtime.command({ ...good, requestID: "pending-control" }, "owner"),
  ).rejects.toThrow("control state is not conclusively idle")
  worker.pendingPermissions = 0
  worker.busy = true
  await expect(f.runtime.command({ ...good, requestID: "active-worker" }, "owner")).rejects.toThrow(
    "control state is not conclusively idle",
  )
  worker.busy = false
  writeFileSync(join(f.root, "unrelated.txt"), "dirty\n")
  await expect(
    f.runtime.command({ ...good, requestID: "dirty-candidate" }, "owner"),
  ).rejects.toThrow("Dirty or unmerged candidate checkout")
  rmSync(join(f.root, "unrelated.txt"))
  writeFileSync(join(f.root, "notes.md"), "outside authorized task scope\n")
  git(f.root, ["add", "notes.md"])
  git(f.root, [
    "-c",
    "user.name=reviewer",
    "-c",
    "user.email=reviewer@example.invalid",
    "commit",
    "-m",
    "out-of-scope descendant",
  ])
  const outOfScope = git(f.root, ["rev-parse", "HEAD"])
  await expect(
    f.runtime.command(
      {
        ...good,
        requestID: "out-of-scope-candidate",
        descendantCommit: outOfScope,
      },
      "owner",
    ),
  ).rejects.toThrow("outside the task's authorized scope")
  git(f.root, ["branch", "conflict-candidate", f.base])
  git(f.root, ["switch", "conflict-candidate"])
  writeFileSync(join(f.root, "result.txt"), "conflict\n")
  git(f.root, ["add", "result.txt"])
  git(f.root, [
    "-c",
    "user.name=reviewer",
    "-c",
    "user.email=reviewer@example.invalid",
    "commit",
    "-m",
    "conflicting candidate",
  ])
  git(f.root, ["switch", "main"])
  const merge = Bun.spawnSync(["git", "merge", "conflict-candidate"], { cwd: f.root })
  expect(merge.exitCode).not.toBe(0)
  await expect(
    f.runtime.command(
      { ...good, requestID: "unmerged-candidate", descendantCommit: outOfScope },
      "owner",
    ),
  ).rejects.toThrow("Dirty or unmerged candidate checkout")
  git(f.root, ["merge", "--abort"])
  const uncertainCheck = f.store
    .effects(f.planID)
    .find((effect) => effect.kind === "verify:task-check")!
  f.store.atomic((db) =>
    db.query("UPDATE runner_effects SET state='uncertain' WHERE id=?").run(uncertainCheck.id),
  )
  await expect(
    f.runtime.command({ ...good, requestID: "uncertain-old-check" }, "owner"),
  ).rejects.toThrow("Uncertain effects must be resolved")
  expect(f.store.adoptions(f.planID)).toHaveLength(0)
  expect(f.events.filter((event) => /^(create|prompt):/.test(event))).toHaveLength(2)
})

test("active adoption scopes are reserved transactionally across plans", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const current = (await f.runtime.command(
    adoptionCommand(f, attempt.id, node.artifact!, candidate),
    "owner",
  )) as { adoptionID: string }
  expect(f.store.activeAdoptions()).toHaveLength(1)

  const taskID = crypto.randomUUID()
  f.repository.insert({
    ...structuredClone(f.task),
    id: taskID,
    createdAt: new Date().toISOString(),
    proposal: { ...structuredClone(f.task.proposal), objective: "A competing task" },
  })
  const submitted = f.store.submit(
    {
      ...f.planInput,
      requestID: "competing-plan",
      nodes: [{ taskID, revision: 1 as const }],
      integrationOrder: [taskID],
    },
    "owner",
  ) as { planID: string }
  f.store.atomic((db) =>
    db.query("UPDATE runner_plans SET state='blocked' WHERE id=?").run(submitted.planID),
  )
  const competingPlan = f.store.plan(submitted.planID)!
  await expect(
    Promise.resolve().then(() =>
      f.store.createAdoption({
        id: crypto.randomUUID(),
        planID: competingPlan.id,
        taskID,
        writeScope: f.store.effectiveWriteScope(taskID),
        requestID: "competing-adoption",
        owner: "owner",
        expectedVersion: competingPlan.version,
        taskRevision: 1,
        attemptID: crypto.randomUUID(),
        nodeState: "failed",
        attemptState: "failed",
        oldArtifact: node.artifact!,
        descendantCommit: candidate,
        targetBranch: "main",
        landingHead: candidate,
        reviewedBaseline: node.artifact!,
        candidateTree: git(f.root, ["rev-parse", `${candidate}^{tree}`]),
        inputFingerprint: "competing-input",
        environmentIdentity: "competing-environment",
        reason: "This operation must not steal a live reservation",
        combinedArtifact: candidate,
      }),
    ),
  ).rejects.toThrow("active descendant reservation conflicts")
  expect(f.store.activeAdoptions().map((item) => item.id)).toEqual([current.adoptionID])
  expect(f.store.adoptions(submitted.planID)).toHaveLength(0)
  expect(f.store.plan(submitted.planID)?.version).toBe(competingPlan.version)
  expect(f.events.filter((event) => /^(create|prompt):/.test(event))).toHaveLength(2)
})

test("a worker activated after the final idle observation still fences adoption publication", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const requested = (await f.runtime.command(
    adoptionCommand(f, attempt.id, node.artifact!, candidate),
    "owner",
  )) as { adoptionID: string }
  await drive(f.runtime, 1)
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("waiting-human")
  await recordHumanEvidence(f, requested.adoptionID, candidate, true)
  f.setWorkerSessionHook(4, () =>
    f.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(attempt.id),
    ),
  )
  await f.runtime.tick()
  f.store.atomic((db) =>
    db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(attempt.id),
  )
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("held")
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({ id: attempt.id, state: "failed" })
})

test("cancellation during a fresh check fences late acceptance and preserves adoption worktrees", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const command = adoptionCommand(f, attempt.id, node.artifact!, candidate)
  const requested = (await f.runtime.command(command, "owner")) as { adoptionID: string }
  const adoption = f.store.adoption(requested.adoptionID)!
  writeFileSync(f.taskGate, "wait\n")
  const tick = f.runtime.tick()
  for (let i = 0; i < 500 && !existsSync(f.taskStarted); i++) await Bun.sleep(10)
  expect(existsSync(f.taskStarted)).toBe(true)
  await f.runtime.command(
    {
      requestID: "cancel-adoption",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  writeFileSync(f.taskRelease, "go\n")
  await tick
  await drive(f.runtime, 3)
  expect(f.store.adoption(adoption.id)?.state).toBe("cancelled")
  expect(f.store.plan(f.planID)?.state).toBe("cancelled")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(
    f.store
      .effects(f.planID)
      .some((effect) => effect.kind.startsWith("adoption-") && effect.state === "completed"),
  ).toBe(true)
  expect(f.events.some((event) => event.startsWith("remove:"))).toBe(false)
})

test("cancellation during combined checks prevents late plan acceptance and cleanup", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const requested = (await f.runtime.command(
    adoptionCommand(f, attempt.id, node.artifact!, candidate),
    "owner",
  )) as { adoptionID: string }
  writeFileSync(f.graphGate, "wait\n")
  const tick = f.runtime.tick()
  for (let i = 0; i < 500 && !existsSync(f.graphStarted); i++) await Bun.sleep(10)
  expect(existsSync(f.graphStarted)).toBe(true)
  await f.runtime.command(
    {
      requestID: "cancel-during-combined-check",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  writeFileSync(f.graphRelease, "go\n")
  await tick
  await drive(f.runtime, 3)
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("cancelled")
  expect(f.store.plan(f.planID)?.state).toBe("cancelled")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.adoptionChecks(requested.adoptionID, "task")[0]?.state).toBe("completed")
  expect(f.store.adoptionChecks(requested.adoptionID, "combined")[0]?.state).toBe("completed")
  expect(f.events.some((event) => event.startsWith("remove:"))).toBe(false)
})

test("timed-out adoption checks hold without repair, new worker turns, or acceptance", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const requested = (await f.runtime.command(
    adoptionCommand(f, attempt.id, node.artifact!, candidate),
    "owner",
  )) as { adoptionID: string }
  const before = f.events.filter((event) => /^(create|prompt):/.test(event)).length
  writeFileSync(f.taskTimeoutGate, "timeout\n")
  await f.runtime.tick()
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("held")
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.events.filter((event) => /^(create|prompt):/.test(event)).length).toBe(before)
  const receipt = JSON.parse(f.store.adoptionChecks(requested.adoptionID, "task")[0]!.receipt!)
  expect(receipt.timedOut).toBe(true)
  expect(receipt.exitCode).not.toBe(0)
  expect(receipt.unchanged).toBe(true)
  expect(f.store.adoptionChecks(requested.adoptionID, "combined")).toHaveLength(0)
})

test("cancel during worker observation does not create a candidate worktree or publish acceptance", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const requested = (await f.runtime.command(
    adoptionCommand(f, attempt.id, node.artifact!, candidate),
    "owner",
  )) as { adoptionID: string }
  const before = f.events.filter((event) => event.startsWith("worktree:")).length
  const releaseObservation = f.setObservationGate()
  const tick = f.runtime.tick()
  await Bun.sleep(20)
  await f.runtime.command(
    {
      requestID: "cancel-during-observation",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  releaseObservation(f.sessions.get(attempt.session_id)!)
  await tick
  await drive(f.runtime, 3)
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("cancelled")
  expect(f.store.plan(f.planID)?.state).toBe("cancelled")
  expect(f.events.filter((event) => event.startsWith("worktree:")).length).toBe(before)
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
})

test("mutating adoption checks hold without repair or publication", async () => {
  const f = fixture("failed-task")
  const { node, attempt } = await strand(f)
  const candidate = landCandidate(f, node.artifact!)
  const requested = (await f.runtime.command(
    adoptionCommand(f, attempt.id, node.artifact!, candidate),
    "owner",
  )) as { adoptionID: string }
  writeFileSync(f.mutationGate, "mutate\n")
  await f.runtime.tick()
  expect(f.store.adoption(requested.adoptionID)?.state).toBe("held")
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(
    f.store
      .effects(f.planID)
      .some((effect) => effect.kind.startsWith("adoption-") && effect.state === "uncertain"),
  ).toBe(false)
  expect(f.store.adoptionChecks(requested.adoptionID, "task")[0]?.state).toBe("completed")
  expect(
    JSON.parse(f.store.adoptionChecks(requested.adoptionID, "task")[0]!.receipt!).unchanged,
  ).toBe(false)
})
