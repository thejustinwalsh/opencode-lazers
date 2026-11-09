import { afterEach, expect, test } from "bun:test"
import { settleVerification } from "../../test/runner/verification-driver.ts"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import { RunnerStore } from "./store.ts"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-failed-resume-"))
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
  const stateDirectory = mkdtempSync(join(tmpdir(), "lazers-failed-resume-data-"))
  const repository = new TaskRepository(join(stateDirectory, "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  const proposal = validProposal()
  proposal.objective = "Write a resumed result"
  proposal.writeScope = ["result.txt"]
  proposal.verification = [
    { id: "content", command: 'test "$(cat result.txt)" = "correct"', timeoutMs: 1000 },
  ]
  proposal.acceptance = [
    {
      id: "correct",
      assertion: "The result contains the requested content",
      evidence: [{ kind: "verification", verificationID: "content" }],
    },
  ]
  proposal.limits.maxRepairAttempts = 0
  const taskID = crypto.randomUUID()
  repository.insert({
    schemaVersion: 1,
    id: taskID,
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
  const plan = store.submit(
    {
      requestID: "resume-plan",
      objective: proposal.objective,
      workspaceMode: "shared",
      baseCommit: base,
      nodes: [{ taskID, revision: 1 }],
      dependencies: [],
      integrationOrder: [taskID],
      verification: [
        { id: "combined", command: 'test "$(cat result.txt)" = "correct"', timeoutMs: 1000 },
      ],
      acceptance: [
        {
          id: "combined",
          assertion: "The accepted task artifact passes the combined check",
          evidence: [{ kind: "verification", verificationID: "combined" }],
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
        tokens: null,
        tools: 0,
        cost: null,
        messages: [],
      },
    ],
  ])
  const created: string[] = []
  const prompted: string[] = []
  const worktrees: string[] = []
  const host: RunnerHost = {
    workerModel: async () => ({ providerID: "openai", id: "test-model" }),
    worktree: async ({ directory }) => {
      worktrees.push(directory)
      throw new Error("Shared resume must not allocate a worktree")
    },
    worktrees: async () => [],
    removeWorktree: async () => {},
    session: async (id) => structuredClone(sessions.get(id) ?? null),
    create: async (input) => {
      created.push(input.id)
      sessions.set(input.id, {
        id: input.id,
        parentID: input.parentID,
        projectID: "project",
        directory: input.directory,
        agent: input.agent,
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
        tokens: 0,
        tools: 0,
        cost: null,
        messages: [],
      })
    },
    createArchitect: async () => {},
    prompt: async (input) => {
      prompted.push(input.sessionID)
      const session = sessions.get(input.sessionID)!
      const first = prompted.length === 1
      writeFileSync(join(input.directory, "result.txt"), first ? "wrong\n" : "correct\n")
      git(input.directory, ["add", "result.txt"])
      git(input.directory, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        `Prompt ${prompted.length}`,
      ])
      session.messages.push({ id: input.id, text: input.text })
      session.busy = false
      session.outcome = "succeeded"
      session.turn = { inputID: input.id, state: "completed" }
      if (session.background?.state === "observed") session.background.inputID = input.id
      session.tokens = first ? 123 : 200
      session.tools = first ? 7 : 10
      session.cost = first ? 0.25 : 0.5
    },
    updateInstruction: async () => {},
    notify: async () => {},
    interrupt: async (id) => {
      const session = sessions.get(id)
      if (session) {
        session.busy = false
        session.outcome = "interrupted"
        if (session.turn) session.turn = { inputID: session.turn.inputID, state: "interrupted" }
      }
    },
  }
  const runtime = new TaskRuntime(store, host, "project", undefined, {
    requestTick: async () => {},
  })
  cleanup.push(async () => {
    await runtime.stop()
    repository.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(stateDirectory, { recursive: true, force: true })
  })
  return {
    root,
    base,
    planID: plan.planID,
    store,
    runtime,
    sessions,
    created,
    prompted,
    worktrees,
  }
}

async function leaveFailedAttempt(f: ReturnType<typeof fixture>) {
  await f.runtime.command(
    { requestID: "run", planID: f.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  expect(f.prompted).toHaveLength(1)
  await settleVerification(f.runtime)
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(f.planID)[0]?.state).toBe("failed")
  return f.store.attempts(f.planID)[0]!
}

test("explicit resume continues a stopped failed attempt with its history and receipt intact", async () => {
  const f = fixture()
  const original = await leaveFailedAttempt(f)
  const failedReceipt = f.store
    .effects(f.planID)
    .find((effect) => effect.attempt_id === original.id && effect.kind === "verify:content")!
  const failedReceiptJSON = failedReceipt.receipt
  const originalPolicy = original.policy
  expect(original).toMatchObject({ token_count: 123, tool_count: 7, cost: 0.25 })
  expect(JSON.parse(failedReceiptJSON!).check).toMatchObject({ exitCode: 1 })
  expect(
    f.store
      .progressFacts([original.id])
      .some(
        (fact) =>
          fact.kind === "execution-outcome" &&
          JSON.parse(fact.payload).outcome === "failed" &&
          JSON.parse(fact.payload).reason.includes("Verification content exited"),
      ),
  ).toBe(true)

  const command = {
    requestID: "resume-failed",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "resume",
    taskID: original.task_id,
    reason: "Continue the failed attempt in its retained workspace",
  }
  const resumed = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(resumed)
  expect(resumed).toMatchObject({ status: "resuming" })
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: original.id,
    number: original.number,
    session_id: original.session_id,
    workspace: original.workspace,
    policy: originalPolicy,
    token_count: 123,
    tool_count: 7,
    cost: 0.25,
    state: "preparing",
  })

  for (let tick = 0; tick < 20 && f.store.plan(f.planID)?.state !== "accepted"; tick++)
    await settleVerification(f.runtime)

  expect(f.store.plan(f.planID)?.state).toBe("accepted")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: original.id,
    number: original.number,
    session_id: original.session_id,
    workspace: original.workspace,
    policy: originalPolicy,
    token_count: 200,
    tool_count: 10,
    cost: 0.5,
    state: "accepted",
  })
  expect(f.created).toEqual([original.session_id])
  expect(f.prompted).toEqual([original.session_id, original.session_id])
  expect(f.worktrees).toEqual([])
  const checks = f.store
    .effects(f.planID)
    .filter((effect) => effect.attempt_id === original.id && effect.kind === "verify:content")
  expect(checks).toHaveLength(2)
  expect(checks.find((effect) => effect.id === failedReceipt.id)?.receipt).toBe(failedReceiptJSON)
  expect(
    JSON.parse(checks.find((effect) => effect.id !== failedReceipt.id)!.receipt!).check,
  ).toMatchObject({
    exitCode: 0,
  })
  expect(
    f.store.activity(f.planID, original.task_id).some((event) => {
      return (
        event.event === "FAIL" &&
        JSON.parse(event.payload).reason.includes("Verification content exited")
      )
    }),
  ).toBe(true)
})

