import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import {
  NativeWorktreeCreationFailure,
  nativeWorktreeFailureEvidence,
  nativeWorktreeFailureFromReceipt,
  startupFailureSettlementFromReceipt,
  startupWorktreeCandidates,
} from "./startup-recovery.ts"
import { TaskRuntime } from "./runtime.ts"
import { RunnerStore } from "./store.ts"

const roots: string[] = []
const repositories: TaskRepository[] = []
const runtimes: TaskRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop()
  for (const repository of repositories.splice(0)) repository.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "lazers-startup-recovery-"))
  roots.push(temporary)
  const root = join(temporary, "project")
  mkdirSync(root)
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
  const repository = new TaskRepository(join(temporary, "tasks.sqlite"), root)
  repositories.push(repository)
  const proposal = validProposal()
  proposal.objective = "Implement the startup recovery fixture"
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
      sessionID: "owner",
      startingRevision: { kind: "git", commit: base },
    },
    proposal,
  })
  const store = new RunnerStore(repository)
  const receipt = store.submit(
    {
      requestID: "startup-recovery-plan",
      objective: proposal.objective,
      baseCommit: base,
      workspaceMode: "isolated",
      workerModel: { providerID: "openai", id: "startup-test-model" },
      nodes: [{ taskID: task.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: proposal.verification,
      acceptance: proposal.acceptance,
    },
    "owner",
  )
  const planID = receipt.planID
  const plan = store.plan(planID)!
  const sessions = new Map<string, HostSession>()
  sessions.set("owner", {
    id: "owner",
    projectID: "project",
    directory: root,
    agent: "architect",
    archived: false,
    busy: false,
    tokens: null,
    tools: 0,
    cost: null,
    messages: [],
  })
  const calls = { worktree: 0, create: 0, prompt: 0 }
  const host: RunnerHost = {
    worktree: async ({ directory, base: source }) => {
      calls.worktree++
      git(root, ["worktree", "add", "--detach", directory, source])
      return directory
    },
    worktrees: async () =>
      git(root, ["worktree", "list", "--porcelain"])
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length)),
    removeWorktree: async (directory) => {
      git(root, ["worktree", "remove", directory])
    },
    session: async (id) => structuredClone(sessions.get(id) ?? null),
    create: async (input) => {
      calls.create++
      sessions.set(input.id, {
        id: input.id,
        parentID: input.parentID,
        projectID: "project",
        directory: input.directory,
        agent: input.agent,
        metadata: { lazersAttemptID: input.attemptID },
        archived: false,
        busy: false,
        tokens: null,
        tools: 0,
        cost: null,
        messages: [],
      })
    },
    createArchitect: async () => {
      throw new Error("Unexpected Architect creation")
    },
    prompt: async (input) => {
      calls.prompt++
      const session = sessions.get(input.sessionID)!
      session.messages.push({ id: input.id, text: input.text })
    },
    updateInstruction: async () => {},
    notify: async () => {},
    interrupt: async () => {},
  }
  const runtime = new TaskRuntime(store, host, "project")
  runtimes.push(runtime)
  return {
    temporary,
    root,
    base,
    repository,
    store,
    taskID: task.id,
    planID,
    plan,
    sessions,
    calls,
    host,
    runtime,
  }
}

