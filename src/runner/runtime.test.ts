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
import { combineArtifacts, git } from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import { RunnerStore } from "./store.ts"
import { PlanInput } from "./schema.ts"
import type { WorkerPersona } from "./schema.ts"
import { TaskReads } from "../tasks/read.ts"
import { taskInstructions } from "../tasks/instructions.ts"
import type { OutcomeInboxEntry } from "./inbox.ts"
import { isOwnedQueuedOutcome } from "./inbox.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})
function fixture(
  options: {
    fail?: boolean
    human?: boolean
    outside?: boolean
    shared?: boolean
    commit?: boolean
    repair?: boolean
    wrongFirstB?: boolean
    skillSuggestions?: string[]
    workerModel?: { providerID: string; id: string; variant?: string }
    personas?: (WorkerPersona | undefined)[]
    startOnly?: boolean
    independent?: boolean
    delayed?: boolean
    wrongFirstA?: boolean
    allowScopeOverlap?: boolean
    taskFiles?: { name: string; path: string; scope?: string[] }[]
    requireVerifierPreparation?: boolean
    loseWorktreeResponse?: boolean | "empty-error"
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-runner-")))
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
  if (!options.shared) writeFileSync(join(root, "dirty-sentinel.txt"), "preserve me")
  const stateDirectory = options.shared
    ? mkdtempSync(join(tmpdir(), "lazers-shared-data-"))
    : join(root, "data")
  const repository = new TaskRepository(join(stateDirectory, "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  const metadata = new Map<string, { name: string; path: string }>()
  const createTask = (
    name: string,
    path = `${name}.txt`,
    scope: string[] = [path],
    failing = false,
  ) => {
    const proposal = validProposal()
    proposal.objective = `Write ${path}`
    proposal.writeScope = scope
    proposal.verification = [
      {
        id: "content",
        command: options.fail && failing ? "exit 7" : `test "$(cat ${path})" = "${name}"`,
        timeoutMs: 1000,
      },
    ]
    proposal.acceptance = [
      {
        id: "correct",
        assertion: `${name} exists with exact content`,
        evidence: [
          { kind: "verification", verificationID: "content" },
          ...(options.human ? [{ kind: "human" as const, decision: "review" }] : []),
        ],
      },
    ]
    proposal.requirements.skills = options.skillSuggestions ?? []
    proposal.limits.maxRepairAttempts = options.repair ? 1 : 0
    const task = repository.insert({
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
    metadata.set(task.id, { name, path })
    return task
  }
  const taskFiles: { name: string; path: string; scope?: string[] }[] =
    options.taskFiles ?? ["a", "b"].map((name) => ({ name, path: `${name}.txt` }))
  const tasks = taskFiles.map((file, index) =>
    createTask(file.name, file.path, file.scope ?? [file.path], index === 0),
  )
  const sessions = new Map<string, HostSession>()
  sessions.set("owner", {
    id: "owner",
    projectID: "project",
    directory: root,
    agent: "architect",
    archived: false,
    busy: false,
    model: { providerID: "openai", id: "subscription", variant: "high" },
    tokens: null,
    tools: 0,
    cost: null,
    messages: [],
  })
  const events: string[] = []
  const instructions = new Map<string, Map<string, string>>()
  const inbox = new Map<string, OutcomeInboxEntry[]>()
  const admissionOwners = new Map<string, string>()
  const host: RunnerHost = {
    workerModel: async () => options.workerModel ?? { providerID: "openai", id: "test-model" },
    worktree: async ({ directory, base }) => {
      git(root, ["worktree", "add", "--detach", directory, base])
      if (options.loseWorktreeResponse) {
        const emptyError = options.loseWorktreeResponse === "empty-error"
        options.loseWorktreeResponse = false
        throw new Error(emptyError ? "" : "worktree response lost")
      }
      return directory
    },
    worktrees: async () =>
      git(root, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice(9)),
    removeWorktree: async (directory) => {
      git(root, ["worktree", "remove", directory])
    },
    session: async (id) => structuredClone(sessions.get(id) ?? null),
    create: async (input) => {
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
        tokens: 100,
        tools: 1,
        cost: null,
        messages: [],
      })
    },
    createArchitect: async (input) => {
      events.push(`create-architect:${input.id}`)
      sessions.set(input.id, {
        id: input.id,
        parentID: input.parentID,
        projectID: "project",
        directory: input.directory,
        agent: "architect",
        metadata: {
          lazersContinuation: true,
          lazersPlanID: input.planID,
          lazersSourceSessionID: input.sourceSessionID,
        },
        model: input.model,
        archived: false,
        busy: false,
        tokens: 0,
        tools: 0,
        cost: null,
        messages: [],
      })
    },
    prompt: async (input) => {
      events.push(`prompt:${input.id}`)
      expect(input.text).toContain("lazers_get_task_instructions")
      expect(input.text).not.toContain('"specification"')
      expect(input.text).not.toContain("SECRET_SKILL_BODY_CANARY")
      expect("skills" in input).toBe(false)
      expect(input.text.length).toBeLessThan(1200)
      const session = sessions.get(input.sessionID)!
      session.messages.push({ id: input.id, text: input.text })
      const assigned = store
        .plans()
        .flatMap((plan) => store.attempts(plan.id))
        .find((attempt) => attempt.session_id === input.sessionID)!
      const info = metadata.get(assigned.task_id)!
      const path = info.path
      if (path === "b.txt" && !options.independent && !options.taskFiles)
        expect(readFileSync(join(session.directory, "a.txt"), "utf8")).toBe("a")
      const wrongFirstB = options.wrongFirstB && path === "b.txt" && assigned.number === 1
      const wrongFirstA = options.wrongFirstA && info.name === "a" && assigned.number === 1
      if (wrongFirstB) {
        session.tokens = 65941
        session.tools = 17
        session.cost = 1.25
      }
      mkdirSync(dirname(join(session.directory, path)), { recursive: true })
      writeFileSync(join(session.directory, path), wrongFirstA || wrongFirstB ? "wrong" : info.name)
      if (options.outside) writeFileSync(join(session.directory, "escape.txt"), "bad")
      if (options.shared || options.commit) {
        const checkout = session.directory
        git(checkout, ["add", path])
        if (git(checkout, ["status", "--porcelain"]))
          git(checkout, [
            "-c",
            "user.name=fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            `Implement ${path}`,
          ])
      }
      if (options.delayed) {
        session.busy = true
        events.push(`start:${session.id}`)
      } else session.outcome = "succeeded"
    },
    updateInstruction: async (input) => {
      const effect = store
        .effects(store.execution(tasks[0]!.id)!.planID)
        .find(
          (item) => item.kind === "scope-instruction" && JSON.parse(item.payload).key === input.key,
        )
      expect(effect?.state).toMatch(/intended|uncertain/)
      const target = sessions.get(input.sessionID)
      if (
        !target ||
        target.archived ||
        target.projectID !== input.projectID ||
        target.directory !== input.directory ||
        target.metadata?.lazersAttemptID !== input.attemptID
      )
        throw new Error("Scope instruction target is not the owned worker attempt")
      const entries = instructions.get(input.sessionID) ?? new Map<string, string>()
      if (entries.get(input.key) === input.text) return
      entries.set(input.key, input.text)
      instructions.set(input.sessionID, entries)
      events.push(`instruction:${input.key}`)
    },
    outcomeInbox: async (targetSessionID) => structuredClone(inbox.get(targetSessionID) ?? []),
    cancelOutcome: async (input) => {
      const entries = inbox.get(input.sessionID) ?? []
      const index = entries.findIndex((entry) => entry.id === input.inboxID)
      const entry = entries[index]
      if (!entry || !isOwnedQueuedOutcome(entry, input.ownership))
        throw new Error("Fixture refused to cancel unowned or non-queued input")
      entries.splice(index, 1)
      events.push(`cancel:${input.inboxID}`)
    },
    notify: async (input) => {
      const admittedTo = admissionOwners.get(input.id)
      if (admittedTo && admittedTo !== input.sessionID)
        throw new Error("Native lifecycle conflict: message ID belongs to another session")
      admissionOwners.set(input.id, input.sessionID)
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
      sessions.get(id)!.busy = false
      sessions.get(id)!.outcome = "interrupted"
      events.push(`stop:${id}`)
    },
  }
  const runtime = new TaskRuntime(store, host, "project")
  const inputFor = (
    selected: typeof tasks,
    config: {
      requestID?: string
      dependencies?: [number, number][]
      allowScopeOverlap?: boolean
    } = {},
  ) => {
    const files = selected.map((task) => metadata.get(task.id)!)
    const dependencies =
      config.dependencies ??
      (!options.independent
        ? files.slice(1).map((_, index) => [index, index + 1] as [number, number])
        : [])
    return {
      requestID: config.requestID ?? "plan-request",
      objective: `Implement ${files.map((file) => file.name).join(" and ")}`,
      workspaceMode: options.shared ? ("shared" as const) : ("isolated" as const),
      baseCommit: base,
      ...(options.workerModel ? { workerModel: options.workerModel } : {}),
      nodes: selected.map((task) => {
        const persona = options.personas?.[tasks.indexOf(task)]
        return { taskID: task.id, revision: 1 as const, ...(persona ? { persona } : {}) }
      }),
      dependencies: dependencies.map(([prerequisite, successor]) => ({
        prerequisite: selected[prerequisite]!.id,
        successor: selected[successor]!.id,
      })),
      integrationOrder: selected.map((task) => task.id),
      verification: [
        {
          id: "combined",
          command: `${options.requireVerifierPreparation ? `test -f '${join(stateDirectory, "verifier-ready")}' && ` : ""}test "$(cat ${files.map((file) => file.path).join(" ")})" = "${files.map((file) => file.name).join("")}"`,
          timeoutMs: 1000,
        },
      ],
      acceptance: [
        {
          id: "combined",
          assertion: "All accepted changes coexist",
          evidence: [{ kind: "verification" as const, verificationID: "combined" }],
        },
      ],
      ...(config.allowScopeOverlap
        ? {
            dispositions: selected.flatMap((task, index) =>
              selected.slice(index + 1).map((other) => ({
                taskID: task.id,
                otherTaskID: other.id,
                relation: "supplements" as const,
                rationale: "The paths are intentionally scheduled sequentially in this fixture.",
              })),
            ),
          }
        : {}),
    }
  }
  const input = inputFor(tasks, { allowScopeOverlap: options.allowScopeOverlap })
  const receipt = options.startOnly ? undefined : store.submit(input, "owner")
  cleanup.push(() => {
    runtime.stop()
    repository.close()
    rmSync(root, { recursive: true, force: true })
    if (options.shared) rmSync(stateDirectory, { recursive: true, force: true })
  })
  const completeWorker = (
    id: string,
    outcome: "succeeded" | "failed" | "interrupted" = "succeeded",
  ) => {
    const session = sessions.get(id)
    if (!session) throw new Error(`Missing worker ${id}`)
    session.busy = false
    session.outcome = outcome
    events.push(`stop:${id}`)
  }
  return {
    root,
    repository,
    store,
    tasks,
    sessions,
    events,
    instructions,
    host,
    inbox,
    runtime,
    input,
    receipt: receipt!,
    inputFor,
    createTask,
    completeWorker,
    base,
  }
}
async function drive(runtime: TaskRuntime, count = 8) {
  for (let n = 0; n < count; n++) await runtime.tick()
}

test("active scope amendments durably update the same worker after it fetched old instructions and survive reopen", async () => {
  const f = fixture({
    delayed: true,
    outside: true,
    repair: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(planID)[0]!
  const original = f.repository.get(attempt.task_id)
  const fetched = taskInstructions(new TaskReads(f.repository).get({ taskID: attempt.task_id }))
  expect(fetched).not.toContain("escape.txt")
  const command = {
    requestID: "allow-test",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
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
  const runtime = new TaskRuntime(store, f.host, "project")
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
    await f.runtime.command(
      { requestID: "run", planID, expectedVersion: 1, action: "run" },
      "owner",
    )
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
        expectedVersion: f.store.plan(planID)!.version,
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
    const reopened = new TaskRuntime(f.store, f.host, "project")
    try {
      await drive(reopened, 2)
      expect(f.store.effects(planID).at(-1)!.state).toBe("completed")
      expect(f.events.filter((event) => event.startsWith("instruction:"))).toHaveLength(1)
      await reopened.command(
        {
          requestID: "resume-after-receipt",
          planID,
          expectedVersion: f.store.plan(planID)!.version,
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
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 2)
  await f.runtime.command(
    {
      requestID: "allow-test",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
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
      expectedVersion: f.store.plan(planID)!.version,
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
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 2)
  const first = f.store.attempts(planID)[0]!
  f.completeWorker(first.session_id)
  await drive(f.runtime, 3)
  const node = f.store.nodes(planID)[0]!
  const second = f.store.attempts(planID)[1]!
  expect(node.state).toBe("accepted")
  expect(second.state).toBe("running")
  const command = {
    requestID: "land-first",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
    action: "integrated",
    taskID: node.task_id,
    artifact: node.artifact!,
    targetBranch: "main",
    reason: "Reviewed accepted task and passing checks.",
  }
  await expect(f.runtime.command(command, "other")).rejects.toThrow("Only the plan owner")
  await expect(f.runtime.command({ ...command, expectedVersion: 1 }, "owner")).rejects.toThrow(
    "Stale plan version",
  )
  await expect(f.runtime.command({ ...command, taskID: second.task_id }, "owner")).rejects.toThrow(
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
    version: command.expectedVersion + 1,
  })
  expect(await f.runtime.command(command, "owner")).toEqual(result)
  expect(f.store.plan(planID)).toEqual({ ...before.plan!, version: command.expectedVersion + 1 })
  expect(f.store.nodes(planID)).toEqual(before.nodes)
  expect(f.store.attempts(planID)).toEqual(before.attempts)
  expect([...f.sessions]).toEqual(before.sessions)
  expect(f.events).toEqual(before.events)
  expect(existsSync(first.workspace)).toBe(true)
  expect(existsSync(second.workspace)).toBe(true)
  expect(
    f.store
      .activity(planID, node.task_id)
      .filter((event) => event.event === "TASK_INTEGRATION_RECORDED"),
  ).toHaveLength(1)
})

test("scope violations hold a stopped candidate without spending repair, then amendment and reconcile verify it", async () => {
  const f = fixture({ outside: true, repair: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  const spec = f.repository.get(task.id)
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 4)
  const blocked = f.store.plan(planID)!
  const first = f.store.attempts(planID)[0]!
  expect(blocked.state).toBe("blocked")
  expect(blocked.reason).toContain("escape.txt")
  expect(first.state).toBe("verifying")
  expect(f.store.nodes(planID)[0]!.state).toBe("verifying")
  expect(
    f.store.activity(planID, task.id).filter((event) => event.event === "REPAIR"),
  ).toHaveLength(0)
  const history = f.store.activity(planID, task.id)
  const workspaceStatus = git(first.workspace, ["status", "--porcelain"])
  await drive(f.runtime, 5)
  expect(f.store.plan(planID)!.version).toBe(blocked.version)
  expect(f.store.activity(planID, task.id)).toEqual(history)
  expect(git(first.workspace, ["status", "--porcelain"])).toBe(workspaceStatus)
  expect(readFileSync(join(first.workspace, "escape.txt"), "utf8")).toBe("bad")
  expect(f.store.attempts(planID)).toHaveLength(1)
  await f.runtime.command(
    {
      requestID: "authorize-dependency",
      planID,
      expectedVersion: blocked.version,
      action: "amend-scope",
      taskID: task.id,
      scopeAdditions: ["escape.txt"],
      reason: "Reviewed dependency belongs to this implementation.",
    },
    "owner",
  )
  await drive(f.runtime, 2)
  expect(f.store.plan(planID)!.state).toBe("blocked")
  await f.runtime.command(
    {
      requestID: "review-candidate",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 5)
  expect(f.store.plan(planID)!.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]!.id).toBe(first.id)
  expect(f.store.attempts(planID)[0]!.state).toBe("accepted")
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.repository.get(task.id)).toEqual(spec)
})

test("scope amendments preserve the specification and recover dependency edits in the same attempt", async () => {
  const f = fixture({ outside: true, delayed: true })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  const original = f.repository.get(task.id)
  await f.runtime.command(
    { requestID: "scope-run", planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(planID)[0]!
  expect(attempt.state).toBe("running")
  const version = f.store.plan(planID)!.version
  const command = {
    requestID: "allow-dependency",
    planID,
    expectedVersion: version,
    action: "amend-scope" as const,
    taskID: task.id,
    scopeAdditions: ["escape.txt"],
    reason: "The existing implementation needs this dependency file.",
  }
  await expect(f.runtime.command(command, "other-owner")).rejects.toThrow("Only the plan owner")
  await expect(
    f.runtime.command({ ...command, expectedVersion: version - 1 }, "owner"),
  ).rejects.toThrow("Stale plan version")
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
  expect(taskInstructions(new TaskReads(f.repository).get({ taskID: task.id }))).toContain(
    "Authorized execution scope",
  )
  expect(
    f.store.activity(planID, task.id).filter((event) => event.event === "SCOPE_AMENDED"),
  ).toHaveLength(1)
  const now = f.store.plan(planID)!.version
  const unchanged = await f.runtime.command(
    { ...command, requestID: "duplicate-path", expectedVersion: now },
    "owner",
  )
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
        expectedVersion: f.store.plan(planID)!.version,
        scopeAdditions: ["another.txt"],
      },
      "owner",
    ),
  ).rejects.toThrow("unfinished work")
})

test("scope amendment rejects active overlap and reserves amended scope before later dispatch", async () => {
  const f = fixture({ independent: true, delayed: true })
  const planID = f.receipt.planID
  await f.runtime.command(
    { requestID: "scope-run", planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime, 2)
  expect(f.store.attempts(planID)).toHaveLength(2)
  const version = f.store.plan(planID)!.version
  await expect(
    f.runtime.command(
      {
        requestID: "conflicting-amendment",
        planID,
        expectedVersion: version,
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
      expectedVersion: 1,
      action: "amend-scope",
      taskID: queued.tasks[0]!.id,
      scopeAdditions: ["b.txt"],
      reason: "Reserve dependency before dispatch.",
    },
    "owner",
  )
  await queued.runtime.command(
    { requestID: "queued-run", planID: queuedPlan, expectedVersion: 2, action: "run" },
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
    expectedVersion: 1,
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
        expectedVersion: 1,
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

test("inspector Start admits one real runtime plan and returns record-backed task state", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  const task = f.tasks[0]!
  const input = { taskID: task.id, revision: 1 as const, sessionID: "owner" }
  const [first, concurrent] = await Promise.all([
    f.runtime.startTask(input),
    f.runtime.startTask(input),
  ])
  expect(first).toMatchObject({ status: "started", state: "running" })
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
  const reopened = new TaskRuntime(f.store, f.host, "project")
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
  for (const kind of ["foreign", "stale"] as const) {
    const f = fixture({ shared: true })
    f.sessions.get("owner")!.agent = "build"
    const before = f.store.plan(f.receipt.planID)!
    await expect(
      f.runtime.command(
        {
          requestID: "denied-run",
          planID: before.id,
          expectedVersion: kind === "stale" ? 99 : 1,
          action: "run",
        },
        kind === "foreign" ? "not-the-owner" : "owner",
      ),
    ).rejects.toThrow(kind === "foreign" ? "Only the plan owner" : "Stale plan version")
    expect(f.store.plan(before.id)).toEqual(before)
    expect(f.store.continuation(before.id)).toBeNull()
    expect(f.events).toEqual([])
    expect(f.store.attempts(before.id)).toHaveLength(0)
  }
})

test("continued run retains original caller/version replay identity across concurrent calls and restart", async () => {
  const f = fixture({ shared: true })
  f.sessions.get("owner")!.agent = "build"
  const input = {
    requestID: "continued-run",
    planID: f.receipt.planID,
    expectedVersion: 1,
    action: "run",
  }
  const results = await Promise.all([
    f.runtime.command(input, "owner"),
    f.runtime.command(input, "owner"),
  ])
  expect(results[0]).toEqual(results[1])
  expect(await f.runtime.command(input, "owner")).toEqual(results[0])
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  expect(await reopened.command(input, "owner")).toEqual(results[0])
  await expect(reopened.command(input, "not-the-owner")).rejects.toThrow("identity conflict")
  await expect(reopened.command({ ...input, reason: "changed" }, "owner")).rejects.toThrow(
    "identity conflict",
  )
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
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

test("continued run recovers a crash before its receipt without changing caller identity", async () => {
  const f = fixture({ shared: true })
  f.sessions.get("owner")!.agent = "build"
  const input = {
    requestID: "crashed-run",
    planID: f.receipt.planID,
    expectedVersion: 1,
    action: "run",
  }
  const command = f.store.command.bind(f.store)
  f.store.command = () => {
    throw new Error("Injected pre-receipt crash")
  }
  await expect(f.runtime.command(input, "owner")).rejects.toThrow("Injected")
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    owner: "owner",
    version: 1,
    state: "draft",
  })
  f.store.command = command
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  const result = await reopened.command(input, "owner")
  expect(result).toMatchObject({ status: "running" })
  expect(await reopened.command(input, "owner")).toEqual(result)
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
})

test("a concurrent reassignment cannot be overwritten by continuation completion", async () => {
  const f = fixture({ shared: true })
  f.sessions.get("owner")!.agent = "build"
  f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner", agent: "architect" })
  const create = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    await create(input)
    await f.runtime.command(
      {
        requestID: "reassign-during-create",
        planID: f.receipt.planID,
        expectedVersion: 1,
        action: "reassign",
        targetSessionID: "new-owner",
        reason: "Explicit ownership change",
      },
      "owner",
    )
  }
  const input = {
    requestID: "racing-run",
    planID: f.receipt.planID,
    expectedVersion: 1,
    action: "run",
  }
  await expect(f.runtime.command(input, "owner")).rejects.toThrow("Stale plan version")
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    owner: "new-owner",
    version: 2,
    state: "draft",
  })
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(0)
  await expect(f.runtime.command({ ...input, expectedVersion: 2 }, "owner")).rejects.toThrow(
    "Only the plan owner",
  )
})

test("Start cannot adopt a stale continuation after an explicit owner round trip", async () => {
  const f = fixture({ shared: true })
  f.sessions.get("owner")!.agent = "build"
  f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner", agent: "architect" })
  const create = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    await create(input)
    await f.runtime.command(
      {
        requestID: "owner-away",
        planID: f.receipt.planID,
        expectedVersion: 1,
        action: "reassign",
        targetSessionID: "new-owner",
        reason: "Explicit move",
      },
      "owner",
    )
    f.sessions.get("owner")!.agent = "architect"
    await f.runtime.command(
      {
        requestID: "owner-back",
        planID: f.receipt.planID,
        expectedVersion: 2,
        action: "reassign",
        targetSessionID: "owner",
        reason: "Explicit restore",
      },
      "new-owner",
    )
  }
  const input = { taskID: f.tasks[0]!.id, revision: 1 as const, sessionID: "owner" }
  await expect(f.runtime.startTask(input)).rejects.toThrow("Stale plan version")
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    owner: "owner",
    version: 3,
    state: "draft",
  })
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(0)
  expect(await f.runtime.startTask(input)).toMatchObject({
    planID: f.receipt.planID,
    state: "running",
  })
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
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
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  await drive(reopened)
  expect(f.store.plan(plan.id)?.state).toBe("accepted")
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
})

test("a missing task owner gets a same-project continuation without foreign parent context", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
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
  const attempt = f.store.attempts(result.planID)[0]!
  expect(f.sessions.get(attempt.session_id)?.model).toEqual(selected)

  const noModel = fixture({ shared: true, commit: true, startOnly: true })
  noModel.host.workerModel = async () => undefined
  const noModelTask = noModel.tasks[0]!
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

    await f.runtime.command(
      { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
      "owner",
    )
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

test("a native route failure stays visible and is never retried with a substitute", async () => {
  const selected = { providerID: "custom-provider", id: "selected-model", variant: "max" }
  const f = fixture({ shared: true, workerModel: selected })
  const nativeAttempts: NonNullable<PlanInput["workerModel"]>[] = []
  f.host.create = async (input) => {
    nativeAttempts.push(input.model)
    throw new Error("Native provider rejected selected route")
  }

  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()

  expect(nativeAttempts).toEqual([selected])
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    state: "blocked",
    reason: expect.stringContaining("Native provider rejected selected route"),
  })
  expect(JSON.parse(f.store.attempts(f.receipt.planID)[0]!.policy).model).toEqual(selected)
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
      expectedVersion: 1,
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

test("host-admitted current outcomes follow an archived owner unless transcript consumption is proved", async () => {
  for (const consumed of [false, true]) {
    const f = fixture({
      fail: true,
      shared: true,
      commit: true,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    await runPlan(f)
    await drive(f.runtime)
    const original = f.store.outboxForDelivery()[0]!
    expect(original.state).toBe("admitted")
    if (consumed) {
      f.inbox.set("owner", [])
      f.sessions.get("owner")!.messages.push({
        id: original.message_id,
        type: "synthetic",
        text: "consumed",
        metadata: JSON.parse(original.metadata!),
      })
    }
    f.sessions.get("owner")!.archived = true
    await f.runtime.stop()
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    const reopened = new TaskRuntime(f.store, f.host, "project")
    try {
      await drive(reopened, 3)
      const owner = f.store.plan(f.receipt.planID)!.owner
      expect(owner).not.toBe("owner")
      const row = (f.store.detail(f.receipt.planID).delivery as (typeof original)[])[0]!
      if (consumed) {
        expect(row.state).toBe("consumed")
        expect(f.inbox.get(owner) ?? []).toHaveLength(0)
      } else {
        expect(row.state).toBe("admitted")
        expect(row.session_id).toBe(owner)
        expect(row.message_id).not.toBe(original.message_id)
        expect(f.inbox.get(owner)).toHaveLength(1)
        expect(JSON.parse(row.receipt!).history).toContainEqual(
          expect.objectContaining({
            previousMessageID: original.message_id,
            replacementMessageID: row.message_id,
            priorDeliveryState: "admitted",
          }),
        )
      }
      expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    } finally {
      await reopened.stop()
    }
  }
})

test("an uncertain current outcome follows an adopted owner across reopen without losing admission evidence", async () => {
  const f = fixture({
    fail: true,
    shared: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  const originalNotify = f.host.notify
  let notifyCalls = 0
  f.host.notify = async (input) => {
    notifyCalls++
    await originalNotify(input)
    if (notifyCalls <= 2)
      throw new Error(
        notifyCalls === 1
          ? "native delivery response lost after admission"
          : "replacement delivery response lost after admission",
      )
  }
  const outbox = (store: RunnerStore) =>
    store.detail(f.receipt.planID).delivery as {
      id: string
      session_id: string
      message_id: string
      payload: string
      state: string
      receipt: string | null
    }[]
  for (
    let index = 0;
    index < 20 && !outbox(f.store).some((row) => row.state === "uncertain");
    index++
  )
    await f.runtime.tick()

  const uncertain = outbox(f.store).find((row) => row.state === "uncertain")!
  expect(JSON.parse(uncertain.payload).status).toBe("blocked")
  expect(outbox(f.store)).toHaveLength(1) // no newer status can mask the current-outcome recovery
  expect(f.inbox.get("owner")?.filter((entry) => entry.id === uncertain.message_id)).toHaveLength(1)
  f.sessions.get("owner")!.archived = true

  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const databasePath = f.repository.path
  const projectDirectory = f.repository.projectDirectory
  f.repository.close()
  const reopenedRepository = new TaskRepository(databasePath, projectDirectory)
  const reopenedStore = new RunnerStore(reopenedRepository)
  reopenedStore.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(reopenedStore, f.host, "project")
  await reopened.tick()
  const adoptedPlan = reopenedStore.plan(f.receipt.planID)!
  let current = outbox(reopenedStore)[0]!
  expect(adoptedPlan.owner).not.toBe("owner")
  expect(f.sessions.get(adoptedPlan.owner)?.parentID).toBe("owner")
  expect(f.sessions.get(adoptedPlan.owner)?.agent).toBe("architect")
  expect(current.id).toBe(uncertain.id)
  expect(current.session_id).toBe(adoptedPlan.owner)
  expect(current.message_id).not.toBe(uncertain.message_id)
  const replacementMessageID = current.message_id
  expect(current.state).toBe("uncertain")
  let receiptHistory = JSON.parse(current.receipt!).history as Record<string, unknown>[]
  expect(receiptHistory).toContainEqual(
    expect.objectContaining({
      kind: "native-delivery-uncertain",
      error: "native delivery response lost after admission",
    }),
  )
  expect(receiptHistory).toContainEqual(
    expect.objectContaining({
      kind: "owner-retargeted-current-outcome",
      fromSessionID: "owner",
      toSessionID: adoptedPlan.owner,
      previousMessageID: uncertain.message_id,
      replacementMessageID,
    }),
  )

  await reopened.stop()
  reopenedRepository.close()
  const finalRepository = new TaskRepository(databasePath, projectDirectory)
  const finalStore = new RunnerStore(finalRepository)
  finalStore.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const finalRuntime = new TaskRuntime(finalStore, f.host, "project")
  for (let index = 0; index < 6; index++) await finalRuntime.tick()
  current = outbox(finalStore)[0]!
  expect(current.state).toBe("admitted")
  receiptHistory = JSON.parse(current.receipt!).history as Record<string, unknown>[]
  expect(receiptHistory).toContainEqual(
    expect.objectContaining({
      kind: "native-delivery-uncertain",
      error: "replacement delivery response lost after admission",
    }),
  )
  const successorOutcomes = f.inbox
    .get(adoptedPlan.owner)
    ?.filter((entry) => entry.metadata?.lazersPlanID === f.receipt.planID)
  expect(successorOutcomes).toHaveLength(1)
  expect(successorOutcomes?.[0]?.id).toBe(replacementMessageID)
  expect(current.message_id).toBe(replacementMessageID)
  expect(notifyCalls).toBe(2)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
  expect(finalStore.continuation(f.receipt.planID)?.session_id).toBe(adoptedPlan.owner)
  expect(finalStore.attempts(f.receipt.planID)).toHaveLength(1)
  await finalRuntime.stop()
  finalRepository.close()
})
async function runPlan(
  f: ReturnType<typeof fixture>,
  planID = f.receipt.planID,
  requestID = "run",
) {
  return f.runtime.command(
    {
      requestID,
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "run",
    },
    "owner",
  )
}
async function cancelUnstartedPlan(f: ReturnType<typeof fixture>, planID = f.receipt.planID) {
  await runPlan(f, planID, `run-${planID}`)
  const plan = f.store.plan(planID)!
  await f.runtime.command(
    {
      requestID: `cancel-${planID}`,
      planID,
      expectedVersion: plan.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  return f.store.plan(planID)!
}
async function failSecondSharedTask(f: ReturnType<typeof fixture>) {
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  const attempts = f.store.attempts(f.receipt.planID)
  const predecessor = attempts.find((attempt) => attempt.task_id === f.tasks[0]!.id)!
  const failed = attempts.find((attempt) => attempt.task_id === f.tasks[1]!.id)!
  if (!predecessor.artifact || !failed.artifact)
    throw new Error("Expected predecessor and failed worker artifacts")
  expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
  expect(predecessor.state).toBe("accepted")
  expect(failed.state).toBe("failed")
  expect(failed.base_commit).toBe(predecessor.artifact)
  expect(failed.artifact).toBeTruthy()
  return { predecessor, failed }
}
function attemptCheck(
  f: ReturnType<typeof fixture>,
  taskID: string,
  attemptID: string,
): CheckReceipt {
  const effect = f.store
    .effects(f.receipt.planID)
    .find(
      (candidate) =>
        candidate.task_id === taskID &&
        candidate.attempt_id === attemptID &&
        candidate.kind === "verify:content",
    )
  if (!effect?.receipt) throw new Error(`Missing verification receipt for ${attemptID}`)
  expect(effect.state).toBe("completed")
  return (JSON.parse(effect.receipt) as { check: CheckReceipt }).check
}
const skillBodyCanary = "SECRET_SKILL_BODY_CANARY"
function seedLegacySkillBody(
  f: ReturnType<typeof fixture>,
  attempt: ReturnType<RunnerStore["attempts"]>[number],
) {
  const policy = JSON.parse(attempt.policy) as Record<string, unknown>
  const context = JSON.parse(policy.context as string) as Record<string, unknown>
  const body = [{ id: "legacy-skill", path: "/old/SKILL.md", content: skillBodyCanary }]
  policy.skills = body
  context.skills = body
  policy.context = JSON.stringify(context)
  delete policy.packet
  const serialized = JSON.stringify(policy)
  f.store.atomic((db) =>
    db.query("UPDATE runner_attempts SET policy=? WHERE id=?").run(serialized, attempt.id),
  )
  attempt.policy = serialized
  return serialized
}
function expectNoSkillBody(policyText: string) {
  expect(policyText).not.toContain(skillBodyCanary)
  const policy = JSON.parse(policyText) as Record<string, unknown>
  expect(policy.skills).toBeUndefined()
  expect(JSON.parse(policy.context as string)).not.toHaveProperty("skills")
}

test("real Git worktrees execute a dependency graph, verify combined content and retain origin", async () => {
  const f = fixture()
  expect(f.store.submit(f.input, "owner")).toEqual(f.receipt)
  expect(() => f.store.submit({ ...f.input, objective: "changed" }, "owner")).toThrow(
    "identity conflict",
  )
  expect(() => f.store.submit({ ...f.input, requestID: "second-plan" }, "owner")).toThrow("UNIQUE")
  expect(f.store.execution(f.tasks[1]!.id)?.waitingOn).toEqual([f.tasks[0]!.id])
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.nodes(f.receipt.planID).map((n) => n.state)).toEqual(["accepted", "accepted"])
  expect(f.events.filter((e) => e.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((e) => e.startsWith("prompt:"))).toHaveLength(2)
  expect(f.store.effects(f.receipt.planID).every((e) => e.state === "completed")).toBe(true)
  const plan = f.store.plan(f.receipt.planID)!
  expect(git(f.root, ["show", `${plan.artifact}:a.txt`])).toBe("a")
  expect(git(f.root, ["show", `${plan.artifact}:b.txt`])).toBe("b")
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(f.base)
  expect(readFileSync(join(f.root, "dirty-sentinel.txt"), "utf8")).toBe("preserve me")
  expect(
    f.inbox
      .get("owner")
      ?.some(
        (entry) =>
          entry.metadata &&
          "lazersPlanID" in entry.metadata &&
          entry.metadata.lazersPlanID === plan.id,
      ),
  ).toBe(true)
  const workers = f.store.attempts(plan.id)
  expect(workers[1]!.base_commit).toBe(workers[0]!.artifact!)
  expect(JSON.parse(workers[0]!.policy).packet).toEqual({
    recipe: "task-tool/1",
    taskID: workers[0]!.task_id,
    tool: "lazers_get_task_instructions",
  })
  await drive(f.runtime)
  expect(f.events.filter((e) => e.startsWith("create:"))).toHaveLength(2)
})

test("independent isolated Git branches overlap and combined verification includes every artifact", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()

  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  expect(new Set(attempts.map((attempt) => attempt.workspace)).size).toBe(2)
  expect(attempts.every((attempt) => attempt.base_commit === f.base)).toBe(true)
  expect(attempts.every((attempt) => f.sessions.get(attempt.session_id)?.busy)).toBe(true)
  const starts = f.events
    .map((event, index) => ({ event, index }))
    .filter((entry) => entry.event.startsWith("start:"))
  expect(starts).toHaveLength(2)
  const activity = f.store.detail(f.receipt.planID).activity as {
    id: number
    event: string
    payload: string
  }[]
  const dispatchRecords = activity.filter((entry) => entry.event === "WORKER_STARTED")
  expect(dispatchRecords).toHaveLength(2)
  for (const record of dispatchRecords) {
    const identity = JSON.parse(record.payload)
    expect(
      attempts.some(
        (attempt) =>
          attempt.id === identity.attemptID &&
          attempt.session_id === identity.sessionID &&
          attempt.workspace === identity.workspace,
      ),
    ).toBe(true)
  }

  f.completeWorker(attempts[0]!.session_id)
  await f.runtime.tick()
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual(["accepted", "running"])
  const currentActivity = f.store.detail(f.receipt.planID).activity as {
    id: number
    event: string
    payload: string
  }[]
  const lifetimes = currentActivity.filter((entry) =>
    ["WORKER_STARTED", "WORKER_STOPPED"].includes(entry.event),
  )
  const startsBeforeStop = lifetimes.filter((entry) => entry.event === "WORKER_STARTED")
  const firstStop = lifetimes.find((entry) => entry.event === "WORKER_STOPPED")!
  expect(Math.max(...startsBeforeStop.map((entry) => entry.id))).toBeLessThan(firstStop.id)
  f.completeWorker(attempts[1]!.session_id)
  await drive(f.runtime)

  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.state).toBe("accepted")
  expect(git(f.root, ["show", `${plan.artifact}:a.txt`])).toBe("a")
  expect(git(f.root, ["show", `${plan.artifact}:b.txt`])).toBe("b")
  expect(
    combineArtifacts(
      f.root,
      f.base,
      f.store.nodes(plan.id).map((node) => node.artifact!),
    ),
  ).toBe(plan.artifact!)
  const graphWorkspace = f.store.effects(plan.id).find((effect) => effect.kind === "graph-worktree")
  expect(graphWorkspace?.state).toBe("completed")
  const combinedCheck = f.store
    .effects(plan.id)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(combinedCheck.receipt!).check.artifact).toBe(plan.artifact)
  expect(JSON.parse(combinedCheck.receipt!).check.exitCode).toBe(0)
})

test("dependencies wait for accepted inputs and wildcard ancestor scopes serialize", async () => {
  const dependent = fixture({ delayed: true })
  await runPlan(dependent)
  await dependent.runtime.tick()
  expect(dependent.store.attempts(dependent.receipt.planID)).toHaveLength(1)
  expect(dependent.store.execution(dependent.tasks[1]!.id)?.waitingOn).toEqual([
    dependent.tasks[0]!.id,
  ])
  const predecessor = dependent.store.attempts(dependent.receipt.planID)[0]!
  dependent.completeWorker(predecessor.session_id)
  await dependent.runtime.tick()
  expect(dependent.store.attempts(dependent.receipt.planID)).toHaveLength(2)
  const successor = dependent.store.attempts(dependent.receipt.planID)[1]!
  expect(successor.base_commit).toBe(
    dependent.store.attempts(dependent.receipt.planID)[0]!.artifact!,
  )
  expect(dependent.events.indexOf(`stop:${predecessor.session_id}`)).toBeLessThan(
    dependent.events.indexOf(`start:${successor.session_id}`),
  )
  dependent.completeWorker(successor.session_id)
  await drive(dependent.runtime)
  expect(dependent.store.plan(dependent.receipt.planID)!.state).toBe("accepted")

  const scopes = fixture({
    independent: true,
    delayed: true,
    allowScopeOverlap: true,
    taskFiles: [
      { name: "a", path: "src/a.txt", scope: ["src/**"] },
      { name: "b", path: "src/b/b.txt", scope: ["src/b/**"] },
    ],
  })
  await runPlan(scopes)
  await scopes.runtime.tick()
  expect(scopes.store.attempts(scopes.receipt.planID)).toHaveLength(1)
  const first = scopes.store.attempts(scopes.receipt.planID)[0]!
  scopes.completeWorker(first.session_id)
  await scopes.runtime.tick()
  await scopes.runtime.tick()
  const second = scopes.store.attempts(scopes.receipt.planID)[1]!
  expect(second.base_commit).toBe(scopes.base)
  expect(scopes.events.indexOf(`stop:${first.session_id}`)).toBeLessThan(
    scopes.events.indexOf(`start:${second.session_id}`),
  )
  scopes.completeWorker(second.session_id)
  await drive(scopes.runtime)
  expect(scopes.store.plan(scopes.receipt.planID)!.state).toBe("accepted")
})

test("independent plans overlap while a second reconciler cannot duplicate dispatch", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: [{ name: "a", path: "src/a.txt", scope: ["src/**"] }],
  })
  const taskB = f.createTask("b", "src/b/b.txt", ["src/b/**"])
  const planBInput = {
    ...f.inputFor([taskB], { requestID: "plan-b" }),
    dispositions: [
      {
        taskID: taskB.id,
        otherTaskID: f.tasks[0]!.id,
        relation: "supplements" as const,
        rationale: "Serialize overlapping source scopes across plans.",
      },
    ],
  }
  const planB = f.store.submit(planBInput, "owner")
  const taskC = f.createTask("c", "other/c.txt")
  const planC = f.store.submit(f.inputFor([taskC], { requestID: "plan-c" }), "owner")
  await runPlan(f, f.receipt.planID, "run-a")
  await runPlan(f, planB.planID, "run-b")
  await runPlan(f, planC.planID, "run-c")

  const secondReconciler = new TaskRuntime(f.store, f.host, "project")
  try {
    await Promise.all([f.runtime.tick(), secondReconciler.tick()])
    const attemptsA = f.store.attempts(f.receipt.planID)
    const attemptsB = f.store.attempts(planB.planID)
    const attemptsC = f.store.attempts(planC.planID)
    expect(attemptsA).toHaveLength(1)
    expect(attemptsB).toHaveLength(0)
    expect(attemptsC).toHaveLength(1)
    expect(attemptsA[0]!.workspace).not.toBe(attemptsC[0]!.workspace)
    expect(f.sessions.get(attemptsA[0]!.session_id)?.busy).toBe(true)
    expect(f.sessions.get(attemptsC[0]!.session_id)?.busy).toBe(true)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
    secondReconciler.stop()

    f.completeWorker(attemptsA[0]!.session_id)
    await f.runtime.tick()
    const attemptsBAfterA = f.store.attempts(planB.planID)
    expect(attemptsBAfterA).toHaveLength(1)
    expect(f.sessions.get(attemptsBAfterA[0]!.session_id)?.busy).toBe(true)
    expect(f.events.indexOf(`stop:${attemptsA[0]!.session_id}`)).toBeLessThan(
      f.events.indexOf(`start:${attemptsBAfterA[0]!.session_id}`),
    )

    f.completeWorker(attemptsBAfterA[0]!.session_id)
    f.completeWorker(attemptsC[0]!.session_id)
    await drive(f.runtime)
    expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
    expect(f.store.plan(planB.planID)!.state).toBe("accepted")
    expect(f.store.plan(planC.planID)!.state).toBe("accepted")
  } finally {
    secondReconciler.stop()
  }
})

test("single-task acceptance coalesces its task handoff while another plan worker stays active", async () => {
  const f = fixture({ independent: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const b = f.createTask("b", "other/b.txt")
  const planB = f.store.submit(f.inputFor([b], { requestID: "other-plan" }), "owner")
  const notifications: Parameters<RunnerHost["notify"]>[0][] = []
  const notify = f.host.notify
  f.host.notify = async (input) => {
    notifications.push(input)
    await notify(input)
  }
  f.sessions.get("owner")!.busy = true
  await runPlan(f)
  await runPlan(f, planB.planID, "run-other")
  await f.runtime.tick()
  const a = f.store.attempts(f.receipt.planID)[0]!
  const other = f.store.attempts(planB.planID)[0]!
  f.completeWorker(a.session_id)
  await f.runtime.tick()
  expect(f.sessions.get(other.session_id)?.busy).toBe(true)
  expect(f.store.plan(planB.planID)?.state).toBe("running")
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  const combined = notifications.find((input) => input.text.includes('"status":"accepted"'))!
  expect(combined.resume).toBe(true)
  expect(combined.text).toContain("Review and merge")
  expect(notifications.some((input) => input.text.includes('"status":"task-accepted"'))).toBe(false)
  const delivery = f.store.detail(f.receipt.planID).delivery as {
    payload: string
    state: string
    metadata: string
  }[]
  expect(delivery).toHaveLength(2)
  expect(delivery.find((row) => JSON.parse(row.payload).status === "task-accepted")?.state).toBe(
    "superseded",
  )
  expect(delivery.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe(
    "admitted",
  )
  expect(
    f.inbox
      .get("owner")
      ?.filter(
        (entry) =>
          entry.metadata &&
          "lazersPlanID" in entry.metadata &&
          entry.metadata.lazersPlanID === f.receipt.planID,
      ),
  ).toHaveLength(1)
  const ids = notifications.map((input) => input.id)
  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  await reopened.tick()
  expect(notifications.map((input) => input.id)).toEqual(ids)
  f.completeWorker(other.session_id)
  await drive(reopened)
})

test("a late older retry cannot replace a newer queued plan outcome", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const notifications: Parameters<RunnerHost["notify"]>[0][] = []
  const notify = f.host.notify
  f.host.notify = async (input) => {
    notifications.push(input)
    await notify(input)
  }
  f.sessions.get("owner")!.busy = true
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id)
  await f.runtime.tick()

  const plan = f.store.plan(f.receipt.planID)!
  const current = f.store
    .outboxForDelivery()
    .find((row) => row.plan_id === plan.id && JSON.parse(row.payload).status === "accepted")!
  const oldVersion = current.version - 1
  const oldPayload = {
    planID: plan.id,
    planRevision: plan.revision,
    version: oldVersion,
    status: "task-accepted",
    taskID: f.tasks[0]!.id,
  }
  const metadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: "project",
    lazersProjectDirectory: f.repository.projectDirectory,
    lazersPlanID: plan.id,
    lazersOutboxID: "late-old-outbox",
    lazersMessageID: "msg_late_old_outcome",
    lazersSessionID: plan.owner,
    lazersStatus: "task-accepted",
    lazersVersion: oldVersion,
  }
  f.store.atomic((db) =>
    db
      .query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',1,?,NULL)",
      )
      .run(
        "late-old-outbox",
        plan.id,
        plan.owner,
        "msg_late_old_outcome",
        JSON.stringify(oldPayload),
        JSON.stringify(metadata),
      ),
  )

  await f.runtime.tick()

  const rows = f.store.detail(plan.id).delivery as {
    id: string
    payload: string
    state: string
  }[]
  expect(rows.find((row) => row.id === "late-old-outbox")?.state).toBe("superseded")
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("admitted")
  expect(notifications.some((notice) => notice.id === "msg_late_old_outcome")).toBe(false)
  expect(
    f.inbox
      .get(plan.owner)
      ?.filter((entry) => entry.metadata?.lazersPlanID === plan.id)
      .map((entry) => entry.metadata?.lazersStatus),
  ).toEqual(["accepted"])
})

test("an actionable partial-task outcome wakes review while its sibling worker remains active", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  f.sessions.get("owner")!.busy = true
  f.completeWorker(attempts[0]!.session_id)
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("running")
  expect(f.sessions.get(attempts[1]!.session_id)?.busy).toBe(true)
  const partial = f.inbox
    .get("owner")
    ?.filter(
      (entry) =>
        entry.metadata &&
        "lazersPlanID" in entry.metadata &&
        entry.metadata.lazersPlanID === f.receipt.planID,
    )
  expect(partial).toHaveLength(1)
  expect(partial?.[0]?.metadata?.lazersStatus).toBe("task-accepted")
  expect(f.events.some((event) => event === `notify:${partial?.[0]?.id}`)).toBe(true)
})

test("a newer partial result carries all prior reviewable artifacts while a third worker remains active", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: ["a", "b", "c"].map((name) => ({ name, path: `${name}.txt` })),
  })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  const notify = f.host.notify
  let lost = true
  f.host.notify = async (input) => {
    await notify(input)
    if (lost) throw new Error("Lost first partial admission response")
  }
  f.completeWorker(attempts[0]!.session_id)
  await f.runtime.tick()
  expect(f.store.outboxForDelivery()[0]!.state).toBe("uncertain")
  lost = false
  f.completeWorker(attempts[1]!.session_id)
  await f.runtime.tick()
  const rows = f.store.detail(f.receipt.planID).delivery as { state: string; payload: string }[]
  expect(rows[0]!.state).toBe("superseded")
  expect(rows[1]!.state).toBe("admitted")
  const payload = JSON.parse(rows[1]!.payload)
  expect(payload.status).toBe("task-accepted")
  expect(payload.currentPlan.state).toBe("running")
  expect(payload.reviewableTasks.map((task: { taskID: string }) => task.taskID)).toEqual(
    f.tasks.slice(0, 2).map((task) => task.id),
  )
  expect(
    payload.reviewableTasks.every(
      (task: { artifact: string; attemptID: string }) => task.artifact && task.attemptID,
    ),
  ).toBe(true)
  expect(f.sessions.get(attempts[2]!.session_id)!.busy).toBe(true)
  expect(f.inbox.get("owner")).toHaveLength(1)
})

test("legacy partial notices for distinct tasks cannot silently replace one another", async () => {
  const f = fixture()
  for (const [index, task] of f.tasks.entries()) {
    const payload = {
      planID: f.receipt.planID,
      version: index + 1,
      status: "task-accepted",
      taskID: task.id,
      artifact: `artifact-${index}`,
    }
    f.store.atomic((db) =>
      db
        .query(
          "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,?,?,?,'pending',1)",
        )
        .run(
          `partial-${index}`,
          f.receipt.planID,
          "owner",
          `msg_partial_${index}`,
          JSON.stringify(payload),
        ),
    )
  }
  await f.runtime.tick()
  expect(
    (f.store.detail(f.receipt.planID).delivery as { state: string }[]).map((row) => row.state),
  ).toEqual(["admitted", "admitted"])
  expect(f.inbox.get("owner")).toHaveLength(2)
})

test("failed cancellation keeps the newer outcome pending and retries after the queue race clears", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  f.sessions.get("owner")!.busy = true
  f.completeWorker(attempts[0]!.session_id)
  await f.runtime.tick()
  const prior = f.inbox
    .get("owner")!
    .find((entry) => entry.metadata?.lazersPlanID === f.receipt.planID)!
  const cancel = f.host.cancelOutcome!
  let fail = true
  f.host.cancelOutcome = async (input) => {
    if (fail) throw new Error("native lifecycle conflict")
    await cancel(input)
  }

  f.completeWorker(attempts[1]!.session_id)
  await f.runtime.tick()
  let rows = f.store.detail(f.receipt.planID).delivery as {
    payload: string
    state: string
    receipt: string | null
  }[]
  expect(rows.find((row) => JSON.parse(row.payload).status === "task-accepted")?.state).toBe(
    "admitted",
  )
  const current = rows.find((row) => JSON.parse(row.payload).status === "accepted")!
  expect(current.state).toBe("pending")
  expect(
    JSON.parse(rows.find((row) => JSON.parse(row.payload).status === "task-accepted")!.receipt!)
      .history,
  ).toContainEqual(expect.objectContaining({ kind: "cancellation-failed-still-queued" }))
  expect(f.inbox.get("owner")?.some((entry) => entry.id === prior.id)).toBe(true)

  fail = false
  await f.runtime.tick()
  rows = f.store.detail(f.receipt.planID).delivery as typeof rows
  expect(rows.find((row) => JSON.parse(row.payload).status === "task-accepted")?.state).toBe(
    "superseded",
  )
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("admitted")
  expect(
    f.inbox.get("owner")?.filter((entry) => entry.metadata?.lazersPlanID === f.receipt.planID),
  ).toHaveLength(1)
})

test("an unavailable native inbox cannot be reported as successful supersession", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  f.sessions.get("owner")!.busy = true
  f.completeWorker(attempts[0]!.session_id)
  await f.runtime.tick()
  const listInbox = f.host.outcomeInbox
  f.host.outcomeInbox = async () => {
    throw new Error("native host unavailable")
  }

  f.completeWorker(attempts[1]!.session_id)
  await f.runtime.tick()
  let rows = f.store.detail(f.receipt.planID).delivery as {
    payload: string
    state: string
    receipt: string | null
  }[]
  const older = rows.find((row) => JSON.parse(row.payload).status === "task-accepted")!
  expect(older.state).toBe("admitted")
  expect(JSON.parse(older.receipt!).history).toContainEqual(
    expect.objectContaining({ kind: "supersession-observation-unavailable" }),
  )
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("pending")
  expect(
    f.inbox.get("owner")?.filter((entry) => entry.metadata?.lazersPlanID === f.receipt.planID),
  ).toHaveLength(1)

  f.host.outcomeInbox = listInbox
  await f.runtime.tick()
  rows = f.store.detail(f.receipt.planID).delivery as typeof rows
  expect(rows.find((row) => JSON.parse(row.payload).status === "task-accepted")?.state).toBe(
    "superseded",
  )
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("admitted")
})

