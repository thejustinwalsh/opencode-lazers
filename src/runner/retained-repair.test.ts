import { afterEach, expect, test } from "bun:test"
import { withFallowConfig } from "../../test/runner/fallow-config.ts"
import { settleVerification } from "../../test/runner/verification-driver.ts"
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { ModelMappingStore } from "../models/mapping-store.ts"
import { git } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import type { ModelPolicy } from "./schema.ts"
import { RunnerStore } from "./store.ts"
import type { AttemptRow } from "./store.ts"

const cleanups: Array<() => void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type FixtureOptions = {
  dependent?: boolean
  failRepair?: boolean
  ambiguousRepair?: boolean
  repairRace?: boolean
  repairOwnerAdmissionRace?: boolean
  mappedRoute?: ModelPolicy
  configuredModel?: ModelPolicy | null
  wakeScheduler?: () => void
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
  const configuredModel =
    options.configuredModel === undefined ? model : (options.configuredModel ?? undefined)
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
        evidence: [{ kind: "verification" as const, verificationID: `content-${index}` }],
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
  const mappingStore = new ModelMappingStore(repository)
  if (options.mappedRoute)
    for (const task of tasks)
      mappingStore.update({
        target: { scope: "task", taskID: task.id },
        persona: "systems",
        expectedRevision: 0,
        route: options.mappedRoute,
      })
  const plan = store.submit(
    {
      requestID: "retained-repair-plan",
      objective: "Build and verify the retained repair fixture",
      workspaceMode: "isolated",
      baseCommit: base,
      nodes: tasks.map((task) => ({
        taskID: task.id,
        revision: 1 as const,
        ...(options.mappedRoute ? { persona: "systems" as const } : {}),
      })),
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
    workerModel: () => Promise.resolve(configuredModel),
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
  const runtime = new TaskRuntime(withFallowConfig(store), host, "project", undefined, {
    autoResumeInterrupted: false,
    requestTick: async () => {},
    wakeScheduler: options.wakeScheduler,
  })
  cleanups.push(async () => {
    await runtime.stop()
    repository.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })
  return {
    root,
    state,
    base,
    tasks,
    mappingStore,
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
  await f.runtime.command({ requestID: "run", planID: f.planID, action: "run" }, "owner")
  await f.runtime.tick()
}

async function accept(f: ReturnType<typeof fixture>) {
  await start(f)
  await settleVerification(f.runtime)
  await settleVerification(f.runtime)
}

async function reopen(f: ReturnType<typeof fixture>) {
  await f.runtime.stop()
  const repository = new TaskRepository(join(f.state, "tasks.sqlite"), f.root)
  const store = new RunnerStore(repository)
  store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const runtime = new TaskRuntime(store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    requestTick: async () => {},
  })
  cleanups.push(async () => {
    await runtime.stop()
    repository.close()
  })
  f.store = store
  f.runtime = runtime
}

async function integrateTaskSource(f: ReturnType<typeof fixture>, taskID: string) {
  const node = f.store.nodes(f.planID).find((candidate) => candidate.task_id === taskID)
  if (node?.state !== "accepted" || !node.artifact)
    throw new Error(`Expected accepted task source to integrate: ${taskID}`)
  const current = git(f.root, ["rev-parse", "HEAD"])
  try {
    git(f.root, ["merge-base", "--is-ancestor", node.artifact, current])
  } catch {
    git(f.root, ["merge", "--ff-only", node.artifact])
  }
  const plan = f.store.plan(f.planID)!
  return f.runtime.command(
    {
      requestID: `land-retained-repair-task-${taskID}`,
      planID: f.planID,
      action: "integrated",
      taskID,
      artifact: node.artifact,
      targetBranch: git(f.root, ["branch", "--show-current"]),
      reason: "Review and land accepted task source before its dependent is dispatched",
    },
    "owner",
  )
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

  await settleVerification(f.runtime)
  await settleVerification(f.runtime)
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

test.each([
  {
    label: "a different plan fallback",
    configuredModel: { providerID: "fallback-provider", id: "fallback-model", variant: "high" },
  },
  { label: "no plan fallback", configuredModel: null },
])(
  "mapped retained repair keeps its route through reopen with $label",
  async ({ configuredModel }) => {
    const mappedRoute = {
      providerID: "mapped-provider",
      id: "mapped-model",
      variant: "future/effort-v1",
    }
    const updatedMapping = { ...mappedRoute, variant: "future/effort-v2" }
    const updatedFallback = {
      providerID: "later-fallback-provider",
      id: "later-fallback-model",
      variant: "low",
    }
    const f = fixture({ mappedRoute, configuredModel })
    await accept(f)
    const prior = f.store.attempts(f.planID)[0]!
    const originalPolicy = prior.policy
    const originalDecision = JSON.parse(originalPolicy).routeDecision
    expect(JSON.parse(originalPolicy)).toMatchObject({
      model: mappedRoute,
      routeDecision: {
        status: "resolved",
        source: "task-mapping",
        route: mappedRoute,
        provenance: {
          target: { scope: "task", projectDirectory: f.root, taskID: f.tasks[0]!.id },
          revision: 1,
        },
      },
    })
    expect(f.store.plan(f.planID)?.model).toBe(
      configuredModel ? JSON.stringify(configuredModel) : null,
    )

    expect(
      f.mappingStore.update({
        target: { scope: "task", taskID: f.tasks[0]!.id },
        persona: "systems",
        expectedRevision: 1,
        route: updatedMapping,
      }).status,
    ).toBe("updated")
    f.host.workerModel = () => Promise.resolve(updatedFallback)

    const requested = await f.runtime.command(retainedRepairCommand(f), "owner")
    expect(requested).toMatchObject({ status: "retained-repair-requested", attemptID: prior.id })
    expect(f.store.attempts(f.planID)[0]?.policy).toBe(originalPolicy)
    expect(
      f.store.latestRetainedRepair<{ route: unknown }>(f.planID, f.tasks[0]!.id)?.route,
    ).toEqual(mappedRoute)

    await f.runtime.tick()
    const repaired = f.store.attempts(f.planID)[0]!
    const worker = f.sessions.get(prior.session_id)!
    const repairMessageID = repaired.message_id
    expect(repaired.policy).toBe(originalPolicy)
    expect(worker.model).toEqual(mappedRoute)
    worker.outcome = "interrupted"
    worker.turn = { inputID: repairMessageID, state: "interrupted" }
    await f.runtime.tick()
    expect(f.store.plan(f.planID)?.state).toBe("blocked")

    await reopen(f)
    const resume = {
      requestID: "resume-mapped-retained-repair-after-reopen",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "resume" as const,
      taskID: f.tasks[0]!.id,
      attemptID: prior.id,
      reason: "Continue the original mapped route after reopening the runtime.",
    }
    expect(await f.runtime.command(resume, "owner")).toMatchObject({ status: "resuming" })
    await f.runtime.tick()

    const continued = f.store.attempts(f.planID)[0]!
    expect(continued).toMatchObject({
      id: prior.id,
      session_id: prior.session_id,
      workspace: prior.workspace,
      policy: originalPolicy,
    })
    expect(JSON.parse(continued.policy).routeDecision).toEqual(originalDecision)
    expect(f.sessions.get(prior.session_id)?.model).toEqual(mappedRoute)
    expect(f.prompts).toHaveLength(3)
  },
)

test("authorized interrupted-repair recovery uses the original mapped route and provenance", async () => {
  const mappedRoute = {
    providerID: "recovery-mapped-provider",
    id: "recovery-mapped-model",
    variant: "future/recovery-v1",
  }
  const f = fixture({
    mappedRoute,
    configuredModel: { providerID: "recovery-fallback", id: "recovery-fallback-model" },
  })
  await accept(f)
  const attempt = f.store.attempts(f.planID)[0]!
  const originalPolicy = attempt.policy
  expect(
    f.mappingStore.update({
      target: { scope: "task", taskID: f.tasks[0]!.id },
      persona: "systems",
      expectedRevision: 1,
      route: { ...mappedRoute, variant: "future/recovery-v2" },
    }).status,
  ).toBe("updated")
  f.host.workerModel = () =>
    Promise.resolve({ providerID: "later-recovery-fallback", id: "later-fallback-model" })

  await f.runtime.command(retainedRepairCommand(f), "owner")
  await f.runtime.tick()
  const repairAttempt = f.store.attempts(f.planID)[0]!
  const repairMessageID = repairAttempt.message_id
  const worker = f.sessions.get(attempt.session_id)!
  worker.outcome = "interrupted"
  worker.turn = { inputID: repairMessageID, state: "interrupted" }
  await f.runtime.tick()
  expect(f.store.plan(f.planID)?.state).toBe("blocked")

  await reopen(f)
  const firstResume = {
    requestID: "resume-mapped-repair-before-fence-recovery",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "resume" as const,
    taskID: f.tasks[0]!.id,
    attemptID: attempt.id,
    reason: "Continue the exact interrupted retained repair.",
  }
  await f.runtime.command(firstResume, "owner")
  const reserved = f.store.attempts(f.planID)[0]!
  expect(reserved).toMatchObject({ state: "preparing", policy: originalPolicy })
  const firstResumeEvent = f.store
    .activity(f.planID, f.tasks[0]!.id)
    .filter((entry) => entry.event === "ATTEMPT_RESUMED")
    .at(-1)!
  const legacyPayload = JSON.parse(firstResumeEvent.payload) as Record<string, unknown>
  delete legacyPayload.retainedRepairContinuation
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_transitions SET payload=? WHERE id=?")
      .run(JSON.stringify(legacyPayload), firstResumeEvent.id),
  )

  const internals = Reflect.get(f.runtime, "repairRecords") as {
    retainedRepairForAttempt: (candidate: AttemptRow) => { repairMessageID?: unknown } | undefined
  }
  const currentLookup = internals.retainedRepairForAttempt
  internals.retainedRepairForAttempt = (candidate) => {
    const repair = currentLookup.call(internals, candidate)
    return repair?.repairMessageID === candidate.message_id ? repair : undefined
  }
  try {
    await f.runtime.tick()
    await f.runtime.tick()
  } finally {
    internals.retainedRepairForAttempt = currentLookup
  }
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    state: "cancelled",
    policy: originalPolicy,
  })
  expect(f.prompts).toHaveLength(2)

  const recovery = {
    requestID: "recover-mapped-retained-repair-fence",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "resume" as const,
    taskID: f.tasks[0]!.id,
    attemptID: attempt.id,
    reason: "Recover only the original interrupted mapped repair.",
  }
  const recoveryReads = countDetailedReads(f, attempt.session_id)
  expect(await f.runtime.command(recovery, "owner")).toMatchObject({
    status: "retained-repair-recovered",
    attemptID: attempt.id,
  })
  // Recovery admission and its final revalidation: one detailed worker read each. Both were
  // observe-then-confirm pairs before (four reads).
  expect(recoveryReads.detailed).toBe(2)
  expect(f.store.attempts(f.planID)[0]?.policy).toBe(originalPolicy)
  await f.runtime.tick()

  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
    workspace: attempt.workspace,
    policy: originalPolicy,
  })
  expect(worker.model).toEqual(mappedRoute)
  expect(JSON.parse(f.store.attempts(f.planID)[0]!.policy).routeDecision).toMatchObject({
    source: "task-mapping",
    route: mappedRoute,
    provenance: { revision: 1 },
  })
  expect(f.prompts).toHaveLength(3)
})

