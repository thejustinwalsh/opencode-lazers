import { expect, test } from "bun:test"
import { withFallowConfig } from "../../test/runner/fallow-config.ts"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import type { RetainedVerification } from "./retained-verification/schema.ts"
import { createRetainedVerification } from "./retained-verification/store.ts"
import type { EffectRow, PlanRow } from "./store.ts"
import { RunnerStore } from "./store.ts"
import { canonicalProjectWorktreePath } from "./workspace-location.ts"

test("completed retained verification cleanup probes on fallback and after runtime restart", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-retained-cleanup-probe-project-")))
  const dataDirectory = realpathSync(
    mkdtempSync(join(tmpdir(), "lazers-retained-cleanup-probe-data-")),
  )
  const databasePath = join(dataDirectory, "tasks.sqlite")
  const tracePath = join(dataDirectory, "git-trace.log")
  const priorGitTrace = process.env.GIT_TRACE
  const removedWorkspace = canonicalProjectWorktreePath(root, "already-removed")
  let repository: TaskRepository | undefined
  let runtime: TaskRuntime | undefined
  let clock = Date.now()
  let inventoryReads = 0

  const gitCalls = () =>
    existsSync(tracePath)
      ? readFileSync(tracePath, "utf8").split(/\r?\n/).filter(Boolean).length
      : 0
  const reconcile = (candidate: TaskRuntime) =>
    (
      candidate as unknown as {
        retainedVerificationExecution: {
          reconcileTerminalRetainedVerifications(fence: number): Promise<void>
        }
      }
    ).retainedVerificationExecution.reconcileTerminalRetainedVerifications(1)

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
      taskWorkspace: removedWorkspace,
      taskWorkspaceState: "removed",
      environmentIdentity: "{}",
      reason: "Completed cleanup fixture",
      state: "accepted",
      failureReason: null,
      cleanupState: "complete",
      createdAt: clock,
      updatedAt: clock,
    }
    repository.atomic((db) => createRetainedVerification(db, root, operation))
    const host = {
      worktrees: async () => {
        inventoryReads++
        return []
      },
    } as unknown as RunnerHost
    runtime = new TaskRuntime(withFallowConfig(store), host, "project", undefined, {
      now: () => clock,
      requestTick: () => Promise.resolve(),
    })
    process.env.GIT_TRACE = tracePath

    await reconcile(runtime)
    expect(inventoryReads).toBe(1)
    const firstGitCalls = gitCalls()
    expect(firstGitCalls).toBeGreaterThan(0)

    await reconcile(runtime)
    expect(inventoryReads).toBe(1)
    expect(gitCalls()).toBe(firstGitCalls)
    clock += 59_999
    await reconcile(runtime)
    expect(inventoryReads).toBe(1)
    expect(gitCalls()).toBe(firstGitCalls)

    clock += 1
    await reconcile(runtime)
    expect(inventoryReads).toBe(2)
    expect(gitCalls()).toBeGreaterThan(firstGitCalls)

    await runtime.stop()
    runtime = undefined
    repository.close()
    repository = new TaskRepository(databasePath, root)
    const reopened = new RunnerStore(repository)
    runtime = new TaskRuntime(withFallowConfig(reopened), host, "project", undefined, {
      now: () => clock,
      requestTick: () => Promise.resolve(),
    })
    const beforeRestartProbe = gitCalls()
    await reconcile(runtime)
    expect(inventoryReads).toBe(3)
    expect(gitCalls()).toBeGreaterThan(beforeRestartProbe)
  } finally {
    await runtime?.stop()
    repository?.close()
    if (priorGitTrace === undefined) delete process.env.GIT_TRACE
    else process.env.GIT_TRACE = priorGitTrace
    rmSync(`${root}.worktrees`, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test("cleanup discovery exceeds the display window while unchanged holds skip expensive probes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-cleanup-scale-project-")))
  const worktreeParent = `${root}.worktrees`
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), "lazers-cleanup-scale-data-")))
  const databasePath = join(dataDirectory, "tasks.sqlite")
  const tracePath = join(dataDirectory, "git-trace.log")
  const priorGitTrace = process.env.GIT_TRACE
  let repository: TaskRepository | undefined
  let runtime: TaskRuntime | undefined
  let inventoryReads = 0
  let messageSessionReads = 0
  let removeCalls = 0
  const sessions = new Map<string, HostSession>()
  const records: Array<{
    taskID: string
    planID: string
    attemptID: string
    sessionID: string
    workspaces: string[]
    sourceIDs: string[]
  }> = []
  let clock = Date.now()

  const gitCalls = () =>
    existsSync(tracePath)
      ? readFileSync(tracePath, "utf8").split(/\r?\n/).filter(Boolean).length
      : 0

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
    const allWorkspaces = Array.from({ length: 50 }, (_, index) =>
      canonicalProjectWorktreePath(root, `cleanup-scale-${index}`),
    )
    for (const workspace of allWorkspaces)
      git(root, ["worktree", "add", "--detach", workspace, base])
    git(root, ["worktree", "remove", allWorkspaces[38]!])

    repository = new TaskRepository(databasePath, root)
    let store = new RunnerStore(repository)
    for (let index = 0; index < 38; index++) {
      const proposal = validProposal()
      proposal.objective = `Hold cleanup inventory plan ${index}`
      proposal.writeScope = ["seed.txt"]
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
          sessionID: "ses-cleanup-scale-owner",
          startingRevision: { kind: "git", commit: base },
        },
        proposal,
      })
      const submitted = store.submit(
        {
          requestID: `cleanup-scale-plan-${index}`,
          objective: proposal.objective,
          baseCommit: base,
          workspaceMode: "isolated",
          nodes: [{ taskID: task.id, revision: 1 }],
          dependencies: [],
          integrationOrder: [task.id],
          verification: proposal.verification,
          acceptance: proposal.acceptance,
        },
        "ses-cleanup-scale-owner",
      )
      const planID = submitted.planID
      const attemptID = crypto.randomUUID()
      const sessionID = `ses-cleanup-scale-${index}`
      const workspaces = [allWorkspaces[index]!]
      if (index === 0) workspaces.push(allWorkspaces[38]!)
      else if (index >= 26 && index < 37) workspaces.push(allWorkspaces[39 + index - 26]!)
      const sourceIDs: string[] = []
      repository.atomic((db) => {
        db.query("UPDATE runner_plans SET state='cleanup-blocked',artifact=? WHERE id=?").run(
          base,
          planID,
        )
        db.query(
          "UPDATE runner_nodes SET state='accepted',version=version+1,artifact=? WHERE plan_id=? AND task_id=?",
        ).run(base, planID, task.id)
        db.query(
          `INSERT INTO runner_attempts
           (id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count,tool_count,retry_count,cost)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,'accepted',?,0,0,0,NULL)`,
        ).run(
          attemptID,
          planID,
          root,
          task.id,
          1,
          sessionID,
          `msg-cleanup-scale-${index}`,
          workspaces[0]!,
          base,
          base,
          JSON.stringify({}),
          clock,
        )
        for (const [phase, workspace] of workspaces.entries()) {
          const sourceID = crypto.randomUUID()
          const removalID = crypto.randomUUID()
          const sourceKind = phase === 0 ? "worktree" : "graph-worktree"
          sourceIDs.push(sourceID)
          db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'completed',?,?,1)").run(
            sourceID,
            planID,
            task.id,
            phase === 0 ? attemptID : null,
            sourceKind,
            JSON.stringify({ workspace, base }),
            JSON.stringify({ workspace, base }),
          )
          db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'uncertain',?,?,1)").run(
            removalID,
            planID,
            task.id,
            phase === 0 ? attemptID : null,
            "worktree-remove",
            JSON.stringify({ workspace }),
            JSON.stringify({ error: "Prior unknown native activity", retryCheckedAt: clock }),
          )
        }
        db.query("DELETE FROM runner_outbox WHERE plan_id=?").run(planID)
      })
      records.push({ taskID: task.id, planID, attemptID, sessionID, workspaces, sourceIDs })
    }

    repository.atomic((db) => {
      const insert = db.query(
        "INSERT INTO runner_plans VALUES(?,?,?,1,1,'accepted',?,NULL,NULL,NULL)",
      )
      for (let index = 0; index < 1_001; index++)
        insert.run(crypto.randomUUID(), root, "owner", JSON.stringify({ priority: 1 }))
    })
    expect(store.plans().length).toBeGreaterThan(1_000)
    expect(store.plans().map((plan) => plan.id)).toContain(records[0]!.planID)

    const architectSession = (id: string, directory: string, metadata?: Record<string, unknown>) =>
      ({
        id,
        projectID: "project",
        directory,
        agent: "architect",
        ...(metadata ? { metadata } : {}),
        archived: false,
        busy: false,
        pendingInput: false,
        pendingPermissions: 0,
        pendingForms: 0,
        tokens: 0,
        tools: 0,
        cost: null,
        messages: [],
      }) satisfies HostSession
    for (const record of records) {
      const attempt = store.attempts(record.planID)[0]!
      sessions.set(record.sessionID, {
        id: record.sessionID,
        projectID: "project",
        directory: attempt.workspace,
        agent: "lazers-implementor",
        metadata: { lazersAttemptID: record.attemptID },
        archived: false,
        // A live blocker: any probe that does run is held again, never removed.
        busy: true,
        pendingInput: false,
        pendingPermissions: 0,
        pendingForms: 0,
        turn: { inputID: attempt.message_id, state: "completed" },
        outcome: "succeeded",
        tokens: 0,
        tools: 0,
        cost: null,
        messages: [],
      })
    }
    sessions.set("ses-cleanup-scale-owner", architectSession("ses-cleanup-scale-owner", root))
    const host = {
      worktrees: async () => {
        inventoryReads++
        return []
      },
      session: async (_id: string, options?: { messages?: boolean }) => {
        if (options?.messages) messageSessionReads++
        return sessions.get(_id) ?? null
      },
      createArchitect: async (input: { id: string; directory: string; planID: string }) => {
        sessions.set(
          input.id,
          architectSession(input.id, input.directory, {
            lazersContinuation: true,
            lazersPlanID: input.planID,
          }),
        )
      },
      outcomeInbox: async () => [],
      notify: async () => {},
      removeWorktree: async () => {
        removeCalls++
        throw new Error("Unexpected worktree removal during probe-count test")
      },
    } as unknown as RunnerHost
    runtime = new TaskRuntime(withFallowConfig(store), host, "project", undefined, {
      now: () => clock,
      requestTick: () => Promise.resolve(),
    })
    const internals = runtime as unknown as {
      worktreeCleanup: {
        worktreeCleanupRetryFacts(plan: PlanRow, source: EffectRow, workspace: string): string
      }
    }
    for (const record of records) {
      const plan = store.plan(record.planID)!
      for (const workspace of record.workspaces) {
        const source = store.effects(record.planID).find((effect) => {
          if (!record.sourceIDs.includes(effect.id)) return false
          try {
            return JSON.parse(effect.receipt ?? "{}").workspace === workspace
          } catch {
            return false
          }
        })!
        const removal = store
          .effects(record.planID)
          .find(
            (effect) =>
              effect.kind === "worktree-remove" &&
              JSON.parse(effect.payload).workspace === workspace,
          )!
        const retryFacts = internals.worktreeCleanup.worktreeCleanupRetryFacts(
          plan,
          source,
          workspace,
        )
        repository.atomic((db) =>
          db.query("UPDATE runner_effects SET receipt=? WHERE id=?").run(
            JSON.stringify({
              error: "Prior unknown native activity",
              retryFacts,
              retryCheckedAt: clock,
            }),
            removal.id,
          ),
        )
      }
    }

    const first = records[0]!
    const completedWorkspace = first.workspaces[1]!
    const completedRemoval = store
      .effects(first.planID)
      .find(
        (effect) =>
          effect.kind === "worktree-remove" &&
          JSON.parse(effect.payload).workspace === completedWorkspace,
      )!
    const completedReceipt = JSON.stringify({
      workspace: completedWorkspace,
      removed: true,
      native: true,
      cacheRetirement: "not-loaded",
    })
    repository.atomic((db) =>
      db
        .query("UPDATE runner_effects SET state='completed',receipt=? WHERE id=?")
        .run(completedReceipt, completedRemoval.id),
    )

    process.env.GIT_TRACE = tracePath
    for (let tick = 0; tick < 6; tick++) {
      if (tick > 0) clock += 10_000
      await runtime.tick()
    }
    expect(records).toHaveLength(38)
    expect(records.flatMap((record) => record.workspaces)).toHaveLength(50)
    expect(inventoryReads).toBe(0)
    expect(messageSessionReads).toBe(0)
    expect(gitCalls()).toBe(0)

    await runtime.stop()
    repository.close()
    repository = new TaskRepository(databasePath, root)
    repository.atomic((db) => {
      db.query("UPDATE runner_leases SET expires_at=0 WHERE project_directory=?").run(root)
    })
    store = new RunnerStore(repository)
    runtime = new TaskRuntime(withFallowConfig(store), host, "project", undefined, {
      now: () => clock,
      requestTick: () => Promise.resolve(),
    })
    await runtime.tick()
    expect(inventoryReads).toBe(0)
    expect(messageSessionReads).toBe(0)
    expect(gitCalls()).toBe(0)
    expect(
      store.effects(first.planID).find((effect) => effect.id === completedRemoval.id)?.receipt,
    ).toBe(completedReceipt)

    // Live host facts alone never schedule a probe between fallback intervals.
    await runtime.tick()
    expect(inventoryReads).toBe(0)
    expect(gitCalls()).toBe(0)
    expect(
      store.effects(first.planID).find((effect) => effect.id === completedRemoval.id)?.receipt,
    ).toBe(completedReceipt)

    const inventoryBeforeSourceChange = inventoryReads
    repository.atomic((db) =>
      db
        .query("UPDATE runner_effects SET receipt=? WHERE id=?")
        .run(
          JSON.stringify({ workspace: first.workspaces[0]!, changedSourceFact: true }),
          first.sourceIDs[0]!,
        ),
    )
    await runtime.tick()
    expect(inventoryReads).toBeGreaterThan(inventoryBeforeSourceChange)

    const inventoryBeforeOwnershipChange = inventoryReads
    const second = records[1]!
    repository.atomic((db) => {
      db.query(
        `INSERT INTO runner_attempts
         (id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count,tool_count,retry_count,cost)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,'accepted',?,0,0,0,NULL)`,
      ).run(
        crypto.randomUUID(),
        second.planID,
        root,
        second.taskID,
        2,
        "ses-cleanup-scale-shared-owner",
        "msg-cleanup-scale-shared-owner",
        first.workspaces[0]!,
        base,
        base,
        JSON.stringify({}),
        clock,
      )
    })
    await runtime.tick()
    expect(inventoryReads).toBeGreaterThan(inventoryBeforeOwnershipChange)

    const absentWorkspace = second.workspaces[0]!
    rmSync(absentWorkspace, { recursive: true })
    await runtime.tick()
    expect(store.plan(second.planID)?.state).toBe("cleanup-blocked")
    expect(existsSync(absentWorkspace)).toBe(false)
    expect(removeCalls).toBe(0)
    expect(inventoryReads).toBeGreaterThan(inventoryBeforeOwnershipChange)
  } finally {
    await runtime?.stop()
    repository?.close()
    if (priorGitTrace === undefined) delete process.env.GIT_TRACE
    else process.env.GIT_TRACE = priorGitTrace
    rmSync(worktreeParent, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test("bounded native fallback detects an external dirty edit without deleting the checkout", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-cleanup-fallback-project-")))
  const worktreeParent = `${root}.worktrees`
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), "lazers-cleanup-fallback-data-")))
  const databasePath = join(dataDirectory, "tasks.sqlite")
  const tracePath = join(dataDirectory, "git-trace.log")
  const priorGitTrace = process.env.GIT_TRACE
  const workspace = canonicalProjectWorktreePath(root, "fallback-checkout")
  let repository: TaskRepository | undefined
  let runtime: TaskRuntime | undefined
  let clock = Date.now()
  let inventoryReads = 0
  let detailedSessionReads = 0
  let removeCalls = 0
  let workspacePresent = true

  const gitCalls = () =>
    existsSync(tracePath)
      ? readFileSync(tracePath, "utf8").split(/\r?\n/).filter(Boolean).length
      : 0

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
    git(root, ["worktree", "add", "--detach", workspace, base])

    repository = new TaskRepository(databasePath, root)
    let store = new RunnerStore(repository)
    const proposal = validProposal()
    proposal.objective = "Keep fallback probing bounded while protecting dirty workspaces"
    proposal.writeScope = ["result.txt"]
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
        sessionID: "ses-cleanup-fallback-owner",
        startingRevision: { kind: "git", commit: base },
      },
      proposal,
    })
    const planID = store.submit(
      {
        requestID: "cleanup-fallback-plan",
        objective: proposal.objective,
        baseCommit: base,
        workspaceMode: "isolated",
        nodes: [{ taskID: task.id, revision: 1 }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: proposal.verification,
        acceptance: proposal.acceptance,
      },
      "ses-cleanup-fallback-owner",
    ).planID
    const attemptID = crypto.randomUUID()
    const sessionID = "ses-cleanup-fallback-worker"
    const assignedMessageID = "msg-cleanup-fallback-input"
    const sourceID = crypto.randomUUID()
    const removalID = crypto.randomUUID()
    repository.atomic((db) => {
      db.query("UPDATE runner_plans SET state='cleanup-blocked',artifact=? WHERE id=?").run(
        base,
        planID,
      )
      db.query(
        "UPDATE runner_nodes SET state='accepted',version=version+1,artifact=? WHERE plan_id=? AND task_id=?",
      ).run(base, planID, task.id)
      db.query(
        `INSERT INTO runner_attempts
         (id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count,tool_count,retry_count,cost)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,'accepted',?,0,0,0,NULL)`,
      ).run(
        attemptID,
        planID,
        root,
        task.id,
        1,
        sessionID,
        assignedMessageID,
        workspace,
        base,
        base,
        JSON.stringify({}),
        clock,
      )
      db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'completed',?,?,1)").run(
        sourceID,
        planID,
        task.id,
        attemptID,
        "worktree",
        JSON.stringify({ workspace, base }),
        JSON.stringify({ workspace, base }),
      )
      db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'uncertain',?,?,1)").run(
        removalID,
        planID,
        task.id,
        attemptID,
        "worktree-remove",
        JSON.stringify({ workspace }),
        JSON.stringify({ error: "Native worker activity was previously unknown" }),
      )
      db.query("DELETE FROM runner_outbox WHERE plan_id=?").run(planID)
    })

    const workerSession: HostSession = {
      id: sessionID,
      parentID: "ses-cleanup-fallback-owner",
      projectID: "project",
      directory: workspace,
      agent: "lazers-implementor",
      metadata: { lazersAttemptID: attemptID },
      archived: false,
      busy: false,
      pendingInput: false,
      pendingPermissions: 0,
      pendingForms: 0,
      turn: { inputID: assignedMessageID, state: "completed" },

      outcome: "succeeded",
      tokens: 0,
      tools: 0,
      cost: null,
      messages: [],
    }
    const ownerSession: HostSession = {
      id: "ses-cleanup-fallback-owner",
      projectID: "project",
      directory: root,
      agent: "architect",
      archived: false,
      busy: false,
      pendingInput: false,
      pendingPermissions: 0,
      pendingForms: 0,
      tokens: 0,
      tools: 0,
      cost: null,
      messages: [],
    }
    const host = {
      worktrees: async () => {
        inventoryReads++
        return workspacePresent ? [workspace] : []
      },
      session: async (id: string, options?: { messages?: boolean }) => {
        if (options?.messages) detailedSessionReads++
        return id === sessionID ? workerSession : id === ownerSession.id ? ownerSession : null
      },
      outcomeInbox: async () => [],
      notify: async () => {},
      removeWorktree: async () => {
        removeCalls++
        git(root, ["worktree", "remove", workspace])
        workspacePresent = false
      },
    } as unknown as RunnerHost
    runtime = new TaskRuntime(withFallowConfig(store), host, "project", undefined, {
      now: () => clock,
      requestTick: () => Promise.resolve(),
    })
    const internals = runtime as unknown as {
      worktreeCleanup: {
        worktreeCleanupRetryFacts(plan: PlanRow, source: EffectRow, directory: string): string
      }
    }
    const source = store.effects(planID).find((effect) => effect.id === sourceID)!
    const retryFacts = internals.worktreeCleanup.worktreeCleanupRetryFacts(
      store.plan(planID)!,
      source,
      workspace,
    )
    repository.atomic((db) =>
      db.query("UPDATE runner_effects SET receipt=? WHERE id=?").run(
        JSON.stringify({
          error: "Native worker activity was previously unknown",
          retryFacts,
          retryCheckedAt: clock,
        }),
        removalID,
      ),
    )

    process.env.GIT_TRACE = tracePath
    writeFileSync(join(workspace, "untracked.txt"), "external edit without a native event\n")
    await runtime.tick()
    expect(inventoryReads).toBe(0)
    expect(detailedSessionReads).toBe(0)
    expect(gitCalls()).toBe(0)
    expect(existsSync(workspace)).toBe(true)

    clock += 59_999
    await runtime.tick()
    expect(inventoryReads).toBe(0)
    expect(detailedSessionReads).toBe(0)
    expect(gitCalls()).toBe(0)

    clock += 1
    await runtime.tick()
    expect(inventoryReads).toBeGreaterThan(0)
    expect(gitCalls()).toBeGreaterThan(0)
    expect(store.plan(planID)).toMatchObject({ state: "cleanup-blocked" })
    expect(store.plan(planID)?.reason).toContain("worktree is dirty")
    expect(existsSync(workspace)).toBe(true)
    expect(removeCalls).toBe(0)

    // F-S4-3: fallback probes must not turn an unchanged hold into new decisions.
    const counts = () => ({
      version: store.plan(planID)!.version,
      transitions: repository!.atomic(
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT count(*) count FROM runner_transitions WHERE plan_id=?",
            )
            .get(planID)!.count,
      ),
      notices: repository!.atomic(
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT count(*) count FROM runner_outbox WHERE plan_id=?",
            )
            .get(planID)!.count,
      ),
    })
    const held = counts()
    const reads = inventoryReads
    for (let retry = 0; retry < 3; retry++) {
      clock += 60_000
      await runtime.tick()
      expect(counts()).toEqual(held)
    }
    expect(inventoryReads).toBeGreaterThan(reads)

    await runtime.stop()
    repository.close()
    repository = new TaskRepository(databasePath, root)
    store = new RunnerStore(repository)
    // The replacement runtime acquires the expired lease of the stopped process.
    repository.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    runtime = new TaskRuntime(withFallowConfig(store), host, "project", undefined, {
      now: () => clock,
      requestTick: () => Promise.resolve(),
    })
    clock += 60_000
    await runtime.tick()
    expect(counts()).toEqual(held)

    rmSync(join(workspace, "untracked.txt"))
    workerSession.busy = true
    clock += 60_000
    await runtime.tick()
    expect(store.plan(planID)?.reason).toContain("worker session is busy")
    expect(counts().notices).toBe(held.notices + 1)
    const activeHold = counts()
    clock += 60_000
    await runtime.tick()
    expect(counts()).toEqual(activeHold)
    expect(removeCalls).toBe(0)

    workerSession.busy = false
    clock += 60_000
    await runtime.tick()
    expect(removeCalls).toBe(1)
    expect(existsSync(workspace)).toBe(false)
    expect(store.plan(planID)?.state).toBe("integrated")
  } finally {
    await runtime?.stop()
    repository?.close()
    if (priorGitTrace === undefined) delete process.env.GIT_TRACE
    else process.env.GIT_TRACE = priorGitTrace
    rmSync(worktreeParent, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})
