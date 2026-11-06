import { afterEach, expect, test } from "bun:test"
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
import { dirname, join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import { RunnerStore } from "./store.ts"
import { ProbeRepository } from "../verification/probe/store.ts"
import { ResourceRepository } from "../verification/resources/store.ts"
import { filesystemProbeLifecycle } from "../verification/resources/lifecycle.ts"
import { retainedVerificationProbeBasis } from "./retained-verification/probe.ts"
import { RetainedVerificationSchema } from "./retained-verification/schema.ts"
import {
  createRetainedCheckContext,
  runRetainedSetupProcess,
} from "./retained-verification/isolation.ts"
import type { RetainedDependencyInstaller } from "./retained-verification/isolation.ts"
import {
  registerRetainedVerificationResources,
  saveRetainedVerification,
  updateRetainedVerificationResourceIdentity,
} from "./retained-verification/store.ts"
import { retainedProcedurePlan } from "./retained-verification/procedure.ts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture(
  options: {
    taskCheckCommand?: string
    combinedCheckCommand?: string
    failRetainedCleanup?: boolean
    humanTaskEvidence?: boolean
    retainedDependencyInstaller?: RetainedDependencyInstaller
    requestTick?: () => Promise<void>
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lazers-retained-reverify-project-"))
  const state = mkdtempSync(join(tmpdir(), "lazers-retained-reverify-state-"))
  const originalHome = process.env.HOME
  const originalVerificationDB = process.env.LAZERS_VERIFICATION_SQLITE
  const oldHome = join(state, "old-home")
  mkdirSync(oldHome)
  mkdirSync(join(oldHome, "profile"))
  writeFileSync(join(oldHome, "profile", "sentinel"), "preexisting\n")
  process.env.HOME = oldHome
  delete process.env.LAZERS_VERIFICATION_SQLITE
  git(root, ["init", "--initial-branch=main"])
  git(root, ["config", "user.name", "fixture"])
  git(root, ["config", "user.email", "fixture@example.invalid"])
  writeFileSync(join(root, "seed.txt"), "baseline\n")
  writeFileSync(join(root, ".gitignore"), "node_modules/\n")
  writeFileSync(
    join(root, "package.json"),
    '{"name":"retained-reverify-fixture","version":"1.0.0"}\n',
  )
  if (options.retainedDependencyInstaller) {
    const manifest = {
      name: "retained-reverify-fixture",
      version: "1.0.0",
      dependencies: { "retained-fixture-dependency": "file:vendor/fixture-dependency.tgz" },
    }
    mkdirSync(join(root, "vendor"), { recursive: true })
    writeFileSync(join(root, "vendor", "fixture-dependency.tgz"), "injected installer fixture\n")
    writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest)}\n`)
    writeFileSync(join(root, "bun.lock"), '{"lockfileVersion":1,"workspaces":{}}\n')
  }
  mkdirSync(join(root, "node_modules"))
  for (const directory of [
    "src/runner",
    "src/models",
    "src/verification/resources",
    "src/verification/probe",
    "test/retained-verification",
  ])
    mkdirSync(join(root, directory), { recursive: true })
  for (const directory of [
    "src/verification/resources",
    "src/verification/probe",
    "test/retained-verification",
  ])
    writeFileSync(join(root, directory, ".keep"), "fixture target\n")
  writeFileSync(
    join(root, "src", "runner", "retained-check.test.ts"),
    `import { Database } from "bun:sqlite"\n` +
      `import { appendFileSync, mkdirSync } from "node:fs"\n` +
      `import { dirname, join } from "node:path"\n` +
      `import { expect, test } from "bun:test"\n` +
      `test("authored project check writes only to the isolated profile and database", () => {\n` +
      `  if (!process.env.LAZERS_VERIFICATION_SQLITE) throw new Error("No private verification database")\n` +
      `  const sentinel = join(process.env.HOME!, "profile", "sentinel")\n` +
      `  mkdirSync(dirname(sentinel), { recursive: true })\n` +
      `  const db = new Database(process.env.LAZERS_VERIFICATION_SQLITE!)\n` +
      `  let checkID: string\n` +
      `  try {\n` +
      `    checkID = db.query<{ check_id: string }, []>("SELECT check_id FROM retained_verification_owner").get()!.check_id\n` +
      `    db.exec("CREATE TABLE IF NOT EXISTS writes(value TEXT)")\n` +
      `    db.query("INSERT INTO writes VALUES (?)").run(checkID)\n` +
      `  }\n` +
      `  finally { db.close() }\n` +
      `  appendFileSync(sentinel, checkID === "isolated-combined-check" ? "combined\\n" : "task\\n")\n` +
      `  expect(checkID).toMatch(/^isolated-(?:task|combined)-check$/)\n` +
      `})\n`,
  )
  writeFileSync(
    join(root, "src", "models", "retained-delayed-check.test.ts"),
    `import { appendFileSync, mkdirSync } from "node:fs"\n` +
      `import { dirname, join } from "node:path"\n` +
      `import { test } from "bun:test"\n` +
      `test("waits after publishing its isolated start witness", async () => {\n` +
      `  if (!process.env.LAZERS_VERIFICATION_SQLITE) throw new Error("No private verification database")\n` +
      `  const started = join(process.env.HOME!, "started")\n` +
      `  mkdirSync(dirname(started), { recursive: true })\n` +
      `  appendFileSync(started, "started\\n")\n` +
      `  await Bun.sleep(10_000)\n` +
      `}, { timeout: 20_000 })\n`,
  )
  git(root, ["add", "-A"])
  git(root, ["commit", "-m", "baseline"])
  const base = git(root, ["rev-parse", "HEAD"])
  const repository = new TaskRepository(join(state, "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  const model = { providerID: "openai", id: "retained-check-test", variant: "high" }
  const proposal = validProposal()
  proposal.objective = "Write and verify an exact retained candidate"
  proposal.writeScope = ["result.txt"]
  proposal.verification = [
    {
      id: "isolated-task-check",
      command:
        options.taskCheckCommand ??
        "bun test src/runner src/verification/resources src/verification/probe test/retained-verification",
      timeoutMs: 10_000,
    },
  ]
  proposal.acceptance = [
    {
      id: "task-candidate",
      assertion: "The exact committed result is present and its private-resource check passes",
      evidence: [
        { kind: "verification", verificationID: "isolated-task-check" },
        ...(options.humanTaskEvidence
          ? [{ kind: "human" as const, decision: "Architect observes the exact candidate" }]
          : []),
      ],
    },
  ]
  proposal.limits.maxRepairAttempts = 0
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
  const plan = store.submit(
    {
      requestID: "retained-reverify-plan",
      objective: "Verify a committed result without replacing its worker",
      workspaceMode: "isolated",
      baseCommit: base,
      workerModel: model,
      nodes: [{ taskID: task.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: [
        {
          id: "isolated-combined-check",
          command:
            options.combinedCheckCommand ??
            "bun test src/runner src/verification/resources src/verification/probe test/retained-verification",
          timeoutMs: 10_000,
        },
      ],
      acceptance: [
        {
          id: "combined-candidate",
          assertion: "The combined candidate passed its exact private-resource check",
          evidence: [{ kind: "verification", verificationID: "isolated-combined-check" }],
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
        tokens: null,
        tools: 0,
        cost: null,
        messages: [],
      },
    ],
    [
      "owner2",
      {
        id: "owner2",
        projectID: "project",
        directory: root,
        agent: "architect",
        archived: false,
        busy: false,
        tokens: null,
        tools: 0,
        cost: null,
        messages: [],
      },
    ],
  ])
  const prompts: Array<{ sessionID: string; id: string }> = []
  const created: string[] = []
  const worktreeCreations: string[] = []
  const host: RunnerHost = {
    workerModel: () => Promise.resolve(model),
    worktree: ({ directory, base: source }) => {
      mkdirSync(dirname(directory), { recursive: true })
      worktreeCreations.push(directory)
      git(root, ["worktree", "add", "--detach", directory, source])
      return Promise.resolve(directory)
    },
    worktrees: () =>
      Promise.resolve(
        git(root, ["worktree", "list", "--porcelain"])
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice(9)),
      ),
    removeWorktree: (directory) => {
      if (options.failRetainedCleanup && directory.includes("/retained-"))
        return Promise.reject(new Error("fixture native cleanup unavailable"))
      git(root, ["worktree", "remove", directory])
      return Promise.resolve()
    },
    session: (id) => Promise.resolve(structuredClone(sessions.get(id) ?? null)),
    create: (input) => {
      created.push(input.id)
      sessions.set(input.id, {
        id: input.id,
        parentID: input.parentID,
        projectID: "project",
        directory: input.directory,
        agent: input.agent,
        model: input.model,
        metadata: { lazersAttemptID: input.attemptID },
        archived: false,
        busy: false,
        pendingInput: false,
        pendingPermissions: 0,
        pendingForms: 0,
        background: {
          state: "observed",
          source: "experimental.idle",
          observedAt: Date.now(),
          inputID: "before-first-prompt",
          executionStartSequence: 1,
          eventSequence: 1,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        tokens: 41,
        tools: 2,
        cost: null,
        messages: [],
      })
      return Promise.resolve()
    },
    createArchitect: async () => {},
    waitForSession: async () => {},
    prompt: (input) => {
      prompts.push({ sessionID: input.sessionID, id: input.id })
      const worker = sessions.get(input.sessionID)
      if (!worker) throw new Error("The original worker is missing")
      writeFileSync(join(input.directory, "result.txt"), "retained candidate\n")
      git(input.directory, ["add", "result.txt"])
      git(input.directory, ["commit", "-m", "retained candidate"])
      worker.messages.push({ id: input.id, text: input.text })
      worker.busy = false
      worker.pendingInput = false
      worker.pendingPermissions = 0
      worker.pendingForms = 0
      worker.outcome = "succeeded"
      worker.turn = { inputID: input.id, state: "completed" }
      if (worker.background?.state === "observed") worker.background.inputID = input.id
      worker.tokens = 55
      worker.tools = 4
      return Promise.resolve()
    },
    updateInstruction: async () => {},
    notify: async () => {},
    interrupt: async () => {},
  }
  const runtime = new TaskRuntime(store, host, "project", undefined, {
    ...(options.requestTick === undefined ? {} : { requestTick: options.requestTick }),
    retainedDependencyInstaller: options.retainedDependencyInstaller,
  })
  cleanups.push(() => {
    void runtime.stop()
    repository.close()
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalVerificationDB === undefined) delete process.env.LAZERS_VERIFICATION_SQLITE
    else process.env.LAZERS_VERIFICATION_SQLITE = originalVerificationDB
    rmSync(root, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })
  return {
    root,
    state,
    oldHome,
    task,
    planID: plan.planID,
    store,
    runtime,
    sessions,
    prompts,
    created,
    worktreeCreations,
    host,
  }
}

async function failedFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options)
  await f.runtime.command(
    { requestID: "run-retained-fixture", planID: f.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  for (let i = 0; i < 5; i++) await f.runtime.tick()
  const plan = f.store.plan(f.planID)!
  const attempt = f.store.attempts(f.planID).at(-1)!
  if (!attempt.artifact) throw new Error("Fixture attempt did not retain an artifact")
  return { ...f, plan, attempt, artifact: attempt.artifact }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function retainedVerifyCommand(f: Awaited<ReturnType<typeof failedFixture>>, requestID: string) {
  const plan = f.store.plan(f.planID)!
  return {
    requestID,
    planID: f.planID,
    expectedVersion: plan.version,
    action: "verify-retained" as const,
    projectID: "project",
    planRevision: plan.revision,
    taskID: f.task.id,
    taskRevision: f.task.revision,
    attemptID: f.attempt.id,
    artifact: f.artifact,
    reason: "Verify the exact retained candidate without replaying its worker turn",
  }
}

function writeInjectedPrivatePackage(candidateWorkspace: string): void {
  const dependencyRoot = realpathSync(join(candidateWorkspace, "node_modules"))
  const packageDirectory = join(dependencyRoot, "retained-fixture-dependency")
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(
    join(packageDirectory, "package.json"),
    '{"name":"retained-fixture-dependency","version":"1.0.0"}\n',
  )
}

test("owner verifies an exact failed-attempt candidate with zero replacement prompts", async () => {
  const f = await failedFixture()
  const planBefore = f.plan
  const attemptBefore = f.attempt
  expect(planBefore.state).toBe("blocked")
  expect(attemptBefore.state).toBe("failed")
  expect(attemptBefore.artifact).toMatch(/^[a-f0-9]{40}$/)
  const exactArtifact = attemptBefore.artifact
  if (!exactArtifact) throw new Error("Failed attempt did not retain its committed candidate")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  const sessionBefore = structuredClone(f.sessions.get(attemptBefore.session_id))
  const promptCount = f.prompts.length
  const sessionCount = f.created.length
  const worktreeCount = f.worktreeCreations.length
  const oldEffectPayload = JSON.stringify({ uncertain: true, originalAttemptOnly: true })
  f.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_effects(id,plan_id,task_id,attempt_id,kind,state,payload,receipt,fence)
       VALUES('retained-old-uncertain-effect',?,?,?,?,?,?,NULL,0)`,
      )
      .run(
        f.planID,
        f.task.id,
        attemptBefore.id,
        "old-resource-effect",
        "uncertain",
        oldEffectPayload,
      ),
  )
  const oldEffectBefore = f.store
    .effects(f.planID)
    .find((effect) => effect.id === "retained-old-uncertain-effect")
  const oldProfileBefore = readFileSync(join(f.oldHome, "profile", "sentinel"), "utf8")

  const verifyCommand = {
    requestID: "verify-retained-candidate",
    planID: f.planID,
    expectedVersion: planBefore.version,
    action: "verify-retained" as const,
    projectID: "project",
    planRevision: planBefore.revision,
    taskID: f.task.id,
    taskRevision: f.task.revision,
    attemptID: attemptBefore.id,
    artifact: exactArtifact,
    reason: "Verify the exact committed implementation without replaying its worker turn",
  }
  const result = (await f.runtime.command(verifyCommand, "owner")) as {
    operationID: string
    generation: number
    status: string
  }

  expect(result.status).toBe("retained-verification-requested")
  expect(result.generation).toBe(1)
  expect(await f.runtime.command(verifyCommand, "owner")).toEqual(result)
  expect(f.worktreeCreations).toHaveLength(worktreeCount + 2)
  const operation = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(result.operationID),
  )
  expect(operation).toBeDefined()
  const retained = JSON.parse(operation!.payload) as {
    state: string
    cleanupState: string
    artifact: string
    combinedArtifact: string
    taskWorkspace: string | null
    combinedWorkspace: string | null
  }
  expect(retained.state).toBe("accepted")
  expect(retained.cleanupState).toBe("complete")
  expect(retained.artifact).toBe(exactArtifact)
  expect(f.store.plan(f.planID)?.state).toBe("accepted")
  expect(f.store.nodes(f.planID)[0]?.artifact).toBe(exactArtifact)
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: attemptBefore.id,
    state: "failed",
    session_id: attemptBefore.session_id,
    message_id: attemptBefore.message_id,
    artifact: exactArtifact,
    token_count: attemptBefore.token_count,
    tool_count: attemptBefore.tool_count,
    cost: attemptBefore.cost,
  })
  expect(f.prompts).toHaveLength(promptCount)
  expect(f.created).toHaveLength(sessionCount)
  expect(f.sessions.get(attemptBefore.session_id)).toEqual(sessionBefore)
  expect(
    f.store.effects(f.planID).find((effect) => effect.id === "retained-old-uncertain-effect"),
  ).toEqual(oldEffectBefore)
  expect(oldEffectBefore).toMatchObject({ state: "uncertain", payload: oldEffectPayload })
  expect(readFileSync(join(f.oldHome, "profile", "sentinel"), "utf8")).toBe(oldProfileBefore)
  expect(retained.combinedArtifact).toMatch(/^[a-f0-9]{40}$/)
  expect(retained.taskWorkspace).not.toBeNull()
  expect(retained.combinedWorkspace).not.toBeNull()
  expect(existsSync(retained.taskWorkspace!)).toBe(false)
  expect(existsSync(retained.combinedWorkspace!)).toBe(false)
  const checks = f.store.atomic((db) =>
    db
      .query<
        {
          phase: string
          check_id: string
          state: string
          receipt: string | null
          cleanup_state: string
        },
        [string]
      >(
        "SELECT phase,check_id,state,receipt,cleanup_state FROM runner_retained_verification_checks WHERE operation_id=? ORDER BY phase",
      )
      .all(result.operationID),
  )
  expect(checks).toHaveLength(2)
  expect(
    checks.every((check) => check.state === "completed" && check.cleanup_state === "complete"),
  ).toBe(true)
  for (const check of checks) {
    const receipt = JSON.parse(check.receipt!) as {
      exitCode: number
      cwd: string
      isolation: {
        operationID: string
        generation: number
        phase: string
        resources: Array<{ name: string; realPath: string; device: number; inode: number }>
        sqlitePath: string
      }
    }
    expect(receipt.exitCode).toBe(0)
    expect(receipt.cwd).not.toBe(attemptBefore.workspace)
    expect(receipt.isolation.operationID).toBe(result.operationID)
    expect(receipt.isolation.generation).toBe(1)
    expect(receipt.isolation.phase).toBe(check.phase)
    expect(receipt.isolation.resources.length).toBe(9)
    expect(
      new Set(receipt.isolation.resources.map((resource) => `${resource.device}:${resource.inode}`))
        .size,
    ).toBe(9)
    expect(receipt.isolation.sqlitePath).toContain("retained-verification-resources")
  }
})