test("a changed attempt route and changed retained-repair route never continue", async () => {
  const mappedRoute = {
    providerID: "route-fence-provider",
    id: "route-fence-model",
    variant: "effort-v1",
  }
  const changedRoute = { ...mappedRoute, variant: "effort-v2" }
  const f = fixture({
    mappedRoute,
    configuredModel: { providerID: "route-fallback", id: "route-fallback-model" },
  })
  await accept(f)
  const originalAttempt = f.store.attempts(f.planID)[0]!
  const beforePlan = f.store.plan(f.planID)
  const beforeNode = f.store.nodes(f.planID)[0]
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_attempts SET policy=? WHERE id=?")
      .run(
        JSON.stringify({ ...JSON.parse(originalAttempt.policy), model: changedRoute }),
        originalAttempt.id,
      ),
  )
  const changedAttempt = f.store.attempts(f.planID)[0]!
  await expect(f.runtime.command(retainedRepairCommand(f), "owner")).rejects.toThrow()
  expect(f.store.plan(f.planID)).toEqual(beforePlan)
  expect(f.store.nodes(f.planID)[0]).toEqual(beforeNode)
  expect(f.store.attempts(f.planID)[0]).toEqual(changedAttempt)
  expect(f.prompts).toHaveLength(1)

  const repair = fixture({
    mappedRoute,
    configuredModel: { providerID: "route-fallback", id: "route-fallback-model" },
  })
  await accept(repair)
  const prior = repair.store.attempts(repair.planID)[0]!
  await repair.runtime.command(retainedRepairCommand(repair), "owner")
  const transition = repair.store.atomic((db) =>
    db
      .query<{ id: number; payload: string }, [string, string]>(
        "SELECT id,payload FROM runner_transitions WHERE plan_id=? AND task_id=? AND event='RETAINED_REPAIR_REQUESTED' ORDER BY id DESC LIMIT 1",
      )
      .get(repair.planID, repair.tasks[0]!.id),
  )!
  const payload = JSON.parse(transition.payload) as Record<string, unknown>
  payload.route = changedRoute
  repair.store.atomic((db) =>
    db
      .query("UPDATE runner_transitions SET payload=? WHERE id=?")
      .run(JSON.stringify(payload), transition.id),
  )
  await repair.runtime.tick()
  await repair.runtime.tick()
  expect(repair.store.attempts(repair.planID)).toHaveLength(1)
  expect(repair.store.attempts(repair.planID)[0]).toMatchObject({
    id: prior.id,
    policy: prior.policy,
  })
  expect(repair.prompts).toHaveLength(1)
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
    await settleVerification(f.runtime)
    await settleVerification(f.runtime)
    expect(f.store.plan(f.planID)?.state).toBe("accepted")
    expect(f.store.attempts(f.planID)).toHaveLength(1)
    expect(f.store.attempts(f.planID)[0]).toMatchObject({ id: prior.id, state: "accepted" })
    expect(f.prompts).toHaveLength(2)
    expect(worker.parentID).toBe(predecessor.id)
  },
)

