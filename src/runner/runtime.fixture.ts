import { allPlans } from "./store-plans.fixture.ts"
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
import type { FallowPackage, FallowFinding } from "../audit/contract.ts"
import { setFallowConfig } from "../audit/config.ts"
import { RunnerStore, type AttemptRow } from "./store.ts"
import { PlanInput } from "./schema.ts"
import type { WorkerPersona } from "./schema.ts"
import type { OutcomeInboxEntry } from "./inbox.ts"
import { isOwnedQueuedOutcome } from "./inbox.ts"
import { verificationActivitiesForDatabase } from "./verification-activities.ts"
import { registerRunnerTools } from "./tools.ts"
import { settleVerification } from "../../test/runner/verification-driver.ts"
import { setProjectSetting } from "../projects/settings.ts"
import { registerProject } from "../project-key.ts"
import type { RunnerCheckReceipt } from "./artifacts.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"

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

const RAW = Symbol("raw")
let sessionClock = 0

/**
 * A fixture session whose every change, however deep (`busy = true`, `messages.push(..)`), moves
 * its `updatedAt` the way the native `time.updated` moves, so tests need not remember to.
 */
function observedSession(root: HostSession): HostSession {
  const touch = () => {
    root.updatedAt = ++sessionClock
  }
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, key, receiver) {
        if (key === RAW) return object
        const value = Reflect.get(object, key, receiver)
        return typeof value === "object" && value !== null ? wrap(value) : value
      },
      set(object, key, value) {
        if (!(object === root && key === "updatedAt")) touch()
        return Reflect.set(object, key, value)
      },
      deleteProperty(object, key) {
        touch()
        return Reflect.deleteProperty(object, key)
      },
    })
  touch()
  return wrap(root)
}

/** The sessions map of a fixture host: stored sessions are observed, so mutations bump `updatedAt`. */
function observedSessions() {
  const sessions = new Map<string, HostSession>()
  const set = sessions.set.bind(sessions)
  sessions.set = (key, value) => set(key, observedSession(value))
  return sessions
}

/**
 * Observed sessions are proxies, which `structuredClone` refuses. Tests clone fixture sessions to
 * build variants, so a clone that fails on a proxy is retried on a plain copy of it.
 */
const nativeStructuredClone = globalThis.structuredClone
globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
  try {
    return nativeStructuredClone(value, options)
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "DataCloneError") throw error
    return nativeStructuredClone(unproxied(value), options)
  }
}) as typeof structuredClone

function unproxied(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unproxied)
  if (typeof value !== "object" || value === null) return value
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unproxied(entry)]))
}

function plainClone<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) return value.map(plainClone) as T
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, plainClone(entry)]),
  ) as T
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
  const sessions = observedSessions()
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
    session: async (id) => plainClone(sessions.get(id) ?? null),
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
      const effect = allPlans(store)
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
    architectInputPage: async (targetSessionID, cursor, known) => {
      const entries = structuredClone(inbox.get(targetSessionID) ?? [])
      const session = sessions.get(targetSessionID)
      const observation = {
        updatedAt: session?.updatedAt ?? 0,
        inbox: JSON.stringify(
          entries.map((entry) => ({
            id: entry.id,
            type: entry.type,
            delivery: entry.delivery ?? null,
          })),
        ),
      }
      if (
        !cursor &&
        known &&
        known.updatedAt === observation.updatedAt &&
        known.inbox === observation.inbox
      )
        return {
          inbox: [],
          messages: [],
          nextCursor: null,
          observation,
          unchanged: true,
          archived: session?.archived ?? false,
        }
      return {
        inbox: entries.map((entry) => ({
          id: entry.id,
          type: entry.type,
          ...(entry.delivery ? { delivery: entry.delivery } : {}),
          ...(entry.metadata ? { metadata: entry.metadata } : {}),
        })),
        messages: (session?.messages ?? []).map((message) => ({
          id: message.id,
          type: message.type ?? "user",
          ...(message.metadata ? { metadata: message.metadata } : {}),
        })),
        nextCursor: null,
        observation,
        archived: session?.archived ?? false,
      }
    },
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