test("a cancellation that races with transcript consumption is recorded as consumed, not suppressed", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  f.sessions.get("owner")!.busy = true
  f.completeWorker(attempts[0]!.session_id)
  await f.runtime.tick()
  const cancel = f.host.cancelOutcome
  f.host.cancelOutcome = async (input) => {
    const entries = f.inbox.get(input.sessionID) ?? []
    const index = entries.findIndex((entry) => entry.id === input.inboxID)
    if (index >= 0) entries.splice(index, 1)
    f.sessions.get(input.sessionID)!.messages.push({
      id: input.inboxID,
      text: "Consumed native outcome",
      type: "synthetic",
      metadata: input.ownership,
    })
    throw new Error("cancel lost a race with consumption")
  }
  f.completeWorker(attempts[1]!.session_id)
  await f.runtime.tick()
  const rows = f.store.detail(f.receipt.planID).delivery as {
    payload: string
    state: string
    receipt: string | null
  }[]
  const partial = rows.find((row) => JSON.parse(row.payload).status === "task-accepted")!
  expect(partial.state).toBe("consumed")
  expect(JSON.parse(partial.receipt!).history).toContainEqual(
    expect.objectContaining({ kind: "cancel-raced-with-consumption" }),
  )
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("admitted")
  expect(
    f.inbox.get("owner")?.filter((entry) => entry.metadata?.lazersPlanID === f.receipt.planID),
  ).toHaveLength(1)
  f.host.cancelOutcome = cancel
})

