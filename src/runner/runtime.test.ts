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
    independent?: boolean
    delayed?: boolean
    wrongFirstA?: boolean
    allowScopeOverlap?: boolean
    taskFiles?: { name: string; path: string; scope?: string[] }[]
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
        model: input.model,
        archived: false,
        busy: false,
        tokens: 100,
        tools: 1,
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
    notify: async (input) => {
      events.push(`notify:${input.id}`)
      sessions.get(input.sessionID)!.messages.push({ id: input.id, text: input.text })
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
      nodes: selected.map((task) => ({ taskID: task.id, revision: 1 as const })),
      dependencies: dependencies.map(([prerequisite, successor]) => ({
        prerequisite: selected[prerequisite]!.id,
        successor: selected[successor]!.id,
      })),
      integrationOrder: selected.map((task) => task.id),
      verification: [
        {
          id: "combined",
          command: `test "$(cat ${files.map((file) => file.path).join(" ")})" = "${files.map((file) => file.name).join("")}"`,
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
  const receipt = store.submit(input, "owner")
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
    host,
    runtime,
    input,
    inputFor,
    createTask,
    completeWorker,
    receipt,
    base,
  }
}
async function drive(runtime: TaskRuntime, count = 8) {
  for (let n = 0; n < count; n++) await runtime.tick()
}
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

test("lost worktree creation response reconciles without dispatching a blocked worker", async () => {
  const f = fixture({ independent: true, delayed: true })
  const create = f.host.worktree
  let loseFirstResponse = true
  let createCalls = 0
  f.host.worktree = async (input) => {
    createCalls++
    const directory = await create(input)
    if (loseFirstResponse) {
      loseFirstResponse = false
      throw new Error("native worktree response lost")
    }
    return directory
  }
  await runPlan(f)
  await f.runtime.tick()
  expect(createCalls).toBe(2)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(0)
  expect(
    f.store.effects(f.receipt.planID).filter((effect) => effect.kind === "worktree"),
  ).toHaveLength(2)

  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  try {
    await reopened.tick()
    expect(
      f.store
        .effects(f.receipt.planID)
        .find((effect) => effect.state === "completed" && effect.kind === "worktree"),
    ).toBeTruthy()
    await reopened.tick()
    expect(
      f.store.attempts(f.receipt.planID).every((attempt) => attempt.state === "cancelled"),
    ).toBe(true)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(0)
    expect(await f.host.worktrees()).toHaveLength(3)
    expect(createCalls).toBe(2)
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