test("stale, wrong-candidate, wrong-attempt and foreign-owner requests launch no checks", async () => {
  const f = await failedFixture()
  const base = {
    planID: f.planID,
    expectedVersion: f.plan.version,
    action: "verify-retained" as const,
    projectID: "project",
    planRevision: f.plan.revision,
    taskID: f.task.id,
    taskRevision: f.task.revision,
    attemptID: f.attempt.id,
    artifact: f.artifact,
    reason: "Check the latest candidate under current owner authority",
  }
  const worktreeCount = f.worktreeCreations.length
  await expect(
    f.runtime.command(
      { ...base, requestID: "stale-plan-revision", planRevision: f.plan.revision + 1 },
      "owner",
    ),
  ).rejects.toThrow("plan revision is stale")
  await expect(
    f.runtime.command({ ...base, requestID: "wrong-artifact", artifact: "f".repeat(40) }, "owner"),
  ).rejects.toThrow("Candidate does not match")
  await expect(
    f.runtime.command(
      { ...base, requestID: "wrong-attempt", attemptID: crypto.randomUUID() },
      "owner",
    ),
  ).rejects.toThrow("latest original attempt")
  await expect(
    f.runtime.command({ ...base, requestID: "foreign-caller" }, "foreign-session"),
  ).rejects.toThrow("Only the plan owner")
  expect(f.worktreeCreations).toHaveLength(worktreeCount)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM runner_retained_verification_checks",
          )
          .get()!.count,
    ),
  ).toBe(0)
})

