import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { fingerprint } from "../identity.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import {
  NativeWorktreeCreationFailure,
  nativeWorktreeFailureEvidence,
  nativeWorktreeFailureFromReceipt,
  startupFailureSettlementFromReceipt,
  startupWorktreeFailureEvidence,
  startupWorktreeCandidates,
  UNCERTAIN_EFFECT_RECEIPT_SCHEMA,
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

async function createUnversionedLegacyFailure(f: ReturnType<typeof fixture>) {
  f.host.worktree = async () => {
    f.calls.worktree++
    throw new Error("Worktree.DirectoryUnavailableError")
  }
  await f.runtime.command(
    { requestID: "startup-run", planID: f.planID, expectedVersion: f.plan.version, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  const attempt = f.store.attempts(f.planID)[0]!
  const effect = f.store.effects(f.planID).find((candidate) => candidate.kind === "worktree")!
  const modernReceipt = JSON.parse(effect.receipt!) as Record<string, unknown>
  expect(modernReceipt).toMatchObject({
    schema: UNCERTAIN_EFFECT_RECEIPT_SCHEMA,
    error: "Worktree.DirectoryUnavailableError",
  })
  // Replace the newly versioned receipt with the exact pre-version writer
  // shape in this isolated fixture, as if read from an older database.
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_effects SET receipt=? WHERE id=?")
      .run('{"error":"Worktree.DirectoryUnavailableError"}', effect.id),
  )
  return {
    attempt,
    effect: f.store.effects(f.planID).find((candidate) => candidate.id === effect.id)!,
  }
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

test("legacy error-only receipts settle generically from current runtime identity and resume after reopen", async () => {
  const f = fixture()
  const { attempt, effect } = await createUnversionedLegacyFailure(f)
  const originalAttempt = structuredClone(attempt)
  const originalPlan = structuredClone(f.store.plan(f.planID)!)
  const settledResult = await f.runtime.command(settlementCommand(f, attempt.id), "owner")
  expect(settledResult).toMatchObject({
    status: "startup-failure-settled-absent",
    evidence: {
      legacyFailure: {
        schema: "lazers-worktree-startup-legacy-failure/v1",
        classification: "legacy-error-only-inference",
        rawReceipt: '{"error":"Worktree.DirectoryUnavailableError"}',
        provenance: {
          kind: "legacy-untyped-error-inference",
          nativeErrorIdentity: "unknown",
        },
        binding: {
          planID: f.planID,
          taskID: f.taskID,
          attemptID: attempt.id,
          effectID: effect.id,
          sessionID: attempt.session_id,
          messageID: attempt.message_id,
          workspace: attempt.workspace,
          base: attempt.base_commit,
        },
      },
    },
  })
  expect(f.store.attempts(f.planID)[0]).toEqual(originalAttempt)
  expect(f.store.plan(f.planID)).toMatchObject({
    owner: originalPlan.owner,
    revision: originalPlan.revision,
    body: originalPlan.body,
    model: originalPlan.model,
    state: "blocked",
    version: originalPlan.version + 1,
  })
  expect(f.calls).toEqual({ worktree: 1, create: 0, prompt: 0 })
  const settledEffect = f.store.effects(f.planID).find((candidate) => candidate.id === effect.id)!
  expect(settledEffect.state).toBe("failed")
  const receipt = JSON.parse(settledEffect.receipt!) as {
    history: Record<string, unknown>[]
  }
  expect(receipt.history[0]).toEqual({ error: "Worktree.DirectoryUnavailableError" })
  expect(Object.keys(receipt.history[0]!)).toEqual(["error"])
  expect(receipt.history[0]).not.toHaveProperty("nativeFailure")
  expect(receipt.history[0]).not.toHaveProperty("directory")
  expect(startupFailureSettlementFromReceipt(settledEffect.receipt)).toMatchObject({
    legacyFailure: {
      rawReceipt: '{"error":"Worktree.DirectoryUnavailableError"}',
      provenance: { nativeErrorIdentity: "unknown" },
    },
  })
  expect(f.store.effects(f.planID)).toHaveLength(1)
  expect(
    f.store
      .effects(f.planID)
      .some(
        (item) =>
          item.kind === "session" || item.kind === "prompt" || item.kind.startsWith("verify:"),
      ),
  ).toBe(false)

  const databasePath = f.repository.path
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  f.repository.close()
  const repository = new TaskRepository(databasePath, f.root)
  repositories.push(repository)
  f.repository = repository
  f.store = new RunnerStore(repository)
  const reopened = new TaskRuntime(f.store, f.host, "project")
  runtimes.push(reopened)
  f.runtime = reopened
  await reopened.tick()
  expect(f.calls).toEqual({ worktree: 1, create: 0, prompt: 0 })
  const resume = {
    requestID: "legacy-explicit-resume",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "resume" as const,
    taskID: f.taskID,
    attemptID: attempt.id,
    reason: "Continue the same retained attempt after absence settlement.",
  }
  const authorized = await reopened.command(resume, "owner")
  expect(await reopened.command(resume, "owner")).toEqual(authorized)
  f.host.worktree = async ({ directory, base }) => {
    f.calls.worktree++
    git(f.root, ["worktree", "add", "--detach", directory, base])
    return directory
  }
  await reopened.tick()
  expect(f.calls).toEqual({ worktree: 2, create: 1, prompt: 1 })
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: originalAttempt.id,
    session_id: originalAttempt.session_id,
    message_id: originalAttempt.message_id,
    workspace: originalAttempt.workspace,
    base_commit: originalAttempt.base_commit,
    policy: originalAttempt.policy,
    state: "running",
  })
  expect(f.store.effects(f.planID).find((candidate) => candidate.id === effect.id)?.state).toBe(
    "failed",
  )
  expect(
    f.store.effects(f.planID).find((candidate) => candidate.kind === "worktree-recovery")?.state,
  ).toBe("completed")
})

