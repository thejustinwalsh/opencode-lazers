import { expect, test } from "bun:test"
import { withFallowConfig } from "../../test/runner/fallow-config.ts"
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
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import type { RetainedVerification } from "./retained-verification/schema.ts"
import {
  createRetainedVerification,
  retainedVerification,
  saveRetainedVerification,
} from "./retained-verification/store.ts"
import type { EffectRow, PlanRow } from "./store.ts"
import { RunnerStore } from "./store.ts"
import { canonicalProjectWorktreePath } from "./workspace-location.ts"

test("a terminal retained verification whose cleanup is stuck is probed on the fallback interval, not every tick", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-retained-stuck-project-")))
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), "lazers-retained-stuck-data-")))
  const databasePath = join(dataDirectory, "tasks.sqlite")
  const tracePath = join(dataDirectory, "git-trace.log")
  const priorGitTrace = process.env.GIT_TRACE
  const stuckWorkspace = canonicalProjectWorktreePath(root, "stuck")
  let repository: TaskRepository | undefined
  let runtime: TaskRuntime | undefined
  const clock = { now: Date.now() }
  let inventoryReads = 0
  const gitCalls = () =>
    existsSync(tracePath)
      ? readFileSync(tracePath, "utf8").split(/\r?\n/).filter(Boolean).length
      : 0
  let fence = 1
  const reconcile = (candidate: TaskRuntime) =>
    (
      candidate as unknown as {
        retainedVerificationExecution: {
          reconcileTerminalRetainedVerifications(fence: number): Promise<void>
        }
      }
    ).retainedVerificationExecution.reconcileTerminalRetainedVerifications(fence)
  try {
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
    repository = new TaskRepository(databasePath, root)
    const store = new RunnerStore(repository)
    const proposal = validProposal()
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
        sessionID: "ses-retained-cleanup-probe-owner",
        startingRevision: { kind: "git", commit: base },
      },
      proposal,
    })
    const planID = store.submit(
      {
        requestID: "retained-cleanup-probe-plan",
        objective: "Avoid repeated inventory for already completed retained cleanup",
        baseCommit: base,
        workspaceMode: "isolated",
        nodes: [{ taskID: task.id, revision: 1 }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: proposal.verification,
        acceptance: proposal.acceptance,
      },
      "ses-retained-cleanup-probe-owner",
    ).planID
    const operation: RetainedVerification = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      projectID: "project",
      projectDirectory: root,
      planID,
      planRevision: 1,
      owner: "ses-retained-cleanup-probe-owner",
      taskID: task.id,
      taskRevision: 1,
      attemptID: crypto.randomUUID(),
      originalSessionID: "ses-retained-cleanup-probe-worker",
      originalMessageID: "msg-retained-cleanup-probe-input",
      originalWorkspace: root,
      artifact: "a".repeat(40),
      taskWorkspace: stuckWorkspace,
      taskWorkspaceState: "owned",
      environmentIdentity: "{}",
      reason: "Completed cleanup fixture",
      state: "failed",
      failureReason: null,
      cleanupState: "failed",
      createdAt: clock.now,
      updatedAt: clock.now,
    }
    repository.atomic((db) => createRetainedVerification(db, root, operation))
    mkdirSync(stuckWorkspace, { recursive: true })
    const host = {
      worktrees: async () => {
        inventoryReads++
        return [stuckWorkspace]
      },
    } as unknown as RunnerHost
    runtime = new TaskRuntime(withFallowConfig(store), host, "project", undefined, {
      now: () => clock.now,
      requestTick: () => Promise.resolve(),
    })
    fence = store.claim(runtime.owner)!
    process.env.GIT_TRACE = tracePath
    await reconcile(runtime)
    const writes = () =>
      repository!.read((db) => db.query<{ n: number }, []>("SELECT total_changes() n").get()!.n)
    expect(repository.read((db) => retainedVerification(db, operation.id))?.cleanupState).toBe(
      "failed",
    )
    // The first pass settles the record; a pass that moves no fact is the one that is gated.
    await reconcile(runtime)
    const reads0 = inventoryReads
    const git0 = gitCalls()
    const changes0 = writes()
    for (let i = 0; i < 10; i++) await reconcile(runtime)
    if (process.env.READ_SWEEP_NUMBERS)
      console.log(
        `[idle-retained] 10 stuck ticks: inventory=${inventoryReads - reads0} git=${gitCalls() - git0} writes=${writes() - changes0}`,
      )
    expect(inventoryReads).toBe(reads0)
    expect(gitCalls()).toBe(git0)
    expect(writes()).toBe(changes0)

    // The exit: the fallback interval passes, and a changed record runs it at once.
    clock.now += 60_000
    await reconcile(runtime)
    expect(inventoryReads).toBeGreaterThan(reads0)
    const after = inventoryReads
    await reconcile(runtime)
    expect(inventoryReads).toBe(after)
    repository.atomic((db) => {
      const current = retainedVerification(db, operation.id)!
      saveRetainedVerification(db, { ...current, updatedAt: clock.now + 1 })
    })
    await reconcile(runtime)
    expect(inventoryReads).toBeGreaterThan(after)
  } finally {
    await runtime?.stop()
    repository?.close()
    if (priorGitTrace === undefined) delete process.env.GIT_TRACE
    else process.env.GIT_TRACE = priorGitTrace
    rmSync(`${root}.worktrees`, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(dataDirectory, { recursive: true, force: true })
  }
}, 120_000)
