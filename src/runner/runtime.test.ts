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
import type {
  ArchitectSourceResult,
  HostBackgroundObservation,
  HostSession,
  RunnerHost,
} from "./host.ts"
import { DEFAULT_ARCHITECT_IDLE_WINDOW_MS, TaskRuntime, architectIdleWindowMs } from "./runtime.ts"
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
    architectIdleWindowMs?: number
    architectPromptHook?: boolean
    now?: () => number
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
    background: {
      state: "observed",
      source: "experimental.idle",
      observedAt: Date.now(),
      inputID: "owner-input",
      executionStartSequence: 1,
      eventSequence: 1,
      count: 0,
      kinds: { shell: 0, subagent: 0, image: 0 },
    },
    model: { providerID: "openai", id: "subscription", variant: "high" },
    tokens: null,
    tools: 0,
    cost: null,
    messages: [],
  })
  const events: string[] = []
  const notifications: { sessionID: string; id: string; text: string; resume: boolean }[] = []
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
          ...(input.planIDs ? { lazersPlanIDs: input.planIDs } : {}),
          lazersSourceSessionID: input.sourceSessionID,
        },
        model: input.model,
        archived: false,
        busy: false,
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
        tokens: 0,
        tools: 0,
        cost: null,
        messages: [],
      })
    },
    updateSession: async ({ sessionID, archived }) => {
      const session = sessions.get(sessionID)
      if (!session) throw new Error("Native session not found")
      events.push(`update-session:${sessionID}:${archived}`)
      session.archived = archived
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
      session.turn = {
        inputID: input.id,
        state: options.delayed ? "pending" : "completed",
      }
      if (session.background?.state === "observed") session.background.inputID = input.id
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
    architectInputPage: async (targetSessionID) => ({
      inbox: structuredClone(inbox.get(targetSessionID) ?? []).map((entry) => ({
        id: entry.id,
        type: entry.type,
        ...(entry.delivery ? { delivery: entry.delivery } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      })),
      messages: (sessions.get(targetSessionID)?.messages ?? []).map((message) => ({
        id: message.id,
        type: message.type ?? "user",
        ...(message.metadata ? { metadata: message.metadata } : {}),
      })),
      nextCursor: null,
    }),
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
      notifications.push({
        sessionID: input.sessionID,
        id: input.id,
        text: input.text,
        resume: input.resume,
      })
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
      if (sessions.get(id)!.turn)
        sessions.get(id)!.turn = {
          inputID: sessions.get(id)!.turn!.inputID,
          state: "interrupted",
        }
      events.push(`stop:${id}`)
    },
  }
  const runtime = new TaskRuntime(store, host, "project", undefined, {
    architectIdleWindowMs: options.architectIdleWindowMs,
    architectPromptHook: options.architectPromptHook,
    now: options.now,
  })
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
    session.turn = {
      inputID: session.turn?.inputID ?? null,
      state: outcome === "succeeded" ? "completed" : "interrupted",
    }
    events.push(`stop:${id}`)
  }
  return {
    root,
    repository,
    store,
    tasks,
    sessions,
    events,
    notifications,
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
async function acceptPlan(
  f: ReturnType<typeof fixture>,
  planID: ReturnType<typeof crypto.randomUUID>,
) {
  await runPlan(f, planID, `run-${planID}`)
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(planID)[0]!
  f.completeWorker(attempt.session_id)
  await drive(f.runtime, 6)
  const plan = f.store.plan(planID)!
  expect(plan.state).toBe("accepted")
  return { plan, attempt }
}
function includeArtifact(f: ReturnType<typeof fixture>, artifact: string) {
  const head = git(f.root, ["rev-parse", "HEAD"])
  try {
    git(f.root, ["merge-base", "--is-ancestor", artifact, head])
    return
  } catch {
    // The accepted artifact is not present in the selected branch yet.
  }
  try {
    git(f.root, ["merge-base", "--is-ancestor", head, artifact])
    git(f.root, ["merge", "--ff-only", artifact])
    return
  } catch {
    // Independent task branches need a reviewed merge commit.
  }
  git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "merge",
    "--no-edit",
    "--no-ff",
    artifact,
  ])
}
async function recordPlanIntegration(
  f: ReturnType<typeof fixture>,
  planID: ReturnType<typeof crypto.randomUUID>,
  options: { recordTaskLanding?: boolean } = {},
) {
  const accepted = f.store.plan(planID)!
  if (options.recordTaskLanding) {
    const node = f.store.nodes(planID)[0]!
    await f.runtime.command(
      {
        requestID: `task-land-${planID}`,
        planID,
        expectedVersion: accepted.version,
        action: "integrated",
        taskID: node.task_id,
        artifact: node.artifact!,
        targetBranch: "main",
        reason: "Record task-level landing before combined plan integration",
      },
      "owner",
    )
  }
  const plan = f.store.plan(planID)!
  await f.runtime.command(
    {
      requestID: `plan-land-${planID}`,
      planID,
      expectedVersion: plan.version,
      action: "integrated",
      artifact: plan.artifact!,
      targetBranch: "main",
      reason: "Record reviewed combined source integration",
    },
    "owner",
  )
}
async function acceptAndIntegratePlan(
  f: ReturnType<typeof fixture>,
  planID: ReturnType<typeof crypto.randomUUID>,
  options: { recordTaskLanding?: boolean } = {},
) {
  const accepted = await acceptPlan(f, planID)
  includeArtifact(f, accepted.plan.artifact!)
  await recordPlanIntegration(f, planID, options)
  return accepted
}
async function cleanupBlockedFixture() {
  const f = fixture({ commit: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await drive(f.runtime)
  const plan = f.store.plan(f.receipt!.planID)!
  expect(plan.state).toBe("accepted")
  const attempt = f.store.attempts(plan.id)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const artifact = plan.artifact!
  git(f.root, ["merge", "--ff-only", artifact])
  worker.busy = true
  await f.runtime.command(
    {
      requestID: "prepare-cleanup-diagnostics",
      planID: plan.id,
      expectedVersion: plan.version,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Prepare a blocked worker cleanup for diagnostics",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
  return { f, planID: plan.id, attempt, worker, artifact, workspace: attempt.workspace }
}
async function prepareAfterPlanDependency(
  f: ReturnType<typeof fixture>,
  requestID: string,
  priority = 10,
) {
  const parentID = f.receipt.planID
  const childTask = f.createTask("b", "b.txt")
  const child = f.store.submit(
    {
      ...f.inputFor([childTask], { requestID }),
      afterPlans: [parentID],
      priority,
    },
    "owner",
  )
  await runPlan(f, child.planID, `${requestID}-run`)
  const accepted = await acceptPlan(f, parentID)
  includeArtifact(f, accepted.plan.artifact!)
  await recordPlanIntegration(f, parentID)
  return { parentID, child, accepted }
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

test("lost prompt response after a committed worker turn reconciles through verification", async () => {
  const f = fixture({
    independent: true,
    delayed: false,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { child } = await prepareAfterPlanDependency(f, "lost-committed-child-prompt")
  const original = f.host.prompt
  f.host.prompt = async (input) => {
    await original(input)
    throw new Error("committed prompt response lost")
  }

  await f.runtime.tick()
  const attempt = f.store.attempts(child.planID)[0]!
  const originalPrompt = attempt.message_id
  expect(f.store.plan(child.planID)?.state).toBe("blocked")
  expect(attempt.state).toBe("preparing")
  expect(git(attempt.workspace, ["rev-parse", "HEAD"])).not.toBe(attempt.base_commit)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)

  await f.runtime.tick()
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "prompt")?.state).toBe(
    "completed",
  )
  await f.runtime.command(
    {
      requestID: "reconcile-lost-committed-child-prompt",
      planID: child.planID,
      expectedVersion: f.store.plan(child.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 8)

  expect(f.store.plan(child.planID)?.state).toBe("accepted")
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(f.store.attempts(child.planID)[0]).toMatchObject({ id: attempt.id, state: "accepted" })
  expect(git(attempt.workspace, ["rev-parse", "HEAD"])).not.toBe(attempt.base_commit)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
  expect(f.events.filter((event) => event === `prompt:${originalPrompt}`)).toHaveLength(1)
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

test("a cancelled afterPlans child resumes its retained committed attempt", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { child } = await prepareAfterPlanDependency(f, "resume-committed-child")
  await f.runtime.tick()
  const attempt = f.store.attempts(child.planID)[0]!
  const originalPromptID = attempt.message_id
  const originalHead = git(attempt.workspace, ["rev-parse", "HEAD"])
  expect(originalHead).not.toBe(attempt.base_commit)
  expect(f.store.attempts(child.planID)).toHaveLength(1)

  await f.runtime.command(
    {
      requestID: "cancel-committed-child",
      planID: child.planID,
      expectedVersion: f.store.plan(child.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(child.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(child.planID)[0]).toMatchObject({ id: attempt.id, state: "cancelled" })

  await f.runtime.command(
    {
      requestID: "resume-committed-child-attempt",
      planID: child.planID,
      expectedVersion: f.store.plan(child.planID)!.version,
      action: "resume",
      taskID: attempt.task_id,
      reason: "Continue the committed work in its retained workspace",
    },
    "owner",
  )
  await f.runtime.tick()
  const resumed = f.store.attempts(child.planID)[0]!
  expect(resumed).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
    state: "running",
    base_commit: attempt.base_commit,
  })
  expect(git(resumed.workspace, ["rev-parse", "HEAD"])).toBe(originalHead)
  expect(git(resumed.workspace, ["rev-parse", "HEAD"])).not.toBe(resumed.base_commit)
  const promptIDs = f.events
    .filter((event) => event.startsWith("prompt:"))
    .map((event) => event.slice(7))
  expect(promptIDs).toHaveLength(3)
  expect(promptIDs.filter((id) => id === originalPromptID)).toHaveLength(1)
  expect(resumed.message_id).not.toBe(originalPromptID)

  f.completeWorker(resumed.session_id)
  await drive(f.runtime, 8)
  expect(f.store.plan(child.planID)?.state).toBe("accepted")
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(f.store.attempts(child.planID)[0]?.state).toBe("accepted")
  expect(
    f.events.filter((event) => event.startsWith("prompt:")).map((event) => event.slice(7)),
  ).toEqual(promptIDs)
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

test("cleanup retries require detailed worker inactivity and never rerun product checks", async () => {
  const f = fixture({ commit: true })
  await runPlan(f)
  await drive(f.runtime)
  const plan = f.store.plan(f.receipt.planID)!
  const artifact = plan.artifact!
  const attempt = f.store.attempts(plan.id)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalBackground = structuredClone(worker.background)
  const worktree = attempt.workspace
  const checksBefore = f.store
    .effects(plan.id)
    .filter(
      (effect) => effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:"),
    )
    .map((effect) => [effect.id, effect.state, effect.receipt])
  const workerAdmissionsBefore = f.events.filter((event) => /^(create|prompt):/.test(event)).length
  git(f.root, ["merge", "--ff-only", artifact])

  const retryCleanup = async (requestID: string) => {
    await f.runtime.command(
      {
        requestID,
        planID: plan.id,
        expectedVersion: f.store.plan(plan.id)!.version,
        action: "integrated",
        artifact,
        targetBranch: "main",
        reason: "Retry cleanup after the worker was observed idle",
      },
      "owner",
    )
    await f.runtime.tick()
    expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
    expect(await f.host.worktrees()).toContain(worktree)
  }

  f.sessions.delete(attempt.session_id)
  await retryCleanup("cleanup-missing-session")
  f.sessions.set(attempt.session_id, worker)
  worker.pendingInput = true
  await retryCleanup("cleanup-pending-input")
  worker.pendingInput = false
  worker.pendingPermissions = 1
  await retryCleanup("cleanup-pending-permission")
  worker.pendingPermissions = 0
  worker.pendingForms = 1
  await retryCleanup("cleanup-pending-form")
  worker.pendingForms = 0
  worker.observationUnstable = true
  await retryCleanup("cleanup-unstable-observation")
  worker.observationUnstable = false
  worker.background = {
    state: "unknown",
    source: "experimental.idle",
    reason: "fixture cannot establish worker quiescence",
  }
  await retryCleanup("cleanup-unknown-background")

  worker.background = originalBackground
  delete worker.pendingInput
  delete worker.pendingPermissions
  delete worker.pendingForms
  await f.runtime.command(
    {
      requestID: "cleanup-conclusive-idle",
      planID: plan.id,
      expectedVersion: f.store.plan(plan.id)!.version,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Detailed native observation confirms cleanup is safe",
    },
    "owner",
  )
  await f.runtime.tick()

  expect(f.store.plan(plan.id)?.state).toBe("integrated")
  expect(await f.host.worktrees()).not.toContain(worktree)
  expect(
    f.store
      .effects(plan.id)
      .filter(
        (effect) => effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:"),
      )
      .map((effect) => [effect.id, effect.state, effect.receipt]),
  ).toEqual(checksBefore)
  expect(f.events.filter((event) => /^(create|prompt):/.test(event)).length).toBe(
    workerAdmissionsBefore,
  )
})

test("cleanup audit reports the first sampled worker blocker without exposing observed identity details", async () => {
  const { f, planID, attempt, worker } = await cleanupBlockedFixture()
  const valid = structuredClone(worker)
  valid.busy = false
  const sessionCalls: { id: string; options?: { messages?: boolean } }[] = []
  const originalSession = f.host.session
  f.host.session = async (id, options) => {
    sessionCalls.push({ id, options })
    return originalSession(id, options)
  }
  type Diagnostic = {
    binding: {
      projectID: string
      planID: string
      attemptID: string
      sessionID: string
      workspace: string
      assignedMessageID: string
    }
    firstBlocker: { stage: string; code: string } | null
    planVersion: number
    sampledAt: number
    stages: Array<{ stage: string; status: string; code?: string }>
  }
  const auditedWorker = (result: unknown) => {
    const diagnostics = (result as { cleanupDiagnostics?: { workers?: Diagnostic[] } })
      .cleanupDiagnostics
    expect(diagnostics?.workers).toHaveLength(1)
    return diagnostics!.workers![0]!
  }
  const audit = (requestID: string) =>
    f.runtime.command(
      {
        requestID,
        planID,
        expectedVersion: f.store.plan(planID)!.version,
        action: "audit",
      },
      "observer",
    )
  const sample = async (
    requestID: string,
    change?: (session: HostSession) => void,
  ): Promise<Diagnostic> => {
    const session = structuredClone(valid)
    change?.(session)
    f.sessions.set(attempt.session_id, session)
    return auditedWorker(await audit(requestID))
  }
  const cases: Array<{
    name: string
    stage: string
    code: string
    change?: (session: HostSession) => void
    absent?: boolean
    unavailable?: boolean
  }> = [
    { name: "read failure", stage: "session-read", code: "read-unavailable", unavailable: true },
    { name: "absent session", stage: "session-read", code: "session-absent", absent: true },
    {
      name: "session identity",
      stage: "session-id",
      code: "session-id-mismatch",
      change: (session) => (session.id = "foreign-session-detail"),
    },
    {
      name: "project identity",
      stage: "project-id",
      code: "project-id-mismatch",
      change: (session) => (session.projectID = "foreign-project-detail"),
    },
    {
      name: "directory identity",
      stage: "directory",
      code: "directory-mismatch",
      change: (session) => (session.directory = "/foreign/workspace-detail"),
    },
    {
      name: "agent identity",
      stage: "agent",
      code: "agent-mismatch",
      change: (session) => (session.agent = "foreign-agent-detail"),
    },
    {
      name: "attempt identity",
      stage: "attempt-id",
      code: "attempt-id-mismatch",
      change: (session) =>
        (session.metadata = { ...session.metadata, lazersAttemptID: "foreign-attempt-detail" }),
    },
    {
      name: "foreground activity",
      stage: "foreground",
      code: "foreground-busy",
      change: (session) => (session.busy = true),
    },
    {
      name: "pending input",
      stage: "pending-input",
      code: "pending-input",
      change: (session) => (session.pendingInput = true),
    },
    {
      name: "unstable observation",
      stage: "observation-stability",
      code: "observation-unstable",
      change: (session) => (session.observationUnstable = true),
    },
    {
      name: "pending permission",
      stage: "pending-permissions",
      code: "pending-permissions",
      change: (session) => (session.pendingPermissions = 1),
    },
    {
      name: "pending form",
      stage: "pending-forms",
      code: "pending-forms",
      change: (session) => (session.pendingForms = 1),
    },
    {
      name: "missing outcome",
      stage: "outcome",
      code: "outcome-absent",
      change: (session) => {
        delete session.outcome
      },
    },
    {
      name: "missing turn",
      stage: "turn",
      code: "turn-absent",
      change: (session) => {
        delete session.turn
      },
    },
    {
      name: "pending turn",
      stage: "turn",
      code: "turn-pending",
      change: (session) => {
        session.turn = { inputID: attempt.message_id, state: "pending" }
      },
    },
    {
      name: "unknown turn",
      stage: "turn",
      code: "turn-unknown",
      change: (session) => {
        session.turn = { inputID: attempt.message_id, state: "unknown" }
      },
    },
    {
      name: "missing background observation",
      stage: "background",
      code: "background-absent",
      change: (session) => {
        delete session.background
      },
    },
    {
      name: "unknown background observation",
      stage: "background",
      code: "background-unknown",
      change: (session) => {
        session.background = {
          state: "unknown",
          source: "experimental.idle",
          reason: "credential=private-background-detail",
        }
      },
    },
    {
      name: "assigned input mismatch",
      stage: "assigned-input",
      code: "assigned-input-mismatch",
      change: (session) => {
        if (session.background?.state === "observed")
          session.background.inputID = "foreign-input-detail"
      },
    },
    {
      name: "turn input mismatch",
      stage: "turn-input",
      code: "turn-input-mismatch",
      change: (session) => {
        if (session.turn) session.turn.inputID = "foreign-turn-input-detail"
      },
    },
    {
      name: "positive background count",
      stage: "background-count",
      code: "positive-background-count",
      change: (session) => {
        if (session.background?.state === "observed") session.background.count = 1
      },
    },
  ]

  for (const [index, item] of cases.entries()) {
    if (item.absent) f.sessions.delete(attempt.session_id)
    else {
      const session = structuredClone(valid)
      item.change?.(session)
      f.sessions.set(attempt.session_id, session)
    }
    const read = f.host.session
    if (item.unavailable) {
      f.host.session = async () => {
        throw new Error("Authorization: Bearer private-secret")
      }
    }
    const diagnostic = auditedWorker(
      await audit(`cleanup-audit-stage-${index}-${item.name.replaceAll(" ", "-")}`),
    )
    f.host.session = read
    expect(diagnostic.firstBlocker).toEqual({ stage: item.stage, code: item.code })
    const blockedIndex = diagnostic.stages.findIndex((stage) => stage.stage === item.stage)
    expect(diagnostic.stages[blockedIndex]).toMatchObject({ status: "blocked", code: item.code })
    expect(
      diagnostic.stages.slice(0, blockedIndex).every((stage) => stage.status === "passed"),
    ).toBe(true)
    expect(
      diagnostic.stages.slice(blockedIndex + 1).every((stage) => stage.status === "not-evaluated"),
    ).toBe(true)
    expect(diagnostic.binding).toEqual({
      projectID: "project",
      planID,
      attemptID: attempt.id,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      assignedMessageID: attempt.message_id,
    })
    expect(diagnostic.planVersion).toBe(f.store.plan(planID)!.version)
    expect(diagnostic.sampledAt).toBeGreaterThan(0)
    const serialized = JSON.stringify(diagnostic)
    expect(serialized).not.toContain("foreign-session-detail")
    expect(serialized).not.toContain("foreign-project-detail")
    expect(serialized).not.toContain("foreign/workspace-detail")
    expect(serialized).not.toContain("foreign-agent-detail")
    expect(serialized).not.toContain("foreign-attempt-detail")
    expect(serialized).not.toContain("private-secret")
    expect(serialized).not.toContain("private-background-detail")
    if (item.absent) f.sessions.set(attempt.session_id, structuredClone(valid))
  }

  for (const state of ["completed", "interrupted"] as const) {
    const diagnostic = await sample(`cleanup-audit-zero-${state}`, (session) => {
      session.outcome = state === "completed" ? "succeeded" : "interrupted"
      session.turn = { inputID: attempt.message_id, state }
      if (session.background?.state === "observed") session.background.count = 0
    })
    expect(diagnostic.firstBlocker).toBeNull()
    expect(diagnostic.stages.every((stage) => stage.status === "passed")).toBe(true)
  }
  expect(
    sessionCalls.every((call) => call.id === attempt.session_id && call.options?.messages === true),
  ).toBe(true)
})

test("cleanup audit is neutral, receipt-safe, and later requests sample fresh observations", async () => {
  const { f, planID, attempt, worker } = await cleanupBlockedFixture()
  const planBefore = f.store.plan(planID)!
  const detailBefore = f.store.detail(planID)
  const notificationsBefore = f.notifications.length
  const eventsBefore = [...f.events]
  const sessionCalls: { id: string; options?: { messages?: boolean } }[] = []
  let worktreeReads = 0
  let removals = 0
  const originalSession = f.host.session
  const originalWorktrees = f.host.worktrees
  const originalRemove = f.host.removeWorktree
  f.host.session = async (id, options) => {
    sessionCalls.push({ id, options })
    return originalSession(id, options)
  }
  f.host.worktrees = async () => {
    worktreeReads++
    return originalWorktrees()
  }
  f.host.removeWorktree = async (workspace) => {
    removals++
    return originalRemove(workspace)
  }
  const input = {
    requestID: "cleanup-audit-replay",
    planID,
    expectedVersion: planBefore.version,
    action: "audit" as const,
  }
  const first = await f.runtime.command(input, "observer")
  const firstDiagnostic = (
    first as {
      cleanupDiagnostics: { diagnosticOnly: true; workers: Array<{ firstBlocker: unknown }> }
    }
  ).cleanupDiagnostics
  expect(firstDiagnostic.diagnosticOnly).toBe(true)
  expect(firstDiagnostic.workers[0]?.firstBlocker).toEqual({
    stage: "foreground",
    code: "foreground-busy",
  })
  const detailAfter = f.store.detail(planID)
  expect(detailAfter.plan).toEqual(detailBefore.plan)
  expect(detailAfter.nodes).toEqual(detailBefore.nodes)
  expect(detailAfter.attempts).toEqual(detailBefore.attempts)
  expect(detailAfter.effects).toEqual(detailBefore.effects)
  expect(detailAfter.adoptions).toEqual(detailBefore.adoptions)
  expect(detailAfter.adoptionChecks).toEqual(detailBefore.adoptionChecks)
  expect(detailAfter.adoptionEvidence).toEqual(detailBefore.adoptionEvidence)
  expect(detailAfter.evidence).toEqual(detailBefore.evidence)
  expect(detailAfter.activity).toEqual(detailBefore.activity)
  expect(detailAfter.delivery).toEqual(detailBefore.delivery)
  expect(f.store.plan(planID)).toEqual(planBefore)
  expect(f.notifications).toHaveLength(notificationsBefore)
  expect(f.events).toEqual(eventsBefore)
  expect(sessionCalls).toEqual([{ id: attempt.session_id, options: { messages: true } }])
  expect(worktreeReads).toBe(0)
  expect(removals).toBe(0)

  const idle = structuredClone(worker)
  idle.busy = false
  f.sessions.set(attempt.session_id, idle)
  expect(await f.runtime.command(input, "observer")).toEqual(first)
  expect(sessionCalls).toHaveLength(1)
  const fresh = await f.runtime.command({ ...input, requestID: "cleanup-audit-fresh" }, "observer")
  expect(
    (fresh as { cleanupDiagnostics: { workers: Array<{ firstBlocker: unknown }> } })
      .cleanupDiagnostics.workers[0]?.firstBlocker,
  ).toBeNull()
  expect(sessionCalls).toHaveLength(2)
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cleanup-blocked")
  expect(worktreeReads).toBe(0)
  expect(removals).toBe(0)
  expect(f.notifications).toHaveLength(notificationsBefore)
})

test("cleanup audit publication rejects a concurrent plan-version change", async () => {
  const { f, planID, attempt, artifact } = await cleanupBlockedFixture()
  const version = f.store.plan(planID)!.version
  let started!: () => void
  let release!: () => void
  const sampleStarted = new Promise<void>((resolve) => (started = resolve))
  const sampleGate = new Promise<void>((resolve) => (release = resolve))
  const originalSession = f.host.session
  f.host.session = async (id, options) => {
    started()
    await sampleGate
    return originalSession(id, options)
  }
  const auditInput = {
    requestID: "cleanup-audit-stale",
    planID,
    expectedVersion: version,
    action: "audit" as const,
  }
  const pendingAudit = f.runtime.command(auditInput, "owner")
  await sampleStarted
  await f.runtime.command(
    {
      requestID: "cleanup-audit-race-integrate",
      planID,
      expectedVersion: version,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Advance the cleanup plan while diagnostics are being sampled",
    },
    "owner",
  )
  release()
  await expect(pendingAudit).rejects.toThrow(`Stale plan version; current ${version + 1}`)
  expect(f.store.plan(planID)?.state).toBe("cleaning")
  expect(
    f.store.priorCommand("cleanup-audit-stale", { command: auditInput, caller: "owner" }),
  ).toBeUndefined()
  expect(f.store.effects(planID).some((effect) => effect.kind === "worktree-remove")).toBe(true)
  expect(f.store.attempts(planID).some((item) => item.id === attempt.id)).toBe(true)
})

test("a successful cleanup diagnostic cannot bypass changed worker lineage", async () => {
  const { f, planID, attempt, worker, artifact, workspace } = await cleanupBlockedFixture()
  const idle = structuredClone(worker)
  idle.busy = false
  f.sessions.set(attempt.session_id, idle)
  const version = f.store.plan(planID)!.version
  const diagnostic = await f.runtime.command(
    {
      requestID: "cleanup-audit-clear-before-lineage-change",
      planID,
      expectedVersion: version,
      action: "audit",
    },
    "observer",
  )
  expect(
    (diagnostic as { cleanupDiagnostics: { workers: Array<{ firstBlocker: unknown }> } })
      .cleanupDiagnostics.workers[0]?.firstBlocker,
  ).toBeNull()
  const changed = structuredClone(idle)
  if (changed.turn) changed.turn.inputID = "different-after-diagnostic"
  f.sessions.set(attempt.session_id, changed)
  let removals = 0
  const originalRemove = f.host.removeWorktree
  f.host.removeWorktree = async (directory) => {
    removals++
    return originalRemove(directory)
  }
  await f.runtime.command(
    {
      requestID: "cleanup-retry-after-lineage-change",
      planID,
      expectedVersion: version,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Retry cleanup using a fresh native observation",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cleanup-blocked")
  expect(f.store.plan(planID)?.reason).toContain("worker activity is not conclusively idle")
  expect(existsSync(workspace)).toBe(true)
  expect(removals).toBe(0)
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

test("afterPlans dispatches from combined integration while prerequisite cleanup is still pending", async () => {
  for (const expectedParentState of ["cleaning", "cleanup-blocked"] as const) {
    const f = fixture({
      independent: true,
      delayed: true,
      commit: true,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    const parentID = f.receipt.planID
    const childTask = f.createTask("b", "b.txt")
    const child = f.store.submit(
      {
        ...f.inputFor([childTask], { requestID: `dependent-${expectedParentState}` }),
        afterPlans: [parentID],
        priority: expectedParentState === "cleaning" ? 10 : -10,
      },
      "owner",
    )
    await runPlan(f, child.planID, `run-child-${expectedParentState}`)
    const accepted = await acceptPlan(f, parentID)
    const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
    writeFileSync(sentinel, "still owned")
    includeArtifact(f, accepted.plan.artifact!)
    await recordPlanIntegration(f, parentID, { recordTaskLanding: true })
    expect(f.store.plan(parentID)!.state).toBe("cleaning")

    const observations: { parentState: string; workspace: string; source: string }[] = []
    const originalPrompt = f.host.prompt
    f.host.prompt = async (input) => {
      const parent = f.store.plan(parentID)!
      expect(existsSync(accepted.attempt.workspace)).toBe(true)
      expect(readFileSync(sentinel, "utf8")).toBe("still owned")
      expect(input.directory).not.toBe(accepted.attempt.workspace)
      expect(readFileSync(join(input.directory, "a.txt"), "utf8")).toBe("a")
      observations.push({
        parentState: parent.state,
        workspace: input.directory,
        source: git(input.directory, ["rev-parse", "HEAD"]),
      })
      await originalPrompt(input)
    }

    await f.runtime.tick()
    expect(observations).toHaveLength(1)
    expect(observations[0]!.parentState).toBe(expectedParentState)
    expect(observations[0]!.source).toBe(accepted.plan.artifact!)
    expect(f.store.plan(parentID)!.state).toBe("cleanup-blocked")
    const childAttempt = f.store.attempts(child.planID)[0]!
    expect(childAttempt.workspace).toBe(observations[0]!.workspace)
    expect(childAttempt.workspace).not.toBe(accepted.attempt.workspace)
    expect(childAttempt.base_commit).toBe(accepted.plan.artifact!)
  }
})

test("afterPlans rejects a legacy cleanup snapshot after durable prerequisite cancellation", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { parentID, child } = await prepareAfterPlanDependency(f, "legacy-cancelled-prerequisite")
  await f.runtime.command(
    {
      requestID: "cancel-integrated-prerequisite",
      planID: parentID,
      expectedVersion: f.store.plan(parentID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(parentID)?.state).toBe("cancelled")

  // An older persisted view can still report cleanup-blocked. The durable
  // cancellation transition must invalidate its earlier acceptance/integration.
  f.store.atomic((db) => {
    db.query(
      "UPDATE runner_plans SET state='cleanup-blocked',reason=?,version=version+1 WHERE id=?",
    ).run("Legacy cleanup-blocked snapshot", parentID)
  })
  const promptsBefore = f.events.filter((event) => event.startsWith("prompt:")).length
  await f.runtime.tick()

  expect(f.store.attempts(child.planID)).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptsBefore)
})

test("afterPlans cleanup cannot publish over cancellation or reuse the historical integration proof", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { parentID, child, accepted } = await prepareAfterPlanDependency(f, "cancel-cleanup", -10)
  const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(sentinel, "still owned")
  const originalSession = f.host.session
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.session = async (id, options) => {
    if (id === accepted.attempt.session_id && options?.messages) {
      enter()
      await blocked
    }
    return originalSession(id, options)
  }

  const cleanup = f.runtime.tick()
  await entered
  await f.runtime.command(
    {
      requestID: "cancel-during-cleanup",
      planID: parentID,
      expectedVersion: f.store.plan(parentID)!.version,
      action: "cancel",
    },
    "owner",
  )
  release()
  await cleanup

  expect(f.store.plan(parentID)?.state).toBe("cancelling")
  expect(f.store.plan(parentID)?.artifact).toBe(accepted.plan.artifact)
  expect(
    f.store.latestTransition<{ artifact?: string }>(parentID, null, "INTEGRATION_RECORDED")
      ?.artifact,
  ).toBe(accepted.plan.artifact!)
  expect(f.store.attempts(child.planID)).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(existsSync(accepted.attempt.workspace)).toBe(true)
  expect(readFileSync(sentinel, "utf8")).toBe("still owned")
  expect(await f.host.worktrees()).toContain(accepted.attempt.workspace)

  await f.runtime.tick()
  expect(f.store.plan(parentID)?.state).toBe("cancelled")
  expect(f.store.attempts(child.planID)).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test("afterPlans invalidation during child worktree creation keeps the owned workspace and suppresses prompt admission", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { parentID, child, accepted } = await prepareAfterPlanDependency(f, "cancel-worktree")
  const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(sentinel, "still owned")
  const originalWorktree = f.host.worktree
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.worktree = async (input) => {
    if (input.base === accepted.plan.artifact) {
      enter()
      await blocked
    }
    return originalWorktree(input)
  }

  const dispatch = f.runtime.tick()
  await entered
  await f.runtime.command(
    {
      requestID: "cancel-parent-during-child-worktree",
      planID: parentID,
      expectedVersion: f.store.plan(parentID)!.version,
      action: "cancel",
    },
    "owner",
  )
  release()
  await dispatch

  const attempt = f.store.attempts(child.planID)[0]!
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(attempt.state).toBe("preparing")
  expect(attempt.base_commit).toBe(accepted.plan.artifact!)
  expect(existsSync(attempt.workspace)).toBe(true)
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "worktree")?.state).toBe(
    "completed",
  )
  expect(f.store.effects(child.planID).some((effect) => effect.kind === "session")).toBe(false)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(readFileSync(sentinel, "utf8")).toBe("still owned")
  expect(await f.host.worktrees()).toContain(accepted.attempt.workspace)
  expect(await f.host.worktrees()).toContain(attempt.workspace)

  await drive(f.runtime, 2)
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(existsSync(attempt.workspace)).toBe(true)
})

test("cancelling a child during session creation prevents prompt intent and preserves owned resources", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { child, accepted } = await prepareAfterPlanDependency(f, "cancel-session")
  const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(sentinel, "still owned")
  const originalCreate = f.host.create
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.create = async (input) => {
    enter()
    await blocked
    await originalCreate(input)
  }

  const preparation = f.runtime.tick()
  await entered
  await f.runtime.command(
    {
      requestID: "cancel-child-during-session-create",
      planID: child.planID,
      expectedVersion: f.store.plan(child.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  release()
  await preparation

  const attempt = f.store.attempts(child.planID)[0]!
  expect(f.store.plan(child.planID)?.state).toBe("cancelling")
  expect(attempt.state).toBe("preparing")
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "session")?.state).toBe(
    "completed",
  )
  expect(f.store.effects(child.planID).some((effect) => effect.kind === "prompt")).toBe(false)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(existsSync(attempt.workspace)).toBe(true)
  expect(f.sessions.has(attempt.session_id)).toBe(true)
  expect(readFileSync(sentinel, "utf8")).toBe("still owned")

  await f.runtime.tick()
  expect(f.store.plan(child.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(existsSync(attempt.workspace)).toBe(true)
})

test("afterPlans invalidation during retained preparation reconciliation blocks the later prompt", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { parentID, child, accepted } = await prepareAfterPlanDependency(f, "cancel-reconcile")
  const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(sentinel, "still owned")
  const originalCreate = f.host.create
  let createCalls = 0
  f.host.create = async (input) => {
    createCalls++
    await originalCreate(input)
    throw new Error("session creation reply lost")
  }
  await f.runtime.tick()
  const attempt = f.store.attempts(child.planID)[0]!
  expect(f.store.plan(parentID)?.state).toBe("cleanup-blocked")
  expect(f.store.plan(child.planID)?.state).toBe("blocked")
  expect(attempt.state).toBe("preparing")
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "session")?.state).toBe(
    "uncertain",
  )
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)

  const originalSession = f.host.session
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.session = async (id, options) => {
    if (id === attempt.session_id && !options?.messages) {
      enter()
      await blocked
    }
    return originalSession(id, options)
  }
  const reconciliation = f.runtime.tick()
  await entered
  // Model a legacy cleanup-blocked snapshot after a newer durable cancellation
  // invalidation while the retained effect is read.
  f.store.atomic((db) => {
    db.query(
      "UPDATE runner_plans SET state='cleanup-blocked',reason=?,version=version+1 WHERE id=?",
    ).run("Legacy cleanup snapshot after cancellation", parentID)
    f.store.record(parentID, null, "CANCEL_REQUESTED", {
      caller: "owner",
      phase: "retained-preparation-reconciliation",
    })
  })
  release()
  await reconciliation
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "session")?.state).toBe(
    "completed",
  )
  expect(createCalls).toBe(1)

  await f.runtime.command(
    {
      requestID: "resume-retained-child",
      planID: child.planID,
      expectedVersion: f.store.plan(child.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await f.runtime.tick()

  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(f.store.attempts(child.planID)[0]?.state).toBe("preparing")
  expect(f.store.effects(child.planID).some((effect) => effect.kind === "prompt")).toBe(false)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(existsSync(attempt.workspace)).toBe(true)
  expect(f.sessions.has(attempt.session_id)).toBe(true)
  expect(readFileSync(sentinel, "utf8")).toBe("still owned")
})

test("afterPlans dispatches after genuine combined-check recovery while preserving failed receipts", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    requireVerifierPreparation: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const parentID = f.receipt.planID
  const childTask = f.createTask("b", "b.txt")
  const child = f.store.submit(
    {
      ...f.inputFor([childTask], { requestID: "recovered-child" }),
      afterPlans: [parentID],
      priority: 10,
    },
    "owner",
  )
  await runPlan(f, child.planID, "run-recovered-child")
  await runPlan(f, parentID, "run-recovered-parent")
  await f.runtime.tick()
  const parentAttempt = f.store.attempts(parentID)[0]!
  f.completeWorker(parentAttempt.session_id)
  await drive(f.runtime, 6)

  expect(f.store.plan(parentID)?.state).toBe("blocked")
  expect(f.store.attempts(child.planID)).toHaveLength(0)
  const failedReceipt = f.store
    .effects(parentID)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(failedReceipt.receipt!).check.exitCode).not.toBe(0)
  const failedReceiptSnapshot = [failedReceipt.id, failedReceipt.state, failedReceipt.receipt]

  writeFileSync(join(dirname(f.repository.path), "verifier-ready"), "repaired environment")
  await f.runtime.command(
    {
      requestID: "reconcile-genuine-parent",
      planID: parentID,
      expectedVersion: f.store.plan(parentID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 6)
  const accepted = f.store.plan(parentID)!
  expect(accepted.state).toBe("accepted")
  const recoveredArtifact = accepted.artifact
  if (!recoveredArtifact) throw new Error("Expected genuine combined acceptance artifact")
  const acceptedTransition = f.store.latestTransition<{ artifact: string; checks: CheckReceipt[] }>(
    parentID,
    null,
    "PLAN_ACCEPTED",
  )!
  expect(acceptedTransition.artifact).toBe(recoveredArtifact)
  expect(acceptedTransition.checks.every((check) => check.exitCode === 0)).toBe(true)
  expect(f.store.effects(parentID).find((effect) => effect.id === failedReceipt.id)).toMatchObject({
    id: failedReceiptSnapshot[0],
    state: failedReceiptSnapshot[1],
    receipt: failedReceiptSnapshot[2],
  })

  includeArtifact(f, recoveredArtifact)
  await recordPlanIntegration(f, parentID)
  const parentSentinel = join(parentAttempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(parentSentinel, "still owned")
  await f.runtime.tick()

  expect(f.store.plan(parentID)?.state).toBe("cleanup-blocked")
  const childAttempt = f.store.attempts(child.planID)[0]!
  expect(childAttempt.state).toBe("running")
  expect(childAttempt.base_commit).toBe(recoveredArtifact)
  expect(readFileSync(join(childAttempt.workspace, "a.txt"), "utf8")).toBe("a")
  expect(readFileSync(parentSentinel, "utf8")).toBe("still owned")
  expect(f.events.some((event) => event.startsWith("prompt:"))).toBe(true)
  expect(f.store.effects(parentID).find((effect) => effect.id === failedReceipt.id)).toMatchObject({
    id: failedReceiptSnapshot[0],
    state: failedReceiptSnapshot[1],
    receipt: failedReceiptSnapshot[2],
  })
})

test("afterPlans rejects task-only, missing, malformed, mismatched and foreign integration evidence", async () => {
  for (const invalidation of [
    "missing",
    "task-only",
    "malformed",
    "artifact-mismatch",
    "foreign-prerequisite",
  ] as const) {
    const f = fixture({
      independent: true,
      delayed: true,
      commit: true,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    const parentID = f.receipt.planID
    const childTask = f.createTask("b", "b.txt")
    const child = f.store.submit(
      {
        ...f.inputFor([childTask], { requestID: `invalid-${invalidation}` }),
        afterPlans: [parentID],
        priority: 10,
      },
      "owner",
    )
    await runPlan(f, child.planID, `run-invalid-${invalidation}`)
    const accepted = await acceptPlan(f, parentID)
    includeArtifact(f, accepted.plan.artifact!)

    if (invalidation === "task-only") {
      const node = f.store.nodes(parentID)[0]!
      await f.runtime.command(
        {
          requestID: `task-only-${parentID}`,
          planID: parentID,
          expectedVersion: f.store.plan(parentID)!.version,
          action: "integrated",
          taskID: node.task_id,
          artifact: node.artifact!,
          targetBranch: "main",
          reason: "Record task landing without combined plan integration",
        },
        "owner",
      )
    } else await recordPlanIntegration(f, parentID)

    f.store.atomic((db) => {
      if (invalidation === "missing")
        db.query(
          "DELETE FROM runner_transitions WHERE plan_id=? AND task_id IS NULL AND event='INTEGRATION_RECORDED'",
        ).run(parentID)
      if (invalidation === "malformed" || invalidation === "artifact-mismatch") {
        const receipt = db
          .query<{ id: number; payload: string }, [string]>(
            "SELECT id,payload FROM runner_transitions WHERE plan_id=? AND task_id IS NULL AND event='INTEGRATION_RECORDED' ORDER BY id DESC LIMIT 1",
          )
          .get(parentID)
        if (receipt && invalidation === "malformed")
          db.query("UPDATE runner_transitions SET payload=? WHERE id=?").run("{broken", receipt.id)
        else if (receipt) {
          const payload = JSON.parse(receipt.payload) as Record<string, unknown>
          payload.artifact = f.base
          db.query("UPDATE runner_transitions SET payload=? WHERE id=?").run(
            JSON.stringify(payload),
            receipt.id,
          )
        }
      }
      if (invalidation === "foreign-prerequisite") {
        const body = JSON.parse(f.store.plan(child.planID)!.body) as Record<string, unknown>
        body.afterPlans = [crypto.randomUUID()]
        db.query("UPDATE runner_plans SET body=? WHERE id=?").run(
          JSON.stringify(body),
          child.planID,
        )
      }
      // A lifecycle label cannot stand in for a combined integration receipt.
      db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(parentID)
    })
    const promptsBefore = f.events.filter((event) => event.startsWith("prompt:")).length
    await f.runtime.tick()
    expect(f.store.attempts(child.planID)).toHaveLength(0)
    expect(f.events.filter((event) => event.startsWith("prompt:")).length).toBe(promptsBefore)
  }
})

test("afterPlans requires both the integrated artifact and its recorded integration head in selected HEAD", async () => {
  for (const missingSource of ["integration-head", "artifact"] as const) {
    const f = fixture({
      independent: true,
      delayed: true,
      commit: true,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    const parentID = f.receipt.planID
    const childTask = f.createTask("b", "b.txt")
    const child = f.store.submit(
      {
        ...f.inputFor([childTask], { requestID: `missing-${missingSource}` }),
        afterPlans: [parentID],
        priority: 10,
      },
      "owner",
    )
    await runPlan(f, child.planID, `run-missing-${missingSource}`)
    const accepted = await acceptPlan(f, parentID)
    includeArtifact(f, accepted.plan.artifact!)
    if (missingSource === "integration-head") {
      writeFileSync(join(f.root, "after-integration.txt"), "later baseline\n")
      git(f.root, ["add", "after-integration.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "later selected baseline",
      ])
    }
    await recordPlanIntegration(f, parentID)
    git(f.root, [
      "reset",
      "--hard",
      missingSource === "artifact" ? f.base : accepted.plan.artifact!,
    ])
    f.store.atomic((db) =>
      db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(parentID),
    )

    await expect(f.runtime.tick()).resolves.toBeUndefined()
    expect(f.store.attempts(child.planID)).toHaveLength(0)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  }
})

test("every afterPlans prerequisite needs genuine fresh acceptance and integration after cancellation", async () => {
  const f = fixture({ independent: true, delayed: true, commit: true, startOnly: true })
  const parentA = f.store.submit(f.inputFor([f.tasks[0]!], { requestID: "parent-a" }), "owner")
  const parentB = f.store.submit(f.inputFor([f.tasks[1]!], { requestID: "parent-b" }), "owner")
  const childTask = f.createTask("c", "c.txt")
  const child = f.store.submit(
    {
      ...f.inputFor([childTask], { requestID: "all-prerequisites" }),
      afterPlans: [parentA.planID, parentB.planID],
      priority: 10,
    },
    "owner",
  )
  await runPlan(f, child.planID, "run-all-prerequisites")
  await acceptAndIntegratePlan(f, parentA.planID)
  await acceptAndIntegratePlan(f, parentB.planID)

  const beforeCancel = f.store.plan(parentB.planID)!
  await f.runtime.command(
    {
      requestID: "cancel-integrated-parent",
      planID: parentB.planID,
      expectedVersion: beforeCancel.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(parentB.planID)!.state).toBe("cancelled")
  expect(f.store.attempts(child.planID)).toHaveLength(0)
  const transitionID = (event: string) =>
    f.store.atomic(
      (db) =>
        db
          .query<{ id: number }, [string, string]>(
            "SELECT id FROM runner_transitions WHERE plan_id=? AND task_id IS NULL AND event=? ORDER BY id DESC LIMIT 1",
          )
          .get(parentB.planID, event)?.id ?? 0,
    )
  const cancellationID = transitionID("CANCEL_REQUESTED")

  f.store.atomic((db) => {
    db.query(
      "UPDATE runner_plans SET state='cleanup-blocked',reason=?,version=version+1 WHERE id=?",
    ).run("Legacy cleanup snapshot after cancellation", parentB.planID)
  })
  await f.runtime.tick()
  expect(f.store.attempts(child.planID)).toHaveLength(0)

  // Re-enter explicit reconciliation from a recovered blocked snapshot. The
  // runtime must produce new combined-check evidence before dependent work resumes.
  f.store.atomic((db) => {
    db.query("UPDATE runner_plans SET state='blocked',reason=?,version=version+1 WHERE id=?").run(
      "Recovered prerequisite requires fresh verification",
      parentB.planID,
    )
  })
  await f.runtime.command(
    {
      requestID: "reconcile-cancelled-prerequisite",
      planID: parentB.planID,
      expectedVersion: f.store.plan(parentB.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 6)
  const refreshed = f.store.plan(parentB.planID)!
  expect(refreshed.state).toBe("accepted")
  const refreshedArtifact = refreshed.artifact
  if (!refreshedArtifact) throw new Error("Expected refreshed prerequisite artifact")
  const accepted = f.store.latestTransition<{ artifact: string; checks: CheckReceipt[] }>(
    parentB.planID,
    null,
    "PLAN_ACCEPTED",
  )!
  expect(accepted.artifact).toBe(refreshedArtifact)
  expect(accepted.checks.length).toBeGreaterThan(0)
  expect(accepted.checks.every((check) => check.exitCode === 0 && !check.timedOut)).toBe(true)
  const acceptanceID = transitionID("PLAN_ACCEPTED")
  expect(acceptanceID).toBeGreaterThan(cancellationID)
  includeArtifact(f, refreshedArtifact)
  await f.runtime.command(
    {
      requestID: "fresh-integrated-parent-after-reacceptance",
      planID: parentB.planID,
      expectedVersion: refreshed.version,
      action: "integrated",
      artifact: refreshedArtifact,
      targetBranch: "main",
      reason: "Review the freshly verified combined source after cancellation recovery",
    },
    "owner",
  )
  expect(transitionID("INTEGRATION_RECORDED")).toBeGreaterThan(acceptanceID)
  await f.runtime.tick()
  const childAttempt = f.store.attempts(child.planID)[0]!
  expect(childAttempt).toBeDefined()
  const integration = f.store.latestTransition<{ head: string }>(
    parentB.planID,
    null,
    "INTEGRATION_RECORDED",
  )
  if (!integration?.head) throw new Error("Expected refreshed prerequisite integration head")
  expect(childAttempt.base_commit).toBe(integration.head)
  expect(git(childAttempt.workspace, ["rev-parse", "HEAD"])).not.toBe(childAttempt.base_commit)
  expect(readFileSync(join(childAttempt.workspace, "a.txt"), "utf8")).toBe("a")
  expect(readFileSync(join(childAttempt.workspace, "b.txt"), "utf8")).toBe("b")
})

test("valid afterPlans integration does not bypass shared-checkout admission", async () => {
  const f = fixture({
    shared: true,
    independent: true,
    delayed: true,
    commit: true,
    startOnly: true,
    taskFiles: [
      { name: "a", path: "a.txt" },
      { name: "b", path: "b.txt" },
      { name: "c", path: "c.txt" },
    ],
  })
  const prerequisite = f.store.submit(
    f.inputFor([f.tasks[0]!], { requestID: "shared-parent" }),
    "owner",
  )
  const blocker = f.store.submit(
    f.inputFor([f.tasks[1]!], { requestID: "shared-blocker" }),
    "owner",
  )
  const dependent = f.store.submit(
    {
      ...f.inputFor([f.tasks[2]!], { requestID: "shared-dependent" }),
      afterPlans: [prerequisite.planID],
    },
    "owner",
  )
  await acceptAndIntegratePlan(f, prerequisite.planID)
  await runPlan(f, blocker.planID, "run-shared-blocker")
  await runPlan(f, dependent.planID, "run-shared-dependent")
  await f.runtime.tick()
  expect(f.store.attempts(blocker.planID)).toHaveLength(1)
  expect(f.store.attempts(dependent.planID)).toHaveLength(0)
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
  worker.turn = { inputID: attempt.message_id, state: "completed" }
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
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  await f.runtime.tick()
  expect(calls.find((call) => call.id === attempt.session_id)?.messages).toBe(false)
  expect(calls.some((call) => call.id === attempt.session_id && call.messages)).toBe(true)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")

  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)[0]!.tool_count).toBe(9)
})

test.each(["interrupted", "succeeded", "missing"] as const)(
  "cancellation wins over a stale %s detailed worker observation",
  async (result) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await f.runtime.tick()
    const planID = f.receipt.planID
    const attempt = f.store.attempts(planID)[0]!
    const worker = f.sessions.get(attempt.session_id)!
    worker.busy = false
    worker.outcome = result === "succeeded" ? "succeeded" : "interrupted"
    worker.turn = { inputID: attempt.message_id, state: "interrupted" }
    worker.background = {
      state: "unknown",
      source: "experimental.idle",
      reason: "Host restarted before observing an idle report",
    }
    const originalSession = f.host.session
    let raced = false
    f.host.session = async (id, options) => {
      const snapshot = await originalSession(id, options)
      if (id === worker.id && options?.messages && !raced) {
        raced = true
        await f.runtime.command(
          {
            requestID: `cancel-during-${result}-detail`,
            planID,
            expectedVersion: f.store.plan(planID)!.version,
            action: "cancel",
          },
          "owner",
        )
        return result === "missing" ? null : snapshot
      }
      return snapshot
    }

    const prompts = f.events.filter((event) => event.startsWith("prompt:")).length
    await f.runtime.tick()
    expect(raced).toBe(true)
    expect(f.store.plan(planID)?.state).toBe("cancelled")
    expect(f.store.attempts(planID)).toHaveLength(1)
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: attempt.id,
      state: "cancelled",
      session_id: attempt.session_id,
      workspace: attempt.workspace,
    })
    expect(existsSync(attempt.workspace)).toBe(true)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(prompts)
    expect(f.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(false)
  },
)

test("terminal verification waits for active foreground, exact input completion, and background settlement", async () => {
  const f = fixture({ delayed: true, repair: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalSession = f.host.session
  const baseHead = git(f.root, ["rev-parse", "HEAD"])

  // A stale succeeded value after prompt admission cannot outrank the current native handle.
  worker.outcome = "succeeded"
  worker.turn = { inputID: "msg_historical", state: "completed" }
  expect(worker.busy).toBe(true)
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(baseHead)

  // The foreground becomes active after the quiet heartbeat but during the detail read.
  worker.busy = false
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: attempt.message_id,
    executionStartSequence: 2,
    eventSequence: 3,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  let raced = false
  f.host.session = async (id, options) => {
    const session = await originalSession(id, options)
    if (id === attempt.session_id && options?.messages && !raced && session) {
      raced = true
      worker.busy = true
      return { ...session, busy: true, observationUnstable: true, outcome: "succeeded" }
    }
    return session
  }
  await f.runtime.tick()
  expect(raced).toBe(true)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(baseHead)

  f.host.session = originalSession
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "pending" }
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)

  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.background = {
    state: "unknown",
    source: "experimental.idle",
    reason: "native idle signal was lost",
  }
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(f.store.plan(f.receipt.planID)?.reason).toContain("background observation is unknown")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(baseHead)

  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: attempt.message_id,
    executionStartSequence: 2,
    eventSequence: 3,
    count: 2,
    kinds: { shell: 1, subagent: 1, image: 0 },
  }
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(baseHead)
  const backgroundWait = f.store.latestTransition<{ background: HostBackgroundObservation }>(
    f.receipt.planID,
    attempt.task_id,
    "WORKER_BACKGROUND_WAIT",
  )
  expect(backgroundWait?.background).toMatchObject({
    state: "observed",
    count: 2,
    kinds: { shell: 1, subagent: 1 },
  })

  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: attempt.message_id,
    executionStartSequence: 2,
    eventSequence: 3,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(true)
})

test("worker-location permissions and forms block terminal work and surface actionable diagnostics", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.pendingPermissions = 1
  worker.pendingForms = 1

  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.plan(planID)?.reason).toContain(`Worker at ${worker.directory}`)
  expect(f.store.plan(planID)?.reason).toContain("1 pending permission request(s)")
  expect(f.store.plan(planID)?.reason).toContain("1 pending form(s)")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("running")
  expect(f.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(false)
  expect(
    f.store.latestTransition<{
      workspace: string
      directory: string
      pendingPermissions: number
      pendingForms: number
    }>(planID, attempt.task_id, "WORKER_APPROVAL_WAIT"),
  ).toMatchObject({
    workspace: attempt.workspace,
    directory: worker.directory,
    pendingPermissions: 1,
    pendingForms: 1,
  })

  worker.pendingPermissions = 0
  worker.pendingForms = 0
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
})

test("a durably admitted same-attempt handoff reminder can finish with fresh matching evidence", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const claim = f.runtime.progress.claimReminder(
    attempt.session_id,
    "Provide the remaining handoff",
    "msg_owned_final_handoff",
  )!
  expect(claim).toBeDefined()
  f.runtime.progress.finishReminder(claim, "admitted")
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: claim.messageID, state: "completed" }
  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: claim.messageID,
    executionStartSequence: 10,
    eventSequence: 11,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  await drive(f.runtime, 10)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test.each(["unconfirmed", "foreign", "stale-assignment", "pre-reminder-report"])(
  "reminder completion rejects %s lineage",
  async (mode) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await f.runtime.tick()
    const attempt = f.store.attempts(f.receipt.planID)[0]!
    const worker = f.sessions.get(attempt.session_id)!
    const claim = f.runtime.progress.claimReminder(
      attempt.session_id,
      "Remaining handoff",
      "msg_claimed_handoff",
    )!
    f.runtime.progress.finishReminder(claim, mode === "unconfirmed" ? "unknown" : "admitted")
    if (mode === "stale-assignment")
      f.store.atomic((db) =>
        db
          .query("UPDATE runner_attempts SET message_id=? WHERE id=?")
          .run("msg_resumed_assignment", attempt.id),
      )
    const inputID = mode === "foreign" ? "msg_foreign_synthetic" : claim.messageID
    worker.busy = false
    worker.outcome = "succeeded"
    worker.turn = { inputID, state: "completed" }
    worker.background = {
      state: "observed",
      source: "experimental.idle",
      observedAt: Date.now(),
      inputID: mode === "pre-reminder-report" ? attempt.message_id : inputID,
      executionStartSequence: 10,
      eventSequence: 11,
      count: 0,
      kinds: { shell: 0, subagent: 0, image: 0 },
    }
    await f.runtime.tick()
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
    ).toBe(false)
  },
)

test("terminal verification rejects a fresh idle report from a different native input", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: "msg_from_an_older_execution",
    executionStartSequence: 3,
    eventSequence: 4,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }

  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(f.store.plan(f.receipt.planID)?.reason).toContain(
    "Native idle background observation does not match the current worker input lineage",
  )
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
})

test("explicit cancellation after process replacement resumes the same dirty attempt exactly once", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalSession = f.host.session
  const originalMessageID = attempt.message_id
  const originalWorkspace = attempt.workspace
  const originalPolicy = attempt.policy
  const originalBase = attempt.base_commit
  worker.outcome = "succeeded"
  worker.tokens = 777
  worker.tools = 23
  worker.cost = 2.5
  let replaced = true
  f.host.session = async (id, options) => {
    const session = await originalSession(id, options)
    if (id !== attempt.session_id || !replaced || !session) return session
    return {
      ...session,
      busy: false,
      outcome: "interrupted",
      turn: { inputID: originalMessageID, state: "interrupted" },
      background: {
        state: "unknown",
        source: "experimental.idle",
        reason: "The replaced process no longer reports its idle hook state",
      },
    }
  }

  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.plan(planID)?.reason).toContain("Worker execution was interrupted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("running")
  expect(
    (f.store.detail(planID).activity as { event: string }[]).some(
      (entry) => entry.event === "REPAIR",
    ),
  ).toBe(false)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)

  await f.runtime.command(
    {
      requestID: "cancel-replaced",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cancelled")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    state: "cancelled",
    session_id: attempt.session_id,
    workspace: originalWorkspace,
    base_commit: originalBase,
    policy: originalPolicy,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(
    f.store.latestTransition(planID, attempt.task_id, "WORKER_BACKGROUND_UNKNOWN"),
  ).toBeDefined()
  expect(git(originalWorkspace, ["status", "--porcelain"])).not.toBe("")
  expect(readFileSync(join(originalWorkspace, "a.txt"), "utf8")).toBe("a")

  replaced = false
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: originalMessageID, state: "interrupted" }
  const promptCount = f.events.filter((event) => event.startsWith("prompt:")).length
  const resume = {
    requestID: "resume-replaced-same-attempt",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
    action: "resume",
    taskID: attempt.task_id,
    reason: "Continue the retained dirty attempt after confirming the old process is interrupted",
  }
  const first = await f.runtime.command(resume, "owner")
  const replay = await f.runtime.command(resume, "owner")
  expect(replay).toEqual(first)
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    state: "preparing",
    session_id: attempt.session_id,
    workspace: originalWorkspace,
    base_commit: originalBase,
    policy: originalPolicy,
  })
  const resumedMessageID = f.store.attempts(planID)[0]!.message_id
  expect(resumedMessageID).not.toBe(originalMessageID)
  expect(
    (f.store.detail(planID).activity as { event: string }[]).filter(
      (entry) => entry.event === "ATTEMPT_RESUMED",
    ),
  ).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptCount)

  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: attempt.message_id,
    executionStartSequence: 2,
    eventSequence: 3,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptCount + 1)
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.message_id).toBe(resumedMessageID)
  expect(worker.model).toEqual(JSON.parse(originalPolicy).model)
  expect(readFileSync(join(originalWorkspace, "a.txt"), "utf8")).toBe("a")
  expect(git(originalWorkspace, ["status", "--porcelain"])).not.toBe("")
  expect(f.store.attempts(planID)[0]).toMatchObject({ token_count: 777, tool_count: 23, cost: 2.5 })

  f.completeWorker(worker.id, "succeeded")
  await drive(f.runtime, 4)
  expect(f.store.plan(planID)?.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.effects(planID).some((effect) => effect.kind === "verify:content")).toBe(true)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptCount + 1)
})

test("cancellation does not settle when foreground activity reappears during its detail read", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalSession = f.host.session
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: attempt.message_id, state: "interrupted" }
  await f.runtime.command(
    {
      requestID: "cancel-detail-race",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "cancel",
    },
    "owner",
  )

  let raced = false
  f.host.session = async (id, options) => {
    const session = await originalSession(id, options)
    if (id === attempt.session_id && options?.messages && !raced && session) {
      raced = true
      worker.busy = true
      return { ...session, busy: true, observationUnstable: true }
    }
    return session
  }
  await f.runtime.tick()
  expect(raced).toBe(true)
  expect(f.store.plan(planID)?.state).toBe("cancelling")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("running")

  f.host.session = originalSession
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: attempt.message_id, state: "interrupted" }
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cancelled")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("cancelled")
})