test("the exact historical 139/141 receipt shapes are classified without an identity allowlist", () => {
  const cases = [
    {
      planID: "916474c0-4f49-4c42-80dd-718ff3c20ba3",
      taskID: "873b7617-e895-486d-bdba-7e89b07dee07",
      attemptID: "dd65c71f-4864-4bdd-a412-03856c5c72c4",
      effectID: "84afbe5e71eab267d4e530a05661b803e37ce7c9589f174d670bb2f08237c408",
      sessionID: "ses_620c358ef5094d448751694fd5b7e898",
      messageID: "msg_beb566f479734be08658df0cbf2e51f3",
      workspace:
        "/Users/tjw/.local/share/opencode/plugins/lazers/runner/worktrees/dd65c71f-4864-4bdd-a412-03856c5c72c4",
      base: "2d5c550270f9fea174dec3ad21312ab3962fd171",
    },
    {
      planID: "8fdab5bc-c948-48b3-baab-8938215b85b7",
      taskID: "89646906-1d2e-4027-b28d-bdd6be580fe9",
      attemptID: "d63243f2-4f6c-4a14-b26b-4a72200d073b",
      effectID: "c947110df7404982f237cc91093e1f18ebac1f52d89f0dd82e58639165eaad98",
      sessionID: "ses_9f38dcf3886440938e167596f2517a32",
      messageID: "msg_76c7b1d2db644f6f9e4e1e18411f0bd1",
      workspace:
        "/Users/tjw/.local/share/opencode/plugins/lazers/runner/worktrees/d63243f2-4f6c-4a14-b26b-4a72200d073b",
      base: "ed5cd6af1c8d82ed7a47e30719bdd5be07e4c6f5",
    },
  ]
  for (const identity of cases) {
    const failure = startupWorktreeFailureEvidence({
      ...identity,
      kind: "worktree",
      state: "uncertain",
      receipt: '{"error":"Worktree.DirectoryUnavailableError"}',
      payload: JSON.stringify({ workspace: identity.workspace, base: identity.base }),
    })
    expect(failure).toMatchObject({
      kind: "legacy-error-only-inference",
      legacyFailure: {
        classification: "legacy-error-only-inference",
        rawReceipt: '{"error":"Worktree.DirectoryUnavailableError"}',
        provenance: { nativeErrorIdentity: "unknown" },
        binding: identity,
      },
    })
    expect(failure).not.toHaveProperty("nativeFailure")
  }

  const identity = cases[0]!
  const input = {
    ...identity,
    kind: "worktree",
    state: "uncertain",
    receipt: '{"error":"Worktree.DirectoryUnavailableError"}',
    payload: JSON.stringify({ workspace: identity.workspace, base: identity.base }),
  }
  for (const invalid of [
    { ...input, kind: "worktree-recovery" },
    { ...input, payload: JSON.stringify({ workspace: identity.workspace, base: "f".repeat(40) }) },
    { ...input, receipt: '{"error":"Worktree.DirectoryUnavailableError","directory":"/x"}' },
    {
      ...input,
      receipt: JSON.stringify({
        schema: UNCERTAIN_EFFECT_RECEIPT_SCHEMA,
        error: "Worktree.DirectoryUnavailableError",
      }),
    },
  ]) {
    expect(startupWorktreeFailureEvidence(invalid)).toBeUndefined()
  }
})