test("unisolatable required shared services block before checkout or check receipt", async () => {
  const f = fixture({ taskCheckCommand: "true # http://127.0.0.1:5432" })
  await f.runtime.command(
    {
      requestID: "run-shared-service-fixture",
      planID: f.planID,
      expectedVersion: 1,
      action: "run",
    },
    "owner",
  )
  for (let i = 0; i < 5; i++) await f.runtime.tick()
  const plan = f.store.plan(f.planID)!
  const attempt = f.store.attempts(f.planID).at(-1)!
  if (!attempt.artifact) throw new Error("Fixture attempt did not retain an artifact")
  const before = f.worktreeCreations.length
  const result = (await f.runtime.command(
    {
      requestID: "verify-unisolatable-shared-service",
      planID: f.planID,
      expectedVersion: plan.version,
      action: "verify-retained",
      projectID: "project",
      planRevision: plan.revision,
      taskID: f.task.id,
      taskRevision: f.task.revision,
      attemptID: attempt.id,
      artifact: attempt.artifact,
      reason: "Verify whether a shared database check can run in isolation",
    },
    "owner",
  )) as { operationID: string }
  const retained = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(result.operationID),
  )!
  expect(JSON.parse(retained.payload)).toMatchObject({
    state: "held",
    holdReason: expect.stringContaining("shared external service"),
  })
  expect(f.worktreeCreations).toHaveLength(before)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=?",
          )
          .get(result.operationID)!.count,
    ),
  ).toBe(0)
})