test("retained repair follows multiple continuations before reassignment without reparenting the worker", async () => {
  const f = fixture()
  await accept(f)
  const prior = f.store.attempts(f.planID)[0]!
  const worker = f.sessions.get(prior.session_id)!
  const originalParent = worker.parentID
  let ownerID = "owner"

  for (const nextOwnerID of ["renewed-owner-1", "renewed-owner-2", "renewed-owner-3"]) {
    f.sessions.set(nextOwnerID, {
      ...structuredClone(f.sessions.get(ownerID)!),
      id: nextOwnerID,
    })
    expect(f.store.updatePlanOwner(f.planID, ownerID, nextOwnerID)).toBe(true)
    ownerID = nextOwnerID
  }

  const currentOwner = { ...structuredClone(f.sessions.get(ownerID)!), id: "current-owner" }
  f.sessions.set(currentOwner.id, currentOwner)
  await f.runtime.command(
    {
      requestID: "reassign-after-retained-repair-renewals",
      planID: f.planID,
      action: "reassign",
      targetSessionID: currentOwner.id,
      reason: "Reassign retained repair authority after successive supported continuations.",
    },
    ownerID,
  )

  expect(f.store.plan(f.planID)?.owner).toBe(currentOwner.id)
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(worker.parentID).toBe(originalParent)
  expect(originalParent).toBe("owner")

  const command = retainedRepairCommand(f)
  const requested = await f.runtime.command(command, currentOwner.id)
  expect(requested).toMatchObject({
    status: "retained-repair-requested",
    taskID: prior.task_id,
    attemptID: prior.id,
    artifact: prior.artifact,
  })
  expect(await f.runtime.command(command, currentOwner.id)).toEqual(requested)
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: prior.id,
    session_id: prior.session_id,
    state: "preparing",
  })
  expect(worker.parentID).toBe(originalParent)
  expect(f.created).toHaveLength(1)

  await f.runtime.tick()
  expect(f.prompts).toHaveLength(2)
  expect(f.prompts[1]?.sessionID).toBe(prior.session_id)
  await settleVerification(f.runtime)
  await settleVerification(f.runtime)
  expect(f.store.plan(f.planID)?.state).toBe("accepted")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: prior.id,
    session_id: prior.session_id,
    state: "accepted",
  })
  expect(worker.parentID).toBe(originalParent)
  expect(f.prompts).toHaveLength(2)
})

