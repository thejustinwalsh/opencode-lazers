import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionMessage } from "@opencode/schema/session-message"
import { DateTime, Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { NativeInboxClient, NativeInboxDependencies } from "./native.ts"
import { nativeHost } from "./native.ts"
import { NativeIdleStore } from "./native-idle.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import type { RetainedVerification } from "./retained-verification/schema.ts"
import { createRetainedVerification } from "./retained-verification/store.ts"
import type { EffectRow, PlanRow } from "./store.ts"
import { RunnerStore } from "./store.ts"
import { canonicalProjectWorktreePath } from "./workspace-location.ts"

test("fresh durable native idle revalidation removes a clean merged owned worktree without replay", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-cleanup-convergence-project-")))
  const dataDirectory = realpathSync(
    mkdtempSync(join(tmpdir(), "lazers-cleanup-convergence-data-")),
  )
  const workspace = canonicalProjectWorktreePath(root, "attempt-worktree")
  const databasePath = join(dataDirectory, "tasks.sqlite")
  const verificationMarker = join(dataDirectory, "verification-replayed")
  let repository: TaskRepository | undefined
  let runtime: TaskRuntime | undefined
  const removeCalls: Array<{ directory: string; force: boolean | undefined; projectID?: string }> =
    []
  const nativeLocations = new Set([workspace])
  let loseNextRemovalReply = false
  let promptCalls = 0
  let workerCreationCalls = 0

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
    writeFileSync(join(workspace, "feature.txt"), "accepted\n")
    git(workspace, ["add", "feature.txt"])
    git(workspace, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "accepted worker change",
    ])
    const artifact = git(workspace, ["rev-parse", "HEAD"])
    git(root, ["merge", "--ff-only", artifact])
    expect(git(workspace, ["status", "--porcelain"])).toBe("")

    repository = new TaskRepository(databasePath, root)
    const store = new RunnerStore(repository)
    const proposal = validProposal()
    proposal.objective = "Make the cleanup fixture artifact eligible for ordinary cleanup"
    proposal.writeScope = ["feature.txt"]
    proposal.verification = [
      { id: "combined", command: `printf replay >> '${verificationMarker}'`, timeoutMs: 1000 },
    ]
    proposal.acceptance = [
      {
        id: "combined",
        assertion: "The accepted change is integrated before cleanup",
        evidence: [{ kind: "verification", verificationID: "combined" }],
      },
    ]
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
        sessionID: "ses-owner",
        startingRevision: { kind: "git", commit: base },
      },
      proposal,
    })
    const submitted = store.submit(
      {
        requestID: "cleanup-convergence-plan",
        objective: "Remove a clean merged owned worker tree after fresh native idle validation",
        baseCommit: base,
        workspaceMode: "isolated",
        nodes: [{ taskID: task.id, revision: 1 }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: proposal.verification,
        acceptance: proposal.acceptance,
      },
      "ses-owner",
    )
    const planID = submitted.planID
    const attemptID = crypto.randomUUID()
    const sessionID = "ses-cleanup-worker"
    const assignedMessageID = "msg-cleanup-input"
    const worktreeEffectID = crypto.randomUUID()
    repository.atomic((db) => {
      db.query("UPDATE runner_plans SET state='accepted',artifact=? WHERE id=?").run(
        artifact,
        planID,
      )
      db.query(
        "UPDATE runner_nodes SET state='accepted',version=version+1,artifact=? WHERE plan_id=? AND task_id=?",
      ).run(artifact, planID, task.id)
      db.query(
        `INSERT INTO runner_attempts
         (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count,tool_count,retry_count,cost)
         VALUES(?,?,?,?,?,?,?,?,?,?,'accepted',?,0,0,0,NULL)`,
      ).run(
        attemptID,
        planID,
        task.id,
        1,
        sessionID,
        assignedMessageID,
        workspace,
        base,
        artifact,
        JSON.stringify({}),
        Date.now(),
      )
      db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'completed',?,?,1)").run(
        worktreeEffectID,
        planID,
        task.id,
        attemptID,
        "worktree",
        JSON.stringify({ workspace, base }),
        JSON.stringify({ workspace, base }),
      )
    })
    let idleStore = new NativeIdleStore(repository)
    const binding = idleStore.assignmentForSession(sessionID)!
    const started = idleStore.observeEvent(binding, "session.execution.started", 10)
    expect(started.status).toBe("changed")
    expect(
      idleStore.recordIdle(
        binding,
        {
          observedAt: Date.now(),
          inputID: assignedMessageID,
          executionStartSequence: 10,
          eventSequence: 10,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        started.status === "changed" ? started.revision : -1,
      ),
    ).toBe(true)
    const terminalEventID = "evt_cleanup_success"
    const terminalMessageID = SessionMessage.ID.fromEvent(terminalEventID)
    const pending = idleStore.observeEvent(
      binding,
      "session.execution.succeeded",
      11,
      terminalEventID,
      terminalMessageID,
    )
    expect(pending.status).toBe("terminal-pending")
    expect(
      idleStore.confirmSuccess(
        binding,
        assignedMessageID,
        { sequence: 11, eventID: terminalEventID, messageID: terminalMessageID },
        pending.status === "terminal-pending" ? pending.revision : -1,
      ),
    ).toBe(true)

    repository.close()
    repository = new TaskRepository(databasePath, root)
    let reopenedStore = new RunnerStore(repository)
    const now = DateTime.nowUnsafe()
    const session = {
      id: sessionID,
      parentID: "ses-owner",
      projectID: "project",
      agent: "lazers-implementor",
      metadata: { lazersAttemptID: attemptID },
      location: { directory: workspace },
      time: { created: now, updated: now, idle: now },
      tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
      outcome: "succeeded",
      model: { providerID: "openai", id: "test-model" },
    }
    const ownerSession = {
      id: "ses-owner",
      projectID: "project",
      agent: "architect",
      location: { directory: root },
      time: { created: now, updated: now },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      outcome: "succeeded",
      model: { providerID: "openai", id: "test-model" },
    }
    const sessionByID = (id: string) => (id === sessionID ? session : ownerSession)
    const messages = [
      { id: assignedMessageID, type: "user", time: { created: now }, text: "Implement" },
      {
        id: "msg-cleanup-assistant",
        type: "assistant",
        time: { created: now, completed: now },
        finish: "stop",
        content: [{ type: "text", text: "The merged change is complete." }],
      },
      {
        id: terminalMessageID,
        type: "idle",
        outcome: "succeeded",
        time: { created: now },
      },
    ]
    const worktrees = () =>
      git(root, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
    const client = {
      server: { info: async () => ({ pid: process.pid, version: "2.2.5" }) },
      form: {
        list: async ({ location }: { location: { directory: string } }) => ({ location, data: [] }),
      },
      permission: {
        request: {
          list: async ({ location }: { location: { directory: string } }) => ({
            location,
            data: [],
          }),
        },
      },
      session: {
        active: async () => ({}),
        get: async ({ sessionID: id }: { sessionID: string }) => sessionByID(id),
        synthetic: async () => ({ id: "msg-unused" }),
        inbox: { list: async () => [], cancel: async () => {} },
        update: async () => {},
      },
      message: {
        list: async () => ({ data: [], cursor: { previous: undefined } }),
      },
      shell: {
        list: async ({ location }: { location: { directory: string } }) => ({ location, data: [] }),
      },
      debug: {
        location: {
          list: async () => [...nativeLocations].map((directory) => ({ directory })),
          evict: async ({ location }: { location: { directory: string } }) => {
            nativeLocations.delete(location.directory)
          },
        },
      },
    } as unknown as NativeInboxClient
    const dependencies = {
      discover: async () => ({ url: "https://opencode.localhost", auth: undefined }),
      make: () => client,
      processID: () => process.pid,
    } as NativeInboxDependencies
    const context = {
      app: { version: "2.2.5" },
      location: { directory: root, project: { id: "project" } },
      session: {
        get: ({ sessionID: id }: { sessionID: string }) => Effect.succeed(sessionByID(id) as never),
        context: ({ sessionID: id }: { sessionID: string }) =>
          Effect.succeed((id === sessionID ? messages : []) as never),
      },
      worktree: {
        refresh: () => Effect.void,
        list: () => Effect.succeed(worktrees().map((directory) => ({ directory })) as never),
        remove: (input: { directory: string; force: boolean }) =>
          Effect.sync(() => {
            removeCalls.push(input)
            git(root, ["worktree", "remove", input.directory])
            if (loseNextRemovalReply) {
              loseNextRemovalReply = false
              throw new Error("native removal response lost after removal")
            }
          }),
      },
    } as unknown as Plugin.Context
    const native = nativeHost(context, repository, dependencies)
    let host = {
      ...native,
      prompt: async () => {
        promptCalls++
        throw new Error("Unexpected cleanup prompt")
      },
      create: async () => {
        workerCreationCalls++
        throw new Error("Unexpected worker creation")
      },
    }
    runtime = new TaskRuntime(reopenedStore, host, "project")
    expect(idleStore.invalidate(binding, "fresh native completion has not yet been observed")).toBe(
      true,
    )
    await runtime.command(
      {
        requestID: "integrate-cleanup-convergence-plan",
        planID,
        expectedVersion: reopenedStore.plan(planID)!.version,
        action: "integrated",
        artifact,
        targetBranch: "main",
        reason: "The accepted worker artifact has been merged and can be ordinarily cleaned up.",
      },
      "ses-owner",
    )
    expect(reopenedStore.plan(planID)?.state).toBe("cleaning")
    await runtime.tick()
    expect(reopenedStore.plan(planID)).toMatchObject({ state: "cleanup-blocked" })
    expect(existsSync(workspace)).toBe(true)
    expect(removeCalls).toHaveLength(0)

    await runtime.stop()
    repository.close()
    repository = new TaskRepository(databasePath, root)
    repository.atomic((db) => {
      db.query("UPDATE runner_leases SET expires_at=0 WHERE project_directory=?").run(root)
    })
    reopenedStore = new RunnerStore(repository)
    idleStore = new NativeIdleStore(repository)
    host = {
      ...nativeHost(context, repository, dependencies),
      prompt: async () => {
        promptCalls++
        throw new Error("Unexpected cleanup prompt")
      },
      create: async () => {
        workerCreationCalls++
        throw new Error("Unexpected worker creation")
      },
    }
    runtime = new TaskRuntime(reopenedStore, host, "project")

    const restarted = idleStore.observeEvent(binding, "session.execution.started", 12)
    expect(restarted.status).toBe("changed")
    expect(
      idleStore.recordIdle(
        binding,
        {
          observedAt: Date.now(),
          inputID: assignedMessageID,
          executionStartSequence: 12,
          eventSequence: 12,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        restarted.status === "changed" ? restarted.revision : -1,
      ),
    ).toBe(true)
    const refreshedTerminalEventID = "evt_cleanup_refreshed_success"
    const refreshedTerminalMessageID = SessionMessage.ID.fromEvent(refreshedTerminalEventID)
    const refreshedTerminal = idleStore.observeEvent(
      binding,
      "session.execution.succeeded",
      13,
      refreshedTerminalEventID,
      refreshedTerminalMessageID,
    )
    expect(refreshedTerminal.status).toBe("terminal-pending")
    expect(
      idleStore.confirmSuccess(
        binding,
        assignedMessageID,
        {
          sequence: 13,
          eventID: refreshedTerminalEventID,
          messageID: refreshedTerminalMessageID,
        },
        refreshedTerminal.status === "terminal-pending" ? refreshedTerminal.revision : -1,
      ),
    ).toBe(true)
    messages.push({
      id: refreshedTerminalMessageID,
      type: "idle",
      outcome: "succeeded",
      time: { created: now },
    })
    loseNextRemovalReply = true
    await runtime.tick()
    expect(reopenedStore.plan(planID)).toMatchObject({ state: "cleanup-blocked" })
    expect(existsSync(workspace)).toBe(false)
    expect(removeCalls).toHaveLength(1)
    await runtime.tick()

    expect(reopenedStore.plan(planID)).toMatchObject({ state: "integrated" })
    expect(existsSync(workspace)).toBe(false)
    expect(worktrees()).not.toContain(workspace)
    expect(removeCalls).toEqual([{ projectID: "project", directory: workspace, force: false }])
    expect(nativeLocations.has(workspace)).toBe(false)
    expect(promptCalls).toBe(0)
    expect(workerCreationCalls).toBe(0)
    expect(existsSync(verificationMarker)).toBe(false)
  } finally {
    await runtime?.stop()
    repository?.close()
    rmSync(`${root}.worktrees`, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

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
        reconcileTerminalRetainedVerifications(fence: number): Promise<void>
      }
    ).reconcileTerminalRetainedVerifications(1)

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
      generation: 1,
      projectID: "project",
      projectDirectory: root,
      planID,
      planRevision: 1,
      planVersion: 1,
      owner: "ses-retained-cleanup-probe-owner",
      ownerEpoch: 0,
      taskID: task.id,
      taskRevision: 1,
      attemptID: crypto.randomUUID(),
      originalSessionID: "ses-retained-cleanup-probe-worker",
      originalMessageID: "msg-retained-cleanup-probe-input",
      originalWorkspace: root,
      artifact: "a".repeat(40),
      combinedArtifact: null,
      combinedInputFingerprint: null,
      taskWorkspace: removedWorkspace,
      taskWorkspaceState: "removed",
      combinedWorkspace: null,
      combinedWorkspaceState: null,
      inputFingerprint: "retained-cleanup-probe-input",
      environmentIdentity: "{}",
      reason: "Completed cleanup fixture",
      state: "accepted",
      holdReason: null,
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
    runtime = new TaskRuntime(store, host, "project", undefined, {
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
    runtime = new TaskRuntime(reopened, host, "project", undefined, {
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
    let idleStore = new NativeIdleStore(repository)
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
    expect(store.plans()).toHaveLength(1_000)
    expect(store.plans().map((plan) => plan.id)).not.toContain(records[0]!.planID)

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
        busy: false,
        pendingInput: false,
        pendingPermissions: 0,
        pendingForms: 0,
        turn: { inputID: attempt.message_id, state: "completed" },
        background: {
          state: "unknown",
          source: "experimental.idle",
          reason: "Current native background observation is unavailable",
        },
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
    runtime = new TaskRuntime(store, host, "project", undefined, {
      now: () => clock,
      requestTick: () => Promise.resolve(),
    })
    const internals = runtime as unknown as {
      worktreeCleanupRetryFacts(plan: PlanRow, source: EffectRow, workspace: string): string
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
        const retryFacts = internals.worktreeCleanupRetryFacts(plan, source, workspace)
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
    idleStore = new NativeIdleStore(repository)
    runtime = new TaskRuntime(store, host, "project", undefined, {
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

    const binding = idleStore.assignmentForSession(first.sessionID)!
    expect(idleStore.observeEvent(binding, "session.execution.started", 1).status).toBe("changed")
    await runtime.tick()
    expect(inventoryReads).toBe(1)
    expect(gitCalls()).toBeGreaterThan(0)
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
    const store = new RunnerStore(repository)
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
      background: {
        state: "observed",
        source: "experimental.idle",
        projectDirectory: root,
        projectID: "project",
        attemptID,
        sessionID,
        workspace,
        assignedMessageID,
        observedAt: clock,
        inputID: assignedMessageID,
        executionStartSequence: 1,
        eventSequence: 1,
        count: 0,
        kinds: { shell: 0, subagent: 0, image: 0 },
      },
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
        return [workspace]
      },
      session: async (id: string, options?: { messages?: boolean }) => {
        if (options?.messages) detailedSessionReads++
        return id === sessionID ? workerSession : id === ownerSession.id ? ownerSession : null
      },
      outcomeInbox: async () => [],
      notify: async () => {},
      removeWorktree: async () => {
        removeCalls++
        throw new Error("Dirty worktree removal must never be attempted")
      },
    } as unknown as RunnerHost
    runtime = new TaskRuntime(store, host, "project", undefined, {
      now: () => clock,
      requestTick: () => Promise.resolve(),
    })
    const internals = runtime as unknown as {
      worktreeCleanupRetryFacts(plan: PlanRow, source: EffectRow, directory: string): string
    }
    const source = store.effects(planID).find((effect) => effect.id === sourceID)!
    const retryFacts = internals.worktreeCleanupRetryFacts(store.plan(planID)!, source, workspace)
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
    expect(detailedSessionReads).toBeGreaterThan(0)
    expect(gitCalls()).toBeGreaterThan(0)
    expect(store.plan(planID)).toMatchObject({ state: "cleanup-blocked" })
    expect(store.plan(planID)?.reason).toContain("worktree is dirty")
    expect(existsSync(workspace)).toBe(true)
    expect(removeCalls).toBe(0)
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