test("an opaque called script is held before candidate checkout or receipt creation", async () => {
  const f = fixture({ taskCheckCommand: "bun ./scripts/check-profile-and-database.ts" })
  await f.runtime.command(
    {
      requestID: "run-indirect-resource-fixture",
      planID: f.planID,
      expectedVersion: 1,
      action: "run",
    },
    "owner",
  )
  for (let i = 0; i < 5; i++) await f.runtime.tick()
  const plan = f.store.plan(f.planID)!
  const attempt = f.store.attempts(f.planID).at(-1)!
  if (!attempt.artifact) throw new Error("Fixture attempt did not retain an artifact")
  const before = f.worktreeCreations.length
  const result = (await f.runtime.command(
    {
      requestID: "verify-indirect-resource-check",
      planID: f.planID,
      expectedVersion: plan.version,
      action: "verify-retained",
      projectID: "project",
      planRevision: plan.revision,
      taskID: f.task.id,
      taskRevision: f.task.revision,
      attemptID: attempt.id,
      artifact: attempt.artifact,
      reason: "Hold indirect checks until their actual mutable resources can be bound",
    },
    "owner",
  )) as { operationID: string }
  const retained = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(result.operationID),
  )!
  expect(JSON.parse(retained.payload)).toMatchObject({
    state: "held",
    holdReason: expect.stringContaining("has no project-authored procedure/resource binding"),
  })
  expect(f.worktreeCreations).toHaveLength(before)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=?",
          )
          .get(result.operationID)!.count,
    ),
  ).toBe(0)
})

test("a current task probe definition cannot be bypassed by task-check receipts", async () => {
  const f = await failedFixture()
  const probes = new ProbeRepository(f.store.repository)
  probes.define(
    {
      requestID: "required-retained-probe-definition",
      target: { kind: "task", taskID: f.task.id },
      scenarios: [
        {
          id: "retained-live-behavior",
          summary: "Exercise the exact retained candidate",
          acceptanceIDs: ["task-candidate"],
          procedure: { recordID: "runbook:retained-probe", revision: "1" },
        },
      ],
      notApplicable: [],
    },
    { sessionID: "owner", agent: "architect" },
  )
  const result = (await f.runtime.command(
    {
      requestID: "verify-with-required-live-probe",
      planID: f.planID,
      expectedVersion: f.plan.version,
      action: "verify-retained",
      projectID: "project",
      planRevision: f.plan.revision,
      taskID: f.task.id,
      taskRevision: f.task.revision,
      attemptID: f.attempt.id,
      artifact: f.artifact,
      reason: "Verify the exact candidate and preserve its required live behavior gate",
    },
    "owner",
  )) as { operationID: string }
  const retained = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(result.operationID),
  )!
  expect(JSON.parse(retained.payload)).toMatchObject({
    state: "waiting-human",
    holdReason: expect.stringContaining("task-candidate:probe:retained-live-behavior"),
  })
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=?",
          )
          .get(result.operationID)!.count,
    ),
  ).toBe(1)
  expect(f.store.attempts(f.planID)).toHaveLength(1)
})

test("a retained probe is generation-bound, owner-recorded, resource-isolated, and gates acceptance", async () => {
  const f = await failedFixture()
  const probes = new ProbeRepository(f.store.repository)
  const definitionResult = probes.define(
    {
      requestID: "required-retained-probe-definition-pass",
      target: { kind: "task", taskID: f.task.id },
      scenarios: [
        {
          id: "retained-live-behavior-pass",
          summary: "Exercise the exact retained candidate",
          acceptanceIDs: ["task-candidate"],
          procedure: { recordID: "runbook:retained-probe-pass", revision: "1" },
        },
      ],
      notApplicable: [],
    },
    { sessionID: "owner", agent: "architect" },
  )
  if (definitionResult.status === "conflict")
    throw new Error("Probe definition unexpectedly conflicted")
  const requested = (await f.runtime.command(
    {
      requestID: "verify-retained-with-live-probe",
      planID: f.planID,
      expectedVersion: f.plan.version,
      action: "verify-retained",
      projectID: "project",
      planRevision: f.plan.revision,
      taskID: f.task.id,
      taskRevision: f.task.revision,
      attemptID: f.attempt.id,
      artifact: f.artifact,
      reason: "Run ordinary isolated checks and preserve the required live behavior probe",
    },
    "owner",
  )) as { operationID: string }
  const operationRow = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(requested.operationID),
  )!
  const operation = RetainedVerificationSchema.parse(JSON.parse(operationRow.payload))
  const basis = retainedVerificationProbeBasis(operation, "task")
  const probeInput = {
    requestID: "retained-live-probe-run",
    definitionID: definitionResult.definition.definitionID,
    definitionRevision: definitionResult.definition.revision,
    scenarioID: "retained-live-behavior-pass",
    attemptID: f.attempt.id,
    ...basis,
    capabilities: ["isolated-filesystem-fixture"],
    setupReferences: ["runbook:retained-probe-pass#setup"],
    fixtureReferences: ["owned-resource:retained-probe-fixture"],
    actions: [
      {
        kind: "navigate" as const,
        summary: "Exercise the retained candidate in its owned context",
      },
    ],
    observations: [
      { source: "tool-observation" as const, fact: "The exact retained behavior was observed" },
    ],
    evidenceReferences: [{ kind: "interaction" as const, reference: "trace:retained-probe-pass" }],
    timing: { startedAt: 100, finishedAt: null, elapsedMs: null },
    usage: { tokens: 0, toolCalls: 1, costUsd: null },
    cleanupState: "pending" as const,
  }
  const architect = { sessionID: "owner", agent: "architect" }
  expect(() =>
    probes.startRun(
      {
        ...probeInput,
        requestID: "stale-retained-live-probe",
        inputs: { ...basis.inputs, revision: "stale" },
      },
      architect,
    ),
  ).toThrow("candidate, inputs or environment are stale")
  expect(() =>
    probes.startRun(
      { ...probeInput, requestID: "foreign-retained-live-probe" },
      { sessionID: "foreign", agent: "architect" },
    ),
  ).toThrow("current Architect owner")
  expect(probes.runsForAttempt(f.attempt.id)).toHaveLength(0)
  const started = probes.startRun(probeInput, architect)
  if (started.status === "conflict") throw new Error(started.message)
  expect(started.run).toMatchObject({
    sessionID: f.attempt.session_id,
    producer: architect,
  })

  const fixtureRoot = mkdtempSync(join(tmpdir(), "lazers-retained-live-probe-resource-"))
  cleanups.push(() => rmSync(fixtureRoot, { recursive: true, force: true }))
  const lifecycle = filesystemProbeLifecycle(
    new ResourceRepository(f.store.repository),
    probes,
    fixtureRoot,
  )
  const executed = await lifecycle.withOwnedResources(
    {
      runID: started.run.runID,
      actor: architect,
      resources: [
        {
          requestID: "retained-probe-fixture-resource",
          generation: 1,
          name: "behavior-fixture",
          contents: "candidate-owned fixture",
        },
      ],
    },
    (fixtures) => {
      expect(existsSync(fixtures[0]!.path)).toBe(true)
      return { verdict: "passed", value: "behavior observed" }
    },
  )
  expect(executed.run).toMatchObject({
    lifecycle: "completed",
    verdict: "passed",
    cleanupState: "complete",
  })
  for (let i = 0; i < 4 && f.store.plan(f.planID)?.state !== "accepted"; i++) await f.runtime.tick()
  expect(f.store.plan(f.planID)?.state).toBe("accepted")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.prompts).toHaveLength(1)
})

