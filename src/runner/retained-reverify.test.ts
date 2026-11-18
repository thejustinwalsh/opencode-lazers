import { afterEach, expect, spyOn, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
import type { CheckReceipt } from "./artifacts.ts"
import {
  verificationActivitiesForDatabase,
  forgetVerificationActivity,
} from "./verification-activities.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { TaskRuntime } from "./runtime.ts"
import type { TaskRuntimeOptions } from "./runtime.ts"
import { RunnerStore } from "./store.ts"
import { ProbeRepository } from "../verification/probe/store.ts"
import { RetainedVerificationSchema } from "./retained-verification/schema.ts"
import {
  createRetainedCheckContext,
  runRetainedSetupProcess,
} from "./retained-verification/isolation.ts"
import type { RetainedDependencyInstaller } from "./retained-verification/isolation.ts"
import {
  registerRetainedVerificationResources,
  retainedVerificationChecks,
  saveRetainedVerification,
  updateRetainedVerificationResourceIdentity,
} from "./retained-verification/store.ts"
import { retainedProcedurePlan } from "./retained-verification/procedure.ts"
import { registerRunnerTools } from "./tools.ts"
import {
  canonicalProjectWorktreeParent,
  canonicalProjectWorktreePath,
} from "./workspace-location.ts"

type RegisteredRunnerTool = Parameters<ToolEditor["add"]>[0]

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fixture(
  options: {
    taskCheckCommand?: string | ((paths: { root: string; state: string }) => string)
    combinedCheckCommand?: string | ((paths: { root: string; state: string }) => string)
    taskCheckInactivityTimeoutMs?: number
    taskCheckHardTimeoutMs?: number
    combinedCheckInactivityTimeoutMs?: number
    combinedCheckHardTimeoutMs?: number
    verificationTimeoutDefaults?: { inactivityTimeoutMs: number; hardTimeoutMs: number }
    failRetainedCleanup?: boolean
    retainedDependencyInstaller?: RetainedDependencyInstaller
    requestTick?: () => Promise<void>
    successorCount?: number
    failRetainedCheck?: boolean
    additionalCombinedChecks?: Array<{ id: string; command: string }>
    gatedVerificationTest?: boolean
    candidateContentsCheck?: boolean
    projectBuild?: boolean
    verificationScript?: string
    beforeRetainedCheckBegin?: TaskRuntimeOptions["beforeRetainedCheckBegin"]
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
  if (options.verificationScript !== undefined) {
    writeFileSync(join(root, "verify-fixture.ts"), options.verificationScript)
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({
        name: "retained-reverify-fixture",
        version: "1.0.0",
        scripts: { verify: "bun verify-fixture.ts" },
      })}\n`,
    )
  }
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
  writeFileSync(join(root, "src/runner/noop-format.ts"), "export const retainedNoop = 1;\n")
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
  if (options.gatedVerificationTest)
    writeFileSync(
      join(root, "src", "runner", "retained-check.test.ts"),
      [
        'import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"',
        'import { join } from "node:path"',
        'import { expect, test } from "bun:test"',
        'test("waits for explicit retained-check release", async () => {',
        '  if (!process.env.LAZERS_VERIFICATION_SQLITE) throw new Error("No private verification database")',
        "  const home = process.env.HOME!",
        "  mkdirSync(home, { recursive: true })",
        '  appendFileSync(join(home, "started"), "started\\n")',
        '  const release = join(home, "release")',
        "  const deadline = Date.now() + 4_000",
        "  while (!existsSync(release) && Date.now() < deadline) await Bun.sleep(10)",
        "  expect(existsSync(release)).toBe(true)",
        '  expect(readFileSync("result.txt", "utf8")).toContain("retained candidate")',
        "})",
      ].join("\n"),
    )
  if (options.failRetainedCheck)
    writeFileSync(join(root, "src", "runner", "FAIL_RETAINED_CHECK"), "fail\n")
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
  const taskCheckCommand =
    typeof options.taskCheckCommand === "function"
      ? options.taskCheckCommand({ root, state })
      : options.taskCheckCommand
  proposal.verification = [
    {
      id: "isolated-task-check",
      command:
        taskCheckCommand ??
        "bun test src/runner src/verification/resources src/verification/probe test/retained-verification",
      timeoutMs: 10_000,
      ...(options.taskCheckInactivityTimeoutMs === undefined
        ? {}
        : { inactivityTimeoutMs: options.taskCheckInactivityTimeoutMs }),
      ...(options.taskCheckHardTimeoutMs === undefined
        ? {}
        : { hardTimeoutMs: options.taskCheckHardTimeoutMs }),
    },
  ]
  proposal.acceptance = [
    {
      id: "task-candidate",
      assertion: "The exact committed result is present and its private-resource check passes",
      evidence: [{ kind: "verification", verificationID: "isolated-task-check" }],
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
            (typeof options.combinedCheckCommand === "function"
              ? options.combinedCheckCommand({ root, state })
              : options.combinedCheckCommand) ??
            // Retained verification runs no combined check; the ordinary one accepts the plan.
            "true",
          timeoutMs: 10_000,
          ...(options.combinedCheckInactivityTimeoutMs === undefined
            ? {}
            : { inactivityTimeoutMs: options.combinedCheckInactivityTimeoutMs }),
          ...(options.combinedCheckHardTimeoutMs === undefined
            ? {}
            : { hardTimeoutMs: options.combinedCheckHardTimeoutMs }),
        },
        ...(options.additionalCombinedChecks ?? []).map((check) => ({
          ...check,
          timeoutMs: 10_000,
        })),
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
    ...(options.verificationTimeoutDefaults === undefined
      ? {}
      : { verificationTimeoutDefaults: options.verificationTimeoutDefaults }),
    retainedDependencyInstaller: options.retainedDependencyInstaller,
    beforeRetainedCheckBegin: options.beforeRetainedCheckBegin,
  })
  cleanups.push(async () => {
    await runtime.stop()
    repository.close()
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalVerificationDB === undefined) delete process.env.LAZERS_VERIFICATION_SQLITE
    else process.env.LAZERS_VERIFICATION_SQLITE = originalVerificationDB
    rmSync(canonicalProjectWorktreeParent(root), { recursive: true, force: true })
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

async function registeredPlanCommand(runtime: TaskRuntime, sessionID = "owner") {
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
          sessionID: sessionID as never,
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
  await waitForFixtureCondition(
    f,
    "ordinary attempt verification",
    () => {
      const current = f.store.plan(f.planID)
      return Boolean(
        current &&
        ["blocked", "accepted", "cleanup-blocked", "failed", "cancelled"].includes(current.state),
      )
    },
    30_000,
  )
  const plan = f.store.plan(f.planID)!
  const attempt = f.store.attempts(f.planID).at(-1)!
  if (!attempt.artifact) throw new Error("Fixture attempt did not retain an artifact")
  return { ...f, plan, attempt, artifact: attempt.artifact }
}

async function failedCandidateFixture(options: Parameters<typeof fixture>[0] = {}) {
  const check = "bun test src/runner/retained-check.test.ts"
  const f = await failedFixture({
    taskCheckCommand: check,
    combinedCheckCommand: check,
    candidateContentsCheck: true,
    ...options,
  })
  const attempt = f.store.attempts(f.planID).at(-1)!
  if (!attempt.artifact) throw new Error("Retained fixture requires a retained candidate")
  // A combined-check hold leaves every task accepted; verify-retained then runs against the
  // accepted plan, where its combined phase may continue.
  if (
    f.store.plan(f.planID)?.state === "blocked" &&
    f.store.nodes(f.planID).every((node) => node.state === "accepted")
  )
    f.store.atomic((db) =>
      db
        .query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'accepted'),reason=NULL,version=version+1 WHERE id=?",
        )
        .run(f.planID),
    )

  const removedWorkspaces: string[] = []
  const removeWorktree = f.host.removeWorktree
  f.host.removeWorktree = async (directory) => {
    removedWorkspaces.push(directory)
    await removeWorktree(directory)
  }
  const control = await registeredPlanCommand(f.runtime)
  const currentAttempt = f.store.attempts(f.planID).at(-1)!
  const originalWorker = f.sessions.get(attempt.session_id)
  if (!originalWorker) throw new Error("Retained fixture lost its original worker")
  const originalEffects = structuredClone(
    f.store.effects(f.planID).filter((effect) => effect.attempt_id === attempt.id),
  )
  const originalWorkspace = {
    head: git(attempt.workspace, ["rev-parse", "HEAD"]),
    status: git(attempt.workspace, ["status", "--porcelain", "--untracked-files=all"]),
  }
  return {
    ...f,
    control,
    attempt: currentAttempt,
    artifact: currentAttempt.artifact!,
    originalAttempt: structuredClone(currentAttempt),
    originalWorker: structuredClone(originalWorker),
    originalEffects,
    originalWorkspace,
    removedWorkspaces,
  }
}

function gatedRetainedCheckScript(): string {
  return [
    'import { appendFileSync, existsSync, mkdirSync } from "node:fs"',
    'import { join } from "node:path"',
    "if (!process.env.LAZERS_VERIFICATION_SQLITE) process.exit(1)",
    "const home = process.env.HOME!",
    "mkdirSync(home, { recursive: true })",
    'appendFileSync(join(home, "started"), "started\\n")',
    'const release = join(home, "release")',
    "const deadline = Date.now() + 4_000",
    "while (!existsSync(release) && Date.now() < deadline) await Bun.sleep(10)",
    "if (!existsSync(release)) process.exit(1)",
    "",
  ].join("\n")
}

async function waitForRetainedCheckStart(
  f: ReturnType<typeof fixture>,
  operationID: string,
): Promise<string> {
  let contextPath: string | undefined
  await waitForFixtureObservation(f, "retained source check start witness", () => {
    const check = f.store.atomic((db) =>
      db
        .query<{ context_path: string }, [string]>(
          "SELECT context_path FROM runner_retained_verification_checks WHERE operation_id=? AND state='intended'",
        )
        .get(operationID),
    )
    if (check) {
      contextPath = check.context_path
      return existsSync(join(contextPath, "home", "started"))
    }
    return false
  })
  return contextPath!
}

function retainedDebugSnapshot(
  f: ReturnType<typeof fixture> | Awaited<ReturnType<typeof failedFixture>>,
) {
  const operation = f.store.atomic((db) =>
    db
      .query<{ id: string; state: string; payload: string }, [string]>(
        "SELECT id,state,payload FROM runner_retained_verifications WHERE plan_id=?",
      )
      .get(f.planID),
  )
  const checks = operation
    ? f.store.atomic((db) =>
        db
          .query<
            {
              phase: string
              check_id: string
              state: string
              cleanup_state: string
              receipt: string | null
            },
            [string]
          >(
            "SELECT phase,check_id,state,cleanup_state,receipt FROM runner_retained_verification_checks WHERE operation_id=? ORDER BY phase,check_id",
          )
          .all(operation.id)
          .map((row) => ({
            ...row,
            receipt: row.receipt ? (JSON.parse(row.receipt) as unknown) : null,
          })),
      )
    : []
  const transitions = f.store.atomic((db) =>
    db
      .query<{ id: number; event: string; payload: string }, [string]>(
        "SELECT id,event,payload FROM runner_transitions WHERE plan_id=? ORDER BY id DESC LIMIT 12",
      )
      .all(f.planID),
  )
  const taskWorkspace = operation
    ? (JSON.parse(operation.payload) as { taskWorkspace?: string }).taskWorkspace
    : undefined
  let checkout: { head: string; status: string; conflicts: string; diff: string } | null = null
  if (taskWorkspace && existsSync(taskWorkspace)) {
    try {
      checkout = {
        head: git(taskWorkspace, ["rev-parse", "HEAD"]),
        status: git(taskWorkspace, ["status", "--porcelain", "--untracked-files=all"]),
        conflicts: git(taskWorkspace, ["ls-files", "-u", "-z"]),
        diff: git(taskWorkspace, ["diff", "--", "src/runner/noop-format.ts"]),
      }
    } catch {
      checkout = null
    }
  }
  const operationSummary: Record<string, unknown> | null = operation
    ? { ...(JSON.parse(operation.payload) as Record<string, unknown>), sqlState: operation.state }
    : null
  return {
    plan: f.store.plan(f.planID),
    node: f.store.nodes(f.planID).find((entry) => entry.task_id === f.task.id),
    attempt: f.store
      .attempts(f.planID)
      .find((entry) => ("attempt" in f ? entry.id === f.attempt.id : entry.task_id === f.task.id)),
    operation: operationSummary,
    checks,
    transitions,
    checkout,
  }
}

async function waitForFixtureCondition(
  f: ReturnType<typeof fixture>,
  description: string,
  complete: () => boolean,
  timeoutMs = 60_000,
  advance: () => Promise<unknown> = () => f.runtime.tick(),
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await advance()
    const active = verificationActivitiesForDatabase(f.store.repository.path).filter(
      (activity) => activity.state === "running",
    )
    if (active.length) await Promise.all(active.map((activity) => activity.settled))
    if (complete()) return
    if (active.length === 0) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(
    `${description} did not settle: ${JSON.stringify({
      plan: f.store.plan(f.planID),
      nodes: f.store.nodes(f.planID),
      attempts: f.store.attempts(f.planID),
      transitions: f.store.atomic((db) =>
        db
          .query<{ event: string; payload: string }, [string]>(
            "SELECT event,payload FROM runner_transitions WHERE plan_id=? ORDER BY id DESC LIMIT 12",
          )
          .all(f.planID),
      ),
    })}`,
  )
}

async function waitForFixtureObservation(
  f: ReturnType<typeof fixture>,
  description: string,
  observed: () => boolean,
  timeoutMs = 60_000,
  advance: () => Promise<unknown> = () => f.runtime.tick(),
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (observed()) return
    await advance()
    if (observed()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`${description} was not observed before the bounded deadline`)
}

async function waitForRetainedCheckActivity(f: ReturnType<typeof fixture>, operationID: string) {
  const selected = () =>
    verificationActivitiesForDatabase(f.store.repository.path).find(
      (entry) => entry.metadata.kind === "retained" && entry.metadata.operationID === operationID,
    )
  // F-S5-3: setup admission is now asynchronous; wait for the actual check, not its parent step.
  await waitForFixtureObservation(f, "Retained check activity", () => selected() !== undefined)
  return selected()!
}

async function waitForFixtureEffectsSettled(f: ReturnType<typeof fixture>, description: string) {
  await waitForFixtureCondition(f, description, () => {
    const runningActivity = verificationActivitiesForDatabase(f.store.repository.path).some(
      (activity) => activity.state === "running",
    )
    const unresolvedEffect = f.store
      .effects(f.planID)
      .some((effect) => ["intended", "uncertain"].includes(effect.state))
    return !runningActivity && !unresolvedEffect
  })
}

async function waitForRetainedTaskOutcome(
  f: ReturnType<typeof fixture> | Awaited<ReturnType<typeof failedFixture>>,
) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await f.runtime.tick()
    const active = verificationActivitiesForDatabase(f.store.repository.path).filter(
      (activity) => activity.state === "running",
    )
    await Promise.all(active.map((activity) => activity.settled))
    const snapshot = retainedDebugSnapshot(f)
    const operationState = snapshot.operation?.state
    const operationID = snapshot.operation?.id
    const retainedAcceptance = snapshot.transitions.some((transition) => {
      if (transition.event !== "RETAINED_CANDIDATE_ACCEPTED") return false
      try {
        return JSON.parse(transition.payload).operationID === operationID
      } catch {
        return false
      }
    })
    if (retainedAcceptance || ["accepted", "failed", "cancelled"].includes(String(operationState)))
      return snapshot
    if (active.length === 0) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(
    `Retained verification did not settle: ${JSON.stringify(retainedDebugSnapshot(f))}`,
  )
}

async function waitForRetainedOperationState(
  f: ReturnType<typeof fixture>,
  operationID: string,
  states: string[],
  description: string,
) {
  await waitForFixtureCondition(f, description, () => {
    const row = f.store.atomic((db) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_retained_verifications WHERE id=?",
        )
        .get(operationID),
    )
    return Boolean(row && states.includes((JSON.parse(row.payload) as { state: string }).state))
  })
}

async function waitForPlanAcceptance(
  f: ReturnType<typeof fixture>,
  description: string,
  timeoutMs = 60_000,
) {
  await waitForFixtureCondition(
    f,
    description,
    () =>
      Boolean(
        f.store.plan(f.planID)?.state === "accepted" &&
        f.store.nodes(f.planID).every((node) => node.state === "accepted") &&
        f.store.attempts(f.planID).every((attempt) => attempt.state === "accepted"),
      ),
    timeoutMs,
  )
  await waitForFixtureEffectsSettled(f, `${description} effects`)
}

async function addCompetingAttempt(f: Awaited<ReturnType<typeof fixture>>) {
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
      objective: "Preserve a same-scope retained task attempt",
      writeScope: ["result.txt"],
    },
  })
  const sourcePlan = JSON.parse(f.store.plan(f.planID)!.body) as Record<string, unknown>
  const plan = f.store.submit(
    {
      ...sourcePlan,
      requestID: `competing-active-attempt-${task.id}`,
      objective: "Keep the older same-scope attempt and its source intact",
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
  })
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

test("registered verify-retained checks a blocked verifying candidate without settling its source", async () => {
  const check = "bun test src/runner/retained-check.test.ts"
  let retainedCheckStarts = 0
  const observeRetainedCheckStarts = (runtime: TaskRuntime) => {
    const internals = runtime as unknown as {
      startCheckActivity(input: { id: string }): unknown
    }
    const start = internals.startCheckActivity.bind(runtime)
    internals.startCheckActivity = (input) => {
      if (input.id.startsWith("retained:")) retainedCheckStarts++
      return start(input)
    }
  }
  const f = await failedCandidateFixture({
    verificationTimeoutDefaults: { inactivityTimeoutMs: 20_000, hardTimeoutMs: 40_000 },
  })
  observeRetainedCheckStarts(f.runtime)
  const request = retainedVerifyCommand(f, "verify-sealed-source-candidate")
  const prompts = structuredClone(f.prompts)
  const created = [...f.created]
  const requested = await f.control.execute(request)
  expect(requested.status).toBe("retained-verification-requested")
  const operationID = String(requested.operationID)
  await waitForRetainedOperationState(f, operationID, ["accepted"], "retained task acceptance")

  const operationRow = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(operationID),
  )!
  expect(JSON.parse(operationRow.payload)).toMatchObject({
    state: "accepted",
    artifact: f.artifact,
    attemptID: f.attempt.id,
  })
  expect(f.store.plan(f.planID)?.state).toBe("accepted")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(f.store.attempts(f.planID).find((attempt) => attempt.id === f.attempt.id)).toEqual(
    f.originalAttempt,
  )
  expect(f.sessions.get(f.attempt.session_id)).toEqual(f.originalWorker)
  expect(f.store.effects(f.planID).filter((effect) => effect.attempt_id === f.attempt.id)).toEqual(
    f.originalEffects,
  )
  expect({
    head: git(f.attempt.workspace, ["rev-parse", "HEAD"]),
    status: git(f.attempt.workspace, ["status", "--porcelain", "--untracked-files=all"]),
  }).toEqual(f.originalWorkspace)
  expect(f.prompts).toEqual(prompts)
  expect(f.created).toEqual(created)
  expect(f.removedWorkspaces).not.toContain(f.attempt.workspace)

  const checks = f.store.atomic((db) =>
    db
      .query<
        {
          phase: string
          check_id: string
          artifact: string
          state: string
          receipt: string | null
        },
        [string]
      >(
        "SELECT phase,check_id,artifact,state,receipt FROM runner_retained_verification_checks WHERE operation_id=? ORDER BY phase,check_id",
      )
      .all(operationID),
  )
  expect(checks.map((row) => row.phase)).toEqual(["task"])
  expect(requested).not.toHaveProperty("combinedArtifact")
  for (const row of checks) {
    expect(row.artifact).toBe(f.artifact)
    expect(row.state).toBe("completed")
    const receipt = JSON.parse(row.receipt!) as CheckReceipt
    expect(receipt.command).toBe(check)
    expect(receipt.exitCode).toBe(0)
    expect(receipt.cwd).not.toBe(f.attempt.workspace)
    expect(receipt.inactivityTimeoutMs).toBe(20_000)
    expect(receipt.hardTimeoutMs).toBe(40_000)
    expect(receipt.verificationDeadline).toMatchObject({
      authoredTimeoutMs: 10_000,
      effectiveInactivityTimeoutMs: 20_000,
      effectiveHardTimeoutMs: 40_000,
      inactivityProvenance: "project-default",
      hardTimeoutProvenance: "project-default",
    })
  }

  f.store.atomic((db) => {
    for (const row of retainedVerificationChecks(db, operationID)) {
      db.query(
        "UPDATE runner_retained_verification_checks SET check_json=? WHERE operation_id=? AND phase=? AND check_id=?",
      ).run(
        JSON.stringify({
          id: row.checkID,
          command: (JSON.parse(row.checkJSON) as { command: string }).command,
          timeoutMs: 10_000,
        }),
        operationID,
        row.phase,
        row.checkID,
      )
    }
  })
  const legacyCheckJSON = f.store.atomic((db) =>
    retainedVerificationChecks(db, operationID).map((row) => row.checkJSON),
  )
  expect(legacyCheckJSON.every((check) => !JSON.parse(check).inactivityTimeoutMs)).toBe(true)

  expect(await f.control.execute(request)).toEqual(requested)
  expect(
    f.store.atomic((db) =>
      db
        .query<
          {
            phase: string
            check_id: string
            artifact: string
            state: string
            receipt: string | null
          },
          [string]
        >(
          "SELECT phase,check_id,artifact,state,receipt FROM runner_retained_verification_checks WHERE operation_id=? ORDER BY phase,check_id",
        )
        .all(operationID),
    ),
  ).toEqual(checks)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM runner_transitions WHERE plan_id=? AND event='RETAINED_CANDIDATE_ACCEPTED'",
          )
          .get(f.planID)?.n,
    ),
  ).toBe(1)

  await f.runtime.stop()
  f.store.atomic((db) =>
    db.query("UPDATE runner_leases SET expires_at=0 WHERE project_directory=?").run(f.root),
  )
  f.store.repository.close()
  const reopenedRepository = new TaskRepository(join(f.state, "tasks.sqlite"), f.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopenedRuntime = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    verificationTimeoutDefaults: { inactivityTimeoutMs: 25_000, hardTimeoutMs: 50_000 },
  })
  observeRetainedCheckStarts(reopenedRuntime)
  cleanups.push(async () => {
    await reopenedRuntime.stop()
    reopenedRepository.close()
  })
  await waitForFixtureCondition(
    f,
    "reopened sealed-source combined evidence gate",
    () => {
      const row = reopenedStore.atomic((db) =>
        db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM runner_retained_verifications WHERE id=?",
          )
          .get(operationID),
      )
      return Boolean(row && JSON.parse(row.payload).state === "accepted")
    },
    60_000,
    () => reopenedRuntime.tick(),
  )
  const reopenedChecks = reopenedStore.atomic((db) =>
    db
      .query<
        {
          phase: string
          check_id: string
          artifact: string
          state: string
          receipt: string | null
        },
        [string]
      >(
        "SELECT phase,check_id,artifact,state,receipt FROM runner_retained_verification_checks WHERE operation_id=? ORDER BY phase,check_id",
      )
      .all(operationID),
  )
  expect(reopenedChecks).toEqual(checks)
  expect(
    reopenedStore.atomic((db) =>
      retainedVerificationChecks(db, operationID).map((row) => row.checkJSON),
    ),
  ).toEqual(legacyCheckJSON)
  const reopenedControl = await registeredPlanCommand(reopenedRuntime)
  expect(await reopenedControl.execute(request)).toEqual(requested)
  expect(
    reopenedStore
      .activity(f.planID, f.task.id)
      .filter((entry) => entry.event === "RETAINED_VERIFICATION_CHECK_COMPLETED"),
  ).toHaveLength(1)
  expect(reopenedStore.plan(f.planID)?.state).toBe("accepted")
  expect(reopenedStore.attempts(f.planID).find((attempt) => attempt.id === f.attempt.id)).toEqual(
    f.originalAttempt,
  )
  expect(retainedCheckStarts).toBe(1)
}, 120_000)

test("registered verify-retained accepts a reassigned owner after reopen under the current owner", async () => {
  const f = await failedCandidateFixture({})
  const previousOwner = f.store.plan(f.planID)!.owner
  const reassignment = await f.runtime.command(
    {
      requestID: "reassign-sealed-source-verification-owner",
      planID: f.planID,
      expectedVersion: f.store.plan(f.planID)!.version,
      action: "reassign",
      targetSessionID: "owner2",
      reason: "Continue review of the sealed candidate under the current Architect owner",
    },
    previousOwner,
  )
  expect(reassignment).toMatchObject({ status: "reassigned" })
  expect(f.store.plan(f.planID)?.owner).toBe("owner2")
  const request = retainedVerifyCommand(f, "verify-continued-sealed-source-candidate")
  const prompts = structuredClone(f.prompts)
  const created = [...f.created]
  const attemptID = f.attempt.id

  await f.runtime.stop()
  f.store.atomic((db) =>
    db.query("UPDATE runner_leases SET expires_at=0 WHERE project_directory=?").run(f.root),
  )
  f.store.repository.close()
  const reopenedRepository = new TaskRepository(join(f.state, "tasks.sqlite"), f.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopenedRuntime = new TaskRuntime(reopenedStore, f.host, "project")
  cleanups.push(async () => {
    await reopenedRuntime.stop()
    reopenedRepository.close()
  })
  const reopenedFixture = { ...f, store: reopenedStore, runtime: reopenedRuntime }
  const control = await registeredPlanCommand(reopenedRuntime, "owner2")
  const requested = await control.execute(request)
  expect(requested.status).toBe("retained-verification-requested")
  const operationID = String(requested.operationID)
  await waitForRetainedOperationState(
    reopenedFixture,
    operationID,
    ["accepted"],
    "continued-owner isolated task acceptance with combined gate pending",
  )

  const checks = reopenedStore.atomic((db) =>
    db
      .query<{ phase: string; artifact: string; state: string; receipt: string | null }, [string]>(
        "SELECT phase,artifact,state,receipt FROM runner_retained_verification_checks WHERE operation_id=? ORDER BY phase,check_id",
      )
      .all(operationID),
  )
  expect(checks.map((row) => row.phase)).toEqual(["task"])
  for (const row of checks) {
    expect(row.state).toBe("completed")
    const receipt = JSON.parse(row.receipt!) as CheckReceipt
    expect(receipt.command).toBe("bun test src/runner/retained-check.test.ts")
    expect(receipt.exitCode).toBe(0)
    expect(receipt.cwd).not.toBe(f.attempt.workspace)
  }
  expect(reopenedStore.plan(f.planID)).toMatchObject({ state: "accepted", owner: "owner2" })
  const retainedOperation = reopenedStore.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(operationID),
  )
  expect(JSON.parse(retainedOperation!.payload)).toMatchObject({
    owner: "owner2",
  })
  expect(reopenedStore.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(
    reopenedStore.latestTransition(f.planID, f.task.id, "RETAINED_CANDIDATE_ACCEPTED"),
  ).toBeDefined()
  expect(reopenedStore.attempts(f.planID).find((attempt) => attempt.id === attemptID)).toEqual(
    f.originalAttempt,
  )
  expect(f.sessions.get(f.attempt.session_id)).toEqual(f.originalWorker)
  expect(
    reopenedStore.effects(f.planID).filter((effect) => effect.attempt_id === attemptID),
  ).toEqual(f.originalEffects)
  expect({
    head: git(f.attempt.workspace, ["rev-parse", "HEAD"]),
    status: git(f.attempt.workspace, ["status", "--porcelain", "--untracked-files=all"]),
  }).toEqual(f.originalWorkspace)
  expect(f.prompts).toEqual(prompts)
  expect(f.created).toEqual(created)
  expect(f.removedWorkspaces).not.toContain(f.attempt.workspace)
}, 60_000)

test("stopped-plan verify-retained preserves failed sealed-source check receipts and holds", async () => {
  const f = await failedCandidateFixture({
    taskCheckCommand: "bun run verify",
    combinedCheckCommand: "true",
    verificationScript: [
      'if (process.env.LAZERS_VERIFICATION_SQLITE) throw new Error("fixture retained check failure")',
      "process.exit(1)",
      "",
    ].join("\n"),
  })
  const prompts = structuredClone(f.prompts)
  const requested = await f.control.execute(
    retainedVerifyCommand(f, "verify-failing-stopped-sealed-source-candidate"),
  )
  const operationID = String(requested.operationID)
  await waitForRetainedOperationState(f, operationID, ["failed"], "stopped-plan failed checks")

  const check = f.store.atomic((db) =>
    db
      .query<{ phase: string; artifact: string; state: string; receipt: string | null }, [string]>(
        "SELECT phase,artifact,state,receipt FROM runner_retained_verification_checks WHERE operation_id=?",
      )
      .get(operationID),
  )
  expect(check).toMatchObject({ phase: "task", artifact: f.artifact, state: "completed" })
  const receipt = JSON.parse(check!.receipt!) as CheckReceipt
  expect(receipt.exitCode).not.toBe(0)
  expect(`${receipt.stdout}\n${receipt.stderr}`).toContain("fixture retained check failure")
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(f.planID).find((attempt) => attempt.id === f.attempt.id)).toEqual(
    f.originalAttempt,
  )
  expect(f.sessions.get(f.attempt.session_id)).toEqual(f.originalWorker)
  expect(f.store.effects(f.planID).filter((effect) => effect.attempt_id === f.attempt.id)).toEqual(
    f.originalEffects,
  )
  expect({
    head: git(f.attempt.workspace, ["rev-parse", "HEAD"]),
    status: git(f.attempt.workspace, ["status", "--porcelain", "--untracked-files=all"]),
  }).toEqual(f.originalWorkspace)
  expect(f.prompts).toEqual(prompts)
  expect(f.removedWorkspaces).not.toContain(f.attempt.workspace)
  expect(f.store.latestTransition(f.planID, f.task.id, "RETAINED_CANDIDATE_ACCEPTED")).toBe(
    undefined,
  )
}, 60_000)

test("an owner change after admission does not fence or fail the retained call", async () => {
  const f = await failedCandidateFixture({
    taskCheckCommand: "bun run verify",
    verificationScript: gatedRetainedCheckScript(),
    candidateContentsCheck: false,
    requestTick: async () => {},
  })
  const request = retainedVerifyCommand(f, "source-owner-change-after-admission")
  const requested = await f.control.execute(request)
  const operationID = String(requested.operationID)
  const contextPath = await waitForRetainedCheckStart(f, operationID)
  // Ownership is advisory: another live Architect adopting the plan changes nothing here.
  expect(f.store.updatePlanOwner(f.planID, "owner", "owner2")).toBe(true)
  writeFileSync(join(contextPath, "home", "release"), "continue\n")
  const activity = await waitForRetainedCheckActivity(f, operationID)
  await activity.settled
  await waitForRetainedOperationState(f, operationID, ["accepted"], "owner change after admission")

  expect(f.store.plan(f.planID)).toMatchObject({ owner: "owner2" })
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(
    f.store.latestTransition(f.planID, f.task.id, "RETAINED_CANDIDATE_ACCEPTED"),
  ).toMatchObject({
    operationID,
  })
  expect(f.prompts).toHaveLength(1)
  expect(f.sessions.get(f.attempt.session_id)).toEqual(f.originalWorker)
})

test("a competing verification of the same source is rejected while one call runs, and that call still passes", async () => {
  const f = await failedCandidateFixture({
    taskCheckCommand: "bun run verify",
    verificationScript: gatedRetainedCheckScript(),
    candidateContentsCheck: false,
    requestTick: async () => {},
  })
  const request = retainedVerifyCommand(f, "source-verification-to-cancel")
  const requested = await f.control.execute(request)
  const operationID = String(requested.operationID)
  await waitForRetainedCheckStart(f, operationID)
  const checkActivity = await waitForRetainedCheckActivity(f, operationID)

  await expect(
    f.control.execute({
      ...request,
      requestID: "competing-source-verification",
      reason: "Try to reserve a second verification authority for the same source candidate",
    }),
  ).rejects.toThrow("conflicting retained verification authority")
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM runner_retained_verifications WHERE plan_id=?",
          )
          .get(f.planID)?.n,
    ),
  ).toBe(1)

  const contextPath = await waitForRetainedCheckStart(f, operationID)
  writeFileSync(join(contextPath, "home", "release"), "continue\n")
  await checkActivity.settled
  await waitForRetainedOperationState(f, operationID, ["accepted"], "competing verification")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(f.sessions.get(f.attempt.session_id)).toEqual(f.originalWorker)
  expect(f.prompts).toHaveLength(1)
  expect(f.removedWorkspaces).not.toContain(f.attempt.workspace)
})

async function acceptedFailedAttemptFixture() {
  const f = await failedFixture()
  const control = await registeredPlanCommand(f.runtime)
  await control.execute(retainedVerifyCommand(f, "accept-retained-failed-attempt"))
  const snapshot = await waitForRetainedTaskOutcome(f)
  if (snapshot.node?.state !== "accepted")
    throw new Error(`Retained candidate did not reach task acceptance: ${JSON.stringify(snapshot)}`)
  await waitForFixtureEffectsSettled(f, "retained failed-attempt effects")
  // The call only accepts the task; the ordinary combined check then accepts the plan.
  await waitForFixtureCondition(
    f,
    "combined acceptance after the retained task acceptance",
    () => f.store.plan(f.planID)?.state === "accepted",
  )
  await waitForFixtureEffectsSettled(f, "combined acceptance effects")
  expect(f.store.attempts(f.planID)[0]?.state).toBe("failed")
  const command = {
    requestID: "repair-retained-accepted-failed-attempt",
    planID: f.planID,
    expectedVersion: f.store.plan(f.planID)!.version,
    action: "retained-repair" as const,
    taskID: f.task.id,
    attemptID: f.attempt.id,
    artifact: f.artifact,
    reason: "Resolve the actual combined integration conflict in the original worker",
  }
  return { ...f, control, command }
}

test("retained bun run verify may perform a no-op formatter and use its passing result", async () => {
  const f = await failedFixture({
    taskCheckCommand: "bun run verify",
    verificationScript: [
      'import { spawnSync } from "node:child_process"',
      "if (process.env.LAZERS_VERIFICATION_SQLITE) {",
      '  const result = spawnSync(process.execPath, ["fmt", "src/runner/noop-format.ts"], { stdio: "inherit" })',
      "  process.exit(result.status ?? 1)",
      "}",
      "",
    ].join("\n"),
  })
  const control = await registeredPlanCommand(f.runtime)
  await control.execute(retainedVerifyCommand(f, "retained-noop-formatter"))
  const snapshot = await waitForRetainedTaskOutcome(f)

  const operation = f.store.atomic((db) =>
    db
      .query<{ id: string; state: string }, []>(
        "SELECT id,state FROM runner_retained_verifications",
      )
      .get(),
  )!
  const check = f.store.atomic((db) =>
    db
      .query<{ state: string; receipt: string | null; cleanup_state: string }, [string]>(
        "SELECT state,receipt,cleanup_state FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
      )
      .get(operation.id),
  )!
  if (!check.receipt) throw new Error(`No retained formatter receipt: ${JSON.stringify(snapshot)}`)
  const receipt = JSON.parse(check.receipt!) as CheckReceipt
  expect(receipt.command).toBe("bun run verify")
  expect(receipt.exitCode).toBe(0)
  expect(check.state).toBe("completed")
  expect(check.cleanup_state).toBe("complete")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(f.store.nodes(f.planID)[0]?.artifact).toBe(f.artifact)
  if (operation.state === "failed")
    throw new Error(`No-op retained formatter failed: ${JSON.stringify(snapshot)}`)
  expect(snapshot.operation).not.toBeNull()
}, 60_000)

test("retained verification does not accept a verifier that actually changes its bound candidate", async () => {
  const f = await failedFixture({
    taskCheckCommand: "bun run verify",
    verificationScript: [
      'import { writeFileSync } from "node:fs"',
      'if (process.env.LAZERS_VERIFICATION_SQLITE) writeFileSync("result.txt", "changed by retained verifier\\n")',
      "",
    ].join("\n"),
  })
  const control = await registeredPlanCommand(f.runtime)
  const originalPromptCount = f.prompts.length
  await control.execute(retainedVerifyCommand(f, "retained-mutating-verifier"))
  const snapshot = await waitForRetainedTaskOutcome(f)

  const operation = f.store.atomic((db) =>
    db
      .query<{ id: string; state: string; payload: string }, []>(
        "SELECT id,state,payload FROM runner_retained_verifications",
      )
      .get(),
  )!
  const check = f.store.atomic((db) =>
    db
      .query<{ state: string; receipt: string | null }, [string]>(
        "SELECT state,receipt FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
      )
      .get(operation.id),
  )!
  const receipt = JSON.parse(check.receipt!) as CheckReceipt
  expect(receipt.exitCode).toBe(0)
  expect(check.state).toBe("completed")
  expect(operation.state).toBe("failed")
  expect((JSON.parse(operation.payload) as { failureReason: string }).failureReason).toContain(
    "candidate changed after its checks",
  )
  expect(snapshot.operation).toMatchObject({ state: "failed" })
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(f.store.nodes(f.planID)[0]?.artifact).toBe(f.artifact)
  expect(f.prompts).toHaveLength(originalPromptCount)
  expect(
    f.store.latestTransition(f.planID, f.task.id, "RETAINED_CANDIDATE_ACCEPTED"),
  ).toBeUndefined()
}, 60_000)

test("retained acceptance repairs the same failed-history attempt without rewriting its failure", async () => {
  const f = await acceptedFailedAttemptFixture()
  const original = f.store.attempts(f.planID)[0]!
  const history = () =>
    f.store.atomic((db) =>
      db.query("SELECT * FROM runner_transitions WHERE plan_id=? ORDER BY id").all(f.planID),
    )
  const oldHistory = history()
  const oldPromptCount = f.prompts.length
  f.host.prompt = async (input) => {
    f.prompts.push({ sessionID: input.sessionID, id: input.id })
    writeFileSync(join(input.directory, "result.txt"), "retained candidate\nconflict resolved\n")
    git(input.directory, ["add", "result.txt"])
    git(input.directory, ["commit", "-m", "resolve combined conflict"])
    const worker = f.sessions.get(input.sessionID)!
    worker.messages.push({ id: input.id, text: input.text })
    worker.turn = { inputID: input.id, state: "completed" }
  }
  const result = await f.control.execute(f.command)
  expect(result).toMatchObject({ status: "retained-repair-requested", attemptID: original.id })
  expect(await f.control.execute(f.command)).toEqual(result)
  expect(history().slice(0, oldHistory.length)).toEqual(oldHistory)
  expect(f.store.latestTransition(f.planID, f.task.id, "RETAINED_REPAIR_REQUESTED")).toMatchObject({
    previousAttemptState: "failed",
    artifact: original.artifact,
  })
  await waitForFixtureCondition(
    f,
    "same-worker retained repair dispatch",
    () => f.prompts.length === oldPromptCount + 1,
  )
  expect(f.store.attempts(f.planID)).toHaveLength(1)
  expect(f.store.attempts(f.planID)[0]).toMatchObject({
    id: original.id,
    number: original.number,
    session_id: original.session_id,
    workspace: original.workspace,
    policy: original.policy,
  })
  expect(f.prompts).toHaveLength(oldPromptCount + 1)
  expect(f.prompts.at(-1)?.sessionID).toBe(original.session_id)
}, 30_000)

for (const timing of ["before admission", "during native observation"]) {
  test(`failed-history repair rejects missing retained acceptance ${timing}`, async () => {
    const f = await acceptedFailedAttemptFixture()
    const original = f.store.attempts(f.planID)[0]!
    const oldPromptCount = f.prompts.length
    const removeAcceptance = () =>
      f.store.atomic((db) =>
        db
          .query(
            "UPDATE runner_retained_verifications SET state='failed',payload=json_set(payload,'$.state','failed') WHERE plan_id=? AND state='accepted'",
          )
          .run(f.planID),
      )
    if (timing === "before admission") removeAcceptance()
    else
      f.host.waitForSession = async () => {
        removeAcceptance()
      }
    await expect(f.control.execute(f.command)).rejects.toThrow(
      timing === "before admission"
        ? "latest accepted task and attempt"
        : "assignment changed before admission",
    )
    expect(f.store.attempts(f.planID)).toEqual([original])
    expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
    expect(f.prompts).toHaveLength(oldPromptCount)
  }, 30_000)
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

test("isolated verification proceeds beside a same-scope retained source without changing it", async () => {
  const f = await failedFixture()
  const old = await addCompetingAttempt(f)
  const promptCount = f.prompts.length
  const sourceHead = git(old.workspace, ["rev-parse", "HEAD"])
  const result = await f.runtime.command(
    retainedVerifyCommand(f, "isolated-check-retained-source"),
    "owner",
  )
  await waitForRetainedTaskOutcome(f)
  await waitForFixtureCondition(
    f,
    "retained plan acceptance",
    () => f.store.plan(f.planID)?.state === "accepted",
  )
  expect(result).toMatchObject({ status: "retained-verification-requested" })
  expect(f.store.plan(f.planID)?.state).toBe("accepted")
  expect(f.prompts).toHaveLength(promptCount)
  expect(f.store.attempts(old.planID)).toEqual([old.attempt])
  expect(f.store.plan(old.planID)).toEqual(old.plan)
  expect(f.store.effects(old.planID)).toEqual(old.effects)
  expect(f.sessions.get(old.sessionID)).toEqual(old.worker)
  expect(git(old.workspace, ["rev-parse", "HEAD"])).toBe(sourceHead)
})

test("isolated checks preserve an actively editing worker and its uncommitted source", async () => {
  const f = await failedFixture()
  const old = await addCompetingAttempt(f)
  const activeWorker = { ...old.worker, agent: "lazers-implementor", archived: false, busy: true }
  f.sessions.set(old.sessionID, activeWorker)
  writeFileSync(join(old.workspace, "result.txt"), "worker is editing this file\n")
  const sourceStatus = git(old.workspace, ["status", "--porcelain"])
  const prompts = [...f.prompts]
  await f.runtime.command(retainedVerifyCommand(f, "beside-active-writer"), "owner")
  await waitForRetainedTaskOutcome(f)
  await waitForFixtureCondition(
    f,
    "retained plan acceptance beside writer",
    () => f.store.plan(f.planID)?.state === "accepted",
  )
  expect(f.store.plan(f.planID)?.state).toBe("accepted")
  expect(f.sessions.get(old.sessionID)).toEqual(activeWorker)
  expect(f.store.attempts(old.planID)).toEqual([old.attempt])
  expect(readFileSync(join(old.workspace, "result.txt"), "utf8")).toBe(
    "worker is editing this file\n",
  )
  expect(git(old.workspace, ["status", "--porcelain"])).toBe(sourceStatus)
  expect(f.prompts).toEqual(prompts)
})

test("retained verification refuses a physical destination alias of another worker", async () => {
  const f = await failedFixture()
  const old = await addCompetingAttempt(f)
  const operationID = crypto.randomUUID()
  const destination = canonicalProjectWorktreePath(f.root, `retained-${operationID}-task`)
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(old.workspace, destination, "dir")
  const randomID = spyOn(crypto, "randomUUID").mockReturnValue(operationID)
  try {
    await expect(
      f.runtime.command(retainedVerifyCommand(f, "physical-collision"), "owner"),
    ).rejects.toThrow("uses this task or verification checkout")
  } finally {
    randomID.mockRestore()
  }
  expect(f.store.attempts(old.planID)).toEqual([old.attempt])
  expect(f.store.plan(f.planID)?.state).toBe("blocked")
})

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
      status: string
    }

    expect(result.status).toBe("retained-verification-requested")
    expect(result).not.toHaveProperty("generation")
    expect(await control.execute(verifyCommand)).toEqual(result)
    expect(control.permissionChecks).toEqual(["lz-plan-command", "lz-plan-command"])
    await waitForRetainedOperationState(
      f,
      result.operationID,
      ["accepted"],
      "exact failed-candidate retained verification",
    )
    expect(f.worktreeCreations).toHaveLength(worktreeCount + 1)
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
      taskWorkspace: string | null
    }
    expect(retained.state).toBe("accepted")
    expect(retained.cleanupState).toBe("complete")
    expect(retained.artifact).toBe(exactArtifact)
    // The call accepts the task only. The old uncertain effect keeps the plan from the
    // ordinary combined check's acceptance until it is reconciled; the call never touches it.
    expect(f.store.plan(f.planID)?.state).not.toBe("accepted")
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
    expect(retained).not.toHaveProperty("combinedArtifact")
    expect(retained.taskWorkspace).not.toBeNull()
    expect(existsSync(retained.taskWorkspace!)).toBe(false)
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
    expect(checks).toHaveLength(1)
    expect(
      checks.every((check) => check.state === "completed" && check.cleanup_state === "complete"),
    ).toBe(true)
    for (const check of checks) {
      const receipt = JSON.parse(check.receipt!) as {
        exitCode: number
        cwd: string
        isolation: {
          operationID: string
          phase: string
          resources: Array<{ name: string; realPath: string; device: number; inode: number }>
          sqlitePath: string
        }
      }
      expect(receipt.exitCode).toBe(0)
      expect(receipt.cwd).not.toBe(attemptBefore.workspace)
      expect(receipt.isolation.operationID).toBe(result.operationID)
      expect(receipt.isolation).not.toHaveProperty("generation")
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

test("failed retained task evidence never accepts the target or releases dependents", async () => {
  const f = await failedFixture({ successorCount: 1, failRetainedCheck: true })
  const originalPromptCount = f.prompts.length
  const result = (await f.runtime.command(
    retainedVerifyCommand(f, "verify-retained-failing-task-evidence"),
    "owner",
  )) as { operationID: string }
  await waitForRetainedOperationState(
    f,
    result.operationID,
    ["failed"],
    "failed retained task evidence",
  )
  const operation = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(result.operationID),
  )!
  expect(JSON.parse(operation.payload)).toMatchObject({ state: "failed" })
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
  ).rejects.toThrow("A live Architect session of this project must command the plan")
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

test("a service URL in an authorized check does not trigger a verification admission ban", async () => {
  const f = fixture({
    taskCheckCommand: "true # http://127.0.0.1:5432",
    combinedCheckCommand: "true",
  })
  await f.runtime.command(
    {
      requestID: "run-shared-service-fixture",
      planID: f.planID,
      expectedVersion: 1,
      action: "run",
    },
    "owner",
  )
  await waitForPlanAcceptance(f, "service URL fixture plan acceptance")
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
  await waitForFixtureObservation(f, "service URL retained check admission", () =>
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=?",
          )
          .get(result.operationID)!.count > 0,
    ),
  )
  const retained = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(result.operationID),
  )!
  expect(JSON.parse(retained.payload).failureReason ?? "").not.toContain("shared external service")
  expect(f.worktreeCreations.length).toBeGreaterThan(before)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=?",
          )
          .get(result.operationID)!.count,
    ),
  ).toBeGreaterThan(0)
})

test("a configured script executes and records its actual command failure", async () => {
  const f = await failedFixture({
    taskCheckCommand: "bun ./scripts/check-profile-and-database.ts",
  })
  const plan = f.plan
  const attempt = f.attempt
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
  await waitForRetainedOperationState(
    f,
    result.operationID,
    ["failed"],
    "configured script retained failure",
  )
  const retained = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(result.operationID),
  )!
  expect(JSON.parse(retained.payload)).toMatchObject({
    state: "failed",
    failureReason: expect.stringContaining("exited with code"),
  })
  expect(f.worktreeCreations.length).toBeGreaterThan(before)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_retained_verification_checks WHERE operation_id=?",
          )
          .get(result.operationID)!.count,
    ),
  ).toBeGreaterThan(0)
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
  await waitForRetainedOperationState(
    f,
    result.operationID,
    ["failed"],
    "required retained task probe gate",
  )
  const retained = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(result.operationID),
  )!
  expect(JSON.parse(retained.payload)).toMatchObject({
    state: "failed",
    failureReason: expect.stringContaining("task-candidate:probe:retained-live-behavior"),
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

// SKIPPED: probes cannot be recorded against a held operation (assertRetainedProbeBinding); a missing probe now goes straight to held.
test("failed retained-checkout cleanup does not revoke a product pass", async () => {
  const cleanupFixture = fixture({
    failRetainedCleanup: true,
    taskCheckCommand: "true",
    combinedCheckCommand: "true",
  })
  await cleanupFixture.runtime.command(
    {
      requestID: "run-retained-cleanup-fixture",
      planID: cleanupFixture.planID,
      expectedVersion: 1,
      action: "run",
    },
    "owner",
  )
  await waitForPlanAcceptance(cleanupFixture, "cleanup fixture plan acceptance")
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
  await waitForRetainedOperationState(
    cleanupFixture,
    result.operationID,
    ["accepted"],
    "retained cleanup-failure evidence",
  )
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

test.each(["cancel"] as const)(
  "%s retains a completed passing receipt with unknown process settlement",
  async (action) => {
    const f = await failedFixture({
      requestTick: async () => {},
      verificationScript: [
        "if (!process.env.LAZERS_VERIFICATION_SQLITE) process.exit(1)",
        'Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref()',
      ].join("\n"),
    })
    const control = await registeredPlanCommand(f.runtime)
    const result = (await control.execute(retainedVerifyCommand(f, "uncertain-settlement"))) as {
      operationID: string
    }
    const originalKill = process.kill.bind(process)
    let group: number | undefined
    const kill = spyOn(process, "kill").mockImplementation(((pid, signal) => {
      if (typeof pid === "number" && pid < 0) {
        group = pid
        if (signal === 0) return true
        if (signal === "SIGKILL") throw new Error("fixture cannot observe tree termination")
      }
      return originalKill(pid, signal)
    }) as typeof process.kill)
    try {
      const activity = await waitForRetainedCheckActivity(f, result.operationID)
      expect(activity).toBeDefined()
      await activity!.settled
      expect(activity!.state).toBe("completed")
      expect(activity!.result).toMatchObject({
        exitCode: 0,
        timedOut: false,
        processCleanup: { state: "uncertain" },
      })
      const command = {
        requestID: "cancel-unknown-settlement",
        planID: f.planID,
        expectedVersion: f.store.plan(f.planID)!.version,
        action,
      }
      await control.execute(command)
      await f.runtime.tick()
      expect(f.store.plan(f.planID)?.state).toBe("cancelling")
      await f.runtime.tick()
      expect(f.store.plan(f.planID)?.state).toBe("cancelling")
      expect(f.store.plan(f.planID)?.reason).toContain("settlement is uncertain")
      const check = f.store.atomic((db) =>
        db
          .query<{ state: string; receipt: string; cleanup_state: string }, [string]>(
            "SELECT state,receipt,cleanup_state FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
          )
          .get(result.operationID),
      )!
      expect(check).toMatchObject({ state: "completed", cleanup_state: "pending" })
      expect(JSON.parse(check.receipt)).toMatchObject({ exitCode: 0, timedOut: false })
      const events = f.store
        .activity(f.planID, f.task.id)
        .filter((entry) => entry.event === "RETAINED_VERIFICATION_CHECK_COMPLETED")
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.payload)).toMatchObject({ passed: true, cancelled: true })
      const resources = f.store.atomic((db) =>
        db
          .query<{ state: string; canonical_path: string }, [string]>(
            "SELECT state,canonical_path FROM runner_retained_verification_resources WHERE operation_id=?",
          )
          .all(result.operationID),
      )
      expect(resources.length).toBeGreaterThan(0)
      expect(resources.every((resource) => resource.state === "uncertain")).toBe(true)
      expect(resources.some((resource) => existsSync(resource.canonical_path))).toBe(true)
      expect(f.prompts).toHaveLength(1)
    } finally {
      kill.mockRestore()
      if (group !== undefined) {
        try {
          originalKill(group, "SIGKILL")
        } catch {
          // The test descendant may already have exited during assertions.
        }
      }
    }
  },
  30_000,
)

for (const action of ["cancel"] as const)
  test.each(["valid", "missing", "check", "candidate", "isolation"] as const)(
    `${action} recovers receipt-cut cancellation with %s disk evidence`,
    async (kind) => {
      const f = await failedFixture({ requestTick: async () => {} })
      const control = await registeredPlanCommand(f.runtime)
      const requested = (await control.execute(retainedVerifyCommand(f, "cancel-receipt-cut"))) as {
        operationID: string
      }
      const activity = await waitForRetainedCheckActivity(f, requested.operationID)
      await activity.settled
      expect(activity.state).toBe("completed")
      forgetVerificationActivity(activity.key, activity.identity)
      const row = f.store.atomic((db) =>
        db
          .query<
            {
              state: string
              receipt_path: string
              context_path: string
            },
            [string]
          >(
            "SELECT state,receipt_path,context_path FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
          )
          .get(requested.operationID),
      )!
      expect(row.state).toBe("intended")
      const original = JSON.parse(readFileSync(row.receipt_path, "utf8")) as CheckReceipt
      const changed = structuredClone(original)
      const isolation = changed.isolation as { resources: { inode: number }[] }
      if (kind === "missing") rmSync(row.receipt_path)
      else {
        if (kind === "check") changed.id = "foreign-check"
        if (kind === "candidate") changed.artifact = f.attempt.base_commit
        if (kind === "isolation") isolation.resources[0]!.inode++
        writeFileSync(row.receipt_path, JSON.stringify(changed))
      }
      await f.runtime.stop()
      f.store.repository.close()
      const repository = new TaskRepository(join(f.state, "tasks.sqlite"), f.root)
      const store = new RunnerStore(repository)
      store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
      const runtime = new TaskRuntime(store, f.host, "project", undefined, {
        requestTick: async () => {},
      })
      cleanups.unshift(async () => {
        await runtime.stop()
        repository.close()
      })
      const reopenedControl = await registeredPlanCommand(runtime)
      const command = {
        requestID: "cancel-after-receipt-cut",
        planID: f.planID,
        expectedVersion: store.plan(f.planID)!.version,
        action,
      }
      const worktreesBefore = [...f.worktreeCreations]
      const spawn = spyOn(Bun, "spawn")
      try {
        await reopenedControl.execute(command)
        await runtime.tick()
        const events = () =>
          store
            .activity(f.planID, f.task.id)
            .filter((entry) => entry.event === "RETAINED_VERIFICATION_CHECK_COMPLETED")
        const saved = store.atomic((db) =>
          db
            .query<{ state: string; receipt: string; cleanup_state: string }, [string]>(
              "SELECT state,receipt,cleanup_state FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
            )
            .get(requested.operationID),
        )!
        expect(saved.state).toBe(kind === "valid" ? "completed" : "uncertain")
        expect(events()).toHaveLength(kind === "valid" ? 1 : 0)
        if (kind === "valid") {
          expect(JSON.parse(saved.receipt)).toEqual(original)
          expect(saved.cleanup_state).toBe("complete")
          expect(JSON.parse(events()[0]!.payload)).toMatchObject({
            operationID: requested.operationID,
            phase: "task",
            exitCode: 0,
            timedOut: false,
            passed: true,
            cancelled: true,
          })
          expect(existsSync(row.context_path)).toBe(false)
          await reopenedControl.execute(command)
        } else {
          expect(existsSync(row.context_path)).toBe(true)
          const resources = store.atomic((db) =>
            db
              .query<{ state: string }, [string]>(
                "SELECT state FROM runner_retained_verification_resources WHERE operation_id=?",
              )
              .all(requested.operationID),
          )
          expect(resources.length).toBeGreaterThan(0)
          expect(resources.every((resource) => resource.state === "uncertain")).toBe(true)
        }
        await runtime.tick()
        expect(events()).toHaveLength(kind === "valid" ? 1 : 0)
        expect(store.plan(f.planID)?.state).toBe(
          action === "cancel" ? (kind === "valid" ? "cancelled" : "cancelling") : "blocked",
        )
        expect(store.nodes(f.planID)[0]?.state).not.toBe("accepted")
        expect(f.prompts).toHaveLength(1)
        expect(f.worktreeCreations).toEqual(worktreesBefore)
        if (action === "cancel" && kind === "valid") {
          // Terminal cleanup now uses main's async read-only dirty-tree probe.
          // Allow that exact probe, but still forbid replaying any check process.
          // Read-only change-identity probes (tree, patch-id, notes, containment) are not a check replay.
          const identityStamping = new Set([
            "config",
            "diff",
            "log",
            "merge-base",
            "merge-tree",
            "notes",
            "patch-id",
            "remote",
            "ls-files",
            "worktree",
            "rev-parse",
          ])
          const replayed = spawn.mock.calls.filter(([argument]) => {
            const cmd = (argument as { cmd?: string[] }).cmd
            // Full-fidelity status observations (untracked included) are read-only probes.
            if (cmd?.[0] === "git" && cmd[1] === "status" && cmd.includes("--untracked-files=all"))
              return false
            return !(cmd?.[0] === "git" && identityStamping.has(cmd[1] ?? ""))
          })
          expect(replayed).toHaveLength(1)
          expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({
              cmd: ["git", "status", "--porcelain"],
              cwd: f.attempt.workspace,
            }),
          )
        } else {
          // Read-only Git observations are not a check replay.
          const readOnly = new Set([
            "worktree",
            "status",
            "rev-parse",
            "merge-base",
            "diff",
            "ls-files",
          ])
          expect(
            spawn.mock.calls.filter(([argument]) => {
              const cmd = (argument as { cmd?: string[] }).cmd
              return !(cmd?.[0] === "git" && readOnly.has(cmd[1] ?? ""))
            }),
          ).toHaveLength(0)
        }
        expect(verificationActivitiesForDatabase(repository.path)).toHaveLength(0)
      } finally {
        spawn.mockRestore()
      }
    },
    30_000,
  )

test.each([false, true])(
  "retained completion events survive receipt-cut reopen=%s exactly once",
  async (receiptCut) => {
    for (const failRetainedCheck of [false, true]) {
      const f = await failedFixture({ failRetainedCheck, requestTick: async () => {} })
      const control = await registeredPlanCommand(f.runtime)
      const result = (await control.execute(retainedVerifyCommand(f, "completion-event"))) as {
        operationID: string
      }
      let runtime = f.runtime
      let store = f.store
      let reopened: TaskRepository | undefined
      try {
        if (receiptCut) {
          const activity = await waitForRetainedCheckActivity(f, result.operationID)
          await activity.settled
          expect(activity.state).toBe("completed")
          // Process death after the disk receipt, before its DB application.
          forgetVerificationActivity(activity.key, activity.identity)
          expect(
            f.store
              .activity(f.planID, f.task.id)
              .filter((entry) => entry.event === "RETAINED_VERIFICATION_CHECK_COMPLETED"),
          ).toHaveLength(0)
          await f.runtime.stop()
          f.store.repository.close()
          reopened = new TaskRepository(join(f.state, "tasks.sqlite"), f.root)
          store = new RunnerStore(reopened)
          store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
          runtime = new TaskRuntime(store, f.host, "project", undefined, {
            requestTick: async () => {},
          })
        }
        for (let tick = 0; tick < 30; tick++) {
          await runtime.tick()
          const operation = store.atomic((db) =>
            db
              .query<{ state: string }, [string]>(
                "SELECT state FROM runner_retained_verifications WHERE id=?",
              )
              .get(result.operationID),
          )!
          if (["accepted", "failed"].includes(operation.state)) break
          await Promise.all(
            verificationActivitiesForDatabase(store.repository.path).map((entry) => entry.settled),
          )
        }
        const events = () =>
          store
            .activity(f.planID, f.task.id)
            .filter((entry) => entry.event === "RETAINED_VERIFICATION_CHECK_COMPLETED")
            .map((entry) => JSON.parse(entry.payload))
        expect(events()).toHaveLength(1)
        for (const event of events())
          expect(event).toMatchObject({
            operationID: result.operationID,
            cancelled: false,
            exitCode: failRetainedCheck ? 1 : 0,
            timedOut: false,
            passed: !failRetainedCheck,
            artifact: expect.any(String),
            workspace: expect.any(String),
          })
        const before = events()
        await runtime.tick()
        await runtime.tick()
        expect(events()).toEqual(before)
        expect(f.prompts).toHaveLength(1)
      } finally {
        if (reopened) {
          await runtime.stop()
          reopened.close()
        }
      }
    }
  },
  60_000,
)

test.each(["cancel"] as const)(
  "%s and database reopen cannot accept a late retained-check result",
  async (action) => {
    const delayedCheck = "bun run verify"
    // The worker's first run fails deterministically; isolated retained verification
    // then waits behind an explicit filesystem barrier until cancellation.
    const delayed = await failedFixture({
      taskCheckCommand: delayedCheck,
      verificationScript: [
        'import { appendFileSync, existsSync, mkdirSync, watch } from "node:fs"',
        'import { join } from "node:path"',
        "if (!process.env.LAZERS_VERIFICATION_SQLITE) process.exit(1)",
        "const home = process.env.HOME!",
        "mkdirSync(home, { recursive: true })",
        'appendFileSync(join(home, "started"), "started\\n")',
        'const release = join(home, "release")',
        "await new Promise<void>((resolve) => {",
        "  if (existsSync(release)) return resolve()",
        "  const watcher = watch(home, (_event, filename) => {",
        '    if (filename === "release" && existsSync(release)) { watcher.close(); resolve() }',
        "  })",
        "  if (existsSync(release)) { watcher.close(); resolve() }",
        "})",
        "",
      ].join("\n"),
    })
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
    void verifying.catch(() => undefined)
    await waitForFixtureObservation(delayed, "retained operation admission", () =>
      Boolean(
        delayed.store.atomic((db) =>
          db
            .query<{ id: string }, []>("SELECT id FROM runner_retained_verifications LIMIT 1")
            .get(),
        ),
      ),
    )
    const operation = delayed.store.atomic((db) =>
      db.query<{ id: string }, []>("SELECT id FROM runner_retained_verifications LIMIT 1").get(),
    )!
    let contextPath: string | undefined
    await waitForFixtureObservation(delayed, "retained subprocess start witness", () => {
      const check = delayed.store.atomic((db) =>
        db
          .query<{ context_path: string }, [string]>(
            "SELECT context_path FROM runner_retained_verification_checks WHERE operation_id=? AND state='intended'",
          )
          .get(operation.id),
      )
      if (check) {
        contextPath = check.context_path
        return existsSync(join(contextPath, "home", "started"))
      }
      return false
    })
    expect(existsSync(join(contextPath!, "home", "started"))).toBe(true)
    const control = await registeredPlanCommand(delayed.runtime)
    await control.execute({
      requestID: "cancel-retained-during-check",
      planID: delayed.planID,
      expectedVersion: plan.version,
      action,
      reason: "Stop the isolated check and retain its actual result without acceptance",
    })
    await waitForRetainedOperationState(
      delayed,
      operation.id,
      ["cancelled"],
      "retained check cancellation",
    )
    await verifying
    const cancelled = delayed.store.atomic((db) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_retained_verifications WHERE id=?",
        )
        .get(operation.id),
    )!
    expect(JSON.parse(cancelled.payload).state).toBe("cancelled")
    const cancelledCheck = delayed.store.atomic((db) =>
      db
        .query<{ state: string; cleanup_state: string; receipt: string | null }, [string]>(
          "SELECT state,cleanup_state,receipt FROM runner_retained_verification_checks WHERE operation_id=? AND phase='task'",
        )
        .get(operation.id),
    )!
    expect(cancelledCheck).toMatchObject({ state: "completed", cleanup_state: "complete" })
    if (!cancelledCheck.receipt) throw new Error("Cancelled check did not retain its actual result")
    const cancelledReceipt = JSON.parse(cancelledCheck.receipt) as CheckReceipt
    expect(cancelledReceipt.exitCode === 0 && !cancelledReceipt.timedOut).toBe(false)
    expect(delayed.store.plan(delayed.planID)?.state).toBe(
      action === "cancel" ? "cancelled" : "blocked",
    )
    const completionEvents = () =>
      delayed.store
        .activity(delayed.planID, delayed.task.id)
        .filter((entry) => entry.event === "RETAINED_VERIFICATION_CHECK_COMPLETED")
    expect(completionEvents()).toHaveLength(1)
    await delayed.runtime.tick()
    expect(completionEvents()).toHaveLength(1)
    expect(delayed.store.attempts(delayed.planID)).toHaveLength(1)
    expect(delayed.prompts).toHaveLength(1)

    await delayed.runtime.stop()
    delayed.store.repository.close()
    const reopenedRepository = new TaskRepository(join(delayed.state, "tasks.sqlite"), delayed.root)
    const reopenedStore = new RunnerStore(reopenedRepository)
    const reopenedRuntime = new TaskRuntime(reopenedStore, delayed.host, "project")
    await waitForFixtureCondition(
      delayed,
      "cancelled retained operation after reopen",
      () => {
        const row = reopenedStore.atomic((db) =>
          db
            .query<{ payload: string }, [string]>(
              "SELECT payload FROM runner_retained_verifications WHERE id=?",
            )
            .get(operation.id),
        )
        return Boolean(row && JSON.parse(row.payload).state === "cancelled")
      },
      60_000,
      () => reopenedRuntime.tick(),
    )
    expect(
      reopenedStore.atomic((db) =>
        db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM runner_retained_verifications WHERE id=?",
          )
          .get(operation.id),
      ),
    ).toMatchObject({ payload: expect.stringContaining('"state":"cancelled"') })
    expect(reopenedStore.attempts(delayed.planID)).toHaveLength(1)
    expect(delayed.prompts).toHaveLength(1)
    await reopenedRuntime.stop()
    reopenedRepository.close()
  },
  30_000,
)

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
    // F-S5-3: RPC responsiveness alone did not prove the scheduler drain could advance.
    const drain = await Promise.race([
      f.runtime.tick().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2_000)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    expect(drain).toBe(true)
    expect(released).toBe(false)
    released = true
    releaseSetup.resolve()
    const result = (await verification) as { operationID: string }
    await waitForRetainedOperationState(
      f,
      result.operationID,
      ["accepted"],
      "retained verification after dependency setup",
    )
    expect(installCalls).toBe(1)
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
  await waitForFixtureObservation(
    f,
    "installer descendant process",
    () => {
      if (existsSync(descendantPIDPath)) {
        const value = readFileSync(descendantPIDPath, "utf8")
        if (/^\d+$/.test(value)) {
          const parsed = Number(value)
          if (Number.isSafeInteger(parsed) && parsed > 0) runningDescendantPID = parsed
        }
      }
      return runningDescendantPID > 0 && processIsAlive(runningDescendantPID)
    },
    30_000,
    async () => {},
  )
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
      action: "cancel",
      reason: "Cancel the isolated dependency setup before any check launches",
    },
    "owner",
  )
  await verification
  // Plan cancellation aborts the call; the installer settles and its setup is removed on the runtime's own ticks.
  await waitForFixtureCondition(
    f,
    "cancelled dependency setup settled",
    () =>
      descendantPID !== undefined &&
      f.store.atomic((db) =>
        db
          .query<{ state: string }, [string]>(
            "SELECT state FROM runner_retained_verification_resources WHERE operation_id=?",
          )
          .all(operation.id)
          .every((row) => row.state === "removed"),
      ),
  )

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
      await waitForFixtureObservation(
        f,
        "installer heartbeat",
        () => existsSync(heartbeatPath),
        30_000,
        async () => {},
      )
      expect(existsSync(heartbeatPath)).toBe(true)
      expect(() => process.kill(installer.pid, 0)).not.toThrow()
      if (cancelBeforeRestart) {
        const cancel = {
          requestID: "cancel-before-reopen-with-live-installer",
          planID: f.planID,
          expectedVersion: f.store.plan(f.planID)!.version,
          action: "cancel" as const,
          reason: "Cancel before runtime restart with installer termination unknown",
        }
        expect(await f.runtime.command(cancel, "owner")).toMatchObject({ status: "cancelling" })
        expect(await f.runtime.command(cancel, "owner")).toMatchObject({ status: "cancelling" })
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
        state: cancelBeforeRestart ? "cancelled" : "failed",
        failureReason: expect.stringContaining(
          cancelBeforeRestart
            ? "Plan cancellation requested"
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
  // F-S5-3: admission returns before the background setup has settled.
  await waitForRetainedOperationState(f, operation.id, ["failed"], "Injected setup cleanup")

  const held = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(operation.id),
  )!
  expect(JSON.parse(held.payload)).toMatchObject({
    state: "failed",
    failureReason: expect.stringContaining("injected dependency setup failure"),
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

test("verify-retained runs on the current candidate however far the plan version has moved", async () => {
  const f = await failedCandidateFixture({ requestTick: async () => {} })
  const requested = await f.control.execute(
    retainedVerifyCommand(f, "verify-before-the-version-moves"),
  )
  const operationID = String(requested.operationID)
  const admitted = f.store.plan(f.planID)!.version
  // Other work on the plan moves its version while the call is pending. A call once stranded
  // on "retained operation binds plan version 43, while the plan is now version 59".
  f.store.atomic((db) =>
    db.query("UPDATE runner_plans SET version=version+16 WHERE id=?").run(f.planID),
  )
  expect(f.store.plan(f.planID)!.version).toBe(admitted + 16)

  await waitForRetainedOperationState(
    f,
    operationID,
    ["accepted", "failed"],
    "retained verification after the plan version moved",
  )
  const row = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_retained_verifications WHERE id=?",
      )
      .get(operationID),
  )!
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  expect(payload).toMatchObject({ state: "accepted", artifact: f.artifact })
  for (const retired of ["generation", "planVersion", "inputFingerprint", "holdReason"])
    expect(payload).not.toHaveProperty(retired)
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(
    f.store.latestTransition(f.planID, f.task.id, "RETAINED_CANDIDATE_ACCEPTED"),
  ).toMatchObject({ operationID })
  expect(f.prompts).toHaveLength(1)
}, 60_000)

test("a failed verify-retained records the failure and the next call verifies the same commit afresh", async () => {
  const f = await failedCandidateFixture({
    requestTick: async () => {},
    verificationScript: [
      'import { existsSync } from "node:fs"',
      'import { join } from "node:path"',
      "if (!process.env.LAZERS_VERIFICATION_SQLITE) process.exit(1)",
      `if (!existsSync(${JSON.stringify(join(tmpdir(), "retained-recheck-release"))})) process.exit(1)`,
      "",
    ].join("\n"),
    taskCheckCommand: "bun run verify",
    candidateContentsCheck: false,
  })
  const release = join(tmpdir(), "retained-recheck-release")
  rmSync(release, { force: true })
  cleanups.push(() => rmSync(release, { force: true }))
  const first = await f.control.execute(retainedVerifyCommand(f, "verify-then-fail"))
  const firstID = String(first.operationID)
  await waitForRetainedOperationState(f, firstID, ["failed"], "first retained verification")
  const failed = JSON.parse(
    f.store.atomic((db) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_retained_verifications WHERE id=?",
        )
        .get(firstID),
    )!.payload,
  ) as { state: string; failureReason: string }
  expect(failed.state).toBe("failed")
  expect(failed.failureReason).toBeString()
  expect(f.store.nodes(f.planID)[0]?.state).toBe("failed")
  expect(f.store.plan(f.planID)?.state).toBe("blocked")

  // Nothing holds or waits: a new call on the same commit runs, and passes now.
  writeFileSync(release, "ok\n")
  const second = await f.control.execute(retainedVerifyCommand(f, "verify-again"))
  const secondID = String(second.operationID)
  expect(secondID).not.toBe(firstID)
  await waitForRetainedOperationState(f, secondID, ["accepted"], "second retained verification")
  expect(f.store.nodes(f.planID)[0]?.state).toBe("accepted")
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM runner_retained_verifications WHERE plan_id=?",
          )
          .get(f.planID)!.n,
    ),
  ).toBe(2)
}, 60_000)