test("A to B to A during retained-repair admission re-reads the plan and applies once", async () => {
  const f = fixture({ repairOwnerAdmissionRace: true })
  await accept(f)
  const versionBefore = f.store.plan(f.planID)!.version

  // The owner round-trip moves the plan version between the runtime's read and
  // its transaction. The runtime re-reads, re-evaluates against the machine and
  // admits the same command once; the caller supplied no version to go stale.
  await expect(f.runtime.command(retainedRepairCommand(f), "owner")).resolves.toMatchObject({
    status: "retained-repair-requested",
  })

  expect(f.store.plan(f.planID)).toMatchObject({ state: "running", owner: "owner" })
  expect(f.store.plan(f.planID)!.version).toBeGreaterThan(versionBefore)
  expect(f.store.latestRetainedRepair(f.planID, f.tasks[0]!.id)).toBeDefined()
})

type RepairRejectionCase =
  | "stale"
  | "foreign"
  | "wrong-artifact"
  | "changed-route"
  | "changed-identity"
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
  if (rejected === "wrong-artifact") command.artifact = "c".repeat(40)
  if (rejected === "uncertain-effect") {
    f.store.atomic((db) =>
      db
        .query("UPDATE runner_effects SET state='uncertain' WHERE attempt_id=? AND kind='prompt'")
        .run(beforeAttempt!.id),
    )
  }
  const caller = rejected === "foreign" ? "foreign-owner" : "owner"

  await expect(f.runtime.command(command, caller)).rejects.toThrow()
  expect(f.store.plan(f.planID)).toEqual(beforePlan)
  expect(f.store.nodes(f.planID)[0]).toEqual(beforeNode)
  expect(f.store.attempts(f.planID)[0]).toEqual(beforeAttempt)
  expect(f.prompts).toHaveLength(1)
  expect(f.store.latestRetainedRepair(f.planID, f.tasks[0]!.id)).toBeUndefined()
}