test("owner reassignment and a newer generation reject late probe and human evidence", async () => {
  const f = await failedFixture({ humanTaskEvidence: true })
  const probes = new ProbeRepository(f.store.repository)
  const definitionResult = probes.define(
    {
      requestID: "retained-generation-probe-definition",
      target: { kind: "task", taskID: f.task.id },
      scenarios: [
        {
          id: "retained-generation-scenario",
          summary: "Observe the exact candidate",
          acceptanceIDs: ["task-candidate"],
          procedure: { recordID: "runbook:retained-generation", revision: "1" },
        },
      ],
      notApplicable: [],
    },
    { sessionID: "owner", agent: "architect" },
  )
  if (definitionResult.status === "conflict")
    throw new Error("Probe definition unexpectedly conflicted")
  const first = (await f.runtime.command(
    {
      requestID: "retained-generation-one",
      planID: f.planID,
      expectedVersion: f.plan.version,
      action: "verify-retained",
      projectID: "project",
      planRevision: f.plan.revision,
      taskID: f.task.id,
      taskRevision: f.task.revision,
      attemptID: f.attempt.id,
      artifact: f.artifact,
      reason: "Start an owner-bound retained evidence generation",
    },
    "owner",
  )) as { operationID: string; generation: number }
  expect(first.generation).toBe(1)
  const firstRow = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(first.operationID),
  )!
  const firstOperation = RetainedVerificationSchema.parse(JSON.parse(firstRow.payload))
  expect(firstOperation.state).toBe("waiting-human")
  const firstBasis = retainedVerificationProbeBasis(firstOperation, "task")
  const firstProbeInput = {
    requestID: "retained-generation-one-probe",
    definitionID: definitionResult.definition.definitionID,
    definitionRevision: definitionResult.definition.revision,
    scenarioID: "retained-generation-scenario",
    attemptID: f.attempt.id,
    ...firstBasis,
    capabilities: ["candidate-observation"],
    setupReferences: [],
    fixtureReferences: [],
    actions: [{ kind: "inspect" as const, summary: "Observe the retained candidate" }],
    observations: [
      { source: "tool-observation" as const, fact: "The candidate was opened for inspection" },
    ],
    evidenceReferences: [
      { kind: "interaction" as const, reference: "trace:retained-generation-one" },
    ],
    timing: { startedAt: 100, finishedAt: null, elapsedMs: null },
    usage: { tokens: 0, toolCalls: 1, costUsd: null },
    cleanupState: "pending" as const,
  }
  const firstProbe = probes.startRun(firstProbeInput, { sessionID: "owner", agent: "architect" })
  if (firstProbe.status === "conflict") throw new Error(firstProbe.message)
  await f.runtime.command(
    {
      requestID: "old-generation-human-evidence",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "human-evidence",
      taskID: f.task.id,
      assertionID: "task-candidate",
      artifact: f.artifact,
      retainedVerificationID: first.operationID,
      reason: "The original Architect observed the exact retained candidate",
    },
    "owner",
  )

  await f.runtime.command(
    {
      requestID: "reassign-retained-generation-owner",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "reassign",
      targetSessionID: "owner2",
      reason: "Transfer the plan owner while preserving the active evidence generation",
    },
    "owner",
  )
  await f.runtime.tick()
  const heldRow = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(first.operationID),
  )!
  expect(JSON.parse(heldRow.payload)).toMatchObject({ state: "held", generation: 1 })
  expect(() =>
    probes.updateRun(
      {
        requestID: "late-probe-generation-one-result",
        runID: firstProbe.run.runID,
        expectedVersion: 1,
        lifecycle: "completed",
        verdict: "passed",
        actions: firstProbe.run.actions,
        observations: firstProbe.run.observations,
        evidenceReferences: firstProbe.run.evidenceReferences,
        timing: { startedAt: 100, finishedAt: 110, elapsedMs: 10 },
        usage: firstProbe.run.usage,
        cleanupState: "complete",
      },
      { sessionID: "owner", agent: "architect" },
    ),
  ).toThrow("current owned verification generation")
  expect(
    probes.eligibility(firstProbe.run.runID, {
      ...firstBasis,
      procedure: definitionResult.definition.scenarios[0]!.procedure,
    }).eligible,
  ).toBe(false)
  await expect(
    f.runtime.command(
      {
        requestID: "late-human-generation-one-result",
        planID: f.planID,
        expectedVersion: f.store.plan(f.planID)!.version,
        action: "human-evidence",
        taskID: f.task.id,
        assertionID: "task-candidate",
        artifact: f.artifact,
        retainedVerificationID: first.operationID,
        reason: "Attempt to apply the prior owner decision after reassignment",
      },
      "owner2",
    ),
  ).rejects.toThrow("current retained verification generation")

  await f.runtime.command(
    {
      requestID: "cancel-held-old-retained-generation",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "cancel-retained-verification",
      retainedVerificationID: first.operationID,
      reason: "Close the prior owner generation before opening a new one",
    },
    "owner2",
  )
  const second = (await f.runtime.command(
    {
      requestID: "retained-generation-two",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "verify-retained",
      projectID: "project",
      planRevision: f.store.plan(f.planID)!.revision,
      taskID: f.task.id,
      taskRevision: f.task.revision,
      attemptID: f.attempt.id,
      artifact: f.artifact,
      reason: "Open a fresh retained evidence generation under the new current owner",
    },
    "owner2",
  )) as { operationID: string; generation: number }
  expect(second.generation).toBe(2)
  expect(second.operationID).not.toBe(first.operationID)
  await expect(
    f.runtime.command(
      {
        requestID: "late-human-after-new-generation",
        planID: f.planID,
        expectedVersion: f.store.plan(f.planID)!.version,
        action: "human-evidence",
        taskID: f.task.id,
        assertionID: "task-candidate",
        artifact: f.artifact,
        retainedVerificationID: first.operationID,
        reason: "An old generation cannot supply the new generation's human evidence",
      },
      "owner2",
    ),
  ).rejects.toThrow("current retained verification generation")
  expect(() =>
    probes.startRun(
      { ...firstProbeInput, requestID: "late-probe-after-new-generation" },
      { sessionID: "owner", agent: "architect" },
    ),
  ).toThrow("current owned verification generation")
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.prompts).toHaveLength(1)
})

test("failed retained-checkout cleanup does not revoke a product pass", async () => {
  const cleanupFixture = fixture({ failRetainedCleanup: true })
  await cleanupFixture.runtime.command(
    {
      requestID: "run-retained-cleanup-fixture",
      planID: cleanupFixture.planID,
      expectedVersion: 1,
      action: "run",
    },
    "owner",
  )
  for (let i = 0; i < 5; i++) await cleanupFixture.runtime.tick()
  const plan = cleanupFixture.store.plan(cleanupFixture.planID)!
  const attempt = cleanupFixture.store.attempts(cleanupFixture.planID).at(-1)!
  if (!attempt.artifact) throw new Error("Fixture attempt did not retain an artifact")
  const result = (await cleanupFixture.runtime.command(
    {
      requestID: "verify-retained-cleanup-failure",
      planID: cleanupFixture.planID,
      expectedVersion: plan.version,
      action: "verify-retained",
      projectID: "project",
      planRevision: plan.revision,
      taskID: cleanupFixture.task.id,
      taskRevision: cleanupFixture.task.revision,
      attemptID: attempt.id,
      artifact: attempt.artifact,
      reason: "Preserve a valid pass even when the isolated checkout cannot be retired",
    },
    "owner",
  )) as { operationID: string }
  const retained = cleanupFixture.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(result.operationID),
  )!
  expect(JSON.parse(retained.payload)).toMatchObject({ state: "accepted", cleanupState: "failed" })
  expect(cleanupFixture.store.plan(cleanupFixture.planID)?.state).toBe("accepted")
  expect(cleanupFixture.store.nodes(cleanupFixture.planID)[0]?.state).toBe("accepted")
})