test("legacy dependent worktree compatibility binds the attempt base, not the plan anchor", async () => {
  const makeDependentBase = (f: ReturnType<typeof fixture>) => {
    writeFileSync(join(f.root, "dependency-artifact.txt"), "dependent source\n")
    git(f.root, ["add", "dependency-artifact.txt"])
    git(f.root, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "dependency artifact",
    ])
    return git(f.root, ["rev-parse", "HEAD"])
  }

  const f = fixture()
  const { attempt, effect } = await createUnversionedLegacyFailure(f)
  const planAnchor = JSON.parse(f.store.plan(f.planID)!.body).baseCommit as string
  const attemptBase = makeDependentBase(f)
  expect(attemptBase).not.toBe(planAnchor)
  const payload = { workspace: attempt.workspace, base: attemptBase }
  const linkedEffectID = fingerprint({
    planID: f.planID,
    taskID: f.taskID,
    attemptID: attempt.id,
    kind: "worktree",
    payload,
  })
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET base_commit=? WHERE id=?").run(attemptBase, attempt.id)
    db.query("UPDATE runner_effects SET id=?,payload=?,receipt=? WHERE id=?").run(
      linkedEffectID,
      JSON.stringify(payload),
      '{"error":"Worktree.DirectoryUnavailableError"}',
      effect.id,
    )
  })
  const currentAttempt = f.store.attempts(f.planID)[0]!
  const currentEffect = f.store
    .effects(f.planID)
    .find((candidate) => candidate.id === linkedEffectID)!
  const settled = await f.runtime.command(
    settlementCommand(f, currentAttempt.id, "settle-dependent-base"),
    "owner",
  )
  expect(settled).toMatchObject({
    effectID: linkedEffectID,
    evidence: {
      base: attemptBase,
      legacyFailure: {
        binding: { base: attemptBase, workspace: attempt.workspace },
      },
    },
  })
  expect(currentEffect.state).toBe("uncertain")
  expect(
    f.store.effects(f.planID).find((candidate) => candidate.id === linkedEffectID)?.state,
  ).toBe("failed")
  expect(JSON.parse(f.store.plan(f.planID)!.body).baseCommit).toBe(planAnchor)

  const mismatch = fixture()
  const failed = await createUnversionedLegacyFailure(mismatch)
  const anchor = JSON.parse(mismatch.store.plan(mismatch.planID)!.body).baseCommit as string
  const mismatchedAttemptBase = makeDependentBase(mismatch)
  mismatch.store.atomic((db) =>
    db
      .query("UPDATE runner_attempts SET base_commit=? WHERE id=?")
      .run(mismatchedAttemptBase, failed.attempt.id),
  )
  const version = mismatch.store.plan(mismatch.planID)!.version
  await expect(
    mismatch.runtime.command(
      settlementCommand(mismatch, failed.attempt.id, "reject-mismatched-payload"),
      "owner",
    ),
  ).rejects.toThrow("bound terminal native failure evidence")
  expect(mismatch.store.plan(mismatch.planID)).toMatchObject({ state: "blocked", version })
  expect(
    mismatch.store.effects(mismatch.planID).find((candidate) => candidate.id === failed.effect.id)
      ?.state,
  ).toBe("uncertain")
  expect(mismatch.store.attempts(mismatch.planID)[0]!.base_commit).toBe(mismatchedAttemptBase)
  expect(JSON.parse(mismatch.store.plan(mismatch.planID)!.body).baseCommit).toBe(anchor)
  expect(mismatch.calls).toEqual({ worktree: 1, create: 0, prompt: 0 })
})