test("foreign caller rejects without lifecycle changes", async () => {
  for (const rejected of ["foreign"] as const) await verifyRepairRejection(rejected)
})

test("wrong artifacts and changed routes reject without lifecycle changes", async () => {
  for (const rejected of ["wrong-artifact", "changed-route"] as const)
    await verifyRepairRejection(rejected)
})

test("foreground/input controls and uncertain effects reject without lifecycle changes", async () => {
  for (const rejected of [
    "busy",
    "pending-input",
    "pending-permission",
    "pending-form",
    "uncertain-effect",
  ] as const) {
    await verifyRepairRejection(rejected)
  }
})

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

test("source-landed artifacts and an actually dispatched dependent cannot reopen", async () => {
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
  await settleVerification(dependent.runtime)
  expect(dependent.store.nodes(dependent.planID)[0]?.state).toBe("accepted")
  expect(dependent.store.attempts(dependent.planID)).toHaveLength(1)
  await integrateTaskSource(dependent, dependent.tasks[0]!.id)
  for (let index = 0; index < 5 && dependent.store.attempts(dependent.planID).length < 2; index++)
    await dependent.runtime.tick()
  expect(dependent.store.attempts(dependent.planID)).toHaveLength(2)
  const [prerequisiteAttempt, successorAttempt] = dependent.store.attempts(dependent.planID)
  expect(prerequisiteAttempt?.artifact).toBeString()
  expect(successorAttempt?.base_commit).toBe(git(dependent.root, ["rev-parse", "HEAD"]))
  expect(
    git(dependent.root, [
      "merge-base",
      "--is-ancestor",
      prerequisiteAttempt!.artifact!,
      successorAttempt!.base_commit!,
    ]),
  ).toBe("")
  const command = retainedRepairCommand(dependent)
  await expect(dependent.runtime.command(command, "owner")).rejects.toThrow(
    "Source-landed task work",
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
  await settleVerification(f.runtime)
  await settleVerification(f.runtime)

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
  await settleVerification(f.runtime)
  await settleVerification(f.runtime)

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

test("retained repair preserves uncommitted work in the original worker", async () => {
  const f = fixture()
  await accept(f)
  const prior = f.store.attempts(f.planID)[0]!
  const path = join(prior.workspace, "untracked.txt")
  writeFileSync(path, "useful partial work")
  const result = await f.runtime.command(retainedRepairCommand(f), "owner")
  expect(result).toMatchObject({ status: "retained-repair-requested", attemptID: prior.id })
  expect(readFileSync(path, "utf8")).toBe("useful partial work")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
})

test("a resumed retained repair whose worker is still running on its prior input leaves preparing", async () => {
  const f = fixture()
  await accept(f)
  const attempt = f.store.attempts(f.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  await f.runtime.command(retainedRepairCommand(f), "owner")
  await f.runtime.tick()
  const repairMessageID = f.store.attempts(f.planID)[0]!.message_id
  // The worker is mid-turn on the repair input, then a stale observation reads it as interrupted.
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: repairMessageID, state: "interrupted" }
  await f.runtime.tick()
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  await f.runtime.command(
    {
      requestID: "resume-stale-interrupted-repair",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "resume",
      taskID: f.tasks[0]!.id,
      attemptID: attempt.id,
      reason: "Continue the interrupted retained repair.",
    },
    "owner",
  )
  expect(f.store.attempts(f.planID)[0]?.state).toBe("preparing")
  // The worker was in fact still running its turn the whole time.
  worker.busy = true
  worker.outcome = undefined
  worker.turn = { inputID: repairMessageID, state: "pending" }
  for (let tick = 0; tick < 4; tick++) await f.runtime.tick()
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    state: "running",
    message_id: repairMessageID,
  })
  expect(f.store.plan(f.planID)?.state).toBe("running")
  expect(taskEvents(f, f.tasks[0]!.id, "WORKER_RESUME_ADOPTED")).toHaveLength(1)
  // No second input was queued behind the live turn.
  expect(f.prompts).toHaveLength(2)
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: repairMessageID, state: "completed" }
  await settleVerification(f.runtime)
  await settleVerification(f.runtime)
  expect(f.store.attempts(f.planID)[0]?.state).toBe("accepted")
  expect(f.prompts).toHaveLength(2)
})