test("a successful native cancel response is rechecked before recording supersession", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  f.sessions.get("owner")!.busy = true
  f.completeWorker(attempts[0]!.session_id)
  await f.runtime.tick()
  f.host.cancelOutcome = async (input) => {
    const entries = f.inbox.get(input.sessionID) ?? []
    const index = entries.findIndex((entry) => entry.id === input.inboxID)
    if (index >= 0) entries.splice(index, 1)
    f.sessions.get(input.sessionID)!.messages.push({
      id: input.inboxID,
      text: "Consumed while cancellation completed",
      type: "synthetic",
      metadata: input.ownership,
    })
  }

  f.completeWorker(attempts[1]!.session_id)
  await f.runtime.tick()
  const rows = f.store.detail(f.receipt.planID).delivery as {
    payload: string
    state: string
    receipt: string | null
  }[]
  const partial = rows.find((row) => JSON.parse(row.payload).status === "task-accepted")!
  expect(partial.state).toBe("consumed")
  expect(JSON.parse(partial.receipt!).history).toContainEqual(
    expect.objectContaining({ kind: "consumption-observed-after-cancel" }),
  )
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("admitted")
  expect(
    f.inbox.get("owner")?.filter((entry) => entry.metadata?.lazersPlanID === f.receipt.planID),
  ).toHaveLength(1)
})

