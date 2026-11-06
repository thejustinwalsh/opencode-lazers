import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import { RunnerStore } from "./store.ts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

type FixtureOptions = {
  dependent?: boolean
  humanEvidence?: boolean
  failRepair?: boolean
  ambiguousRepair?: boolean
  repairRace?: boolean
  repairOwnerAdmissionRace?: boolean
}

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "lazers-retained-repair-project-"))
  const state = mkdtempSync(join(tmpdir(), "lazers-retained-repair-state-"))
  git(root, ["init", "--initial-branch=main"])
  git(root, ["config", "user.name", "fixture"])
  git(root, ["config", "user.email", "fixture@example.invalid"])
  writeFileSync(join(root, "seed.txt"), "baseline\n")
  git(root, ["add", "seed.txt"])
  git(root, ["commit", "-m", "baseline"])
  const base = git(root, ["rev-parse", "HEAD"])
  const repository = new TaskRepository(join(state, "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  const model = { providerID: "openai", id: "repair-test-model", variant: "high" }
  const taskCount = options.dependent ? 2 : 1
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const path = `result-${index}.txt`
    const proposal = validProposal()
    proposal.objective = `Write ${path}`
    proposal.writeScope = [path]
    proposal.verification = [
      {
        id: `content-${index}`,
        command: `printf check >> '${join(state, `task-check-${index}.log`)}' && test "$(cat '${path}')" = "accepted"`,
        timeoutMs: 1000,
      },
    ]
    proposal.acceptance = [
      {
        id: `correct-${index}`,
        assertion: `The accepted content is present in ${path}`,
        evidence: [
          { kind: "verification" as const, verificationID: `content-${index}` },
          ...(options.humanEvidence && index === 0
            ? [{ kind: "human" as const, decision: "review" }]
            : []),
        ],
      },
    ]
    proposal.limits.maxRepairAttempts = 1
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
        startingRevision: { kind: "git", commit: base },
      },
      proposal,
    })
  })
  const plan = store.submit(
    {
      requestID: "retained-repair-plan",
      objective: "Build and verify the retained repair fixture",
      workspaceMode: "isolated",
      baseCommit: base,
      nodes: tasks.map((task) => ({ taskID: task.id, revision: 1 as const })),
      dependencies: options.dependent
        ? [{ prerequisite: tasks[0]!.id, successor: tasks[1]!.id }]
        : [],
      integrationOrder: tasks.map((task) => task.id),
      verification: [
        {
          id: "combined",
          command: `printf check >> '${join(state, "combined-check.log")}' && test -f ${tasks.map((_, index) => `result-${index}.txt`).join(" -a -f ")}`,
          timeoutMs: 1000,
        },
      ],
      acceptance: [
        {
          id: "combined",
          assertion: "All isolated task artifacts are present together",
          evidence: [{ kind: "verification" as const, verificationID: "combined" }],
        },
      ],
    },
    "owner",
  )

  const sessions = new Map<string, HostSession>([
    [
      "owner",
      {
        id: "owner",
        projectID: "project",
        directory: root,
        agent: "architect",
        archived: false,
        busy: false,
        tokens: null,
        tools: 0,
        cost: null,
        messages: [],
      },
    ],
  ])
  const events: string[] = []
  const prompts: Array<{ sessionID: string; id: string; directory: string; text: string }> = []
  const created: string[] = []
  const waits: string[] = []
  let waitObserved = false
  let ownerReadDuringWait = false
  const host: RunnerHost = {
    workerModel: () => Promise.resolve(model),
    worktree: ({ directory, base: source }) => {
      mkdirSync(dirname(directory), { recursive: true })
      git(root, ["worktree", "add", "--detach", directory, source])
      events.push(`worktree:${directory}`)
      return Promise.resolve(directory)
    },
    worktrees: () =>
      Promise.resolve(
        git(root, ["worktree", "list", "--porcelain"])
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice(9)),
      ),
    removeWorktree: (directory) => {
      git(root, ["worktree", "remove", directory])
      return Promise.resolve()
    },
    session: (id) => {
      if (id === "owner" && waitObserved && !ownerReadDuringWait) {
        ownerReadDuringWait = true
        if (options.repairRace) {
          const worker = [...sessions.values()].find(
            (candidate) => candidate.agent === "lazers-implementor",
          )
          if (worker) worker.turn = { inputID: "msg_foreign_race", state: "completed" }
        }
        if (options.repairOwnerAdmissionRace) {
          store.updatePlanOwner(plan.planID, "owner", "owner-b")
          store.updatePlanOwner(plan.planID, "owner-b", "owner")
        }
      }
      return Promise.resolve(structuredClone(sessions.get(id) ?? null))
    },
    create: (input) => {
      created.push(input.id)
      events.push(`create:${input.id}`)
      sessions.set(input.id, {
        id: input.id,
        parentID: input.parentID,
        projectID: "project",
        directory: input.directory,
        agent: input.agent,
        model: input.model,
        metadata: { lazersAttemptID: input.attemptID },
        archived: false,
        busy: false,
        pendingInput: false,
        pendingPermissions: 0,
        pendingForms: 0,
        background: {
          state: "observed",
          source: "experimental.idle",
          observedAt: Date.now(),
          inputID: "before-first-prompt",
          executionStartSequence: 1,
          eventSequence: 1,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        tokens: 100,
        tools: 2,
        cost: null,
        messages: [],
      })
      return Promise.resolve()
    },
    createArchitect: async () => {},
    waitForSession: (sessionID) => {
      waits.push(sessionID)
      waitObserved = true
      events.push(`wait:${sessionID}`)
      return Promise.resolve()
    },
    prompt: (input) => {
      prompts.push(input)
      events.push(`prompt:${input.id}`)
      const session = sessions.get(input.sessionID)
      if (!session) throw new Error("worker missing")
      const attempt = store
        .plans()
        .flatMap((candidate) => store.attempts(candidate.id))
        .find((candidate) => candidate.session_id === input.sessionID)
      if (!attempt || input.attemptID !== attempt.id || input.directory !== attempt.workspace)
        throw new Error("repair prompt changed attempt or workspace")
      if (input.text.includes("Concrete defect to repair:")) {
        if (!input.text.includes("Escaped delimiters are parsed incorrectly."))
          throw new Error("repair prompt omitted concrete defect")
        if (input.moveIfNeeded !== false)
          throw new Error("retained repair may not move the session")
        if (options.failRepair) {
          const index = tasks.findIndex((task) => task.id === attempt.task_id)
          writeFileSync(join(input.directory, `result-${index}.txt`), "wrong\n")
        }
      } else {
        const index = tasks.findIndex((task) => task.id === attempt.task_id)
        writeFileSync(join(input.directory, `result-${index}.txt`), "accepted\n")
        git(input.directory, ["add", `result-${index}.txt`])
        git(input.directory, ["commit", "-m", `accepted candidate ${index}`])
      }
      session.messages.push({ id: input.id, text: input.text })
      session.busy = false
      session.pendingInput = false
      session.pendingPermissions = 0
      session.pendingForms = 0
      session.outcome = "succeeded"
      session.turn = { inputID: input.id, state: "completed" }
      if (session.background?.state === "observed") session.background.inputID = input.id
      session.tokens = 150
      session.tools = 3
      if (input.text.includes("Concrete defect to repair:") && options.ambiguousRepair)
        throw new Error("repair prompt response was lost")
      return Promise.resolve()
    },
    updateInstruction: async () => {},
    notify: async () => {},
    interrupt: async () => {},
  }
  const runtime = new TaskRuntime(store, host, "project")
  cleanups.push(() => {
    void runtime.stop()
    repository.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })
  return {
    root,
    state,
    base,
    tasks,
    planID: plan.planID,
    store,
    runtime,
    sessions,
    prompts,
    created,
    waits,
    events,
    host,
  }
}