/** Counts detailed (`messages: true`) reads of one session on a fake host. */
function countDetailedReads(f: ReturnType<typeof fixture>, sessionID: string) {
  const original = f.host.session
  const counts = { detailed: 0, metadata: 0 }
  f.host.session = async (id, options) => {
    if (id === sessionID) counts[options?.messages ? "detailed" : "metadata"]++
    return original(id, options)
  }
  return counts
}

test("retained repair admission reads the worker conversation once per revalidation, not twice", async () => {
  const f = fixture()
  await accept(f)
  const prior = f.store.attempts(f.planID)[0]!
  const reads = countDetailedReads(f, prior.session_id)
  await f.runtime.command(retainedRepairCommand(f), "owner")
  // Two admission stages (prepare, final revalidation), each one detailed read. Each stage was
  // an observe-then-confirm pair before, so the same command made four.
  expect(reads.detailed).toBe(2)
})

test("observing a retained repair candidate reads the worker conversation once, after the owner", async () => {
  const f = fixture()
  await accept(f)
  await f.runtime.command(retainedRepairCommand(f), "owner")
  await f.runtime.tick()
  const attempt = f.store.attempts(f.planID)[0]!
  const repairs = Reflect.get(f.runtime, "repairRecords") as {
    retainedRepairForAttempt: (candidate: AttemptRow) => { operationID: string } | undefined
  }
  const repair = repairs.retainedRepairForAttempt(attempt)!
  const worker = f.sessions.get(attempt.session_id)!
  const order: string[] = []
  const original = f.host.session
  f.host.session = async (id, options) => {
    if (id === attempt.session_id && options?.messages) order.push("worker")
    return original(id, options)
  }
  const preparation = Reflect.get(f.runtime, "retainedVerificationPrep") as {
    observeRetainedRepairCandidate: (
      plan: unknown,
      attempt: AttemptRow,
      binding: unknown,
      observeOwner: () => Promise<void>,
    ) => Promise<void>
  }
  await preparation
    .observeRetainedRepairCandidate(
      f.store.plan(f.planID)!,
      attempt,
      { operationID: repair.operationID },
      async () => {
        order.push("owner")
      },
    )
    .catch((error: unknown) => {
      // Only the read count matters here; the candidate itself may still be rejected.
      order.push(`rejected:${String(error).slice(0, 40)}`)
    })
  expect(worker.id).toBe(attempt.session_id)
  expect(order.filter((step) => step === "worker")).toHaveLength(1)
  expect(order.indexOf("owner")).toBeLessThan(order.indexOf("worker"))
})