test("completed shared plan verifies its exact artifact without touching an advanced shared checkout", async () => {
  const f = fixture({ shared: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const move = f.store.move.bind(f.store)
  let advanced = ""
  f.store.move = (planID, taskID, event, reason) => {
    const result = move(planID, taskID, event, reason)
    if (event === "ACCEPT") {
      writeFileSync(join(f.root, "reviewed-later.txt"), "keep\n")
      git(f.root, ["add", "reviewed-later.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Later reviewed work",
      ])
      advanced = git(f.root, ["rev-parse", "HEAD"])
    }
    return result
  }
  await runPlan(f)
  await drive(f.runtime)
  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.state).toBe("accepted")
  expect(plan.artifact).not.toBe(advanced)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(advanced)
  expect(readFileSync(join(f.root, "reviewed-later.txt"), "utf8")).toBe("keep\n")
  const effect = f.store.effects(plan.id).find((entry) => entry.kind === "graph-worktree")!
  expect(effect.state).toBe("completed")
  const workspace = JSON.parse(effect.receipt!).workspace
  expect(workspace).not.toBe(f.root)
  expect(git(workspace, ["rev-parse", "HEAD"])).toBe(plan.artifact!)
  const check = f.store.effects(plan.id).find((entry) => entry.kind === "graph-verify:combined")!
  expect(JSON.parse(check.receipt!).check).toMatchObject({
    cwd: workspace,
    artifact: plan.artifact,
    unchanged: true,
    exitCode: 0,
  })
})

test("shared resume waits for another plan's worker and cancellation retains final usage", async () => {
  const f = fixture({ shared: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const a = f.store.attempts(f.receipt.planID)[0]!
  Object.assign(f.sessions.get(a.session_id)!, { tokens: 777, tools: 45, cost: 3 })
  await f.runtime.command(
    {
      requestID: "cancel-a",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
    token_count: 777,
    tool_count: 45,
    cost: 3,
  })
  const b = f.createTask("b", "b.txt")
  const planB = f.store.submit(f.inputFor([b], { requestID: "shared-b" }), "owner")
  await runPlan(f, planB.planID, "run-b")
  await f.runtime.tick()
  const other = f.store.attempts(planB.planID)[0]!
  expect(f.sessions.get(other.session_id)?.busy).toBe(true)
  await f.runtime.command(
    {
      requestID: "resume-a",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "resume",
      taskID: a.task_id,
      workspaceMode: "shared",
      reason: "Continue retained shared work",
    },
    "owner",
  )
  const prompts = f.events.filter((event) => event.startsWith("prompt:")).length
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(prompts)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("preparing")
  f.completeWorker(other.session_id)
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(prompts + 1)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  f.completeWorker(a.session_id)
  await drive(f.runtime)
})

test("reconciliation retains legacy advanced-checkout receipts and verifies the exact artifact afresh", async () => {
  const f = fixture({ shared: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const move = f.store.move.bind(f.store)
  let legacyID = ""
  f.store.move = (planID, taskID, event, reason) => {
    const result = move(planID, taskID, event, reason)
    if (event === "ACCEPT") {
      const artifact = f.store.attempts(planID)[0]!.artifact!
      writeFileSync(join(f.root, "later.txt"), "preserve\n")
      git(f.root, ["add", "later.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Later reviewed work",
      ])
      const check = f.input.verification[0]!
      legacyID = crypto.randomUUID()
      f.store.atomic((db) => {
        db.query("INSERT INTO runner_effects VALUES(?,?,NULL,NULL,?,'completed',?,?,1)").run(
          legacyID,
          planID,
          `graph-verify:${check.id}`,
          JSON.stringify({
            workspace: f.root,
            artifact,
            identity: artifact,
            check,
            receiptPath: "legacy-receipt.json",
          }),
          JSON.stringify({
            check: {
              id: check.id,
              command: check.command,
              cwd: f.root,
              artifact,
              exitCode: 0,
              timedOut: false,
              unchanged: false,
            },
          }),
        )
        db.query(
          "UPDATE runner_plans SET state='blocked',reason='Combined artifact verification failed',version=version+1 WHERE id=?",
        ).run(planID)
      })
    }
    return result
  }
  await runPlan(f)
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  await f.runtime.command(
    {
      requestID: "reconcile-legacy",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  const effects = f.store
    .effects(f.receipt.planID)
    .filter((effect) => effect.kind === "graph-verify:combined")
  expect(effects).toHaveLength(2)
  expect(effects.find((effect) => effect.id === legacyID)?.state).toBe("completed")
  expect(
    JSON.parse(effects.find((effect) => effect.id === legacyID)!.receipt!).check.unchanged,
  ).toBe(false)
  const fresh = JSON.parse(effects.find((effect) => effect.id !== legacyID)!.receipt!).check
  expect(fresh).toMatchObject({
    artifact: f.store.plan(f.receipt.planID)!.artifact!,
    unchanged: true,
    exitCode: 0,
  })
  expect(fresh.cwd).not.toBe(f.root)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(readFileSync(join(f.root, "later.txt"), "utf8")).toBe("preserve\n")
})

test("explicit reconcile retries conclusive combined checks after environment repair without erasing evidence", async () => {
  const f = fixture({
    shared: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    requireVerifierPreparation: true,
  })
  await runPlan(f)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  const checks = () =>
    f.store.effects(f.receipt.planID).filter((effect) => effect.kind === "graph-verify:combined")
  expect(checks()).toHaveLength(1)
  const failed = checks()[0]!
  expect(JSON.parse(failed.receipt!).check.exitCode).toBe(1)
  await drive(f.runtime)
  expect(checks()).toHaveLength(1)
  writeFileSync(join(dirname(f.repository.path), "verifier-ready"), "prepared\n")
  const command = {
    requestID: "reconcile-prepared-verifier",
    planID: f.receipt.planID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    action: "reconcile",
    reason: "Repair verifier prerequisites, not implementation",
  }
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(checks()).toHaveLength(2)
  expect(checks().find((effect) => effect.id === failed.id)?.receipt).toBe(failed.receipt)
  const fresh = checks().find((effect) => effect.id !== failed.id)!
  expect(JSON.parse(fresh.payload).verificationEpoch).toBeGreaterThan(0)
  expect(JSON.parse(fresh.receipt!).check).toMatchObject({ exitCode: 0, unchanged: true })
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test("uncertain prompt cannot prevent cancellation of an admitted sibling", async () => {
  const f = fixture({ independent: true, delayed: true })
  const detailedSessionIDs: string[] = []
  const session = f.host.session
  f.host.session = async (id, options) => {
    if (options?.messages) detailedSessionIDs.push(id)
    return session(id, options)
  }
  const prompt = f.host.prompt
  let release!: () => void
  const admitted = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.prompt = async (input) => {
    const attempt = f.store
      .attempts(f.receipt.planID)
      .find((entry) => entry.session_id === input.sessionID)!
    if (attempt.task_id === f.tasks[0]!.id) {
      await admitted
      throw new Error("Prompt admission response unknown")
    }
    await prompt(input)
    release()
  }
  await runPlan(f)
  await f.runtime.tick()
  const b = f.store.attempts(f.receipt.planID).find((entry) => entry.task_id === f.tasks[1]!.id)!
  expect(f.sessions.get(b.session_id)?.busy).toBe(true)
  await f.runtime.command(
    {
      requestID: "cancel-uncertain",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.events).toContain(`stop:${b.session_id}`)
  expect(f.sessions.get(b.session_id)?.busy).toBe(false)
  expect(f.store.attempts(f.receipt.planID).find((entry) => entry.id === b.id)?.state).toBe(
    "cancelled",
  )
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
  expect(
    f.store
      .effects(f.receipt.planID)
      .some((effect) => effect.kind === "prompt" && effect.state === "uncertain"),
  ).toBe(true)
  expect(detailedSessionIDs).toContain(b.session_id)
})

test("two conflicting shared resumes use current prompt identities and cannot deadlock", async () => {
  const f = fixture({ shared: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const a = f.store.attempts(f.receipt.planID)[0]!
  await f.runtime.command(
    {
      requestID: "cancel-old-a",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await drive(f.runtime, 2)
  const b = f.createTask("b", "b.txt")
  const planB = f.store.submit(f.inputFor([b], { requestID: "second-shared" }), "owner")
  await runPlan(f, planB.planID, "run-old-b")
  await f.runtime.tick()
  const other = f.store.attempts(planB.planID)[0]!
  await f.runtime.command(
    {
      requestID: "cancel-old-b",
      planID: planB.planID,
      expectedVersion: f.store.plan(planB.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await drive(f.runtime, 2)
  for (const [planID, taskID] of [
    [f.receipt.planID, a.task_id],
    [planB.planID, other.task_id],
  ])
    await f.runtime.command(
      {
        requestID: `resume-${taskID}`,
        planID,
        expectedVersion: f.store.plan(planID!)!.version,
        action: "resume",
        taskID,
        workspaceMode: "shared",
        reason: "Continue stopped work",
      },
      "owner",
    )
  const count = f.events.filter((event) => event.startsWith("prompt:")).length
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(count + 1)
  const active = [a.session_id, other.session_id].filter((id) => f.sessions.get(id)?.busy)
  expect(active).toHaveLength(1)
  f.completeWorker(active[0]!)
  await drive(f.runtime, 2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(count + 2)
  const remaining = [a.session_id, other.session_id].filter((id) => f.sessions.get(id)?.busy)
  expect(remaining).toHaveLength(1)
  f.completeWorker(remaining[0]!)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.plan(planB.planID)?.state).toBe("accepted")
})

test("combined worktree completion cannot overwrite a concurrent cancellation", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  for (const attempt of f.store.attempts(f.receipt.planID)) f.completeWorker(attempt.session_id)
  const create = f.host.worktree
  f.host.worktree = async (input) => {
    const actual = await create(input)
    await f.runtime.command(
      {
        requestID: "cancel-during-combine",
        planID: f.receipt.planID,
        expectedVersion: f.store.plan(f.receipt.planID)!.version,
        action: "cancel",
      },
      "owner",
    )
    return actual
  }
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
  expect(f.store.plan(f.receipt.planID)?.artifact).toBeNull()
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("graph-verify:")),
  ).toBe(false)
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
})

test("one failed branch blocks combined acceptance without losing sibling verification or usage", async () => {
  const f = fixture({ independent: true, delayed: true, fail: true })
  await runPlan(f)
  await f.runtime.tick()
  const [first, second] = f.store.attempts(f.receipt.planID)
  if (!first || !second) throw new Error("Expected two isolated workers")
  f.completeWorker(first.session_id)
  f.completeWorker(second.session_id)
  await f.runtime.tick()

  expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual(["failed", "accepted"])
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.token_count)).toEqual([
    100, 100,
  ])
  expect(attemptCheck(f, first.task_id, first.id).exitCode).toBe(7)
  expect(attemptCheck(f, second.task_id, second.id).exitCode).toBe(0)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("graph-verify:")),
  ).toBe(false)
})

test("conflicting accepted branches hold integration and preserve both real Git artifacts", async () => {
  const f = fixture({
    independent: true,
    allowScopeOverlap: true,
    taskFiles: [
      { name: "a", path: "shared.txt", scope: ["shared.txt"] },
      { name: "b", path: "shared.txt", scope: ["shared.txt"] },
    ],
  })
  await runPlan(f)
  await drive(f.runtime)

  const plan = f.store.plan(f.receipt.planID)!
  const nodes = f.store.nodes(plan.id)
  expect(plan.state).toBe("blocked")
  expect(plan.reason).toContain("Conflicting accepted artifacts")
  expect(nodes.map((node) => node.state)).toEqual(["accepted", "accepted"])
  expect(nodes.every((node) => node.artifact)).toBe(true)
  expect(git(f.root, ["show", `${nodes[0]!.artifact}:shared.txt`])).toBe("a")
  expect(git(f.root, ["show", `${nodes[1]!.artifact}:shared.txt`])).toBe("b")
  expect(f.store.attempts(plan.id).every((attempt) => existsSync(attempt.workspace))).toBe(true)
  expect(
    f.store
      .effects(plan.id)
      .filter((effect) => effect.kind.startsWith("verify:"))
      .every((e) => e.state === "completed"),
  ).toBe(true)
  expect(f.store.effects(plan.id).some((effect) => effect.kind.startsWith("graph-verify:"))).toBe(
    false,
  )
})

test("lost worktree creation response resumes its own blocked startup after reconciliation", async () => {
  for (const response of [true, "empty-error"] as const) {
    const f = fixture({
      independent: true,
      delayed: true,
      loseWorktreeResponse: response,
    })
    await runPlan(f)
    await f.runtime.tick()
    const effect = f.store.effects(f.receipt.planID).find((item) => item.kind === "worktree")!
    expect(effect.state).toBe("uncertain")
    expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
    expect(f.store.plan(f.receipt.planID)!.reason).toContain(
      response === "empty-error" ? ": Error" : ": worktree response lost",
    )
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
    expect(f.store.attempts(f.receipt.planID).every((item) => item.state === "preparing")).toBe(
      true,
    )
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(0)

    f.runtime.stop()
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    const reopened = new TaskRuntime(f.store, f.host, "project")
    try {
      await reopened.tick()
      expect(f.store.effects(f.receipt.planID).find((item) => item.id === effect.id)?.state).toBe(
        "completed",
      )
      expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
      expect(f.store.attempts(f.receipt.planID).every((item) => item.state === "preparing")).toBe(
        true,
      )

      await reopened.tick()
      expect(f.store.attempts(f.receipt.planID).every((item) => item.state === "running")).toBe(
        true,
      )
      expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
      expect(await f.host.worktrees()).toHaveLength(3)
      expect(
        f.store.latestTransition<{ effectID: string }>(
          f.receipt.planID,
          null,
          "WORKTREE_RECOVERY_RESUMED",
        ),
      ).toMatchObject({ effectID: effect.id })
      for (const worker of f.store.attempts(f.receipt.planID)) f.completeWorker(worker.session_id)
      await drive(reopened)
      expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
    } finally {
      reopened.stop()
    }
  }
})

test("a different block reason keeps a reconciled worktree startup blocked", async () => {
  const f = fixture({
    delayed: true,
    loseWorktreeResponse: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const effect = f.store.effects(planID).find((item) => item.kind === "worktree")!
  f.store.atomic((db) =>
    db.query("UPDATE runner_plans SET reason=? WHERE id=?").run("Unrelated blocked reason", planID),
  )

  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  try {
    await reopened.tick()
    expect(f.store.effects(planID).find((item) => item.id === effect.id)?.state).toBe("completed")
    expect(f.store.plan(planID)).toMatchObject({
      state: "blocked",
      reason: "Unrelated blocked reason",
    })
    await reopened.tick()
    expect(f.store.attempts(planID).every((item) => item.state === "cancelled")).toBe(true)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(0)
  } finally {
    reopened.stop()
  }
})

test("cancelling overlapping workers waits for every native session and preserves usage", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  for (const attempt of attempts) f.sessions.get(attempt.session_id)!.tokens = 123
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.token_count)).toEqual([
    123, 123,
  ])

  await f.runtime.command(
    {
      requestID: "cancel-parallel",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cancelling")
  expect(f.store.attempts(f.receipt.planID).every((attempt) => attempt.state === "running")).toBe(
    true,
  )
  await f.runtime.tick()

  expect(f.store.plan(f.receipt.planID)!.state).toBe("cancelled")
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual([
    "cancelled",
    "cancelled",
  ])
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.state)).toEqual([
    "cancelled",
    "cancelled",
  ])
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.token_count)).toEqual([
    123, 123,
  ])
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("graph-verify:")),
  ).toBe(false)
})

test("reviewed combined merge removes only owned Git worktrees and preserves foreign work", async () => {
  const f = fixture({ independent: true, commit: true })
  const foreignPath = join(tmpdir(), `lazers-foreign-${crypto.randomUUID()}`)
  git(f.root, ["worktree", "add", "--detach", foreignPath, f.base])
  const foreign = realpathSync(foreignPath)
  try {
    await runPlan(f)
    await drive(f.runtime)
    const artifact = f.store.plan(f.receipt.planID)!.artifact!
    const acceptedInbox = f.inbox
      .get("owner")!
      .find(
        (entry) =>
          entry.metadata &&
          "lazersPlanID" in entry.metadata &&
          entry.metadata.lazersPlanID === f.receipt.planID,
      )!
    expect(acceptedInbox.metadata?.lazersStatus).toBe("accepted")
    f.inbox.get("owner")!.push(
      { id: "msg_user_keep", type: "user", delivery: "queue" },
      {
        id: "msg_worker_keep",
        type: "synthetic",
        delivery: "queue",
        metadata: { lazersKind: "worker-prompt", lazersMessageID: "msg_worker_keep" },
      },
      {
        id: "msg_foreign_keep",
        type: "synthetic",
        delivery: "queue",
        metadata: {
          ...acceptedInbox.metadata,
          lazersPlanID: "foreign-plan",
          lazersOutboxID: "foreign-outbox",
          lazersMessageID: "msg_foreign_keep",
        },
      },
    )
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind === "graph-worktree"),
    ).toBe(true)
    git(f.root, ["merge", "--ff-only", artifact])
    await f.runtime.command(
      {
        requestID: "integrate-parallel",
        planID: f.receipt.planID,
        expectedVersion: f.store.plan(f.receipt.planID)!.version,
        action: "integrated",
        artifact,
        targetBranch: "main",
        reason: "Reviewed every branch and the combined checks",
      },
      "owner",
    )
    await f.runtime.tick()

    expect(f.store.plan(f.receipt.planID)!.state).toBe("integrated")
    const outbox = f.store.detail(f.receipt.planID).delivery as {
      payload: string
      state: string
      message_id: string
    }[]
    expect(outbox.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe(
      "superseded",
    )
    expect(outbox.find((row) => JSON.parse(row.payload).status === "integrated")?.state).toBe(
      "admitted",
    )
    expect(f.inbox.get("owner")?.map((entry) => entry.id)).toEqual([
      "msg_user_keep",
      "msg_worker_keep",
      "msg_foreign_keep",
      outbox.find((row) => JSON.parse(row.payload).status === "integrated")!.message_id,
    ])
    const removals = f.store
      .effects(f.receipt.planID)
      .filter((effect) => effect.kind === "worktree-remove")
    expect(removals).toHaveLength(3)
    expect(removals.every((effect) => JSON.parse(effect.receipt!).native === true)).toBe(true)
    expect(await f.host.worktrees()).toEqual([f.root, foreign])
  } finally {
    if (existsSync(foreign)) git(f.root, ["worktree", "remove", foreign])
  }
})

test("repairing one parallel branch retains its failed check and usage while its sibling is accepted", async () => {
  const f = fixture({ independent: true, delayed: true, wrongFirstA: true, repair: true })
  await runPlan(f)
  await f.runtime.tick()
  const initial = f.store.attempts(f.receipt.planID)
  f.completeWorker(initial[0]!.session_id)
  f.completeWorker(initial[1]!.session_id)
  await f.runtime.tick()
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual(["running", "accepted"])
  expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
  expect(attemptCheck(f, initial[0]!.task_id, initial[0]!.id).exitCode).not.toBe(0)

  await f.runtime.tick()
  const repaired = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === initial[0]!.task_id)
    .at(-1)!
  expect(
    f.store.attempts(f.receipt.planID).filter((attempt) => attempt.task_id === repaired.task_id),
  ).toHaveLength(2)
  f.completeWorker(repaired.session_id)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  const attempts = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === repaired.task_id)
  expect(attempts[0]!.token_count).toBe(100)
  expect(attemptCheck(f, attempts[0]!.task_id, attempts[0]!.id).exitCode).not.toBe(0)
  expect(attemptCheck(f, attempts[1]!.task_id, attempts[1]!.id).exitCode).toBe(0)
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual([
    "accepted",
    "accepted",
  ])
})

test("missing and permission-denied skill suggestions never block admission or dispatch", async () => {
  for (const skillSuggestions of [
    [],
    ["missing-skill — Optional but not installed"],
    ["denied-skill — Optional and may not be permitted"],
  ]) {
    const f = fixture({ skillSuggestions })
    await f.runtime.command(
      { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
      "owner",
    )
    await drive(f.runtime)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
    for (const attempt of f.store.attempts(f.receipt.planID)) {
      expectNoSkillBody(attempt.policy)
      expect(
        JSON.parse(JSON.parse(attempt.policy).context).specification.requirements.skills,
      ).toEqual(skillSuggestions)
    }
  }
})

test("repair handoffs do not copy legacy skill bodies into a new attempt", async () => {
  const f = fixture({ fail: true, repair: true, skillSuggestions: ["sqlite — Optional helper"] })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  const first = f.store.attempts(f.receipt.planID)[0]!
  seedLegacySkillBody(f, first)
  await f.runtime.tick()
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("running")
  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]!.policy).toContain(skillBodyCanary)
  expectNoSkillBody(attempts[1]!.policy)
})

test("verification failure and scope violations cannot unblock a successor", async () => {
  for (const options of [{ fail: true }, { outside: true }, { human: true }]) {
    const f = fixture(options)
    await f.runtime.command(
      { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
      "owner",
    )
    await drive(f.runtime, 5)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
    expect(f.store.nodes(f.receipt.planID)[1]!.state).toBe("queued")
    expect(f.events.filter((e) => e.startsWith("create:"))).toHaveLength(1)
    expect(f.store.repository.get(f.tasks[0]!.id)!.status).toBe("submitted")
  }
})

test("an unchanged evidence wait keeps its version and notification stable until evidence arrives", async () => {
  const f = fixture({ human: true, commit: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 5)
  const blocked = f.store.plan(planID)!
  expect(blocked.state).toBe("blocked")
  const counts = () =>
    f.store.atomic((db) => ({
      blocked: db
        .query("SELECT COUNT(*) AS n FROM runner_transitions WHERE plan_id=? AND event='BLOCKED'")
        .get(planID),
      outcomes: db.query("SELECT COUNT(*) AS n FROM runner_outbox WHERE plan_id=?").get(planID),
    }))
  const before = counts()
  await drive(f.runtime, 4)
  expect(f.store.plan(planID)!.version).toBe(blocked.version)
  expect(counts()).toEqual(before)

  await f.runtime.command(
    {
      requestID: "observed",
      planID,
      expectedVersion: blocked.version,
      action: "human-evidence",
      taskID: f.tasks[0]!.id,
      assertionID: "correct",
      artifact: f.store.nodes(planID)[0]!.artifact!,
      reason: "Observed the fixture acceptance condition.",
    },
    "owner",
  )
  await drive(f.runtime, 4)
  expect(f.store.nodes(planID)[0]!.state).toBe("accepted")
  await f.runtime.command(
    {
      requestID: "continue-observed",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 4)
  expect(f.store.plan(planID)!.state).toBe("accepted")
})

test("a resumed worker verifies its new commit without reusing older receipts or spending a repair", async () => {
  const f = fixture({
    human: true,
    commit: true,
    repair: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 5)
  const original = f.store.attempts(planID)[0]!
  const originalCheck = f.store.effects(planID).find((effect) => effect.kind === "verify:content")!
  const originalReceipt = originalCheck.receipt
  expect(f.store.plan(planID)?.reason).toContain("correct:human")

  await f.runtime.command(
    {
      requestID: "cancel",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.command(
    {
      requestID: "resume-review-repair",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "resume",
      taskID: original.task_id,
      reason: "Continue the existing worker after review",
    },
    "owner",
  )
  await f.runtime.tick()
  // Same attempt, different valid source commit after the resumed worker finishes.
  writeFileSync(join(original.workspace, "a.txt"), "a\n")
  git(original.workspace, ["add", "a.txt"])
  git(original.workspace, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Repair after review",
  ])
  const repaired = git(original.workspace, ["rev-parse", "HEAD"])
  expect(repaired).not.toBe(original.artifact!)
  await drive(f.runtime, 5)

  expect(f.store.attempts(planID).map((attempt) => attempt.id)).toEqual([original.id])
  expect(f.store.plan(planID)?.reason).toContain("correct:human")
  expect(f.store.nodes(planID)[0]).toMatchObject({ state: "verifying", artifact: repaired })
  const checks = f.store.effects(planID).filter((effect) => effect.kind === "verify:content")
  expect(checks).toHaveLength(2)
  expect(checks.find((effect) => effect.id === originalCheck.id)?.receipt).toBe(originalReceipt)
  expect(new Set(checks.map((effect) => JSON.parse(effect.payload).receiptPath)).size).toBe(2)
  for (const effect of checks) {
    const payload = JSON.parse(effect.payload)
    expect(JSON.parse(effect.receipt!).check).toMatchObject({
      artifact: payload.artifact,
      exitCode: 0,
    })
    expect(existsSync(payload.receiptPath)).toBe(true)
  }
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
})

test("plan evidence binds to the accepted combination and remains separate from task evidence", async () => {
  const f = fixture({ commit: true, startOnly: true })
  const plan = f.store.submit(
    {
      ...f.input,
      acceptance: [
        ...f.input.acceptance,
        {
          id: "native",
          assertion: "Observed the combined behavior",
          evidence: [{ kind: "human", decision: "Observe the app" }],
        },
      ],
    },
    "owner",
  )
  const evidence = {
    requestID: "graph-observed",
    planID: plan.planID,
    expectedVersion: 1,
    action: "human-evidence" as const,
    assertionID: "native",
    artifact: f.base,
    reason: "Observed the combined acceptance condition.",
  }
  await expect(f.runtime.command(evidence, "owner")).rejects.toThrow("all accepted task artifacts")
  await f.runtime.command(
    { requestID: "run", planID: plan.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime, 10)
  expect(f.store.plan(plan.planID)!.reason).toContain("native:human")
  expect(f.store.nodes(plan.planID).every((node) => node.state === "accepted")).toBe(true)
  const artifact = combineArtifacts(
    f.root,
    f.base,
    f.input.integrationOrder.map(
      (id) => f.store.nodes(plan.planID).find((node) => node.task_id === id)!.artifact!,
    ),
  )
  const current = { ...evidence, expectedVersion: f.store.plan(plan.planID)!.version, artifact }
  await expect(
    f.runtime.command({ ...current, requestID: "wrong-artifact", artifact: f.base }, "owner"),
  ).rejects.toThrow("current assertion/artifact")
  await expect(
    f.runtime.command({ ...current, requestID: "wrong-scope", taskID: f.tasks[0]!.id }, "owner"),
  ).rejects.toThrow("current assertion/artifact")
  const receipt = await f.runtime.command(current, "owner")
  expect(f.store.plan(plan.planID)!.state).toBe("blocked")
  const recorded = () =>
    f.store.atomic((db) =>
      db
        .query(
          "SELECT task_id,artifact FROM runner_evidence WHERE plan_id=? AND assertion_id='native' AND kind='human'",
        )
        .all(plan.planID),
    )
  expect(recorded()).toEqual([{ task_id: null, artifact }])
  await f.runtime.command(
    {
      requestID: "continue-graph",
      planID: plan.planID,
      expectedVersion: f.store.plan(plan.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 4)
  expect(f.store.plan(plan.planID)!.state).toBe("accepted")
  expect(await f.runtime.command(current, "owner")).toEqual(receipt)
  expect(recorded()).toHaveLength(1)
})

test("lost host response reconciles a real accepted prompt without creating another worker", async () => {
  const f = fixture()
  const original = f.host.prompt
  f.host.prompt = async (input) => {
    await original(input)
    throw new Error("response lost")
  }
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime, 2)
  expect(f.store.effects(f.receipt.planID).find((e) => e.kind === "prompt")?.state).toBe(
    "completed",
  )
  expect(f.events.filter((e) => e.startsWith("prompt:"))).toHaveLength(1)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
})

test("leases fence stale owners; expiration does not replay an uncertain effect", async () => {
  const f = fixture()
  const a = f.store.claim("first", 100)!
  expect(f.store.claim("second", 101)).toBeNull()
  const b = f.store.claim("second", 30101)!
  expect(b).toBeGreaterThan(a)
  expect(() => f.store.fenced("first", a, () => true)).toThrow("Stale")
  expect(f.store.fenced("second", b, () => true)).toBe(true)
})

test("schema rejects cycles, foreign dependency IDs and duplicate nodes before persistence", () => {
  const f = fixture()
  expect(
    PlanInput.safeParse({
      ...f.input,
      dependencies: [{ prerequisite: f.tasks[1]!.id, successor: f.tasks[0]!.id }],
    }).success,
  ).toBe(false)
  expect(
    PlanInput.safeParse({ ...f.input, nodes: [f.input.nodes[0], f.input.nodes[0]] }).success,
  ).toBe(false)
  expect(
    PlanInput.safeParse({
      ...f.input,
      dependencies: [{ prerequisite: crypto.randomUUID(), successor: f.tasks[0]!.id }],
    }).success,
  ).toBe(false)
  expect(() =>
    f.runtime.store.submit(
      {
        ...f.input,
        requestID: "foreign",
        nodes: [{ taskID: crypto.randomUUID(), revision: 1 }],
        integrationOrder: [crypto.randomUUID()],
      },
      "owner",
    ),
  ).toThrow()
})

test("historical guessed token caps do not stop useful work and stopped attempts resume without resetting usage", async () => {
  const f = fixture()
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const historicalPolicy = seedLegacySkillBody(f, attempt)
  const worker = f.sessions.get(attempt.session_id)!
  worker.tokens = 65941
  worker.outcome = "interrupted"
  f.store.move(f.receipt.planID, attempt.task_id, "EXHAUST", "Historical guessed token cap")
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='exhausted',token_count=65941 WHERE id=?").run(
      attempt.id,
    )
    db.query("UPDATE runner_plans SET state='blocked' WHERE id=?").run(f.receipt.planID)
  })
  const command = {
    requestID: "resume-existing",
    planID: f.receipt.planID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    action: "resume",
    taskID: attempt.task_id,
    reason: "No model-derived budget is configured",
  }
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  expect(f.store.attempts(f.receipt.planID)[0]!.token_count).toBe(65941)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)[0]!.policy).toBe(historicalPolicy)
  const sameTask = f.store.attempts(f.receipt.planID).filter((a) => a.task_id === attempt.task_id)
  expect(sameTask).toHaveLength(1)
  expect(sameTask[0]!.session_id).toBe(attempt.session_id)
  expect(sameTask[0]!.token_count).toBe(65941)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(3)
})

test("runtime retains the actual directory returned by the host worktree strategy", async () => {
  const f = fixture()
  const create = f.host.worktree
  f.host.worktree = async ({ directory, base }) => create({ directory: directory + "-2", base })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(
    f.store.attempts(f.receipt.planID).every((attempt) => attempt.workspace.endsWith("-2")),
  ).toBe(true)
  expect(f.store.effects(f.receipt.planID).some((effect) => effect.kind === "graph-worktree")).toBe(
    false,
  )
})

test("an explicitly cancelled worker can continue through its owner without replacing its worktree", async () => {
  const f = fixture()
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  await f.runtime.command(
    {
      requestID: "cancel",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cancelled")
  await f.runtime.command(
    {
      requestID: "continue",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "resume",
      taskID: attempt.task_id,
      reason: "Host location corrected",
    },
    "owner",
  )
  // Cancellation also stopped the queued successor; verify this task's continuation independently.
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]!.workspace).toBe(attempt.workspace)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
})

test("retry requeues a cancelled unstarted successor in the admitted graph and waits for dependencies and scope", async () => {
  const f = fixture({ delayed: true })
  const planID = f.receipt.planID
  const predecessorID = f.tasks[0]!.id
  const successorID = f.tasks[1]!.id
  const originalGraph = {
    body: f.store.plan(planID)!.body,
    nodes: f.store.nodes(planID).map((node) => node.task_id),
    dependencies: f.store.atomic((db) =>
      db
        .query<{ prerequisite: string; successor: string }, [string]>(
          "SELECT prerequisite,successor FROM runner_dependencies WHERE plan_id=? ORDER BY rowid",
        )
        .all(planID),
    ),
  }
  await runPlan(f)
  await f.runtime.tick()
  const original = f.store.attempts(planID)[0]!
  expect(original.task_id).toBe(predecessorID)
  expect(f.store.attempts(planID)).toHaveLength(1)

  await f.runtime.command(
    {
      requestID: "cancel-running-graph",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(planID)!.state).toBe("cancelled")
  expect(f.store.nodes(planID).map((node) => node.state)).toEqual(["cancelled", "cancelled"])

  await f.runtime.command(
    {
      requestID: "resume-original-predecessor",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "resume",
      taskID: predecessorID,
      reason: "Continue the admitted prerequisite",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)!.state).toBe("running")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: original.id,
    session_id: original.session_id,
    number: original.number,
    state: "running",
  })

  const requeue = {
    requestID: "requeue-unstarted-successor",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
    action: "retry" as const,
    taskID: successorID,
    reason: "Restore the original dependent task",
  }
  const receipt = await f.runtime.command(requeue, "owner")
  expect(receipt).toMatchObject({ status: "requeued" })
  expect(f.store.plan(planID)!.state).toBe("running")
  expect(f.store.plan(planID)!.body).toBe(originalGraph.body)
  expect(f.store.nodes(planID).map((node) => node.task_id)).toEqual(originalGraph.nodes)
  expect(
    f.store.atomic((db) =>
      db
        .query<{ prerequisite: string; successor: string }, [string]>(
          "SELECT prerequisite,successor FROM runner_dependencies WHERE plan_id=? ORDER BY rowid",
        )
        .all(planID),
    ),
  ).toEqual(originalGraph.dependencies)
  expect(f.store.nodes(planID).find((node) => node.task_id === successorID)?.state).toBe("ready")
  expect(f.store.execution(successorID)?.waitingOn).toEqual([predecessorID])
  expect(
    f.store.attempts(planID).filter((attempt) => attempt.task_id === successorID),
  ).toHaveLength(0)

  const requeuedHistory = f.store.activity(planID, successorID).length
  const reopenedRepository = new TaskRepository(f.repository.path, f.repository.projectDirectory)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopened = new TaskRuntime(reopenedStore, f.host, "project")
  try {
    expect(await reopened.command(requeue, "owner")).toEqual(receipt)
    await expect(
      reopened.command({ ...requeue, reason: "Different recovery intent" }, "owner"),
    ).rejects.toThrow("identity conflict")
    await expect(reopened.command(requeue, "not-the-owner")).rejects.toThrow("identity conflict")
    expect(reopenedStore.activity(planID, successorID)).toHaveLength(requeuedHistory)
  } finally {
    await reopened.stop()
    reopenedRepository.close()
  }
  expect(f.store.activity(planID, successorID)).toHaveLength(requeuedHistory)

  const scopeBlocker = f.createTask("c", "c.txt", ["b.txt", "c.txt"])
  const blockerPlan = f.store.submit(
    f.inputFor([scopeBlocker], { requestID: "scope-blocker-plan" }),
    "owner",
  )
  await f.runtime.command(
    {
      requestID: "run-scope-blocker",
      planID: blockerPlan.planID,
      expectedVersion: blockerPlan.version,
      action: "run",
    },
    "owner",
  )
  await f.runtime.tick()
  const blockerAttempt = f.store.attempts(blockerPlan.planID)[0]!
  expect(f.sessions.get(blockerAttempt.session_id)?.busy).toBe(true)

  f.completeWorker(original.session_id)
  await f.runtime.tick()
  expect(f.store.nodes(planID).find((node) => node.task_id === predecessorID)?.state).toBe(
    "accepted",
  )
  expect(f.store.execution(successorID)?.waitingOn).toEqual([])
  expect(
    f.store.attempts(planID).filter((attempt) => attempt.task_id === successorID),
  ).toHaveLength(0)

  f.completeWorker(blockerAttempt.session_id)
  await f.runtime.tick()
  expect(f.store.plan(blockerPlan.planID)?.state).toBe("accepted")
  expect(
    f.store.attempts(planID).filter((attempt) => attempt.task_id === successorID),
  ).toHaveLength(0)

  await f.runtime.tick()
  const successorAttempts = f.store
    .attempts(planID)
    .filter((attempt) => attempt.task_id === successorID)
  expect(successorAttempts).toHaveLength(1)
  expect(successorAttempts[0]).toMatchObject({ number: 1, state: "running" })
  expect(successorAttempts[0]!.base_commit).toBe(f.store.attempts(planID)[0]!.artifact!)
  expect(
    f.store.attempts(planID).filter((attempt) => attempt.task_id === predecessorID),
  ).toHaveLength(1)
  expect(f.store.activity(planID, predecessorID).map((entry) => entry.event)).toContain("RESUME")
  expect(f.store.activity(planID, predecessorID).map((entry) => entry.event)).toContain("CANCEL")

  f.completeWorker(successorAttempts[0]!.session_id)
  await drive(f.runtime)
  expect(f.store.plan(planID)?.state).toBe("accepted")
})

test("requeued unstarted work can be cancelled again before normal dispatch", async () => {
  const f = fixture()
  const planID = f.receipt.planID
  const cancelled = await cancelUnstartedPlan(f)
  expect(cancelled.state).toBe("cancelled")
  const taskID = f.tasks[1]!.id
  const requeue = {
    requestID: "requeue-then-cancel",
    planID,
    expectedVersion: cancelled.version,
    action: "retry" as const,
    taskID,
    reason: "Restore, then stop before dispatch",
  }
  const receipt = await f.runtime.command(requeue, "owner")
  expect(receipt).toMatchObject({ status: "requeued" })
  expect(f.store.attempts(planID)).toHaveLength(0)
  await f.runtime.command(
    {
      requestID: "cancel-requeued-before-dispatch",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)!.state).toBe("cancelled")
  expect(f.store.nodes(planID).find((node) => node.task_id === taskID)?.state).toBe("cancelled")
  expect(f.store.attempts(planID)).toHaveLength(0)
  expect(f.events.some((event) => event.startsWith("create:") || event.startsWith("prompt:"))).toBe(
    false,
  )
})

test("unstarted recovery rejects unauthorized, stale, missing, archived and foreign owners without writes", async () => {
  for (const denial of ["unauthorized", "stale", "missing", "archived", "foreign"] as const) {
    const f = fixture()
    const stopped = await cancelUnstartedPlan(f)
    const planID = stopped.id
    const taskID = f.tasks[1]!.id
    const beforePlan = f.store.plan(planID)!
    const beforeNode = f.store.nodes(planID).find((node) => node.task_id === taskID)!
    const beforeHistory = f.store.activity(planID, taskID)
    const recovery = {
      requestID: `denied-recovery-${denial}`,
      planID,
      expectedVersion: denial === "stale" ? beforePlan.version - 1 : beforePlan.version,
      action: "retry" as const,
      taskID,
      reason: "Attempt a denied recovery",
    }
    if (denial === "missing") f.sessions.delete("owner")
    if (denial === "archived") f.sessions.get("owner")!.archived = true
    if (denial === "foreign") f.sessions.get("owner")!.projectID = "another-project"

    await expect(
      f.runtime.command(recovery, denial === "unauthorized" ? "not-the-owner" : "owner"),
    ).rejects.toThrow(
      denial === "unauthorized"
        ? "Only the plan owner"
        : denial === "stale"
          ? "Stale plan version"
          : denial === "foreign"
            ? "Foreign owner session"
            : "Owner unavailable",
    )
    expect(f.store.plan(planID)).toEqual(beforePlan)
    expect(f.store.nodes(planID).find((node) => node.task_id === taskID)).toEqual(beforeNode)
    expect(f.store.activity(planID, taskID)).toEqual(beforeHistory)
    expect(f.store.attempts(planID)).toHaveLength(0)
    expect(
      f.store.atomic(
        (db) =>
          db
            .query<{ count: number }, [string, string]>(
              "SELECT count(*) AS count FROM runner_commands WHERE project_directory=? AND request_id=?",
            )
            .get(f.store.repository.projectDirectory, recovery.requestID)!.count,
      ),
    ).toBe(0)
    expect(
      f.events.some((event) => event.startsWith("create:") || event.startsWith("prompt:")),
    ).toBe(false)
  }
})

test("unstarted recovery rechecks the plan version after owner lookup races with reassignment", async () => {
  const f = fixture()
  const stopped = await cancelUnstartedPlan(f)
  const planID = stopped.id
  const taskID = f.tasks[1]!.id
  f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner" })
  const recovery = {
    requestID: "racing-unstarted-recovery",
    planID,
    expectedVersion: stopped.version,
    action: "retry" as const,
    taskID,
    reason: "Recover only if ownership remains current",
  }
  const beforeHistory = f.store.activity(planID, taskID)
  const originalSession = f.host.session
  let announceLookup!: () => void
  let releaseLookup!: () => void
  const lookupStarted = new Promise<void>((resolve) => (announceLookup = resolve))
  const lookupGate = new Promise<void>((resolve) => (releaseLookup = resolve))
  f.host.session = async (id, options) => {
    if (id === "owner") {
      announceLookup()
      await lookupGate
    }
    return originalSession(id, options)
  }

  const pendingRecovery = f.runtime.command(recovery, "owner")
  await lookupStarted
  await f.runtime.command(
    {
      requestID: "reassign-during-unstarted-recovery",
      planID,
      expectedVersion: stopped.version,
      action: "reassign",
      targetSessionID: "new-owner",
      reason: "Explicitly change the plan owner",
    },
    "owner",
  )
  releaseLookup()
  await expect(pendingRecovery).rejects.toThrow("Stale plan version")

  expect(f.store.plan(planID)).toMatchObject({ owner: "new-owner", state: "cancelled" })
  expect(f.store.nodes(planID).find((node) => node.task_id === taskID)?.state).toBe("cancelled")
  expect(f.store.activity(planID, taskID)).toEqual(beforeHistory)
  expect(f.store.attempts(planID)).toHaveLength(0)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string, string]>(
            "SELECT count(*) AS count FROM runner_commands WHERE project_directory=? AND request_id=?",
          )
          .get(f.store.repository.projectDirectory, recovery.requestID)!.count,
    ),
  ).toBe(0)
})