async function prepareIdleArchitect(f: ReturnType<typeof fixture>, now: number, idleFor: number) {
  await runPlan(f)
  await drive(f.runtime, 2)
  const owner = f.sessions.get("owner")!
  owner.busy = false
  owner.idleAt = now - idleFor
  await f.runtime.recordArchitectContinuity(owner.id, {
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  return f.store.attempts(f.receipt.planID)[0]!
}

test("the registered scheduler reuses recent/busy Architects and renews at the default threshold", async () => {
  const now = 2_000_000_000_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  expect(architectIdleWindowMs(undefined)).toBe(30 * 60 * 1000)
  expect(DEFAULT_ARCHITECT_IDLE_WINDOW_MS).toBe(30 * 60 * 1000)
  expect(() => architectIdleWindowMs(0)).toThrow("positive integer")
  const attempt = await prepareIdleArchitect(f, now, 0)
  const owner = f.sessions.get("owner")!
  owner.messages.push({ id: "old-transcript", text: "SECRET_TRANSCRIPT_SHOULD_NOT_REPLAY" })
  await f.runtime.recordArchitectContinuity(owner.id, {
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  owner.idleAt = now - DEFAULT_ARCHITECT_IDLE_WINDOW_MS + 1

  await f.runtime.tick()
  expect(f.store.architectRenewalsNeedingRecovery()).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(0)
  expect(owner.archived).toBe(false)

  owner.idleAt = now - DEFAULT_ARCHITECT_IDLE_WINDOW_MS
  const peer = new TaskRuntime(f.store, f.host, "project", undefined, {
    architectPromptHook: true,
    now: () => now,
  })
  cleanup.push(() => peer.stop())
  const createInputs: Parameters<RunnerHost["createArchitect"]>[0][] = []
  const create = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    createInputs.push(input)
    await create(input)
  }
  const update = f.host.updateSession!
  let archiveSawDurableTransfer = false
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
      const handoff = f.store
        .outboxForDelivery()
        .find((row) => row.id === renewal.handoff_outbox_id)
      expect(renewal.state).toBe("archiving")
      expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
      expect(handoff?.state).toBe("pending")
      archiveSawDurableTransfer = true
    }
    await update(input)
  }

  await Promise.all([f.runtime.tick(), peer.tick()])

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successor = f.sessions.get(renewal.successor_session_id)!
  expect(renewal.state).toBe("committed")
  expect(archiveSawDurableTransfer).toBe(true)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successor.id)
  expect(owner.archived).toBe(true)
  expect(successor.parentID).toBe(owner.id)
  expect(successor.model).toEqual(owner.model)
  expect(f.store.architectContinuity(successor.id)).toMatchObject({
    revision: 2,
    decisions: JSON.stringify(["Keep the existing approved implementation direction."]),
    unresolved_questions: JSON.stringify(["Confirm whether the follow-up needs additional scope."]),
  })
  expect(successor.metadata?.lazersPlanID).toBe(f.receipt.planID)
  expect(successor.metadata?.lazersPlanIDs).toContain(f.receipt.planID)
  expect(createInputs).toHaveLength(1)
  expect(createInputs[0]).toMatchObject({
    parentID: "owner",
    planID: f.receipt.planID,
    sourceSessionID: "owner",
    title: expect.stringContaining("Implement a"),
    model: owner.model,
  })
  expect(f.store.attempts(f.receipt.planID)[0]?.session_id).toBe(attempt.session_id)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  expect(owner.messages).toEqual([
    { id: "old-transcript", text: "SECRET_TRANSCRIPT_SHOULD_NOT_REPLAY" },
  ])
  const wake = f.notifications.find(
    (notice) =>
      notice.sessionID === successor.id && notice.text.includes("Architect continuity handoff"),
  )!
  expect(wake.text).toContain("lazers_inspect_plan")
  expect(wake.text).toContain("Keep the existing approved implementation direction.")
  expect(wake.text).toContain("Confirm whether the follow-up needs additional scope.")
  expect(wake.text).not.toContain("SECRET_TRANSCRIPT_SHOULD_NOT_REPLAY")
  expect(f.inbox.get(successor.id)).toHaveLength(2)
  expect(
    f.notifications.find((notice) => notice.text.includes("retained Architect input update")),
  ).toMatchObject({
    resume: false,
  })
  expect(wake.resume).toBe(true)
  const committed = f.store.latestTransition<{ wakeContext: { bytes: number; tokens: null } }>(
    f.receipt.planID,
    null,
    "ARCHITECT_RENEWAL_COMMITTED",
  )!
  expect(committed.wakeContext.bytes).toBe(new TextEncoder().encode(wake.text).byteLength)
  expect(committed.wakeContext.tokens).toBeNull()
  expect(committed.wakeContext.bytes).toBeGreaterThan(0)
})