async function createTerminalFailure(
  f: ReturnType<typeof fixture>,
  message = "Native worktree setup failed",
) {
  f.host.worktree = async () => {
    f.calls.worktree++
    throw new NativeWorktreeCreationFailure({
      schema: "lazers-native-worktree-failure/v2",
      api: "worktree.create",
      nativeTag: "Worktree.OperationError",
      message,
    })
  }
  await f.runtime.command(
    { requestID: "startup-run", planID: f.planID, expectedVersion: f.plan.version, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  const attempt = f.store.attempts(f.planID)[0]!
  const effect = f.store.effects(f.planID).find((candidate) => candidate.kind === "worktree")!
  expect(f.store.plan(f.planID)!.state).toBe("blocked")
  expect(effect.state).toBe("uncertain")
  expect(JSON.parse(effect.receipt!).nativeFailure).toMatchObject({
    nativeTag: "Worktree.OperationError",
    message,
  })
  return { attempt, effect }
}

function settlementCommand(
  f: ReturnType<typeof fixture>,
  attemptID: string,
  requestID = "settle-startup",
) {
  return {
    requestID,
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "settle-startup" as const,
    taskID: f.taskID,
    attemptID,
    reason: "The terminal native error and fresh absence were reviewed.",
  }
}

function assertSettlementWasNonMutating(
  f: ReturnType<typeof fixture>,
  effectID: string,
  version: number,
) {
  expect(f.store.plan(f.planID)).toMatchObject({ state: "blocked", version })
  expect(f.store.effects(f.planID).find((effect) => effect.id === effectID)?.state).toBe(
    "uncertain",
  )
  expect(f.calls).toEqual({ worktree: 1, create: 0, prompt: 0 })
}

test("typed native failure settles only after fresh absence and resumes the same reservation after reopen", async () => {
  const f = fixture()
  const { attempt, effect } = await createTerminalFailure(f)
  const originalAttempt = structuredClone(attempt)
  const planBeforeSettlement = structuredClone(f.store.plan(f.planID)!)
  const settlementInput = settlementCommand(f, attempt.id)
  const result = await f.runtime.command(settlementInput, "owner")
  expect(result).toMatchObject({
    status: "startup-failure-settled-absent",
    planID: f.planID,
    taskID: f.taskID,
    attemptID: attempt.id,
    effectID: effect.id,
  })
  expect(f.store.effects(f.planID).find((candidate) => candidate.id === effect.id)?.state).toBe(
    "failed",
  )
  expect(f.store.attempts(f.planID)[0]).toEqual(originalAttempt)
  expect(f.store.plan(f.planID)).toMatchObject({
    owner: planBeforeSettlement.owner,
    revision: planBeforeSettlement.revision,
    body: planBeforeSettlement.body,
    model: planBeforeSettlement.model,
    state: "blocked",
    version: planBeforeSettlement.version + 1,
  })
  expect(f.calls).toEqual({ worktree: 1, create: 0, prompt: 0 })
  expect(
    f.store
      .effects(f.planID)
      .some((item) => item.kind.startsWith("verify:") || item.kind.startsWith("graph-verify:")),
  ).toBe(false)
  const receipt = f.store
    .effects(f.planID)
    .find((candidate) => candidate.id === effect.id)!.receipt!
  expect(JSON.parse(receipt).history[0]).toMatchObject({
    error: "Worktree.OperationError: Native worktree setup failed",
    nativeFailure: {
      nativeTag: "Worktree.OperationError",
      message: "Native worktree setup failed",
    },
  })
  const settled = startupFailureSettlementFromReceipt(receipt)!
  expect(settled).toMatchObject({
    requestID: "settle-startup",
    planID: f.planID,
    taskID: f.taskID,
    attemptID: attempt.id,
    effectID: effect.id,
    sessionID: attempt.session_id,
    workspace: attempt.workspace,
    base: f.base,
    observations: {
      candidates: startupWorktreeCandidates(attempt.workspace),
      nativeAbsent: true,
      gitAbsent: true,
      filesystemAbsent: true,
      sessionAbsent: true,
    },
  })

  const databasePath = f.repository.path
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  f.repository.close()
  const repository = new TaskRepository(databasePath, f.root)
  repositories.push(repository)
  f.repository = repository
  f.store = new RunnerStore(repository)
  const reopenedAfterSettlement = new TaskRuntime(f.store, f.host, "project")
  runtimes.push(reopenedAfterSettlement)
  f.runtime = reopenedAfterSettlement
  const durableEffect = f.store.effects(f.planID).find((candidate) => candidate.id === effect.id)!
  expect(nativeWorktreeFailureFromReceipt(durableEffect.receipt)).toMatchObject({
    schema: "lazers-native-worktree-failure/v2",
    nativeTag: "Worktree.OperationError",
    message: "Native worktree setup failed",
  })
  expect(startupFailureSettlementFromReceipt(durableEffect.receipt)).toEqual(settled)
  await f.runtime.tick()
  expect(f.calls).toEqual({ worktree: 1, create: 0, prompt: 0 })
  const recoveryCommand = {
    requestID: "explicit-startup-resume",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "resume" as const,
    taskID: f.taskID,
    attemptID: attempt.id,
    reason: "Explicitly continue after confirmed startup failure.",
  }
  const authorization = await f.runtime.command(recoveryCommand, "owner")
  expect(authorization).toMatchObject({
    status: "startup-recovery-authorized",
    attemptID: attempt.id,
  })
  expect(await f.runtime.command(recoveryCommand, "owner")).toEqual(authorization)
  await expect(
    f.runtime.command(
      {
        ...recoveryCommand,
        requestID: "duplicate-authority",
        expectedVersion: recoveryCommand.expectedVersion,
      },
      "owner",
    ),
  ).rejects.toThrow("Stale plan version")
  expect(f.calls).toEqual({ worktree: 1, create: 0, prompt: 0 })

  f.host.worktree = async ({ directory, base }) => {
    f.calls.worktree++
    git(f.root, ["worktree", "add", "--detach", directory, base])
    return directory
  }
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  runtimes.push(reopened)
  await reopened.tick()
  expect(f.calls).toEqual({ worktree: 2, create: 1, prompt: 1 })
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
    message_id: attempt.message_id,
    workspace: attempt.workspace,
    base_commit: attempt.base_commit,
    policy: attempt.policy,
    state: "running",
  })
  const recovery = f.store
    .effects(f.planID)
    .find((candidate) => candidate.kind === "worktree-recovery")!
  expect(recovery.state).toBe("completed")
  expect(JSON.parse(recovery.payload)).toMatchObject({
    sourceEffectID: effect.id,
    settlementRequestID: "settle-startup",
    sessionID: attempt.session_id,
    messageID: attempt.message_id,
    workspace: attempt.workspace,
    base: attempt.base_commit,
    policy: attempt.policy,
  })
  expect(f.store.effects(f.planID).find((candidate) => candidate.id === effect.id)?.state).toBe(
    "failed",
  )
  expect(
    f.store.activity(f.planID, f.taskID).filter((entry) => entry.event === "WORKER_STARTED"),
  ).toHaveLength(1)
})