export function setReviewInputObservation(
  f: ReturnType<typeof fixture>,
  attempt: AttemptRow,
  reviewInputID: string,
) {
  const ownedAttempt = attempt
  const worker = f.sessions.get(ownedAttempt.session_id)!
  const reviewRequestID = `review-${ownedAttempt.task_id}-${ownedAttempt.number}`
  worker.messages.push({
    id: reviewInputID,
    type: "synthetic",
    text: "Continue the already-assigned task after review.",
    metadata: {
      lazersReview: {
        taskID: ownedAttempt.task_id,
        attemptID: ownedAttempt.id,
        requestID: reviewRequestID,
      },
    },
  })
  worker.busy = false
  worker.pendingInput = false
  worker.pendingPermissions = 0
  worker.pendingForms = 0
  worker.outcome = "succeeded"
  worker.turn = { inputID: reviewInputID, state: "completed" }
  worker.model = JSON.parse(ownedAttempt.policy).model

  return { worker, reviewRequestID }
}

export async function heldReviewInputFixture() {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const reviewInputID = "msg_received_review_steer"
  const { worker, reviewRequestID } = setReviewInputObservation(f, attempt, reviewInputID)
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(f.store.plan(f.receipt.planID)?.reason).toContain("current assigned input")
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  return { f, attempt, worker, reviewInputID, reviewRequestID }
}

export function reviewInputCommand(
  f: ReturnType<typeof fixture>,
  attempt: AttemptRow,
  reviewInputID: string,
  requestID = "reconcile-review-steer",
) {
  return {
    requestID,
    planID: f.receipt.planID,
    action: "reconcile" as const,
    taskID: attempt.task_id,
    attemptID: attempt.id,
    reviewInputID,
  }
}

export async function holdInterruptedAttempt(f: ReturnType<typeof fixture>) {
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: attempt.message_id, state: "interrupted" }

  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.plan(planID)?.reason).toContain("Worker execution was interrupted")
  return { planID, attempt: f.store.attempts(planID)[0]!, worker }
}

export async function holdFailedAttempt(
  f: ReturnType<typeof fixture>,
  inputID?: string | null,
  outcome: HostSession["outcome"] = "failed",
) {
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = outcome
  worker.turn = {
    inputID: inputID === undefined ? attempt.message_id : inputID,
    state: "completed",
  }

  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  return { planID, attempt: f.store.attempts(planID)[0]!, worker }
}

export async function acceptedAttemptFixture(options: { syntheticTerminalInput?: boolean } = {}) {
  const f = fixture({
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt", scope: ["a.txt", "repair-notes.txt"] }],
  })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  await runPlan(f)
  await f.runtime.tick()
  const original = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(original.session_id)!
  if (options.syntheticTerminalInput) {
    const claim = f.runtime.progress.claimReminder(
      original.session_id,
      "Provide a concise handoff after the owned background shell completes.",
      SessionMessage.ID.create(),
    )
    if (!claim) throw new Error("Could not capture the owned synthetic worker input")
    expect(f.runtime.progress.finishReminder(claim, "admitted")).toBe(true)
    worker.messages.push({
      id: claim.messageID,
      type: "synthetic",
      text: "Provide a concise handoff after the owned background shell completes.",
      metadata: claim.ownership,
    })
    worker.turn = { inputID: claim.messageID, state: "completed" }
    worker.outcome = "succeeded"
  }
  await drive(f.runtime, 10)
  expect(f.store.plan(planID)?.state).toBe("accepted")
  const artifact = f.store.nodes(planID)[0]!.artifact!
  Object.assign(worker, {
    busy: false,
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    observationUnstable: false,
  })
  return { f, planID, task, original, artifact, worker }
}

export async function acceptedRetainedRepairFixture() {
  const {
    f,
    planID,
    task,
    original,
    artifact,
    worker: acceptedWorker,
  } = await acceptedAttemptFixture()
  await f.runtime.command(
    {
      requestID: "retained-repair-for-continuation",
      planID,
      action: "retained-repair",
      taskID: task.id,
      attemptID: original.id,
      artifact,
      reason: "The accepted parser misses the recovery edge case.",
    },
    "owner",
  )
  await f.runtime.tick()
  acceptedWorker.busy = false
  acceptedWorker.pendingInput = false
  acceptedWorker.pendingPermissions = 0
  acceptedWorker.pendingForms = 0
  acceptedWorker.observationUnstable = false
  const attempt = f.store.attempts(planID)[0]!
  const repair = f.store.latestRetainedRepair<{
    operationID: string
    messageID: string
    owner: string
  }>(planID, task.id)!
  return {
    f,
    planID,
    task,
    original,
    attempt,
    artifact,
    repair,
    worker: f.sessions.get(attempt.session_id)!,
  }
}