async function start(f: ReturnType<typeof fixture>) {
  await f.runtime.command(
    { requestID: "run", planID: f.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
}

async function accept(f: ReturnType<typeof fixture>) {
  await start(f)
  await f.runtime.tick()
  await f.runtime.tick()
}

function retainedRepairCommand(
  f: ReturnType<typeof fixture>,
  reason = "Escaped delimiters are parsed incorrectly.",
) {
  const attempt = f.store
    .attempts(f.planID)
    .find((candidate) => candidate.task_id === f.tasks[0]!.id)!
  return {
    requestID: "repair-accepted-candidate",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "retained-repair" as const,
    taskID: f.tasks[0]!.id,
    attemptID: attempt.id,
    artifact: attempt.artifact!,
    reason,
  }
}

function taskEvents(f: ReturnType<typeof fixture>, taskID: string, event: string) {
  const rows = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string, string, string]>(
        "SELECT payload FROM runner_transitions WHERE plan_id=? AND task_id=? AND event=? ORDER BY id",
      )
      .all(f.planID, taskID, event),
  ) as unknown as Array<{ payload: string }>
  return rows.map((row) => JSON.parse(row.payload) as unknown as Record<string, unknown>)
}

function addActivePlanAttempt(
  f: ReturnType<typeof fixture>,
  options: { afterPlans?: string[]; writeScope?: string[] },
) {
  const proposal = validProposal()
  proposal.objective = "Reserve an independent fixture task"
  proposal.writeScope = options.writeScope ?? ["independent.txt"]
  const task = f.store.repository.insert({
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
  const plan = f.store.submit(
    {
      requestID: `active-plan-${task.id}`,
      objective: "Track an active source plan dependency",
      workspaceMode: "isolated",
      baseCommit: f.base,
      nodes: [{ taskID: task.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: [{ id: "check", command: "true", timeoutMs: 1000 }],
      acceptance: [
        {
          id: "accepted",
          assertion: "The independent task output is available",
          evidence: [{ kind: "verification", verificationID: "check" }],
        },
      ],
      ...(options.afterPlans ? { afterPlans: options.afterPlans } : {}),
    },
    "owner",
  )
  f.store.atomic((db) =>
    db
      .query(
        "INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at) VALUES(?,?,?,?,?,?,?,?,?,'running',?)",
      )
      .run(
        crypto.randomUUID(),
        plan.planID,
        task.id,
        1,
        `ses_${crypto.randomUUID()}`,
        `msg_${crypto.randomUUID()}`,
        join(f.state, `unobserved-${task.id}`),
        f.base,
        JSON.stringify({
          workspaceMode: "isolated",
          model: { providerID: "openai", id: "repair-test-model", variant: "high" },
        }),
        Date.now() - 1000,
      ),
  )
  return plan.planID
}

test("explicit retained repair preserves accepted history and usage and re-verifies equal-hash task and combined artifacts", async () => {
  const f = fixture()
  await accept(f)
  expect(f.store.plan(f.planID)?.state).toBe("accepted")
  const prior = f.store.attempts(f.planID)[0]!
  const previousSession = f.sessions.get(prior.session_id)!
  const oldArtifact = prior.artifact!
  const oldPolicy = prior.policy
  const oldUsage = {
    token_count: prior.token_count,
    tool_count: prior.tool_count,
    cost: prior.cost,
  }
  const oldWorkspace = prior.workspace
  const oldPromptID = prior.message_id
  const oldAcceptanceCount = taskEvents(f, f.tasks[0]!.id, "ARTIFACT_ACCEPTED").length
  const command = retainedRepairCommand(f)
  const requested = await f.runtime.command(command, "owner")

  expect(requested).toMatchObject({
    status: "retained-repair-requested",
    taskID: f.tasks[0]!.id,
    attemptID: prior.id,
    artifact: oldArtifact,
  })
  expect(f.store.plan(f.planID)).toMatchObject({ state: "running", artifact: null })
  expect(f.store.nodes(f.planID)[0]).toMatchObject({ state: "ready", artifact: null })
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: prior.id,
    number: prior.number,
    session_id: prior.session_id,
    workspace: oldWorkspace,
    policy: oldPolicy,
    artifact: oldArtifact,
    state: "preparing",
    token_count: oldUsage.token_count,
    tool_count: oldUsage.tool_count,
    cost: oldUsage.cost,
  })
  expect(f.store.attempts(f.planID)[0]?.message_id).not.toBe(oldPromptID)
  expect(taskEvents(f, f.tasks[0]!.id, "ARTIFACT_ACCEPTED")).toHaveLength(oldAcceptanceCount)
  expect(f.sessions.get(prior.session_id)).toEqual(previousSession)
  expect(f.created).toHaveLength(1)
  expect(f.waits).toEqual([prior.session_id])

  expect(await f.runtime.command(command, "owner")).toEqual(requested)
  expect(f.prompts).toHaveLength(1)
  await f.runtime.tick()
  expect(f.prompts).toHaveLength(2)
  expect(f.prompts[1]?.sessionID).toBe(prior.session_id)
  expect(f.prompts[1]?.directory).toBe(oldWorkspace)
  expect(f.prompts[1]?.text).toContain(
    "Concrete defect to repair: Escaped delimiters are parsed incorrectly.",
  )
  expect(f.created).toHaveLength(1)
  expect(f.store.attempts(f.planID)).toHaveLength(1)

  await f.runtime.tick()
  await f.runtime.tick()
  const acceptedPlan = f.store.plan(f.planID)
  expect(acceptedPlan?.state).toBe("accepted")
  expect(typeof acceptedPlan?.artifact).toBe("string")
  expect(f.store.nodes(f.planID)[0]).toMatchObject({ state: "accepted", artifact: oldArtifact })
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: prior.id,
    session_id: prior.session_id,
    workspace: oldWorkspace,
    policy: oldPolicy,
    artifact: oldArtifact,
    state: "accepted",
  })
  expect(f.store.attempts(f.planID)[0]!.token_count).toBeGreaterThanOrEqual(
    oldUsage.token_count ?? 0,
  )
  expect(
    f.store.effects(f.planID).filter((effect) => effect.kind === "verify:content-0"),
  ).toHaveLength(2)
  expect(
    f.store.effects(f.planID).filter((effect) => effect.kind === "graph-verify:combined"),
  ).toHaveLength(2)
  expect(
    f.store
      .effects(f.planID)
      .filter((effect) => effect.kind === "verify:content-0")
      .map((effect) => (JSON.parse(effect.payload) as { repairID?: string }).repairID),
  ).toEqual([undefined, (requested as { operationID: string }).operationID])
  expect(taskEvents(f, f.tasks[0]!.id, "ARTIFACT_ACCEPTED")).toHaveLength(oldAcceptanceCount + 1)
  expect(f.store.latestRetainedRepair<{ defect: string }>(f.planID, f.tasks[0]!.id)?.defect).toBe(
    "Escaped delimiters are parsed incorrectly.",
  )
  expect(f.prompts).toHaveLength(2)
})