test("cancellation and database reopen cannot accept a late retained-check result", async () => {
  const delayedCheck = "bun test src/models"
  // The immutable task proposal holds the check text, so use a dedicated fixture plan
  // whose retained check is delayed only when the private runtime database is present.
  const delayed = fixture({ taskCheckCommand: delayedCheck })
  await delayed.runtime.command(
    {
      requestID: "run-retained-cancellation-fixture",
      planID: delayed.planID,
      expectedVersion: 1,
      action: "run",
    },
    "owner",
  )
  for (let i = 0; i < 5; i++) await delayed.runtime.tick()
  const plan = delayed.store.plan(delayed.planID)!
  const attempt = delayed.store.attempts(delayed.planID).at(-1)!
  if (!attempt.artifact) throw new Error("Fixture attempt did not retain an artifact")
  const command = {
    requestID: "verify-retained-cancel-late-result",
    planID: delayed.planID,
    expectedVersion: plan.version,
    action: "verify-retained" as const,
    projectID: "project",
    planRevision: plan.revision,
    taskID: delayed.task.id,
    taskRevision: delayed.task.revision,
    attemptID: attempt.id,
    artifact: attempt.artifact,
    reason: "Cancel while the retained check is still executing",
  }
  const verifying = delayed.runtime.command(command, "owner")
  let operation: { id: string } | undefined
  for (let i = 0; i < 500 && !operation; i++) {
    operation = delayed.store.atomic(
      (db) =>
        db
          .query<{ id: string }, []>("SELECT id FROM runner_retained_verifications LIMIT 1")
          .get() ?? undefined,
    )
    if (!operation) await Bun.sleep(10)
  }
  expect(operation).toBeDefined()
  let contextPath: string | undefined
  for (let i = 0; i < 500; i++) {
    const check = delayed.store.atomic((db) =>
      db
        .query<{ context_path: string }, [string]>(
          "SELECT context_path FROM runner_retained_verification_checks WHERE operation_id=? AND state='intended'",
        )
        .get(operation!.id),
    )
    if (check) {
      contextPath = check.context_path
      if (existsSync(join(contextPath, "home", "started"))) break
    }
    await Bun.sleep(10)
  }
  expect(contextPath).toBeDefined()
  expect(existsSync(join(contextPath!, "home", "started"))).toBe(true)
  await delayed.runtime.command(
    {
      requestID: "cancel-retained-during-check",
      planID: delayed.planID,
      expectedVersion: plan.version,
      action: "cancel-retained-verification",
      retainedVerificationID: operation!.id,
      reason: "Stop the isolated check and preserve its uncertain outcome",
    },
    "owner",
  )
  await verifying
  const cancelled = delayed.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(operation!.id),
  )!
  expect(JSON.parse(cancelled.payload).state).toBe("cancelled")
  expect(
    delayed.store.atomic((db) =>
      db
        .query<{ state: string }, [string]>(
          "SELECT state FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
        )
        .get(operation!.id),
    ),
  ).toMatchObject({ state: "uncertain" })
  expect(delayed.store.plan(delayed.planID)?.state).toBe("blocked")
  expect(delayed.store.attempts(delayed.planID)).toHaveLength(1)
  expect(delayed.prompts).toHaveLength(1)

  await delayed.runtime.stop()
  delayed.store.repository.close()
  const reopenedRepository = new TaskRepository(join(delayed.state, "tasks.sqlite"), delayed.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopenedRuntime = new TaskRuntime(reopenedStore, delayed.host, "project")
  await reopenedRuntime.tick()
  expect(
    reopenedStore.atomic((db) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_retained_verifications WHERE id=?",
        )
        .get(operation!.id),
    ),
  ).toMatchObject({ payload: expect.stringContaining('"state":"cancelled"') })
  expect(reopenedStore.attempts(delayed.planID)).toHaveLength(1)
  expect(delayed.prompts).toHaveLength(1)
  await reopenedRuntime.stop()
  reopenedRepository.close()
})