export async function reproduceLegacyRetainedRepairFenceFailure() {
  const state = await acceptedRetainedRepairFixture()
  const { f, planID, task, attempt, repair, worker } = state
  worker.tokens = 777
  worker.tools = 23
  worker.cost = 2.5
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: repair.messageID, state: "interrupted" }

  await f.runtime.tick()
  await f.runtime.stop()
  const reopened = reopenRuntime(f)
  const resume = {
    requestID: "reproduce-retained-repair-fence-failure",
    planID,
    action: "resume" as const,
    taskID: task.id,
    attemptID: attempt.id,
    reason: "Reproduce the historical authorized interrupted continuation.",
  }
  await reopened.runtime.command(resume, "owner")
  const failedReservation = reopened.store.attempts(planID)[0]!
  const firstResume = reopened.store
    .activity(planID, task.id)
    .filter((entry) => entry.event === "ATTEMPT_RESUMED")
    .at(-1)!
  const legacyPayload = JSON.parse(firstResume.payload) as Record<string, unknown>
  delete legacyPayload.retainedRepairContinuation
  reopened.store.atomic((db) =>
    db
      .query("UPDATE runner_transitions SET payload=? WHERE id=?")
      .run(JSON.stringify(legacyPayload), firstResume.id),
  )

  const legacyRuntime = Reflect.get(reopened.runtime, "repairRecords") as {
    retainedRepairForAttempt: (candidate: AttemptRow) => unknown
  }
  const currentLookup = legacyRuntime.retainedRepairForAttempt
  legacyRuntime.retainedRepairForAttempt = function (candidate) {
    const found = currentLookup.call(legacyRuntime, candidate) as
      { repairMessageID?: unknown } | undefined
    return found?.repairMessageID === candidate.message_id ? found : undefined
  }
  try {
    await reopened.runtime.tick()
    expect(reopened.store.plan(planID)?.reason).toBe(
      "Retained repair is missing a valid owner/control authorization fence",
    )
    await reopened.runtime.tick()
  } finally {
    legacyRuntime.retainedRepairForAttempt = currentLookup
  }
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(reopened.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    state: "cancelled",
    session_id: attempt.session_id,
    workspace: attempt.workspace,
    base_commit: attempt.base_commit,
    policy: attempt.policy,
    message_id: failedReservation.message_id,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
  return { ...state, reopened, failedReservation }
}

export type LegacyFenceState = Awaited<ReturnType<typeof reproduceLegacyRetainedRepairFenceFailure>>

export function recoveryCommand(state: LegacyFenceState, requestID: string) {
  return {
    requestID,
    planID: state.planID,
    action: "resume" as const,
    taskID: state.task.id,
    attemptID: state.attempt.id,
    reason: "Recover only the original retained repair after its proven fence failure.",
  }
}

export function recoveryAdmissionSnapshot(state: LegacyFenceState) {
  const plan = state.reopened.store.plan(state.planID)!
  return {
    version: plan.version,
    state: plan.state,
    owner: plan.owner,
    attempt: structuredClone(
      state.reopened.store
        .attempts(state.planID)
        .find((candidate) => candidate.id === state.attempt.id)!,
    ),
    resumes: state.reopened.store
      .activity(state.planID, state.task.id)
      .filter((entry) => entry.event === "ATTEMPT_RESUMED").length,
    promptEffects: state.reopened.store
      .effects(state.planID)
      .filter((effect) => effect.attempt_id === state.attempt.id && effect.kind === "prompt")
      .length,
    prompts: state.f.events.filter((event) => event.startsWith("prompt:")).length,
    creates: state.f.events.filter((event) => event.startsWith("create:")).length,
  }
}

