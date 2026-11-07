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
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
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
  registerSourceGuard,
  sourceQuarantine,
  sourceReservationExcluded,
} from "./source-quarantine.ts"
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
import { registerRunnerTools } from "./tools.ts"

type RegisteredRunnerTool = Parameters<ToolEditor["add"]>[0]

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
    successorCount?: number
    failRetainedCheck?: boolean
    combinedHumanEvidence?: boolean
    candidateContentsCheck?: boolean
    projectBuild?: boolean
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
  if (options.projectBuild) {
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n")
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "retained-reverify-fixture",
        version: "1.0.0",
        scripts: { "build:fixture": "bun scripts/build-fixture.ts" },
      }) + "\n",
    )
    mkdirSync(join(root, "scripts"))
    writeFileSync(
      join(root, "scripts/build-fixture.ts"),
      'import {mkdirSync,writeFileSync} from "node:fs"; mkdirSync("dist",{recursive:true});writeFileSync("dist/built.txt","built before tests");console.log("project build completed");\n',
    )
  }
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
      `import { appendFileSync, existsSync, mkdirSync } from "node:fs"\n` +
      `import { dirname, join } from "node:path"\n` +
      `import { expect, test } from "bun:test"\n` +
      `test("authored project check writes only to the isolated profile and database", () => {\n` +
      `  if (existsSync(join(import.meta.dir, "FAIL_RETAINED_CHECK"))) throw new Error("fixture retained check failure")\n` +
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
  if (options.failRetainedCheck)
    writeFileSync(join(root, "src", "runner", "FAIL_RETAINED_CHECK"), "fail\n")
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
  if (options.candidateContentsCheck)
    writeFileSync(
      join(root, "src/runner/retained-check.test.ts"),
      'import {test,expect} from "bun:test"; import {readFileSync} from "node:fs";\n' +
        'test("committed candidate contents",()=>{const text=readFileSync("result.txt","utf8");expect(text).toContain("retained candidate");' +
        (options.projectBuild
          ? 'expect(readFileSync("dist/built.txt","utf8")).toBe("built before tests");'
          : "") +
        "console.log(text)});\n",
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
  const tasks = [task]
  for (let index = 0; index < (options.successorCount ?? 0); index++) {
    const checkID = `successor-${index + 1}-check`
    const successorProposal = validProposal()
    successorProposal.objective = `Complete retained-verification successor ${index + 1}`
    successorProposal.writeScope = [`result-${index + 2}.txt`]
    successorProposal.verification = [{ id: checkID, command: "true", timeoutMs: 10_000 }]
    successorProposal.acceptance = [
      {
        id: `successor-${index + 1}-candidate`,
        assertion: `Successor ${index + 1} passes its authored task check`,
        evidence: [{ kind: "verification", verificationID: checkID }],
      },
    ]
    successorProposal.limits.maxRepairAttempts = 0
    tasks.push(
      repository.insert({
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
        proposal: successorProposal,
      }),
    )
  }
  const plan = store.submit(
    {
      requestID: "retained-reverify-plan",
      objective: "Verify a committed result without replacing its worker",
      workspaceMode: "isolated",
      baseCommit: base,
      workerModel: model,
      nodes: tasks.map((candidate) => ({ taskID: candidate.id, revision: 1 })),
      dependencies: tasks.slice(1).map((successor, index) => ({
        prerequisite: tasks[index]!.id,
        successor: successor.id,
      })),
      integrationOrder: tasks.map((candidate) => candidate.id),
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
          evidence: [
            { kind: "verification", verificationID: "isolated-combined-check" },
            ...(options.combinedHumanEvidence
              ? [{ kind: "human" as const, decision: "Architect observes the combined candidate" }]
              : []),
          ],
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
      const attemptID = worker.metadata?.lazersAttemptID
      const taskIndex = store
        .attempts(plan.planID)
        .find((attempt) => attempt.id === attemptID)?.task_id
      const resultFile =
        tasks.findIndex((candidate) => candidate.id === taskIndex) <= 0
          ? "result.txt"
          : `result-${tasks.findIndex((candidate) => candidate.id === taskIndex) + 1}.txt`
      writeFileSync(
        join(input.directory, resultFile),
        `retained candidate ${taskIndex ?? "unknown"}\n`,
      )
      git(input.directory, ["add", resultFile])
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
    tasks,
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

async function registeredPlanCommand(runtime: TaskRuntime) {
  const tools = new Map<string, RegisteredRunnerTool>()
  const editor = {
    add: (tool: RegisteredRunnerTool) => tools.set(tool.name, tool),
  } as unknown as ToolEditor
  const permissionChecks: string[] = []
  const context = {
    permission: {
      assert: ({ action }: { action: string }) => {
        permissionChecks.push(action)
        return Effect.void
      },
    },
    tool: {
      transform: (transform: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          transform(editor)
          return { dispose: Effect.void }
        }),
    },
  } as unknown as Plugin.Context
  await Effect.runPromise(Effect.scoped(registerRunnerTools(context, runtime)))
  const tool = tools.get("lz-plan-command")!
  return {
    permissionChecks,
    execute: async (input: unknown) => {
      const result = await Effect.runPromise(
        tool.execute(input, {
          sessionID: "owner" as never,
          agent: Agent.ID.make("architect"),
          messageID: SessionMessage.ID.make("msg_test"),
          id: Tool.CallID.make("call_test"),
          progress: () => Effect.void,
        } as Parameters<RegisteredRunnerTool["execute"]>[1]),
      )
      return JSON.parse(String(result.content)) as Record<string, unknown>
    },
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

async function heldRepairFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture({
    taskCheckCommand: "bun test src/runner/retained-check.test.ts",
    combinedCheckCommand: "bun test src/runner/retained-check.test.ts",
    candidateContentsCheck: true,
    ...options,
  })
  const control = await registeredPlanCommand(f.runtime)
  await control.execute({
    requestID: "start-original",
    planID: f.planID,
    expectedVersion: 1,
    action: "run",
  })
  for (let i = 0; i < 5; i++) await f.runtime.tick()
  const original = f.store.attempts(f.planID)[0]!
  expect(original.state).toBe("accepted")
  const previousArtifact = original.artifact!
  f.host.prompt = async (input) => {
    f.prompts.push({ sessionID: input.sessionID, id: input.id })
    writeFileSync(join(input.directory, "result.txt"), "retained candidate\nrepair descendant\n")
    git(input.directory, ["add", "result.txt"])
    git(input.directory, ["commit", "-m", "same-worker repair descendant"])
    const worker = f.sessions.get(input.sessionID)!
    worker.messages.push({ id: input.id, text: input.text })
    worker.outcome = "succeeded"
    worker.turn = { inputID: input.id, state: "completed" }
    worker.background = {
      state: "unknown",
      source: "experimental.idle",
      reason: "current idle lineage missing",
    }
  }
  await control.execute({
    requestID: "repair-original",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "retained-repair",
    taskID: f.task.id,
    attemptID: original.id,
    artifact: previousArtifact,
    reason: "Repair the committed result in the original worker",
  })
  for (let i = 0; i < 5; i++) await f.runtime.tick()
  const attempt = f.store.attempts(f.planID)[0]!
  expect(attempt.state).toBe("running")
  expect(attempt.artifact).toBe(previousArtifact)
  expect(f.store.nodes(f.planID)[0]?.artifact).toBeNull()
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  const artifact = git(attempt.workspace, ["rev-parse", "HEAD"])
  expect(artifact).not.toBe(previousArtifact)
  return {
    ...f,
    control,
    attempt,
    artifact,
    previousArtifact,
    request: {
      requestID: "verify-repair-descendant",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "verify-retained",
      projectID: "project",
      planRevision: 1,
      taskID: f.task.id,
      taskRevision: 1,
      attemptID: attempt.id,
      artifact,
      reason: "Verify the actual repair without fabricating idle",
    },
  }
}

test("registered verification qualifies an actual same-worker repair descendant with missing idle", async () => {
  const f = await heldRepairFixture()
  const prompts = [...f.prompts]
  const before = { ...f.attempt }
  const requested = await f.control.execute(f.request)
  expect(await f.control.execute(f.request)).toEqual(requested)
  for (let i = 0; i < 6; i++) await f.runtime.tick()
  const after = f.store.attempts(f.planID)[0]!
  expect(after).toMatchObject({
    id: before.id,
    session_id: before.session_id,
    workspace: before.workspace,
    message_id: before.message_id,
    policy: before.policy,
    token_count: before.token_count,
    tool_count: before.tool_count,
    cost: before.cost,
    state: "accepted",
    artifact: f.artifact,
  })
  expect(f.prompts).toEqual(prompts)
  expect(f.created).toHaveLength(1)
  expect(f.store.nodes(f.planID)[0]?.artifact).toBe(f.artifact)
  expect(f.sessions.get(after.session_id)?.background?.state).toBe("unknown")
  const checks = f.store.atomic((db) =>
    db
      .query<{ artifact: string; receipt: string }, [string]>(
        "SELECT artifact,receipt FROM runner_retained_verification_checks WHERE operation_id=?",
      )
      .all(String(requested.operationID)),
  )
  expect(checks.length).toBeGreaterThan(0)
  expect(
    checks.every(
      (check) => check.artifact === f.artifact && check.receipt.includes("repair descendant"),
    ),
  ).toBe(true)
})

test("registered retained repair verification executes the exact authored build/test chain", async () => {
  const command = "bun run build:fixture && bun test src/runner/retained-check.test.ts"
  const f = await heldRepairFixture({
    projectBuild: true,
    taskCheckCommand: command,
    combinedCheckCommand: command,
  })
  const requested = await f.control.execute(f.request)
  for (let i = 0; i < 6; i++) await f.runtime.tick()
  expect(f.store.attempts(f.planID)[0]?.artifact).toBe(f.artifact)
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  await f.control.execute({
    requestID: "continue-combined-build-chain",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "reconcile",
    reason: "Continue combined checks after exact task candidate acceptance",
  })
  for (let i = 0; i < 6; i++) await f.runtime.tick()
  const rows = f.store.atomic((db) =>
    db
      .query<{ check_json: string; artifact: string; receipt: string }, [string]>(
        "SELECT check_json,artifact,receipt FROM runner_retained_verification_checks WHERE operation_id=?",
      )
      .all(String(requested.operationID)),
  )
  expect(rows).toHaveLength(2)
  for (const row of rows) {
    expect(JSON.parse(row.check_json).command).toBe(command)
    expect(row.artifact).toBe(f.artifact)
    expect(JSON.parse(row.receipt).exitCode).toBe(0)
    expect(row.receipt).toContain("project build completed")
    expect(row.receipt).toContain("repair descendant")
  }
  expect(f.prompts).toHaveLength(2)
  expect(f.created).toHaveLength(1)
})

test.each([
  "dirty",
  "moved-head",
  "non-descendant",
  "busy",
  "permission",
  "form",
  "input",
  "route",
  "repair",
  "conflict",
  "uncertain-effect",
  "outside-scope",
  "stale-revision",
  "wrong-task",
])(
  "repair descendant admission rejects %s without prompts or verification effects",
  async (kind) => {
    const f = await heldRepairFixture()
    const worker = f.sessions.get(f.attempt.session_id)!
    const prompts = [...f.prompts]
    if (kind === "dirty") writeFileSync(join(f.attempt.workspace, "untracked.txt"), "not committed")
    if (kind === "moved-head") {
      writeFileSync(join(f.attempt.workspace, "result.txt"), "retained candidate\nlater\n")
      git(f.attempt.workspace, ["commit", "-am", "later source"])
    }
    if (kind === "non-descendant") {
      git(f.attempt.workspace, ["checkout", "--detach", f.attempt.base_commit])
      f.request.artifact = f.attempt.base_commit
    }
    if (kind === "busy") worker.busy = true
    if (kind === "permission") worker.pendingPermissions = 1
    if (kind === "form") worker.pendingForms = 1
    if (kind === "input") worker.turn = { inputID: "foreign-input", state: "completed" }
    if (kind === "route") worker.model = { ...worker.model!, id: "foreign-model" }
    if (kind === "repair") {
      const prior = f.store.latestRetainedRepair<Record<string, unknown>>(f.planID, f.task.id)!
      f.store.record(f.planID, f.task.id, "RETAINED_REPAIR_REQUESTED", {
        ...prior,
        operationID: crypto.randomUUID(),
      })
    }
    if (kind === "conflict") await addCompetingAttempt(f, "none")
    if (kind === "uncertain-effect")
      f.store.atomic((db) =>
        db
          .query(
            "UPDATE runner_effects SET state='uncertain' WHERE attempt_id=? AND kind LIKE 'verify:%'",
          )
          .run(f.attempt.id),
      )
    if (kind === "outside-scope") {
      writeFileSync(join(f.attempt.workspace, "outside.txt"), "unrelated change")
      git(f.attempt.workspace, ["add", "outside.txt"])
      git(f.attempt.workspace, ["commit", "-m", "out of scope"])
      f.request.artifact = git(f.attempt.workspace, ["rev-parse", "HEAD"])
    }
    if (kind === "stale-revision") f.request.taskRevision = 2
    if (kind === "wrong-task") f.request.taskID = crypto.randomUUID()
    await expect(f.control.execute(f.request)).rejects.toThrow()
    expect(f.prompts).toEqual(prompts)
    expect(
      f.store.atomic(
        (db) =>
          db
            .query<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM runner_retained_verifications WHERE plan_id=?",
            )
            .get(f.planID)?.n,
      ),
    ).toBe(0)
    expect(f.store.attempts(f.planID)[0]?.artifact).toBe(f.previousArtifact)
  },
)

test.each(["disposition", "owner", "input"])(
  "repair descendant rejects %s during final native admission",
  async (kind) => {
    const f = await heldRepairFixture()
    const session = f.host.session
    let owners = 0
    f.host.session = async (id, options) => {
      const observed = await session(id, options)
      if (id === "owner" && ++owners === 2) {
        if (kind === "disposition")
          f.store.repository.recordDisposition(
            {
              taskID: f.task.id,
              requestID: "disposed-during-admission",
              disposition: "rejected",
              reason: "Task cancelled during native await",
              evidence: [{ kind: "human", reference: "fixture concurrent decision" }],
            },
            { sessionID: "owner", agent: "architect" },
          )
        if (kind === "owner") {
          f.store.updatePlanOwner(f.planID, "owner", "owner2")
          f.store.updatePlanOwner(f.planID, "owner2", "owner")
        }
        if (kind === "input") f.sessions.get(f.attempt.session_id)!.pendingInput = true
      }
      return observed
    }
    await expect(f.control.execute(f.request)).rejects.toThrow()
    expect(
      f.store.atomic(
        (db) =>
          db
            .query<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM runner_retained_verifications WHERE plan_id=?",
            )
            .get(f.planID)?.n,
      ),
    ).toBe(0)
    expect(f.prompts).toHaveLength(2)
  },
)

test.each(["archive", "role", "project", "competing-attempt"])(
  "repair admission rechecks %s after its final worker observations",
  async (kind) => {
    const f = await heldRepairFixture()
    const session = f.host.session
    let owners = 0
    let changed = false
    f.host.session = async (id, options) => {
      const observed = await session(id, options)
      if (id === "owner") owners++
      if (id === f.attempt.session_id && owners >= 2 && !changed) {
        changed = true
        const owner = f.sessions.get("owner")!
        if (kind === "archive") owner.archived = true
        if (kind === "role") owner.agent = "implementor"
        if (kind === "project") owner.projectID = "another-project"
        if (kind === "competing-attempt") await addCompetingAttempt(f, "none")
      }
      return observed
    }
    await expect(f.control.execute(f.request)).rejects.toThrow()
    expect(changed).toBe(true)
    expect(
      f.store.atomic(
        (db) =>
          db
            .query<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM runner_retained_verifications WHERE plan_id=?",
            )
            .get(f.planID)?.n,
      ),
    ).toBe(0)
    expect(f.store.attempts(f.planID)[0]?.artifact).toBe(f.previousArtifact)
    expect(f.prompts).toHaveLength(2)
  },
)