test("idle-window overrides, busy sessions, unsupported hooks, and pre-create input fail closed", async () => {
  const now = 2_000_000_100_000
  expect(architectIdleWindowMs(5_000)).toBe(5_000)

  const overridden = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 5_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(overridden, now, 4_999)
  await overridden.runtime.tick()
  expect(overridden.events.filter((event) => event.startsWith("create-architect:")).length).toBe(0)
  overridden.sessions.get("owner")!.idleAt = now - 5_000
  await overridden.runtime.tick()
  expect(overridden.store.architectRenewalForPlan(overridden.receipt.planID)?.state).toBe(
    "committed",
  )

  for (const scenario of ["busy", "unsupported-hook", "input-before-create"] as const) {
    const f = fixture({
      delayed: true,
      architectPromptHook: scenario !== "unsupported-hook",
      architectIdleWindowMs: 5_000,
      now: () => now,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    await prepareIdleArchitect(f, now, 5_000)
    const owner = f.sessions.get("owner")!
    if (scenario === "busy") owner.busy = true
    if (scenario === "input-before-create") {
      await f.runtime.observeArchitectPrompt(owner.id, "pre-create-user-message")
      await f.runtime.observeArchitectPrompt(owner.id, "pre-create-user-message")
      expect(
        f.store.atomic(
          (db) =>
            db
              .query<{ count: number }, [string]>(
                "SELECT count(*) AS count FROM runner_architect_inputs WHERE session_id=?",
              )
              .get(owner.id)!.count,
        ),
      ).toBe(1)
    }
    await f.runtime.tick()
    expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(0)
    expect(f.events.filter((event) => event.startsWith("update-session:")).length).toBe(0)
    expect(owner.archived).toBe(false)
  }
})

test("renewal requires an explicit checkpoint and retains queued native inputs by ID", async () => {
  const now = 2_000_000_125_000
  const missingCheckpoint = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(missingCheckpoint)
  await drive(missingCheckpoint.runtime, 2)
  missingCheckpoint.sessions.get("owner")!.idleAt = now - 1_000
  await missingCheckpoint.runtime.tick()
  expect(
    missingCheckpoint.store.architectRenewalForPlan(missingCheckpoint.receipt.planID),
  ).toBeNull()
  expect(missingCheckpoint.events.some((event) => event.startsWith("create-architect:"))).toBe(
    false,
  )
  expect(missingCheckpoint.sessions.get("owner")?.archived).toBe(false)

  const reconciledHost = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(reconciledHost, now, 1_000)
  const foreign = {
    id: "msg_external_queue_before_creation",
    type: "synthetic",
    delivery: "queue",
    metadata: { source: "another-plugin" },
  }
  reconciledHost.inbox.set("owner", [foreign])
  await reconciledHost.runtime.tick()
  const renewal = reconciledHost.store.architectRenewalForPlan(reconciledHost.receipt.planID)!
  expect(renewal.state).toBe("committed")
  expect(reconciledHost.store.plan(reconciledHost.receipt.planID)?.owner).toBe(
    renewal.successor_session_id,
  )
  expect(
    reconciledHost.events.filter((event) => event === "update-session:owner:true"),
  ).toHaveLength(1)
  expect(reconciledHost.inbox.get("owner")).toEqual([foreign])
  expect(reconciledHost.sessions.get("owner")?.archived).toBe(true)
  expect(reconciledHost.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: foreign.id, disposition: "pending" }),
  )
  expect(
    reconciledHost.notifications.some((notification) => notification.text.includes(foreign.id)),
  ).toBe(true)
})

