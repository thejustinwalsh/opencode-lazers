import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
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
import { UNCERTAIN_EFFECT_RECEIPT_SCHEMA } from "./startup-recovery.ts"
import { TaskRuntime as ProductionTaskRuntime } from "./runtime.ts"
import type { FallowReview } from "./fallow-check.ts"
import type { AuditorReport } from "./auditor-report.ts"
import type { FallowReviewResult } from "../audit/review.ts"
import type { FallowPackage } from "../audit/contract.ts"
import { setFallowConfig } from "../audit/config.ts"
import { RunnerStore } from "./store.ts"
import { PlanInput } from "./schema.ts"
import type { WorkerPersona } from "./schema.ts"
import type { OutcomeInboxEntry } from "./inbox.ts"
import { isOwnedQueuedOutcome } from "./inbox.ts"
import { verificationActivitiesForDatabase } from "./verification-activities.ts"
import { registerRunnerTools } from "./tools.ts"
import { settleVerification } from "../../test/runner/verification-driver.ts"

export const cleanPackage: FallowPackage = {
  verdict: "pass",
  base: "base",
  config: { source: "lazers", classesNotChecked: [] },
  thresholds: { cyclomatic: 20, cognitive: 15 },
  findings: [],
  summary: { errors: 0, warnings: 0, inherited: 0 },
  timings: { elapsedMs: 1 },
}

export const cleanFallowResult: FallowReviewResult = { status: "clean", package: cleanPackage }

/** Tests do not load the native analyzer: every runtime reviews clean unless a test injects one. */
export class TaskRuntime extends ProductionTaskRuntime {
  constructor(...args: ConstructorParameters<typeof ProductionTaskRuntime>) {
    const [store, host, projectID, progress, options = {}] = args
    super(store, host, projectID, progress, {
      fallowReviewRun: async () => cleanFallowResult,
      fallowPlanReviewRun: async () => cleanFallowResult,
      auditorReportRun: async () => undefined,
      ...options,
    })
  }
}

export type RegisteredRunnerTool = Parameters<ToolEditor["add"]>[0]

export const cleanup: Array<() => void | Promise<void>> = []

/** Call once at the top of each test file: it runs the registered cleanups after every test. */
export function useRuntimeFixtureCleanup() {
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn()
  })
}