test.each(["archive", "role", "project"])(
  "retained acceptance rechecks native owner %s after asynchronous check setup",
  async (kind) => {
    const f = await heldRepairFixture({ requestTick: async () => {} })
    const requested = await f.control.execute(f.request)
    const worktree = f.host.worktree
    let changed = false
    f.host.worktree = async (input) => {
      const result = await worktree(input)
      const owner = f.sessions.get("owner")!
      if (kind === "archive") owner.archived = true
      if (kind === "role") owner.agent = "implementor"
      if (kind === "project") owner.projectID = "another-project"
      changed = true
      return result
    }
    for (let i = 0; i < 6; i++) await f.runtime.tick()
    expect(changed).toBe(true)
    expect(f.store.attempts(f.planID)[0]?.artifact).toBe(f.previousArtifact)
    expect(f.store.nodes(f.planID)[0]?.state).not.toBe("accepted")
    const operation = f.store.atomic((db) =>
      db
        .query<{ state: string }, [string]>(
          "SELECT state FROM runner_retained_verifications WHERE id=?",
        )
        .get(String(requested.operationID)),
    )
    expect(operation?.state).toBe("held")
    expect(f.prompts).toHaveLength(2)
  },
)

for (const phase of ["admission", "acceptance"] as const) {
  test.each(["input", "busy", "route"])(
    `repair ${phase} detects worker %s changes during the final owner lookup`,
    async (kind) => {
      const f = await heldRepairFixture({ requestTick: async () => {} })
      const session = f.host.session
      const worktree = f.host.worktree
      let owners = 0
      let checking = false
      let changed = false
      f.host.worktree = async (input) => {
        const result = await worktree(input)
        checking = true
        return result
      }
      f.host.session = async (id, options) => {
        const observed = await session(id, options)
        if (id === "owner") owners++
        if (id === "owner" && !changed && (phase === "admission" ? owners === 3 : checking)) {
          const worker = f.sessions.get(f.attempt.session_id)!
          if (kind === "input") worker.pendingInput = true
          if (kind === "busy") worker.busy = true
          if (kind === "route") worker.model = { ...worker.model!, id: "new-route" }
          changed = true
        }
        return observed
      }
      if (phase === "admission") await expect(f.control.execute(f.request)).rejects.toThrow()
      else {
        const requested = await f.control.execute(f.request)
        for (let i = 0; i < 6; i++) await f.runtime.tick()
        const operation = f.store.atomic((db) =>
          db
            .query<{ state: string }, [string]>(
              "SELECT state FROM runner_retained_verifications WHERE id=?",
            )
            .get(String(requested.operationID)),
        )
        expect(operation?.state).toBe("held")
      }
      expect(changed).toBe(true)
      expect(f.store.attempts(f.planID)[0]?.artifact).toBe(f.previousArtifact)
      expect(f.store.nodes(f.planID)[0]?.state).not.toBe("accepted")
      expect(f.prompts).toHaveLength(2)
    },
  )
}