test("one successor receives every live plan owned by the same Architect", async () => {
  const now = 2_000_000_150_000
  const f = fixture({
    delayed: true,
    independent: true,
    architectPromptHook: true,
    architectIdleWindowMs: 5_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a/a.txt" }],
  })
  const taskB = f.createTask("b", "b/b.txt")
  const planB = f.store.submit(f.inputFor([taskB], { requestID: "second-owner-plan" }), "owner")
  await runPlan(f)
  await runPlan(f, planB.planID, "run-second-owner-plan")
  await drive(f.runtime, 2)
  await f.runtime.recordArchitectContinuity("owner", {
    decisions: ["Keep both task plans under the current Architect."],
    unresolvedQuestions: ["Confirm cross-plan ordering after integration."],
  })
  const attempts = [f.store.attempts(f.receipt.planID)[0]!, f.store.attempts(planB.planID)[0]!]
  expect(attempts.every((attempt) => f.sessions.get(attempt.session_id)?.busy)).toBe(true)
  f.sessions.get("owner")!.idleAt = now - 5_000

  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successor = f.sessions.get(renewal.successor_session_id)!
  expect(renewal.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successor.id)
  expect(f.store.plan(planB.planID)?.owner).toBe(successor.id)
  expect(successor.metadata?.lazersPlanIDs).toEqual([f.receipt.planID, planB.planID].sort())
  expect(f.store.continuation(f.receipt.planID)?.session_id).toBe(successor.id)
  expect(f.store.continuation(planB.planID)?.session_id).toBe(successor.id)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
  expect(attempts.map((attempt) => f.store.attempts(attempt.plan_id)[0]?.session_id)).toEqual(
    attempts.map((attempt) => attempt.session_id),
  )
  expect(attempts.every((attempt) => f.sessions.get(attempt.session_id)?.busy)).toBe(true)
  const handoff = f.store
    .outboxForDelivery()
    .find((row) => JSON.parse(row.payload).status === "architect-handoff")!
  expect(JSON.parse(handoff.payload).planIDs).toEqual([f.receipt.planID, planB.planID].sort())
  expect(JSON.parse(handoff.payload).continuity).toEqual({
    revision: 1,
    decisions: ["Keep both task plans under the current Architect."],
    unresolvedQuestions: ["Confirm cross-plan ordering after integration."],
  })
})