export function fixture(
  options: {
    fail?: boolean
    missingEvidence?: boolean
    outside?: boolean
    /** Extra files the worker writes (null deletes); `attempt` limits one attempt number. */
    writes?: { path: string; content: string | null; attempt?: number }[]
    createScope?: { path: string; purpose: string }[]
    protectedScope?: string[]
    shared?: boolean
    commit?: boolean
    repair?: boolean
    wrongFirstB?: boolean
    skillSuggestions?: string[]
    workerAgent?: "auditor"
    workerModel?: { providerID: string; id: string; variant?: string }
    personas?: (WorkerPersona | undefined)[]
    startOnly?: boolean
    independent?: boolean
    delayed?: boolean
    wrongFirstA?: boolean
    allowScopeOverlap?: boolean
    taskFiles?: { name: string; path: string; scope?: string[] }[]
    requireVerifierPreparation?: boolean
    loseWorktreeResponse?: boolean | "empty-error"
    architectIdleWindowMs?: number
    autoResume?: boolean
    architectPromptHook?: boolean
    wakeScheduler?: () => void
    now?: () => number
    workerNoProgressWindowMs?: number
    cancelIdleWaitMs?: number
    checkCommand?: string | ((name: string, path: string, root: string) => string)
    beforeCheck?: string
    combinedCheckCommand?: string
    additionalCombinedCheckCommand?: string
    verificationTimeoutDefaults?: { inactivityTimeoutMs: number; hardTimeoutMs: number }
    useProjectVerificationDefaults?: boolean
    fallowReview?: "on" | "off"
    /** "none" leaves the project without a Fallow config (the default stores one). */
    fallowConfig?: "none"
    fallowReviewRun?: FallowReview
    fallowPlanReviewRun?: FallowReview
    auditorReportRun?: AuditorReport
    takeover?: { handoffWindowMs: number; stopWaitMs: number; pollMs: number }
    workerSpendCeilingTokens?: number
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-runner-")))
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
  if (!options.shared) writeFileSync(join(root, "dirty-sentinel.txt"), "preserve me")
  const stateDirectory = options.shared
    ? mkdtempSync(join(tmpdir(), "lazers-shared-data-"))
    : join(root, "data")
  const repository = new TaskRepository(join(stateDirectory, "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  const metadata = new Map<string, { name: string; path: string }>()
  const createTask = (
    name: string,
    path = `${name}.txt`,
    scope: string[] = [path],
    failing = false,
  ) => {
    const proposal = validProposal()
    proposal.objective = `Write ${path}`
    proposal.writeScope = scope
    if (options.createScope) proposal.createScope = options.createScope
    if (options.protectedScope) proposal.protectedScope = options.protectedScope
    proposal.verification = [
      ...(options.beforeCheck
        ? [
            {
              id: "before",
              command: options.beforeCheck,
              timeoutMs: 1000,
              ...(options.useProjectVerificationDefaults
                ? {}
                : { inactivityTimeoutMs: 1000, hardTimeoutMs: 1000 }),
            },
          ]
        : []),
      {
        id: "content",
        command:
          (typeof options.checkCommand === "function"
            ? options.checkCommand(name, path, root)
            : options.checkCommand) ??
          (options.fail && failing ? "exit 7" : `test "$(cat ${path})" = "${name}"`),
        timeoutMs: 1000,
        ...(options.useProjectVerificationDefaults
          ? {}
          : { inactivityTimeoutMs: 1000, hardTimeoutMs: 1000 }),
      },
    ]
    proposal.acceptance = [
      {
        id: "correct",
        assertion: `${name} exists with exact content`,
        evidence: [
          { kind: "verification", verificationID: "content" },
          ...(options.missingEvidence
            ? [{ kind: "artifact" as const, reference: "evidence/never-produced.md" }]
            : []),
        ],
      },
    ]
    proposal.requirements.skills = options.skillSuggestions ?? []
    proposal.limits.maxRepairAttempts = options.repair ? 1 : 0
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
    metadata.set(task.id, { name, path })
    return task
  }
  const taskFiles: { name: string; path: string; scope?: string[] }[] =
    options.taskFiles ?? ["a", "b"].map((name) => ({ name, path: `${name}.txt` }))
  const tasks = taskFiles.map((file, index) =>
    createTask(file.name, file.path, file.scope ?? [file.path], index === 0),
  )
  const sessions = new Map<string, HostSession>()
  sessions.set("owner", {
    id: "owner",
    projectID: "project",
    directory: root,
    agent: "architect",
    archived: false,
    busy: false,

    model: { providerID: "openai", id: "subscription", variant: "high" },
    tokens: null,
    tools: 0,
    cost: null,
    messages: [],
  })
  const events: string[] = []
  const notifications: { sessionID: string; id: string; text: string; resume: boolean }[] = []
  const instructions = new Map<string, Map<string, string>>()
  const inbox = new Map<string, OutcomeInboxEntry[]>()
  const admissionOwners = new Map<string, string>()
  const host: RunnerHost = {
    workerModel: async () => options.workerModel ?? { providerID: "openai", id: "test-model" },
    worktree: async ({ directory, base }) => {
      git(root, ["worktree", "add", "--detach", directory, base])
      if (options.loseWorktreeResponse) {
        const emptyError = options.loseWorktreeResponse === "empty-error"
        options.loseWorktreeResponse = false
        throw new Error(emptyError ? "" : "worktree response lost")
      }
      return directory
    },
    worktrees: async () =>
      git(root, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice(9)),
    removeWorktree: async (directory) => {
      git(root, ["worktree", "remove", directory])
    },
    session: async (id) => structuredClone(sessions.get(id) ?? null),
    create: async (input) => {
      events.push(`create:${input.id}`)
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

        tokens: 100,
        tools: 1,
        cost: null,
        messages: [],
      })
    },
    createArchitect: async (input) => {
      events.push(`create-architect:${input.id}`)
      sessions.set(input.id, {
        id: input.id,
        parentID: input.parentID,
        projectID: "project",
        directory: input.directory,
        agent: "architect",
        metadata: {
          lazersContinuation: true,
          lazersPlanID: input.planID,
          ...(input.planIDs ? { lazersPlanIDs: input.planIDs } : {}),
          lazersSourceSessionID: input.sourceSessionID,
        },
        model: input.model,
        archived: false,
        busy: false,

        tokens: 0,
        tools: 0,
        cost: null,
        messages: [],
      })
    },
    updateSession: async ({ sessionID, archived }) => {
      const session = sessions.get(sessionID)
      if (!session) throw new Error("Native session not found")
      events.push(`update-session:${sessionID}:${archived}`)
      session.archived = archived
    },
    prompt: async (input) => {
      events.push(`prompt:${input.id}`)
      expect(input.text).toContain("lz-get-task")
      expect(input.text).not.toContain('"specification"')
      expect(input.text).not.toContain("SECRET_SKILL_BODY_CANARY")
      expect("skills" in input).toBe(false)
      expect(input.text.length).toBeLessThan(1200)
      const session = sessions.get(input.sessionID)!
      session.messages.push({ id: input.id, text: input.text })
      session.turn = {
        inputID: input.id,
        state: options.delayed ? "pending" : "completed",
      }
      const assigned = store
        .activeProjectAttempts()
        .find((attempt) => attempt.session_id === input.sessionID)!
      const info = metadata.get(assigned.task_id)!
      const path = info.path
      if (path === "b.txt" && !options.independent && !options.taskFiles)
        expect(readFileSync(join(session.directory, "a.txt"), "utf8")).toBe("a")
      const wrongFirstB = options.wrongFirstB && path === "b.txt" && assigned.number === 1
      const wrongFirstA = options.wrongFirstA && info.name === "a" && assigned.number === 1
      if (wrongFirstB) {
        session.tokens = 65941
        session.tools = 17
        session.cost = 1.25
      }
      mkdirSync(dirname(join(session.directory, path)), { recursive: true })
      writeFileSync(join(session.directory, path), wrongFirstA || wrongFirstB ? "wrong" : info.name)
      if (options.outside) writeFileSync(join(session.directory, "escape.txt"), "bad")
      for (const write of options.writes ?? []) {
        if (write.attempt !== undefined && write.attempt !== assigned.number) continue
        const target = join(session.directory, write.path)
        if (write.content === null) rmSync(target, { force: true })
        else {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, write.content)
        }
      }
      if (options.shared || options.commit) {
        const checkout = session.directory
        git(checkout, ["add", path])
        if (git(checkout, ["status", "--porcelain"]))
          git(checkout, [
            "-c",
            "user.name=fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            `Implement ${path}`,
          ])
      }
      if (options.delayed) {
        session.busy = true
        events.push(`start:${session.id}`)
      } else session.outcome = "succeeded"
    },
    updateInstruction: async (input) => {
      const effect = store
        .plans()
        .flatMap((plan) => store.effects(plan.id))
        .find(
          (item) => item.kind === "scope-instruction" && JSON.parse(item.payload).key === input.key,
        )
      expect(effect?.state).toMatch(/intended|uncertain/)
      const target = sessions.get(input.sessionID)
      if (
        !target ||
        target.archived ||
        target.projectID !== input.projectID ||
        target.directory !== input.directory ||
        target.metadata?.lazersAttemptID !== input.attemptID
      )
        throw new Error("Scope instruction target is not the owned worker attempt")
      const entries = instructions.get(input.sessionID) ?? new Map<string, string>()
      if (entries.get(input.key) === input.text) return
      entries.set(input.key, input.text)
      instructions.set(input.sessionID, entries)
      events.push(`instruction:${input.key}`)
    },
    outcomeInbox: async (targetSessionID) => structuredClone(inbox.get(targetSessionID) ?? []),
    architectInputPage: async (targetSessionID) => ({
      inbox: structuredClone(inbox.get(targetSessionID) ?? []).map((entry) => ({
        id: entry.id,
        type: entry.type,
        ...(entry.delivery ? { delivery: entry.delivery } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      })),
      messages: (sessions.get(targetSessionID)?.messages ?? []).map((message) => ({
        id: message.id,
        type: message.type ?? "user",
        ...(message.metadata ? { metadata: message.metadata } : {}),
      })),
      nextCursor: null,
    }),
    cancelOutcome: async (input) => {
      const entries = inbox.get(input.sessionID) ?? []
      const index = entries.findIndex((entry) => entry.id === input.inboxID)
      const entry = entries[index]
      if (!entry || !isOwnedQueuedOutcome(entry, input.ownership))
        throw new Error("Fixture refused to cancel unowned or non-queued input")
      entries.splice(index, 1)
      events.push(`cancel:${input.inboxID}`)
    },
    notify: async (input) => {
      const admittedTo = admissionOwners.get(input.id)
      if (admittedTo && admittedTo !== input.sessionID)
        throw new Error("Native lifecycle conflict: message ID belongs to another session")
      admissionOwners.set(input.id, input.sessionID)
      events.push(`notify:${input.id}`)
      notifications.push({
        sessionID: input.sessionID,
        id: input.id,
        text: input.text,
        resume: input.resume,
      })
      const entries = inbox.get(input.sessionID) ?? []
      if (!entries.some((entry) => entry.id === input.id))
        entries.push({
          id: input.id,
          type: "synthetic",
          delivery: "queue",
          ...(input.metadata ? { metadata: input.metadata } : {}),
        })
      inbox.set(input.sessionID, entries)
    },
    interrupt: async (id) => {
      sessions.get(id)!.busy = false
      sessions.get(id)!.outcome = "interrupted"
      if (sessions.get(id)!.turn)
        sessions.get(id)!.turn = {
          inputID: sessions.get(id)!.turn!.inputID,
          state: "interrupted",
        }
      events.push(`stop:${id}`)
    },
    waitForSession: async () => {},
  }
  if (options.fallowConfig !== "none")
    setFallowConfig(
      store.repository,
      { entry: [] },
      { sessionID: "fixture", agent: "architect" },
      "fixture project config",
    )
  const runtime = new TaskRuntime(store, host, "project", undefined, {
    architectIdleWindowMs: options.architectIdleWindowMs,
    autoResumeInterrupted: options.autoResume ?? false,
    ...(options.fallowReview ? { fallowReview: options.fallowReview } : {}),
    ...(options.fallowReviewRun ? { fallowReviewRun: options.fallowReviewRun } : {}),
    ...(options.fallowPlanReviewRun ? { fallowPlanReviewRun: options.fallowPlanReviewRun } : {}),
    ...(options.auditorReportRun ? { auditorReportRun: options.auditorReportRun } : {}),
    architectPromptHook: options.architectPromptHook,
    wakeScheduler: options.wakeScheduler,
    ...(options.verificationTimeoutDefaults === undefined
      ? {}
      : { verificationTimeoutDefaults: options.verificationTimeoutDefaults }),
    now: options.now,
    ...(options.workerNoProgressWindowMs === undefined
      ? {}
      : { workerNoProgressWindowMs: options.workerNoProgressWindowMs }),
    ...(options.cancelIdleWaitMs === undefined
      ? {}
      : { cancelIdleWaitMs: options.cancelIdleWaitMs }),
    ...(options.workerSpendCeilingTokens === undefined
      ? {}
      : { workerSpendCeilingTokens: options.workerSpendCeilingTokens }),
    ...(options.takeover
      ? {
          takeoverHandoffWindowMs: options.takeover.handoffWindowMs,
          takeoverStopWaitMs: options.takeover.stopWaitMs,
          takeoverPollMs: options.takeover.pollMs,
        }
      : {}),
    requestTick: () =>
      verificationActivitiesForDatabase(repository.path).length
        ? Promise.resolve()
        : runtime.tick(),
  })
  const inputFor = (
    selected: typeof tasks,
    config: {
      requestID?: string
      dependencies?: [number, number][]
      allowScopeOverlap?: boolean
    } = {},
  ) => {
    const files = selected.map((task) => metadata.get(task.id)!)
    const dependencies =
      config.dependencies ??
      (!options.independent
        ? files.slice(1).map((_, index) => [index, index + 1] as [number, number])
        : [])
    return {
      requestID: config.requestID ?? "plan-request",
      draft: true as const,
      objective: `Implement ${files.map((file) => file.name).join(" and ")}`,
      ...(options.workerAgent ? { workerAgent: options.workerAgent } : {}),
      workspaceMode: options.shared ? ("shared" as const) : ("isolated" as const),
      baseCommit: base,
      ...(options.workerModel ? { workerModel: options.workerModel } : {}),
      nodes: selected.map((task) => {
        const persona = options.personas?.[tasks.indexOf(task)]
        return { taskID: task.id, revision: 1 as const, ...(persona ? { persona } : {}) }
      }),
      dependencies: dependencies.map(([prerequisite, successor]) => ({
        prerequisite: selected[prerequisite]!.id,
        successor: selected[successor]!.id,
      })),
      integrationOrder: selected.map((task) => task.id),
      verification: [
        {
          id: "combined",
          command:
            options.combinedCheckCommand ??
            `${options.requireVerifierPreparation ? `test -f '${join(stateDirectory, "verifier-ready")}' && ` : ""}test "$(cat ${files.map((file) => file.path).join(" ")})" = "${files.map((file) => file.name).join("")}"`,
          timeoutMs: 1000,
          ...(options.useProjectVerificationDefaults
            ? {}
            : { inactivityTimeoutMs: 1000, hardTimeoutMs: 1000 }),
        },
        ...(options.additionalCombinedCheckCommand
          ? [
              {
                id: "combined-second",
                command: options.additionalCombinedCheckCommand,
                timeoutMs: 1000,
                ...(options.useProjectVerificationDefaults
                  ? {}
                  : { inactivityTimeoutMs: 1000, hardTimeoutMs: 1000 }),
              },
            ]
          : []),
      ],
      acceptance: [
        {
          id: "combined",
          assertion: "All accepted changes coexist",
          evidence: [{ kind: "verification" as const, verificationID: "combined" }],
        },
      ],
      ...(config.allowScopeOverlap
        ? {
            dispositions: selected.flatMap((task, index) =>
              selected.slice(index + 1).map((other) => ({
                taskID: task.id,
                otherTaskID: other.id,
                relation: "supplements" as const,
                rationale: "The paths are intentionally scheduled sequentially in this fixture.",
              })),
            ),
          }
        : {}),
    }
  }
  const input = inputFor(tasks, { allowScopeOverlap: options.allowScopeOverlap })
  const receipt = options.startOnly ? undefined : store.submit(input, "owner")
  cleanup.push(async () => {
    await runtime.stop()
    repository.close()
    rmSync(`${realpathSync(root)}.worktrees`, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    if (options.shared) rmSync(stateDirectory, { recursive: true, force: true })
  })
  const completeWorker = (
    id: string,
    outcome: "succeeded" | "failed" | "interrupted" = "succeeded",
  ) => {
    const session = sessions.get(id)
    if (!session) throw new Error(`Missing worker ${id}`)
    session.busy = false
    session.outcome = outcome
    session.turn = {
      inputID: session.turn?.inputID ?? null,
      state: outcome === "succeeded" ? "completed" : "interrupted",
    }
    events.push(`stop:${id}`)
  }
  return {
    root,
    repository,
    store,
    tasks,
    sessions,
    events,
    notifications,
    instructions,
    host,
    inbox,
    runtime,
    input,
    receipt: receipt!,
    inputFor,
    createTask,
    completeWorker,
    base,
  }
}

export async function drive(runtime: TaskRuntime, count = 8) {
  for (let n = 0; n < count; n++) {
    await settleVerification(runtime)
  }
}

export async function registeredPlanCommand(runtime: TaskRuntime, sessionID = "owner") {
  const tools = new Map<string, RegisteredRunnerTool>()
  const editor = {
    add: (tool: RegisteredRunnerTool) => tools.set(tool.name, tool),
  } as unknown as ToolEditor
  const context = {
    permission: { assert: () => Effect.void },
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
    execute: async (input: unknown) =>
      Effect.runPromise(
        tool.execute(input, {
          sessionID: sessionID as never,
          agent: Agent.ID.make("architect"),
          messageID: SessionMessage.ID.make("msg_test"),
          id: Tool.CallID.make("call_test"),
          progress: () => Effect.void,
        } as Parameters<RegisteredRunnerTool["execute"]>[1]),
      ),
  }
}

export async function waitForPath(path: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for subprocess barrier: ${path}`)
}

export async function retainedSourceFixture() {
  const f = fixture({ delayed: true, commit: true, taskFiles: [{ name: "a", path: "shared.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id)
  const worker = f.sessions.get(attempt.session_id)!
  Object.assign(worker, {
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
  })
  const artifact = git(attempt.workspace, ["rev-parse", "HEAD"])
  const effectID = crypto.randomUUID()
  f.store.move(f.receipt.planID, attempt.task_id, "VERIFY")
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='verifying',artifact=? WHERE id=?").run(
      artifact,
      attempt.id,
    )
    db.query("UPDATE runner_nodes SET artifact=? WHERE task_id=?").run(artifact, attempt.task_id)
    db.query(
      "UPDATE runner_plans SET state='blocked',reason='Retained check is uncertain' WHERE id=?",
    ).run(f.receipt.planID)
    // An uncertain check without a receipt re-runs; a durable interrupted receipt keeps it uncertain.
    const receiptPath = join(f.root, "retained-check.json")
    const verification = f.tasks[0]!.proposal.verification[0]!
    const interrupted = {
      id: verification.id,
      command: verification.command,
      cwd: attempt.workspace,
      artifact,
      inputIdentity: "retained-check",
      environmentIdentity: "retained-check",
      startedAt: 1,
      endedAt: 2,
      exitCode: null,
      timedOut: false,
      aborted: true,
      stdout: "",
      stderr: "",
    }
    writeFileSync(receiptPath, JSON.stringify(interrupted))
    db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'uncertain',?,?,0)").run(
      effectID,
      f.receipt.planID,
      attempt.task_id,
      attempt.id,
      "verify:content",
      JSON.stringify({
        workspace: attempt.workspace,
        artifact,
        check: verification,
        identity: "retained-check",
        receiptPath,
      }),
      JSON.stringify({
        schema: UNCERTAIN_EFFECT_RECEIPT_SCHEMA,
        error: "Verification was interrupted before completion",
        result: { check: interrupted },
      }),
    )
  })
  const retained = f.store.attempts(f.receipt.planID)[0]!
  return {
    ...f,
    retained,
    worker,
    artifact,
    effectID,
  }
}

/** The `task-accepted` outcome's scope review, from the delivered notice. */
export function acceptedScope(f: ReturnType<typeof fixture>, planID: string) {
  const rows = f.store.detail(planID).delivery as { payload: string }[]
  const accepted = rows
    .map((row) => JSON.parse(row.payload))
    .findLast((payload) => payload.status === "task-accepted")
  return accepted?.scope as
    | {
        created: { path: string; class: string; purpose?: string }[]
        missingExpected: { path: string; purpose: string }[]
        divergences: { path: string }[]
        accepted: { path: string; reason: string }[]
        warnings: unknown[]
      }
    | undefined
}

export const taskEvents = (
  f: ReturnType<typeof fixture>,
  planID: string,
  taskID: string,
  name: string,
) => f.store.activity(planID, taskID).filter((event) => event.event === name)

export async function runPlan(
  f: ReturnType<typeof fixture>,
  planID = f.receipt.planID,
  requestID = "run",
) {
  return f.runtime.command(
    {
      requestID,
      planID,
      action: "run",
    },
    "owner",
  )
}

export function expireRunnerLease(f: ReturnType<typeof fixture>) {
  f.store.atomic((db) =>
    db.query("UPDATE runner_leases SET expires_at=0 WHERE project_directory=?").run(f.root),
  )
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => (resolve = complete))
  return { promise, resolve }
}

/** Give the fixture's checkout a registered project with `code`, as registration would. */
export function codeProject(f: ReturnType<typeof fixture>, code: string) {
  f.repository.atomic((db) => {
    db.query("INSERT INTO lazers_projects(key,created_at,code,name) VALUES(?,?,?,?)").run(
      `path:${f.root}`,
      "2026-01-01",
      code,
      "fixture",
    )
    db.query("INSERT INTO lazers_project_paths(path,key,last_seen_at) VALUES(?,?,?)").run(
      f.root,
      `path:${f.root}`,
      "2026-01-01",
    )
  })
}

export function reopenRuntime(
  f: ReturnType<typeof fixture>,
  verificationTimeoutDefaults?: { inactivityTimeoutMs: number; hardTimeoutMs: number },
  wakeScheduler?: () => void,
) {
  const repository = new TaskRepository(f.repository.path, f.root)
  const store = new RunnerStore(repository)
  store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const runtime = new TaskRuntime(store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    verificationTimeoutDefaults,
    wakeScheduler,
  })
  cleanup.unshift(async () => {
    await runtime.stop()
    repository.close()
  })
  return { store, runtime }
}

export async function acceptPlan(
  f: ReturnType<typeof fixture>,
  planID: ReturnType<typeof crypto.randomUUID>,
) {
  await runPlan(f, planID, `run-${planID}`)
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(planID)[0]!
  f.completeWorker(attempt.session_id)
  await driveWithTaskSourceLandings(f, 6, planID)
  const plan = f.store.plan(planID)!
  expect(plan.state).toBe("accepted")
  return { plan, attempt }
}

export function includeArtifact(f: ReturnType<typeof fixture>, artifact: string) {
  const head = git(f.root, ["rev-parse", "HEAD"])
  try {
    git(f.root, ["merge-base", "--is-ancestor", artifact, head])
    return
  } catch {
    // The accepted artifact is not present in the selected branch yet.
  }
  try {
    git(f.root, ["merge-base", "--is-ancestor", head, artifact])
    git(f.root, ["merge", "--ff-only", artifact])
    return
  } catch {
    // Independent task branches need a reviewed merge commit.
  }
  git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "merge",
    "--no-edit",
    "--no-ff",
    artifact,
  ])
}

export async function integrateTaskSource(
  f: ReturnType<typeof fixture>,
  planID: string,
  taskID: string,
  runtime: TaskRuntime = f.runtime,
  requestID = `land-task-${planID}-${taskID}`,
) {
  const node = f.store.nodes(planID).find((candidate) => candidate.task_id === taskID)
  if (node?.state !== "accepted" || !node.artifact)
    throw new Error(`Expected accepted task source to integrate: ${taskID}`)
  includeArtifact(f, node.artifact)
  const plan = f.store.plan(planID)!
  return runtime.command(
    {
      requestID,
      planID,
      action: "integrated",
      taskID,
      artifact: node.artifact,
      targetBranch: git(f.root, ["branch", "--show-current"]),
      reason: "Review and land prerequisite task source for its dependent",
    },
    "owner",
  )
}

export async function driveWithTaskSourceLandings(
  f: ReturnType<typeof fixture>,
  count = 16,
  planID: string = f.receipt.planID,
  runtime: TaskRuntime = f.runtime,
) {
  for (let iteration = 0; iteration < count; iteration++) {
    await settleVerification(runtime)
    const plan = f.store.plan(planID)
    if (plan?.state === "accepted") break
    if (!plan || plan.state !== "running") continue
    const input = PlanInput.parse(JSON.parse(plan.body))
    const nodes = f.store.nodes(plan.id)
    const successorsWaiting = new Set(
      input.dependencies
        .filter((edge) => {
          const successor = nodes.find((node) => node.task_id === edge.successor)
          return successor && ["queued", "ready"].includes(successor.state)
        })
        .map((edge) => edge.prerequisite),
    )
    for (const taskID of successorsWaiting) {
      const prerequisite = nodes.find((node) => node.task_id === taskID)
      if (
        prerequisite?.state === "accepted" &&
        !f.store.latestTransition(plan.id, taskID, "TASK_INTEGRATION_RECORDED")
      )
        await integrateTaskSource(f, plan.id, taskID, runtime)
    }
  }
}

export async function recordPlanIntegration(
  f: ReturnType<typeof fixture>,
  planID: ReturnType<typeof crypto.randomUUID>,
  options: { recordTaskLanding?: boolean } = {},
) {
  const accepted = f.store.plan(planID)!
  if (options.recordTaskLanding) {
    const node = f.store.nodes(planID)[0]!
    await f.runtime.command(
      {
        requestID: `task-land-${planID}`,
        planID,
        action: "integrated",
        taskID: node.task_id,
        artifact: node.artifact!,
        targetBranch: "main",
        reason: "Record task-level landing before combined plan integration",
      },
      "owner",
    )
  }
  const plan = f.store.plan(planID)!
  await f.runtime.command(
    {
      requestID: `plan-land-${planID}`,
      planID,
      action: "integrated",
      artifact: plan.artifact!,
      targetBranch: "main",
      reason: "Record reviewed combined source integration",
    },
    "owner",
  )
}

export async function acceptAndIntegratePlan(
  f: ReturnType<typeof fixture>,
  planID: ReturnType<typeof crypto.randomUUID>,
  options: { recordTaskLanding?: boolean } = {},
) {
  const accepted = await acceptPlan(f, planID)
  includeArtifact(f, accepted.plan.artifact!)
  await recordPlanIntegration(f, planID, options)
  return accepted
}

export async function cleanupBlockedFixture() {
  const f = fixture({ commit: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await drive(f.runtime)
  const plan = f.store.plan(f.receipt!.planID)!
  expect(plan.state).toBe("accepted")
  const attempt = f.store.attempts(plan.id)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const artifact = plan.artifact!
  git(f.root, ["merge", "--ff-only", artifact])
  worker.busy = true
  await f.runtime.command(
    {
      requestID: "prepare-cleanup-diagnostics",
      planID: plan.id,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Prepare a blocked worker cleanup for diagnostics",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
  return { f, planID: plan.id, attempt, worker, artifact, workspace: attempt.workspace }
}

export const countTransitions = (f: ReturnType<typeof fixture>, planID: string, event: string) =>
  f.store.atomic(
    (db) =>
      db
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) AS count FROM runner_transitions WHERE plan_id=? AND event=?",
        )
        .get(planID, event)?.count ?? 0,
  )

export const outboxStates = (f: ReturnType<typeof fixture>) =>
  f.store.atomic((db) =>
    db
      .query<{ state: string; n: number }, []>(
        "SELECT state,COUNT(*) AS n FROM runner_outbox GROUP BY state ORDER BY state",
      )
      .all(),
  )

export const transitions = (f: ReturnType<typeof fixture>, planID: string, event: string) =>
  f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string, string]>(
        "SELECT payload FROM runner_transitions WHERE plan_id=? AND event=?",
      )
      .all(planID, event),
  )