test("admitted repair candidate survives reopen and cannot be retargeted by a later HEAD", async () => {
  const f = await heldRepairFixture()
  const admitted = await f.control.execute(f.request)
  await f.runtime.stop()
  f.store.repository.close()
  const repository = new TaskRepository(join(f.state, "tasks.sqlite"), f.root)
  const store = new RunnerStore(repository)
  const runtime = new TaskRuntime(store, f.host, "project")
  try {
    expect(await runtime.command(f.request, "owner")).toEqual(admitted)
    writeFileSync(
      join(f.attempt.workspace, "result.txt"),
      "retained candidate\nlater unverified head\n",
    )
    git(f.attempt.workspace, ["commit", "-am", "later unverified source"])
    for (let i = 0; i < 6; i++) await runtime.tick()
    expect(store.attempts(f.planID)[0]?.artifact).toBe(f.artifact)
    const operations = store.atomic((db) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_retained_verifications WHERE plan_id=?",
        )
        .all(f.planID),
    )
    expect(operations).toHaveLength(1)
    expect(JSON.parse(operations[0]!.payload)).toMatchObject({
      artifact: f.artifact,
      repair: { previousArtifact: f.previousArtifact },
    })
    expect(f.prompts).toHaveLength(2)
  } finally {
    await runtime.stop()
    repository.close()
  }
})