test("unstarted recovery rejects invalid node/plan states and unreconciled effects", async () => {
  const queued = fixture()
  await runPlan(queued)
  const queuedPlan = queued.store.plan(queued.receipt.planID)!
  const queuedTask = queued.tasks[1]!.id
  await expect(
    queued.runtime.command(
      {
        requestID: "retry-still-queued-node",
        planID: queuedPlan.id,
        expectedVersion: queuedPlan.version,
        action: "retry",
        taskID: queuedTask,
        reason: "Do not recover a non-cancelled node",
      },
      "owner",
    ),
  ).rejects.toThrow("Only an exhausted or cancelled, stopped attempt can resume")
  expect(queued.store.nodes(queuedPlan.id).find((node) => node.task_id === queuedTask)?.state).toBe(
    "queued",
  )
  expect(queued.store.attempts(queuedPlan.id)).toHaveLength(0)

  const integrated = fixture()
  const integratedPlan = await cancelUnstartedPlan(integrated)
  integrated.store.atomic((db) =>
    db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(integratedPlan.id),
  )
  const integratedNode = integrated.store
    .nodes(integratedPlan.id)
    .find((node) => node.task_id === integrated.tasks[1]!.id)!
  const integratedHistory = integrated.store.activity(integratedPlan.id, integratedNode.task_id)
  await expect(
    integrated.runtime.command(
      {
        requestID: "retry-integrated-plan",
        planID: integratedPlan.id,
        expectedVersion: integrated.store.plan(integratedPlan.id)!.version,
        action: "retry",
        taskID: integratedNode.task_id,
        reason: "Do not revive an integrated plan",
      },
      "owner",
    ),
  ).rejects.toThrow("Only an admitted, nonintegrated plan can requeue an unstarted task")
  expect(
    integrated.store
      .nodes(integratedPlan.id)
      .find((node) => node.task_id === integratedNode.task_id),
  ).toEqual(integratedNode)
  expect(integrated.store.activity(integratedPlan.id, integratedNode.task_id)).toEqual(
    integratedHistory,
  )
  expect(integrated.store.attempts(integratedPlan.id)).toHaveLength(0)

  const unresolved = fixture()
  const unresolvedPlan = await cancelUnstartedPlan(unresolved)
  const unresolvedTask = unresolved.tasks[1]!.id
  unresolved.store.atomic((db) =>
    db
      .query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'intended',?,NULL,0)")
      .run(
        crypto.randomUUID(),
        unresolvedPlan.id,
        unresolvedTask,
        null,
        "recovery-test-effect",
        "{}",
      ),
  )
  const unresolvedNode = unresolved.store
    .nodes(unresolvedPlan.id)
    .find((node) => node.task_id === unresolvedTask)!
  const unresolvedHistory = unresolved.store.activity(unresolvedPlan.id, unresolvedTask)
  await expect(
    unresolved.runtime.command(
      {
        requestID: "retry-with-unresolved-effect",
        planID: unresolvedPlan.id,
        expectedVersion: unresolved.store.plan(unresolvedPlan.id)!.version,
        action: "retry",
        taskID: unresolvedTask,
        reason: "Reconcile the outstanding effect first",
      },
      "owner",
    ),
  ).rejects.toThrow("Reconcile uncertain effects first")
  expect(
    unresolved.store.nodes(unresolvedPlan.id).find((node) => node.task_id === unresolvedTask),
  ).toEqual(unresolvedNode)
  expect(unresolved.store.activity(unresolvedPlan.id, unresolvedTask)).toEqual(unresolvedHistory)
  expect(unresolved.store.attempts(unresolvedPlan.id)).toHaveLength(0)
  expect(
    unresolved.store.effects(unresolvedPlan.id).some((effect) => effect.state === "intended"),
  ).toBe(true)
})