test("input during a deferred native create prevents transfer and predecessor archival", async () => {
  const now = 2_000_000_200_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const create = f.host.createArchitect
  let startCreate!: () => void
  let releaseCreate!: () => void
  const started = new Promise<void>((resolve) => (startCreate = resolve))
  const gate = new Promise<void>((resolve) => (releaseCreate = resolve))
  f.host.createArchitect = async (input) => {
    startCreate()
    await gate
    await create(input)
  }

  const tick = f.runtime.tick()
  await started
  await f.runtime.observeArchitectPrompt("owner", "input-during-create")
  f.sessions.get("owner")!.messages.push({ id: "input-during-create", text: "Keep this input" })
  releaseCreate()
  await tick

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("deferred")
  expect(renewal.input_message_id).toBe("input-during-create")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(f.events.filter((event) => event.startsWith("update-session:")).length).toBe(0)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("a continuity edit during successor creation blocks stale ownership transfer", async () => {
  const now = 2_000_000_205_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const create = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    await create(input)
    await f.runtime.recordArchitectContinuity("owner", {
      decisions: ["Use the revised approved direction."],
      unresolvedQuestions: ["Confirm the revised rollout."],
    })
  }

  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("deferred")
  expect(renewal.error).toContain("continuity changed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(f.store.architectContinuity("owner")).toMatchObject({
    revision: 2,
    decisions: JSON.stringify(["Use the revised approved direction."]),
    unresolved_questions: JSON.stringify(["Confirm the revised rollout."]),
  })
  expect(f.store.architectContinuity(renewal.successor_session_id)).toBeNull()
  expect(f.notifications).toHaveLength(0)
})

