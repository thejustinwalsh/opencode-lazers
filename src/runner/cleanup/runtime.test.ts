import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../../test/proposal.ts"
import { TaskRepository } from "../../storage.ts"
import { git } from "../artifacts.ts"
import type { HostSession, RunnerHost } from "../host.ts"
import { TaskRuntime } from "../runtime.ts"
import { RunnerStore } from "../store.ts"
import { sameCanonicalProjectDirectory } from "./canonical-ownership.ts"
import { settleVerification } from "../../../test/runner/verification-driver.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function cleanupFixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-cleanup-project-drift-"))
  const dataDirectory = mkdtempSync(join(tmpdir(), "lazers-cleanup-project-drift-data-"))
  const foreignDirectory = mkdtempSync(join(tmpdir(), "lazers-cleanup-project-drift-foreign-"))
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
  const repository = new TaskRepository(join(dataDirectory, "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  const task = validProposal()
  task.objective = "Verify cleanup after native project identity drift"
  task.writeScope = ["result.txt"]
  task.verification = [
    {
      id: "content",
      command: 'test "$(cat result.txt)" = "ready"',
      inactivityTimeoutMs: 2_000,
      hardTimeoutMs: 10_000,
    },
  ]
  task.acceptance = [
    {
      id: "correct",
      assertion: "The generated result is exact",
      evidence: [{ kind: "verification", verificationID: "content" }],
    },
  ]
  const taskRow = repository.insert({
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
    proposal: task,
  })
  const combinedChecks = [
    {
      id: "combined",
      command: 'test "$(cat result.txt)" = "ready"',
      inactivityTimeoutMs: 2_000,
      hardTimeoutMs: 10_000,
    },
  ]
  const submission = store.submit(
    {
      requestID: "cleanup-project-drift-plan",
      draft: true,
      objective: task.objective,
      baseCommit: base,
      workspaceMode: "isolated",
      nodes: [{ taskID: taskRow.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [taskRow.id],
      verification: combinedChecks,
      acceptance: [
        {
          id: "combined",
          assertion: "The integrated result is exact",
          evidence: [{ kind: "verification", verificationID: "combined" }],
        },
      ],
    },
    "owner",
  )

  const owner: HostSession = {
    id: "owner",
    projectID: "project",
    directory: root,
    agent: "architect",
    archived: false,
    busy: false,
    tokens: 0,
    tools: 0,
    cost: null,
    messages: [],
  }
  const sessions = new Map<string, HostSession>([["owner", owner]])
  const removed: string[] = []
  let canonicalEvidence: string | undefined
  let failNextNativeRemoval = false
  let clock = Date.now()
  const host: RunnerHost & {
    nativeProjectCanonicalDirectory(projectID: string): Promise<string | undefined>
  } = {
    workerModel: async () => ({ providerID: "openai", id: "cleanup-test" }),
    worktree: async ({ directory, base: branch }) => {
      git(root, ["worktree", "add", "--detach", directory, branch])
      return directory
    },
    worktrees: async () =>
      git(root, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length)),
    removeWorktree: async (directory) => {
      removed.push(directory)
      if (directory.endsWith(".worktrees/") || directory === root)
        throw new Error("Refusing unexpected worktree cleanup target")
      if (failNextNativeRemoval) {
        failNextNativeRemoval = false
        throw new Error("Native worktree removal response failed")
      }
      git(root, ["worktree", "remove", directory])
    },
    nativeProjectCanonicalDirectory: async (projectID) =>
      projectID === "drifted-project" ? canonicalEvidence : undefined,
    session: async (id) => structuredClone(sessions.get(id) ?? null),
    create: async (input) => {
      sessions.set(input.id, {
        id: input.id,
        parentID: input.parentID,
        projectID: "project",
        directory: input.directory,
        agent: input.agent,
        metadata: { lazersAttemptID: input.attemptID },
        archived: false,
        busy: false,
        pendingInput: false,
        pendingPermissions: 0,
        pendingForms: 0,
        runningShells: 0,
        activeChildren: 0,
        tokens: 0,
        tools: 0,
        cost: null,
        messages: [],
      })
    },
    createArchitect: async (input) => {
      sessions.set(input.id, {
        id: input.id,
        ...(input.parentID ? { parentID: input.parentID } : {}),
        projectID: "project",
        directory: input.directory,
        agent: "architect",
        metadata: {
          lazersContinuation: true,
          lazersPlanID: input.planID,
          ...(input.planIDs ? { lazersPlanIDs: input.planIDs } : {}),
          lazersSourceSessionID: input.sourceSessionID,
        },
        archived: false,
        busy: false,
        tokens: 0,
        tools: 0,
        cost: null,
        messages: [],
      })
    },
    prompt: async (input) => {
      const worker = sessions.get(input.sessionID)!
      mkdirSync(input.directory, { recursive: true })
      writeFileSync(join(input.directory, "result.txt"), "ready")
      git(input.directory, ["add", "result.txt"])
      git(input.directory, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Implement result",
      ])
      worker.messages.push({ id: input.id, text: input.text })
      worker.turn = { inputID: input.id, state: "completed" }
      worker.outcome = "succeeded"
      worker.busy = false
    },
    retireIntegratedWorker: async (input) => {
      const worker = sessions.get(input.sessionID)
      if (
        !worker ||
        worker.id !== input.sessionID ||
        worker.directory !== input.workspace ||
        worker.metadata?.lazersAttemptID !== input.attemptID ||
        worker.busy ||
        (worker.projectID !== input.projectID &&
          !sameCanonicalProjectDirectory(root, canonicalEvidence))
      )
        throw new Error("Integrated worker ownership or activity changed")
      worker.archived = true
    },
    outcomeInbox: async () => [],
    architectInputPage: async () => ({ inbox: [], messages: [], nextCursor: null }),
    notify: async () => {},
    interrupt: async () => {},
    waitForSession: async () => {},
    updateInstruction: async () => {},
  }
  const runtime = new TaskRuntime(store, host, "project", undefined, {
    autoResumeInterrupted: false,
    fallowReview: "off",
    requestTick: () => Promise.resolve(),
    now: () => clock,
  })
  const disposal = async () => {
    await runtime.stop()
    repository.close()
    rmSync(`${root}.worktrees`, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(dataDirectory, { recursive: true, force: true })
    rmSync(foreignDirectory, { recursive: true, force: true })
  }
  cleanup.push(disposal)

  const integrate = (candidate: TaskRuntime, requestID: string) => {
    const plan = store.plan(submission.planID)!
    return candidate.command(
      {
        requestID,
        planID: plan.id,
        action: "integrated",
        artifact: plan.artifact!,
        targetBranch: "main",
        reason: "Retry the reviewed cleanup with fresh canonical ownership evidence",
      },
      "owner",
    )
  }

  return {
    root,
    foreignDirectory,
    repository,
    store,
    taskRow,
    submission,
    host,
    sessions,
    removed,
    runtime,
    integrate,
    setCanonicalEvidence: (directory: string | undefined) => (canonicalEvidence = directory),
    setFailNextNativeRemoval: () => (failNextNativeRemoval = true),
    advanceClock: (milliseconds: number) => (clock += milliseconds),
    reopen: () => {
      store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
      return new TaskRuntime(store, host, "project", undefined, {
        autoResumeInterrupted: false,
        fallowReview: "off",
        requestTick: () => Promise.resolve(),
        now: () => clock,
      })
    },
  }
}

test("public integrated cleanup retries native project-ID drift only after fresh exact ownership proof", async () => {
  const f = await cleanupFixture()
  let runtime = f.runtime
  try {
    await runtime.command(
      { requestID: "run-cleanup-drift", planID: f.submission.planID, action: "run" },
      "owner",
    )
    for (let round = 0; round < 10; round++) await settleVerification(runtime)
    const plan = f.store.plan(f.submission.planID)!
    expect(plan.state).toBe("accepted")
    const attempt = f.store.attempts(plan.id)[0]!
    const worker = f.sessions.get(attempt.session_id)!
    git(f.root, ["merge", "--ff-only", plan.artifact!])
    worker.projectID = "drifted-project"

    await f.integrate(runtime, "integrate-without-canonical-evidence")
    await runtime.tick()
    expect(f.store.plan(plan.id)).toMatchObject({ state: "cleanup-blocked" })
    expect(f.store.plan(plan.id)?.reason).toContain("project identity")
    expect(existsSync(attempt.workspace)).toBe(true)
    expect(f.removed).not.toContain(attempt.workspace)

    await runtime.stop()
    runtime = f.reopen()
    f.setCanonicalEvidence(f.foreignDirectory)
    await f.integrate(runtime, "integrate-with-foreign-canonical-evidence")
    await runtime.tick()
    expect(f.store.plan(plan.id)).toMatchObject({ state: "cleanup-blocked" })
    expect(existsSync(attempt.workspace)).toBe(true)
    expect(f.removed).not.toContain(attempt.workspace)

    f.setCanonicalEvidence(f.root)
    const originalProjectLookup = f.host.nativeProjectCanonicalDirectory
    const originalWorktrees = f.host.worktrees
    let worktreeReads = 0
    let finalInventoryPassed = false
    let introducedActivity = false
    f.host.worktrees = async () => {
      const paths = await originalWorktrees()
      worktreeReads++
      if (worktreeReads === 2) finalInventoryPassed = true
      return paths
    }
    f.host.nativeProjectCanonicalDirectory = async (projectID) => {
      const directory = await originalProjectLookup(projectID)
      if (finalInventoryPassed && !introducedActivity) {
        introducedActivity = true
        worker.busy = true
      }
      return directory
    }
    await f.integrate(runtime, "integrate-with-last-moment-activity")
    await runtime.tick()
    expect(introducedActivity).toBe(true)
    expect(f.store.plan(plan.id)).toMatchObject({ state: "cleanup-blocked" })
    expect(f.store.plan(plan.id)?.reason).toContain("worker session is busy")
    expect(existsSync(attempt.workspace)).toBe(true)
    expect(f.removed).not.toContain(attempt.workspace)

    f.host.worktrees = originalWorktrees
    f.host.nativeProjectCanonicalDirectory = originalProjectLookup
    worker.busy = false
    f.advanceClock(6_000)
    f.setFailNextNativeRemoval()
    await f.integrate(runtime, "integrate-native-removal-failure")
    await runtime.tick()
    expect(f.store.plan(plan.id)).toMatchObject({ state: "cleanup-blocked" })
    expect(f.store.plan(plan.id)?.reason).toContain("Native worktree removal response failed")
    expect(existsSync(attempt.workspace)).toBe(true)
    expect(
      f.store
        .effects(plan.id)
        .find(
          (effect) =>
            effect.kind === "worktree-remove" &&
            JSON.parse(effect.payload).workspace === attempt.workspace,
        )?.state,
    ).toBe("uncertain")

    f.advanceClock(60_000)
    await f.integrate(runtime, "integrate-after-native-removal-retry")
    await runtime.tick()
    expect(f.store.plan(plan.id)).toMatchObject({ state: "integrated", reason: null })
    expect(existsSync(attempt.workspace)).toBe(false)
    expect(f.removed.filter((directory) => directory === attempt.workspace)).toHaveLength(2)
    const removal = f.store
      .effects(plan.id)
      .find(
        (effect) =>
          effect.kind === "worktree-remove" &&
          JSON.parse(effect.payload).workspace === attempt.workspace,
      )!
    expect(removal.state).toBe("completed")
    expect(JSON.parse(removal.receipt!)).toMatchObject({
      workspace: attempt.workspace,
      removed: true,
      native: true,
    })

    const callsAfterRemoval = f.removed.length
    await runtime.tick()
    expect(f.removed).toHaveLength(callsAfterRemoval)
  } finally {
    await runtime.stop()
  }
})