test("serial shared children commit in the current checkout without creating worktrees", async () => {
  const f = fixture({ shared: true })
  f.host.worktree = async () => {
    throw new Error("Serial tasks must not allocate worktrees")
  }
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID).every((attempt) => attempt.workspace === f.root)).toBe(
    true,
  )
  expect(f.store.effects(f.receipt.planID).some((effect) => effect.kind.includes("worktree"))).toBe(
    false,
  )
  expect(git(f.root, ["show", "HEAD:a.txt"])).toBe("a")
  expect(git(f.root, ["show", "HEAD:b.txt"])).toBe("b")
})

test("explicit retry starts a fresh native child and retains the old attempt and usage", async () => {
  const f = fixture({ shared: true })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  const old = f.store.attempts(f.receipt.planID)[0]!
  seedLegacySkillBody(f, old)
  f.store.atomic((db) =>
    db.query("UPDATE runner_attempts SET token_count=65941 WHERE id=?").run(old.id),
  )
  await f.runtime.command(
    {
      requestID: "cancel",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  const command = {
    requestID: "fresh-retry",
    planID: f.receipt.planID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    action: "retry",
    taskID: old.task_id,
    reason: "Use concise task fetch in a fresh child",
    workspaceMode: "shared",
    baseCommit: f.base,
  }
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]!.token_count).toBe(65941)
  expect(attempts[0]!.state).toBe("cancelled")
  expect(attempts[0]!.policy).toContain(skillBodyCanary)
  expectNoSkillBody(attempts[1]!.policy)
  expect(attempts[1]!.session_id).not.toBe(old.session_id)
  expect(attempts[1]!.workspace).toBe(f.root)
})