test("native queued synthetic input is retained and referenced across creation, transfer, and archive", async () => {
  const phases = ["creation", "transfer", "archive"] as const
  for (const [index, phase] of phases.entries()) {
    const now = 2_000_000_210_000 + index * 10_000
    const f = fixture({
      delayed: true,
      architectPromptHook: true,
      architectIdleWindowMs: 1_000,
      now: () => now,
      taskFiles: [{ name: "a", path: `a-${phase}.txt` }],
    })
    await prepareIdleArchitect(f, now, 1_000)
    const foreign = {
      id: `msg_synthetic_${phase}`,
      type: "synthetic",
      delivery: "queue",
      metadata: { source: "another-plugin" },
    }
    if (phase === "creation") {
      const create = f.host.createArchitect
      f.host.createArchitect = async (input) => {
        await create(input)
        f.inbox.set("owner", [foreign])
      }
    } else if (phase === "transfer") {
      const transfer = f.store.transferArchitectRenewal.bind(f.store)
      f.store.transferArchitectRenewal = (input) => {
        const result = transfer(input)
        f.inbox.set("owner", [foreign])
        return result
      }
    } else {
      const update = f.host.updateSession!
      f.host.updateSession = async (input) => {
        if (input.sessionID === "owner" && input.archived) f.inbox.set("owner", [foreign])
        await update(input)
      }
    }

    await f.runtime.tick()

    const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
    expect(renewal.state).toBe("committed")
    expect(f.inbox.get("owner")).toEqual([foreign])
    expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
    expect(f.sessions.get("owner")?.archived).toBe(true)
    expect(f.store.architectRenewalHasInput(renewal.id)).toBe(true)
    expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(1)
    expect(
      (f.store.detail(f.receipt.planID).delivery as { state: string; payload: string }[]).find(
        (row) => JSON.parse(row.payload).status === "architect-handoff",
      )?.state,
    ).toBe("admitted")
    expect(f.notifications.some((notification) => notification.text.includes(foreign.id))).toBe(
      true,
    )
  }
})

test("late input on an archived predecessor is reconciled to the current owner without waking or replay", async () => {
  const now = 2_000_000_275_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "late-input.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const currentOwner = renewal.successor_session_id
  expect(renewal.state).toBe("committed")
  expect(f.sessions.get("owner")?.archived).toBe(true)

  const late = {
    id: "msg_late_after_archive",
    type: "synthetic",
    delivery: "queue",
    metadata: { source: "another-plugin" },
  }
  f.inbox.set("owner", [late])
  const before = f.notifications.length
  await f.runtime.tick()

  expect(f.store.plan(f.receipt.planID)?.owner).toBe(currentOwner)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.inbox.get("owner")).toEqual([late])
  expect(f.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: late.id, disposition: "pending" }),
  )
  const reference = f.notifications
    .slice(before)
    .find((notification) => notification.text.includes(late.id))
  expect(reference).toMatchObject({ sessionID: currentOwner, resume: false })
  await f.runtime.tick()
  expect(
    f.notifications.filter((notification) => notification.text.includes(late.id)),
  ).toHaveLength(1)
})

test("predecessor reconciliation persists native message pagination across scheduler ticks", async () => {
  const now = 2_000_000_280_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "paged-source.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const pages: (string | undefined)[] = []
  f.host.architectInputPage = async (_sessionID, cursor) => {
    pages.push(cursor)
    return cursor
      ? {
          inbox: [],
          messages: [{ id: "msg_page_two_input", type: "user" }],
          nextCursor: null,
        }
      : { inbox: [], messages: [], nextCursor: "page-two" }
  }

  await f.runtime.tick()
  expect(f.store.architectSource(renewal.previous_session_id)?.scan_cursor).toBe("page-two")
  expect(f.store.architectSourceInputs(renewal.previous_session_id)).not.toContainEqual(
    expect.objectContaining({ message_id: "msg_page_two_input" }),
  )
  await f.runtime.tick()

  expect(pages).toEqual([undefined, "page-two"])
  expect(f.store.architectSource(renewal.previous_session_id)?.scan_cursor).toBeNull()
  expect(f.store.architectSourceInputs(renewal.previous_session_id)).toContainEqual(
    expect.objectContaining({ message_id: "msg_page_two_input", disposition: "delivered" }),
  )
  expect(
    f.notifications.some((notification) => notification.text.includes("msg_page_two_input")),
  ).toBe(true)
})

test("large predecessor histories produce bounded reference-only notification batches", async () => {
  const now = 2_000_000_281_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "bounded-references.txt" }],
  })
  const ids = Array.from(
    { length: 45 },
    (_, index) => `msg_reference_${index.toString().padStart(2, "0")}`,
  )
  f.host.architectInputPage = async () => ({
    inbox: [],
    messages: ids.map((id) => ({ id, type: "user" })),
    nextCursor: null,
  })
  await prepareIdleArchitect(f, now, 1_000)

  await f.runtime.tick()
  let rows = f.store.detail(f.receipt.planID).delivery as { payload: string }[]
  let references = rows
    .map((row) => JSON.parse(row.payload))
    .filter((payload) => payload.status === "architect-source-reference")
  expect(references.length).toBeGreaterThanOrEqual(1)
  expect(references.every((payload) => payload.inputIDs.length <= 20)).toBe(true)
  await f.runtime.tick()
  await f.runtime.tick()

  rows = f.store.detail(f.receipt.planID).delivery as { payload: string }[]
  references = rows
    .map((row) => JSON.parse(row.payload))
    .filter((payload) => payload.status === "architect-source-reference")
  const referencedIDs = references.flatMap((payload) =>
    payload.inputIDs.map((input: { id: string }) => input.id),
  )
  expect(referencedIDs.toSorted()).toEqual(ids.toSorted())
  expect(references.every((payload) => payload.inputIDs.length <= 20)).toBe(true)
  const handoff = rows
    .map((row) => JSON.parse(row.payload))
    .find((payload) => payload.status === "architect-handoff")
  expect(handoff).not.toHaveProperty("inputSources")
  expect(
    f.notifications.filter((notification) =>
      notification.text.includes("retained Architect input update"),
    ),
  ).toHaveLength(references.length)
})

test("a previously seen pending input that disappears without history stays unknown, never cancelled or replayed", async () => {
  const now = 2_000_000_282_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "unknown-input.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const late = {
    id: "msg_disappeared_without_transcript",
    type: "user",
    delivery: "queue",
  }
  f.inbox.set("owner", [late])
  await f.runtime.tick()
  expect(f.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: late.id, disposition: "pending" }),
  )

  f.inbox.set("owner", [])
  await f.runtime.tick()

  expect(f.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: late.id, disposition: "unknown" }),
  )
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(
    f.notifications.filter((notification) => notification.text.includes(late.id)),
  ).toHaveLength(2)
  expect(f.notifications.at(-1)?.resume).toBe(false)
})