export function expectNoRecoveryAdmission(
  state: LegacyFenceState,
  before: ReturnType<typeof recoveryAdmissionSnapshot>,
) {
  const plan = state.reopened.store.plan(state.planID)!
  expect({ version: plan.version, state: plan.state, owner: plan.owner }).toEqual({
    version: before.version,
    state: before.state,
    owner: before.owner,
  })
  expect(
    state.reopened.store
      .attempts(state.planID)
      .find((candidate) => candidate.id === state.attempt.id),
  ).toEqual(before.attempt)
  expect(
    state.reopened.store
      .activity(state.planID, state.task.id)
      .filter((entry) => entry.event === "ATTEMPT_RESUMED"),
  ).toHaveLength(before.resumes)
  expect(
    state.reopened.store
      .effects(state.planID)
      .filter((effect) => effect.attempt_id === state.attempt.id && effect.kind === "prompt"),
  ).toHaveLength(before.promptEffects)
  expect(state.f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(before.prompts)
  expect(state.f.events.filter((event) => event.startsWith("create:"))).toHaveLength(before.creates)
}

export async function pauseRecoveryAtWorktrees(state: LegacyFenceState, requestID: string) {
  const entered = deferred<void>()
  const release = deferred<void>()
  const originalWorktrees = state.f.host.worktrees
  state.f.host.worktrees = async () => {
    entered.resolve()
    await release.promise
    return originalWorktrees()
  }
  const command = recoveryCommand(state, requestID)
  const pending = state.reopened.runtime.command(command, "owner")
  await entered.promise
  return {
    command,
    pending,
    release: () => {
      release.resolve()
      state.f.host.worktrees = originalWorktrees
    },
  }
}

export async function prepareInterruptedCombinedCheck(
  options: {
    combinedCheckCommand?: string
    additionalCombinedCheckCommand?: string
    verificationTimeoutDefaults?: { inactivityTimeoutMs: number; hardTimeoutMs: number }
    reopenTimeoutDefaults?: { inactivityTimeoutMs: number; hardTimeoutMs: number }
    interruptedCheckID?: string
    legacyCompletedCheckID?: string
    wakeScheduler?: () => void
  } = {},
) {
  const f = fixture({
    taskFiles: [{ name: "a", path: "a.txt" }],
    combinedCheckCommand:
      options.combinedCheckCommand ??
      "printf started > .lazers-combined-started; while [ ! -f .lazers-combined-release ]; do sleep 0.02; done; exit 0",
    ...(options.additionalCombinedCheckCommand
      ? { additionalCombinedCheckCommand: options.additionalCombinedCheckCommand }
      : {}),
    ...(options.verificationTimeoutDefaults
      ? {
          useProjectVerificationDefaults: true,
          verificationTimeoutDefaults: options.verificationTimeoutDefaults,
        }
      : {}),
  })
  await runPlan(f)
  let interruptedEffect: ReturnType<RunnerStore["effects"]>[number] | undefined
  for (let index = 0; index < 30; index++) {
    await f.runtime.tick()
    const effect = f.store
      .effects(f.receipt.planID)
      .find(
        (candidate) =>
          candidate.kind === `graph-verify:${options.interruptedCheckID ?? "combined"}`,
      )
    const activity = effect
      ? verificationActivitiesForDatabase(f.repository.path).find(
          (candidate) => candidate.metadata.effectID === effect.id,
        )
      : undefined
    if (effect && activity?.state === "running") {
      interruptedEffect = effect
      break
    }
    const activeChecks = verificationActivitiesForDatabase(f.repository.path).filter(
      (candidate) =>
        candidate.metadata.planID === f.receipt.planID && candidate.state === "running",
    )
    await Promise.all(activeChecks.map((candidate) => candidate.settled))
  }
  if (!interruptedEffect) throw new Error("Combined verification did not start")
  const payload = JSON.parse(interruptedEffect.payload) as {
    workspace: string
    receiptPath: string
  }
  await waitForPath(join(payload.workspace, ".lazers-combined-started"))
  let legacyReceipt: string | null = null
  if (options.legacyCompletedCheckID) {
    const legacyEffect = f.store
      .effects(f.receipt.planID)
      .find((candidate) => candidate.kind === `graph-verify:${options.legacyCompletedCheckID}`)
    if (!legacyEffect?.receipt) throw new Error("Completed combined check receipt is missing")
    const legacyPayload = JSON.parse(legacyEffect.payload) as Record<string, unknown>
    delete legacyPayload.authoredCheck
    delete legacyPayload.verificationDeadline
    f.store.atomic((db) =>
      db
        .query("UPDATE runner_effects SET payload=? WHERE id=?")
        .run(JSON.stringify(legacyPayload), legacyEffect.id),
    )
    legacyReceipt = legacyEffect.receipt
  }
  await f.runtime.stop()
  rmSync(join(payload.workspace, ".lazers-combined-started"), { force: true })
  rmSync(join(payload.workspace, ".lazers-combined-release"), { force: true })

  const reopened = reopenRuntime(f, options.reopenTimeoutDefaults, options.wakeScheduler)
  await drive(reopened.runtime, 4)
  const interrupted = reopened.store
    .effects(f.receipt.planID)
    .find((candidate) => candidate.id === interruptedEffect.id)!
  if (interrupted.state !== "uncertain")
    throw new Error("Combined interruption was not durably reconciled as uncertain")
  return {
    f,
    reopened,
    interrupted,
    receiptPath: payload.receiptPath,
    planID: f.receipt.planID,
    legacyReceipt,
  }
}

export async function prepareAfterPlanDependency(
  f: ReturnType<typeof fixture>,
  requestID: string,
  priority = 10,
  holdCleanup = false,
) {
  const parentID = f.receipt.planID
  const childTask = f.createTask("b", "b.txt")
  const child = f.store.submit(
    {
      ...f.inputFor([childTask], { requestID }),
      afterPlans: [parentID],
      priority,
    },
    "owner",
  )
  await runPlan(f, child.planID, `${requestID}-run`)
  const accepted = await acceptPlan(f, parentID)
  includeArtifact(f, accepted.plan.artifact!)
  if (holdCleanup)
    writeFileSync(join(accepted.attempt.workspace, "keep-owned-worktree.txt"), "still owned")
  await recordPlanIntegration(f, parentID)
  return { parentID, child, accepted }
}

export async function cancelUnstartedPlan(
  f: ReturnType<typeof fixture>,
  planID = f.receipt.planID,
) {
  await runPlan(f, planID, `run-${planID}`)
  const plan = f.store.plan(planID)!
  await f.runtime.command(
    {
      requestID: `cancel-${planID}`,
      planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  return f.store.plan(planID)!
}

export async function failSecondSharedTask(f: ReturnType<typeof fixture>) {
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await driveWithTaskSourceLandings(f)
  const attempts = f.store.attempts(f.receipt.planID)
  const predecessor = attempts.find((attempt) => attempt.task_id === f.tasks[0]!.id)!
  const failed = attempts.find((attempt) => attempt.task_id === f.tasks[1]!.id)!
  if (!predecessor.artifact || !failed.artifact)
    throw new Error("Expected predecessor and failed worker artifacts")
  expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
  expect(predecessor.state).toBe("accepted")
  expect(failed.state).toBe("failed")
  expect(failed.base_commit).toBe(predecessor.artifact)
  expect(failed.artifact).toBeTruthy()
  return { predecessor, failed }
}

export function attemptCheck(
  f: ReturnType<typeof fixture>,
  taskID: string,
  attemptID: string,
): RunnerCheckReceipt {
  const effect = f.store
    .effects(f.receipt.planID)
    .find(
      (candidate) =>
        candidate.task_id === taskID &&
        candidate.attempt_id === attemptID &&
        candidate.kind === "verify:content",
    )
  if (!effect?.receipt) throw new Error(`Missing verification receipt for ${attemptID}`)
  expect(effect.state).toBe("completed")
  return (JSON.parse(effect.receipt) as { check: RunnerCheckReceipt }).check
}

export const skillBodyCanary = "SECRET_SKILL_BODY_CANARY"

export function seedLegacySkillBody(
  f: ReturnType<typeof fixture>,
  attempt: ReturnType<RunnerStore["attempts"]>[number],
) {
  const policy = JSON.parse(attempt.policy) as Record<string, unknown>
  const context = JSON.parse(policy.context as string) as Record<string, unknown>
  const body = [{ id: "legacy-skill", path: "/old/SKILL.md", content: skillBodyCanary }]
  policy.skills = body
  context.skills = body
  policy.context = JSON.stringify(context)
  delete policy.packet
  const serialized = JSON.stringify(policy)
  f.store.atomic((db) =>
    db.query("UPDATE runner_attempts SET policy=? WHERE id=?").run(serialized, attempt.id),
  )
  attempt.policy = serialized
  return serialized
}

export function expectNoSkillBody(policyText: string) {
  expect(policyText).not.toContain(skillBodyCanary)
  const policy = JSON.parse(policyText) as Record<string, unknown>
  expect(policy.skills).toBeUndefined()
  expect(JSON.parse(policy.context as string)).not.toHaveProperty("skills")
}

/** A shell-check effect: the runtime's own Fallow review is journaled beside these. */
export const authoredVerifyEffect = (effect: { kind: string }) =>
  effect.kind.startsWith("verify:") && effect.kind !== "verify:fallow-audit"

export function fallowFinding(
  file: string,
  line: number,
  extra: Partial<FallowFinding> = {},
): FallowFinding {
  return {
    id: `duplication:code-duplication:${file}`,
    rule: "code-duplication",
    class: "duplication",
    severity: "warn",
    attribution: "introduced",
    file,
    line,
    endLine: line + 8,
    message: "cloned block",
    suggestion: "Reuse the existing helper.",
    ...extra,
  }
}

export function reviewOf(...findings: FallowFinding[]): FallowReviewResult {
  const live = findings.filter((f) => f.attribution !== "inherited")
  const errors = live.filter((f) => f.severity === "error").length
  return {
    status: live.length ? "findings" : "clean",
    package: {
      ...cleanPackage,
      verdict: errors ? "fail" : live.length ? "warn" : "pass",
      findings,
      summary: { errors, warnings: live.length - errors, inherited: findings.length - live.length },
    },
  }
}

/** Scripted reviews: each call takes the next result and the last one repeats. */
export function scriptedReview(...results: FallowReviewResult[]) {
  const calls: number[] = []
  const bases: string[] = []
  const run: FallowReview = async (input) => {
    calls.push(Date.now())
    bases.push(input.baseCommit)
    return results[Math.min(calls.length, results.length) - 1]!
  }
  return { run, calls, bases }
}

export const introducedResult = reviewOf

export function taskAcceptedOutcomes(f: ReturnType<typeof fixture>) {
  return (f.store.detail(f.receipt.planID).delivery as { payload: string }[])
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
    .filter((payload) => payload.status === "task-accepted")
}

export const singleTask = [{ name: "a", path: "a.txt" }]

export function planAcceptedOutcomes(f: ReturnType<typeof fixture>) {
  return (f.store.detail(f.receipt.planID).delivery as { payload: string }[])
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
    .filter((payload) => payload.status === "accepted")
}

export function planLevelRecords(f: ReturnType<typeof fixture>, event: string) {
  return f.store.read((db) =>
    db
      .query<{ payload: string }, [string, string]>(
        "SELECT payload FROM runner_transitions WHERE plan_id=? AND task_id IS NULL AND event=?",
      )
      .all(f.receipt.planID, event),
  )
}

export const planFallowEffects = (f: ReturnType<typeof fixture>) =>
  f.store.effects(f.receipt.planID).filter((effect) => effect.kind === "graph-verify:fallow-audit")

export async function acceptedMergedFixture(options: { clock?: { offset: number } } = {}) {
  const clock = options.clock
  const f = fixture({
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    ...(clock ? { now: () => Date.now() + clock.offset } : {}),
  })
  await runPlan(f)
  await drive(f.runtime)
  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.state).toBe("accepted")
  const attempt = f.store.attempts(plan.id)[0]!
  git(f.root, ["merge", "--ff-only", plan.artifact!])
  const integrate = (requestID: string) =>
    f.runtime.command(
      {
        requestID,
        planID: plan.id,
        action: "integrated",
        artifact: plan.artifact!,
        targetBranch: "main",
        reason: "Merged reviewed artifact",
      },
      "owner",
    )
  return { f, plan, attempt, worker: f.sessions.get(attempt.session_id)!, integrate }
}

export type HeldReviewInput = Awaited<ReturnType<typeof heldReviewInputFixture>>

export const invalidReviewInputs: {
  name: string
  mutate: (context: HeldReviewInput) => void
}[] = [
  {
    name: "wrong task metadata",
    mutate: ({ worker, reviewInputID }) => {
      worker.messages.find((message) => message.id === reviewInputID)!.metadata!.lazersReview = {
        taskID: crypto.randomUUID(),
        attemptID: "wrong-attempt",
        requestID: "review-request",
      }
    },
  },
  {
    name: "wrong attempt metadata",
    mutate: ({ attempt, worker, reviewInputID }) => {
      worker.messages.find((message) => message.id === reviewInputID)!.metadata!.lazersReview = {
        taskID: attempt.task_id,
        attemptID: crypto.randomUUID(),
        requestID: "review-request",
      }
    },
  },
  {
    name: "missing review metadata",
    mutate: ({ worker, reviewInputID }) => {
      worker.messages.find((message) => message.id === reviewInputID)!.metadata = { forged: true }
    },
  },
  {
    name: "absent native message",
    mutate: ({ worker, reviewInputID }) => {
      worker.messages = worker.messages.filter((message) => message.id !== reviewInputID)
    },
  },
  {
    name: "unrelated latest input",
    mutate: ({ worker }) => {
      worker.turn = { inputID: "msg_unrelated_latest_input", state: "completed" }
    },
  },
  {
    name: "wrong session",
    mutate: ({ worker }) => {
      worker.id = "ses_foreign_worker"
    },
  },
  {
    name: "wrong project",
    mutate: ({ worker }) => {
      worker.projectID = "foreign-project"
    },
  },
  {
    name: "wrong workspace",
    mutate: ({ worker }) => {
      worker.directory = "/foreign/workspace"
    },
  },
  {
    name: "wrong attempt session metadata",
    mutate: ({ worker }) => {
      worker.metadata = { lazersAttemptID: crypto.randomUUID() }
    },
  },
  {
    name: "wrong model route",
    mutate: ({ worker }) => {
      worker.model = { providerID: "other-provider", id: "other-model" }
    },
  },
  {
    name: "running shell",
    mutate: ({ worker }) => {
      worker.runningShells = 1
    },
  },
  {
    name: "active child session",
    mutate: ({ worker }) => {
      worker.activeChildren = 1
    },
  },
  {
    name: "active foreground",
    mutate: ({ worker }) => {
      worker.busy = true
    },
  },
  {
    name: "pending native input",
    mutate: ({ worker }) => {
      worker.pendingInput = true
    },
  },
  {
    name: "pending turn",
    mutate: ({ worker, reviewInputID }) => {
      worker.turn = { inputID: reviewInputID, state: "pending" }
    },
  },
  {
    name: "pending approval",
    mutate: ({ worker }) => {
      worker.pendingPermissions = 1
    },
  },
  {
    name: "pending form",
    mutate: ({ worker }) => {
      worker.pendingForms = 1
    },
  },
  {
    name: "unstable observation",
    mutate: ({ worker }) => {
      worker.observationUnstable = true
    },
  },
]

export async function prepareIdleArchitect(
  f: ReturnType<typeof fixture>,
  now: number,
  idleFor: number,
  notice = true,
) {
  await runPlan(f)
  await drive(f.runtime, 2)
  const owner = f.sessions.get("owner")!
  owner.busy = false
  owner.idleAt = now - idleFor
  // Renewal is judged only for plans awaiting an Architect; its tokens are unknown, so a cold cache is large.
  f.store.atomic((db) =>
    db
      .query(
        "UPDATE runner_plans SET state='blocked',reason='Awaiting Architect judgement' WHERE id=?",
      )
      .run(f.receipt.planID),
  )
  await f.runtime.recordArchitectContinuity(owner.id, {
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  // Renewal is decided when news waits for the Architect: queue the hold's notice.
  if (notice) queueArchitectNotice(f)
  return f.store.attempts(f.receipt.planID)[0]!
}

let architectNotices = 0
/** A new pending notice for the fixture plan's Architect, as a fresh hold would queue. */
export function queueArchitectNotice(f: ReturnType<typeof fixture>, planID = f.receipt.planID) {
  const plan = f.store.plan(planID)!
  ;(
    Reflect.get(f.runtime, "journal") as {
      outcome(id: string, payload: unknown, resume: boolean): void
    }
  ).outcome(
    planID,
    { status: plan.state, reason: `${plan.reason ?? "update"} (${++architectNotices})` },
    true,
  )
}

export function withoutDraft<T extends { draft?: unknown }>(input: T): Omit<T, "draft"> {
  const { draft: _draft, ...rest } = input
  return rest
}

export function countArchitectContact(f: ReturnType<typeof fixture>) {
  const created: string[] = []
  const create = f.host.createArchitect!
  f.host.createArchitect = async (input) => {
    created.push(input.id)
    return create(input)
  }
  return { created }
}

/** Plans that share the fixture Architect, each with an outcome of its own to report. */
export function architectBacklog(f: ReturnType<typeof fixture>, size: number) {
  const ids = Array.from({ length: size }, (_, index) => `backlog-${index}`)
  f.store.atomic((db) => {
    const clone = db.query(`INSERT INTO runner_plans
      SELECT ?,project_directory,owner,revision,version,'blocked',body,model,'held',artifact
      FROM runner_plans WHERE id=?`)
    for (const id of ids) clone.run(id, f.receipt.planID)
  })
  const emit = (planID: string, payload: Record<string, unknown>) =>
    (
      Reflect.get(f.runtime, "journal") as {
        outcome(id: string, payload: unknown, resume: boolean): void
      }
    ).outcome(planID, payload, true)
  const deliver = async () => {
    const fence = f.store.claim(f.runtime.owner)!
    return (
      f.runtime as unknown as { outcomeDelivery: { deliver(fence: number): Promise<boolean> } }
    ).outcomeDelivery.deliver(fence)
  }
  return { ids, emit, deliver }
}

export function handOverPlan(f: ReturnType<typeof fixture>, planID: string) {
  f.sessions.set("owner-2", { ...f.sessions.get("owner")!, id: "owner-2", messages: [] })
  f.store.updatePlanOwner(planID, "owner", "owner-2")
}

export async function cancelRunningPlan(f: ReturnType<typeof fixture>, requestID: string) {
  await f.runtime.command(
    {
      requestID,
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
}

export async function idleCancelFixture(clock: { now: number }) {
  const f = fixture({
    shared: false,
    delayed: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    now: () => clock.now,
    workerNoProgressWindowMs: 0,
    cancelIdleWaitMs: 30_000,
  })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id, "interrupted")
  return { f, attempt, session: f.sessions.get(attempt.session_id)! }
}

export const known = (value: string) => ({ status: "known" as const, value })

export function workerHandoffDraft() {
  return {
    target: {
      outcome: known("a.txt holds the task name"),
      originalUserIntent: { status: "unknown" as const },
      workerInterpretation: known("write a.txt"),
      contractReferences: [],
    },
    completedWork: [{ summary: "Committed a first version of a.txt", evidence: [] }],
    partialWork: [],
    workspaceState: known("a.txt committed with the wrong content"),
    approaches: [{ approach: "wrote a.txt", result: known("content check fails"), evidence: [] }],
    failure: {
      status: "observed" as const,
      behavior: known("the content check fails"),
      cause: "implementation" as const,
      evidence: [],
    },
    assumptions: [],
    evidence: [],
    preservedObligations: [],
    remainingWork: known("write the right content"),
    remainingDecisions: { status: "not-applicable" as const },
    reportedOwnership: {
      writerActivity: known("stopping"),
      backgroundActivity: known("none"),
      unresolvedNativeEffects: known("none"),
      reportedQuiescence: "idle" as const,
    },
  }
}

export const fastTakeover = { handoffWindowMs: 200, stopWaitMs: 50, pollMs: 5 }

export async function takeoverFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture({
    delayed: true,
    wrongFirstA: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    takeover: fastTakeover,
    ...options,
  })
  await runPlan(f)
  await f.runtime.tick()
  const worker = f.store.attempts(f.receipt.planID)[0]!
  expect(f.sessions.get(worker.session_id)!.busy).toBe(true)
  const steered: string[] = []
  return { f, worker, steered }
}

export function commitWorkInProgress(worker: AttemptRow) {
  git(worker.workspace, ["add", "-A"])
  git(worker.workspace, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "WIP before takeover",
  ])
}

/** A worker that still uses the full reviewed handoff draft is read as the worker's account. */
export function workerWritesHandoff(
  f: ReturnType<typeof fixture>,
  worker: AttemptRow,
  requestID: string,
) {
  commitWorkInProgress(worker)
  new HandoffStore(f.repository).saveDraft(
    { requestID, draftID: crypto.randomUUID(), draft: workerHandoffDraft() },
    {
      sessionID: worker.session_id,
      agent: String(JSON.parse(worker.policy).agent),
      role: "worker",
    },
  )
}

export async function submitTakeover(
  f: ReturnType<typeof fixture>,
  taskID: string,
  requestID: string,
  sessionID = "owner",
) {
  return f.runtime.command(
    {
      requestID,
      planID: f.receipt.planID,
      action: "takeover-submit",
      taskID,
      reason: "Architect result",
    },
    sessionID,
  )
}

export async function registeredKey(f: ReturnType<typeof fixture>) {
  return (await registerProject(f.repository, { directory: f.root, opencodeProjectID: "project" }))
    .key
}

export async function capacityLimit(f: ReturnType<typeof fixture>, limit: number | undefined) {
  setProjectSetting(f.repository, await f.runtime.delegatedAgentCapacity.key(), "limit", limit)
}
