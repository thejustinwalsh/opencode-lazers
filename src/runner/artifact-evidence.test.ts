import { afterEach, expect, test } from "bun:test"
import { settleVerification } from "../../test/runner/verification-driver.ts"
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import { RunnerStore } from "./store.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

type EvidenceDirectory = "populated" | "empty" | "empty-tree" | "missing"

function fixture(
  options: { evidenceDirectory?: EvidenceDirectory; failedCheck?: boolean; autoFix?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lazers-directory-artifact-"))
  const state = mkdtempSync(join(tmpdir(), "lazers-directory-artifact-state-"))
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
  const baseCommit = git(root, ["rev-parse", "HEAD"])
  const directoryReference = "evidence/037-artifact-evidence/"
  const evidencePath = join(root, "evidence", "037-artifact-evidence")
  const proposal = validProposal()
  proposal.objective = "Require a readable directory artifact with normal verification gates"
  proposal.writeScope = ["result.txt", "evidence/**"]
  proposal.context = [{ reference: "result.txt", revision: null }]
  proposal.verification = [
    {
      id: "check",
      command: options.failedCheck
        ? "exit 7"
        : options.autoFix
          ? "printf 'formatted\\n' > result.txt"
          : 'test "$(cat result.txt)" = "ok"',
      timeoutMs: 1000,
    },
  ]
  proposal.acceptance = [
    {
      id: "correct",
      assertion: "A verified task has readable directory evidence",
      evidence: [
        { kind: "artifact", reference: directoryReference },
        { kind: "verification", verificationID: "check" },
      ],
    },
  ]
  proposal.limits!.maxRepairAttempts = 0

  const repository = new TaskRepository(join(state, "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
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
      startingRevision: { kind: "git", commit: baseCommit },
    },
    proposal,
  })
  const input = {
    requestID: "directory-artifact-plan",
    objective: "Verify directory evidence without bypassing other gates",
    baseCommit,
    workspaceMode: "shared" as const,
    nodes: [{ taskID: task.id, revision: 1 as const }],
    dependencies: [],
    integrationOrder: [task.id],
    verification: [
      {
        id: "combined",
        command: 'test "$(cat result.txt)" = "ok"',
        timeoutMs: 1000,
      },
    ],
    acceptance: [
      {
        id: "combined",
        assertion: "The task result passes combined verification",
        evidence: [{ kind: "verification" as const, verificationID: "combined" }],
      },
    ],
  }
  const plan = store.submit(input, "owner")
  const events: string[] = []
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
        model: { providerID: "openai", id: "test-model" },
        tokens: null,
        tools: 0,
        cost: null,
        messages: [],
      },
    ],
  ])
  const host: RunnerHost = {
    workerModel: async () => ({ providerID: "openai", id: "test-model" }),
    worktree: async () => {
      throw new Error("The shared-workspace fixture must not create a worktree")
    },
    worktrees: async () => [root],
    removeWorktree: async () => {},
    session: async (id) => structuredClone(sessions.get(id) ?? null),
    outcomeInbox: async () => [],
    cancelOutcome: async () => {},
    create: async (worker) => {
      events.push("create")
      sessions.set(worker.id, {
        id: worker.id,
        parentID: worker.parentID,
        projectID: "project",
        directory: worker.directory,
        agent: worker.agent,
        metadata: { lazersAttemptID: worker.attemptID },
        archived: false,
        busy: true,
        model: worker.model,
        tokens: 0,
        tools: 0,
        cost: null,
        messages: [],
      })
    },
    createArchitect: async (architect) => {
      sessions.set(architect.id, {
        id: architect.id,
        parentID: architect.parentID,
        projectID: "project",
        directory: architect.directory,
        agent: "architect",
        archived: false,
        busy: false,
        model: architect.model,
        tokens: 0,
        tools: 0,
        cost: null,
        messages: [],
      })
    },
    prompt: async ({ sessionID, directory, id }) => {
      events.push("prompt")
      const mode = options.evidenceDirectory ?? "populated"
      writeFileSync(join(directory, "result.txt"), "ok\n")
      if (mode !== "missing") {
        mkdirSync(evidencePath, { recursive: true })
        if (mode === "empty-tree") mkdirSync(join(evidencePath, "nested"), { recursive: true })
        if (mode === "populated")
          writeFileSync(join(evidencePath, "verification.md"), "LZ37-shaped evidence\n")
      }
      git(directory, ["add", "--all"])
      git(directory, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "worker result",
      ])
      const session = sessions.get(sessionID)!
      session.busy = false
      session.outcome = "succeeded"
      session.turn = { inputID: id, state: "completed" }
      session.background = {
        state: "observed",
        source: "experimental.idle",
        observedAt: Date.now(),
        inputID: id,
        executionStartSequence: 1,
        eventSequence: 2,
        count: 0,
        kinds: { shell: 0, subagent: 0, image: 0 },
      }
    },
    updateInstruction: async () => {},
    notify: async () => {},
    interrupt: async (id) => {
      const session = sessions.get(id)
      if (session) {
        session.busy = false
        session.outcome = "interrupted"
      }
    },
  }
  const runtime = new TaskRuntime(store, host, "project")
  cleanup.push(() => {
    void runtime.stop()
    repository.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })
  return {
    root,
    evidencePath,
    directoryReference,
    task,
    planID: plan.planID,
    runtime,
    store,
    events,
  }
}