test("generated renewal notifications are authenticated and do not form A-to-B-to-C input loops", async () => {
  const now = 2_000_000_284_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "notification-loop.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const first = f.store.architectRenewalForPlan(f.receipt.planID)!
  const middle = f.sessions.get(first.successor_session_id)!
  expect(f.inbox.get(middle.id)).toHaveLength(1)

  middle.idleAt = now - 1_000
  await f.runtime.tick()
  const second = f.store.architectRenewalForSource(middle.id)!

  expect(second.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(second.successor_session_id)
  expect(f.store.architectSourceInputs(middle.id)).toHaveLength(0)
  expect(f.inbox.get(middle.id)).toHaveLength(0)
  expect(
    f.notifications.filter((notification) =>
      notification.text.includes("retained Architect input update"),
    ),
  ).toHaveLength(0)
})

test("a retired Architect predecessor cannot reclaim a transferred plan through reassign", async () => {
  const now = 2_000_000_285_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "reassign.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const plan = f.store.plan(f.receipt.planID)!
  f.sessions.set("active-target", {
    ...f.sessions.get(renewal.successor_session_id)!,
    id: "active-target",
    parentID: undefined,
    metadata: {},
  })
  const reassign = {
    requestID: "retired-predecessor-reassign",
    planID: plan.id,
    expectedVersion: plan.version,
    action: "reassign",
    targetSessionID: "active-target",
    reason: "Test the retired-owner guard",
  }

  await expect(f.runtime.command(reassign, "owner")).rejects.toThrow(
    "retired Architect predecessor",
  )
  expect(f.store.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  await f.runtime.command(
    { ...reassign, requestID: "active-owner-reassign" },
    renewal.successor_session_id,
  )
  expect(f.store.plan(plan.id)?.owner).toBe("active-target")
})

test("input racing native archival remains on the retained source and is referenced to the new owner", async () => {
  const now = 2_000_000_300_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  let startArchive!: () => void
  let releaseArchive!: () => void
  const started = new Promise<void>((resolve) => (startArchive = resolve))
  const gate = new Promise<void>((resolve) => (releaseArchive = resolve))
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      startArchive()
      await gate
    }
    await update(input)
  }

  const tick = f.runtime.tick()
  await started
  await f.runtime.observeArchitectPrompt("owner", "input-during-archive")
  f.sessions.get("owner")!.messages.push({ id: "input-during-archive", text: "Keep this input" })
  releaseArchive()
  await tick

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const handoff = f.store.detail(f.receipt.planID).delivery as { state: string; payload: string }[]
  expect(renewal.state).toBe("committed")
  expect(renewal.input_message_id).toBe("input-during-archive")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.sessions.get("owner")?.messages.at(-1)?.id).toBe("input-during-archive")
  expect(handoff.find((row) => JSON.parse(row.payload).status === "architect-handoff")?.state).toBe(
    "admitted",
  )
  expect(
    f.notifications.some((notification) => notification.text.includes("input-during-archive")),
  ).toBe(true)
  expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(1)
  expect(f.events.filter((event) => event === "update-session:owner:false")).toHaveLength(0)
})

test("input on the reserved successor is preserved there without reversing predecessor transfer", async () => {
  const now = 2_000_000_325_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  let startArchive!: () => void
  let releaseArchive!: () => void
  const started = new Promise<void>((resolve) => (startArchive = resolve))
  const gate = new Promise<void>((resolve) => (releaseArchive = resolve))
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      startArchive()
      await gate
    }
    await update(input)
  }

  const tick = f.runtime.tick()
  await started
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  await f.runtime.observeArchitectPrompt(renewal.successor_session_id, "successor-user-input")
  const successor = f.sessions.get(renewal.successor_session_id)!
  successor.busy = true
  successor.messages.push({ id: "successor-user-input", text: "Keep input on successor" })
  expect(f.store.architectRenewalHasInput(renewal.id)).toBe(false)
  releaseArchive()
  await tick

  expect(f.store.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successor.id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(successor.messages.at(-1)?.id).toBe("successor-user-input")
  expect(successor.busy).toBe(true)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ session_id: string }, [string]>(
            "SELECT session_id FROM runner_architect_inputs WHERE message_id=?",
          )
          .get("successor-user-input")?.session_id,
    ),
  ).toBe(successor.id)
})

test("an outcome admitted during archival is blocked then retargeted to the renewed owner", async () => {
  const now = 2_000_000_350_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const beforeCreatePlan = f.store.plan(f.receipt.planID)!
  f.store.atomic((db) =>
    db
      .query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',1,?,NULL)",
      )
      .run(
        "task-outcome-before-create",
        beforeCreatePlan.id,
        "owner",
        "task-outcome-before-create-message",
        JSON.stringify({
          planID: beforeCreatePlan.id,
          version: beforeCreatePlan.version,
          status: "task-accepted",
          taskID: f.tasks[0]!.id,
          artifact: "worker-artifact",
        }),
        JSON.stringify({
          lazersKind: "runner-outcome",
          lazersProjectID: "project",
          lazersProjectDirectory: f.root,
          lazersPlanID: beforeCreatePlan.id,
          lazersOutboxID: "task-outcome-before-create",
          lazersMessageID: "task-outcome-before-create-message",
          lazersSessionID: "owner",
          lazersStatus: "task-accepted",
          lazersVersion: beforeCreatePlan.version,
        }),
      ),
  )
  const update = f.host.updateSession!
  let startArchive!: () => void
  let releaseArchive!: () => void
  const started = new Promise<void>((resolve) => (startArchive = resolve))
  const gate = new Promise<void>((resolve) => (releaseArchive = resolve))
  let oldOutcomeID = ""
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      const plan = f.store.plan(f.receipt.planID)!
      const renewal = f.store.architectRenewalForPlan(plan.id)!
      oldOutcomeID = "task-outcome-during-archive"
      const oldPayload = {
        planID: plan.id,
        version: plan.version,
        status: "task-accepted",
        taskID: f.tasks[0]!.id,
        artifact: "worker-artifact",
      }
      const oldMetadata = {
        lazersKind: "runner-outcome",
        lazersProjectID: "project",
        lazersProjectDirectory: f.root,
        lazersPlanID: plan.id,
        lazersOutboxID: oldOutcomeID,
        lazersMessageID: "old-task-outcome-message",
        lazersSessionID: "owner",
        lazersStatus: "task-accepted",
        lazersVersion: plan.version,
      }
      f.store.atomic((db) =>
        db
          .query(
            "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',1,?,NULL)",
          )
          .run(
            oldOutcomeID,
            plan.id,
            "owner",
            "old-task-outcome-message",
            JSON.stringify(oldPayload),
            JSON.stringify(oldMetadata),
          ),
      )
      expect(renewal.state).toBe("archiving")
      expect(plan.owner).toBe(renewal.successor_session_id)
      expect(f.notifications).toHaveLength(0)
      expect(f.store.outboxForDelivery().find((row) => row.id === oldOutcomeID)?.state).toBe(
        "pending",
      )
      startArchive()
      await gate
    }
    await update(input)
  }

  const tick = f.runtime.tick()
  await started
  expect(f.notifications).toHaveLength(0)
  releaseArchive()
  await tick

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successor = renewal.successor_session_id
  let oldOutcome = f.store.outboxForDelivery().find((row) => row.id === oldOutcomeID)!
  expect(renewal.state).toBe("committed")
  expect(
    (f.store.detail(f.receipt.planID).delivery as { id: string; state: string }[]).find(
      (row) => row.id === "task-outcome-before-create",
    )?.state,
  ).toBe("superseded")
  expect(oldOutcome.session_id).toBe(successor)
  expect(oldOutcome.message_id).not.toBe("old-task-outcome-message")
  expect(JSON.parse(oldOutcome.receipt!).history).toContainEqual(
    expect.objectContaining({ kind: "owner-retargeted-current-outcome", toSessionID: successor }),
  )
  expect(f.notifications).toHaveLength(2)
  expect(f.notifications.every((notice) => notice.sessionID === successor)).toBe(true)

  await f.runtime.tick()
  oldOutcome = f.store.outboxForDelivery().find((row) => row.id === oldOutcomeID)!
  expect(oldOutcome.state).toBe("admitted")
  expect(f.notifications.some((notice) => notice.text.includes('"status":"task-accepted"'))).toBe(
    true,
  )
  expect(f.notifications.every((notice) => notice.sessionID === successor)).toBe(true)
})