test.each(["reassignment", "renewal"] as const)(
  "retained repair preserves the original worker parent after supported %s",
  async (transfer) => {
    const f = fixture()
    await accept(f)
    const prior = f.store.attempts(f.planID)[0]!
    const worker = f.sessions.get(prior.session_id)!
    const predecessor = f.sessions.get("owner")!
    const successor = { ...structuredClone(predecessor), id: "owner-b" }
    f.sessions.set(successor.id, successor)

    if (transfer === "reassignment") {
      await f.runtime.command(
        {
          requestID: "reassign-before-retained-repair",
          planID: f.planID,
          expectedVersion: f.store.plan(f.planID)!.version,
          action: "reassign",
          targetSessionID: successor.id,
          reason: "Transfer retained repair authority without renewing the Architect.",
        },
        predecessor.id,
      )
      expect(predecessor.archived).toBe(false)
      expect(
        f.store.atomic(
          (db) =>
            db
              .query<{ count: number }, [string]>(
                "SELECT COUNT(*) AS count FROM runner_architect_renewal_plans WHERE plan_id=?",
              )
              .get(f.planID)!.count,
        ),
      ).toBe(0)
    } else {
      // Renewal records the same plan-local OWNER_CONTINUED transfer while
      // leaving the accepted worker's original parentID untouched.
      f.store.atomic((db) =>
        db
          .query("UPDATE runner_plans SET owner=?,version=version+1 WHERE id=? AND owner=?")
          .run(successor.id, f.planID, predecessor.id),
      )
      f.store.record(f.planID, null, "OWNER_CONTINUED", {
        from: predecessor.id,
        to: successor.id,
        renewalID: "renewal-retained-repair-test",
      })
      expect(predecessor.archived).toBe(false)
    }

    expect(f.store.plan(f.planID)?.owner).toBe(successor.id)
    expect(worker.parentID).toBe(predecessor.id)
    const command = retainedRepairCommand(f)
    const requested = await f.runtime.command(command, successor.id)
    expect(requested).toMatchObject({
      status: "retained-repair-requested",
      attemptID: prior.id,
      artifact: prior.artifact,
    })
    expect(await f.runtime.command(command, successor.id)).toEqual(requested)
    expect(f.store.attempts(f.planID)).toHaveLength(1)
    expect(f.store.attempts(f.planID)[0]).toMatchObject({
      id: prior.id,
      session_id: prior.session_id,
      state: "preparing",
    })
    expect(worker.parentID).toBe(predecessor.id)

    await f.runtime.tick()
    expect(f.prompts).toHaveLength(2)
    expect(f.prompts[1]?.sessionID).toBe(prior.session_id)
    await f.runtime.tick()
    await f.runtime.tick()
    expect(f.store.plan(f.planID)?.state).toBe("accepted")
    expect(f.store.attempts(f.planID)).toHaveLength(1)
    expect(f.store.attempts(f.planID)[0]).toMatchObject({ id: prior.id, state: "accepted" })
    expect(f.prompts).toHaveLength(2)
    expect(worker.parentID).toBe(predecessor.id)
  },
)