test("failed-attempt resume preserves authorization, owner, and uncertain-effect guards", async () => {
  const f = fixture()
  const attempt = await leaveFailedAttempt(f)
  const version = f.store.plan(f.planID)!.version
  const command = {
    requestID: "resume-guard",
    planID: f.planID,
    expectedVersion: version,
    action: "resume",
    taskID: attempt.task_id,
    reason: "Continue only after guards pass",
  }

  await expect(f.runtime.command(command, "other")).rejects.toThrow("Only the plan owner")
  await expect(
    f.runtime.command(
      { ...command, requestID: "resume-stale", expectedVersion: version - 1 },
      "owner",
    ),
  ).rejects.toThrow("Stale plan version")

  f.sessions.get("owner")!.archived = true
  await expect(
    f.runtime.command({ ...command, requestID: "resume-owner-unavailable" }, "owner"),
  ).rejects.toThrow("Owner unavailable")
  f.sessions.get("owner")!.archived = false

  const promptEffect = f.store.effects(f.planID).find((effect) => effect.kind === "prompt")!
  for (const state of ["intended", "uncertain"] as const) {
    f.store.atomic((db) =>
      db.query("UPDATE runner_effects SET state=? WHERE id=?").run(state, promptEffect.id),
    )
    await expect(
      f.runtime.command({ ...command, requestID: `resume-${state}` }, "owner"),
    ).rejects.toThrow("Reconcile uncertain effects first")
    f.store.atomic((db) =>
      db.query("UPDATE runner_effects SET state='completed' WHERE id=?").run(promptEffect.id),
    )
  }

  expect(f.store.plan(f.planID)).toMatchObject({ state: "blocked", version })
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]?.state).toBe("failed")
  expect(f.prompted).toHaveLength(1)
  expect(f.created).toEqual([attempt.session_id])
})

test("RETRY after failure still starts a distinct retained attempt", async () => {
  const f = fixture()
  const original = await leaveFailedAttempt(f)
  const retryCommand = {
    requestID: "retry-failed",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "retry",
    taskID: original.task_id,
    reason: "Start a fresh attempt after reviewing the failed result",
    workspaceMode: "shared",
    baseCommit: f.base,
  }
  const retry = await f.runtime.command(retryCommand, "owner")
  expect(await f.runtime.command(retryCommand, "owner")).toEqual(retry)
  expect(retry).toMatchObject({ status: "retrying" })
  for (let tick = 0; tick < 20 && f.store.attempts(f.planID).length < 2; tick++)
    await settleVerification(f.runtime)

  const attempts = f.store.attempts(f.planID)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toMatchObject({
    id: original.id,
    number: original.number,
    session_id: original.session_id,
    state: "failed",
    token_count: 123,
    tool_count: 7,
    cost: 0.25,
  })
  expect(attempts[1]!.id).not.toBe(original.id)
  expect(attempts[1]!.number).toBe(original.number + 1)
  expect(attempts[1]!.session_id).not.toBe(original.session_id)
  expect(f.created).toHaveLength(2)
  expect(f.created[1]).toBe(attempts[1]!.session_id)
})