test("native archive failure remains visible and retries without restoring predecessor authority", async () => {
  const now = 2_000_000_375_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  let failArchive = true
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived && failArchive) {
      failArchive = false
      throw new Error("native archive temporarily unavailable")
    }
    await update(input)
  }

  await f.runtime.tick()

  const failed = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successorID = failed.successor_session_id
  expect(failed.state).toBe("archiving")
  expect(failed.error).toContain("native archive temporarily unavailable")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successorID)
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(
    f.store.latestTransition<{ error: string }>(
      f.receipt.planID,
      null,
      "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
    )?.error,
  ).toContain("native archive temporarily unavailable")

  f.sessions.get("owner")!.idleAt = now - 1_000
  f.host.updateSession = update
  await f.runtime.tick()

  const recovered = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(recovered.id).toBe(failed.id)
  expect(recovered.state).toBe("committed")
  expect(recovered.successor_session_id).toBe(successorID)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successorID)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("a reopened scheduler recovers a durable transfer before archival without changing workers", async () => {
  const now = 2_000_000_400_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  const ownerID = f.runtime.owner
  const fence = f.store.claim(ownerID, now)!
  const plan = f.store.plan(f.receipt.planID)!
  const renewal = f.store.beginArchitectRenewal({
    schedulerOwner: ownerID,
    fence,
    anchorPlanID: plan.id,
    previousSessionID: plan.owner,
    directory: f.sessions.get(plan.owner)!.directory,
    model: JSON.stringify(f.sessions.get(plan.owner)!.model),
    idleAt: f.sessions.get(plan.owner)!.idleAt!,
    now,
    handoffMessageID: "reopen-handoff-message",
  })!
  await f.host.createArchitect({
    id: renewal.successor_session_id,
    parentID: renewal.previous_session_id,
    directory: renewal.directory,
    model: JSON.parse(renewal.model),
    title: "LAZERS · reopened plan",
    planID: renewal.anchor_plan_id,
    planIDs: f.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id),
    sourceSessionID: renewal.previous_session_id,
  })
  const payload = {
    status: "architect-handoff",
    planID: plan.id,
    version: plan.version + 1,
    planIDs: [plan.id],
    label: "reopened plan",
    continuity: JSON.parse(renewal.continuity_json!),
    predecessorSessionID: renewal.previous_session_id,
    successorSessionID: renewal.successor_session_id,
  }
  const metadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: "project",
    lazersProjectDirectory: f.root,
    lazersPlanID: plan.id,
    lazersOutboxID: "reopen-handoff-outbox",
    lazersMessageID: renewal.handoff_message_id,
    lazersSessionID: renewal.successor_session_id,
    lazersStatus: "architect-handoff",
    lazersVersion: plan.version + 1,
  }
  expect(
    f.store.transferArchitectRenewal({
      schedulerOwner: ownerID,
      fence,
      renewalID: renewal.id,
      outboxID: "reopen-handoff-outbox",
      payload: JSON.stringify(payload),
      metadata: JSON.stringify(metadata),
    }),
  ).toBe(true)
  expect(f.store.architectRenewal(renewal.id)?.state).toBe("archiving")
  expect(f.store.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get(renewal.previous_session_id)?.archived).toBe(false)
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())

  const reopenedRepository = new TaskRepository(f.repository.path, f.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopened = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    architectIdleWindowMs: 1_000,
    architectPromptHook: true,
    now: () => now,
  })
  cleanup.push(() => {
    void reopened.stop()
    reopenedRepository.close()
  })
  await reopened.tick()

  expect(reopenedStore.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(JSON.parse(reopenedStore.architectRenewal(renewal.id)!.continuity_json!)).toEqual({
    revision: 1,
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  expect(reopenedStore.architectContinuity(renewal.successor_session_id)).toMatchObject({
    revision: 1,
    decisions: JSON.stringify(["Keep the existing approved implementation direction."]),
    unresolved_questions: JSON.stringify(["Confirm whether the follow-up needs additional scope."]),
  })
  expect(reopenedStore.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get(renewal.previous_session_id)?.archived).toBe(true)
  expect(reopenedStore.attempts(plan.id)[0]?.session_id).toBe(attempt.session_id)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
  expect(f.notifications).toHaveLength(1)
})

test("a reopened two-scheduler runtime archives only after durable transfer and reconciles queued input", async () => {
  const now = 2_000_000_450_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const schedulerOwner = f.runtime.owner
  const fence = f.store.claim(schedulerOwner, now)!
  const plan = f.store.plan(f.receipt.planID)!
  const predecessor = f.sessions.get(plan.owner)!
  const renewal = f.store.beginArchitectRenewal({
    schedulerOwner,
    fence,
    anchorPlanID: plan.id,
    previousSessionID: predecessor.id,
    directory: predecessor.directory,
    model: JSON.stringify(predecessor.model),
    idleAt: predecessor.idleAt!,
    now,
    handoffMessageID: "unsupported-hook-handoff",
  })!
  await f.host.createArchitect({
    id: renewal.successor_session_id,
    parentID: predecessor.id,
    directory: renewal.directory,
    model: JSON.parse(renewal.model),
    title: "LAZERS · unsupported-hook case",
    planID: plan.id,
    planIDs: [plan.id],
    sourceSessionID: predecessor.id,
  })
  const payload = {
    status: "architect-handoff",
    planID: plan.id,
    version: plan.version + 1,
    planIDs: [plan.id],
    label: "unsupported-hook case",
    predecessorSessionID: predecessor.id,
    successorSessionID: renewal.successor_session_id,
  }
  const metadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: "project",
    lazersProjectDirectory: f.root,
    lazersPlanID: plan.id,
    lazersOutboxID: "unsupported-hook-outbox",
    lazersMessageID: renewal.handoff_message_id,
    lazersSessionID: renewal.successor_session_id,
    lazersStatus: "architect-handoff",
    lazersVersion: plan.version + 1,
  }
  expect(
    f.store.transferArchitectRenewal({
      schedulerOwner,
      fence,
      renewalID: renewal.id,
      outboxID: "unsupported-hook-outbox",
      payload: JSON.stringify(payload),
      metadata: JSON.stringify(metadata),
    }),
  ).toBe(true)
  const foreign = {
    id: "msg_synthetic_during_process_restart",
    type: "synthetic",
    delivery: "queue",
    metadata: { source: "another-plugin" },
  }
  f.inbox.set(predecessor.id, [foreign])
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())

  const reopenedRepository = new TaskRepository(f.repository.path, f.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const first = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    architectIdleWindowMs: 1_000,
    architectPromptHook: true,
    now: () => now,
  })
  const second = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    architectIdleWindowMs: 1_000,
    architectPromptHook: true,
    now: () => now,
  })
  cleanup.push(() => {
    void first.stop()
    void second.stop()
    reopenedRepository.close()
  })

  await Promise.all([first.tick(), second.tick()])

  expect(reopenedStore.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(JSON.parse(reopenedStore.architectRenewal(renewal.id)!.continuity_json!)).toEqual({
    revision: 1,
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  expect(reopenedStore.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(predecessor.archived).toBe(true)
  expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(1)
  expect(f.inbox.get(predecessor.id)).toEqual([foreign])
  expect(reopenedStore.architectRenewalHasInput(renewal.id)).toBe(true)
  expect(reopenedStore.architectSourceInputs(predecessor.id)).toContainEqual(
    expect.objectContaining({ message_id: foreign.id, disposition: "pending" }),
  )
  expect(f.notifications.some((notification) => notification.text.includes(foreign.id))).toBe(true)
})

test("cancellation interrupts workers while a transferred renewal still has failed archival recovery", async () => {
  const now = 2_000_000_500_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "cancel-during-archive.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  let archiveAttempts = 0
  f.host.updateSession = async ({ sessionID, archived }) => {
    if (sessionID === "owner" && archived) {
      archiveAttempts++
      throw new Error("archive remains unavailable during cancellation")
    }
  }

  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("archiving")
  const plan = f.store.plan(f.receipt.planID)!
  await f.runtime.command(
    {
      requestID: "cancel-during-archive-recovery",
      planID: plan.id,
      expectedVersion: plan.version,
      action: "cancel",
    },
    renewal.successor_session_id,
  )
  expect(f.store.plan(plan.id)?.state).toBe("cancelling")
  expect(f.store.architectRenewalForPlan(plan.id)?.id).toBe(renewal.id)
  let failedHistoryReads = 0
  f.host.architectInputPage = async () => {
    failedHistoryReads++
    throw new Error("retained predecessor history is temporarily unavailable")
  }

  await f.runtime.tick()
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(false)
  expect(f.sessions.get(attempt.session_id)?.outcome).toBe("interrupted")
  expect(f.store.plan(plan.id)?.state).toBe("cancelling")
  await f.runtime.tick()
  await f.runtime.tick()

  expect(f.store.plan(plan.id)?.state).toBe("cancelled")
  expect(f.store.architectRenewal(renewal.id)).toMatchObject({
    state: "archiving",
    error: "retained predecessor history is temporarily unavailable",
  })
  expect(f.store.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(archiveAttempts).toBe(1)
  expect(failedHistoryReads).toBeGreaterThanOrEqual(6)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("a continuity checkpoint cannot outlive a later observed user input", async () => {
  let now = 2_000_000_510_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "checkpoint-coverage.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const owner = f.sessions.get("owner")!
  now += 100
  owner.messages.push({ id: "msg_new_user_decision", type: "user", text: "Use the new decision" })
  await f.runtime.observeArchitectPrompt(owner.id, "msg_new_user_decision")
  owner.busy = false
  owner.idleAt = now + 100
  now = owner.idleAt + 1_000

  await f.runtime.tick()
  expect(f.store.architectRenewalForPlan(f.receipt.planID)).toBeNull()
  expect(owner.archived).toBe(false)
  expect(
    f.store.latestTransition<{ uncoveredInputID: string }>(
      f.receipt.planID,
      null,
      "ARCHITECT_RENEWAL_BLOCKED_STALE_CHECKPOINT",
    )?.uncoveredInputID,
  ).toBe("msg_new_user_decision")

  await f.runtime.recordArchitectContinuity(owner.id, {
    decisions: ["Use the newly observed user decision."],
    unresolvedQuestions: [],
  })
  expect(f.store.architectContinuityCoverage(owner.id)).toContain("msg_new_user_decision")
  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("committed")
  expect(JSON.parse(renewal.continuity_json!).decisions).toEqual([
    "Use the newly observed user decision.",
  ])
  const handoff = (f.store.detail(f.receipt.planID).delivery as { payload: string }[])
    .map((row) => JSON.parse(row.payload))
    .find((payload) => payload.status === "architect-handoff")
  expect(handoff.continuityCoverage).toMatchObject({ revision: 2, inputCount: 1 })
})

test("renewal finishes all preparation pages before transferring a checkpoint", async () => {
  const now = 2_000_000_515_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "page-three-checkpoint.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const cursors: (string | undefined)[] = []
  f.host.architectInputPage = async (_sessionID, cursor) => {
    cursors.push(cursor)
    if (cursor === undefined) return { inbox: [], messages: [], nextCursor: "page-two" }
    if (cursor === "page-two") return { inbox: [], messages: [], nextCursor: "page-three" }
    return {
      inbox: [],
      messages: [{ id: "msg_page_three_user", type: "user" }],
      nextCursor: null,
    }
  }

  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(cursors).toEqual([undefined, "page-two", "page-three"])
  expect(renewal.state).toBe("deferred")
  expect(renewal.input_message_id).toBe("msg_page_three_user")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(0)
  expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(0)
})

test("late and mutable assistant tool results are durably referenced by safe revision", async () => {
  const now = 2_000_000_520_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "mutable-source-result.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("committed")

  const privateCanary = "RAW_TOOL_ARGUMENTS_AND_REASONING_MUST_NOT_ESCAPE"
  let result: ArchitectSourceResult = {
    state: "running" as const,
    finish: null,
    toolCounts: { running: 1, completed: 0, failed: 0, other: 0 },
  }
  f.host.architectInputPage = async () => ({
    inbox: [],
    messages: [
      {
        id: "msg_late_tool_result",
        type: "assistant",
        metadata: { private: privateCanary },
        result,
      },
    ],
    nextCursor: null,
  })

  await f.runtime.tick()
  result = {
    state: "completed",
    finish: "stop",
    toolCounts: { running: 0, completed: 1, failed: 0, other: 0 },
  }
  await f.runtime.tick()

  const stored = f.store.atomic((db) =>
    db
      .query<
        {
          state: string
          result_revision: number
          referenced_revision: number
          result_fingerprint: string
        },
        [string, string]
      >(
        `SELECT state,result_revision,referenced_revision,result_fingerprint
         FROM runner_architect_source_results WHERE session_id=? AND message_id=?`,
      )
      .get("owner", "msg_late_tool_result"),
  )!
  expect(stored).toMatchObject({
    state: "completed",
    result_revision: 2,
    referenced_revision: expect.any(Number),
  })
  expect(stored.referenced_revision).toEqual(2)
  const references = (f.store.detail(f.receipt.planID).delivery as { payload: string }[])
    .map((row) => JSON.parse(row.payload))
    .filter((payload) => payload.status === "architect-source-reference")
  expect(references.flatMap((payload) => payload.results)).toEqual([
    expect.objectContaining({ id: "msg_late_tool_result", revision: 1, state: "running" }),
    expect.objectContaining({ id: "msg_late_tool_result", revision: 2, state: "completed" }),
  ])
  const resultNotices = f.notifications.filter((notice) =>
    notice.text.includes("assistant result msg_late_tool_result"),
  )
  expect(resultNotices).toHaveLength(2)
  expect(resultNotices.every((notice) => notice.resume === false)).toBe(true)
  expect(JSON.stringify(references)).not.toContain(privateCanary)
  expect(JSON.stringify(resultNotices)).not.toContain(privateCanary)
  expect(f.store.attempts(f.receipt.planID)[0]?.session_id).toBe(attempt.session_id)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
})

test("concurrent plan admission joins the fixed successor and survives two-scheduler reopen", async () => {
  const now = 2_000_000_530_000
  const f = fixture({
    shared: true,
    delayed: true,
    independent: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "concurrent-admission.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  const peer = new TaskRuntime(f.store, f.host, "project", undefined, {
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
  })
  cleanup.push(() => void peer.stop())
  let signalCreated!: () => void
  let releaseCreate!: () => void
  const created = new Promise<void>((resolve) => (signalCreated = resolve))
  const createGate = new Promise<void>((resolve) => (releaseCreate = resolve))
  const nativeCreate = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    await nativeCreate(input)
    signalCreated()
    await createGate
  }
  let failArchive = true
  const nativeUpdate = f.host.updateSession!
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived && failArchive) {
      failArchive = false
      throw new Error("hold transfer for reopen")
    }
    await nativeUpdate(input)
  }

  const tick = f.runtime.tick()
  await created
  const lateTask = f.createTask("late", "late-concurrent-plan.txt")
  const lateReceipt = f.store.submit(
    f.inputFor([lateTask], { requestID: "late-plan-during-successor-create" }),
    "owner",
  )
  await peer.tick()
  releaseCreate()
  await tick

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("archiving")
  expect(f.store.architectRenewalForPlan(lateReceipt.planID)?.id).toBe(renewal.id)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.store.plan(lateReceipt.planID)?.owner).toBe(renewal.successor_session_id)
  const handoff = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>("SELECT payload FROM runner_outbox WHERE id=?")
      .get(renewal.handoff_outbox_id!)!,
  )
  const handoffPayload = JSON.parse(handoff.payload)
  expect(handoffPayload.planIDs).toContain(lateReceipt.planID)
  expect(handoffPayload.planVersions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ planID: f.receipt.planID }),
      expect.objectContaining({ planID: lateReceipt.planID }),
    ]),
  )
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)

  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopenedRepository = new TaskRepository(f.repository.path, f.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopenedA = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
  })
  const reopenedB = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
  })
  cleanup.unshift(() => {
    void reopenedA.stop()
    void reopenedB.stop()
    reopenedRepository.close()
  })
  await Promise.all([reopenedA.tick(), reopenedB.tick()])

  expect(reopenedStore.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(reopenedStore.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(reopenedStore.plan(lateReceipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  expect(reopenedStore.attempts(f.receipt.planID)[0]?.session_id).toBe(attempt.session_id)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("shared-database renewal recovery is invisible to a different canonical project", async () => {
  const now = 2_000_000_540_000
  const f = fixture({
    shared: true,
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "project-isolation.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived)
      throw new Error("foreign scheduler must not retry this archive")
    await update(input)
  }
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("archiving")

  const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "lazers-other-project-")))
  const otherRepository = new TaskRepository(f.repository.path, otherRoot)
  const otherStore = new RunnerStore(otherRepository)
  const otherRuntime = new TaskRuntime(otherStore, f.host, "other-project", undefined, {
    now: () => now,
    architectPromptHook: true,
  })
  cleanup.unshift(() => {
    void otherRuntime.stop()
    otherRepository.close()
    rmSync(otherRoot, { recursive: true, force: true })
  })
  let foreignSessionReads = 0
  const session = f.host.session
  f.host.session = async (id, options) => {
    foreignSessionReads++
    return session(id, options)
  }

  await otherRuntime.tick()

  expect(foreignSessionReads).toBe(0)
  expect(otherStore.architectRenewalsNeedingRecovery()).toEqual([])
  expect(otherStore.architectSources()).toEqual([])
  expect(otherStore.architectRenewal(renewal.id)).toBeNull()
  expect(otherStore.architectRenewalForSource("owner")).toBeNull()
  expect(otherStore.architectSource("owner")).toBeNull()
  expect(otherStore.architectSourceInputs("owner")).toEqual([])
  expect(
    otherStore.observeArchitectInput("owner", "foreign-user-input", now, {
      type: "user",
      userPrompt: true,
    }),
  ).toMatchObject({ renewal: null, state: null })
  expect(f.store.architectRenewal(renewal.id)).toMatchObject({
    state: "archiving",
    error: "foreign scheduler must not retry this archive",
  })
})