async function run(runtime: TaskRuntime, planID: string, count = 10) {
  await runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  for (let index = 0; index < count; index++) await settleVerification(runtime)
}

test("directory artifact evidence accepts only with matching checks", async () => {
  const f = fixture()
  await run(f.runtime, f.planID)

  expect(readFileSync(join(f.evidencePath, "verification.md"), "utf8")).toContain("LZ37-shaped")

  const originalChecks = f.store
    .effects(f.planID)
    .filter((effect) => effect.kind === "verify:check")
  expect(originalChecks).toHaveLength(1)
  const originalReceipt = originalChecks[0]!.receipt
  const checked = JSON.parse(originalReceipt!).check
  expect(checked).toMatchObject({ exitCode: 0, timedOut: false })
  expect(checked.inputIdentity).toBe(checked.artifact)
  expect(f.store.repository.get(f.task.id)?.proposal.acceptance[0]?.evidence[0]).toEqual({
    kind: "artifact",
    reference: f.directoryReference,
  })
  const artifactHead = git(f.root, ["rev-parse", "HEAD"])

  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  await f.runtime.command(
    {
      requestID: "reconcile-accepted-task",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  for (let index = 0; index < 10; index++) await settleVerification(f.runtime)

  expect(f.store.plan(f.planID)?.state).toBe("accepted")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  const reusedChecks = f.store.effects(f.planID).filter((effect) => effect.kind === "verify:check")
  expect(reusedChecks.map((effect) => effect.id)).toEqual([originalChecks[0]!.id])
  expect(reusedChecks[0]?.receipt).toBe(originalReceipt)
  expect(f.events).toEqual(["create", "prompt"])
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(artifactHead)
  expect(git(f.root, ["status", "--porcelain"])).toBe("")
})

test.each(["missing", "empty", "empty-tree"] as const)(
  "%s requested output remains missing",
  async (evidenceDirectory) => {
    const f = fixture({ evidenceDirectory })
    await run(f.runtime, f.planID)
    expect(f.store.plan(f.planID)?.state).toBe("blocked")
    expect(f.store.plan(f.planID)?.reason).toContain(`correct:${f.directoryReference}`)
    const check = f.store.effects(f.planID).find((effect) => effect.kind === "verify:check")
    expect(JSON.parse(check!.receipt!).check).toMatchObject({ exitCode: 0 })
  },
)

test("a failed command still prevents acceptance", async () => {
  const failed = fixture({ failedCheck: true })
  await run(failed.runtime, failed.planID)
  expect(failed.store.plan(failed.planID)?.state).toBe("blocked")
  expect(failed.store.plan(failed.planID)?.reason).toContain("Verification check exited")
  const failedCheck = failed.store
    .effects(failed.planID)
    .find((effect) => effect.kind === "verify:check")
  expect(JSON.parse(failedCheck!.receipt!).check).toMatchObject({ exitCode: 7 })
})

test("successful automatic fixes are committed and reach Architect review in the same attempt", async () => {
  const f = fixture({ autoFix: true })
  await run(f.runtime, f.planID)
  const attempt = f.store.attempts(f.planID)[0]!
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(git(f.root, ["show", `${attempt.artifact}:result.txt`])).toBe("formatted")
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(attempt.artifact!)
  expect(git(f.root, ["status", "--porcelain"])).toBe("")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
})
