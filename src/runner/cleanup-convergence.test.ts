import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
import { TaskRuntime } from "./runtime.ts"
import { RunnerStore } from "./store.ts"

test("fresh durable native idle revalidation removes a clean merged owned worktree without replay", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-cleanup-convergence-project-")))
  const dataDirectory = realpathSync(
    mkdtempSync(join(tmpdir(), "lazers-cleanup-convergence-data-")),
  )
  const workspace = join(dataDirectory, "attempt-worktree")
  const databasePath = join(dataDirectory, "tasks.sqlite")
  const verificationMarker = join(dataDirectory, "verification-replayed")
  let repository: TaskRepository | undefined
  let runtime: TaskRuntime | undefined
  const removeCalls: Array<{ directory: string; force: boolean | undefined; projectID?: string }> =
    []
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
    const idleStore = new NativeIdleStore(repository)
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
    const reopenedStore = new RunnerStore(repository)
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
          }),
      },
    } as unknown as Plugin.Context
    const native = nativeHost(context, repository, dependencies)
    const host = {
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

    expect(reopenedStore.plan(planID)).toMatchObject({ state: "integrated" })
    expect(existsSync(workspace)).toBe(false)
    expect(worktrees()).not.toContain(workspace)
    expect(removeCalls).toEqual([{ projectID: "project", directory: workspace, force: false }])
    expect(promptCalls).toBe(0)
    expect(workerCreationCalls).toBe(0)
    expect(existsSync(verificationMarker)).toBe(false)
  } finally {
    await runtime?.stop()
    repository?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})