test("a shared node's first attempt starts at reviewed HEAD, not an older accepted predecessor", async () => {
  const f = fixture({ shared: true })
  let reviewedHead = ""
  const move = f.store.move.bind(f.store)
  f.store.move = (planID, taskID, event, reason) => {
    const result = move(planID, taskID, event, reason)
    if (taskID === f.tasks[0]!.id && event === "ACCEPT") {
      writeFileSync(join(f.root, "reviewer-fix.txt"), "approved\n")
      git(f.root, ["add", "reviewer-fix.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Reviewed repair between shared nodes",
      ])
      reviewedHead = git(f.root, ["rev-parse", "HEAD"])
    }
    return result
  }
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  const predecessor = f.store.attempts(f.receipt.planID)[0]!
  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  await drive(reopened)
  const predecessorArtifact = f.store.attempts(f.receipt.planID)[0]!.artifact
  expect(reviewedHead).not.toBe("")
  expect(reviewedHead).not.toBe(predecessorArtifact)
  const next = f.store
    .attempts(f.receipt.planID)
    .find((attempt) => attempt.task_id === f.tasks[1]!.id)!
  expect(next.base_commit).toBe(reviewedHead)
  expect(JSON.parse(next.policy).source).toBe(reviewedHead)
  expect(next.state).toBe("accepted")
  expect(git(f.root, ["diff", "--name-only", `${next.base_commit}..${next.artifact}`])).toBe(
    "b.txt",
  )
  expect(git(f.root, ["show", `${next.artifact}:reviewer-fix.txt`])).toBe("approved")
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
    id: predecessor.id,
    artifact: predecessorArtifact,
    base_commit: f.base,
    state: "accepted",
  })
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
})