async function addCompetingAttempt(
  f: Awaited<ReturnType<typeof fixture>>,
  quarantine: "sealed" | "none" | "held" | "misbound" | "unguarded" = "sealed",
) {
  const task = f.store.repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory: f.root,
      workspaceDirectory: f.root,
      sessionID: "owner",
      startingRevision: { kind: "git", commit: git(f.root, ["rev-parse", "HEAD"]) },
    },
    proposal: {
      ...validProposal(),
      objective: "Preserve a same-scope quarantined task attempt",
      writeScope: ["result.txt"],
    },
  })
  const sourcePlan = JSON.parse(f.store.plan(f.planID)!.body) as Record<string, unknown>
  const plan = f.store.submit(
    {
      ...sourcePlan,
      requestID: `competing-active-attempt-${task.id}`,
      objective: "Keep the older same-scope attempt and its source quarantine intact",
      nodes: [{ taskID: task.id, revision: task.revision }],
      dependencies: [],
      integrationOrder: [task.id],
    },
    "owner",
  )
  const workspace = join(f.state, `competing-${task.id}`)
  const baseCommit = git(f.root, ["rev-parse", "HEAD"])
  git(f.root, ["worktree", "add", "--detach", workspace, baseCommit])
  const attemptID = crypto.randomUUID()
  const sessionID = `worker-${task.id}`
  const messageID = `message-${task.id}`
  const startedAt = Date.now()
  f.store.atomic((db) => {
    db.query(
      `INSERT INTO runner_attempts(
         id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,
         policy,state,started_at,token_count,tool_count,retry_count,cost
       ) VALUES(?,?,?,?,?,?,?,?,NULL,?,'running',?,NULL,0,0,NULL)`,
    ).run(
      attemptID,
      plan.planID,
      task.id,
      1,
      sessionID,
      messageID,
      workspace,
      baseCommit,
      f.store.attempts(f.planID)[0]!.policy,
      startedAt,
    )
    db.query("UPDATE runner_nodes SET state='running' WHERE plan_id=? AND task_id=?").run(
      plan.planID,
      task.id,
    )
    db.query("UPDATE runner_plans SET state='cleanup-blocked',reason=? WHERE id=?").run(
      "Preserve the older unknown-background attempt and its source resources",
      plan.planID,
    )
    if (quarantine !== "none") {
      db.query(
        `INSERT INTO runner_source_quarantines(
           attempt_id,plan_id,session_id,assigned_message_id,requested_owner,workspace,
           request_id,reason,phase,hold_reason,review_input_json,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?, 'sealed',?,?,?,?)`,
      ).run(
        attemptID,
        plan.planID,
        sessionID,
        quarantine === "misbound" ? "wrong-original-message" : messageID,
        "owner",
        workspace,
        `quarantine-${task.id}`,
        "Retain the old writer and keep its source checkout guarded",
        quarantine === "held" ? "The source quarantine still has an unresolved hold" : null,
        JSON.stringify({ inputID: `review-${task.id}`, requestID: `quarantine-${task.id}` }),
        startedAt,
        startedAt,
      )
    }
  })
  if (quarantine !== "unguarded") cleanups.push(registerSourceGuard(f.store, workspace))
  const worker: HostSession = {
    id: sessionID,
    projectID: "project",
    directory: workspace,
    agent: "worker",
    archived: true,
    busy: false,
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    background: {
      state: "unknown",
      source: "experimental.idle",
      reason: "The older execution has no recoverable idle certificate",
    },
    tokens: null,
    tools: 0,
    cost: null,
    messages: [],
  }
  f.sessions.set(sessionID, worker)
  f.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_effects(id,plan_id,task_id,attempt_id,kind,state,payload,receipt,fence)
         VALUES(?,?,?,?,?,'completed',?,?,0)`,
      )
      .run(
        `preserved-${task.id}`,
        plan.planID,
        task.id,
        attemptID,
        "old-source-resource",
        JSON.stringify({ resource: "task-122-checkout" }),
        JSON.stringify({ completed: true }),
      ),
  )
  return {
    task,
    planID: plan.planID,
    attemptID,
    workspace,
    sessionID,
    quarantine: sourceQuarantine(f.store, attemptID),
    plan: f.store.plan(plan.planID),
    attempt: f.store.attempts(plan.planID)[0]!,
    effects: f.store.effects(plan.planID),
    worker,
  }
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

test("unrecorded running candidate qualifies under an idle hold and continues through reconciliation", async () => {
  const f = fixture({ successorCount: 2, requestTick: async () => {} })
  const observe = f.host.session
  f.host.session = async (id) => {
    const worker = await observe(id)
    if (worker && f.created[0] === id && worker.turn?.state === "completed")
      worker.background = {
        state: "unknown",
        source: "experimental.idle",
        reason: "Native execution success did not match the current experimental.idle execution",
      }
    return worker
  }
  await f.runtime.command(
    { requestID: "run-held-native-candidate", planID: f.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  for (let i = 0; i < 5; i++) await f.runtime.tick()
  const attempt = f.store.attempts(f.planID)[0]!
  expect(attempt.state).toBe("running")
  expect(attempt.artifact).toBeNull()
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  const artifact = git(attempt.workspace, ["rev-parse", "HEAD"])
  const old = await addCompetingAttempt(f)
  expect(old.attempt).toMatchObject({ state: "running", artifact: null })
  expect(old.worker.background?.state).toBe("unknown")
  expect(sourceReservationExcluded(f.store, old.attempt, { mode: "isolated" })).toBe(true)
  expect(sourceReservationExcluded(f.store, old.attempt, { mode: "shared" })).toBe(false)
  expect(
    sourceReservationExcluded(f.store, old.attempt, {
      mode: "isolated",
      workspace: old.workspace,
    }),
  ).toBe(false)
  const oldPromptCount = f.prompts.filter(
    (prompt) => prompt.sessionID === attempt.session_id,
  ).length
  const oldEffectHistory = old.effects
  const request = {
    requestID: "qualify-unrecorded-running-candidate",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "verify-retained" as const,
    projectID: "project",
    planRevision: 1,
    taskID: f.task.id,
    taskRevision: 1,
    attemptID: attempt.id,
    artifact,
    reason: "Qualify actual committed work despite missing old idle lineage",
  }
  const control = await registeredPlanCommand(f.runtime)
  const requested = (await control.execute(request)) as { operationID: string }
  expect(await control.execute(request)).toEqual(requested)
  expect(control.permissionChecks).toEqual(["lz-plan-command", "lz-plan-command"])
  for (let i = 0; i < 5 && f.store.nodes(f.planID)[0]?.state !== "accepted"; i++)
    await f.runtime.tick()
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(f.prompts.filter((p) => p.sessionID === attempt.session_id)).toHaveLength(oldPromptCount)
  const qualifiedAttempt = f.store.attempts(f.planID)[0]!
  expect(qualifiedAttempt.id).toBe(attempt.id)
  expect(qualifiedAttempt.state).toBe("accepted")
  expect(qualifiedAttempt.artifact).toBe(artifact)
  // Non-failure holds remain an explicit Architect decision, not an implicit bypass.
  expect(
    f.store
      .nodes(f.planID)
      .slice(1)
      .map((node) => node.state),
  ).toEqual(["queued", "queued"])
  expect(f.store.attempts(old.planID)).toEqual([old.attempt])
  expect(f.store.plan(old.planID)).toEqual(old.plan)
  expect(f.store.effects(old.planID)).toEqual(oldEffectHistory)
  expect(sourceQuarantine(f.store, old.attemptID)).toEqual(old.quarantine)
  expect(f.sessions.get(old.sessionID)).toEqual(old.worker)
  await f.runtime.command(
    {
      requestID: "reconcile-qualified-held-plan",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  for (let i = 0; i < 20 && f.store.nodes(f.planID).some((node) => node.state !== "accepted"); i++)
    await f.runtime.tick()
  expect(f.store.nodes(f.planID).map((node) => node.state)).toEqual([
    "accepted",
    "accepted",
    "accepted",
  ])
  expect(f.prompts.filter((p) => p.sessionID === attempt.session_id)).toHaveLength(oldPromptCount)
  const worker = await f.host.session(attempt.session_id)
  expect(worker?.background?.state).toBe("unknown")
  expect(f.store.attempts(old.planID)).toEqual([old.attempt])
  expect(f.store.plan(old.planID)).toEqual(old.plan)
  expect(f.store.effects(old.planID)).toEqual(oldEffectHistory)
  expect(sourceQuarantine(f.store, old.attemptID)).toEqual(old.quarantine)
  expect(f.sessions.get(old.sessionID)).toEqual(old.worker)
  expect(requested.operationID).toBeString()
}, 30_000)

test.each(["none", "held", "misbound", "unguarded"] as const)(
  "retained verification still blocks a same-scope %s live source reservation",
  async (quarantine) => {
    const f = await failedFixture()
    const old = await addCompetingAttempt(f, quarantine)
    expect(sourceReservationExcluded(f.store, old.attempt, { mode: "isolated" })).toBe(false)
    const checksBefore = f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM runner_retained_verification_checks",
          )
          .get()!.count,
    )
    await expect(
      f.runtime.command(retainedVerifyCommand(f, `reject-active-${quarantine}`), "owner"),
    ).rejects.toThrow("A conflicting active implementation attempt prevents retained verification")
    expect(
      f.store.atomic(
        (db) =>
          db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM runner_retained_verifications",
            )
            .get()!.count,
      ),
    ).toBe(0)
    expect(
      f.store.atomic(
        (db) =>
          db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM runner_retained_verification_checks",
            )
            .get()!.count,
      ),
    ).toBe(checksBefore)
    expect(f.store.attempts(old.planID)).toEqual([old.attempt])
    expect(f.store.plan(old.planID)).toEqual(old.plan)
    expect(sourceQuarantine(f.store, old.attemptID)).toEqual(old.quarantine)
    expect(f.store.effects(old.planID)).toEqual(old.effects)
  },
)

test(
  "owner verifies an exact failed-attempt candidate with zero replacement prompts",
  async () => {
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
    const control = await registeredPlanCommand(f.runtime)
    const result = (await control.execute(verifyCommand)) as {
      operationID: string
      generation: number
      status: string
    }

    expect(result.status).toBe("retained-verification-requested")
    expect(result.generation).toBe(1)
    expect(await control.execute(verifyCommand)).toEqual(result)
    expect(control.permissionChecks).toEqual(["lz-plan-command", "lz-plan-command"])
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
        new Set(
          receipt.isolation.resources.map((resource) => `${resource.device}:${resource.inode}`),
        ).size,
      ).toBe(9)
      expect(receipt.isolation.sqlitePath).toContain("retained-verification-resources")
    }
  },
  { timeout: 30_000 },
)

test(
  "retained task evidence releases a successor chain and defers combined checks across reopen",
  async () => {
    const f = await failedFixture({
      successorCount: 2,
      humanTaskEvidence: true,
      combinedHumanEvidence: true,
      requestTick: async () => {},
    })
    const originalAttempt = f.attempt
    const originalSession = structuredClone(f.sessions.get(originalAttempt.session_id))
    const originalPromptCount = f.prompts.filter(
      (prompt) => prompt.sessionID === originalAttempt.session_id,
    ).length
    const request = retainedVerifyCommand(f, "verify-retained-chain-with-human-evidence")
    const requested = (await f.runtime.command(request, "owner")) as {
      operationID: string
      generation: number
      status: string
    }
    expect(requested.status).toBe("retained-verification-requested")
    await f.runtime.tick()

    const initialOperation = f.store.atomic((db) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_retained_verifications WHERE id=?",
        )
        .get(requested.operationID),
    )!
    expect(JSON.parse(initialOperation.payload)).toMatchObject({
      state: "waiting-human",
      combinedArtifact: null,
      combinedWorkspace: null,
    })
    expect(f.store.nodes(f.planID).map((node) => node.state)).toEqual([
      "failed",
      "queued",
      "queued",
    ])
    expect(
      f.store.attempts(f.planID).filter((attempt) => attempt.task_id === f.task.id),
    ).toHaveLength(1)
    expect(
      f.store.atomic(
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=? AND phase='combined'",
            )
            .get(requested.operationID)!.count,
      ),
    ).toBe(0)
    const taskChecksBeforeReplay = f.store.atomic((db) =>
      db
        .query<{ receipt: string | null; state: string }, [string]>(
          "SELECT receipt,state FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
        )
        .get(requested.operationID),
    )!
    const worktreesBeforeReplay = f.worktreeCreations.length
    expect(await f.runtime.command(request, "owner")).toEqual(requested)
    expect(f.worktreeCreations).toHaveLength(worktreesBeforeReplay)
    expect(
      f.store.atomic((db) =>
        db
          .query<{ receipt: string | null; state: string }, [string]>(
            "SELECT receipt,state FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
          )
          .get(requested.operationID),
      ),
    ).toEqual(taskChecksBeforeReplay)
    expect(
      f.prompts.filter((prompt) => prompt.sessionID === originalAttempt.session_id),
    ).toHaveLength(originalPromptCount)
    expect(f.sessions.get(originalAttempt.session_id)).toEqual(originalSession)

    await f.runtime.stop()
    f.store.atomic((db) =>
      db.query("UPDATE runner_leases SET expires_at=0 WHERE project_directory=?").run(f.root),
    )
    f.store.repository.close()
    const reopenedRepository = new TaskRepository(join(f.state, "tasks.sqlite"), f.root)
    const reopenedStore = new RunnerStore(reopenedRepository)
    const reopenedRuntime = new TaskRuntime(reopenedStore, f.host, "project")
    cleanups.push(() => {
      void reopenedRuntime.stop()
      reopenedRepository.close()
    })
    await reopenedRuntime.tick()
    expect(
      reopenedStore.atomic((db) =>
        db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM runner_retained_verifications WHERE id=?",
          )
          .get(requested.operationID),
      ),
    ).toMatchObject({ payload: expect.stringContaining('"state":"waiting-human"') })
    expect(
      reopenedStore.atomic((db) =>
        db
          .query<{ receipt: string | null; state: string }, [string]>(
            "SELECT receipt,state FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
          )
          .get(requested.operationID),
      ),
    ).toEqual(taskChecksBeforeReplay)
    expect(
      f.prompts.filter((prompt) => prompt.sessionID === originalAttempt.session_id),
    ).toHaveLength(originalPromptCount)
    expect(reopenedStore.nodes(f.planID).map((node) => node.state)).toEqual([
      "failed",
      "queued",
      "queued",
    ])

    await reopenedRuntime.command(
      {
        requestID: "provide-retained-chain-human-evidence",
        planID: f.planID,
        expectedVersion: reopenedStore.plan(f.planID)!.version,
        action: "human-evidence",
        taskID: f.task.id,
        assertionID: "task-candidate",
        artifact: f.artifact,
        retainedVerificationID: requested.operationID,
        reason: "The Architect observed the retained first-task candidate",
      },
      "owner",
    )
    expect(reopenedStore.nodes(f.planID)[0]?.state).toBe("accepted")
    expect(reopenedStore.nodes(f.planID)[2]?.state).toBe("queued")
    expect(reopenedStore.plan(f.planID)?.state).toBe("running")
    expect(
      reopenedStore.atomic(
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=? AND phase='combined'",
            )
            .get(requested.operationID)!.count,
      ),
    ).toBe(0)

    for (
      let i = 0;
      i < 40 &&
      reopenedStore.plan(f.planID)?.state !== "accepted" &&
      reopenedStore
        .atomic((db) =>
          db
            .query<{ payload: string }, [string]>(
              "SELECT payload FROM runner_retained_verifications WHERE id=?",
            )
            .get(requested.operationID),
        )
        ?.payload.includes('"state":"waiting-human-combined"') !== true;
      i++
    )
      await reopenedRuntime.tick()
    expect(reopenedStore.nodes(f.planID).map((node) => node.state)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ])
    const waitingCombinedEvidence = JSON.parse(
      reopenedStore.atomic((db) =>
        db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM runner_retained_verifications WHERE id=?",
          )
          .get(requested.operationID),
      )!.payload,
    ) as { state: string; combinedArtifact: string | null }
    expect(waitingCombinedEvidence.state).toBe("waiting-human-combined")
    const combinedArtifact = waitingCombinedEvidence.combinedArtifact
    if (typeof combinedArtifact !== "string")
      throw new Error("Deferred combined evidence has no committed artifact")
    expect(combinedArtifact).toMatch(/^[a-f0-9]{40}$/)
    const combinedOperation = RetainedVerificationSchema.parse(waitingCombinedEvidence)
    const combinedInputFingerprint = combinedOperation.combinedInputFingerprint
    if (typeof combinedInputFingerprint !== "string")
      throw new Error("Deferred combined evidence has no phase-specific input fingerprint")
    expect(combinedInputFingerprint).not.toBe(combinedOperation.inputFingerprint)
    expect(retainedVerificationProbeBasis(combinedOperation, "combined").inputs.revision).toBe(
      combinedInputFingerprint,
    )
    expect(reopenedStore.plan(f.planID)?.state).toBe("running")
    expect(
      reopenedStore.atomic(
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=? AND phase='combined' AND state='completed'",
            )
            .get(requested.operationID)!.count,
      ),
    ).toBe(1)
    await reopenedRuntime.command(
      {
        requestID: "provide-retained-chain-combined-human-evidence",
        planID: f.planID,
        expectedVersion: reopenedStore.plan(f.planID)!.version,
        action: "human-evidence",
        assertionID: "combined-candidate",
        artifact: combinedArtifact,
        retainedVerificationID: requested.operationID,
        reason: "The Architect observed the complete combined candidate",
      },
      "owner",
    )
    expect(reopenedStore.plan(f.planID)?.state).toBe("accepted")
    expect(
      reopenedStore.atomic(
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=? AND phase='combined' AND state='completed'",
            )
            .get(requested.operationID)!.count,
      ),
    ).toBe(1)
    expect(
      reopenedStore.attempts(f.planID).filter((attempt) => attempt.task_id === f.task.id),
    ).toHaveLength(1)
    expect(
      reopenedStore.attempts(f.planID).find((attempt) => attempt.id === originalAttempt.id),
    ).toMatchObject({
      state: "failed",
      session_id: originalAttempt.session_id,
      message_id: originalAttempt.message_id,
      artifact: f.artifact,
      token_count: originalAttempt.token_count,
      tool_count: originalAttempt.tool_count,
    })
    expect(
      f.prompts.filter((prompt) => prompt.sessionID === originalAttempt.session_id),
    ).toHaveLength(originalPromptCount)
  },
  { timeout: 30_000 },
)

test("failed retained task evidence never accepts the target or releases dependents", async () => {
  const f = await failedFixture({ successorCount: 1, failRetainedCheck: true })
  const originalPromptCount = f.prompts.length
  const result = (await f.runtime.command(
    retainedVerifyCommand(f, "verify-retained-failing-task-evidence"),
    "owner",
  )) as { operationID: string }
  const operation = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(result.operationID),
  )!
  expect(JSON.parse(operation.payload)).toMatchObject({ state: "held" })
  expect(
    f.store.atomic((db) =>
      db
        .query<{ exit_code: number; state: string }, [string]>(
          "SELECT json_extract(receipt,'$.exitCode') AS exit_code,state FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
        )
        .get(result.operationID),
    ),
  ).toMatchObject({ exit_code: expect.any(Number), state: "completed" })
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ exit_code: number }, [string]>(
            "SELECT json_extract(receipt,'$.exitCode') AS exit_code FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
          )
          .get(result.operationID)!.exit_code,
    ),
  ).not.toBe(0)
  expect(f.store.nodes(f.planID).map((node) => node.state)).toEqual(["failed", "queued"])
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.prompts).toHaveLength(originalPromptCount)
  expect(
    f.store.attempts(f.planID).filter((attempt) => attempt.task_id === f.task.id),
  ).toHaveLength(1)
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

test(
  "a retained probe is generation-bound, owner-recorded, resource-isolated, and gates acceptance",
  async () => {
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
      evidenceReferences: [
        { kind: "interaction" as const, reference: "trace:retained-probe-pass" },
      ],
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
    for (let i = 0; i < 4 && f.store.plan(f.planID)?.state !== "accepted"; i++)
      await f.runtime.tick()
    expect(f.store.plan(f.planID)?.state).toBe("accepted")
    expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
    expect(f.store.attempts(f.planID)).toHaveLength(1)
    expect(f.prompts).toHaveLength(1)
  },
  { timeout: 30_000 },
)

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
  let runningDescendantPID = 0
  for (let i = 0; i < 500 && runningDescendantPID === 0; i++) {
    if (existsSync(descendantPIDPath)) {
      const value = readFileSync(descendantPIDPath, "utf8")
      if (/^\d+$/.test(value)) {
        const parsed = Number(value)
        if (Number.isSafeInteger(parsed) && parsed > 0) runningDescendantPID = parsed
      }
    }
    if (runningDescendantPID === 0) await Bun.sleep(10)
  }
  expect(existsSync(descendantPIDPath)).toBe(true)
  expect(runningDescendantPID).toBeGreaterThan(0)
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
