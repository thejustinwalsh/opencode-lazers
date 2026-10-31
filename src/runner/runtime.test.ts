import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import { RunnerStore } from "./store.ts"
import { PlanInput } from "./schema.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})
function fixture(options: { fail?: boolean; human?: boolean; outside?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lazers-runner-"))
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
  writeFileSync(join(root, "dirty-sentinel.txt"), "preserve me")
  const repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root)
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
    session: async (id) => structuredClone(sessions.get(id) ?? null),
    skills: async () => [],
    assemble: async (input) => ({
      text: JSON.stringify({
        specification: input.proposal,
        source: input.source,
        skills: input.skills,
      }),
      metadata: { source: input.source },
    }),
    create: async (input) => {
      events.push(`create:${input.id}`)
      sessions.set(input.id, {
        id: input.id,
        parentID: input.parentID,
        projectID: "project",
        directory: input.directory,
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
      const session = sessions.get(input.sessionID)!
      session.messages.push({ id: input.id, text: input.text })
      const spec = JSON.parse(input.text)
      const path = spec.specification.writeScope[0] as string
      if (path === "b.txt") expect(readFileSync(join(session.directory, "a.txt"), "utf8")).toBe("a")
      writeFileSync(join(session.directory, path), path[0]!)
      if (options.outside) writeFileSync(join(session.directory, "escape.txt"), "bad")
      session.outcome = "succeeded"
    },
    notify: async (input) => {
      events.push(`notify:${input.id}`)
      sessions.get(input.sessionID)!.messages.push({ id: input.id, text: input.text })
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
    baseCommit: base,
    nodes: tasks.map((t) => ({ taskID: t.id, revision: 1 as const })),
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
  const receipt = store.submit(input, "owner")
  cleanup.push(() => {
    runtime.stop()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, repository, store, tasks, sessions, events, host, runtime, input, receipt, base }
}
async function drive(runtime: TaskRuntime, count = 8) {
  for (let n = 0; n < count; n++) await runtime.tick()
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
  await drive(f.runtime)
  expect(f.events.filter((e) => e.startsWith("create:"))).toHaveLength(2)
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