test("unknown, timed-out and ENOSPC failures cannot be settled as terminal absence", async () => {
  for (const message of [
    "response timed out",
    "lost response after native call",
    "ENOSPC: no space left on device",
    "Worktree.DirectoryUnavailableError",
  ]) {
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
    expect(JSON.parse(effect.receipt!)).toMatchObject({
      schema: UNCERTAIN_EFFECT_RECEIPT_SCHEMA,
      error: message,
    })
    expect(nativeWorktreeFailureEvidence(JSON.parse(effect.receipt!))).toBeUndefined()
    expect(nativeWorktreeFailureEvidence(new Error(message))).toBeUndefined()
    await expect(f.runtime.command(settlementCommand(f, attempt.id), "owner")).rejects.toThrow(
      "bound terminal native failure evidence",
    )
    assertSettlementWasNonMutating(f, effect.id, version)
  }
})

test("each conclusively failed linked recovery can be settled before another explicit resume", async () => {
  const f = fixture()
  const { attempt, effect: original } = await createTerminalFailure(f)
  const initialAttempt = structuredClone(attempt)
  const initialPlan = structuredClone(f.store.plan(f.planID)!)
  await f.runtime.command(settlementCommand(f, attempt.id, "settle-original"), "owner")

  let worktreeCalls = 1
  const nativeFailure = (message: string) =>
    new NativeWorktreeCreationFailure({
      schema: "lazers-native-worktree-failure/v2",
      api: "worktree.create",
      nativeTag: "Worktree.OperationError",
      message,
    })
  f.host.worktree = async ({ directory, base }) => {
    worktreeCalls++
    f.calls.worktree++
    if (worktreeCalls < 4) throw nativeFailure(`Recovery generation ${worktreeCalls - 1} failed`)
    expect(f.calls.prompt).toBe(0)
    git(f.root, ["worktree", "add", "--detach", directory, base])
    return directory
  }
  const prompt = f.host.prompt
  f.host.prompt = async (input) => {
    expect(f.calls.prompt).toBe(0)
    expect(git(attempt.workspace, ["rev-parse", "HEAD"])).toBe(attempt.base_commit)
    await prompt(input)
  }

  const authorizeResume = async (requestID: string) => {
    const command = {
      requestID,
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "resume" as const,
      taskID: f.taskID,
      attemptID: attempt.id,
      reason: "Explicitly continue the same attempt after startup absence settlement.",
    }
    const authorization = await f.runtime.command(command, "owner")
    expect(await f.runtime.command(command, "owner")).toEqual(authorization)
    return authorization
  }

  const resume1 = await authorizeResume("resume-generation-1")
  await f.runtime.tick()
  const recovery1 = f.store
    .effects(f.planID)
    .find((candidate) => candidate.kind === "worktree-recovery")!
  expect(recovery1.state).toBe("uncertain")
  expect(f.store.plan(f.planID)!.state).toBe("blocked")
  expect(f.calls).toEqual({ worktree: 2, create: 0, prompt: 0 })

  const settle1 = settlementCommand(f, attempt.id, "settle-generation-1")
  const settlement1 = await f.runtime.command(settle1, "owner")
  expect(await f.runtime.command(settle1, "owner")).toEqual(settlement1)
  expect(recovery1.id).not.toBe(original.id)
  expect(f.store.effects(f.planID).find((candidate) => candidate.id === recovery1.id)?.state).toBe(
    "failed",
  )
  expect(f.store.effects(f.planID).find((candidate) => candidate.id === original.id)?.state).toBe(
    "failed",
  )
  expect(f.calls).toEqual({ worktree: 2, create: 0, prompt: 0 })

  const databasePath = f.repository.path
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  f.repository.close()
  const repository = new TaskRepository(databasePath, f.root)
  repositories.push(repository)
  f.repository = repository
  f.store = new RunnerStore(repository)
  f.runtime = new TaskRuntime(f.store, f.host, "project")
  runtimes.push(f.runtime)
  await f.runtime.tick()
  expect(f.calls).toEqual({ worktree: 2, create: 0, prompt: 0 })

  const resume2 = await authorizeResume("resume-generation-2")
  await f.runtime.tick()
  const recovery2 = f.store
    .effects(f.planID)
    .filter((candidate) => candidate.kind === "worktree-recovery")[1]!
  expect(recovery2.state).toBe("uncertain")
  expect(f.store.plan(f.planID)!.state).toBe("blocked")
  expect(f.calls).toEqual({ worktree: 3, create: 0, prompt: 0 })
  await f.runtime.command(settlementCommand(f, attempt.id, "settle-generation-2"), "owner")
  expect(f.store.effects(f.planID).find((candidate) => candidate.id === recovery2.id)?.state).toBe(
    "failed",
  )

  const resume3 = await authorizeResume("resume-generation-3")
  await f.runtime.tick()
  const effects = f.store.effects(f.planID)
  const recoveries = effects.filter((candidate) => candidate.kind === "worktree-recovery")
  expect(recoveries).toHaveLength(3)
  expect(new Set(recoveries.map((candidate) => candidate.id)).size).toBe(3)
  expect(recoveries.map((candidate) => candidate.state)).toEqual(["failed", "failed", "completed"])
  expect(JSON.parse(recoveries[0]!.payload)).toMatchObject({
    recoveryID: (resume1 as { recoveryID: string }).recoveryID,
    sourceEffectID: original.id,
    settlementRequestID: "settle-original",
  })
  expect(JSON.parse(recoveries[1]!.payload)).toMatchObject({
    recoveryID: (resume2 as { recoveryID: string }).recoveryID,
    sourceEffectID: recoveries[0]!.id,
    settlementRequestID: "settle-generation-1",
  })
  expect(JSON.parse(recoveries[2]!.payload)).toMatchObject({
    recoveryID: (resume3 as { recoveryID: string }).recoveryID,
    sourceEffectID: recoveries[1]!.id,
    settlementRequestID: "settle-generation-2",
  })
  expect(
    startupFailureSettlementFromReceipt(
      f.store.effects(f.planID).find((candidate) => candidate.id === original.id)!.receipt,
    ),
  ).toMatchObject({
    requestID: "settle-original",
    effectID: original.id,
  })
  expect(startupFailureSettlementFromReceipt(recoveries[0]!.receipt)).toMatchObject({
    requestID: "settle-generation-1",
    effectID: recoveries[0]!.id,
  })
  expect(startupFailureSettlementFromReceipt(recoveries[1]!.receipt)).toMatchObject({
    requestID: "settle-generation-2",
    effectID: recoveries[1]!.id,
  })
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: initialAttempt.id,
    session_id: initialAttempt.session_id,
    message_id: initialAttempt.message_id,
    workspace: initialAttempt.workspace,
    base_commit: initialAttempt.base_commit,
    policy: initialAttempt.policy,
    token_count: initialAttempt.token_count,
    cost: initialAttempt.cost,
    tool_count: initialAttempt.tool_count,
    state: "running",
  })
  expect(f.store.plan(f.planID)).toMatchObject({
    owner: initialPlan.owner,
    revision: initialPlan.revision,
    body: initialPlan.body,
    model: initialPlan.model,
    state: "running",
  })
  expect(f.calls).toEqual({ worktree: 4, create: 1, prompt: 1 })
  expect(
    f.store
      .activity(f.planID, f.taskID)
      .filter((entry) => entry.event === "STARTUP_RECOVERY_AUTHORIZED"),
  ).toHaveLength(3)
  expect(
    f.store.activity(f.planID, f.taskID).filter((entry) => entry.event === "WORKER_STARTED"),
  ).toHaveLength(1)
})