test("A to B to A owner reassignment fences the deferred retained-repair prompt", async () => {
  const f = fixture()
  await accept(f)
  const prior = f.store.attempts(f.planID)[0]!
  const repair = await f.runtime.command(retainedRepairCommand(f), "owner")
  const requestedEpoch = f.store.planControlEpoch(f.planID)
  const owner = f.sessions.get("owner")!
  f.sessions.set("owner-b", { ...structuredClone(owner), id: "owner-b" })

  await f.runtime.command(
    {
      requestID: "reassign-repair-away",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "reassign",
      targetSessionID: "owner-b",
      reason: "Exercise the deferred repair authorization fence.",
    },
    "owner",
  )
  await f.runtime.command(
    {
      requestID: "reassign-repair-back",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "reassign",
      targetSessionID: "owner",
      reason: "Return to the original owner without restoring its authorization epoch.",
    },
    "owner-b",
  )

  expect(f.store.plan(f.planID)).toMatchObject({ state: "running", owner: "owner" })
  expect(f.store.planControlEpoch(f.planID)).toBeGreaterThan(requestedEpoch)
  expect(f.prompts).toHaveLength(1)
  await f.runtime.tick()

  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: prior.id,
    state: "preparing",
    session_id: prior.session_id,
  })
  expect(f.prompts).toHaveLength(1)
  expect(f.store.effects(f.planID).filter((effect) => effect.kind === "prompt")).toHaveLength(1)
  expect(repair).toMatchObject({ status: "retained-repair-requested", attemptID: prior.id })
})