test("a slow candidate dependency setup leaves unrelated plan RPCs responsive", async () => {
  const setupStarted = deferred()
  const releaseSetup = deferred()
  let installCalls = 0
  let released = false
  const installer: RetainedDependencyInstaller = async ({ candidateWorkspace, signal }) => {
    installCalls++
    if (installCalls === 1) {
      setupStarted.resolve()
      await releaseSetup.promise
    }
    if (signal.aborted) throw new Error("fixture setup cancelled")
    writeInjectedPrivatePackage(candidateWorkspace)
  }
  const f = await failedFixture({
    taskCheckCommand: "bun test src/runner/retained-check.test.ts",
    combinedCheckCommand: "bun test src/runner/retained-check.test.ts",
    retainedDependencyInstaller: installer,
  })
  const verification = f.runtime.command(
    retainedVerifyCommand(f, "verify-retained-during-slow-setup"),
    "owner",
  )
  try {
    await setupStarted.promise
    const audit = f.runtime.command(
      {
        requestID: "audit-during-slow-retained-install",
        planID: f.planID,
        expectedVersion: f.store.plan(f.planID)!.version,
        action: "audit",
      },
      "owner",
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    let responsive: boolean
    try {
      responsive = await Promise.race([
        audit.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2_000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    expect(responsive).toBe(true)
    expect(released).toBe(false)
    released = true
    releaseSetup.resolve()
    const result = (await verification) as { operationID: string }
    expect(installCalls).toBe(2)
    const operation = f.store.atomic((db) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_retained_verifications WHERE id=?",
        )
        .get(result.operationID),
    )!
    expect(JSON.parse(operation.payload)).toMatchObject({ state: "accepted" })
  } finally {
    releaseSetup.resolve()
    await verification.catch(() => undefined)
  }
})

test("cancellation observes a real installer process group before removing partial setup", async () => {
  const setupStarted = deferred()
  const state = mkdtempSync(join(tmpdir(), "lazers-retained-installer-tree-"))
  const descendantPIDPath = join(state, "descendant.pid")
  const descendantScript =
    `trap '' TERM; printf '%s' "$$" > ${shellQuote(descendantPIDPath)}; ` +
    "while :; do /bin/sleep 1; done"
  const storeRef: { current?: RunnerStore } = {}
  let processTreeStoppedBeforeCleanup = false
  let setupStillPresentWhenInstallerSettled = false
  let descendantPID: number | undefined
  const installer: RetainedDependencyInstaller = async ({
    candidateWorkspace,
    environment,
    signal,
  }) => {
    setupStarted.resolve()
    try {
      await runRetainedSetupProcess({
        command: ["/bin/sh", "-c", `/bin/sh -c ${shellQuote(descendantScript)} & wait`],
        candidateWorkspace,
        environment,
        signal,
        timeoutMs: 60_000,
        failedMessage: "fixture installer failed",
      })
    } catch (error) {
      if (existsSync(descendantPIDPath)) {
        descendantPID = Number(readFileSync(descendantPIDPath, "utf8"))
        processTreeStoppedBeforeCleanup = !processIsAlive(descendantPID)
      }
      const setupRoot = storeRef.current?.atomic((db) =>
        db
          .query<{ canonical_path: string }, []>(
            "SELECT canonical_path FROM runner_retained_verification_resources WHERE resource_name='setup-root'",
          )
          .get(),
      )
      setupStillPresentWhenInstallerSettled = Boolean(
        setupRoot && existsSync(setupRoot.canonical_path),
      )
      throw error
    }
  }
  const f = await failedFixture({
    taskCheckCommand: "bun test src/runner/retained-check.test.ts",
    combinedCheckCommand: "bun test src/runner/retained-check.test.ts",
    retainedDependencyInstaller: installer,
  })
  storeRef.current = f.store
  cleanups.push(() => rmSync(state, { recursive: true, force: true }))
  const verification = f.runtime.command(
    retainedVerifyCommand(f, "verify-retained-cancel-during-setup"),
    "owner",
  )
  await setupStarted.promise
  for (let i = 0; i < 500 && !existsSync(descendantPIDPath); i++) await Bun.sleep(10)
  expect(existsSync(descendantPIDPath)).toBe(true)
  const runningDescendantPID = Number(readFileSync(descendantPIDPath, "utf8"))
  expect(processIsAlive(runningDescendantPID)).toBe(true)
  const operation = f.store.atomic((db) =>
    db
      .query<{ id: string; payload: string }, []>(
        "SELECT id,payload FROM runner_retained_verifications LIMIT 1",
      )
      .get(),
  )!
  const setupRows = f.store.atomic((db) =>
    db
      .query<
        {
          resource_name: string
          canonical_path: string
          state: string
          device: number
          inode: number
        },
        [string]
      >(
        "SELECT resource_name,canonical_path,state,device,inode FROM runner_retained_verification_resources WHERE operation_id=?",
      )
      .all(operation.id),
  )
  expect(setupRows.some((row) => row.resource_name === "setup-root")).toBe(true)
  expect(setupRows.length).toBeGreaterThan(1)
  expect(setupRows.every((row) => row.state === "creating")).toBe(true)
  const setupRoot = setupRows.find((row) => row.resource_name === "setup-root")!
  const candidateWorkspace = (JSON.parse(operation.payload) as { taskWorkspace: string })
    .taskWorkspace

  await f.runtime.command(
    {
      requestID: "cancel-retained-dependency-setup",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "cancel-retained-verification",
      retainedVerificationID: operation.id,
      reason: "Cancel the isolated dependency setup before any check launches",
    },
    "owner",
  )
  await verification

  const cancelled = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(operation.id),
  )!
  expect(JSON.parse(cancelled.payload)).toMatchObject({ state: "cancelled" })
  expect(descendantPID).toBe(runningDescendantPID)
  expect(processTreeStoppedBeforeCleanup).toBe(true)
  expect(setupStillPresentWhenInstallerSettled).toBe(true)
  expect(processIsAlive(runningDescendantPID)).toBe(false)
  expect(existsSync(setupRoot.canonical_path)).toBe(false)
  expect(existsSync(join(candidateWorkspace, "node_modules"))).toBe(false)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=?",
          )
          .get(operation.id)!.count,
    ),
  ).toBe(0)
  expect(
    f.store.atomic((db) =>
      db
        .query<{ state: string }, [string]>(
          "SELECT state FROM runner_retained_verification_resources WHERE operation_id=?",
        )
        .all(operation.id)
        .every((row) => row.state === "removed"),
    ),
  ).toBe(true)
})