test("a new owner may settle historical linked failure and explicitly continue under fresh authority", async () => {
  const f = fixture()
  const { attempt, effect: original } = await createTerminalFailure(f)
  await f.runtime.command(settlementCommand(f, attempt.id, "owner-settlement-1"), "owner")
  await f.runtime.command(
    {
      requestID: "owner-recovery-1",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "resume",
      taskID: f.taskID,
      attemptID: attempt.id,
      reason: "Explicitly authorize the first linked recovery.",
    },
    "owner",
  )
  await f.runtime.tick()
  const recovery1 = f.store
    .effects(f.planID)
    .find((candidate) => candidate.kind === "worktree-recovery")!
  expect(recovery1.state).toBe("uncertain")
  expect(f.calls).toEqual({ worktree: 2, create: 0, prompt: 0 })

  f.sessions.set("next-owner", {
    ...structuredClone(f.sessions.get("owner")!),
    id: "next-owner",
  })
  await f.runtime.command(
    {
      requestID: "transfer-after-recovery-failure",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "reassign",
      targetSessionID: "next-owner",
      reason: "Continue recovery through the active coordinator.",
    },
    "owner",
  )
  const afterTransferVersion = f.store.plan(f.planID)!.version
  await expect(
    f.runtime.command(settlementCommand(f, attempt.id, "stale-owner-settlement"), "owner"),
  ).rejects.toThrow("Only the plan owner")
  expect(f.store.plan(f.planID)).toMatchObject({ state: "blocked", version: afterTransferVersion })
  expect(f.store.effects(f.planID).find((candidate) => candidate.id === recovery1.id)?.state).toBe(
    "uncertain",
  )
  expect(f.calls).toEqual({ worktree: 2, create: 0, prompt: 0 })

  const secondSettlementCommand = settlementCommand(f, attempt.id, "next-owner-settlement-2")
  const secondSettlement = await f.runtime.command(secondSettlementCommand, "next-owner")
  expect(secondSettlement).toMatchObject({
    status: "startup-failure-settled-absent",
    effectID: recovery1.id,
  })
  expect(await f.runtime.command(secondSettlementCommand, "next-owner")).toEqual(secondSettlement)
  expect(f.store.effects(f.planID).find((candidate) => candidate.id === recovery1.id)?.state).toBe(
    "failed",
  )
  expect(f.store.effects(f.planID).find((candidate) => candidate.id === original.id)?.state).toBe(
    "failed",
  )

  f.host.worktree = async ({ directory, base }) => {
    f.calls.worktree++
    expect(f.calls.prompt).toBe(0)
    git(f.root, ["worktree", "add", "--detach", directory, base])
    return directory
  }
  const prompt = f.host.prompt
  f.host.prompt = async (input) => {
    expect(f.calls.prompt).toBe(0)
    expect(git(attempt.workspace, ["rev-parse", "HEAD"])).toBe(attempt.base_commit)
    await prompt(input)
  }
  await f.runtime.command(
    {
      requestID: "next-owner-recovery-2",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "resume",
      taskID: f.taskID,
      attemptID: attempt.id,
      reason: "Explicitly resume after current-owner settlement.",
    },
    "next-owner",
  )
  await f.runtime.tick()

  const recoveries = f.store
    .effects(f.planID)
    .filter((candidate) => candidate.kind === "worktree-recovery")
  expect(recoveries).toHaveLength(2)
  expect(recoveries.map((candidate) => candidate.state)).toEqual(["failed", "completed"])
  expect(recoveries[0]!.id).not.toBe(recoveries[1]!.id)
  expect(JSON.parse(recoveries[0]!.payload)).toMatchObject({
    sourceEffectID: original.id,
    settlementRequestID: "owner-settlement-1",
    authorizedOwner: "owner",
  })
  expect(JSON.parse(recoveries[1]!.payload)).toMatchObject({
    sourceEffectID: recoveries[0]!.id,
    settlementRequestID: "next-owner-settlement-2",
    authorizedOwner: "next-owner",
  })
  const authorizations = f.store
    .activity(f.planID, f.taskID)
    .filter((entry) => entry.event === "STARTUP_RECOVERY_AUTHORIZED")
    .map((entry) => JSON.parse(entry.payload) as Record<string, unknown>)
  expect(authorizations).toHaveLength(2)
  expect(authorizations.map((authorization) => authorization.owner)).toEqual([
    "owner",
    "next-owner",
  ])
  expect(authorizations[0]!.ownerEpoch).not.toBe(authorizations[1]!.ownerEpoch)
  expect(startupFailureSettlementFromReceipt(recoveries[0]!.receipt)).toMatchObject({
    requestID: "next-owner-settlement-2",
    effectID: recoveries[0]!.id,
  })
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
  expect(f.calls).toEqual({ worktree: 3, create: 1, prompt: 1 })
  expect(
    f.store.activity(f.planID, f.taskID).filter((entry) => entry.event === "WORKER_STARTED"),
  ).toHaveLength(1)
})