test("A to B to A during retained-repair admission rejects before reservation", async () => {
  const f = fixture({ repairOwnerAdmissionRace: true })
  await accept(f)
  const beforeNode = f.store.nodes(f.planID)[0]
  const beforeAttempt = f.store.attempts(f.planID)[0]

  await expect(f.runtime.command(retainedRepairCommand(f), "owner")).rejects.toThrow()

  expect(f.store.plan(f.planID)).toMatchObject({ state: "accepted", owner: "owner" })
  expect(f.store.nodes(f.planID)[0]).toEqual(beforeNode)
  expect(f.store.attempts(f.planID)[0]).toEqual(beforeAttempt)
  expect(f.store.latestRetainedRepair(f.planID, f.tasks[0]!.id)).toBeUndefined()
  expect(f.store.effects(f.planID).filter((effect) => effect.kind === "prompt")).toHaveLength(1)
  expect(f.prompts).toHaveLength(1)
})

test("repeated artifact hashes require current-generation human evidence after repair", async () => {
  const f = fixture({ humanEvidence: true })
  await f.runtime.command(
    { requestID: "run", planID: f.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  for (let index = 0; index < 6; index++) await f.runtime.tick()
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  const originalAttempt = f.store.attempts(f.planID)[0]!
  const artifact = f.store.nodes(f.planID)[0]!.artifact!
  await f.runtime.command(
    {
      requestID: "original-human-review",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "human-evidence",
      taskID: f.tasks[0]!.id,
      assertionID: "correct-0",
      artifact,
      reason: "Reviewed the original candidate.",
    },
    "owner",
  )
  for (let index = 0; index < 10; index++) await f.runtime.tick()
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  await f.runtime.command(
    {
      requestID: "original-reconcile",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  for (let index = 0; index < 10; index++) await f.runtime.tick()
  expect(f.store.plan(f.planID)?.state).toBe("accepted")

  const repair = await f.runtime.command(retainedRepairCommand(f), "owner")
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: originalAttempt.id,
    state: "verifying",
  })
  expect(f.store.nodes(f.planID)[0]).toMatchObject({ state: "verifying", artifact })
  expect(f.store.plan(f.planID)?.state).toBe("blocked")

  await f.runtime.command(
    {
      requestID: "repair-human-review",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "human-evidence",
      taskID: f.tasks[0]!.id,
      assertionID: "correct-0",
      artifact,
      reason: "Reviewed the retained repair against the reported defect.",
    },
    "owner",
  )
  for (let index = 0; index < 10; index++) await f.runtime.tick()
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  await f.runtime.command(
    {
      requestID: "repair-reconcile",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  for (let index = 0; index < 10; index++) await f.runtime.tick()
  expect(f.store.plan(f.planID)?.state).toBe("accepted")
  expect(f.store.nodes(f.planID)[0]).toMatchObject({ state: "accepted", artifact })
  const humanEvidence = f.store.atomic((db) =>
    db
      .query<{ body: string }, [string, string]>(
        "SELECT body FROM runner_evidence WHERE plan_id=? AND task_id=? AND kind='human' ORDER BY created_at",
      )
      .all(f.planID, f.tasks[0]!.id)
      .map((row) => JSON.parse(row.body) as { sourceGeneration?: string }),
  ) as unknown as Array<{ sourceGeneration?: string }>
  expect(humanEvidence).toHaveLength(2)
  expect(humanEvidence[0]?.sourceGeneration).toBeUndefined()
  expect(humanEvidence[1]?.sourceGeneration).toBe((repair as { operationID: string }).operationID)
})

test(
  "a later retry cannot reuse human acceptance evidence superseded by retained repair",
  { timeout: 15000 },
  async () => {
    const f = fixture({ humanEvidence: true, failRepair: true })
    await f.runtime.command(
      { requestID: "run", planID: f.planID, expectedVersion: 1, action: "run" },
      "owner",
    )
    for (let index = 0; index < 6; index++) await f.runtime.tick()
    const originalArtifact = f.store.nodes(f.planID)[0]!.artifact!
    await f.runtime.command(
      {
        requestID: "original-human-review",
        planID: f.planID,
        expectedVersion: f.store.plan(f.planID)!.version,
        action: "human-evidence",
        taskID: f.tasks[0]!.id,
        assertionID: "correct-0",
        artifact: originalArtifact,
        reason: "Reviewed the original candidate.",
      },
      "owner",
    )
    for (let index = 0; index < 10; index++) await f.runtime.tick()
    await f.runtime.command(
      {
        requestID: "original-reconcile",
        planID: f.planID,
        expectedVersion: f.store.plan(f.planID)!.version,
        action: "reconcile",
      },
      "owner",
    )
    for (let index = 0; index < 10; index++) await f.runtime.tick()
    expect(f.store.plan(f.planID)?.state).toBe("accepted")

    await f.runtime.command(retainedRepairCommand(f), "owner")
    for (let index = 0; index < 4; index++) await f.runtime.tick()
    expect(f.store.plan(f.planID)?.state).toBe("blocked")
    expect(f.store.attempts(f.planID)[0]?.state).toBe("failed")

    await f.runtime.command(
      {
        requestID: "retry-after-retained-repair",
        planID: f.planID,
        expectedVersion: f.store.plan(f.planID)!.version,
        action: "retry",
        taskID: f.tasks[0]!.id,
        reason: "Start a fresh attempt after reviewing the failed retained repair.",
      },
      "owner",
    )
    for (let index = 0; index < 12; index++) await f.runtime.tick()
    expect(f.store.attempts(f.planID)).toHaveLength(2)
    expect(f.store.nodes(f.planID)[0]?.state).toBe("verifying")
    expect(f.store.plan(f.planID)?.state).toBe("blocked")
    expect(f.store.plan(f.planID)?.reason).toContain("correct-0:human")
  },
)

type RepairRejectionCase =
  | "stale"
  | "foreign"
  | "dirty"
  | "wrong-artifact"
  | "changed-route"
  | "changed-identity"
  | "unrelated-transfer"
  | "busy"
  | "pending-input"
  | "pending-permission"
  | "pending-form"
  | "uncertain-effect"

async function verifyRepairRejection(rejected: RepairRejectionCase) {
  const f = fixture()
  await accept(f)
  const command = retainedRepairCommand(f)
  const beforePlan = f.store.plan(f.planID)
  const beforeNode = f.store.nodes(f.planID)[0]
  const beforeAttempt = f.store.attempts(f.planID)[0]
  if (rejected === "dirty") writeFileSync(join(beforeAttempt!.workspace, "untracked.txt"), "dirty")
  if (rejected === "pending-input") f.sessions.get(beforeAttempt!.session_id)!.pendingInput = true
  if (rejected === "pending-permission")
    f.sessions.get(beforeAttempt!.session_id)!.pendingPermissions = 1
  if (rejected === "pending-form") f.sessions.get(beforeAttempt!.session_id)!.pendingForms = 1
  if (rejected === "busy") f.sessions.get(beforeAttempt!.session_id)!.busy = true
  if (rejected === "changed-route")
    f.sessions.get(beforeAttempt!.session_id)!.model = {
      providerID: "openai",
      id: "different-route",
      variant: "high",
    }
  if (rejected === "changed-identity")
    f.sessions.get(beforeAttempt!.session_id)!.parentID = "foreign-owner"
  if (rejected === "unrelated-transfer") {
    f.sessions.get(beforeAttempt!.session_id)!.parentID = "predecessor"
    f.store.record(f.planID, null, "OWNER_REASSIGNED", {
      from: "unrelated-predecessor",
      to: "owner",
    })
  }
  if (rejected === "wrong-artifact") command.artifact = "c".repeat(40)
  if (rejected === "uncertain-effect") {
    f.store.atomic((db) =>
      db
        .query("UPDATE runner_effects SET state='uncertain' WHERE attempt_id=? AND kind='prompt'")
        .run(beforeAttempt!.id),
    )
  }
  if (rejected === "stale") command.expectedVersion--
  const caller = rejected === "foreign" ? "foreign-owner" : "owner"

  await expect(f.runtime.command(command, caller)).rejects.toThrow()
  expect(f.store.plan(f.planID)).toEqual(beforePlan)
  expect(f.store.nodes(f.planID)[0]).toEqual(beforeNode)
  expect(f.store.attempts(f.planID)[0]).toEqual(beforeAttempt)
  expect(f.prompts).toHaveLength(1)
  expect(f.store.latestRetainedRepair(f.planID, f.tasks[0]!.id)).toBeUndefined()
}

test("stale caller/version, wrong artifact and dirty workspace reject without lifecycle changes", async () => {
  for (const rejected of ["stale", "foreign", "dirty"] as const)
    await verifyRepairRejection(rejected)
})

test("wrong artifacts, changed routes and unrelated transfers reject without lifecycle changes", async () => {
  for (const rejected of [
    "wrong-artifact",
    "changed-route",
    "changed-identity",
    "unrelated-transfer",
  ] as const)
    await verifyRepairRejection(rejected)
})

test(
  "foreground/input controls and uncertain effects reject without lifecycle changes",
  { timeout: 20000 },
  async () => {
    for (const rejected of [
      "busy",
      "pending-input",
      "pending-permission",
      "pending-form",
      "uncertain-effect",
    ] as const) {
      await verifyRepairRejection(rejected)
    }
  },
)

test("native ownership and input races reject without reopening or prompting", async () => {
  const f = fixture({ repairRace: true })
  await accept(f)
  const beforePlan = f.store.plan(f.planID)
  const beforeNode = f.store.nodes(f.planID)[0]
  const beforeAttempt = f.store.attempts(f.planID)[0]
  await expect(f.runtime.command(retainedRepairCommand(f), "owner")).rejects.toThrow()
  expect(f.store.plan(f.planID)).toEqual(beforePlan)
  expect(f.store.nodes(f.planID)[0]).toEqual(beforeNode)
  expect(f.store.attempts(f.planID)[0]).toEqual(beforeAttempt)
  expect(f.prompts).toHaveLength(1)
  expect(f.store.latestRetainedRepair(f.planID, f.tasks[0]!.id)).toBeUndefined()
})

test("source-landed artifacts and tasks with dispatched transitive dependents cannot reopen", async () => {
  const landed = fixture()
  await accept(landed)
  const landedAttempt = landed.store.attempts(landed.planID)[0]!
  git(landed.root, ["merge", "--ff-only", landedAttempt.artifact!])
  await expect(landed.runtime.command(retainedRepairCommand(landed), "owner")).rejects.toThrow(
    "Source-landed task work",
  )
  expect(landed.store.plan(landed.planID)?.state).toBe("accepted")

  const dependent = fixture({ dependent: true })
  await start(dependent)
  await dependent.runtime.tick()
  expect(dependent.store.nodes(dependent.planID)[0]?.state).toBe("accepted")
  expect(dependent.store.attempts(dependent.planID)).toHaveLength(2)
  const command = retainedRepairCommand(dependent)
  await expect(dependent.runtime.command(command, "owner")).rejects.toThrow(
    "dispatched transitive dependent",
  )
  expect(dependent.store.nodes(dependent.planID)[0]?.state).toBe("accepted")
  expect(dependent.store.attempts(dependent.planID)).toHaveLength(2)
  expect(dependent.prompts).toHaveLength(2)
})

test("dispatched cross-plan dependents and effective scope reservations reject unchanged", async () => {
  const crossPlan = fixture()
  await accept(crossPlan)
  addActivePlanAttempt(crossPlan, { afterPlans: [crossPlan.planID] })
  const beforeCrossPlan = crossPlan.store.plan(crossPlan.planID)
  await expect(
    crossPlan.runtime.command(retainedRepairCommand(crossPlan), "owner"),
  ).rejects.toThrow("cross-plan dependent")
  expect(crossPlan.store.plan(crossPlan.planID)).toEqual(beforeCrossPlan)
  expect(crossPlan.prompts).toHaveLength(1)
  expect(
    crossPlan.store.latestRetainedRepair(crossPlan.planID, crossPlan.tasks[0]!.id),
  ).toBeUndefined()

  const reservation = fixture()
  await accept(reservation)
  addActivePlanAttempt(reservation, { writeScope: ["result-0.txt"] })
  const beforeReservation = reservation.store.plan(reservation.planID)
  await expect(
    reservation.runtime.command(retainedRepairCommand(reservation), "owner"),
  ).rejects.toThrow("conflicting reservation")
  expect(reservation.store.plan(reservation.planID)).toEqual(beforeReservation)
  expect(reservation.prompts).toHaveLength(1)
  expect(
    reservation.store.latestRetainedRepair(reservation.planID, reservation.tasks[0]!.id),
  ).toBeUndefined()
})

test("a failed retained repair holds the same attempt for decision without automatic replacement", async () => {
  const f = fixture({ failRepair: true })
  await accept(f)
  const attempt = f.store.attempts(f.planID)[0]!
  await f.runtime.command(retainedRepairCommand(f), "owner")
  await f.runtime.tick()
  await f.runtime.tick()

  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({ id: attempt.id, state: "failed" })
  expect(f.prompts).toHaveLength(2)
})

test("an ambiguous retained prompt is never automatically replayed", async () => {
  const f = fixture({ ambiguousRepair: true })
  await accept(f)
  const attempt = f.store.attempts(f.planID)[0]!
  await f.runtime.command(retainedRepairCommand(f), "owner")
  await f.runtime.tick()
  await f.runtime.tick()

  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]?.id).toBe(attempt.id)
  expect(f.prompts).toHaveLength(2)
  expect(f.store.effects(f.planID).filter((effect) => effect.kind === "prompt")).toHaveLength(2)
  const promptStates = f.store
    .effects(f.planID)
    .filter((effect) => effect.kind === "prompt")
    .map((effect) => effect.state)
  expect(promptStates[0]).toBe("completed")
  expect(["completed", "uncertain"]).toContain(promptStates[1]!)
})