test.each([false, true])(
  "reopen preserves a surviving installer after cancellation=%s",
  async (cancelBeforeRestart) => {
    const f = await failedFixture({
      retainedDependencyInstaller: async () => {},
      requestTick: async () => {},
    })
    await f.runtime.command(retainedVerifyCommand(f, "verify-retained-crash-during-setup"), "owner")
    const operation = f.store.atomic((db) =>
      db
        .query<{ payload: string }, []>("SELECT payload FROM runner_retained_verifications LIMIT 1")
        .get(),
    )
    if (!operation) throw new Error("Retained verification operation was not reserved")
    const retained = RetainedVerificationSchema.parse(JSON.parse(operation.payload))
    const workspace = join(
      realpathSync(f.state),
      "runner",
      "worktrees",
      `retained-${retained.id}-task`,
    )
    await f.host.worktree({ directory: workspace, base: retained.artifact })
    const checking = RetainedVerificationSchema.parse({
      ...retained,
      state: "task-checks",
      taskWorkspace: workspace,
      taskWorkspaceState: "owned",
      updatedAt: Date.now(),
    })
    f.store.atomic((db) => saveRetainedVerification(db, checking))

    const rootDirectory = join(f.state, "runner", "retained-verification-resources")
    mkdirSync(rootDirectory, { recursive: true, mode: 0o700 })
    const check = f.task.proposal.verification[0]!
    const procedure = retainedProcedurePlan(check.command)
    if (procedure.status !== "supported") throw new Error(procedure.reason)
    const register = (
      resources: Array<{ name: string; realPath: string; device: number; inode: number }>,
    ) =>
      f.store.atomic((db) =>
        registerRetainedVerificationResources(db, f.root, {
          operationID: retained.id,
          generation: retained.generation,
          phase: "task",
          checkID: check.id,
          resources,
          state: "creating",
          now: Date.now(),
        }),
      )
    const updateIdentity = (
      resourceName: string,
      realPath: string,
      device: number,
      inode: number,
    ) => {
      const updated = f.store.atomic((db) =>
        updateRetainedVerificationResourceIdentity(db, {
          operationID: retained.id,
          phase: "task",
          checkID: check.id,
          resourceName,
          realPath,
          device,
          inode,
          now: Date.now(),
        }),
      )
      if (!updated) throw new Error(`Setup ownership reservation changed: ${resourceName}`)
    }
    await expect(
      createRetainedCheckContext({
        rootDirectory,
        operationID: retained.id,
        generation: retained.generation,
        phase: "task",
        checkID: check.id,
        originalWorkspace: retained.originalWorkspace,
        candidateWorkspace: workspace,
        taskDatabase: f.store.repository.path,
        projectDirectory: f.root,
        candidateArtifact: retained.artifact,
        priorResourcePaths: [],
        procedurePlan: procedure.plan,
        dependencyInstaller: async () => {
          throw new Error("simulated process loss during dependency setup")
        },
        onSetupPathReserved: (path) =>
          register([{ name: "setup-root", realPath: path, device: -1, inode: -1 }]),
        onSetupPathCreated: (resource) =>
          updateIdentity("setup-root", resource.realPath, resource.device, resource.inode),
        onResourcesCreated: register,
        onDependencyLinkReserved: (link) =>
          register([{ name: "dependency-link", realPath: link.path, device: -1, inode: -1 }]),
        onDependencyLink: (link) =>
          updateIdentity("dependency-link", link.path, link.device, link.inode),
        onTemporaryDirectoryLinkReserved: (link) =>
          register([{ name: "tmp-alias", realPath: link.path, device: -1, inode: -1 }]),
        onTemporaryDirectoryLink: (link) =>
          updateIdentity("tmp-alias", link.path, link.device, link.inode),
      }),
    ).rejects.toThrow("simulated process loss during dependency setup")

    const setupRows = f.store.atomic((db) =>
      db
        .query<{ resource_name: string; canonical_path: string; state: string }, [string, string]>(
          `SELECT resource_name,canonical_path,state FROM runner_retained_verification_resources
         WHERE operation_id=? AND phase='task' AND check_id=?`,
        )
        .all(retained.id, check.id),
    )
    expect(setupRows.map((row) => row.resource_name)).toContain("setup-root")
    expect(setupRows.map((row) => row.resource_name)).toContain("dependency-link")
    expect(setupRows.every((row) => row.state === "creating")).toBe(true)
    const setupRoot = setupRows.find((row) => row.resource_name === "setup-root")!
    expect(existsSync(setupRoot.canonical_path)).toBe(true)
    expect(existsSync(join(workspace, "node_modules"))).toBe(true)

    const heartbeatPath = join(setupRoot.canonical_path, "installer-heartbeat")
    const installer = Bun.spawn(
      [
        process.execPath,
        "-e",
        "import {openSync,writeSync} from 'node:fs'; const fd=openSync(process.argv.at(-1),'a');writeSync(fd,'started\\n');setInterval(()=>writeSync(fd,'alive\\n'),20)",
        heartbeatPath,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    )
    try {
      for (let i = 0; i < 200 && !existsSync(heartbeatPath); i++) await Bun.sleep(10)
      expect(existsSync(heartbeatPath)).toBe(true)
      expect(() => process.kill(installer.pid, 0)).not.toThrow()
      if (cancelBeforeRestart) {
        const cancel = {
          requestID: "cancel-before-reopen-with-live-installer",
          planID: f.planID,
          expectedVersion: f.store.plan(f.planID)!.version,
          action: "cancel-retained-verification" as const,
          retainedVerificationID: retained.id,
          reason: "Cancel before runtime restart with installer termination unknown",
        }
        expect(await f.runtime.command(cancel, "owner")).toMatchObject({
          status: "retained-verification-cancelled",
        })
        expect(await f.runtime.command(cancel, "owner")).toMatchObject({
          status: "retained-verification-cancelled",
        })
      }
      await f.runtime.stop()
      f.store.atomic((db) =>
        db.query("UPDATE runner_leases SET expires_at=0 WHERE project_directory=?").run(f.root),
      )
      f.store.repository.close()
      const reopenedRepository = new TaskRepository(join(f.state, "tasks.sqlite"), f.root)
      cleanups.push(() => reopenedRepository.close())
      const reopenedStore = new RunnerStore(reopenedRepository)
      const reopenedRuntime = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
        requestTick: async () => {},
      })
      await reopenedRuntime.tick()

      const reconciled = reopenedStore.atomic((db) =>
        db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM runner_retained_verifications WHERE id=?",
          )
          .get(retained.id),
      )!
      expect(JSON.parse(reconciled.payload)).toMatchObject({
        state: cancelBeforeRestart ? "cancelled" : "held",
        holdReason: expect.stringContaining(
          cancelBeforeRestart
            ? "Cancel before runtime restart"
            : "Interrupted retained verification setup",
        ),
      })
      expect(existsSync(setupRoot.canonical_path)).toBe(true)
      expect(existsSync(join(workspace, "node_modules"))).toBe(true)
      expect(
        reopenedStore.atomic((db) =>
          db
            .query<{ state: string }, [string, string]>(
              "SELECT state FROM runner_retained_verification_resources WHERE operation_id=? AND phase='task' AND check_id=?",
            )
            .all(retained.id, check.id)
            .every((row) => row.state === "uncertain"),
        ),
      ).toBe(true)
      expect(
        reopenedStore.atomic(
          (db) =>
            db
              .query<{ count: number }, [string]>(
                "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=?",
              )
              .get(retained.id)!.count,
        ),
      ).toBe(0)
      expect(reopenedStore.attempts(f.planID)).toHaveLength(1)
      expect(f.prompts).toHaveLength(1)
      await reopenedRuntime.stop()
      reopenedRepository.close()
    } finally {
      installer.kill("SIGKILL")
      await installer.exited
    }
  },
)

test("an injected dependency setup failure cleans registered partial resources before holding", async () => {
  const setupStarted = deferred()
  const releaseFailure = deferred()
  const installer: RetainedDependencyInstaller = async () => {
    setupStarted.resolve()
    await releaseFailure.promise
    throw new Error("injected dependency setup failure")
  }
  const f = await failedFixture({
    taskCheckCommand: "bun test src/runner/retained-check.test.ts",
    combinedCheckCommand: "bun test src/runner/retained-check.test.ts",
    retainedDependencyInstaller: installer,
  })
  const verification = f.runtime.command(
    retainedVerifyCommand(f, "verify-retained-injected-setup-failure"),
    "owner",
  )
  await setupStarted.promise
  const operation = f.store.atomic((db) =>
    db
      .query<{ id: string; payload: string }, []>(
        "SELECT id,payload FROM runner_retained_verifications LIMIT 1",
      )
      .get(),
  )!
  const setupRows = f.store.atomic((db) =>
    db
      .query<{ resource_name: string; canonical_path: string; state: string }, [string]>(
        "SELECT resource_name,canonical_path,state FROM runner_retained_verification_resources WHERE operation_id=?",
      )
      .all(operation.id),
  )
  expect(
    setupRows.some((row) => row.resource_name === "setup-root" && row.state === "creating"),
  ).toBe(true)
  expect(
    setupRows.some((row) => row.resource_name === "dependencies" && row.state === "creating"),
  ).toBe(true)
  const setupRoot = setupRows.find((row) => row.resource_name === "setup-root")!
  const candidateWorkspace = (JSON.parse(operation.payload) as { taskWorkspace: string })
    .taskWorkspace
  releaseFailure.resolve()
  await verification

  const held = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(operation.id),
  )!
  expect(JSON.parse(held.payload)).toMatchObject({
    state: "held",
    holdReason: expect.stringContaining("injected dependency setup failure"),
  })
  expect(existsSync(setupRoot.canonical_path)).toBe(false)
  expect(existsSync(join(candidateWorkspace, "node_modules"))).toBe(false)
  expect(
    f.store.atomic((db) =>
      db
        .query<{ state: string }, [string]>(
          "SELECT state FROM runner_retained_verification_resources WHERE operation_id=?",
        )
        .all(operation.id)
        .every((row) => row.state === "removed"),
    ),
  ).toBe(true)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=?",
          )
          .get(operation.id)!.count,
    ),
  ).toBe(0)
})