test("unknown, timed-out and ENOSPC failures cannot be settled as terminal absence", async () => {
  for (const message of ["response timed out", "ENOSPC: no space left on device"]) {
    const f = fixture()
    f.host.worktree = async () => {
      f.calls.worktree++
      throw new Error(message)
    }
    await f.runtime.command(
      {
        requestID: "startup-run",
        planID: f.planID,
        expectedVersion: f.plan.version,
        action: "run",
      },
      "owner",
    )
    await f.runtime.tick()
    const attempt = f.store.attempts(f.planID)[0]!
    const effect = f.store.effects(f.planID).find((candidate) => candidate.kind === "worktree")!
    const version = f.store.plan(f.planID)!.version
    expect(effect.state).toBe("uncertain")
    expect(nativeWorktreeFailureEvidence(JSON.parse(effect.receipt!))).toBeUndefined()
    expect(nativeWorktreeFailureEvidence(new Error(message))).toBeUndefined()
    await expect(f.runtime.command(settlementCommand(f, attempt.id), "owner")).rejects.toThrow(
      "bound terminal native failure evidence",
    )
    assertSettlementWasNonMutating(f, effect.id, version)
  }
})

test("worker admission waits for an untouched reserved base after native creation", async () => {
  const f = fixture()
  const create = f.host.worktree
  f.host.worktree = async ({ directory, base }) => {
    const actual = await create({ directory, base })
    writeFileSync(join(actual, "foreign-startup.txt"), "not admitted\n")
    git(actual, ["add", "foreign-startup.txt"])
    git(actual, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "foreign startup mutation",
    ])
    return actual
  }
  await f.runtime.command(
    { requestID: "invalid-startup-base", planID: f.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  const attempt = f.store.attempts(f.planID)[0]!
  const worktree = f.store.effects(f.planID).find((effect) => effect.kind === "worktree")!
  expect(worktree.state).toBe("uncertain")
  expect(attempt.state).toBe("preparing")
  expect(git(attempt.workspace, ["rev-parse", "HEAD"])).not.toBe(attempt.base_commit)
  expect(f.calls).toEqual({ worktree: 1, create: 0, prompt: 0 })
  expect(f.store.effects(f.planID).some((effect) => effect.kind === "session")).toBe(false)
  expect(f.store.effects(f.planID).some((effect) => effect.kind === "prompt")).toBe(false)
})

test("partial resources, native/Git collisions, inventory failures and reserved sessions refuse settlement", async () => {
  for (const conflict of [
    "filesystem",
    "native-inventory",
    "git-inventory",
    "wrong-head",
    "session",
    "unavailable",
  ] as const) {
    const f = fixture()
    const { attempt, effect } = await createTerminalFailure(f)
    if (conflict === "filesystem") mkdirSync(`${attempt.workspace}-2`, { recursive: true })
    if (conflict === "native-inventory") {
      const list = f.host.worktrees
      f.host.worktrees = async () => [
        ...(await list()),
        `${attempt.workspace}-3`,
        `${attempt.workspace}-4`,
      ]
    }
    if (conflict === "git-inventory") {
      const list = f.host.worktrees
      f.host.worktrees = async () =>
        (await list()).filter((path) => path !== `${attempt.workspace}-5`)
      git(f.root, ["worktree", "add", "--detach", `${attempt.workspace}-5`, f.base])
    }
    if (conflict === "wrong-head") {
      writeFileSync(join(f.root, "foreign.txt"), "foreign baseline\n")
      git(f.root, ["add", "foreign.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "foreign baseline",
      ])
      git(f.root, ["worktree", "add", "--detach", `${attempt.workspace}-6`, "HEAD"])
    }
    if (conflict === "session")
      f.sessions.set(attempt.session_id, {
        id: attempt.session_id,
        projectID: "project",
        directory: attempt.workspace,
        agent: "lazers-implementor",
        archived: false,
        busy: false,
        tokens: null,
        tools: 0,
        cost: null,
        messages: [],
      })
    if (conflict === "unavailable")
      f.host.worktrees = async () => {
        throw new Error("Native inventory unavailable")
      }
    const version = f.store.plan(f.planID)!.version
    await expect(f.runtime.command(settlementCommand(f, attempt.id), "owner")).rejects.toThrow()
    assertSettlementWasNonMutating(f, effect.id, version)
  }
})

test("an ownership change during asynchronous absence observation wins over settlement", async () => {
  const f = fixture()
  const { attempt, effect } = await createTerminalFailure(f)
  let observed!: () => void
  let release!: () => void
  const observationStarted = new Promise<void>((resolve) => (observed = resolve))
  const pendingObservation = new Promise<void>((resolve) => (release = resolve))
  const worktrees = f.host.worktrees
  f.host.worktrees = async () => {
    observed()
    await pendingObservation
    return worktrees()
  }
  const pendingSettlement = f.runtime.command(settlementCommand(f, attempt.id), "owner")
  await observationStarted
  const cancellation = await f.runtime.command(
    {
      requestID: "cancel-during-settlement",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  expect(cancellation).toMatchObject({ status: "cancelling" })
  release()
  await expect(pendingSettlement).rejects.toThrow("identity, version, or ownership changed")
  expect(f.store.plan(f.planID)!.state).toBe("cancelling")
  expect(f.store.effects(f.planID).find((candidate) => candidate.id === effect.id)?.state).toBe(
    "uncertain",
  )
  expect(
    f.store
      .activity(f.planID, f.taskID)
      .some((entry) => entry.event === "WORKTREE_STARTUP_FAILURE_SETTLED_ABSENT"),
  ).toBe(false)
  expect(f.calls).toEqual({ worktree: 1, create: 0, prompt: 0 })
})

test("reassignment during absence observation removes authority from the old owner", async () => {
  const f = fixture()
  const { attempt, effect } = await createTerminalFailure(f)
  f.sessions.set("new-owner", {
    id: "new-owner",
    projectID: "project",
    directory: f.root,
    agent: "architect",
    archived: false,
    busy: false,
    tokens: null,
    tools: 0,
    cost: null,
    messages: [],
  })
  let observed!: () => void
  let release!: () => void
  const observationStarted = new Promise<void>((resolve) => (observed = resolve))
  const pendingObservation = new Promise<void>((resolve) => (release = resolve))
  const worktrees = f.host.worktrees
  f.host.worktrees = async () => {
    observed()
    await pendingObservation
    return worktrees()
  }
  const pendingSettlement = f.runtime.command(settlementCommand(f, attempt.id), "owner")
  await observationStarted
  await f.runtime.command(
    {
      requestID: "reassign-during-settlement",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "reassign",
      targetSessionID: "new-owner",
      reason: "Transfer review authority.",
    },
    "owner",
  )
  release()
  await expect(pendingSettlement).rejects.toThrow("identity, version, or ownership changed")
  expect(f.store.plan(f.planID)).toMatchObject({ state: "blocked", owner: "new-owner" })
  expect(f.store.effects(f.planID).find((candidate) => candidate.id === effect.id)?.state).toBe(
    "uncertain",
  )
  await expect(
    f.runtime.command(settlementCommand(f, attempt.id, "old-owner-settlement"), "owner"),
  ).rejects.toThrow("Only the plan owner")
  expect(f.calls).toEqual({ worktree: 1, create: 0, prompt: 0 })
})

test("an uncertain linked recovery operation stays unresolved and is never replayed", async () => {
  const f = fixture()
  const { attempt } = await createTerminalFailure(f)
  await f.runtime.command(settlementCommand(f, attempt.id), "owner")
  await f.runtime.command(
    {
      requestID: "authorize-uncertain-recovery",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "resume",
      taskID: f.taskID,
      attemptID: attempt.id,
      reason: "Explicitly authorize startup recovery.",
    },
    "owner",
  )
  f.host.worktree = async () => {
    f.calls.worktree++
    throw new Error("recovery response timed out")
  }
  await f.runtime.tick()
  const recovery = f.store.effects(f.planID).find((effect) => effect.kind === "worktree-recovery")!
  expect(recovery.state).toBe("uncertain")
  expect(f.store.plan(f.planID)!.state).toBe("blocked")
  const count = f.calls.worktree
  await f.runtime.tick()
  await expect(
    f.runtime.command(
      {
        requestID: "unsafe-replay-recovery",
        planID: f.planID,
        expectedVersion: f.store.plan(f.planID)!.version,
        action: "resume",
        taskID: f.taskID,
        attemptID: attempt.id,
        reason: "Do not replay the unresolved operation.",
      },
      "owner",
    ),
  ).rejects.toThrow("Reconcile uncertain effects first")
  expect(f.calls.worktree).toBe(count)
  expect(f.calls.create).toBe(0)
  expect(f.calls.prompt).toBe(0)
})

test("a late recovery completion after cancellation cannot admit the reserved worker", async () => {
  const f = fixture()
  const { attempt } = await createTerminalFailure(f)
  await f.runtime.command(settlementCommand(f, attempt.id), "owner")
  await f.runtime.command(
    {
      requestID: "authorize-late-recovery",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "resume",
      taskID: f.taskID,
      attemptID: attempt.id,
      reason: "Explicitly authorize startup recovery.",
    },
    "owner",
  )

  let created!: () => void
  let release!: () => void
  const createStarted = new Promise<void>((resolve) => (created = resolve))
  const delayedCreate = new Promise<void>((resolve) => (release = resolve))
  f.host.worktree = async ({ directory, base }) => {
    f.calls.worktree++
    created()
    await delayedCreate
    git(f.root, ["worktree", "add", "--detach", directory, base])
    return directory
  }
  const pendingTick = f.runtime.tick()
  await createStarted
  await f.runtime.command(
    {
      requestID: "cancel-late-recovery",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  release()
  await pendingTick
  expect(f.store.plan(f.planID)!.state).toBe("cancelling")
  expect(f.calls).toEqual({ worktree: 2, create: 0, prompt: 0 })
  expect(
    f.store.effects(f.planID).filter((effect) => effect.kind === "worktree-recovery"),
  ).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]!.state).toBe("preparing")
})
