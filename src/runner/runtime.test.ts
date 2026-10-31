import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import { RunnerStore } from "./store.ts"
import { PlanInput } from "./schema.ts"
import type { WorkerPersona } from "./schema.ts"
import { TaskReads } from "../tasks/read.ts"

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
  const tasks = ["a", "b"].map((name, index) => {
    const proposal = validProposal()
    proposal.objective = `Write ${name}.txt`
    proposal.writeScope = [`${name}.txt`]
    proposal.verification = [
      {
        id: "content",
        command: options.fail && index === 0 ? "exit 7" : `test "$(cat ${name}.txt)" = ${name}`,
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
  const host: RunnerHost = {
    workerModel: async () => options.workerModel ?? { providerID: "openai", id: "test-model" },
    worktree: async ({ directory, base }) => {
      git(root, ["worktree", "add", "--detach", directory, base])
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
      const path = repository.get(assigned.task_id)!.proposal.writeScope[0]!
      if (path === "b.txt") expect(readFileSync(join(session.directory, "a.txt"), "utf8")).toBe("a")
      const wrongFirstB = options.wrongFirstB && path === "b.txt" && assigned.number === 1
      if (wrongFirstB) {
        session.tokens = 65941
        session.tools = 17
        session.cost = 1.25
      }
      writeFileSync(join(session.directory, path), wrongFirstB ? "wrong" : path[0]!)
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
      session.outcome = "succeeded"
    },
    notify: async (input) => {
      events.push(`notify:${input.id}`)
      const messages = sessions.get(input.sessionID)!.messages
      if (!messages.some((message) => message.id === input.id))
        messages.push({ id: input.id, text: input.text })
    },
    interrupt: async (id) => {
      sessions.get(id)!.busy = false
      sessions.get(id)!.outcome = "interrupted"
    },
  }
  const runtime = new TaskRuntime(store, host, "project")
  const input = {
    requestID: "plan-request",
    objective: "Two dependent exact-content files",
    workspaceMode: options.shared ? ("shared" as const) : ("isolated" as const),
    baseCommit: base,
    ...(options.workerModel ? { workerModel: options.workerModel } : {}),
    nodes: tasks.map((t, index) => {
      const persona = options.personas?.[index]
      return {
        taskID: t.id,
        revision: 1 as const,
        ...(persona ? { persona } : {}),
      }
    }),
    dependencies: [{ prerequisite: tasks[0]!.id, successor: tasks[1]!.id }],
    integrationOrder: tasks.map((t) => t.id),
    verification: [
      { id: "combined", command: "test $(cat a.txt)$(cat b.txt) = ab", timeoutMs: 1000 },
    ],
    acceptance: [
      {
        id: "combined",
        assertion: "Both changes coexist",
        evidence: [{ kind: "verification" as const, verificationID: "combined" }],
      },
    ],
  }
  const receipt = options.startOnly ? undefined : store.submit(input, "owner")
  cleanup.push(() => {
    runtime.stop()
    repository.close()
    rmSync(root, { recursive: true, force: true })
    if (options.shared) rmSync(stateDirectory, { recursive: true, force: true })
  })
  return {
    root,
    repository,
    store,
    tasks,
    sessions,
    events,
    host,
    runtime,
    input,
    receipt: receipt!,
    base,
  }
}
async function drive(runtime: TaskRuntime, count = 8) {
  for (let n = 0; n < count; n++) await runtime.tick()
}

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
  const f = fixture({ shared: true, workerModel: selected })
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

test("an archived Architect is replaced by one linked owner and uncertain delivery reuses its message ID", async () => {
  const f = fixture({ shared: true, commit: true })
  f.sessions.get("owner")!.archived = true
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.owner).not.toBe("owner")
  expect(f.sessions.get(plan.owner)?.parentID).toBe("owner")
  expect(f.sessions.get(plan.owner)?.agent).toBe("architect")

  const original = f.host.notify
  let calls = 0
  f.host.notify = async (input) => {
    calls++
    if (calls === 1) throw new Error("delivery response lost before admission")
    await original(input)
  }
  for (let index = 0; index < 20 && calls === 0; index++) await f.runtime.tick()
  const deliveries = () =>
    f.store.detail(plan.id).delivery as { id: string; message_id: string; state: string }[]
  const uncertain = deliveries().find((item) => item.state === "uncertain")!
  const messageIDBeforeRestart = uncertain.message_id

  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  await drive(reopened)
  const delivery = deliveries().find((item) => item.id === uncertain.id)!
  expect(delivery.state).toBe("delivered")
  expect(delivery.message_id).toBe(messageIDBeforeRestart)
  expect(calls).toBeGreaterThanOrEqual(2)
  const received = f.sessions
    .get(plan.owner)!
    .messages.filter((message) => message.id === messageIDBeforeRestart)
  expect(received).toHaveLength(1)
  expect(
    f.store.attempts(plan.id).filter((attempt) => attempt.task_id === f.tasks[0]!.id),
  ).toHaveLength(1)
})
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
    f.sessions.get("owner")!.messages.some((m) => m.text.includes('"status":"accepted"')),
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
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("ready")
  await f.runtime.tick()
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
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  for (let i = 0; i < 12 && f.store.execution(f.tasks[0]!.id)?.state !== "accepted"; i++)
    await f.runtime.tick()
  expect(f.store.execution(f.tasks[0]!.id)?.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  const predecessor = f.store.attempts(f.receipt.planID)[0]!
  const predecessorArtifact = predecessor.artifact
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
  const reviewedHead = git(f.root, ["rev-parse", "HEAD"])
  expect(reviewedHead).not.toBe(predecessorArtifact)
  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  await drive(reopened)
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