test("an explicit corrected shared baseline wins across reopen and excludes reviewed scope changes", async () => {
  const f = fixture({ shared: true, wrongFirstB: true })
  const { predecessor, failed } = await failSecondSharedTask(f)
  const predecessorArtifact = predecessor.artifact
  const failedArtifact = failed.artifact
  if (!predecessorArtifact || !failedArtifact) throw new Error("Expected Git artifacts")
  expect(failed.token_count).toBe(65941)
  expect(failed.tool_count).toBe(17)
  expect(failed.cost).toBe(1.25)

  writeFileSync(join(f.root, "reviewer-fix.txt"), "approved\n")
  git(f.root, ["add", "reviewer-fix.txt"])
  git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Reviewer correction",
  ])
  const correctedBaseline = git(f.root, ["rev-parse", "HEAD"])
  expect(correctedBaseline).not.toBe(failedArtifact)
  expect(git(f.root, ["show", `${correctedBaseline}:reviewer-fix.txt`])).toBe("approved")

  const retry = await f.runtime.command(
    {
      requestID: "retry-corrected-baseline",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "retry",
      taskID: f.tasks[1]!.id,
      reason: "Start from the reviewed shared baseline",
      workspaceMode: "shared",
      baseCommit: correctedBaseline,
    },
    "owner",
  )
  expect(retry).toMatchObject({ status: "retrying" })
  expect(
    f.store.latestTransition<{ attemptID: string; source: string; explicitBaseline: boolean }>(
      f.receipt.planID,
      f.tasks[1]!.id,
      "WORKSPACE_SELECTED",
    ),
  ).toMatchObject({ source: correctedBaseline, explicitBaseline: true })
  expect(
    f.store.latestTransition<{
      attemptID: string
      selectedBaseline: string | null
      reason: string
      usageRetained: boolean
      budget: null
    }>(f.receipt.planID, f.tasks[1]!.id, "RETRY_REQUESTED"),
  ).toEqual({
    attemptID: failed.id,
    reason: "Start from the reviewed shared baseline",
    usageRetained: true,
    budget: null,
    selectedBaseline: correctedBaseline,
  })

  // A fresh runtime must recover the selected source from durable retry history.
  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  try {
    await drive(reopened)
  } finally {
    reopened.stop()
  }

  const retriedAttempts = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === f.tasks[1]!.id)
  expect(retriedAttempts).toHaveLength(2)
  const retried = retriedAttempts[1]!
  const retriedArtifact = retried.artifact
  if (!retriedArtifact) throw new Error("Expected retry artifact")
  expect(retried.base_commit).toBe(correctedBaseline)
  expect(JSON.parse(retried.policy).source).toBe(correctedBaseline)
  expect(retried.workspace).toBe(f.root)
  expect(retried.state).toBe("accepted")
  expect(retriedAttempts[0]).toMatchObject({
    id: failed.id,
    state: "failed",
    base_commit: predecessorArtifact,
    artifact: failedArtifact,
    token_count: 65941,
    tool_count: 17,
    cost: 1.25,
  })
  expect(f.store.nodes(f.receipt.planID)[1]!.state).toBe("accepted")
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(git(f.root, ["diff", "--name-only", `${correctedBaseline}..${retriedArtifact}`])).toBe(
    "b.txt",
  )
  expect(git(f.root, ["show", `${retriedArtifact}:reviewer-fix.txt`])).toBe("approved")

  const failedCheck = attemptCheck(f, f.tasks[1]!.id, failed.id)
  const retriedCheck = attemptCheck(f, f.tasks[1]!.id, retried.id)
  expect(failedCheck.artifact).toBe(failedArtifact)
  expect(failedCheck.exitCode).not.toBe(0)
  expect(retriedCheck.artifact).toBe(retriedArtifact)
  expect(retriedCheck.inputIdentity).toBe(retriedArtifact)
  expect(retriedCheck.exitCode).toBe(0)
  const checks = f.store
    .effects(f.receipt.planID)
    .filter((effect) => effect.task_id === f.tasks[1]!.id && effect.kind === "verify:content")
  expect(checks.map((effect) => effect.id)).toHaveLength(2)
  expect(new Set(checks.map((effect) => effect.attempt_id)).size).toBe(2)
  const combined = f.store
    .effects(f.receipt.planID)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(combined.receipt!).check.artifact).toBe(retriedArtifact)
})

test("retry without a newly selected baseline continues from the failed artifact and retains history", async () => {
  const f = fixture({ shared: true, wrongFirstB: true })
  const { predecessor, failed } = await failSecondSharedTask(f)
  const predecessorArtifact = predecessor.artifact
  const failedArtifact = failed.artifact
  if (!predecessorArtifact || !failedArtifact) throw new Error("Expected Git artifacts")
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(failedArtifact)

  await f.runtime.command(
    {
      requestID: "retry-existing-baseline",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "retry",
      taskID: f.tasks[1]!.id,
      reason: "Continue the existing shared attempt",
      workspaceMode: "shared",
    },
    "owner",
  )
  expect(
    f.store.latestTransition<{ attemptID: string; selectedBaseline: string | null }>(
      f.receipt.planID,
      f.tasks[1]!.id,
      "RETRY_REQUESTED",
    ),
  ).toMatchObject({ attemptID: failed.id, selectedBaseline: null })
  await drive(f.runtime)

  const retriedAttempts = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === f.tasks[1]!.id)
  expect(retriedAttempts).toHaveLength(2)
  const retried = retriedAttempts[1]!
  const retriedArtifact = retried.artifact
  if (!retriedArtifact) throw new Error("Expected retry artifact")
  expect(retried.base_commit).toBe(failedArtifact)
  expect(JSON.parse(retried.policy).source).toBe(failedArtifact)
  expect(retried.state).toBe("accepted")
  expect(retriedAttempts[0]).toMatchObject({
    id: failed.id,
    state: "failed",
    base_commit: predecessorArtifact,
    artifact: failedArtifact,
    token_count: 65941,
    tool_count: 17,
    cost: 1.25,
  })
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")

  const failedCheck = attemptCheck(f, f.tasks[1]!.id, failed.id)
  const retriedCheck = attemptCheck(f, f.tasks[1]!.id, retried.id)
  expect(failedCheck.artifact).toBe(failedArtifact)
  expect(failedCheck.exitCode).not.toBe(0)
  expect(retriedArtifact).not.toBe(failedArtifact)
  expect(retriedCheck.artifact).toBe(retriedArtifact)
  expect(retriedCheck.inputIdentity).toBe(retriedArtifact)
  expect(retriedCheck.exitCode).toBe(0)
  const combined = f.store
    .effects(f.receipt.planID)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(combined.receipt!).check.artifact).toBe(retriedArtifact)
})

test("native cleanup follows verified integration, preserves dirty work, and retries explicitly", async () => {
  const f = fixture({ commit: true })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  const artifact = f.store.plan(f.receipt.planID)!.artifact!
  const request = (key: string) => ({
    requestID: key,
    planID: f.receipt.planID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    action: "integrated",
    artifact,
    targetBranch: "main",
    reason: "Reviewed task changes and combined checks",
  })
  await expect(f.runtime.command(request("not-merged"), "owner")).rejects.toThrow()
  git(f.root, ["merge", "--ff-only", artifact])
  const worktree = f.store.attempts(f.receipt.planID)[0]!.workspace
  writeFileSync(join(worktree, "unreviewed.txt"), "preserve this")
  await f.runtime.command(request("merged"), "owner")
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cleanup-blocked")
  expect(readFileSync(join(worktree, "unreviewed.txt"), "utf8")).toBe("preserve this")
  expect(f.store.nodes(f.receipt.planID).every((node) => node.state === "accepted")).toBe(true)
  rmSync(join(worktree, "unreviewed.txt"))
  await f.runtime.command(request("retry-cleanup"), "owner")
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.reason).toBeNull()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("integrated")
  expect(await f.host.worktrees()).toEqual([f.root])
  expect(git(f.root, ["show", "HEAD:b.txt"])).toBe("b")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
})

test("explicit Luna Max worker selection preserves the stronger Architect model and reaches acceptance", async () => {
  const model = { providerID: "openai", id: "gpt-6-luna", variant: "max" }
  const f = fixture({ shared: true, workerModel: model })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(JSON.parse(f.store.plan(f.receipt.planID)!.model!)).toEqual(model)
  for (const attempt of f.store.attempts(f.receipt.planID)) {
    expect(f.sessions.get(attempt.session_id)!.model).toEqual(model)
    expect(JSON.parse(attempt.policy).model).toEqual(model)
  }
  expect(f.sessions.get("owner")!.model!.id).toBe("subscription")
})

test("cleanup preserves clean worktrees with commits outside the reviewed integration", async () => {
  const f = fixture({ commit: true })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  const artifact = f.store.plan(f.receipt.planID)!.artifact!
  git(f.root, ["merge", "--ff-only", artifact])
  const worktree = f.store.attempts(f.receipt.planID)[0]!.workspace
  writeFileSync(join(worktree, "unmerged.txt"), "retain this commit")
  git(worktree, ["add", "unmerged.txt"])
  git(worktree, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Unreviewed follow-up",
  ])
  const unmerged = git(worktree, ["rev-parse", "HEAD"])
  expect(git(worktree, ["status", "--porcelain"])).toBe("")
  await f.runtime.command(
    {
      requestID: "integrate",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Reviewed accepted artifact",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cleanup-blocked")
  expect(f.store.plan(f.receipt.planID)!.reason).toContain("unmerged commits")
  expect(git(worktree, ["rev-parse", "HEAD"])).toBe(unmerged)
  expect(await f.host.worktrees()).toContain(worktree)
})

test("cleanup preserves a dirty owned worktree even after its accepted commit was merged", async () => {
  const f = fixture({ independent: true, commit: true })
  await runPlan(f)
  await drive(f.runtime)
  const artifact = f.store.plan(f.receipt.planID)!.artifact!
  git(f.root, ["merge", "--ff-only", artifact])
  const worktree = f.store.attempts(f.receipt.planID)[0]!.workspace
  writeFileSync(join(worktree, "a.txt"), "unreviewed dirty edit")

  await f.runtime.command(
    {
      requestID: "integrate-dirty",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Reviewed only the accepted combined artifact",
    },
    "owner",
  )
  await f.runtime.tick()

  expect(f.store.plan(f.receipt.planID)!.state).toBe("cleanup-blocked")
  expect(f.store.plan(f.receipt.planID)!.reason).toContain("worktree is dirty")
  expect(git(worktree, ["status", "--porcelain"])).toContain("a.txt")
  expect(await f.host.worktrees()).toContain(worktree)
})

test("priority orders conflicting plans without rejecting their overlapping scopes", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: [{ name: "a", path: "src/a.txt", scope: ["src/**"] }],
  })
  const b = f.createTask("b", "src/b.txt", ["src/**"])
  const later = f.store.submit(
    { ...f.inputFor([b], { requestID: "priority-b" }), priority: 10 },
    "owner",
  )
  await runPlan(f, f.receipt.planID, "priority-run-a")
  await runPlan(f, later.planID, "priority-run-b")
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(0)
  const attempt = f.store.attempts(later.planID)[0]!
  expect(attempt).toBeDefined()
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  const updated = await f.runtime.command(
    {
      requestID: "priority-live",
      planID: later.planID,
      expectedVersion: f.store.plan(later.planID)!.version,
      action: "schedule",
      priority: -1,
      reason: "Let another plan take precedence after this worker finishes",
    },
    "owner",
  )
  expect(updated).toMatchObject({ status: "scheduled" })
  expect(f.store.attempts(later.planID)).toHaveLength(1)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
})

test("cross-plan dependencies wait for integration and dispatch from the integrated source", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const b = f.createTask("b", "b.txt")
  const dependent = f.store.submit(
    {
      ...f.inputFor([b], { requestID: "dependent-b" }),
      afterPlans: [f.receipt.planID],
      priority: 10,
    },
    "owner",
  )
  await runPlan(f, dependent.planID, "dependency-run-b")
  await runPlan(f, f.receipt.planID, "dependency-run-a")
  await f.runtime.tick()
  expect(f.store.attempts(dependent.planID)).toHaveLength(0)
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(f.store.attempts(dependent.planID)).toHaveLength(0)
  const accepted = f.store.plan(f.receipt.planID)!
  git(f.root, ["merge", "--ff-only", accepted.artifact!])
  await f.runtime.command(
    {
      requestID: "dependency-integrated",
      planID: accepted.id,
      expectedVersion: accepted.version,
      action: "integrated",
      artifact: accepted.artifact!,
      targetBranch: "main",
      reason: "Reviewed the result and merged it",
    },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(accepted.id)!.reason).toBeNull()
  expect(f.store.plan(accepted.id)!.state).toBe("integrated")
  const next = f.store.attempts(dependent.planID)[0]!
  expect(next.base_commit).toBe(accepted.artifact!)
  expect(readFileSync(join(next.workspace, "a.txt"), "utf8")).toBe("a")
})

test("schedule updates are versioned, retry-safe and reject dependency cycles or foreign plans", async () => {
  const f = fixture({ startOnly: true, independent: true })
  const a = f.store.submit(f.inputFor([f.tasks[0]!], { requestID: "schedule-a" }), "owner")
  const b = f.store.submit(
    { ...f.inputFor([f.tasks[1]!], { requestID: "schedule-b" }), afterPlans: [a.planID] },
    "owner",
  )
  const original = f.store.plan(a.planID)!
  await expect(
    f.runtime.command(
      {
        requestID: "schedule-cycle",
        planID: a.planID,
        expectedVersion: original.version,
        action: "schedule",
        afterPlans: [b.planID],
        reason: "Invalid cycle",
      },
      "owner",
    ),
  ).rejects.toThrow("cycle")
  await expect(
    f.runtime.command(
      {
        requestID: "schedule-foreign",
        planID: a.planID,
        expectedVersion: original.version,
        action: "schedule",
        afterPlans: [crypto.randomUUID()],
        reason: "Unknown project plan",
      },
      "owner",
    ),
  ).rejects.toThrow("foreign")
  expect(f.store.plan(a.planID)!.body).toBe(original.body)
  const command = {
    requestID: "schedule-valid",
    planID: b.planID,
    expectedVersion: b.version,
    action: "schedule",
    priority: 5,
    afterPlans: [],
    baseCommit: f.base,
    reason: "Independent work can start immediately",
  }
  const first = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(first)
  expect(f.store.plan(b.planID)!.revision).toBe(2)
  const history = f.store.atomic((db) =>
    db
      .query<{ body: string }, [string]>(
        "SELECT body FROM runner_plan_revisions WHERE plan_id=? ORDER BY revision",
      )
      .all(b.planID),
  )
  expect(history).toHaveLength(2)
  expect(JSON.parse(history[0]!.body).afterPlans).toEqual([a.planID])
  expect(JSON.parse(history[1]!.body)).toMatchObject({ priority: 5, afterPlans: [] })
})

test("runtime shutdown joins an in-flight native operation before storage may close", async () => {
  const f = fixture({ delayed: true })
  await runPlan(f)
  const original = f.host.session
  let entered!: () => void
  let release!: () => void
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.session = async (id) => {
    entered()
    await blocked
    return original(id)
  }
  const tick = f.runtime.tick()
  await entering
  let stopped = false
  const stopping = f.runtime.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  release()
  await tick
  await stopping
  expect(stopped).toBe(true)
  const attempts = f.store.attempts(f.receipt.planID).length
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(attempts)
})

test("heartbeat avoids context and rechecks a stopped worker after detailed accounting", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const original = f.host.session
  const calls: { id: string; messages: boolean }[] = []
  let firstFinalRead = true
  f.host.session = async (id, options) => {
    calls.push({ id, messages: options?.messages === true })
    const session = await original(id, options)
    if (session && options?.messages) {
      session.tools = 9
      if (id === attempt.session_id && firstFinalRead) {
        firstFinalRead = false
        session.busy = true
        session.outcome = undefined
      }
    }
    return session
  }

  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  await f.runtime.tick()
  expect(calls.find((call) => call.id === attempt.session_id)?.messages).toBe(false)
  expect(calls.some((call) => call.id === attempt.session_id && call.messages)).toBe(true)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")

  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)[0]!.tool_count).toBe(9)
})