test("a late recovery callback after reassignment cannot commit old readiness or admit a worker", async () => {
  const f = fixture()
  const { attempt } = await createTerminalFailure(f)
  await f.runtime.command(settlementCommand(f, attempt.id), "owner")
  await f.runtime.command(
    {
      requestID: "authorize-reassigned-callback",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "resume",
      taskID: f.taskID,
      attemptID: attempt.id,
      reason: "Authorize startup recovery before the owner transfer.",
    },
    "owner",
  )

  let creating!: () => void
  let release!: () => void
  const creationStarted = new Promise<void>((resolve) => (creating = resolve))
  const delayedCreation = new Promise<void>((resolve) => (release = resolve))
  f.host.worktree = async ({ directory, base }) => {
    f.calls.worktree++
    creating()
    await delayedCreation
    git(f.root, ["worktree", "add", "--detach", directory, base])
    return directory
  }
  const pendingTick = f.runtime.tick()
  await creationStarted
  f.sessions.set("next-owner", {
    ...structuredClone(f.sessions.get("owner")!),
    id: "next-owner",
  })
  await f.runtime.command(
    {
      requestID: "reassign-during-worktree-recovery",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "reassign",
      targetSessionID: "next-owner",
      reason: "Transfer authority while native creation is in flight.",
    },
    "owner",
  )
  release()
  await pendingTick

  const recovery = f.store.effects(f.planID).find((effect) => effect.kind === "worktree-recovery")!
  expect(recovery.state).toBe("intended")
  expect(f.store.plan(f.planID)).toMatchObject({ owner: "next-owner", state: "running" })
  expect(f.store.attempts(f.planID)[0]!.state).toBe("preparing")
  expect(f.calls).toEqual({ worktree: 2, create: 0, prompt: 0 })
  const events = f.store.activity(f.planID, f.taskID)
  expect(events.some((event) => event.event === "STARTUP_RECOVERY_WORKTREE_READY")).toBe(false)
  expect(events.some((event) => event.event === "WORKER_STARTED")).toBe(false)
  const authorization = JSON.parse(
    events.find((event) => event.event === "STARTUP_RECOVERY_AUTHORIZED")!.payload,
  ) as Record<string, unknown>
  expect(authorization.owner).toBe("owner")
  expect(authorization.ownerEpoch).not.toBe(f.store.planControlEpoch(f.planID))
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
