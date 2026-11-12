import { createRetainedVerification, retainedVerification } from "./retained-verification/store.ts"
import { afterEach, expect, spyOn, test } from "bun:test"
import { DateTime, Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { spawnSync } from "node:child_process"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { nativeHost, type NativeInboxClient } from "./native.ts"
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
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { checkResourcesSettled, combineArtifacts, git } from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import type {
  ArchitectSourceResult,
  HostBackgroundObservation,
  HostSession,
  RunnerHost,
} from "./host.ts"
import { DEFAULT_ARCHITECT_IDLE_WINDOW_MS, TaskRuntime, architectIdleWindowMs } from "./runtime.ts"
import { RunnerStore, type AttemptRow } from "./store.ts"
import { matchesReviewInputAlias, parseReviewInputAlias } from "./review-input.ts"
import { PlanInput } from "./schema.ts"
import type { WorkerPersona } from "./schema.ts"
import { TaskReads } from "../tasks/read.ts"
import { taskInstructions } from "../tasks/instructions.ts"
import type { OutcomeInboxEntry } from "./inbox.ts"
import { isOwnedQueuedOutcome } from "./inbox.ts"
import { sharedScheduler, schedulerProjectKey } from "./scheduler-coordinator.ts"
import {
  registerSourceGuard,
  sourceGuardInstalled,
  sourceQuarantine,
  sourceReservationExcluded,
  sourceQuarantineToolError,
} from "./source-quarantine.ts"
import { inspectPlan } from "./inspection.ts"
import { privacyStats } from "../trajectory/privacy.ts"
import { ModelMappingStore } from "../models/mapping-store.ts"
import {
  forgetVerificationActivity,
  startVerificationActivity,
  verificationActivitiesForDatabase,
  verificationActivityKey,
} from "./verification-activities.ts"
import { registerRunnerTools } from "./tools.ts"
import { settleVerification } from "../../test/runner/verification-driver.ts"

type RegisteredRunnerTool = Parameters<ToolEditor["add"]>[0]

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})
function fixture(
  options: {
    fail?: boolean
    human?: boolean
    outside?: boolean
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
    architectPromptHook?: boolean
    now?: () => number
    checkCommand?: string | ((name: string, path: string, root: string) => string)
    beforeCheck?: string
    combinedCheckCommand?: string
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
    proposal.verification = [
      ...(options.beforeCheck
        ? [{ id: "before", command: options.beforeCheck, timeoutMs: 1000 }]
        : []),
      {
        id: "content",
        command:
          (typeof options.checkCommand === "function"
            ? options.checkCommand(name, path, root)
            : options.checkCommand) ??
          (options.fail && failing ? "exit 7" : `test "$(cat ${path})" = "${name}"`),
        timeoutMs: 1000,
      },
    ]
    proposal.acceptance = [
      {
        id: "correct",
        assertion: `${name} exists with exact content`,
        evidence: [
          { kind: "verification", verificationID: "content" },
          ...(options.human ? [{ kind: "human" as const, decision: "review" }] : []),
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
    background: {
      state: "observed",
      source: "experimental.idle",
      observedAt: Date.now(),
      inputID: "owner-input",
      executionStartSequence: 1,
      eventSequence: 1,
      count: 0,
      kinds: { shell: 0, subagent: 0, image: 0 },
    },
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
        background: {
          state: "observed",
          source: "experimental.idle",
          observedAt: Date.now(),
          inputID: "unassigned-input",
          executionStartSequence: 1,
          eventSequence: 1,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
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
        background: {
          state: "observed",
          source: "experimental.idle",
          observedAt: Date.now(),
          inputID: "unassigned-input",
          executionStartSequence: 1,
          eventSequence: 1,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        tokens: 0,
        tools: 0,
        cost: null,
        messages: [],
      })
    },
    ensureSourceGuard: async ({ directory }) => {
      if (!sourceGuardInstalled(store, directory))
        throw new Error("Native worker source guard is not installed")
    },
    archiveRetainedWorker: async ({ sessionID }) => {
      const session = sessions.get(sessionID)
      if (!session) throw new Error("Native session not found")
      events.push(`archive-retained:${sessionID}`)
      session.archived = true
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
      if (session.background?.state === "observed") session.background.inputID = input.id
      const assigned = store
        .activeProjectAttempts()
        .find((attempt) => attempt.session_id === input.sessionID)!
      if (session.background?.state === "observed")
        Object.assign(session.background, {
          projectDirectory: root,
          projectID: "project",
          attemptID: assigned.id,
          sessionID: assigned.session_id,
          workspace: assigned.workspace,
          assignedMessageID: assigned.message_id,
          executionStartSequence: 1,
          eventSequence: 2,
          terminalSequence: 3,
          terminalEventID: `event-${input.id}`,
          terminalMessageID: `idle-${input.id}`,
        })
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
  const runtime = new TaskRuntime(store, host, "project", undefined, {
    architectIdleWindowMs: options.architectIdleWindowMs,
    architectPromptHook: options.architectPromptHook,
    now: options.now,
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
        },
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
async function drive(runtime: TaskRuntime, count = 8) {
  for (let n = 0; n < count; n++) {
    await settleVerification(runtime)
  }
}

async function registeredPlanCommand(runtime: TaskRuntime) {
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
          sessionID: "owner" as never,
          agent: Agent.ID.make("architect"),
          messageID: SessionMessage.ID.make("msg_test"),
          id: Tool.CallID.make("call_test"),
          progress: () => Effect.void,
        } as Parameters<RegisteredRunnerTool["execute"]>[1]),
      ),
  }
}

async function waitForPath(path: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for subprocess barrier: ${path}`)
}

async function retainedSourceFixture() {
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
    background: {
      state: "unknown",
      source: "experimental.idle",
      reason: "Old background lineage unavailable",
    },
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
    db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'uncertain',?,NULL,0)").run(
      effectID,
      f.receipt.planID,
      attempt.task_id,
      attempt.id,
      "verify:content",
      JSON.stringify({
        workspace: attempt.workspace,
        artifact,
        check: f.tasks[0]!.proposal.verification[0],
        identity: "retained-check",
        receiptPath: join(f.root, "missing-retained-check.json"),
      }),
    )
  })
  const retained = f.store.attempts(f.receipt.planID)[0]!
  const command = (requestID = crypto.randomUUID()) => ({
    requestID,
    planID: f.receipt.planID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    action: "quarantine-source",
    attemptID: attempt.id,
    reason: "Retain unknown check resources while excluding this source writer",
  })
  let guardID: string | undefined
  const install = (store = f.store) => {
    const unregister = registerSourceGuard(store, attempt.workspace)
    cleanup.push(unregister)
    guardID = unregister.registrationID
    return unregister
  }
  return {
    ...f,
    retained,
    worker,
    artifact,
    effectID,
    command,
    install,
    get guardID() {
      return guardID
    },
  }
}

function attachNativeQuarantineHost(
  f: Pick<
    Awaited<ReturnType<typeof retainedSourceFixture>>,
    "worker" | "retained" | "repository" | "root" | "host" | "guardID"
  >,
  options: {
    target?: Partial<HostSession>
    active?: boolean
    unavailable?: boolean
    loseReply?: boolean
    onUpdate?: () => void
    onObserve?: () => void
    probe?: () => Promise<
      Partial<{
        pid: number
        projectID: string
        directory: string
        databasePath: string
        registrationID: string
      }>
    >
  } = {},
) {
  let archives = 0
  let probes = 0
  const target = () => {
    const current = { ...f.worker, ...options.target }
    return {
      ...current,
      location: { directory: current.directory },
      time: { ...(current.archived ? { archived: DateTime.nowUnsafe() } : {}) },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
  }
  const list = async ({ location }: { location: { directory: string } }) => ({
    location,
    data: [],
  })
  const client = {
    rpc: () => ({
      status: async (_input: unknown, request: { location: { directory: string } }) => {
        probes++
        expect(request.location.directory).toBe(f.retained.workspace)
        const changes = await options.probe?.()
        return {
          pid: 42,
          projectID: "project",
          directory: f.retained.workspace,
          databasePath: f.repository.path,
          registrationID: f.guardID,
          ...changes,
        }
      },
    }),
    server: { info: async () => ({ pid: 42, version: "2.2.5" }) },
    session: {
      get: async () => target(),
      active: async () => {
        options.onObserve?.()
        if (options.unavailable) throw new Error("Native observation unavailable")
        return options.active ? { [f.retained.session_id]: { type: "running" } } : {}
      },
      inbox: { list: async () => [] },
      update: async () => {
        archives++
        f.worker.archived = true
        options.onUpdate?.()
        if (options.loseReply) throw new Error("Archive reply lost")
      },
      message: {
        get: async ({ messageID }: { messageID: string }) => {
          const message = f.worker.messages.find((item) => item.id === messageID)
          if (!message) throw new Error("Native message missing")
          return message
        },
      },
    },
    message: {
      list: async ({ type }: { type: string }) => {
        const review = f.worker.messages.find(
          (message) => message.id === f.worker.turn?.inputID && message.type === "synthetic",
        )
        return {
          data: review
            ? type === "synthetic"
              ? [review]
              : []
            : type === "user" && f.worker.turn?.inputID
              ? [{ type: "user", id: f.worker.turn.inputID }]
              : [],
          cursor: {},
        }
      },
    },
    permission: { request: { list } },
    form: { list },
    shell: { list },
  } as unknown as NativeInboxClient
  const native = nativeHost(
    {
      app: { version: "2.2.5" },
      location: { directory: f.root, project: { id: "project" } },
      session: {
        get: () => Effect.succeed(target() as never),
        context: () => {
          const review = f.worker.messages.find(
            (message) => message.id === f.worker.turn?.inputID && message.type === "synthetic",
          )
          return Effect.succeed(
            review
              ? ([
                  review,
                  {
                    id: "msg_review_response",
                    type: "assistant",
                    content: [],
                    finish: f.worker.turn?.state === "completed" ? "stop" : "tool-calls",
                    time: {
                      created: 1,
                      ...(f.worker.turn?.state === "completed" ? { completed: 2 } : {}),
                    },
                  },
                ] as never)
              : [],
          )
        },
      },
    } as unknown as Plugin.Context,
    f.repository,
    {
      discover: async () => ({ url: "https://opencode.localhost", auth: undefined }),
      make: () => client,
      processID: () => 42,
    },
  )
  const fakeSession = f.host.session
  f.host.session = (id, options) =>
    id === f.retained.session_id ? native.session(id, options) : fakeSession(id, options)
  f.host.ensureSourceGuard = native.ensureSourceGuard
  f.host.archiveRetainedWorker = native.archiveRetainedWorker
  return {
    native,
    get archives() {
      return archives
    },
    get probes() {
      return probes
    },
  }
}

test("source quarantine uses native clear controls and assignment-bound worker archival with lost-reply readback", async () => {
  const f = await retainedSourceFixture()
  f.install()
  const adapter = attachNativeQuarantineHost(f, { loseReply: true })
  expect(await f.host.session(f.retained.session_id)).toMatchObject({
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
  })
  await f.runtime.command(f.command(), "owner")
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, f.retained.id)?.phase).toBe("sealed")
  expect(adapter.archives).toBe(1)
  expect(f.worker.archived).toBe(true)
  expect(f.store.effects(f.receipt.planID).find((row) => row.id === f.effectID)!.state).toBe(
    "uncertain",
  )
})

test("native retained worker archival rejects foreign or changed bindings, active work and unavailable observations", async () => {
  for (const mismatch of [
    "project",
    "agent",
    "attempt",
    "directory",
    "request",
    "active",
    "unavailable",
    "changed-on-update",
  ] as const) {
    const f = await retainedSourceFixture()
    f.install()
    const command = f.command()
    await f.runtime.command(command, "owner")
    const adapter = attachNativeQuarantineHost(f, {
      target:
        mismatch === "project"
          ? { projectID: "foreign" }
          : mismatch === "agent"
            ? { agent: "architect" }
            : mismatch === "attempt"
              ? { metadata: { lazersAttemptID: "foreign" } }
              : mismatch === "directory"
                ? { directory: "/foreign" }
                : undefined,
      active: mismatch === "active",
      unavailable: mismatch === "unavailable",
      onUpdate:
        mismatch === "changed-on-update"
          ? () => {
              f.worker.metadata = { lazersAttemptID: "replacement" }
            }
          : undefined,
    })
    await expect(
      adapter.native.archiveRetainedWorker!({
        sessionID: f.retained.session_id,
        attemptID: f.retained.id,
        planID: f.retained.plan_id,
        requestID: mismatch === "request" ? "foreign" : command.requestID,
        projectID: "project",
        directory: f.retained.workspace,
        assignedMessageID: f.retained.message_id,
      }),
    ).rejects.toThrow()
    expect(adapter.archives).toBe(mismatch === "changed-on-update" ? 1 : 0)
    expect(sourceQuarantine(f.store, f.retained.id)?.phase).toBe("pending")
    if (mismatch === "unavailable")
      await expect(f.runtime.command(f.command(), "owner")).rejects.toThrow("unavailable")
  }
})

test("native location activation restores pending and sealed quarantine after registry loss and database reopen", async () => {
  for (const phase of ["pending", "sealed"] as const) {
    const f = await retainedSourceFixture()
    const guards: ReturnType<typeof f.install>[] = []
    const adapter = attachNativeQuarantineHost(f, {
      probe: async () => {
        if (!sourceGuardInstalled(f.store, f.retained.workspace)) guards.push(f.install())
        return {}
      },
    })
    // Starts without an old-location registration; the native route loads it.
    await f.runtime.command(f.command(), "owner")
    if (phase === "sealed") await f.runtime.tick()
    expect(sourceQuarantine(f.store, f.retained.id)?.phase).toBe(phase)
    const effect = f.store.effects(f.receipt.planID).find((row) => row.id === f.effectID)!
    const probesBefore = adapter.probes
    await f.runtime.stop()
    for (const dispose of guards.splice(0)) dispose()
    expect(sourceGuardInstalled(f.store, f.retained.workspace)).toBe(false)
    f.repository.close()
    const repository = new TaskRepository(f.repository.path, f.root)
    const store = new RunnerStore(repository)
    const runtime = new TaskRuntime(store, f.host, "project")
    try {
      await runtime.tick()
      expect(adapter.probes).toBe(probesBefore)
      // A restarted process waits for the old scheduler lease before recovery.
      store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
      await runtime.tick()
      expect(sourceQuarantine(store, f.retained.id)).toMatchObject({
        phase: "sealed",
        hold_reason: null,
      })
      expect(adapter.probes).toBe(probesBefore + 1)
      expect(adapter.archives).toBe(1)
      expect(store.effects(f.receipt.planID).find((row) => row.id === f.effectID)).toEqual(effect)
      expect(
        sourceReservationExcluded(store, store.attempts(f.receipt.planID)[0]!, {
          mode: "isolated",
        }),
      ).toBe(true)
      const next = f.createTask("after-restart", "shared.txt")
      const plan = store.submit(f.inputFor([next], { requestID: `restore-${phase}` }), "owner")
      await runPlan({ ...f, store, runtime }, plan.planID, `run-restore-${phase}`)
      await runtime.tick()
      expect(store.attempts(plan.planID)).toHaveLength(1)
      expect(store.attempts(f.receipt.planID)[0]!.state).toBe("verifying")
      // A healthy sealed fence causes no recurring native probe or archive.
      expect(adapter.probes).toBe(probesBefore + 1)
    } finally {
      await runtime.stop()
      repository.close()
    }
  }
})

test("reconciliation sends a quarantined verifying attempt to retained verification", async () => {
  const f = await retainedSourceFixture()
  f.install()
  attachNativeQuarantineHost(f)
  await f.runtime.command(f.command(), "owner")
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, f.retained.id)?.phase).toBe("sealed")
  const planID = f.receipt.planID
  f.store.atomic((db) => {
    db.query("UPDATE runner_effects SET state='completed' WHERE id=?").run(f.effectID)
    db.query("UPDATE runner_plans SET state='running',reason=NULL WHERE id=?").run(planID)
  })
  await f.runtime.tick()
  expect(f.store.plan(planID)).toMatchObject({
    state: "blocked",
    reason: expect.stringContaining("verify-retained"),
  })
  const version = f.store.plan(planID)!.version
  expect(
    await f.runtime.command(
      {
        planID,
        expectedVersion: version,
        requestID: "reconcile-quarantined-verification",
        action: "reconcile",
      },
      "owner",
    ),
  ).toMatchObject({ status: "blocked", version })
  expect(f.store.attempts(planID).map((attempt) => attempt.id)).toEqual([f.retained.id])
})

test("failed or mismatched native activation retains sealed resources and recovers only a current exact guard", async () => {
  const f = await retainedSourceFixture()
  const guards = [f.install()]
  const install = () => {
    const guard = f.install()
    guards.push(guard)
    return guard
  }
  let failure:
    | "unavailable"
    | "database"
    | "project"
    | "directory"
    | "pid"
    | "disposed"
    | "superseded"
    | undefined
  const adapter = attachNativeQuarantineHost(f, {
    probe: async () => {
      if (failure === "unavailable") throw new Error("Location activation unavailable")
      const dispose = install()
      if (failure === "disposed") dispose()
      if (failure === "superseded") {
        const stale = dispose.registrationID
        install()
        return { registrationID: stale }
      }
      return failure === "database"
        ? { databasePath: "/foreign/tasks.sqlite" }
        : failure === "project"
          ? { projectID: "foreign" }
          : failure === "directory"
            ? { directory: f.root }
            : failure === "pid"
              ? { pid: 7 }
              : {}
    },
  })
  await f.runtime.command(f.command(), "owner")
  await f.runtime.tick()
  const effect = f.store.effects(f.receipt.planID).find((row) => row.id === f.effectID)!
  for (const mismatch of [
    "unavailable",
    "database",
    "project",
    "directory",
    "pid",
    "disposed",
    "superseded",
  ] as const) {
    failure = mismatch
    // S1-1: remove every fixture scope; disposing one restores installed survivors.
    for (const dispose of guards.splice(0)) dispose()
    await f.runtime.tick()
    expect(sourceQuarantine(f.store, f.retained.id)?.phase).toBe("sealed")
    expect(sourceQuarantine(f.store, f.retained.id)?.hold_reason).toBeString()
    expect(
      sourceReservationExcluded(f.store, f.store.attempts(f.receipt.planID)[0]!, {
        mode: "isolated",
      }),
    ).toBe(false)
    expect(f.store.effects(f.receipt.planID).find((row) => row.id === f.effectID)).toEqual(effect)
  }
  failure = undefined
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, f.retained.id)?.hold_reason).toBeNull()
  expect(adapter.archives).toBe(1)
})

test("source quarantine seals only a stopped guarded native writer and permits independent code without accepting old work", async () => {
  const f = await retainedSourceFixture()
  f.install()
  const heldEffect = f.store.effects(f.receipt.planID).find((row) => row.id === f.effectID)!
  const scope = f.store.effectiveWriteScope(f.retained.task_id)
  const command = f.command()
  const receipt = await f.runtime.command(command, "owner")
  expect(sourceQuarantine(f.store, f.retained.id)?.phase).toBe("pending")
  const next = f.createTask("b", "shared.txt")
  const following = f.store.submit(f.inputFor([next], { requestID: "independent-source" }), "owner")
  await runPlan(f, following.planID, "run-independent-source")
  f.worker.busy = true
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, f.retained.id)?.phase).toBe("pending")
  expect(f.store.attempts(following.planID)).toHaveLength(0)
  expect(f.worker.archived).toBe(false)
  f.worker.busy = false
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, f.retained.id)?.phase).toBe("sealed")
  expect(f.worker.archived).toBe(true)
  expect(f.store.attempts(following.planID)).toHaveLength(1)
  const successor = f.store.attempts(following.planID)[0]!
  expect(successor.workspace).not.toBe(f.retained.workspace)
  expect(readFileSync(join(successor.workspace, "shared.txt"), "utf8")).toBe("b")
  expect(readFileSync(join(f.retained.workspace, "shared.txt"), "utf8")).toBe("a")
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("verifying")
  expect(f.store.effects(f.receipt.planID).find((row) => row.id === f.effectID)).toEqual(heldEffect)
  expect(f.store.effectiveWriteScope(f.retained.task_id)).toEqual(scope)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
  await f.runtime.command(
    {
      requestID: "amend-independent-quarantined-overlap",
      planID: following.planID,
      expectedVersion: f.store.plan(following.planID)!.version,
      action: "amend-scope",
      taskID: next.id,
      scopeAdditions: ["extra.txt"],
      reason: "Independent active source remains disjoint from the retained checkout",
    },
    "owner",
  )
  expect(f.store.effectiveWriteScope(next.id)).toContain("extra.txt")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  expect(inspectPlan(f.store, { planID: f.receipt.planID, full: false })).toHaveProperty(
    "sourceQuarantines.0.phase",
    "sealed",
  )
  const dependent = f.createTask("c", "c.txt")
  const dependentPlan = f.store.submit(
    {
      ...f.inputFor([dependent], { requestID: "retained-integration-dependency" }),
      afterPlans: [f.receipt.planID],
    },
    "owner",
  )
  await runPlan(f, dependentPlan.planID, "run-retained-dependent")
  await f.runtime.tick()
  expect(f.store.attempts(dependentPlan.planID)).toHaveLength(0)
})

test("source quarantine isolates a completed foreground worker with unknown background without accepting it", async () => {
  const f = fixture({ delayed: true, commit: true, taskFiles: [{ name: "a", path: "shared.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const original = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(original.session_id)
  const worker = f.sessions.get(original.session_id)!
  Object.assign(worker, {
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    background: {
      state: "unknown",
      source: "experimental.idle",
      reason: "Missing historical idle",
    },
  })
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")
  const guard = registerSourceGuard(f.store, original.workspace)
  cleanup.push(guard)
  await f.runtime.command(
    {
      requestID: "quarantine-completed-foreground",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "quarantine-source",
      attemptID: original.id,
      reason: "Preserve old resources while allowing independent isolated source work",
    },
    "owner",
  )
  const observeSession = f.host.session
  const adapter = attachNativeQuarantineHost({
    ...f,
    retained: original,
    worker,
    guardID: guard.registrationID,
  })
  f.host.session = observeSession
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, original.id)?.phase).toBe("sealed")
  expect(adapter.archives).toBe(1)
  expect(worker.archived).toBe(true)
  expect(worker.background?.state).toBe("unknown")
  let contextReads = 0
  const readSession = f.host.session
  f.host.session = async (id, options) => {
    if (id === original.session_id && options?.messages) contextReads++
    return readSession(id, options)
  }
  await f.runtime.tick()
  expect(contextReads).toBe(0)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  const next = f.createTask("b", "shared.txt")
  const following = f.store.submit(
    f.inputFor([next], { requestID: "after-completed-quarantine" }),
    "owner",
  )
  await runPlan(f, following.planID, "run-after-completed-quarantine")
  await f.runtime.tick()
  const successor = f.store.attempts(following.planID)[0]!
  expect(successor.workspace).not.toBe(original.workspace)
  expect(readFileSync(join(successor.workspace, "shared.txt"), "utf8")).toBe("b")
  expect(readFileSync(join(original.workspace, "shared.txt"), "utf8")).toBe("a")
  expect(f.store.nodes(f.receipt.planID)[0]!.state).not.toBe("accepted")
})

test("scheduler isolates a completed guarded source when it blocks queued isolated work", async () => {
  const f = fixture({ delayed: true, commit: true, taskFiles: [{ name: "a", path: "shared.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const original = f.store.attempts(f.receipt.planID)[0]!
  const guard = registerSourceGuard(f.store, original.workspace)
  cleanup.push(guard)
  const task = f.createTask("b", "shared.txt")
  const next = f.store.submit(
    f.inputFor([task], { requestID: "automatic-source-isolation" }),
    "owner",
  )
  await runPlan(f, next.planID, "run-automatic-source-isolation")
  await f.runtime.tick()
  expect(f.store.attempts(next.planID)).toHaveLength(0)
  expect(new TaskReads(f.repository).get({ taskID: task.id })).toMatchObject({
    recordedState: "queued",
    execution: {
      state: "blocked",
      reason: `Waiting for checkout or write scope: ${f.repository.referenceFor(original.task_id)}`,
    },
  })

  f.completeWorker(original.session_id)
  const worker = f.sessions.get(original.session_id)!
  Object.assign(worker, {
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    background: {
      state: "unknown",
      source: "experimental.idle",
      reason: "Historical idle missing",
    },
  })
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, original.id)?.phase).toBe("pending")
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, original.id)?.phase).toBe("sealed")
  expect(f.store.attempts(next.planID)[0]?.state).toBe("running")
  expect(f.store.nodes(f.receipt.planID)[0]?.state).not.toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(readFileSync(join(original.workspace, "shared.txt"), "utf8")).toBe("a")
})

async function completedSourceReviewFixture() {
  const f = fixture({ delayed: true, commit: true, taskFiles: [{ name: "a", path: "shared.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id)
  const worker = f.sessions.get(attempt.session_id)!
  const reviewInputID = "msg_tagged_source_review"
  Object.assign(worker, {
    model: JSON.parse(attempt.policy).model,
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    turn: { inputID: reviewInputID, state: "completed" },
    background: { state: "unknown", source: "experimental.idle", reason: "Missing old idle" },
  })
  worker.messages.push({
    id: reviewInputID,
    type: "synthetic",
    text: "Review retained product work",
    metadata: {
      lazersReview: { taskID: attempt.task_id, attemptID: attempt.id, requestID: "review-product" },
    },
  })
  const guard = registerSourceGuard(f.store, attempt.workspace)
  cleanup.push(guard)
  const command = {
    requestID: "quarantine-tagged-source-review",
    planID: f.receipt.planID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    action: "quarantine-source" as const,
    taskID: attempt.task_id,
    attemptID: attempt.id,
    reviewInputID,
    reason: "Retain completed review and release only guarded source",
  }
  return { ...f, attempt, worker, reviewInputID, guard, command }
}

test("tagged review source quarantine survives reopen and native archive without accepting unknown background", async () => {
  const f = await completedSourceReviewFixture()
  const original = f.store.attempts(f.receipt.planID)[0]!
  const receipt = await f.runtime.command(f.command, "owner")
  expect(sourceQuarantine(f.store, f.attempt.id)?.review_input_json).toBe(
    JSON.stringify({ inputID: f.reviewInputID, requestID: "review-product" }),
  )
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const repository = new TaskRepository(f.repository.path, f.root)
  const store = new RunnerStore(repository)
  const observe = f.host.session
  const adapter = attachNativeQuarantineHost(
    {
      ...f,
      repository,
      retained: f.attempt,
      guardID: f.guard.registrationID,
    },
    { loseReply: true },
  )
  f.host.session = observe
  const runtime = new TaskRuntime(store, f.host, "project")
  try {
    await runtime.tick()
    expect(sourceQuarantine(store, f.attempt.id)?.phase).toBe("sealed")
    expect(adapter.archives).toBe(1)
    expect(f.worker.archived).toBe(true)
    expect(f.worker.background?.state).toBe("unknown")
    expect(store.attempts(f.receipt.planID)[0]!.message_id).toBe(original.message_id)
    expect(store.attempts(f.receipt.planID)[0]!.state).toBe("running")
    expect(store.nodes(f.receipt.planID)[0]!.state).not.toBe("accepted")
    expect(
      store.atomic(
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM runner_transitions WHERE plan_id=? AND event='WORKER_REVIEW_INPUT_RECONCILED'",
            )
            .get(f.receipt.planID)?.count,
      ),
    ).toBe(0)
    expect(await runtime.command(f.command, "owner")).toEqual(receipt)
  } finally {
    await runtime.stop()
    repository.close()
  }
})

test.each(
  (["worktrees", "guard"] as const).flatMap((boundary) =>
    (["input", "tag", "route", "owner"] as const).map((field) => ({ boundary, field })),
  ),
)(
  "source review admission rejects $field changed during $boundary without mutation",
  async ({ boundary, field }) => {
    const f = await completedSourceReviewFixture()
    const change = () => {
      if (field === "input") f.worker.turn!.inputID = "msg_newer"
      if (field === "tag")
        (f.worker.messages.at(-1)!.metadata!.lazersReview as Record<string, unknown>).requestID =
          "changed-review"
      if (field === "route") f.worker.model = { ...f.worker.model!, id: "different-model" }
      if (field === "owner") f.sessions.get("owner")!.archived = true
    }
    if (boundary === "worktrees") {
      const list = f.host.worktrees
      f.host.worktrees = async () => {
        const rows = await list()
        change()
        return rows
      }
    } else {
      const ensure = f.host.ensureSourceGuard!
      f.host.ensureSourceGuard = async (input) => {
        await ensure(input)
        change()
      }
    }
    const before = f.store.plan(f.receipt.planID)
    await expect(f.runtime.command(f.command, "owner")).rejects.toThrow()
    expect(f.store.plan(f.receipt.planID)).toEqual(before)
    expect(sourceQuarantine(f.store, f.attempt.id)).toBeNull()
    expect(f.worker.archived).toBe(false)
  },
)

async function sealedSourceReviewFixture() {
  const f = await completedSourceReviewFixture()
  await f.runtime.command(f.command, "owner")
  const observe = f.host.session
  const adapter = attachNativeQuarantineHost({
    ...f,
    retained: f.attempt,
    guardID: f.guard.registrationID,
  })
  f.host.session = observe
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, f.attempt.id)?.phase).toBe("sealed")
  return { ...f, adapter }
}

test("malformed sealed review pin cannot exclude source even with its installed guard", async () => {
  const f = await sealedSourceReviewFixture()
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_source_quarantines SET review_input_json=? WHERE attempt_id=?")
      .run("{invalid", f.attempt.id),
  )
  expect(sourceReservationExcluded(f.store, f.attempt, { mode: "isolated" })).toBe(false)
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, f.attempt.id)?.hold_reason).not.toBeNull()
  expect(sourceReservationExcluded(f.store, f.attempt, { mode: "isolated" })).toBe(false)
})

test.each(["before-restore", "during-restore"] as const)(
  "sealed review guard recovery permits a later handoff %s without replaying archive",
  async (when) => {
    const f = await sealedSourceReviewFixture()
    const pin = sourceQuarantine(f.store, f.attempt.id)!.review_input_json
    f.guard()
    const change = () => {
      f.worker.turn!.inputID = "msg_later_handoff"
      f.worker.messages.push({
        id: "msg_later_handoff",
        type: "synthetic",
        text: "Read retained work and submit handoff",
      })
    }
    if (when === "before-restore") change()
    f.host.ensureSourceGuard = async () => {
      cleanup.push(registerSourceGuard(f.store, f.attempt.workspace))
      if (when === "during-restore") change()
    }
    await f.runtime.tick()
    expect(sourceQuarantine(f.store, f.attempt.id)).toMatchObject({
      hold_reason: null,
      review_input_json: pin,
    })
    expect(sourceReservationExcluded(f.store, f.attempt, { mode: "isolated" })).toBe(true)
    expect(sourceQuarantineToolError(f.store, f.attempt.session_id, "shell")).toContain(
      "quarantined",
    )
    expect(
      sourceQuarantineToolError(f.store, f.attempt.session_id, "lz-submit-handoff"),
    ).toBeUndefined()
    expect(f.adapter.archives).toBe(1)
    expect(f.worker.background?.state).toBe("unknown")
  },
)

test("healthy sealed review guard permits a later handoff without rescanning review messages", async () => {
  const f = await sealedSourceReviewFixture()
  f.worker.turn!.inputID = "msg_later_handoff"
  let reads = 0
  const observe = f.host.session
  f.host.session = async (id, options) => {
    if (id === f.attempt.session_id && options?.messages) reads++
    return observe(id, options)
  }
  await f.runtime.tick()
  expect(reads).toBe(0)
  expect(sourceReservationExcluded(f.store, f.attempt, { mode: "isolated" })).toBe(true)
  expect(sourceQuarantineToolError(f.store, f.attempt.session_id, "write")).toContain("quarantined")
  expect(sourceQuarantineToolError(f.store, f.attempt.session_id, "lz-get-task")).toBeUndefined()
})

test("concurrent explicit pending supersessions use the plan version once", async () => {
  const f = await completedSourceReviewFixture()
  await f.runtime.command(f.command, "owner")
  const version = f.store.plan(f.receipt.planID)!.version
  const results = await Promise.allSettled(
    ["a", "b"].map((suffix) =>
      f.runtime.command(
        {
          ...f.command,
          requestID: `concurrent-source-pin-${suffix}`,
          expectedVersion: version,
        },
        "owner",
      ),
    ),
  )
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  expect(f.store.plan(f.receipt.planID)!.version).toBe(version + 1)
  expect(f.worker.archived).toBe(false)
})

test("a later explicit quarantine cannot retarget an already sealed review pin", async () => {
  const f = await sealedSourceReviewFixture()
  const row = sourceQuarantine(f.store, f.attempt.id)
  const version = f.store.plan(f.receipt.planID)!.version
  const nextInput = "msg_later_sealed_review"
  f.worker.turn!.inputID = nextInput
  f.worker.messages.push({
    id: nextInput,
    type: "synthetic",
    text: "Later review",
    metadata: {
      lazersReview: {
        taskID: f.attempt.task_id,
        attemptID: f.attempt.id,
        requestID: "later-review",
      },
    },
  })
  await f.runtime.command(
    {
      ...f.command,
      requestID: "later-sealed-request",
      reviewInputID: nextInput,
      expectedVersion: version,
    },
    "owner",
  )
  expect(sourceQuarantine(f.store, f.attempt.id)).toEqual(row)
  expect(f.store.plan(f.receipt.planID)!.version).toBe(version)
  expect(f.adapter.archives).toBe(1)
})

test("fresh owner command explicitly supersedes a pending review pin; old replay cannot retarget it", async () => {
  const f = await completedSourceReviewFixture()
  const firstReceipt = await f.runtime.command(f.command, "owner")
  const nextInputID = "msg_next_source_review"
  f.worker.turn!.inputID = nextInputID
  f.worker.messages.push({
    id: nextInputID,
    type: "synthetic",
    text: "Correct retained review",
    metadata: {
      lazersReview: {
        taskID: f.attempt.task_id,
        attemptID: f.attempt.id,
        requestID: "corrected-review",
      },
    },
  })
  const next = {
    ...f.command,
    requestID: "explicit-corrected-source-pin",
    reviewInputID: nextInputID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    reason: "Explicitly supersede the old pending pin after reviewing the correction",
  }
  await f.runtime.command(next, "owner")
  const row = sourceQuarantine(f.store, f.attempt.id)!
  expect(JSON.parse(row.review_input_json!)).toEqual({
    inputID: nextInputID,
    requestID: "corrected-review",
  })
  expect(f.store.attempts(f.receipt.planID)[0]!.message_id).toBe(f.attempt.message_id)
  const history = f.store
    .atomic((db) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_transitions WHERE plan_id=? AND event='SOURCE_QUARANTINE_REQUESTED' ORDER BY id",
        )
        .all(f.receipt.planID),
    )
    .map((entry) => JSON.parse(entry.payload))
  expect(history).toHaveLength(2)
  expect(history[0].reviewInput.inputID).toBe(f.reviewInputID)
  expect(history[1]).toMatchObject({
    supersedesRequestID: f.command.requestID,
    reviewInput: { inputID: nextInputID },
  })
  expect(await f.runtime.command(f.command, "owner")).toEqual(firstReceipt)
  expect(sourceQuarantine(f.store, f.attempt.id)).toEqual(row)
  await expect(
    f.runtime.command({ ...next, reviewInputID: f.reviewInputID }, "owner"),
  ).rejects.toThrow()
  expect(sourceQuarantine(f.store, f.attempt.id)).toEqual(row)
})

test("legacy source quarantine migration preserves its original-input binding", async () => {
  const f = await completedSourceReviewFixture()
  f.worker.turn!.inputID = f.attempt.message_id
  const { reviewInputID: _reviewInputID, ...legacyCommand } = f.command
  await f.runtime.command(legacyCommand, "owner")
  await f.runtime.stop()
  f.store.atomic((db) => {
    // S2-4: this legacy layout has not installed the runner module generation.
    db.query("DELETE FROM schema_modules WHERE module='runner'").run()
    db.exec("ALTER TABLE runner_source_quarantines DROP COLUMN review_input_json")
  })
  const repository = new TaskRepository(f.repository.path, f.root)
  try {
    const store = new RunnerStore(repository)
    expect(sourceQuarantine(store, f.attempt.id)).toMatchObject({
      assigned_message_id: f.attempt.message_id,
      review_input_json: null,
      phase: "pending",
    })
    expect(store.attempts(f.receipt.planID)[0]!.message_id).toBe(f.attempt.message_id)
  } finally {
    repository.close()
  }
})

test.each([
  "metadata",
  "task",
  "attempt",
  "duplicate",
  "current",
  "failed",
  "route",
  "non-synthetic",
  "absent",
  "pending",
  "permission",
  "form",
  "unstable",
  "effort",
] as const)("tagged review source quarantine rejects %s before mutation", async (invalid) => {
  const f = await completedSourceReviewFixture()
  const message = f.worker.messages.at(-1)!
  if (invalid === "metadata") message.metadata = {}
  if (invalid === "task")
    (message.metadata!.lazersReview as Record<string, unknown>).taskID = crypto.randomUUID()
  if (invalid === "attempt")
    (message.metadata!.lazersReview as Record<string, unknown>).attemptID = crypto.randomUUID()
  if (invalid === "duplicate") f.worker.messages.push({ ...message })
  if (invalid === "current") f.worker.turn!.inputID = "msg_newer"
  if (invalid === "failed") f.worker.outcome = "failed"
  if (invalid === "route") f.worker.model = { ...f.worker.model!, id: "other-model" }
  if (invalid === "non-synthetic") message.type = "user"
  if (invalid === "absent") f.worker.messages.pop()
  if (invalid === "pending") f.worker.turn!.state = "pending"
  if (invalid === "permission") f.worker.pendingPermissions = 1
  if (invalid === "form") f.worker.pendingForms = 1
  if (invalid === "unstable") f.worker.observationUnstable = true
  if (invalid === "effort") f.worker.model = { ...f.worker.model!, variant: "different" }
  const before = f.store.plan(f.receipt.planID)
  await expect(f.runtime.command(f.command, "owner")).rejects.toThrow()
  expect(f.store.plan(f.receipt.planID)).toEqual(before)
  expect(sourceQuarantine(f.store, f.attempt.id)).toBeNull()
  expect(f.worker.archived).toBe(false)
})

test.each(
  (["before-update", "after-update"] as const).flatMap((when) =>
    (["input", "tag", "route", "foreground"] as const).map((field) => ({ when, field })),
  ),
)("tagged review archive fences a changed $field $when", async ({ when, field }) => {
  const f = await completedSourceReviewFixture()
  await f.runtime.command(f.command, "owner")
  const observe = f.host.session
  const change = () => {
    if (field === "input") f.worker.turn!.inputID = "msg_newer"
    if (field === "tag")
      (f.worker.messages.at(-1)!.metadata!.lazersReview as Record<string, unknown>).requestID =
        "different-review"
    if (field === "route") f.worker.model = { ...f.worker.model!, id: "different-model" }
    if (field === "foreground") f.worker.outcome = "failed"
  }
  const adapter = attachNativeQuarantineHost(
    {
      ...f,
      retained: f.attempt,
      guardID: f.guard.registrationID,
    },
    {
      onObserve: when === "before-update" ? change : undefined,
      onUpdate: when === "after-update" ? change : undefined,
    },
  )
  f.host.session = observe
  await f.runtime.tick()
  expect(adapter.archives).toBe(when === "before-update" ? 0 : 1)
  expect(sourceQuarantine(f.store, f.attempt.id)?.phase).toBe("pending")
  expect(sourceReservationExcluded(f.store, f.attempt, { mode: "isolated" })).toBe(false)
  await f.runtime.tick()
  expect(adapter.archives).toBe(when === "before-update" ? 0 : 1)
})

test.each(["before-update", "after-update"] as const)(
  "native running-source archive fences a newer input %s",
  async (when) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await f.runtime.tick()
    const attempt = f.store.attempts(f.receipt.planID)[0]!
    f.completeWorker(attempt.session_id)
    const worker = f.sessions.get(attempt.session_id)!
    Object.assign(worker, {
      pendingInput: false,
      pendingPermissions: 0,
      pendingForms: 0,
      background: { state: "unknown", source: "experimental.idle", reason: "Old idle unavailable" },
    })
    const guard = registerSourceGuard(f.store, attempt.workspace)
    cleanup.push(guard)
    await f.runtime.command(
      {
        requestID: `quarantine-input-race-${when}`,
        planID: f.receipt.planID,
        expectedVersion: f.store.plan(f.receipt.planID)!.version,
        action: "quarantine-source",
        attemptID: attempt.id,
        reason: "Keep new foreground input outside the old archive request",
      },
      "owner",
    )
    const observeSession = f.host.session
    const changeInput = () => {
      worker.turn = { inputID: "msg_newer", state: "completed" }
    }
    const adapter = attachNativeQuarantineHost(
      {
        ...f,
        retained: attempt,
        worker,
        guardID: guard.registrationID,
      },
      {
        onObserve: when === "before-update" ? changeInput : undefined,
        onUpdate: when === "after-update" ? changeInput : undefined,
      },
    )
    f.host.session = observeSession
    await f.runtime.tick()
    expect(adapter.archives).toBe(when === "before-update" ? 0 : 1)
    expect(sourceQuarantine(f.store, attempt.id)?.phase).toBe("pending")
    expect(sourceReservationExcluded(f.store, attempt, { mode: "isolated" })).toBe(false)
    expect(worker.background?.state).toBe("unknown")
    await f.runtime.tick()
    expect(adapter.archives).toBe(when === "before-update" ? 0 : 1)
  },
)

test.each(["pending", "different-input", "failed", "busy", "missing-turn"] as const)(
  "running source quarantine rejects %s foreground without mutation",
  async (invalid) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await f.runtime.tick()
    const attempt = f.store.attempts(f.receipt.planID)[0]!
    f.completeWorker(attempt.session_id)
    const worker = f.sessions.get(attempt.session_id)!
    Object.assign(worker, { pendingInput: false, pendingPermissions: 0, pendingForms: 0 })
    if (invalid === "pending") worker.turn!.state = "pending"
    if (invalid === "different-input") worker.turn!.inputID = "msg_newer"
    if (invalid === "failed") worker.outcome = "failed"
    if (invalid === "busy") worker.busy = true
    if (invalid === "missing-turn") worker.turn = undefined
    cleanup.push(registerSourceGuard(f.store, attempt.workspace))
    const before = f.store.plan(f.receipt.planID)
    await expect(
      f.runtime.command(
        {
          requestID: `reject-source-${invalid}`,
          planID: f.receipt.planID,
          expectedVersion: before!.version,
          action: "quarantine-source",
          attemptID: attempt.id,
          reason: "Do not quarantine unresolved foreground work",
        },
        "owner",
      ),
    ).rejects.toThrow()
    expect(f.store.plan(f.receipt.planID)).toEqual(before)
    expect(sourceQuarantine(f.store, attempt.id)).toBeNull()
    expect(worker.archived).toBe(false)
  },
)

test("source quarantine preserves shared and physical-checkout exclusion at both admission gates", async () => {
  for (const destination of ["shared", "same", "symlink", "unavailable"] as const) {
    const f = await retainedSourceFixture()
    f.install()
    await f.runtime.command(f.command(), "owner")
    await f.runtime.tick()
    const next = f.createTask("b", "b.txt")
    const input = {
      ...f.inputFor([next], { requestID: `unsafe-${destination}` }),
      baseCommit: f.artifact,
      workspaceMode: destination === "shared" ? "shared" : "isolated",
    }
    if (destination !== "shared") {
      const alias = join(f.root, "retained-source-alias")
      if (destination === "symlink") symlinkSync(f.retained.workspace, alias, "dir")
      f.host.worktree = async () => (destination === "same" ? f.retained.workspace : alias)
    }
    const plan = f.store.submit(input, "owner")
    await runPlan(f, plan.planID, `run-unsafe-${destination}`)
    const prompts = f.events.filter((event) => event.startsWith("prompt:")).length
    await f.runtime.tick()
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(prompts)
    expect(readFileSync(join(f.retained.workspace, "shared.txt"), "utf8")).toBe("a")
    expect(f.store.effects(f.receipt.planID).find((row) => row.id === f.effectID)!.state).toBe(
      "uncertain",
    )
    if (destination === "shared") expect(f.store.attempts(plan.planID)).toHaveLength(0)
    else expect(f.store.attempts(plan.planID)[0]!.state).toBe("preparing")
  }
})

test("source quarantine recovers lost archive replies after reopen without inventing old receipts or replaying archive", async () => {
  const f = await retainedSourceFixture()
  const disposeFirstGuard = f.install()
  let archives = 0
  f.host.archiveRetainedWorker = async ({ sessionID }) => {
    archives++
    f.sessions.get(sessionID)!.archived = true
    throw new Error("Archive acknowledgement lost")
  }
  const command = f.command()
  await f.runtime.command(command, "owner")
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, f.retained.id)?.phase).toBe("pending")
  expect(archives).toBe(1)
  await f.runtime.stop()
  disposeFirstGuard()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const repository = new TaskRepository(f.repository.path, f.root)
  const store = new RunnerStore(repository)
  const runtime = new TaskRuntime(store, f.host, "project")
  try {
    await runtime.tick()
    expect(sourceQuarantine(store, f.retained.id)?.phase).toBe("pending")
    expect(sourceQuarantine(store, f.retained.id)?.hold_reason).toContain(
      "source guard is not installed",
    )
    const disposeSecondGuard = f.install(store)
    await runtime.tick()
    expect(sourceQuarantine(store, f.retained.id)?.hold_reason).toBeNull()
    expect(sourceQuarantine(store, f.retained.id)?.phase).toBe("sealed")
    expect(archives).toBe(1)
    expect(store.effects(f.receipt.planID).find((row) => row.id === f.effectID)!.receipt).toBeNull()
    expect(
      sourceReservationExcluded(store, store.attempts(f.receipt.planID)[0]!, { mode: "isolated" }),
    ).toBe(true)
    disposeSecondGuard()
    expect(
      sourceReservationExcluded(store, store.attempts(f.receipt.planID)[0]!, { mode: "isolated" }),
    ).toBe(false)
    expect(await runtime.command(command, "owner")).toMatchObject({ status: "quarantining-source" })
  } finally {
    await runtime.stop()
    repository.close()
  }
})

test("source quarantine rejects missing enforcement, active writers, stale versions and foreign owners before mutation", async () => {
  const f = await retainedSourceFixture()
  await expect(f.runtime.command(f.command(), "owner")).rejects.toThrow("source guard")
  f.install()
  f.worker.busy = true
  await expect(f.runtime.command(f.command(), "owner")).rejects.toThrow("active or unresolved")
  f.worker.busy = false
  await expect(f.runtime.command({ ...f.command(), expectedVersion: 1 }, "owner")).rejects.toThrow(
    "Stale plan version",
  )
  await expect(f.runtime.command(f.command(), "another-owner")).rejects.toThrow(
    "Only the plan owner",
  )
  const metadata = f.worker.metadata
  f.worker.metadata = { lazersAttemptID: "replacement" }
  await expect(f.runtime.command(f.command(), "owner")).rejects.toThrow("ownership or location")
  f.worker.metadata = metadata
  expect(sourceQuarantine(f.store, f.retained.id)).toBeNull()
  expect(f.worker.archived).toBe(false)
})

test("source quarantine fences reassignment during archive and accepts a fresh authorized continuation", async () => {
  const f = await retainedSourceFixture()
  f.install()
  f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner" })
  const archive = f.host.archiveRetainedWorker!
  f.host.archiveRetainedWorker = async (input) => {
    await archive(input)
    await f.runtime.command(
      {
        requestID: "reassign-during-quarantine",
        planID: f.receipt.planID,
        expectedVersion: f.store.plan(f.receipt.planID)!.version,
        action: "reassign",
        targetSessionID: "new-owner",
      },
      "owner",
    )
  }
  await f.runtime.command(f.command(), "owner")
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, f.retained.id)?.phase).toBe("pending")
  expect(sourceQuarantine(f.store, f.retained.id)?.hold_reason).toContain(
    "authority or assignment changed",
  )
  expect(
    sourceReservationExcluded(f.store, f.store.attempts(f.receipt.planID)[0]!, {
      mode: "isolated",
    }),
  ).toBe(false)
  await f.runtime.command(f.command(), "new-owner")
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, f.retained.id)?.phase).toBe("sealed")
  expect(f.store.effects(f.receipt.planID).find((row) => row.id === f.effectID)!.state).toBe(
    "uncertain",
  )
})

test("source quarantine recovery does not inspect or mutate another project sharing its database", async () => {
  const f = await retainedSourceFixture()
  f.install()
  await f.runtime.command(f.command(), "owner")
  const before = sourceQuarantine(f.store, f.retained.id)
  const foreignRoot = mkdtempSync(join(tmpdir(), "lazers-quarantine-foreign-"))
  const repository = new TaskRepository(f.repository.path, foreignRoot)
  let reads = 0
  const runtime = new TaskRuntime(
    new RunnerStore(repository),
    {
      ...f.host,
      session: async () => {
        reads++
        throw new Error("Foreign project cannot read this worker")
      },
    },
    "foreign-project",
  )
  try {
    await runtime.tick()
    expect(reads).toBe(0)
    expect(sourceQuarantine(f.store, f.retained.id)).toEqual(before)
    expect(f.worker.archived).toBe(false)
  } finally {
    await runtime.stop()
    repository.close()
    rmSync(foreignRoot, { recursive: true, force: true })
  }
})

test("active scope amendments durably update the same worker after it fetched old instructions and survive reopen", async () => {
  const f = fixture({
    delayed: true,
    outside: true,
    repair: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(planID)[0]!
  const original = f.repository.get(attempt.task_id)
  const fetched = taskInstructions(new TaskReads(f.repository).get({ taskID: attempt.task_id }))
  expect(fetched).not.toContain("escape.txt")
  const command = {
    requestID: "allow-test",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
    action: "amend-scope",
    taskID: attempt.task_id,
    scopeAdditions: ["escape.txt"],
    reason: "Keep the reviewed legitimate dependency test.",
  }
  const result = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(result)
  const effects = f.store.effects(planID).filter((effect) => effect.kind === "scope-instruction")
  expect(effects).toHaveLength(1)
  expect(effects[0]!.state).toBe("intended")
  expect(f.instructions.size).toBe(0)
  expect(f.store.attempts(planID)).toHaveLength(1)
  await f.runtime.stop()
  const repository = new TaskRepository(f.repository.path, f.root)
  const store = new RunnerStore(repository)
  store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const runtime = new TaskRuntime(store, f.host, "project")
  try {
    await drive(runtime, 3)
    const effect = store.effects(planID).find((item) => item.id === effects[0]!.id)!
    expect(effect.state).toBe("completed")
    expect(JSON.parse(effect.receipt!)).toMatchObject({
      nativeEntryConfirmed: true,
      modelConsumption: "unknown",
    })
    const entries = [...f.instructions.get(attempt.session_id)!.values()]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain(attempt.task_id)
    expect(entries[0]).toContain(attempt.id)
    expect(entries[0]).toContain('["a.txt","escape.txt"]')
    expect(entries[0]).toContain("original acceptance and verification")
    expect(f.sessions.get(attempt.session_id)!.busy).toBe(true)
    expect(
      f.events.filter(
        (event) =>
          event.startsWith("create:") || event.startsWith("prompt:") || event.startsWith("stop:"),
      ),
    ).toHaveLength(2)
    expect(store.attempts(planID)).toHaveLength(1)
    expect(repository.get(attempt.task_id)).toEqual(original)
    f.completeWorker(attempt.session_id)
    await drive(runtime, 5)
    expect(store.plan(planID)!.state).toBe("accepted")
    expect(store.attempts(planID)).toHaveLength(1)
    const progress = store.progressFacts([attempt.id])
    expect(progress.map((fact) => fact.kind)).toContain("artifact")
    expect(progress.map((fact) => fact.kind)).toContain("verification")
    expect(progress.some((fact) => JSON.parse(fact.payload).outcome === "accepted")).toBe(true)
    expect(JSON.parse(progress.find((fact) => fact.kind === "verification")!.payload).result).toBe(
      "passed",
    )
  } finally {
    await runtime.stop()
    repository.close()
  }
})

test("failed and lost scope-update replies recover keyed delivery without workers, repairs or wait churn", async () => {
  for (const lostResponse of [false, true]) {
    const f = fixture({ delayed: true, repair: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const planID = f.receipt.planID
    await f.runtime.command(
      { requestID: "run", planID, expectedVersion: 1, action: "run" },
      "owner",
    )
    await drive(f.runtime, 2)
    const attempt = f.store.attempts(planID)[0]!
    const originalUpdate = f.host.updateInstruction
    let unavailable = true
    f.host.updateInstruction = async (input) => {
      if (!unavailable || lostResponse) await originalUpdate(input)
      if (unavailable) throw new Error("Native update response unavailable")
    }
    await f.runtime.command(
      {
        requestID: "allow-test",
        planID,
        expectedVersion: f.store.plan(planID)!.version,
        action: "amend-scope",
        taskID: attempt.task_id,
        scopeAdditions: ["dependency.test.ts"],
        reason: "Reviewed test.",
      },
      "owner",
    )
    await f.runtime.tick()
    const blocked = f.store.plan(planID)!
    expect(blocked.state).toBe("blocked")
    expect(f.store.effects(planID).at(-1)!.state).toBe("uncertain")
    expect(f.instructions.size).toBe(Number(lostResponse))
    await drive(f.runtime, 3)
    expect(f.store.plan(planID)!.version).toBe(blocked.version)
    unavailable = false
    await f.runtime.stop()
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    const reopened = new TaskRuntime(f.store, f.host, "project")
    try {
      await drive(reopened, 2)
      expect(f.store.effects(planID).at(-1)!.state).toBe("completed")
      expect(f.events.filter((event) => event.startsWith("instruction:"))).toHaveLength(1)
      await reopened.command(
        {
          requestID: "resume-after-receipt",
          planID,
          expectedVersion: f.store.plan(planID)!.version,
          action: "reconcile",
        },
        "owner",
      )
      expect(f.store.plan(planID)!.state).toBe("running")
      expect(f.store.attempts(planID)).toHaveLength(1)
      expect(f.store.attempts(planID)[0]!.id).toBe(attempt.id)
      expect(
        f.events.filter((event) => event.startsWith("create:") || event.startsWith("prompt:")),
      ).toHaveLength(2)
      expect(
        f.store.activity(planID, attempt.task_id).filter((event) => event.event === "REPAIR"),
      ).toHaveLength(0)
      expect(f.sessions.get(attempt.session_id)!.busy).toBe(true)
    } finally {
      await reopened.stop()
    }
  }
})

test("cancellation suppresses a pending scope instruction rather than waking a stopped worker", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 2)
  await f.runtime.command(
    {
      requestID: "allow-test",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "amend-scope",
      taskID: f.tasks[0]!.id,
      scopeAdditions: ["dependency.test.ts"],
      reason: "Reviewed test.",
    },
    "owner",
  )
  await f.runtime.command(
    {
      requestID: "cancel",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await drive(f.runtime, 4)
  expect(f.instructions.size).toBe(0)
  const effect = f.store.effects(planID).find((item) => item.kind === "scope-instruction")!
  expect(effect.state).toBe("completed")
  expect(JSON.parse(effect.receipt!).skipped).toBe(true)
  expect(f.store.attempts(planID)).toHaveLength(1)
})

test("task integration records a reviewed landing without finalizing the plan or disturbing active dependencies", async () => {
  const f = fixture({ delayed: true })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 2)
  const first = f.store.attempts(planID)[0]!
  f.completeWorker(first.session_id)
  await drive(f.runtime, 3)
  const node = f.store.nodes(planID)[0]!
  const second = f.store.attempts(planID)[1]!
  expect(node.state).toBe("accepted")
  expect(second.state).toBe("running")
  const command = {
    requestID: "land-first",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
    action: "integrated",
    taskID: node.task_id,
    artifact: node.artifact!,
    targetBranch: "main",
    reason: "Reviewed accepted task and passing checks.",
  }
  await expect(f.runtime.command(command, "other")).rejects.toThrow("Only the plan owner")
  await expect(f.runtime.command({ ...command, expectedVersion: 1 }, "owner")).rejects.toThrow(
    "Stale plan version",
  )
  await expect(f.runtime.command({ ...command, taskID: second.task_id }, "owner")).rejects.toThrow(
    "accepted task",
  )
  await expect(f.runtime.command({ ...command, artifact: f.base }, "owner")).rejects.toThrow(
    "accepted task artifact",
  )
  await expect(f.runtime.command({ ...command, targetBranch: "other" }, "owner")).rejects.toThrow(
    "reviewed target branch",
  )
  await expect(f.runtime.command(command, "owner")).rejects.toThrow()
  git(f.root, ["merge", "--ff-only", node.artifact!])
  const before = structuredClone({
    plan: f.store.plan(planID),
    nodes: f.store.nodes(planID),
    attempts: f.store.attempts(planID),
    sessions: [...f.sessions],
    events: f.events,
  })
  const result = await f.runtime.command(command, "owner")
  expect(result).toMatchObject({
    status: "task-integration-recorded",
    version: command.expectedVersion + 1,
  })
  expect(await f.runtime.command(command, "owner")).toEqual(result)
  expect(f.store.plan(planID)).toEqual({ ...before.plan!, version: command.expectedVersion + 1 })
  expect(f.store.nodes(planID)).toEqual(before.nodes)
  expect(f.store.attempts(planID)).toEqual(before.attempts)
  expect([...f.sessions]).toEqual(before.sessions)
  expect(f.events).toEqual(before.events)
  expect(existsSync(first.workspace)).toBe(true)
  expect(existsSync(second.workspace)).toBe(true)
  expect(
    f.store
      .activity(planID, node.task_id)
      .filter((event) => event.event === "TASK_INTEGRATION_RECORDED"),
  ).toHaveLength(1)
})

test("scope violations hold a stopped candidate without spending repair, then amendment and reconcile verify it", async () => {
  const f = fixture({ outside: true, repair: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  const spec = f.repository.get(task.id)
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 4)
  const blocked = f.store.plan(planID)!
  const first = f.store.attempts(planID)[0]!
  expect(blocked.state).toBe("blocked")
  expect(blocked.reason).toContain("escape.txt")
  expect(first.state).toBe("verifying")
  expect(f.store.nodes(planID)[0]!.state).toBe("verifying")
  expect(
    f.store.activity(planID, task.id).filter((event) => event.event === "REPAIR"),
  ).toHaveLength(0)
  const history = f.store.activity(planID, task.id)
  const workspaceStatus = git(first.workspace, ["status", "--porcelain"])
  await drive(f.runtime, 5)
  expect(f.store.plan(planID)!.version).toBe(blocked.version)
  expect(f.store.activity(planID, task.id)).toEqual(history)
  expect(git(first.workspace, ["status", "--porcelain"])).toBe(workspaceStatus)
  expect(readFileSync(join(first.workspace, "escape.txt"), "utf8")).toBe("bad")
  expect(f.store.attempts(planID)).toHaveLength(1)
  await f.runtime.command(
    {
      requestID: "authorize-dependency",
      planID,
      expectedVersion: blocked.version,
      action: "amend-scope",
      taskID: task.id,
      scopeAdditions: ["escape.txt"],
      reason: "Reviewed dependency belongs to this implementation.",
    },
    "owner",
  )
  await drive(f.runtime, 2)
  expect(f.store.plan(planID)!.state).toBe("blocked")
  await f.runtime.command(
    {
      requestID: "review-candidate",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 5)
  expect(f.store.plan(planID)!.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]!.id).toBe(first.id)
  expect(f.store.attempts(planID)[0]!.state).toBe("accepted")
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.repository.get(task.id)).toEqual(spec)
})

test("scope amendments preserve the specification and recover dependency edits in the same attempt", async () => {
  const f = fixture({ outside: true, delayed: true })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  const original = f.repository.get(task.id)
  await f.runtime.command(
    { requestID: "scope-run", planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(planID)[0]!
  expect(attempt.state).toBe("running")
  const version = f.store.plan(planID)!.version
  const command = {
    requestID: "allow-dependency",
    planID,
    expectedVersion: version,
    action: "amend-scope" as const,
    taskID: task.id,
    scopeAdditions: ["escape.txt"],
    reason: "The existing implementation needs this dependency file.",
  }
  await expect(f.runtime.command(command, "other-owner")).rejects.toThrow("Only the plan owner")
  await expect(
    f.runtime.command({ ...command, expectedVersion: version - 1 }, "owner"),
  ).rejects.toThrow("Stale plan version")
  await expect(
    f.runtime.command({ ...command, scopeAdditions: ["../outside"] }, "owner"),
  ).rejects.toThrow()
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  expect(f.repository.get(task.id)).toEqual(original)
  expect(f.store.effectiveWriteScope(task.id)).toEqual(["a.txt", "escape.txt"])
  const reopenedRepository = new TaskRepository(f.repository.path, f.root)
  try {
    const reopened = new RunnerStore(reopenedRepository)
    expect(reopened.effectiveWriteScope(task.id)).toEqual(["a.txt", "escape.txt"])
    expect(reopenedRepository.get(task.id)).toEqual(original)
  } finally {
    reopenedRepository.close()
  }
  expect(taskInstructions(new TaskReads(f.repository).get({ taskID: task.id }))).toContain(
    "Authorized execution scope",
  )
  expect(
    f.store.activity(planID, task.id).filter((event) => event.event === "SCOPE_AMENDED"),
  ).toHaveLength(1)
  const now = f.store.plan(planID)!.version
  const unchanged = await f.runtime.command(
    { ...command, requestID: "duplicate-path", expectedVersion: now },
    "owner",
  )
  expect(unchanged).toMatchObject({ status: "scope-unchanged", version: now })
  f.completeWorker(attempt.session_id)
  await drive(f.runtime, 2)
  expect(f.store.nodes(planID)[0]!.state).toBe("accepted")
  expect(f.store.attempts(planID).filter((item) => item.task_id === task.id)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("stop:"))).toHaveLength(1)
  expect(f.store.effectiveWriteScope(f.tasks[1]!.id)).toEqual(["b.txt"])
  await expect(
    f.runtime.command(
      {
        ...command,
        requestID: "too-late",
        expectedVersion: f.store.plan(planID)!.version,
        scopeAdditions: ["another.txt"],
      },
      "owner",
    ),
  ).rejects.toThrow("unfinished work")
})

test("scope amendment rejects active overlap and reserves amended scope before later dispatch", async () => {
  const f = fixture({ independent: true, delayed: true })
  const planID = f.receipt.planID
  await f.runtime.command(
    { requestID: "scope-run", planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime, 2)
  expect(f.store.attempts(planID)).toHaveLength(2)
  const version = f.store.plan(planID)!.version
  await expect(
    f.runtime.command(
      {
        requestID: "conflicting-amendment",
        planID,
        expectedVersion: version,
        action: "amend-scope",
        taskID: f.tasks[0]!.id,
        scopeAdditions: ["b.txt"],
        reason: "Would overlap active work.",
      },
      "owner",
    ),
  ).rejects.toThrow("conflicts with active task")
  expect(f.store.plan(planID)!.version).toBe(version)
  expect(f.store.effectiveWriteScope(f.tasks[0]!.id)).toEqual(["a.txt"])

  const queued = fixture({ independent: true, delayed: true })
  const queuedPlan = queued.receipt.planID
  await queued.runtime.command(
    {
      requestID: "queued-amendment",
      planID: queuedPlan,
      expectedVersion: 1,
      action: "amend-scope",
      taskID: queued.tasks[0]!.id,
      scopeAdditions: ["b.txt"],
      reason: "Reserve dependency before dispatch.",
    },
    "owner",
  )
  await queued.runtime.command(
    { requestID: "queued-run", planID: queuedPlan, expectedVersion: 2, action: "run" },
    "owner",
  )
  await drive(queued.runtime, 2)
  expect(queued.store.attempts(queuedPlan)).toHaveLength(1)
  expect(queued.store.attempts(queuedPlan)[0]!.task_id).toBe(queued.tasks[0]!.id)
})

test("scope amendment requires this plan's unfinished task and explicit additive authorization", async () => {
  const f = fixture({ delayed: true })
  const planID = f.receipt.planID
  const command = {
    requestID: "invalid-scope",
    planID,
    expectedVersion: 1,
    action: "amend-scope",
    taskID: crypto.randomUUID(),
    scopeAdditions: ["dependency.ts"],
    reason: "Authorize dependency.",
  }
  await expect(f.runtime.command(command, "owner")).rejects.toThrow("unfinished work")
  await expect(
    f.runtime.command(
      {
        requestID: command.requestID,
        planID,
        expectedVersion: 1,
        action: "amend-scope",
        taskID: f.tasks[0]!.id,
        scopeAdditions: command.scopeAdditions,
      },
      "owner",
    ),
  ).rejects.toThrow("requires task")
  await expect(
    f.runtime.command({ ...command, taskID: f.tasks[0]!.id, scopeAdditions: [] }, "owner"),
  ).rejects.toThrow()
  expect(f.store.plan(planID)!.version).toBe(1)
})

test("Architect run and reconcile wake the scheduler before periodic reconciliation", async () => {
  const f = fixture({ delayed: true })
  let drained = Promise.withResolvers<void>()
  const registration = sharedScheduler.register(
    schedulerProjectKey(f.repository.path, f.root, "project"),
    {
      intervalMs: 300_000,
      run: async () => {
        await f.runtime.tick()
        drained.resolve()
      },
      onError: (error) => drained.reject(error),
    },
    300_000,
  )
  let wakes = 0
  const runtime = new TaskRuntime(f.store, f.host, "project", undefined, {
    wakeScheduler: () => {
      wakes++
      expect(f.store.plan(f.receipt.planID)?.state).toBe("running")
      registration.request()
    },
  })
  try {
    const tool = await registeredPlanCommand(runtime)
    const command = {
      requestID: "architect-run",
      planID: f.receipt.planID,
      expectedVersion: f.receipt.version,
      action: "run",
    }
    const receipt = await tool.execute(command)
    expect(await tool.execute(command)).toEqual(receipt)
    await drained.promise
    expect(wakes).toBe(1)
    const attempts = f.store.attempts(f.receipt.planID)
    expect(attempts).toHaveLength(1)
    expect(f.events.filter((event) => event.startsWith("start:"))).toHaveLength(1)
    f.completeWorker(attempts[0]!.session_id)
    drained = Promise.withResolvers<void>()
    await tool.execute({
      ...command,
      requestID: "architect-reconcile",
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "reconcile",
    })
    await drained.promise
    expect(wakes).toBe(2)
    expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
      id: attempts[0]!.id,
      state: "verifying",
    })
  } finally {
    await registration.dispose()
    await runtime.stop()
  }
})

test("shared scheduler routes manual Start through its elected runtime instead of a second lease owner", async () => {
  const f = fixture({ shared: true, startOnly: true, delayed: true })
  const leader = new TaskRuntime(f.store, f.host, "project")
  const registration = sharedScheduler.register(
    schedulerProjectKey(f.repository.path, f.root, "project"),
    { intervalMs: 2000, run: () => leader.tick() },
  )
  const follower = new TaskRuntime(f.store, f.host, "project", undefined, {
    requestTick: () => registration.runNow(),
  })
  try {
    const result = await follower.startTask({
      taskID: f.tasks[0]!.id,
      revision: 1,
      sessionID: "owner",
    })
    expect(result.status).toBe("started")
    expect(f.store.attempts(result.planID)).toHaveLength(1)
    expect(f.events.filter((event) => event.startsWith("start:"))).toHaveLength(1)
    expect(
      f.repository.atomic((db) =>
        db
          .query<{ owner: string }, [string]>(
            "SELECT owner FROM runner_leases WHERE project_directory=?",
          )
          .get(f.root),
      )?.owner,
    ).toBe(leader.owner)
    expect(leader.owner).not.toBe(follower.owner)
  } finally {
    await registration.dispose()
    await leader.stop()
    await follower.stop()
  }
})

test("scheduler retries after a failed lease claim instead of remaining permanently running", async () => {
  const f = fixture()
  const claim = f.store.claim.bind(f.store)
  let calls = 0
  f.store.claim = (...args) => {
    calls++
    if (calls === 1) throw new Error("database temporarily unavailable")
    return claim(...args)
  }
  await expect(f.runtime.tick()).rejects.toThrow("database temporarily unavailable")
  await f.runtime.tick()
  expect(calls).toBe(2)
})

test("a disposed follower Start cannot read or reopen its store after the elected drain finishes", async () => {
  const f = fixture({ shared: true, startOnly: true, delayed: true })
  const followerRepository = new TaskRepository(f.repository.path, f.root)
  const followerStore = new RunnerStore(followerRepository)
  const leader = new TaskRuntime(f.store, f.host, "project")
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const running = new Promise<void>((resolve) => {
    entered = resolve
  })
  const key = schedulerProjectKey(f.repository.path, f.root, "project")
  const leaderRegistration = sharedScheduler.register(key, {
    intervalMs: 2000,
    run: async () => {
      entered()
      await gate
      await leader.tick()
    },
  })
  const followerRegistration = sharedScheduler.register(key, {
    intervalMs: 2000,
    run: () => follower.tick(),
  })
  const follower = new TaskRuntime(followerStore, f.host, "project", undefined, {
    requestTick: () => followerRegistration.runNow(),
  })
  let closed = false,
    postCloseReads = 0
  const execution = followerStore.execution.bind(followerStore)
  followerStore.execution = (...args) => {
    if (closed) {
      postCloseReads++
      throw new Error("post-close execution read")
    }
    return execution(...args)
  }
  const start = follower
    .startTask({ taskID: f.tasks[0]!.id, revision: 1, sessionID: "owner" })
    .then(
      () => "returned",
      (error: Error) => error.message,
    )
  try {
    await running
    await followerRegistration.dispose()
    await follower.stop()
    followerRepository.close()
    closed = true
    expect(await start).toBe("Scheduler registration was disposed")
    release()
    await leaderRegistration.dispose()
    expect(postCloseReads).toBe(0)
    expect((followerRepository as unknown as { connection?: unknown }).connection).toBeUndefined()
    expect(f.store.attempts(f.store.execution(f.tasks[0]!.id)!.planID)).toHaveLength(1)
    expect(f.events.filter((event) => event.startsWith("start:"))).toHaveLength(1)
  } finally {
    release()
    await followerRegistration.dispose()
    await leaderRegistration.dispose()
    await follower.stop()
    await leader.stop()
    followerRepository.close()
  }
})

test("inspector Start admits one real runtime plan and returns record-backed task state", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  const task = f.tasks[0]!
  const input = { taskID: task.id, revision: 1 as const, sessionID: "owner" }
  const [first, concurrent] = await Promise.all([
    f.runtime.startTask(input),
    f.runtime.startTask(input),
  ])
  expect(first).toMatchObject({ status: "started" })
  expect(["running", "verifying"]).toContain(first.state)
  expect(concurrent.planID).toBe(first.planID)
  const second = await f.runtime.startTask(input)
  expect(second).toMatchObject({ status: "existing", planID: first.planID })
  expect(f.store.plans()).toHaveLength(1)
  expect(f.store.attempts(first.planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)

  await drive(f.runtime)
  expect(f.store.execution(task.id)?.state).toBe("accepted")
  expect(
    new TaskReads(f.repository)
      .query({ includeCompleted: true })
      .tasks.find((item) => item.taskID === task.id),
  ).toMatchObject({ status: "accepted", reason: null })
  const detail = new TaskReads(f.repository).get({ taskID: task.id })
  expect(detail).toMatchObject({
    status: "found",
    execution: { planID: first.planID, state: "accepted" },
    attempts: [{ state: "accepted" }],
  })
  if (detail.status === "found")
    expect(detail.activity?.map((event) => event.event)).toContain("ACCEPT")
})

test("Start recovers a lost native continuation-create response after restart", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  f.sessions.get("owner")!.agent = "build"
  const create = f.host.createArchitect
  let calls = 0
  f.host.createArchitect = async (input) => {
    calls++
    if (calls === 1) throw new Error("native create interrupted before commit")
    await create(input)
  }
  const input = { taskID: f.tasks[0]!.id, revision: 1 as const, sessionID: "owner" }
  await expect(f.runtime.startTask(input)).rejects.toThrow(
    "native create interrupted before commit",
  )
  const draft = f.store.plans()[0]!
  const continuation = f.store.continuation(draft.id)!
  expect(draft.state).toBe("draft")
  expect(f.sessions.get(continuation.session_id)).toBeUndefined()

  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  await drive(reopened)
  expect(f.store.plan(draft.id)?.state).toBe("accepted")
  expect(f.store.plan(draft.id)?.owner).toBe(continuation.session_id)
  expect(calls).toBe(2)
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.store.attempts(draft.id)[0]?.session_id).toBeTruthy()
  expect(f.sessions.get(f.store.attempts(draft.id)[0]!.session_id)?.parentID).toBe(
    continuation.session_id,
  )
})

test("run authorizes and validates the original command before creating a continuation", async () => {
  for (const kind of ["foreign", "stale"] as const) {
    const f = fixture({ shared: true })
    f.sessions.get("owner")!.agent = "build"
    const before = f.store.plan(f.receipt.planID)!
    await expect(
      f.runtime.command(
        {
          requestID: "denied-run",
          planID: before.id,
          expectedVersion: kind === "stale" ? 99 : 1,
          action: "run",
        },
        kind === "foreign" ? "not-the-owner" : "owner",
      ),
    ).rejects.toThrow(kind === "foreign" ? "Only the plan owner" : "Stale plan version")
    expect(f.store.plan(before.id)).toEqual(before)
    expect(f.store.continuation(before.id)).toBeNull()
    expect(f.events).toEqual([])
    expect(f.store.attempts(before.id)).toHaveLength(0)
  }
})

test("continued run retains original caller/version replay identity across concurrent calls and restart", async () => {
  const f = fixture({ shared: true })
  f.sessions.get("owner")!.agent = "build"
  const input = {
    requestID: "continued-run",
    planID: f.receipt.planID,
    expectedVersion: 1,
    action: "run",
  }
  const results = await Promise.all([
    f.runtime.command(input, "owner"),
    f.runtime.command(input, "owner"),
  ])
  expect(results[0]).toEqual(results[1])
  expect(await f.runtime.command(input, "owner")).toEqual(results[0])
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  expect(await reopened.command(input, "owner")).toEqual(results[0])
  await expect(reopened.command(input, "not-the-owner")).rejects.toThrow("identity conflict")
  await expect(reopened.command({ ...input, reason: "changed" }, "owner")).rejects.toThrow(
    "identity conflict",
  )
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
})

test("Start admits an existing queued plan, keeps its selected worker route and respects dependencies", async () => {
  const selected = { providerID: "openai", id: "gpt-6-luna", variant: "max" }
  const f = fixture({ shared: true, workerModel: selected, delayed: true })
  f.sessions.get("owner")!.model = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" }
  const result = await f.runtime.startTask({
    taskID: f.tasks[1]!.id,
    revision: 1,
    sessionID: "owner",
  })
  expect(result.planID).toBe(f.receipt.planID)
  expect(f.store.plans()).toHaveLength(1)
  expect(f.store.plan(result.planID)!.state).toBe("running")
  expect(JSON.parse(f.store.plan(result.planID)!.model!)).toEqual(selected)
  expect(f.store.attempts(result.planID).map((attempt) => attempt.task_id)).toEqual([
    f.tasks[0]!.id,
  ])
  const again = await f.runtime.startTask({
    taskID: f.tasks[1]!.id,
    revision: 1,
    sessionID: "owner",
  })
  expect(again.planID).toBe(result.planID)
  expect(f.store.attempts(result.planID)).toHaveLength(1)
})

test("continued run recovers a crash before its receipt without changing caller identity", async () => {
  const f = fixture({ shared: true })
  f.sessions.get("owner")!.agent = "build"
  const input = {
    requestID: "crashed-run",
    planID: f.receipt.planID,
    expectedVersion: 1,
    action: "run",
  }
  const command = f.store.command.bind(f.store)
  f.store.command = () => {
    throw new Error("Injected pre-receipt crash")
  }
  await expect(f.runtime.command(input, "owner")).rejects.toThrow("Injected")
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    owner: "owner",
    version: 1,
    state: "draft",
  })
  f.store.command = command
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  const result = await reopened.command(input, "owner")
  expect(result).toMatchObject({ status: "running" })
  expect(await reopened.command(input, "owner")).toEqual(result)
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
})

test("a concurrent reassignment cannot be overwritten by continuation completion", async () => {
  const f = fixture({ shared: true })
  f.sessions.get("owner")!.agent = "build"
  f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner", agent: "architect" })
  const create = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    await create(input)
    await f.runtime.command(
      {
        requestID: "reassign-during-create",
        planID: f.receipt.planID,
        expectedVersion: 1,
        action: "reassign",
        targetSessionID: "new-owner",
        reason: "Explicit ownership change",
      },
      "owner",
    )
  }
  const input = {
    requestID: "racing-run",
    planID: f.receipt.planID,
    expectedVersion: 1,
    action: "run",
  }
  await expect(f.runtime.command(input, "owner")).rejects.toThrow("Stale plan version")
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    owner: "new-owner",
    version: 2,
    state: "draft",
  })
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(0)
  await expect(f.runtime.command({ ...input, expectedVersion: 2 }, "owner")).rejects.toThrow(
    "Only the plan owner",
  )
})

test("Start cannot adopt a stale continuation after an explicit owner round trip", async () => {
  const f = fixture({ shared: true })
  f.sessions.get("owner")!.agent = "build"
  f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner", agent: "architect" })
  const create = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    await create(input)
    await f.runtime.command(
      {
        requestID: "owner-away",
        planID: f.receipt.planID,
        expectedVersion: 1,
        action: "reassign",
        targetSessionID: "new-owner",
        reason: "Explicit move",
      },
      "owner",
    )
    f.sessions.get("owner")!.agent = "architect"
    await f.runtime.command(
      {
        requestID: "owner-back",
        planID: f.receipt.planID,
        expectedVersion: 2,
        action: "reassign",
        targetSessionID: "owner",
        reason: "Explicit restore",
      },
      "new-owner",
    )
  }
  const input = { taskID: f.tasks[0]!.id, revision: 1 as const, sessionID: "owner" }
  await expect(f.runtime.startTask(input)).rejects.toThrow("Stale plan version")
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    owner: "owner",
    version: 3,
    state: "draft",
  })
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(0)
  expect(await f.runtime.startTask(input)).toMatchObject({
    planID: f.receipt.planID,
    state: "running",
  })
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
})

test("a lost continuation-create response is reconciled by stable native session ID", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  f.sessions.get("owner")!.agent = "build"
  const create = f.host.createArchitect
  let calls = 0
  f.host.createArchitect = async (input) => {
    calls++
    await create(input)
    if (calls === 1) throw new Error("create response lost")
  }
  const result = await f.runtime.startTask({
    taskID: f.tasks[0]!.id,
    revision: 1,
    sessionID: "owner",
  })
  const plan = f.store.plan(result.planID)!
  const continuation = f.store.continuation(plan.id)!
  expect(result).toMatchObject({ status: "started", state: "running" })
  expect(plan.owner).toBe(continuation.session_id)
  expect(calls).toBe(1)

  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  await drive(reopened)
  expect(f.store.plan(plan.id)?.state).toBe("accepted")
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
})

test("a missing task owner gets a same-project continuation without foreign parent context", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  const originalOwner = f.sessions.get("owner")!
  f.sessions.delete("owner")
  f.sessions.set("ses_starter", {
    ...originalOwner,
    id: "ses_starter",
    agent: "build",
  })
  const create = f.host.createArchitect
  let nativeInput: Parameters<RunnerHost["createArchitect"]>[0] | undefined
  f.host.createArchitect = async (input) => {
    nativeInput = input
    await create({ ...input, model: input.model ?? originalOwner.model })
  }

  const result = await f.runtime.startTask({
    taskID: f.tasks[0]!.id,
    revision: 1,
    sessionID: "ses_starter",
  })
  const plan = f.store.plan(result.planID)!
  const continuation = f.store.continuation(plan.id)!
  const owner = f.sessions.get(continuation.session_id)!
  expect(result).toMatchObject({ status: "started", state: "running" })
  expect(nativeInput?.parentID).toBeUndefined()
  expect(nativeInput?.model).toBeUndefined()
  expect(continuation.parent_id).toBeNull()
  expect(owner).toMatchObject({
    projectID: "project",
    directory: f.root,
    agent: "architect",
    parentID: undefined,
    model: originalOwner.model,
  })
  expect(owner.metadata?.lazersSourceSessionID).toBe("owner")
  await drive(f.runtime)
  expect(f.store.plan(plan.id)?.state).toBe("accepted")
})

test("Start admits the configured route independently of the Architect model", async () => {
  const f = fixture({
    shared: true,
    commit: true,
    startOnly: true,
  })
  const selected = { providerID: "custom-provider", id: "selected-model", variant: "careful" }
  f.host.workerModel = async () => selected
  f.sessions.get("owner")!.model = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" }
  const task = f.tasks[0]!
  const result = await f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "owner" })
  expect(result).toMatchObject({ status: "started", state: "running" })
  expect(JSON.parse(f.store.plan(result.planID)!.model!)).toEqual(selected)
  expect(JSON.parse(f.store.plan(result.planID)!.body).workerModel).toBeUndefined()
  const attempt = f.store.attempts(result.planID)[0]!
  expect(JSON.parse(attempt.policy)).not.toHaveProperty("routeDecision")
  expect(f.sessions.get(attempt.session_id)?.model).toEqual(selected)

  const noModel = fixture({ shared: true, commit: true, startOnly: true })
  noModel.host.workerModel = async () => undefined
  const noModelTask = noModel.tasks[0]!
  expect(noModelTask.proposal.classification).toEqual({
    taxonomy: "task-kind/v1",
    primaryKind: "feature-implementation",
  })
  const irrelevantPersonaMapping = new ModelMappingStore(noModel.repository).update({
    target: { scope: "task", taskID: noModelTask.id },
    persona: "systems",
    expectedRevision: 0,
    route: { providerID: "mapped-provider", id: "mapped-model", variant: "future/effort" },
  })
  expect(irrelevantPersonaMapping.status).toBe("updated")
  await expect(
    noModel.runtime.startTask({
      taskID: noModelTask.id,
      revision: 1,
      sessionID: "owner",
    }),
  ).rejects.toThrow("Select an implementor model")
  expect(noModel.store.plans()).toHaveLength(0)
  expect(noModel.events).toEqual([])
})

test("manual Start supports legacy unclassified tasks without inventing persona provenance", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true })
  const proposal = validProposal()
  delete proposal.classification
  const task = f.repository.insert({
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
      startingRevision: { kind: "git", commit: f.base },
    },
    proposal,
  })
  const selected = { providerID: "legacy-provider", id: "legacy-model", variant: "native" }
  f.host.workerModel = async () => selected

  const result = await f.runtime.startTask({
    taskID: task.id,
    revision: 1,
    sessionID: "owner",
  })
  const plan = f.store.plan(result.planID)!
  const attempt = f.store.attempts(result.planID)[0]!
  expect(result).toMatchObject({ status: "started", state: "running" })
  expect(task.proposal.classification).toBeUndefined()
  expect(JSON.parse(plan.body).workerModel).toBeUndefined()
  expect(JSON.parse(attempt.policy)).toMatchObject({ model: selected })
  expect(JSON.parse(attempt.policy)).not.toHaveProperty("routeDecision")
  expect(f.sessions.get(attempt.session_id)?.model).toEqual(selected)
})

test("Go and configured routes reach native execution unchanged alongside independent personas", async () => {
  const choices: { persona: WorkerPersona; model: NonNullable<PlanInput["workerModel"]> }[] = [
    {
      persona: "ui",
      model: { providerID: "opencode-go", id: "qwen3.8-flash", variant: "xhigh" },
    },
    {
      persona: "ui",
      model: { providerID: "custom-provider", id: "configured-model", variant: "careful" },
    },
    {
      persona: "systems",
      model: { providerID: "custom-provider", id: "configured-model", variant: "careful" },
    },
    {
      persona: "systems",
      model: { providerID: "private-provider", id: "unlisted-model", variant: "medium" },
    },
    {
      persona: "small-refactoring",
      model: { providerID: "private-provider", id: "unlisted-model", variant: "medium" },
    },
    {
      persona: "small-refactoring",
      model: { providerID: "opencode-go", id: "qwen3.8-flash", variant: "xhigh" },
    },
  ]
  const overlayText: Record<WorkerPersona, string> = {
    ui: "Use the existing UI primitives and tokens.",
    systems: "Trace the existing contract before editing.",
    "small-refactoring": "Preserve behavior outside the request.",
  }

  for (const choice of choices) {
    const f = fixture({
      shared: true,
      workerModel: choice.model,
      personas: [choice.persona],
    })
    const nativeModels: NonNullable<PlanInput["workerModel"]>[] = []
    const create = f.host.create
    f.host.create = async (input) => {
      nativeModels.push(input.model)
      await create(input)
    }

    await f.runtime.command(
      { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
      "owner",
    )
    await f.runtime.tick()

    const plan = f.store.plan(f.receipt.planID)!
    const attempt = f.store.attempts(plan.id)[0]!
    const prompt = f.sessions.get(attempt.session_id)!.messages[0]!.text
    expect(JSON.parse(plan.model!)).toEqual(choice.model)
    expect(JSON.parse(plan.body).nodes[0].persona).toBe(choice.persona)
    expect(JSON.parse(attempt.policy)).toMatchObject({
      model: choice.model,
      persona: choice.persona,
    })
    expect(nativeModels).toEqual([choice.model])
    expect(prompt).toContain(
      `Selected ${choice.persona === "ui" ? "UI" : choice.persona === "systems" ? "Systems" : "Small task / refactoring"} persona`,
    )
    expect(prompt).toContain(overlayText[choice.persona])
    expect(prompt.match(/Selected .* persona/g)).toHaveLength(1)
  }
})

test("Start of explicitly persona-bearing plans honors mappings for every persona", async () => {
  const personas: WorkerPersona[] = ["ui", "systems", "small-refactoring"]
  const scopes = ["shared", "project", "task"] as const
  const makeRoute = (name: string) => ({
    providerID: `runtime-provider-${name}`,
    id: `runtime-model-${name}`,
    variant: `native-effort/${name}/uncatalogued`,
  })

  for (const persona of personas) {
    for (const scope of scopes) {
      const f = fixture({ shared: true, personas: [persona] })
      const task = f.tasks[0]!
      const mappings = new ModelMappingStore(f.repository)
      const routes = {
        shared: makeRoute(`${persona}-shared`),
        project: makeRoute(`${persona}-project`),
        task: makeRoute(`${persona}-task`),
      }
      const fallback = makeRoute(`${persona}-native-fallback`)
      f.host.workerModel = async () => fallback
      const shared = mappings.update({
        target: { scope: "shared" },
        persona,
        expectedRevision: 0,
        route: routes.shared,
      })
      expect(shared.status).toBe("updated")
      if (scope !== "shared")
        expect(
          mappings.update({
            target: { scope: "project" },
            persona,
            expectedRevision: 0,
            route: routes.project,
          }).status,
        ).toBe("updated")
      if (scope === "task")
        expect(
          mappings.update({
            target: { scope: "task", taskID: task.id },
            persona,
            expectedRevision: 0,
            route: routes.task,
          }).status,
        ).toBe("updated")

      const nativeRoutes: NonNullable<PlanInput["workerModel"]>[] = []
      const create = f.host.create
      f.host.create = async (input) => {
        nativeRoutes.push(input.model)
        await create(input)
      }
      await f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "owner" })

      const attempt = f.store.attempts(f.receipt.planID)[0]!
      const expectedRoute = routes[scope]
      const source = `${scope}-mapping` as const
      const target =
        scope === "shared"
          ? { scope: "shared" as const }
          : scope === "project"
            ? { scope: "project" as const, projectDirectory: f.root }
            : { scope: "task" as const, projectDirectory: f.root, taskID: task.id }
      expect(nativeRoutes).toEqual([expectedRoute])
      expect(JSON.parse(attempt.policy)).toMatchObject({
        model: expectedRoute,
        persona,
        routeDecision: {
          schemaVersion: 1,
          status: "resolved",
          persona,
          source,
          route: expectedRoute,
          provenance: { target, revision: 1 },
        },
      })
      expect(JSON.parse(f.store.plan(f.receipt.planID)!.body).workerModel).toBeUndefined()
    }
  }
})

test("an intentional plan route wins mappings and fallback while native fallback keeps honest provenance", async () => {
  const makeRoute = (name: string) => ({
    providerID: `runtime-provider-${name}`,
    id: `runtime-model-${name}`,
    variant: `native-effort/${name}/uncatalogued`,
  })
  const explicit = makeRoute("explicit-plan")
  const fallback = makeRoute("native-fallback")
  const f = fixture({ shared: true, personas: ["systems"], workerModel: explicit })
  const task = f.tasks[0]!
  const mappings = new ModelMappingStore(f.repository)
  for (const target of [
    { scope: "shared" as const },
    { scope: "project" as const },
    { scope: "task" as const, taskID: task.id },
  ])
    expect(
      mappings.update({
        target,
        persona: "systems",
        expectedRevision: 0,
        route: makeRoute(`mapped-${target.scope}`),
      }).status,
    ).toBe("updated")
  f.host.workerModel = async () => fallback
  const nativeRoutes: NonNullable<PlanInput["workerModel"]>[] = []
  const create = f.host.create
  f.host.create = async (input) => {
    nativeRoutes.push(input.model)
    await create(input)
  }

  await f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "owner" })
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  expect(nativeRoutes).toEqual([explicit])
  expect(JSON.parse(attempt.policy)).toMatchObject({
    model: explicit,
    routeDecision: {
      status: "resolved",
      source: "explicit-plan-selection",
      route: explicit,
      provenance: null,
    },
  })

  const inherited = fixture({
    shared: true,
    personas: ["small-refactoring"],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const admittedFallback = makeRoute("admitted-fallback")
  const inheritedFallback = makeRoute("current-inherited-fallback")
  inherited.host.workerModel = async () => admittedFallback
  await runPlan(inherited)
  inherited.host.workerModel = async () => inheritedFallback
  await inherited.runtime.tick()
  const inheritedAttempt = inherited.store.attempts(inherited.receipt.planID)[0]!
  expect(JSON.parse(inheritedAttempt.policy)).toMatchObject({
    model: inheritedFallback,
    routeDecision: {
      status: "resolved",
      persona: "small-refactoring",
      source: "native-implementor-selection",
      route: inheritedFallback,
      provenance: null,
    },
  })
})

test("a route removed after admission blocks dispatch before creating a worker", async () => {
  const f = fixture({
    shared: true,
    personas: ["systems"],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const admittedFallback = {
    providerID: "admitted-provider",
    id: "admitted-model",
    variant: "admitted/native-effort",
  }
  f.host.workerModel = async () => admittedFallback
  const task = f.tasks[0]!
  const mappings = new ModelMappingStore(f.repository)
  const mapping = mappings.update({
    target: { scope: "task", taskID: task.id },
    persona: "systems",
    expectedRevision: 0,
    route: { providerID: "mapped-provider", id: "mapped-model", variant: "future/effort" },
  })
  expect(mapping.status).toBe("updated")

  await runPlan(f)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("running")
  expect(JSON.parse(f.store.plan(f.receipt.planID)!.model!)).toEqual(admittedFallback)
  expect(
    mappings.update({
      target: { scope: "task", taskID: task.id },
      persona: "systems",
      expectedRevision: 1,
      route: null,
    }).status,
  ).toBe("updated")
  f.host.workerModel = async () => undefined

  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    state: "blocked",
    reason: expect.stringContaining("No native worker route"),
  })
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(0)
})

test("a reopened retry preserves the earlier route decision and uses the current mapping variant", async () => {
  const f = fixture({
    shared: true,
    fail: true,
    personas: ["systems"],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const task = f.tasks[0]!
  const mappings = new ModelMappingStore(f.repository)
  const initialRoute = {
    providerID: "uncatalogued-provider",
    id: "uncatalogued-model",
    variant: "future/effort-v1",
  }
  const updatedRoute = { ...initialRoute, variant: "future/effort-v2" }
  mappings.update({
    target: { scope: "task", taskID: task.id },
    persona: "systems",
    expectedRevision: 0,
    route: initialRoute,
  })
  const nativeRoutes: NonNullable<PlanInput["workerModel"]>[] = []
  const create = f.host.create
  f.host.create = async (input) => {
    nativeRoutes.push(input.model)
    await create(input)
  }
  await f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "owner" })
  const planID = f.store.execution(task.id)!.planID
  const first = f.store.attempts(planID)[0]!
  const firstPolicy = first.policy
  expect(nativeRoutes).toEqual([initialRoute])
  expect(JSON.parse(firstPolicy).routeDecision).toMatchObject({
    source: "task-mapping",
    route: initialRoute,
    provenance: { revision: 1 },
  })

  mappings.update({
    target: { scope: "task", taskID: task.id },
    persona: "systems",
    expectedRevision: 1,
    route: updatedRoute,
  })
  expect(first.policy).toBe(firstPolicy)
  expect(nativeRoutes).toEqual([initialRoute])
  expect(f.sessions.get(first.session_id)?.model).toEqual(initialRoute)
  f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner" })
  await f.runtime.command(
    {
      requestID: "reassign-during-route-attempt",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "reassign",
      targetSessionID: "new-owner",
      reason: "Transfer plan ownership without retargeting its active attempt",
    },
    "owner",
  )
  expect(f.store.attempts(planID)[0]!.policy).toBe(firstPolicy)

  f.completeWorker(first.session_id)
  await drive(f.runtime)
  expect(f.store.attempts(planID)[0]?.state).toBe("failed")
  expect(f.store.plan(planID)?.state).toBe("blocked")
  await f.runtime.command(
    {
      requestID: "retry-with-updated-mapping",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "retry",
      taskID: task.id,
      reason: "Retry using the currently assigned persona route",
    },
    "new-owner",
  )

  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  try {
    await reopened.tick()
  } finally {
    await reopened.stop()
  }
  const attempts = f.store.attempts(planID).filter((attempt) => attempt.task_id === task.id)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]!.policy).toBe(firstPolicy)
  expect(nativeRoutes).toEqual([initialRoute, updatedRoute])
  expect(JSON.parse(attempts[1]!.policy)).toMatchObject({
    model: updatedRoute,
    routeDecision: {
      source: "task-mapping",
      route: updatedRoute,
      provenance: { revision: 2 },
    },
  })
})

test("resuming a mapped attempt preserves its native route after the mapping changes", async () => {
  const f = fixture({
    shared: true,
    delayed: true,
    personas: ["systems"],
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  f.host.workerModel = async () => undefined
  const task = f.tasks[0]!
  const mappings = new ModelMappingStore(f.repository)
  const originalRoute = {
    providerID: "resume-provider",
    id: "resume-model",
    variant: "future/resume-v1",
  }
  const updatedRoute = { ...originalRoute, variant: "future/resume-v2" }
  mappings.update({
    target: { scope: "task", taskID: task.id },
    persona: "systems",
    expectedRevision: 0,
    route: originalRoute,
  })
  const nativeRoutes: NonNullable<PlanInput["workerModel"]>[] = []
  const create = f.host.create
  f.host.create = async (input) => {
    nativeRoutes.push(input.model)
    await create(input)
  }

  const { planID, attempt } = await holdInterruptedAttempt(f)
  const originalPolicy = attempt.policy
  expect(f.store.plan(planID)?.model).toBeNull()
  expect(nativeRoutes).toEqual([originalRoute])
  mappings.update({
    target: { scope: "task", taskID: task.id },
    persona: "systems",
    expectedRevision: 1,
    route: updatedRoute,
  })

  await f.runtime.command(
    {
      requestID: "resume-with-retained-route",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "resume",
      taskID: task.id,
      attemptID: attempt.id,
      reason: "Continue the exact interrupted native assignment",
    },
    "owner",
  )
  await f.runtime.tick()
  const resumed = f.store.attempts(planID)[0]!
  expect(resumed).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
    state: "running",
  })
  expect(resumed.policy).toBe(originalPolicy)
  expect(nativeRoutes).toEqual([originalRoute])
  expect(f.sessions.get(attempt.session_id)?.model).toEqual(originalRoute)
})

test("a native route failure stays visible and is never retried with a substitute", async () => {
  const selected = { providerID: "custom-provider", id: "selected-model", variant: "max" }
  const f = fixture({ shared: true, workerModel: selected })
  const nativeAttempts: NonNullable<PlanInput["workerModel"]>[] = []
  f.host.create = async (input) => {
    nativeAttempts.push(input.model)
    throw new Error("Native provider rejected selected route")
  }

  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()

  expect(nativeAttempts).toEqual([selected])
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    state: "blocked",
    reason: expect.stringContaining("Native provider rejected selected route"),
  })
  expect(JSON.parse(f.store.attempts(f.receipt.planID)[0]!.policy).model).toEqual(selected)
  expect(JSON.parse(f.store.attempts(f.receipt.planID)[0]!.policy)).not.toHaveProperty(
    "routeDecision",
  )
})

test("Start rejects stale, foreign and ended work without changing runtime state", async () => {
  const f = fixture()
  const task = f.tasks[0]!
  f.sessions.set("ses_foreign", {
    ...f.sessions.get("owner")!,
    id: "ses_foreign",
    projectID: "other-project",
    directory: "/other-project",
  })
  await expect(
    f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "missing-session" }),
  ).rejects.toThrow("live session")
  await expect(
    f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "ses_foreign" }),
  ).rejects.toThrow("live session")
  await expect(
    f.runtime.startTask({ taskID: crypto.randomUUID(), revision: 1, sessionID: "owner" }),
  ).rejects.toThrow("not available")
  await expect(
    f.runtime.startTask({ taskID: task.id, revision: 2, sessionID: "owner" } as never),
  ).rejects.toThrow("Stale task revision")
  const foreignTask = f.repository.insert({
    ...task,
    id: crypto.randomUUID(),
    provenance: { ...task.provenance, projectID: "other-project" },
  })
  await expect(
    f.runtime.startTask({ taskID: foreignTask.id, revision: 1, sessionID: "owner" }),
  ).rejects.toThrow("not available in this project")

  await f.runtime.command(
    {
      requestID: "cancel-before-start",
      planID: f.receipt.planID,
      expectedVersion: 1,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  const cancelled = await f.runtime.startTask({ taskID: task.id, revision: 1, sessionID: "owner" })
  expect(cancelled).toMatchObject({ status: "existing", state: "cancelled" })
  expect(f.store.execution(task.id)?.state).toBe("cancelled")
  expect(f.store.plans()).toHaveLength(1) // the fixture plan only
})

test("an admitted source backlog shares only same-pass no-op target observations", async () => {
  const f = fixture()
  const size = 234
  f.store.atomic((db) => {
    const insert = db.query(
      "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,?,?,?,'admitted',0)",
    )
    for (let index = 0; index < size; index++)
      insert.run(
        `reference-${index}`,
        f.receipt.planID,
        "owner",
        `msg_reference_${index}`,
        JSON.stringify({
          status: index === 0 ? "architect-handoff" : "architect-source-reference",
          planID: f.receipt.planID,
          version: index,
          sourceSessionID: "previous",
        }),
      )
  })
  const before = f.store.detail(f.receipt.planID).delivery
  const session = f.host.session
  let ownerReads = 0
  f.host.session = async (id, options) => {
    if (id === "owner") ownerReads++
    return session(id, options)
  }
  await f.runtime.tick()
  expect(ownerReads).toBe(1)
  expect(f.store.detail(f.receipt.planID).delivery).toEqual(before)
  expect(f.inbox.get("owner") ?? []).toHaveLength(0)
  await f.runtime.tick()
  expect(ownerReads).toBe(2)
  expect(f.store.detail(f.receipt.planID).delivery).toEqual(before)
  f.host.session = async () => {
    throw new Error("native owner observation unavailable")
  }
  await f.runtime.tick()
  expect(f.store.latestTransition(f.receipt.planID, null, "PLAN_DELIVERY_FAILED")).toMatchObject({
    error: "native owner observation unavailable",
  })
  expect(f.store.detail(f.receipt.planID).delivery).toEqual(before)

  let sent = false
  let readsAfterAdmission = 0
  const notify = f.host.notify
  f.host.notify = async (input) => {
    await notify(input)
    sent = true
  }
  f.host.session = async (id, options) => {
    if (sent && id === "owner") readsAfterAdmission++
    return session(id, options)
  }
  f.store.atomic((db) =>
    db.query("UPDATE runner_outbox SET state='pending' WHERE id=?").run("reference-117"),
  )
  await f.runtime.tick()
  expect(sent).toBe(true)
  expect(readsAfterAdmission).toBe(1)
  expect(f.inbox.get("owner")).toHaveLength(1)
})

test("admitted outcome rechecks durable owner after native observation awaits", async () => {
  const f = fixture({
    fail: true,
    shared: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  await drive(f.runtime)
  const original = f.store.outboxForDelivery()[0]!
  expect(original.state).toBe("admitted")
  f.sessions.set("changed-owner", {
    ...f.sessions.get("owner")!,
    id: "changed-owner",
    messages: [],
  })
  const session = f.host.session
  let changed = false
  f.host.session = async (id, options) => {
    const result = await session(id, options)
    if (!changed && id === "owner") {
      changed = true
      f.store.updatePlanOwner(f.receipt.planID, "owner", "changed-owner")
    }
    return result
  }
  await f.runtime.tick()
  expect(changed).toBe(true)
  const current = f.store.outboxForDelivery().find((row) => row.id === original.id)!
  expect(current.session_id).toBe("changed-owner")
  expect(current.message_id).not.toBe(original.message_id)
  expect(current.state).toBe("admitted")
  expect(f.inbox.get("owner") ?? []).toHaveLength(0)
  expect(f.inbox.get("changed-owner")).toHaveLength(1)
})

test("host-admitted current outcomes follow an archived owner unless transcript consumption is proved", async () => {
  for (const consumed of [false, true]) {
    const f = fixture({
      fail: true,
      shared: true,
      commit: true,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    await runPlan(f)
    await drive(f.runtime)
    const original = f.store.outboxForDelivery()[0]!
    expect(original.state).toBe("admitted")
    if (consumed) {
      f.inbox.set("owner", [])
      f.sessions.get("owner")!.messages.push({
        id: original.message_id,
        type: "synthetic",
        text: "consumed",
        metadata: JSON.parse(original.metadata!),
      })
    }
    f.sessions.get("owner")!.archived = true
    await f.runtime.stop()
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    const reopened = new TaskRuntime(f.store, f.host, "project")
    try {
      await drive(reopened, 3)
      const owner = f.store.plan(f.receipt.planID)!.owner
      expect(owner).not.toBe("owner")
      const row = (f.store.detail(f.receipt.planID).delivery as (typeof original)[])[0]!
      if (consumed) {
        expect(row.state).toBe("consumed")
        // F-S4-3: retiring after reading a failure still leaves repair to the successor.
        expect(f.inbox.get(owner) ?? []).toHaveLength(1)
        const wake = f.inbox.get(owner)![0]!
        expect(wake.id).not.toBe(original.message_id)
        expect(f.notifications.find((notice) => notice.id === wake.id)?.resume).toBe(true)
      } else {
        expect(row.state).toBe("admitted")
        expect(row.session_id).toBe(owner)
        expect(row.message_id).not.toBe(original.message_id)
        expect(f.inbox.get(owner)).toHaveLength(1)
        expect(JSON.parse(row.receipt!).history).toContainEqual(
          expect.objectContaining({
            previousMessageID: original.message_id,
            replacementMessageID: row.message_id,
            priorDeliveryState: "admitted",
          }),
        )
      }
      expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    } finally {
      await reopened.stop()
    }
  }
})

test("an uncertain current outcome follows an adopted owner across reopen without losing admission evidence", async () => {
  const f = fixture({
    fail: true,
    shared: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  const originalNotify = f.host.notify
  let notifyCalls = 0
  f.host.notify = async (input) => {
    notifyCalls++
    await originalNotify(input)
    if (notifyCalls <= 2)
      throw new Error(
        notifyCalls === 1
          ? "native delivery response lost after admission"
          : "replacement delivery response lost after admission",
      )
  }
  const outbox = (store: RunnerStore) =>
    store.detail(f.receipt.planID).delivery as {
      id: string
      session_id: string
      message_id: string
      payload: string
      state: string
      receipt: string | null
    }[]
  for (
    let index = 0;
    index < 20 && !outbox(f.store).some((row) => row.state === "uncertain");
    index++
  )
    await settleVerification(f.runtime)

  const uncertain = outbox(f.store).find((row) => row.state === "uncertain")!
  expect(JSON.parse(uncertain.payload).status).toBe("blocked")
  expect(outbox(f.store)).toHaveLength(1) // no newer status can mask the current-outcome recovery
  expect(f.inbox.get("owner")?.filter((entry) => entry.id === uncertain.message_id)).toHaveLength(1)
  f.sessions.get("owner")!.archived = true

  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const databasePath = f.repository.path
  const projectDirectory = f.repository.projectDirectory
  f.repository.close()
  const reopenedRepository = new TaskRepository(databasePath, projectDirectory)
  const reopenedStore = new RunnerStore(reopenedRepository)
  reopenedStore.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(reopenedStore, f.host, "project")
  await reopened.tick()
  const adoptedPlan = reopenedStore.plan(f.receipt.planID)!
  let current = outbox(reopenedStore)[0]!
  expect(adoptedPlan.owner).not.toBe("owner")
  expect(f.sessions.get(adoptedPlan.owner)?.parentID).toBeUndefined()
  expect(f.sessions.get(adoptedPlan.owner)?.metadata?.lazersSourceSessionID).toBe("owner")
  expect(f.sessions.get(adoptedPlan.owner)?.agent).toBe("architect")
  expect(current.id).toBe(uncertain.id)
  expect(current.session_id).toBe(adoptedPlan.owner)
  expect(current.message_id).not.toBe(uncertain.message_id)
  const replacementMessageID = current.message_id
  expect(current.state).toBe("uncertain")
  let receiptHistory = JSON.parse(current.receipt!).history as Record<string, unknown>[]
  expect(receiptHistory).toContainEqual(
    expect.objectContaining({
      kind: "native-delivery-uncertain",
      error: "native delivery response lost after admission",
    }),
  )
  expect(receiptHistory).toContainEqual(
    expect.objectContaining({
      kind: "owner-retargeted-current-outcome",
      fromSessionID: "owner",
      toSessionID: adoptedPlan.owner,
      previousMessageID: uncertain.message_id,
      replacementMessageID,
    }),
  )

  await reopened.stop()
  reopenedRepository.close()
  const finalRepository = new TaskRepository(databasePath, projectDirectory)
  const finalStore = new RunnerStore(finalRepository)
  finalStore.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const finalRuntime = new TaskRuntime(finalStore, f.host, "project")
  for (let index = 0; index < 6; index++) await finalRuntime.tick()
  current = outbox(finalStore)[0]!
  expect(current.state).toBe("admitted")
  receiptHistory = JSON.parse(current.receipt!).history as Record<string, unknown>[]
  expect(receiptHistory).toContainEqual(
    expect.objectContaining({
      kind: "native-delivery-uncertain",
      error: "replacement delivery response lost after admission",
    }),
  )
  const successorOutcomes = f.inbox
    .get(adoptedPlan.owner)
    ?.filter((entry) => entry.metadata?.lazersPlanID === f.receipt.planID)
  expect(successorOutcomes).toHaveLength(1)
  expect(successorOutcomes?.[0]?.id).toBe(replacementMessageID)
  expect(current.message_id).toBe(replacementMessageID)
  expect(notifyCalls).toBe(2)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
  expect(finalStore.continuation(f.receipt.planID)?.session_id).toBe(adoptedPlan.owner)
  expect(finalStore.attempts(f.receipt.planID)).toHaveLength(1)
  await finalRuntime.stop()
  finalRepository.close()
})
async function runPlan(
  f: ReturnType<typeof fixture>,
  planID = f.receipt.planID,
  requestID = "run",
) {
  return f.runtime.command(
    {
      requestID,
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "run",
    },
    "owner",
  )
}

test("F-S4-1 admission and dispatch do not invoke the full project audit", async () => {
  const f = fixture({ delayed: true })
  f.store.audit = () => {
    throw new Error("Full audit on dispatch hot path")
  }
  await runPlan(f)
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
  expect(f.store.attempts(f.receipt.planID).length).toBeGreaterThan(0)
})

test("F-S4-2 scheduler dispatches runnable work behind 1000 high-priority terminal plans", async () => {
  const f = fixture({ delayed: true })
  f.store.atomic((db) => {
    const clone = db.query(`INSERT INTO runner_plans
      SELECT ?,project_directory,owner,revision,version,'integrated',json_set(body,'$.priority',100),model,reason,artifact
      FROM runner_plans WHERE id=?`)
    for (let i = 0; i < 1005; i++) clone.run(`history-${i}`, f.receipt.planID)
  })
  expect(f.store.plans().some((plan) => plan.id === f.receipt.planID)).toBe(false)
  await runPlan(f)
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")
})

test("F-S4-2 retirement preserves a live owner's location outside the display window", async () => {
  const f = fixture({ delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.store.atomic((db) => {
    const clone = db.query(`INSERT INTO runner_plans
      SELECT ?,project_directory,owner,revision,version,'integrated',json_set(body,'$.priority',100),model,reason,artifact
      FROM runner_plans WHERE id=?`)
    for (let i = 0; i < 1005; i++) clone.run(`history-${i}`, f.receipt.planID)
    db.query("UPDATE runner_plans SET state='cleanup-blocked' WHERE id=?").run(f.receipt.planID)
  })
  expect(f.store.plans().some((plan) => plan.id === f.receipt.planID)).toBe(false)
  let retired = false
  f.host.retireWorktreeLocation = async () => {
    retired = true
    return "evicted"
  }
  const runtime = f.runtime as unknown as {
    retireCleanedWorktreeLocation(
      plan: { id: string },
      workspace: string,
      current: () => boolean,
    ): Promise<string>
  }
  expect(
    await runtime.retireCleanedWorktreeLocation(
      { id: "another-cleanup" },
      attempt.workspace,
      () => true,
    ),
  ).toBe("reserved-by-other-attempt")
  expect(retired).toBe(false)
})
function setReviewInputObservation(
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
  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: reviewInputID,
    executionStartSequence: 10,
    eventSequence: 11,
    terminalSequence: 12,
    terminalEventID: "event_review_success",
    terminalMessageID: "msg_review_terminal",
    projectDirectory: f.root,
    projectID: "project",
    attemptID: ownedAttempt.id,
    sessionID: ownedAttempt.session_id,
    workspace: ownedAttempt.workspace,
    assignedMessageID: ownedAttempt.message_id,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  return { worker, reviewRequestID }
}

async function heldReviewInputFixture() {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const reviewInputID = "msg_received_review_steer"
  const { worker, reviewRequestID } = setReviewInputObservation(f, attempt, reviewInputID)
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(f.store.plan(f.receipt.planID)?.reason).toContain("current worker input lineage")
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  return { f, attempt, worker, reviewInputID, reviewRequestID }
}

function expireRunnerLease(f: ReturnType<typeof fixture>) {
  f.store.atomic((db) =>
    db.query("UPDATE runner_leases SET expires_at=0 WHERE project_directory=?").run(f.root),
  )
}

function reviewInputCommand(
  f: ReturnType<typeof fixture>,
  attempt: AttemptRow,
  reviewInputID: string,
  requestID = "reconcile-review-steer",
) {
  return {
    requestID,
    planID: f.receipt.planID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    action: "reconcile" as const,
    taskID: attempt.task_id,
    attemptID: attempt.id,
    reviewInputID,
  }
}

async function holdInterruptedAttempt(f: ReturnType<typeof fixture>) {
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: attempt.message_id, state: "interrupted" }
  worker.background = {
    state: "unknown",
    source: "experimental.idle",
    reason: "The replaced process no longer reports its idle hook state",
  }
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.plan(planID)?.reason).toContain("Worker execution was interrupted")
  return { planID, attempt: f.store.attempts(planID)[0]!, worker }
}
async function holdFailedAttempt(
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
  worker.background = {
    state: "unknown",
    source: "experimental.idle",
    reason: "The native idle-hook report is unavailable",
  }
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  return { planID, attempt: f.store.attempts(planID)[0]!, worker }
}
async function acceptedAttemptFixture(options: { syntheticTerminalInput?: boolean } = {}) {
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
    worker.background = {
      state: "observed",
      source: "experimental.idle",
      observedAt: Date.now(),
      inputID: claim.messageID,
      executionStartSequence: 4,
      eventSequence: 5,
      terminalSequence: 6,
      terminalEventID: "event-owned-shell-terminal",
      terminalMessageID: "idle-owned-shell-terminal",
      projectDirectory: f.root,
      projectID: "project",
      attemptID: original.id,
      sessionID: original.session_id,
      workspace: original.workspace,
      assignedMessageID: original.message_id,
      count: 0,
      kinds: { shell: 0, subagent: 0, image: 0 },
    }
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

async function acceptedRetainedRepairFixture() {
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
      expectedVersion: f.store.plan(planID)!.version,
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
    ownerEpoch: number
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

test("retained repair carries an owned captured synthetic terminal input through same-worker dispatch", async () => {
  const { f, planID, task, original, artifact, worker } = await acceptedAttemptFixture({
    syntheticTerminalInput: true,
  })
  const nativeInputID = worker.turn!.inputID!
  expect(nativeInputID).not.toBe(original.message_id)
  expect(
    f.runtime.progress.matchesAssignedInput(
      original.id,
      original.session_id,
      original.message_id,
      nativeInputID,
    ),
  ).toBe(true)
  const originalSessionCount = f.events.filter((event) => event.startsWith("create:")).length
  const result = (await f.runtime.command(
    {
      requestID: "retained-repair-captured-terminal-input",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "retained-repair",
      taskID: task.id,
      attemptID: original.id,
      artifact,
      reason: "Continue from the captured successful native input.",
    },
    "owner",
  )) as { status: string; attemptID: string }
  expect(result).toMatchObject({ status: "retained-repair-requested", attemptID: original.id })
  const admitted = f.store.attempts(planID)[0]!
  const repair = f.store.latestRetainedRepair<{
    previousMessageID: string
    nativeInputID: string
    nativeAssignmentID: string
  }>(planID, task.id)!
  expect(repair).toMatchObject({
    previousMessageID: original.message_id,
    nativeInputID,
    nativeAssignmentID: original.message_id,
  })
  expect(admitted).toMatchObject({
    id: original.id,
    session_id: original.session_id,
    workspace: original.workspace,
    policy: original.policy,
    state: "preparing",
  })
  expect(admitted.message_id).not.toBe(original.message_id)

  await f.runtime.tick()

  const dispatched = f.store.attempts(planID)[0]!
  expect(dispatched).toMatchObject({
    id: original.id,
    session_id: original.session_id,
    workspace: original.workspace,
    policy: original.policy,
    state: "running",
  })
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(originalSessionCount)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
  expect(worker.messages.some((message) => message.id === nativeInputID)).toBe(true)
})

test.each(["uncaptured-synthetic", "foreign-user", "stale-idle", "active-background"] as const)(
  "retained repair rejects %s input evidence before reserving the attempt",
  async (invalidInput) => {
    const { f, planID, task, original, artifact, worker } = await acceptedAttemptFixture()
    const background = worker.background
    if (!background || background.state !== "observed")
      throw new Error("Fixture lacks its captured native idle observation")
    if (invalidInput === "uncaptured-synthetic" || invalidInput === "foreign-user") {
      const foreignInputID = SessionMessage.ID.create()
      worker.messages.push({
        id: foreignInputID,
        type: invalidInput === "foreign-user" ? "user" : "synthetic",
        text: "Unowned terminal input",
      })
      worker.turn = { inputID: foreignInputID, state: "completed" }
      background.inputID = foreignInputID
    } else if (invalidInput === "stale-idle") {
      worker.turn = { inputID: original.message_id, state: "completed" }
      background.inputID = SessionMessage.ID.create()
    } else {
      worker.turn = { inputID: original.message_id, state: "completed" }
      background.count = 1
      background.kinds.shell = 1
    }

    await expect(
      f.runtime.command(
        {
          requestID: `reject-${invalidInput}-retained-repair`,
          planID,
          expectedVersion: f.store.plan(planID)!.version,
          action: "retained-repair",
          taskID: task.id,
          attemptID: original.id,
          artifact,
          reason: "Reject terminal input without exact captured idle ownership.",
        },
        "owner",
      ),
    ).rejects.toThrow()
    expect(f.store.attempts(planID)).toHaveLength(1)
    expect(f.store.attempts(planID)[0]?.message_id).toBe(original.message_id)
    expect(f.store.latestRetainedRepair(planID, task.id)).toBeUndefined()
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  },
)

test("retained repair revalidates the captured terminal input before prompting the original worker", async () => {
  const { f, planID, task, original, artifact, worker } = await acceptedAttemptFixture({
    syntheticTerminalInput: true,
  })
  const before = f.events.filter((event) => event.startsWith("prompt:")).length
  await f.runtime.command(
    {
      requestID: "reserve-captured-terminal-for-dispatch",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "retained-repair",
      taskID: task.id,
      attemptID: original.id,
      artifact,
      reason: "Repair only while the exact captured terminal input remains current.",
    },
    "owner",
  )
  const foreignInputID = SessionMessage.ID.create()
  worker.messages.push({ id: foreignInputID, type: "synthetic", text: "Unowned input" })
  worker.turn = { inputID: foreignInputID, state: "completed" }
  if (worker.background?.state === "observed") worker.background.inputID = foreignInputID

  await f.runtime.tick()

  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("preparing")
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(before)
})

async function reproduceLegacyRetainedRepairFenceFailure() {
  const state = await acceptedRetainedRepairFixture()
  const { f, planID, task, attempt, repair, worker } = state
  worker.tokens = 777
  worker.tools = 23
  worker.cost = 2.5
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: repair.messageID, state: "interrupted" }
  worker.background = {
    state: "unknown",
    source: "experimental.idle",
    reason: "The replaced process no longer has a current background snapshot",
  }
  await f.runtime.tick()
  await f.runtime.stop()
  const reopened = reopenRuntime(f)
  const resume = {
    requestID: "reproduce-retained-repair-fence-failure",
    planID,
    expectedVersion: reopened.store.plan(planID)!.version,
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

  const legacyRuntime = reopened.runtime as unknown as {
    retainedRepairForAttempt: (candidate: AttemptRow) => unknown
  }
  const currentLookup = legacyRuntime.retainedRepairForAttempt
  legacyRuntime.retainedRepairForAttempt = function (candidate) {
    const found = currentLookup.call(reopened.runtime, candidate) as
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
type LegacyFenceState = Awaited<ReturnType<typeof reproduceLegacyRetainedRepairFenceFailure>>

function recoveryCommand(state: LegacyFenceState, requestID: string) {
  return {
    requestID,
    planID: state.planID,
    expectedVersion: state.reopened.store.plan(state.planID)!.version,
    action: "resume" as const,
    taskID: state.task.id,
    attemptID: state.attempt.id,
    reason: "Recover only the original retained repair after its proven fence failure.",
  }
}

function recoveryAdmissionSnapshot(state: LegacyFenceState) {
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

function expectNoRecoveryAdmission(
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => (resolve = complete))
  return { promise, resolve }
}

async function pauseRecoveryAtWorktrees(state: LegacyFenceState, requestID: string) {
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

function reopenRuntime(f: ReturnType<typeof fixture>) {
  const repository = new TaskRepository(f.repository.path, f.root)
  const store = new RunnerStore(repository)
  store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const runtime = new TaskRuntime(store, f.host, "project")
  cleanup.unshift(async () => {
    await runtime.stop()
    repository.close()
  })
  return { store, runtime }
}
async function prepareInterruptedCombinedCheck() {
  const f = fixture({
    taskFiles: [{ name: "a", path: "a.txt" }],
    combinedCheckCommand:
      "printf started > .lazers-combined-started; while [ ! -f .lazers-combined-release ]; do sleep 0.02; done; exit 0",
  })
  await runPlan(f)
  let interruptedEffect: ReturnType<RunnerStore["effects"]>[number] | undefined
  for (let index = 0; index < 30; index++) {
    await f.runtime.tick()
    const effect = f.store
      .effects(f.receipt.planID)
      .find((candidate) => candidate.kind === "graph-verify:combined")
    const activity = effect
      ? verificationActivitiesForDatabase(f.repository.path).find(
          (candidate) => candidate.metadata.effectID === effect.id,
        )
      : undefined
    if (effect && activity?.state === "running") {
      interruptedEffect = effect
      break
    }
    const taskChecks = verificationActivitiesForDatabase(f.repository.path).filter(
      (candidate) =>
        candidate.metadata.planID === f.receipt.planID &&
        typeof candidate.metadata.taskID === "string" &&
        candidate.state === "running",
    )
    await Promise.all(taskChecks.map((candidate) => candidate.settled))
  }
  if (!interruptedEffect) throw new Error("Combined verification did not start")
  const payload = JSON.parse(interruptedEffect.payload) as {
    workspace: string
    receiptPath: string
  }
  await waitForPath(join(payload.workspace, ".lazers-combined-started"))
  await f.runtime.stop()
  rmSync(join(payload.workspace, ".lazers-combined-started"), { force: true })
  rmSync(join(payload.workspace, ".lazers-combined-release"), { force: true })

  const reopened = reopenRuntime(f)
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
  }
}
async function acceptPlan(
  f: ReturnType<typeof fixture>,
  planID: ReturnType<typeof crypto.randomUUID>,
) {
  await runPlan(f, planID, `run-${planID}`)
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(planID)[0]!
  f.completeWorker(attempt.session_id)
  await drive(f.runtime, 6)
  const plan = f.store.plan(planID)!
  expect(plan.state).toBe("accepted")
  return { plan, attempt }
}
function includeArtifact(f: ReturnType<typeof fixture>, artifact: string) {
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
async function recordPlanIntegration(
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
        expectedVersion: accepted.version,
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
      expectedVersion: plan.version,
      action: "integrated",
      artifact: plan.artifact!,
      targetBranch: "main",
      reason: "Record reviewed combined source integration",
    },
    "owner",
  )
}
async function acceptAndIntegratePlan(
  f: ReturnType<typeof fixture>,
  planID: ReturnType<typeof crypto.randomUUID>,
  options: { recordTaskLanding?: boolean } = {},
) {
  const accepted = await acceptPlan(f, planID)
  includeArtifact(f, accepted.plan.artifact!)
  await recordPlanIntegration(f, planID, options)
  return accepted
}
async function cleanupBlockedFixture() {
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
      expectedVersion: plan.version,
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
async function prepareAfterPlanDependency(
  f: ReturnType<typeof fixture>,
  requestID: string,
  priority = 10,
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
  await recordPlanIntegration(f, parentID)
  return { parentID, child, accepted }
}
async function cancelUnstartedPlan(f: ReturnType<typeof fixture>, planID = f.receipt.planID) {
  await runPlan(f, planID, `run-${planID}`)
  const plan = f.store.plan(planID)!
  await f.runtime.command(
    {
      requestID: `cancel-${planID}`,
      planID,
      expectedVersion: plan.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  return f.store.plan(planID)!
}
async function failSecondSharedTask(f: ReturnType<typeof fixture>) {
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
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
function attemptCheck(
  f: ReturnType<typeof fixture>,
  taskID: string,
  attemptID: string,
): CheckReceipt {
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
  return (JSON.parse(effect.receipt) as { check: CheckReceipt }).check
}
const skillBodyCanary = "SECRET_SKILL_BODY_CANARY"
function seedLegacySkillBody(
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
function expectNoSkillBody(policyText: string) {
  expect(policyText).not.toContain(skillBodyCanary)
  const policy = JSON.parse(policyText) as Record<string, unknown>
  expect(policy.skills).toBeUndefined()
  expect(JSON.parse(policy.context as string)).not.toHaveProperty("skills")
}

test("real Git worktrees execute a dependency graph, verify combined content and retain origin", async () => {
  const f = fixture()
  expect(f.store.submit(f.input, "owner")).toEqual(f.receipt)
  expect(() => f.store.submit({ ...f.input, objective: "changed" }, "owner")).toThrow(
    "identity conflict",
  )
  expect(() => f.store.submit({ ...f.input, requestID: "second-plan" }, "owner")).toThrow("UNIQUE")
  expect(f.store.execution(f.tasks[1]!.id)?.waitingOn).toEqual([f.tasks[0]!.id])
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime, 16)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.nodes(f.receipt.planID).map((n) => n.state)).toEqual(["accepted", "accepted"])
  expect(f.events.filter((e) => e.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((e) => e.startsWith("prompt:"))).toHaveLength(2)
  expect(f.store.effects(f.receipt.planID).every((e) => e.state === "completed")).toBe(true)
  const plan = f.store.plan(f.receipt.planID)!
  expect(git(f.root, ["show", `${plan.artifact}:a.txt`])).toBe("a")
  expect(git(f.root, ["show", `${plan.artifact}:b.txt`])).toBe("b")
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(f.base)
  expect(readFileSync(join(f.root, "dirty-sentinel.txt"), "utf8")).toBe("preserve me")
  expect(
    f.inbox
      .get("owner")
      ?.some(
        (entry) =>
          entry.metadata &&
          "lazersPlanID" in entry.metadata &&
          entry.metadata.lazersPlanID === plan.id,
      ),
  ).toBe(true)
  const workers = f.store.attempts(plan.id)
  expect(workers[1]!.base_commit).toBe(workers[0]!.artifact!)
  expect(JSON.parse(workers[0]!.policy).packet).toEqual({
    recipe: "task-tool/1",
    taskID: workers[0]!.task_id,
    tool: "lz-get-task",
  })
  await drive(f.runtime)
  expect(f.events.filter((e) => e.startsWith("create:"))).toHaveLength(2)
})

test.each([false, true])(
  "authorized formatting is committed before verification (shared=%s)",
  async (shared) => {
    const f = fixture({
      shared,
      taskFiles: [{ name: "a", path: "src/result.ts" }],
      checkCommand: "bun fmt --check src/result.ts",
      combinedCheckCommand: "test -f src/result.ts",
    })
    await runPlan(f)
    await drive(f.runtime, 18)
    const plan = f.store.plan(f.receipt.planID)!
    const attempt = f.store.attempts(plan.id)[0]!
    expect(plan.state).toBe("accepted")
    expect(f.store.attempts(plan.id)).toHaveLength(1)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
    const committed = spawnSync("git", ["show", `${attempt.artifact}:src/result.ts`], {
      cwd: f.root,
      encoding: "utf8",
    }).stdout
    expect(committed).toBe(readFileSync(join(attempt.workspace, "src/result.ts"), "utf8"))
    expect(committed).not.toBe("a")
    expect(attempt.artifact).toBeTruthy()
    const preparation = f.store.effects(plan.id).find((effect) => effect.kind === "mechanical-fix")!
    expect(preparation.state).toBe("completed")
    const preparedReceipt = (JSON.parse(preparation.receipt!) as { check: CheckReceipt }).check
    expect(preparedReceipt.preparation?.inputFingerprint).not.toBe(
      preparedReceipt.preparation?.resultingFingerprint,
    )
    const verified = attemptCheck(f, f.tasks[0]!.id, attempt.id)
    expect(verified.artifact).toBe(attempt.artifact!)
    expect(verified.inputIdentity).toBe(attempt.artifact!)
    expect(verified.exitCode).toBe(0)
  },
)

test("a committed shared-checkout correction gets fresh mechanical preparation", async () => {
  const f = fixture({
    shared: true,
    human: true,
    taskFiles: [{ name: "a", path: "src/result.ts" }],
    checkCommand: "bun fmt --check src/result.ts",
  })
  await runPlan(f)
  await drive(f.runtime, 12)
  const planID = f.receipt.planID
  expect(f.store.plan(planID)?.reason).toContain("Required evidence missing")
  const attemptID = f.store.attempts(planID)[0]!.id
  writeFileSync(join(f.root, "src/result.ts"), "export const correction=1\n")
  git(f.root, ["add", "src/result.ts"])
  git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Correct the retained candidate",
  ])
  await f.runtime.command(
    {
      requestID: "reconcile-correction",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await f.runtime.tick()
  const activities = verificationActivitiesForDatabase(f.repository.path)
  expect(activities).toHaveLength(1)
  await activities[0]!.settled
  await f.runtime.tick()
  expect(
    f.store.effects(planID).filter((effect) => effect.kind.startsWith("verify:")),
  ).toHaveLength(2)
  await drive(f.runtime, 12)
  expect(f.store.plan(planID)?.reason).toContain("Required evidence missing")
  expect(f.store.attempts(planID).map((attempt) => attempt.id)).toEqual([attemptID])
  expect(readFileSync(join(f.root, "src/result.ts"), "utf8")).toContain("correction = 1")
  const effects = f.store.effects(planID).filter((effect) => effect.kind === "mechanical-fix")
  expect(effects.map((effect) => effect.state)).toEqual(["completed", "completed"])
  expect(new Set(effects.map((effect) => JSON.parse(effect.payload).receiptPath)).size).toBe(2)
}, 15_000)

test("out-of-scope candidate changes are not mechanically modified", async () => {
  const f = fixture({
    outside: true,
    taskFiles: [{ name: "a", path: "src/result.ts", scope: ["src/**"] }],
    checkCommand: "bun fmt --check src/result.ts",
  })
  await runPlan(f)
  await drive(f.runtime, 8)
  const plan = f.store.plan(f.receipt.planID)!
  const attempt = f.store.attempts(plan.id)[0]!
  expect(plan.state).toBe("blocked")
  expect(readFileSync(join(attempt.workspace, "src/result.ts"), "utf8")).toBe("a")
  expect(f.store.effects(plan.id).some((effect) => effect.kind === "mechanical-fix")).toBe(false)
})

test("a real verification barrier does not block same-project dispatch, cancellation, or delivery", async () => {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const f = fixture({
    delayed: true,
    independent: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    checkCommand: (name, _path, root) =>
      name === "a"
        ? `printf x >> ${quote(join(root, ".lazers-check-started"))}; while [ ! -f ${quote(join(root, ".lazers-check-release"))} ]; do sleep 0.02; done; test "$(cat a.txt)" = "a"`
        : `test "$(cat ${name}.txt)" = "${name}"`,
  })
  const control = await registeredPlanCommand(f.runtime)
  const run = async (planID: string, requestID: string) => {
    const plan = f.store.plan(planID)!
    await control.execute({ requestID, planID, expectedVersion: plan.version, action: "run" })
  }
  const taskB = f.createTask("b", "b.txt")
  const planB = f.store.submit(f.inputFor([taskB], { requestID: "barrier-plan-b" }), "owner")
  const taskC = f.createTask("c", "c.txt")
  const planC = f.store.submit(f.inputFor([taskC], { requestID: "barrier-plan-c" }), "owner")
  const taskD = f.createTask("d", "d.txt")
  const planD = f.store.submit(f.inputFor([taskD], { requestID: "barrier-plan-d" }), "owner")

  await run(f.receipt.planID, "barrier-run-a")
  await f.runtime.tick()
  const attemptA = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attemptA.session_id)
  await f.runtime.tick()
  const started = join(f.root, ".lazers-check-started")
  const release = join(f.root, ".lazers-check-release")
  await waitForPath(started)
  const effectA = f.store
    .effects(f.receipt.planID)
    .find((effect) => effect.kind === "verify:content")!
  const pending = verificationActivitiesForDatabase(f.repository.path).find(
    (activity) => activity.metadata.effectID === effectA.id,
  )!
  expect(pending.state).toBe("running")
  expect(existsSync(release)).toBe(false)

  await run(planC.planID, "barrier-run-c")
  await f.runtime.tick()
  await run(planB.planID, "barrier-run-b")
  await control.execute({
    requestID: "barrier-cancel-c",
    planID: planC.planID,
    expectedVersion: f.store.plan(planC.planID)!.version,
    action: "cancel",
  })
  await control.execute({
    requestID: "barrier-cancel-d",
    planID: planD.planID,
    expectedVersion: f.store.plan(planD.planID)!.version,
    action: "cancel",
  })
  const competing = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(async () => competing.stop())
  await Promise.all([f.runtime.tick(), f.runtime.tick(), f.runtime.tick(), competing.tick()])

  expect(pending.state).toBe("running")
  expect(readFileSync(started, "utf8")).toBe("x")
  expect(
    f.store.effects(f.receipt.planID).filter((effect) => effect.kind === "verify:content"),
  ).toHaveLength(1)
  expect(f.store.attempts(planB.planID)).toHaveLength(1)
  expect(f.store.attempts(planC.planID)[0]?.state).toBe("cancelled")
  expect(f.store.plan(planC.planID)?.state).toBe("cancelled")
  expect(f.store.plan(planD.planID)?.state).toBe("cancelled")
  expect(f.notifications.some((notice) => notice.text.includes('"status":"cancelled"'))).toBe(true)

  writeFileSync(release, "release\n")
  await pending.settled
  await drive(f.runtime, 5)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
})

test("runtime stop aborts checks admitted by its draining tick before storage disposal", async () => {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const f = fixture({
    taskFiles: [{ name: "a", path: "a.txt" }],
    checkCommand: (_name, _path, root) =>
      `printf started > ${quote(join(root, "check-started"))}; printf "%s" "$$" > ${quote(join(root, "check-pid"))}; while [ ! -f ${quote(join(root, "check-release"))} ]; do sleep 0.02; done; exit 0`,
    combinedCheckCommand: "true",
  })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id)

  let observed!: () => void
  const observationEntered = new Promise<void>((resolve) => (observed = resolve))
  let release!: () => void
  const observationRelease = new Promise<void>((resolve) => (release = resolve))
  let blocked = false
  const originalSession = f.host.session.bind(f.host)
  f.host.session = async (id, options) => {
    if (id === attempt.session_id && options?.messages && !blocked) {
      blocked = true
      observed()
      await observationRelease
    }
    return originalSession(id, options)
  }
  let admitted!: () => void
  const verificationAdmitted = new Promise<void>((resolve) => (admitted = resolve))
  let drain!: () => void
  const drainRelease = new Promise<void>((resolve) => (drain = resolve))
  const runtimeInternals = f.runtime as unknown as {
    verify: (...args: unknown[]) => Promise<void>
  }
  const originalVerify = runtimeInternals.verify.bind(f.runtime)
  runtimeInternals.verify = async (...args) => {
    await originalVerify(...args)
    admitted()
    await drainRelease
  }

  const advancing = f.runtime.tick()
  await observationEntered
  const stopping = f.runtime.stop()
  // Let stop take its first activity snapshot while the tick is held before
  // it admits the check; releasing the observation then exercises the late
  // activity sweep after the drain reaches idle.
  await new Promise<void>((resolve) => setImmediate(resolve))
  release()
  await verificationAdmitted
  await waitForPath(join(f.root, "check-started"), 3_000)

  const effect = f.store.effects(f.receipt.planID).find((item) => item.kind === "verify:content")!
  const activity = verificationActivitiesForDatabase(f.repository.path).find(
    (item) => item.metadata.effectID === effect.id,
  )!
  expect(activity.owner).toBe(f.runtime.owner)
  expect(activity.state).toBe("running")
  drain()
  await Promise.all([advancing, stopping])
  runtimeInternals.verify = originalVerify
  expect(activity.state).toBe("completed")
  expect(
    verificationActivitiesForDatabase(f.repository.path).some((item) => item.state === "running"),
  ).toBe(false)
  const checkedAttempt = f.store.attempts(f.receipt.planID)[0]!
  const receiptPath = (JSON.parse(effect.payload) as { receiptPath: string }).receiptPath
  expect(existsSync(receiptPath)).toBe(true)
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as CheckReceipt
  expect(receipt).toMatchObject({
    id: "content",
    artifact: checkedAttempt.artifact,
    inputIdentity: checkedAttempt.artifact,
    exitCode: expect.any(Number),
    timedOut: false,
    aborted: true,
    processCleanup: { state: "terminated", capability: "process-group" },
  })
  expect(checkResourcesSettled(receipt)).toBe(true)
  expect(effect.state).toBe("intended")

  const reopened = reopenRuntime(f)
  await reopened.runtime.tick()
  const recovered = reopened.store.effects(f.receipt.planID).find((item) => item.id === effect.id)!
  // F-S5-1: shutdown is an interruption, never a failed product check or worker repair.
  expect(recovered.state).toBe("uncertain")
  expect(reopened.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(reopened.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(reopened.store.attempts(f.receipt.planID)[0]?.state).toBe("verifying")
  writeFileSync(join(f.root, "check-release"), "release\n")
  await reopened.runtime.tick()
  expect(
    reopened.store.effects(f.receipt.planID).filter((item) => item.kind === "verify:content"),
  ).toHaveLength(2)
  await drive(reopened.runtime, 8)
  expect(reopened.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(reopened.store.attempts(f.receipt.planID)).toHaveLength(1)
  const checks = reopened.store
    .effects(f.receipt.planID)
    .filter((item) => item.kind === "verify:content")
  expect(checks).toHaveLength(2)
  expect(checks.find((item) => item.id === effect.id)?.state).toBe("failed")
  expect(readFileSync(receiptPath, "utf8")).toContain('"aborted":true')
  expect(readFileSync(join(f.root, "check-started"), "utf8")).toBe("started")
})

test("reopening verification reruns only the interrupted check", async () => {
  const f = fixture({
    taskFiles: [{ name: "a", path: "a.txt" }],
    beforeCheck: "true",
    checkCommand: (_name, _path, root) =>
      `touch '${root}/check-started'; while [ ! -f '${root}/check-release' ]; do sleep 0.02; done`,
  })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id)
  await f.runtime.tick()
  const first = verificationActivitiesForDatabase(f.repository.path).find(
    (activity) => activity.metadata.planID === f.receipt.planID,
  )!
  await first.settled
  await f.runtime.tick()
  await waitForPath(join(f.root, "check-started"), 3_000)
  await f.runtime.stop()

  const reopened = reopenRuntime(f)
  writeFileSync(join(f.root, "check-release"), "release\n")
  await drive(reopened.runtime, 8)
  const effects = reopened.store.effects(f.receipt.planID)
  expect(effects.filter((effect) => effect.kind === "verify:before")).toHaveLength(1)
  expect(effects.filter((effect) => effect.kind === "verify:content")).toHaveLength(2)
  expect(reopened.store.plan(f.receipt.planID)?.state).toBe("accepted")
})

test("registered plan command resumes settled combined verification without replaying accepted workers", async () => {
  const state = await prepareInterruptedCombinedCheck()
  const { f, reopened, interrupted, receiptPath, planID } = state
  const originalReceipt = interrupted.receipt!
  const originalDiskReceipt = readFileSync(receiptPath, "utf8")
  const taskArtifact = reopened.store.nodes(planID)[0]!.artifact
  const command = {
    requestID: "resume-combined-after-interruption",
    planID,
    expectedVersion: reopened.store.plan(planID)!.version,
    action: "resume" as const,
    reason: "Continue the accepted artifacts after the settled combined-check interruption.",
  }
  expect(reopened.store.plan(planID)?.state).toBe("blocked")
  expect(reopened.store.nodes(planID).map((node) => node.state)).toEqual(["accepted"])

  const registered = await registeredPlanCommand(reopened.runtime)
  // The caller loses this reply when the owner process is replaced.
  await registered.execute(command)
  await reopened.runtime.stop()

  const replayedRuntime = reopenRuntime(f)
  const reply = await (await registeredPlanCommand(replayedRuntime.runtime)).execute(command)
  const serializedReply =
    typeof reply.content === "string"
      ? reply.content
      : reply.content?.find((item) => item.type === "text")?.text
  if (!serializedReply) throw new Error("Registered plan command did not return its replay receipt")
  const replay = JSON.parse(serializedReply)
  expect(replay).toMatchObject({
    status: "combined-verification-resumed",
    planID,
    artifact: expect.any(String),
    verificationEpoch: command.expectedVersion + 1,
  })
  const oldAfterReplay = replayedRuntime.store
    .effects(planID)
    .find((effect) => effect.id === interrupted.id)!
  expect(oldAfterReplay.state).toBe("failed")
  expect(oldAfterReplay.receipt).toBe(originalReceipt)
  expect(readFileSync(receiptPath, "utf8")).toBe(originalDiskReceipt)
  expect(
    replayedRuntime.store
      .effects(planID)
      .filter((effect) => effect.kind === "graph-verify:combined"),
  ).toHaveLength(1)

  await replayedRuntime.runtime.tick()
  const combinedChecksBeforeCompletion = replayedRuntime.store
    .effects(planID)
    .filter((effect) => effect.kind === "graph-verify:combined")
  const fresh = combinedChecksBeforeCompletion.find((effect) => effect.id !== interrupted.id)!
  const freshPayload = JSON.parse(fresh.payload) as {
    artifact: string
    workspace: string
    verificationEpoch: number
    combinedContinuationFingerprint: string
    receiptPath: string
  }
  await waitForPath(join(freshPayload.workspace, ".lazers-combined-started"))
  const freshActivity = verificationActivitiesForDatabase(f.repository.path).find(
    (activity) => activity.metadata.effectID === fresh.id,
  )!
  writeFileSync(join(freshPayload.workspace, ".lazers-combined-release"), "release\n")
  await freshActivity.settled
  rmSync(join(freshPayload.workspace, ".lazers-combined-started"), { force: true })
  rmSync(join(freshPayload.workspace, ".lazers-combined-release"), { force: true })
  await drive(replayedRuntime.runtime, 8)

  const plan = replayedRuntime.store.plan(planID)!
  const checks = replayedRuntime.store
    .effects(planID)
    .filter((effect) => effect.kind === "graph-verify:combined")
  const freshCompleted = checks.find((effect) => effect.id === fresh.id)!
  expect(plan.state).toBe("accepted")
  expect(plan.artifact).toBe(freshPayload.artifact)
  expect(freshCompleted.state).toBe("completed")
  expect(freshPayload.artifact).toBe(
    (JSON.parse(interrupted.payload) as { artifact: string }).artifact,
  )
  expect(freshPayload.verificationEpoch).toBeGreaterThan(0)
  expect(freshPayload.workspace).toBe(
    (JSON.parse(interrupted.payload) as { workspace: string }).workspace,
  )
  expect(freshPayload.combinedContinuationFingerprint).toBeTruthy()
  const freshReceipt = (JSON.parse(freshCompleted.receipt!) as { check: CheckReceipt }).check
  expect(freshReceipt).toMatchObject({ artifact: freshPayload.artifact, exitCode: 0 })
  expect(freshReceipt.aborted).not.toBe(true)
  expect(freshPayload.receiptPath).not.toBe(receiptPath)
  expect(checks).toHaveLength(2)
  expect(checks.find((effect) => effect.id === interrupted.id)?.receipt).toBe(originalReceipt)
  expect(replayedRuntime.store.nodes(planID)[0]?.artifact).toBe(taskArtifact)
  expect(replayedRuntime.store.attempts(planID)).toHaveLength(1)
  expect(
    replayedRuntime.store.effects(planID).filter((effect) => effect.kind === "verify:content"),
  ).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(readFileSync(receiptPath, "utf8")).toBe(originalDiskReceipt)
  expect(readFileSync(receiptPath, "utf8")).toContain('"aborted":true')
})

test("combined verification resume rejects wrong authority, changed candidates and unresolved activity", async () => {
  const { f, reopened, interrupted, planID } = await prepareInterruptedCombinedCheck()
  const plan = reopened.store.plan(planID)!
  const baseCommand = {
    planID,
    expectedVersion: plan.version,
    action: "resume" as const,
    reason: "Continue the exact accepted artifacts after interruption.",
  }
  const command = (requestID: string) => ({ ...baseCommand, requestID })
  const originalNodeArtifact = reopened.store.nodes(planID)[0]!.artifact!
  const originalReceipt = interrupted.receipt!

  await expect(reopened.runtime.command(command("wrong-owner"), "foreign")).rejects.toThrow(
    "Only the plan owner",
  )
  await expect(
    reopened.runtime.command(
      { ...command("stale-plan"), expectedVersion: plan.version - 1 },
      "owner",
    ),
  ).rejects.toThrow("Stale plan version")
  f.sessions.get("owner")!.projectID = "foreign-project"
  await expect(reopened.runtime.command(command("wrong-project"), "owner")).rejects.toThrow(
    "current same-project Architect",
  )
  f.sessions.get("owner")!.projectID = "project"

  reopened.store.atomic((db) =>
    db
      .query("UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=?")
      .run(f.base, planID, f.tasks[0]!.id),
  )
  await expect(reopened.runtime.command(command("changed-candidate"), "owner")).rejects.toThrow(
    "retain its accepted artifact",
  )
  reopened.store.atomic((db) =>
    db
      .query("UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=?")
      .run(originalNodeArtifact, planID, f.tasks[0]!.id),
  )

  const interruptedPayload = JSON.parse(interrupted.payload) as { workspace: string }
  const changedCandidate = join(interruptedPayload.workspace, ".lazers-candidate-change")
  writeFileSync(changedCandidate, "candidate changed\n")
  await expect(reopened.runtime.command(command("changed-workspace"), "owner")).rejects.toThrow(
    "candidate changed",
  )
  rmSync(changedCandidate, { force: true })

  const missingCleanup = JSON.parse(originalReceipt) as { result: { check: CheckReceipt } }
  delete missingCleanup.result.check.processCleanup
  reopened.store.atomic((db) =>
    db
      .query("UPDATE runner_effects SET receipt=? WHERE id=?")
      .run(JSON.stringify(missingCleanup), interrupted.id),
  )
  await expect(
    reopened.runtime.command(command("missing-cleanup-evidence"), "owner"),
  ).rejects.toThrow("conclusively settled")
  reopened.store.atomic((db) =>
    db.query("UPDATE runner_effects SET receipt=? WHERE id=?").run(originalReceipt, interrupted.id),
  )

  const unsettled = JSON.parse(originalReceipt) as { result: { check: CheckReceipt } }
  unsettled.result.check.processCleanup = {
    state: "uncertain",
    capability: "process-group",
    detail: "simulated unsettled combined check",
  }
  reopened.store.atomic((db) =>
    db
      .query("UPDATE runner_effects SET receipt=? WHERE id=?")
      .run(JSON.stringify(unsettled), interrupted.id),
  )
  await expect(reopened.runtime.command(command("unsettled-resources"), "owner")).rejects.toThrow(
    "conclusively settled",
  )
  reopened.store.atomic((db) =>
    db.query("UPDATE runner_effects SET receipt=? WHERE id=?").run(originalReceipt, interrupted.id),
  )

  const liveActivity = startVerificationActivity({
    databasePath: f.repository.path,
    key: verificationActivityKey(f.repository.path, "live-combined-probe"),
    identity: "live-combined-probe",
    owner: "test-runtime",
    metadata: { kind: "effect", planID, projectDirectory: f.root },
    run: (signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  }).activity
  await Promise.resolve()
  await expect(reopened.runtime.command(command("live-activity"), "owner")).rejects.toThrow(
    "live verification activity",
  )
  liveActivity.controller.abort()
  await liveActivity.settled
  forgetVerificationActivity(liveActivity.key, liveActivity.identity)

  const unrelatedEffectID = crypto.randomUUID()
  reopened.store.atomic((db) =>
    db
      .query("INSERT INTO runner_effects VALUES(?,?,NULL,NULL,?,'uncertain',?,NULL,1)")
      .run(unrelatedEffectID, planID, "unrelated", JSON.stringify({ uncertainty: true })),
  )
  await expect(reopened.runtime.command(command("unrelated-effect"), "owner")).rejects.toThrow(
    "unrelated unresolved effects",
  )
  reopened.store.atomic((db) =>
    db.query("DELETE FROM runner_effects WHERE id=?").run(unrelatedEffectID),
  )

  expect(reopened.store.plan(planID)?.state).toBe("blocked")
  expect(
    reopened.store.effects(planID).filter((effect) => effect.kind === "graph-verify:combined"),
  ).toHaveLength(1)
  expect(
    reopened.store.effects(planID).find((effect) => effect.id === interrupted.id)?.receipt,
  ).toBe(originalReceipt)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)

  const resumed = command("unrelated-effect-after-admission")
  await reopened.runtime.command(resumed, "owner")
  await reopened.runtime.tick()
  const fresh = reopened.store
    .effects(planID)
    .find((effect) => effect.kind === "graph-verify:combined" && effect.id !== interrupted.id)!
  const freshPayload = JSON.parse(fresh.payload) as { workspace: string }
  const freshActivity = verificationActivitiesForDatabase(f.repository.path).find(
    (activity) => activity.metadata.effectID === fresh.id,
  )!
  await waitForPath(join(freshPayload.workspace, ".lazers-combined-started"))
  reopened.store.atomic((db) =>
    db
      .query("INSERT INTO runner_effects VALUES(?,?,NULL,NULL,?,'uncertain',?,NULL,1)")
      .run(unrelatedEffectID, planID, "unrelated", JSON.stringify({ uncertainty: true })),
  )
  writeFileSync(join(freshPayload.workspace, ".lazers-combined-release"), "release\n")
  await freshActivity.settled
  rmSync(join(freshPayload.workspace, ".lazers-combined-started"), { force: true })
  rmSync(join(freshPayload.workspace, ".lazers-combined-release"), { force: true })
  await drive(reopened.runtime, 4)
  expect(reopened.store.plan(planID)?.state).not.toBe("accepted")
  expect(reopened.store.plan(planID)?.artifact).toBe(null)
  expect(reopened.store.effects(planID).find((effect) => effect.id === fresh.id)?.state).toBe(
    "completed",
  )
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test.each([false, true])(
  "an exit-zero check with uncertain cleanup survives stop-before-reconcile=%s and reopen",
  async (stopBeforeReconcile) => {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const f = fixture({
      taskFiles: [{ name: "a", path: "a.txt" }],
      checkCommand: (_name, _path, root) =>
        `printf x >> ${quote(join(root, "check-count"))}; printf "%s" "$$" > ${quote(join(root, "check-pid"))}; sleep 30 >/dev/null 2>&1 & while [ ! -f ${quote(join(root, "check-release"))} ]; do sleep 0.02; done; exit 0`,
      combinedCheckCommand: "true",
    })
    const originalKill = process.kill.bind(process)
    const pidPath = join(f.root, "check-pid")
    const releasePath = join(f.root, "check-release")
    let processGroupID: number | undefined
    const mockedKill = spyOn(process, "kill").mockImplementation(((pid, signal) => {
      if (typeof pid === "number" && processGroupID !== undefined && pid === -processGroupID) {
        if (signal === 0) return true
        if (signal === "SIGKILL") throw new Error("simulated process-group cleanup failure")
      }
      return originalKill(pid, signal)
    }) as typeof process.kill)
    try {
      await runPlan(f)
      await f.runtime.tick()
      const attempt = f.store.attempts(f.receipt.planID)[0]!
      f.completeWorker(attempt.session_id)
      await f.runtime.tick()
      await waitForPath(pidPath)
      processGroupID = Number(readFileSync(pidPath, "utf8"))
      writeFileSync(releasePath, "go\n")
      const effect = f.store
        .effects(f.receipt.planID)
        .find((candidate) => candidate.kind === "verify:content")!
      const activity = verificationActivitiesForDatabase(f.repository.path).find(
        (candidate) => candidate.metadata.effectID === effect.id,
      )!
      await activity.settled
      if (stopBeforeReconcile) {
        expect(activity.state).toBe("completed")
        await expect(f.runtime.stop()).rejects.toThrow("subprocess cleanup remains uncertain")
        const reopened = reopenRuntime(f)
        await drive(reopened.runtime, 4)
      } else await drive(f.runtime, 4)

      const uncertain = f.store
        .effects(f.receipt.planID)
        .find((candidate) => candidate.id === effect.id)!
      const envelope = JSON.parse(uncertain.receipt!) as {
        result: { check: CheckReceipt }
      }
      expect(uncertain.state).toBe("uncertain")
      expect(envelope.result.check).toMatchObject({
        exitCode: 0,
        timedOut: false,
        processCleanup: {
          state: "uncertain",
          capability: "process-group",
          rootPID: processGroupID,
        },
      })
      expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
      expect(readFileSync(join(f.root, "check-count"), "utf8")).toBe("x")

      await f.runtime.stop()
      const reopened = reopenRuntime(f)
      await reopened.runtime.tick()
      const afterReopen = reopened.store
        .effects(f.receipt.planID)
        .find((candidate) => candidate.id === effect.id)!
      expect(afterReopen.state).toBe("uncertain")
      expect((JSON.parse(afterReopen.receipt!) as typeof envelope).result.check.exitCode).toBe(0)
      expect(
        reopened.store
          .effects(f.receipt.planID)
          .filter((candidate) => candidate.kind === "verify:content"),
      ).toHaveLength(1)
      expect(readFileSync(join(f.root, "check-count"), "utf8")).toBe("x")
    } finally {
      mockedKill.mockRestore()
      if (processGroupID !== undefined) {
        try {
          originalKill(-processGroupID, "SIGKILL")
        } catch {
          // The subprocess tree may have exited while the retained receipt was inspected.
        }
      }
    }
  },
)

test("whole-plan cancellation interrupts busy siblings while retaining uncertain check ownership", async () => {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: ["a", "b", "c"].map((name) => ({ name, path: `${name}.txt` })),
    checkCommand: (_name, _path, root) =>
      `printf "%s" "$$" > ${quote(join(root, "uncertain-pid"))}; sleep 30 >/dev/null 2>&1 & while [ ! -f ${quote(join(root, "uncertain-release"))} ]; do sleep 0.02; done; exit 0`,
  })
  const control = await registeredPlanCommand(f.runtime)
  await runPlan(f)
  await f.runtime.tick()
  const [checked, ...siblings] = f.store.attempts(f.receipt.planID)
  expect(siblings).toHaveLength(2)
  f.completeWorker(checked!.session_id)
  await f.runtime.tick()
  await waitForPath(join(f.root, "uncertain-pid"))
  const pid = Number(readFileSync(join(f.root, "uncertain-pid"), "utf8"))
  const originalKill = process.kill.bind(process)
  const kill = spyOn(process, "kill").mockImplementation(((target, signal) => {
    if (target === -pid) {
      if (signal === 0) return true
      if (signal === "SIGKILL") throw new Error("fixture cannot confirm settlement")
    }
    return originalKill(target, signal)
  }) as typeof process.kill)
  try {
    writeFileSync(join(f.root, "uncertain-release"), "go\n")
    const activity = verificationActivitiesForDatabase(f.repository.path).find(
      (entry) => entry.metadata.attemptID === checked!.id,
    )!
    await activity.settled
    expect(activity.result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      processCleanup: { state: "uncertain" },
    })
    const interrupted: string[] = []
    const interrupt = f.host.interrupt
    f.host.interrupt = async (sessionID) => {
      interrupted.push(sessionID)
      await interrupt(sessionID)
    }
    expect(siblings.every((attempt) => f.sessions.get(attempt.session_id)?.busy)).toBe(true)
    await control.execute({
      requestID: "cancel-uncertain-check-and-siblings",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    })
    await f.runtime.tick()
    expect(interrupted.toSorted()).toEqual(siblings.map((attempt) => attempt.session_id).toSorted())
    expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
    expect(f.store.plan(f.receipt.planID)?.reason).toContain("settlement is uncertain")
    await f.runtime.tick()
    expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
    expect(
      f.store
        .attempts(f.receipt.planID)
        .filter((attempt) => siblings.some((sibling) => sibling.id === attempt.id))
        .every((attempt) => attempt.state === "cancelled"),
    ).toBe(true)
    expect(
      f.store.attempts(f.receipt.planID).find((attempt) => attempt.id === checked!.id)?.state,
    ).toBe("verifying")
    expect(siblings.every((attempt) => existsSync(attempt.workspace))).toBe(true)
    const effect = f.store
      .effects(f.receipt.planID)
      .find((entry) => entry.kind === "verify:content")!
    expect(effect.state).toBe("uncertain")
    expect(JSON.parse(effect.receipt!).result.check).toMatchObject({ exitCode: 0, timedOut: false })
    expect(f.notifications.some((notice) => notice.text.includes('"status":"cancelled"'))).toBe(
      false,
    )
  } finally {
    kill.mockRestore()
    try {
      originalKill(-pid, "SIGKILL")
    } catch {
      // The descendant may already have exited while assertions ran.
    }
  }
})

test("independent isolated Git branches overlap and combined verification includes every artifact", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()

  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  expect(new Set(attempts.map((attempt) => attempt.workspace)).size).toBe(2)
  expect(attempts.every((attempt) => attempt.base_commit === f.base)).toBe(true)
  expect(attempts.every((attempt) => f.sessions.get(attempt.session_id)?.busy)).toBe(true)
  const starts = f.events
    .map((event, index) => ({ event, index }))
    .filter((entry) => entry.event.startsWith("start:"))
  expect(starts).toHaveLength(2)
  const activity = f.store.detail(f.receipt.planID).activity as {
    id: number
    event: string
    payload: string
  }[]
  const dispatchRecords = activity.filter((entry) => entry.event === "WORKER_STARTED")
  expect(dispatchRecords).toHaveLength(2)
  for (const record of dispatchRecords) {
    const identity = JSON.parse(record.payload)
    expect(
      attempts.some(
        (attempt) =>
          attempt.id === identity.attemptID &&
          attempt.session_id === identity.sessionID &&
          attempt.workspace === identity.workspace,
      ),
    ).toBe(true)
  }

  f.completeWorker(attempts[0]!.session_id)
  await settleVerification(f.runtime)
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual(["accepted", "running"])
  const currentActivity = f.store.detail(f.receipt.planID).activity as {
    id: number
    event: string
    payload: string
  }[]
  const lifetimes = currentActivity.filter((entry) =>
    ["WORKER_STARTED", "WORKER_STOPPED"].includes(entry.event),
  )
  const startsBeforeStop = lifetimes.filter((entry) => entry.event === "WORKER_STARTED")
  const firstStop = lifetimes.find((entry) => entry.event === "WORKER_STOPPED")!
  expect(Math.max(...startsBeforeStop.map((entry) => entry.id))).toBeLessThan(firstStop.id)
  f.completeWorker(attempts[1]!.session_id)
  await drive(f.runtime)

  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.state).toBe("accepted")
  expect(git(f.root, ["show", `${plan.artifact}:a.txt`])).toBe("a")
  expect(git(f.root, ["show", `${plan.artifact}:b.txt`])).toBe("b")
  expect(
    await combineArtifacts(
      f.root,
      f.base,
      f.store.nodes(plan.id).map((node) => node.artifact!),
    ),
  ).toBe(plan.artifact!)
  const graphWorkspace = f.store.effects(plan.id).find((effect) => effect.kind === "graph-worktree")
  expect(graphWorkspace?.state).toBe("completed")
  const combinedCheck = f.store
    .effects(plan.id)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(combinedCheck.receipt!).check.artifact).toBe(plan.artifact)
  expect(JSON.parse(combinedCheck.receipt!).check.exitCode).toBe(0)
})

test("dependencies wait for accepted inputs and wildcard ancestor scopes serialize", async () => {
  const dependent = fixture({ delayed: true })
  await runPlan(dependent)
  await dependent.runtime.tick()
  expect(dependent.store.attempts(dependent.receipt.planID)).toHaveLength(1)
  expect(dependent.store.execution(dependent.tasks[1]!.id)?.waitingOn).toEqual([
    dependent.tasks[0]!.id,
  ])
  const predecessor = dependent.store.attempts(dependent.receipt.planID)[0]!
  dependent.completeWorker(predecessor.session_id)
  await settleVerification(dependent.runtime)
  expect(dependent.store.attempts(dependent.receipt.planID)).toHaveLength(2)
  const successor = dependent.store.attempts(dependent.receipt.planID)[1]!
  expect(successor.base_commit).toBe(
    dependent.store.attempts(dependent.receipt.planID)[0]!.artifact!,
  )
  expect(dependent.events.indexOf(`stop:${predecessor.session_id}`)).toBeLessThan(
    dependent.events.indexOf(`start:${successor.session_id}`),
  )
  dependent.completeWorker(successor.session_id)
  await drive(dependent.runtime)
  expect(dependent.store.plan(dependent.receipt.planID)!.state).toBe("accepted")

  const scopes = fixture({
    independent: true,
    delayed: true,
    allowScopeOverlap: true,
    taskFiles: [
      { name: "a", path: "src/a.txt", scope: ["src/**"] },
      { name: "b", path: "src/b/b.txt", scope: ["src/b/**"] },
    ],
  })
  await runPlan(scopes)
  await scopes.runtime.tick()
  expect(scopes.store.attempts(scopes.receipt.planID)).toHaveLength(1)
  const first = scopes.store.attempts(scopes.receipt.planID)[0]!
  scopes.completeWorker(first.session_id)
  await settleVerification(scopes.runtime)
  await scopes.runtime.tick()
  const second = scopes.store.attempts(scopes.receipt.planID)[1]!
  expect(second.base_commit).toBe(scopes.base)
  expect(scopes.events.indexOf(`stop:${first.session_id}`)).toBeLessThan(
    scopes.events.indexOf(`start:${second.session_id}`),
  )
  scopes.completeWorker(second.session_id)
  await drive(scopes.runtime)
  expect(scopes.store.plan(scopes.receipt.planID)!.state).toBe("accepted")
})

test("independent plans overlap while a second reconciler cannot duplicate dispatch", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: [{ name: "a", path: "src/a.txt", scope: ["src/**"] }],
  })
  const taskB = f.createTask("b", "src/b/b.txt", ["src/b/**"])
  const planBInput = {
    ...f.inputFor([taskB], { requestID: "plan-b" }),
    dispositions: [
      {
        taskID: taskB.id,
        otherTaskID: f.tasks[0]!.id,
        relation: "supplements" as const,
        rationale: "Serialize overlapping source scopes across plans.",
      },
    ],
  }
  const planB = f.store.submit(planBInput, "owner")
  const taskC = f.createTask("c", "other/c.txt")
  const planC = f.store.submit(f.inputFor([taskC], { requestID: "plan-c" }), "owner")
  await runPlan(f, f.receipt.planID, "run-a")
  await runPlan(f, planB.planID, "run-b")
  await runPlan(f, planC.planID, "run-c")

  const secondReconciler = new TaskRuntime(f.store, f.host, "project")
  try {
    await Promise.all([f.runtime.tick(), secondReconciler.tick()])
    const attemptsA = f.store.attempts(f.receipt.planID)
    const attemptsB = f.store.attempts(planB.planID)
    const attemptsC = f.store.attempts(planC.planID)
    expect(attemptsA).toHaveLength(1)
    expect(attemptsB).toHaveLength(0)
    expect(attemptsC).toHaveLength(1)
    expect(attemptsA[0]!.workspace).not.toBe(attemptsC[0]!.workspace)
    expect(f.sessions.get(attemptsA[0]!.session_id)?.busy).toBe(true)
    expect(f.sessions.get(attemptsC[0]!.session_id)?.busy).toBe(true)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
    secondReconciler.stop()

    f.completeWorker(attemptsA[0]!.session_id)
    await settleVerification(f.runtime)
    const attemptsBAfterA = f.store.attempts(planB.planID)
    expect(attemptsBAfterA).toHaveLength(1)
    expect(f.sessions.get(attemptsBAfterA[0]!.session_id)?.busy).toBe(true)
    expect(f.events.indexOf(`stop:${attemptsA[0]!.session_id}`)).toBeLessThan(
      f.events.indexOf(`start:${attemptsBAfterA[0]!.session_id}`),
    )

    f.completeWorker(attemptsBAfterA[0]!.session_id)
    f.completeWorker(attemptsC[0]!.session_id)
    await drive(f.runtime)
    expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
    expect(f.store.plan(planB.planID)!.state).toBe("accepted")
    expect(f.store.plan(planC.planID)!.state).toBe("accepted")
  } finally {
    secondReconciler.stop()
  }
})

test("single-task acceptance coalesces its task handoff while another plan worker stays active", async () => {
  const f = fixture({ independent: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const b = f.createTask("b", "other/b.txt")
  const planB = f.store.submit(f.inputFor([b], { requestID: "other-plan" }), "owner")
  const notifications: Parameters<RunnerHost["notify"]>[0][] = []
  const notify = f.host.notify
  f.host.notify = async (input) => {
    notifications.push(input)
    await notify(input)
  }
  f.sessions.get("owner")!.busy = true
  await runPlan(f)
  await runPlan(f, planB.planID, "run-other")
  await f.runtime.tick()
  const a = f.store.attempts(f.receipt.planID)[0]!
  const other = f.store.attempts(planB.planID)[0]!
  f.completeWorker(a.session_id)
  await settleVerification(f.runtime)
  expect(f.sessions.get(other.session_id)?.busy).toBe(true)
  expect(f.store.plan(planB.planID)?.state).toBe("running")
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  const combined = notifications.find((input) => input.text.includes('"status":"accepted"'))!
  expect(combined.resume).toBe(true)
  expect(combined.text).toContain("Review and merge")
  expect(notifications.some((input) => input.text.includes('"status":"task-accepted"'))).toBe(false)
  const delivery = f.store.detail(f.receipt.planID).delivery as {
    payload: string
    state: string
    metadata: string
  }[]
  expect(delivery).toHaveLength(2)
  expect(delivery.find((row) => JSON.parse(row.payload).status === "task-accepted")?.state).toBe(
    "superseded",
  )
  expect(delivery.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe(
    "admitted",
  )
  expect(
    f.inbox
      .get("owner")
      ?.filter(
        (entry) =>
          entry.metadata &&
          "lazersPlanID" in entry.metadata &&
          entry.metadata.lazersPlanID === f.receipt.planID,
      ),
  ).toHaveLength(1)
  const ids = notifications.map((input) => input.id)
  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  await reopened.tick()
  expect(notifications.map((input) => input.id)).toEqual(ids)
  f.completeWorker(other.session_id)
  await drive(reopened)
})

test("a late older retry cannot replace a newer queued plan outcome", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const notifications: Parameters<RunnerHost["notify"]>[0][] = []
  const notify = f.host.notify
  f.host.notify = async (input) => {
    notifications.push(input)
    await notify(input)
  }
  f.sessions.get("owner")!.busy = true
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id)
  await settleVerification(f.runtime)

  const plan = f.store.plan(f.receipt.planID)!
  const current = f.store
    .outboxForDelivery()
    .find((row) => row.plan_id === plan.id && JSON.parse(row.payload).status === "accepted")!
  const oldVersion = current.version - 1
  const oldPayload = {
    planID: plan.id,
    planRevision: plan.revision,
    version: oldVersion,
    status: "task-accepted",
    taskID: f.tasks[0]!.id,
  }
  const metadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: "project",
    lazersProjectDirectory: f.repository.projectDirectory,
    lazersPlanID: plan.id,
    lazersOutboxID: "late-old-outbox",
    lazersMessageID: "msg_late_old_outcome",
    lazersSessionID: plan.owner,
    lazersStatus: "task-accepted",
    lazersVersion: oldVersion,
  }
  f.store.atomic((db) =>
    db
      .query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',1,?,NULL)",
      )
      .run(
        "late-old-outbox",
        plan.id,
        plan.owner,
        "msg_late_old_outcome",
        JSON.stringify(oldPayload),
        JSON.stringify(metadata),
      ),
  )

  await f.runtime.tick()

  const rows = f.store.detail(plan.id).delivery as {
    id: string
    payload: string
    state: string
  }[]
  expect(rows.find((row) => row.id === "late-old-outbox")?.state).toBe("superseded")
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("admitted")
  expect(notifications.some((notice) => notice.id === "msg_late_old_outcome")).toBe(false)
  expect(
    f.inbox
      .get(plan.owner)
      ?.filter((entry) => entry.metadata?.lazersPlanID === plan.id)
      .map((entry) => entry.metadata?.lazersStatus),
  ).toEqual(["accepted"])
})

test("an actionable partial-task outcome wakes review while its sibling worker remains active", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  f.sessions.get("owner")!.busy = true
  f.completeWorker(attempts[0]!.session_id)
  await settleVerification(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("running")
  expect(f.sessions.get(attempts[1]!.session_id)?.busy).toBe(true)
  const partial = f.inbox
    .get("owner")
    ?.filter(
      (entry) =>
        entry.metadata &&
        "lazersPlanID" in entry.metadata &&
        entry.metadata.lazersPlanID === f.receipt.planID,
    )
  expect(partial).toHaveLength(1)
  expect(partial?.[0]?.metadata?.lazersStatus).toBe("task-accepted")
  expect(f.events.some((event) => event === `notify:${partial?.[0]?.id}`)).toBe(true)
})

test("a newer partial result carries all prior reviewable artifacts while a third worker remains active", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: ["a", "b", "c"].map((name) => ({ name, path: `${name}.txt` })),
  })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  const notify = f.host.notify
  let lost = true
  f.host.notify = async (input) => {
    await notify(input)
    if (lost) throw new Error("Lost first partial admission response")
  }
  f.completeWorker(attempts[0]!.session_id)
  await settleVerification(f.runtime)
  expect(f.store.outboxForDelivery()[0]!.state).toBe("uncertain")
  lost = false
  f.completeWorker(attempts[1]!.session_id)
  await settleVerification(f.runtime)
  const rows = f.store.detail(f.receipt.planID).delivery as { state: string; payload: string }[]
  expect(rows[0]!.state).toBe("superseded")
  expect(rows[1]!.state).toBe("admitted")
  const payload = JSON.parse(rows[1]!.payload)
  expect(payload.status).toBe("task-accepted")
  expect(payload.currentPlan.state).toBe("running")
  expect(payload.reviewableTasks.map((task: { taskID: string }) => task.taskID)).toEqual(
    f.tasks.slice(0, 2).map((task) => task.id),
  )
  expect(
    payload.reviewableTasks.every(
      (task: { artifact: string; attemptID: string }) => task.artifact && task.attemptID,
    ),
  ).toBe(true)
  expect(f.sessions.get(attempts[2]!.session_id)!.busy).toBe(true)
  expect(f.inbox.get("owner")).toHaveLength(1)
})

test("legacy partial notices for distinct tasks cannot silently replace one another", async () => {
  const f = fixture()
  for (const [index, task] of f.tasks.entries()) {
    const payload = {
      planID: f.receipt.planID,
      version: index + 1,
      status: "task-accepted",
      taskID: task.id,
      artifact: `artifact-${index}`,
    }
    f.store.atomic((db) =>
      db
        .query(
          "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,?,?,?,'pending',1)",
        )
        .run(
          `partial-${index}`,
          f.receipt.planID,
          "owner",
          `msg_partial_${index}`,
          JSON.stringify(payload),
        ),
    )
  }
  await f.runtime.tick()
  expect(
    (f.store.detail(f.receipt.planID).delivery as { state: string }[]).map((row) => row.state),
  ).toEqual(["admitted", "admitted"])
  expect(f.inbox.get("owner")).toHaveLength(2)
})

test("failed cancellation keeps the newer outcome pending and retries after the queue race clears", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  f.sessions.get("owner")!.busy = true
  f.completeWorker(attempts[0]!.session_id)
  await settleVerification(f.runtime)
  const prior = f.inbox
    .get("owner")!
    .find((entry) => entry.metadata?.lazersPlanID === f.receipt.planID)!
  const cancel = f.host.cancelOutcome!
  let fail = true
  f.host.cancelOutcome = async (input) => {
    if (fail) throw new Error("native lifecycle conflict")
    await cancel(input)
  }

  f.completeWorker(attempts[1]!.session_id)
  await settleVerification(f.runtime)
  let rows = f.store.detail(f.receipt.planID).delivery as {
    payload: string
    state: string
    receipt: string | null
  }[]
  expect(rows.find((row) => JSON.parse(row.payload).status === "task-accepted")?.state).toBe(
    "admitted",
  )
  const current = rows.find((row) => JSON.parse(row.payload).status === "accepted")!
  expect(current.state).toBe("pending")
  expect(
    JSON.parse(rows.find((row) => JSON.parse(row.payload).status === "task-accepted")!.receipt!)
      .history,
  ).toContainEqual(expect.objectContaining({ kind: "cancellation-failed-still-queued" }))
  expect(f.inbox.get("owner")?.some((entry) => entry.id === prior.id)).toBe(true)

  fail = false
  await f.runtime.tick()
  rows = f.store.detail(f.receipt.planID).delivery as typeof rows
  expect(rows.find((row) => JSON.parse(row.payload).status === "task-accepted")?.state).toBe(
    "superseded",
  )
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("admitted")
  expect(
    f.inbox.get("owner")?.filter((entry) => entry.metadata?.lazersPlanID === f.receipt.planID),
  ).toHaveLength(1)
})

test("an unavailable native inbox cannot be reported as successful supersession", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  f.sessions.get("owner")!.busy = true
  f.completeWorker(attempts[0]!.session_id)
  await settleVerification(f.runtime)
  const listInbox = f.host.outcomeInbox
  f.host.outcomeInbox = async () => {
    throw new Error("native host unavailable")
  }

  f.completeWorker(attempts[1]!.session_id)
  await settleVerification(f.runtime)
  let rows = f.store.detail(f.receipt.planID).delivery as {
    payload: string
    state: string
    receipt: string | null
  }[]
  const older = rows.find((row) => JSON.parse(row.payload).status === "task-accepted")!
  expect(older.state).toBe("admitted")
  expect(JSON.parse(older.receipt!).history).toContainEqual(
    expect.objectContaining({ kind: "supersession-observation-unavailable" }),
  )
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("pending")
  expect(
    f.inbox.get("owner")?.filter((entry) => entry.metadata?.lazersPlanID === f.receipt.planID),
  ).toHaveLength(1)

  f.host.outcomeInbox = listInbox
  await f.runtime.tick()
  rows = f.store.detail(f.receipt.planID).delivery as typeof rows
  expect(rows.find((row) => JSON.parse(row.payload).status === "task-accepted")?.state).toBe(
    "superseded",
  )
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("admitted")
})

test("a cancellation that races with transcript consumption is recorded as consumed, not suppressed", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  f.sessions.get("owner")!.busy = true
  f.completeWorker(attempts[0]!.session_id)
  await settleVerification(f.runtime)
  const cancel = f.host.cancelOutcome
  f.host.cancelOutcome = async (input) => {
    const entries = f.inbox.get(input.sessionID) ?? []
    const index = entries.findIndex((entry) => entry.id === input.inboxID)
    if (index >= 0) entries.splice(index, 1)
    f.sessions.get(input.sessionID)!.messages.push({
      id: input.inboxID,
      text: "Consumed native outcome",
      type: "synthetic",
      metadata: input.ownership,
    })
    throw new Error("cancel lost a race with consumption")
  }
  f.completeWorker(attempts[1]!.session_id)
  await settleVerification(f.runtime)
  const rows = f.store.detail(f.receipt.planID).delivery as {
    payload: string
    state: string
    receipt: string | null
  }[]
  const partial = rows.find((row) => JSON.parse(row.payload).status === "task-accepted")!
  expect(partial.state).toBe("consumed")
  expect(JSON.parse(partial.receipt!).history).toContainEqual(
    expect.objectContaining({ kind: "cancel-raced-with-consumption" }),
  )
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("admitted")
  expect(
    f.inbox.get("owner")?.filter((entry) => entry.metadata?.lazersPlanID === f.receipt.planID),
  ).toHaveLength(1)
  f.host.cancelOutcome = cancel
})

test("a successful native cancel response is rechecked before recording supersession", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  f.sessions.get("owner")!.busy = true
  f.completeWorker(attempts[0]!.session_id)
  await settleVerification(f.runtime)
  f.host.cancelOutcome = async (input) => {
    const entries = f.inbox.get(input.sessionID) ?? []
    const index = entries.findIndex((entry) => entry.id === input.inboxID)
    if (index >= 0) entries.splice(index, 1)
    f.sessions.get(input.sessionID)!.messages.push({
      id: input.inboxID,
      text: "Consumed while cancellation completed",
      type: "synthetic",
      metadata: input.ownership,
    })
  }

  f.completeWorker(attempts[1]!.session_id)
  await settleVerification(f.runtime)
  const rows = f.store.detail(f.receipt.planID).delivery as {
    payload: string
    state: string
    receipt: string | null
  }[]
  const partial = rows.find((row) => JSON.parse(row.payload).status === "task-accepted")!
  expect(partial.state).toBe("consumed")
  expect(JSON.parse(partial.receipt!).history).toContainEqual(
    expect.objectContaining({ kind: "consumption-observed-after-cancel" }),
  )
  expect(rows.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe("admitted")
  expect(
    f.inbox.get("owner")?.filter((entry) => entry.metadata?.lazersPlanID === f.receipt.planID),
  ).toHaveLength(1)
})

test("completed shared plan verifies its exact artifact without touching an advanced shared checkout", async () => {
  const f = fixture({ shared: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const move = f.store.move.bind(f.store)
  let advanced = ""
  f.store.move = (planID, taskID, event, reason) => {
    const result = move(planID, taskID, event, reason)
    if (event === "ACCEPT") {
      writeFileSync(join(f.root, "reviewed-later.txt"), "keep\n")
      git(f.root, ["add", "reviewed-later.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Later reviewed work",
      ])
      advanced = git(f.root, ["rev-parse", "HEAD"])
    }
    return result
  }
  await runPlan(f)
  await drive(f.runtime)
  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.state).toBe("accepted")
  expect(plan.artifact).not.toBe(advanced)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(advanced)
  expect(readFileSync(join(f.root, "reviewed-later.txt"), "utf8")).toBe("keep\n")
  const effect = f.store.effects(plan.id).find((entry) => entry.kind === "graph-worktree")!
  expect(effect.state).toBe("completed")
  const workspace = JSON.parse(effect.receipt!).workspace
  expect(workspace).not.toBe(f.root)
  expect(git(workspace, ["rev-parse", "HEAD"])).toBe(plan.artifact!)
  const check = f.store.effects(plan.id).find((entry) => entry.kind === "graph-verify:combined")!
  expect(JSON.parse(check.receipt!).check).toMatchObject({
    cwd: workspace,
    artifact: plan.artifact,
    exitCode: 0,
  })
})

test("shared resume waits for another plan's worker and cancellation retains final usage", async () => {
  const f = fixture({ shared: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const a = f.store.attempts(f.receipt.planID)[0]!
  Object.assign(f.sessions.get(a.session_id)!, { tokens: 777, tools: 45, cost: 3 })
  await f.runtime.command(
    {
      requestID: "cancel-a",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
    token_count: 777,
    tool_count: 45,
    cost: 3,
  })
  const b = f.createTask("b", "b.txt")
  const planB = f.store.submit(f.inputFor([b], { requestID: "shared-b" }), "owner")
  await runPlan(f, planB.planID, "run-b")
  await f.runtime.tick()
  const other = f.store.attempts(planB.planID)[0]!
  expect(f.sessions.get(other.session_id)?.busy).toBe(true)
  await f.runtime.command(
    {
      requestID: "resume-a",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "resume",
      taskID: a.task_id,
      workspaceMode: "shared",
      reason: "Continue retained shared work",
    },
    "owner",
  )
  const prompts = f.events.filter((event) => event.startsWith("prompt:")).length
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(prompts)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("preparing")
  f.completeWorker(other.session_id)
  await settleVerification(f.runtime)
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(prompts + 1)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  f.completeWorker(a.session_id)
  await drive(f.runtime)
})

test("reconciliation retains legacy advanced-checkout receipts and verifies the exact artifact afresh", async () => {
  const f = fixture({ shared: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const move = f.store.move.bind(f.store)
  let legacyID = ""
  f.store.move = (planID, taskID, event, reason) => {
    const result = move(planID, taskID, event, reason)
    if (event === "ACCEPT") {
      const artifact = f.store.attempts(planID)[0]!.artifact!
      writeFileSync(join(f.root, "later.txt"), "preserve\n")
      git(f.root, ["add", "later.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Later reviewed work",
      ])
      const check = f.input.verification[0]!
      legacyID = crypto.randomUUID()
      f.store.atomic((db) => {
        db.query("INSERT INTO runner_effects VALUES(?,?,NULL,NULL,?,'completed',?,?,1)").run(
          legacyID,
          planID,
          `graph-verify:${check.id}`,
          JSON.stringify({
            workspace: f.root,
            artifact,
            identity: artifact,
            check,
            receiptPath: "legacy-receipt.json",
          }),
          JSON.stringify({
            check: {
              id: check.id,
              command: check.command,
              cwd: f.root,
              artifact,
              exitCode: 0,
              timedOut: false,
              unchanged: false,
            },
          }),
        )
        db.query(
          "UPDATE runner_plans SET state='blocked',reason='Combined artifact verification failed',version=version+1 WHERE id=?",
        ).run(planID)
      })
    }
    return result
  }
  await runPlan(f)
  await f.runtime.tick()
  await settleVerification(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  await f.runtime.command(
    {
      requestID: "reconcile-legacy",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  const effects = f.store
    .effects(f.receipt.planID)
    .filter((effect) => effect.kind === "graph-verify:combined")
  expect(effects).toHaveLength(2)
  expect(effects.find((effect) => effect.id === legacyID)?.state).toBe("completed")
  expect(
    JSON.parse(effects.find((effect) => effect.id === legacyID)!.receipt!).check.unchanged,
  ).toBe(false)
  const fresh = JSON.parse(effects.find((effect) => effect.id !== legacyID)!.receipt!).check
  expect(fresh).toMatchObject({
    artifact: f.store.plan(f.receipt.planID)!.artifact!,
    exitCode: 0,
  })
  expect(fresh.cwd).not.toBe(f.root)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(readFileSync(join(f.root, "later.txt"), "utf8")).toBe("preserve\n")
})

test("explicit reconcile retries conclusive combined checks after environment repair without erasing evidence", async () => {
  const f = fixture({
    shared: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    requireVerifierPreparation: true,
  })
  await runPlan(f)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  const checks = () =>
    f.store.effects(f.receipt.planID).filter((effect) => effect.kind === "graph-verify:combined")
  expect(checks()).toHaveLength(1)
  const failed = checks()[0]!
  expect(JSON.parse(failed.receipt!).check.exitCode).toBe(1)
  await drive(f.runtime)
  expect(checks()).toHaveLength(1)
  writeFileSync(join(dirname(f.repository.path), "verifier-ready"), "prepared\n")
  const command = {
    requestID: "reconcile-prepared-verifier",
    planID: f.receipt.planID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    action: "reconcile",
    reason: "Repair verifier prerequisites, not implementation",
  }
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(checks()).toHaveLength(2)
  expect(checks().find((effect) => effect.id === failed.id)?.receipt).toBe(failed.receipt)
  const fresh = checks().find((effect) => effect.id !== failed.id)!
  expect(JSON.parse(fresh.payload).verificationEpoch).toBeGreaterThan(0)
  expect(JSON.parse(fresh.receipt!).check).toMatchObject({ exitCode: 0 })
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test("uncertain prompt cannot prevent cancellation of an admitted sibling", async () => {
  const f = fixture({ independent: true, delayed: true })
  const detailedSessionIDs: string[] = []
  const session = f.host.session
  f.host.session = async (id, options) => {
    if (options?.messages) detailedSessionIDs.push(id)
    return session(id, options)
  }
  const prompt = f.host.prompt
  let release!: () => void
  const admitted = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.prompt = async (input) => {
    const attempt = f.store
      .attempts(f.receipt.planID)
      .find((entry) => entry.session_id === input.sessionID)!
    if (attempt.task_id === f.tasks[0]!.id) {
      await admitted
      throw new Error("Prompt admission response unknown")
    }
    await prompt(input)
    release()
  }
  await runPlan(f)
  await f.runtime.tick()
  const b = f.store.attempts(f.receipt.planID).find((entry) => entry.task_id === f.tasks[1]!.id)!
  expect(f.sessions.get(b.session_id)?.busy).toBe(true)
  await f.runtime.command(
    {
      requestID: "cancel-uncertain",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.events).toContain(`stop:${b.session_id}`)
  expect(f.sessions.get(b.session_id)?.busy).toBe(false)
  expect(f.store.attempts(f.receipt.planID).find((entry) => entry.id === b.id)?.state).toBe(
    "cancelled",
  )
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
  expect(
    f.store
      .effects(f.receipt.planID)
      .some((effect) => effect.kind === "prompt" && effect.state === "uncertain"),
  ).toBe(true)
  expect(detailedSessionIDs).toContain(b.session_id)
})

test("two conflicting shared resumes use current prompt identities and cannot deadlock", async () => {
  const f = fixture({ shared: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const a = f.store.attempts(f.receipt.planID)[0]!
  await f.runtime.command(
    {
      requestID: "cancel-old-a",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await drive(f.runtime, 2)
  const b = f.createTask("b", "b.txt")
  const planB = f.store.submit(f.inputFor([b], { requestID: "second-shared" }), "owner")
  await runPlan(f, planB.planID, "run-old-b")
  await f.runtime.tick()
  const other = f.store.attempts(planB.planID)[0]!
  await f.runtime.command(
    {
      requestID: "cancel-old-b",
      planID: planB.planID,
      expectedVersion: f.store.plan(planB.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await drive(f.runtime, 2)
  for (const [planID, taskID] of [
    [f.receipt.planID, a.task_id],
    [planB.planID, other.task_id],
  ])
    await f.runtime.command(
      {
        requestID: `resume-${taskID}`,
        planID,
        expectedVersion: f.store.plan(planID!)!.version,
        action: "resume",
        taskID,
        workspaceMode: "shared",
        reason: "Continue stopped work",
      },
      "owner",
    )
  const count = f.events.filter((event) => event.startsWith("prompt:")).length
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(count + 1)
  const active = [a.session_id, other.session_id].filter((id) => f.sessions.get(id)?.busy)
  expect(active).toHaveLength(1)
  f.completeWorker(active[0]!)
  await drive(f.runtime, 2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(count + 2)
  const remaining = [a.session_id, other.session_id].filter((id) => f.sessions.get(id)?.busy)
  expect(remaining).toHaveLength(1)
  f.completeWorker(remaining[0]!)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.plan(planB.planID)?.state).toBe("accepted")
})

test("combined worktree completion cannot overwrite a concurrent cancellation", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  for (const attempt of f.store.attempts(f.receipt.planID)) f.completeWorker(attempt.session_id)
  const create = f.host.worktree
  f.host.worktree = async (input) => {
    const actual = await create(input)
    await f.runtime.command(
      {
        requestID: "cancel-during-combine",
        planID: f.receipt.planID,
        expectedVersion: f.store.plan(f.receipt.planID)!.version,
        action: "cancel",
      },
      "owner",
    )
    expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
    return actual
  }
  await settleVerification(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.artifact).toBeNull()
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("graph-verify:")),
  ).toBe(false)
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
})

test("one failed branch blocks combined acceptance without losing sibling verification or usage", async () => {
  const f = fixture({ independent: true, delayed: true, fail: true })
  await runPlan(f)
  await f.runtime.tick()
  const [first, second] = f.store.attempts(f.receipt.planID)
  if (!first || !second) throw new Error("Expected two isolated workers")
  f.completeWorker(first.session_id)
  f.completeWorker(second.session_id)
  await settleVerification(f.runtime)

  expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual(["failed", "accepted"])
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.token_count)).toEqual([
    100, 100,
  ])
  expect(attemptCheck(f, first.task_id, first.id).exitCode).toBe(7)
  expect(attemptCheck(f, second.task_id, second.id).exitCode).toBe(0)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("graph-verify:")),
  ).toBe(false)
})

test("conflicting accepted branches hold integration and preserve both real Git artifacts", async () => {
  const f = fixture({
    independent: true,
    allowScopeOverlap: true,
    taskFiles: [
      { name: "a", path: "shared.txt", scope: ["shared.txt"] },
      { name: "b", path: "shared.txt", scope: ["shared.txt"] },
    ],
  })
  await runPlan(f)
  await drive(f.runtime)

  const plan = f.store.plan(f.receipt.planID)!
  const nodes = f.store.nodes(plan.id)
  expect(plan.state).toBe("blocked")
  expect(plan.reason).toContain("Conflicting accepted artifacts")
  expect(nodes.map((node) => node.state)).toEqual(["accepted", "accepted"])
  expect(nodes.every((node) => node.artifact)).toBe(true)
  expect(git(f.root, ["show", `${nodes[0]!.artifact}:shared.txt`])).toBe("a")
  expect(git(f.root, ["show", `${nodes[1]!.artifact}:shared.txt`])).toBe("b")
  expect(f.store.attempts(plan.id).every((attempt) => existsSync(attempt.workspace))).toBe(true)
  expect(
    f.store
      .effects(plan.id)
      .filter((effect) => effect.kind.startsWith("verify:"))
      .every((e) => e.state === "completed"),
  ).toBe(true)
  expect(f.store.effects(plan.id).some((effect) => effect.kind.startsWith("graph-verify:"))).toBe(
    false,
  )
})

test("lost worktree creation response resumes its own blocked startup after reconciliation", async () => {
  for (const response of [true, "empty-error"] as const) {
    const f = fixture({
      independent: true,
      delayed: true,
      loseWorktreeResponse: response,
    })
    await runPlan(f)
    await f.runtime.tick()
    const effect = f.store.effects(f.receipt.planID).find((item) => item.kind === "worktree")!
    expect(effect.state).toBe("uncertain")
    expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
    expect(f.store.plan(f.receipt.planID)!.reason).toContain(
      response === "empty-error" ? ": Error" : ": worktree response lost",
    )
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
    expect(f.store.attempts(f.receipt.planID).every((item) => item.state === "preparing")).toBe(
      true,
    )
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(0)

    f.runtime.stop()
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    const reopened = new TaskRuntime(f.store, f.host, "project")
    try {
      await reopened.tick()
      expect(f.store.effects(f.receipt.planID).find((item) => item.id === effect.id)?.state).toBe(
        "completed",
      )
      expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
      expect(f.store.attempts(f.receipt.planID).every((item) => item.state === "preparing")).toBe(
        true,
      )

      await reopened.tick()
      expect(f.store.attempts(f.receipt.planID).every((item) => item.state === "running")).toBe(
        true,
      )
      expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
      expect(await f.host.worktrees()).toHaveLength(3)
      expect(
        f.store.latestTransition<{ effectID: string }>(
          f.receipt.planID,
          null,
          "WORKTREE_RECOVERY_RESUMED",
        ),
      ).toMatchObject({ effectID: effect.id })
      for (const worker of f.store.attempts(f.receipt.planID)) f.completeWorker(worker.session_id)
      await drive(reopened)
      expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
    } finally {
      reopened.stop()
    }
  }
})

test("a different block reason keeps a reconciled worktree startup blocked", async () => {
  const f = fixture({
    delayed: true,
    loseWorktreeResponse: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const effect = f.store.effects(planID).find((item) => item.kind === "worktree")!
  f.store.atomic((db) =>
    db.query("UPDATE runner_plans SET reason=? WHERE id=?").run("Unrelated blocked reason", planID),
  )

  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  try {
    await reopened.tick()
    expect(f.store.effects(planID).find((item) => item.id === effect.id)?.state).toBe("completed")
    expect(f.store.plan(planID)).toMatchObject({
      state: "blocked",
      reason: "Unrelated blocked reason",
    })
    await reopened.tick()
    expect(f.store.attempts(planID).every((item) => item.state === "cancelled")).toBe(true)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(0)
  } finally {
    reopened.stop()
  }
})

test("cancelling overlapping workers waits for every native session and preserves usage", async () => {
  const f = fixture({ independent: true, delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  for (const attempt of attempts) f.sessions.get(attempt.session_id)!.tokens = 123
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.token_count)).toEqual([
    123, 123,
  ])

  await f.runtime.command(
    {
      requestID: "cancel-parallel",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cancelling")
  expect(f.store.attempts(f.receipt.planID).every((attempt) => attempt.state === "running")).toBe(
    true,
  )
  await f.runtime.tick()

  expect(f.store.plan(f.receipt.planID)!.state).toBe("cancelled")
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual([
    "cancelled",
    "cancelled",
  ])
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.state)).toEqual([
    "cancelled",
    "cancelled",
  ])
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.token_count)).toEqual([
    123, 123,
  ])
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("graph-verify:")),
  ).toBe(false)
})

test("reviewed combined merge removes only owned Git worktrees and preserves foreign work", async () => {
  const f = fixture({ independent: true, commit: true })
  const foreignPath = join(tmpdir(), `lazers-foreign-${crypto.randomUUID()}`)
  git(f.root, ["worktree", "add", "--detach", foreignPath, f.base])
  const foreign = realpathSync(foreignPath)
  try {
    await runPlan(f)
    await drive(f.runtime)
    const artifact = f.store.plan(f.receipt.planID)!.artifact!
    const acceptedInbox = f.inbox
      .get("owner")!
      .find(
        (entry) =>
          entry.metadata &&
          "lazersPlanID" in entry.metadata &&
          entry.metadata.lazersPlanID === f.receipt.planID,
      )!
    expect(acceptedInbox.metadata?.lazersStatus).toBe("accepted")
    f.inbox.get("owner")!.push(
      { id: "msg_user_keep", type: "user", delivery: "queue" },
      {
        id: "msg_worker_keep",
        type: "synthetic",
        delivery: "queue",
        metadata: { lazersKind: "worker-prompt", lazersMessageID: "msg_worker_keep" },
      },
      {
        id: "msg_foreign_keep",
        type: "synthetic",
        delivery: "queue",
        metadata: {
          ...acceptedInbox.metadata,
          lazersPlanID: "foreign-plan",
          lazersOutboxID: "foreign-outbox",
          lazersMessageID: "msg_foreign_keep",
        },
      },
    )
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind === "graph-worktree"),
    ).toBe(true)
    git(f.root, ["merge", "--ff-only", artifact])
    await f.runtime.command(
      {
        requestID: "integrate-parallel",
        planID: f.receipt.planID,
        expectedVersion: f.store.plan(f.receipt.planID)!.version,
        action: "integrated",
        artifact,
        targetBranch: "main",
        reason: "Reviewed every branch and the combined checks",
      },
      "owner",
    )
    await f.runtime.tick()

    expect(f.store.plan(f.receipt.planID)!.state).toBe("integrated")
    const outbox = f.store.detail(f.receipt.planID).delivery as {
      payload: string
      state: string
      message_id: string
    }[]
    expect(outbox.find((row) => JSON.parse(row.payload).status === "accepted")?.state).toBe(
      "superseded",
    )
    expect(outbox.find((row) => JSON.parse(row.payload).status === "integrated")?.state).toBe(
      "admitted",
    )
    expect(f.inbox.get("owner")?.map((entry) => entry.id)).toEqual([
      "msg_user_keep",
      "msg_worker_keep",
      "msg_foreign_keep",
      outbox.find((row) => JSON.parse(row.payload).status === "integrated")!.message_id,
    ])
    const removals = f.store
      .effects(f.receipt.planID)
      .filter((effect) => effect.kind === "worktree-remove")
    expect(removals).toHaveLength(3)
    expect(removals.every((effect) => JSON.parse(effect.receipt!).native === true)).toBe(true)
    expect(await f.host.worktrees()).toEqual([f.root, foreign])
  } finally {
    if (existsSync(foreign)) git(f.root, ["worktree", "remove", foreign])
  }
})

test("repairing one parallel branch retains its failed check and usage while its sibling is accepted", async () => {
  const f = fixture({ independent: true, delayed: true, wrongFirstA: true, repair: true })
  await runPlan(f)
  await f.runtime.tick()
  const initial = f.store.attempts(f.receipt.planID)
  f.completeWorker(initial[0]!.session_id)
  f.completeWorker(initial[1]!.session_id)
  await settleVerification(f.runtime)
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual(["running", "accepted"])
  expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
  expect(attemptCheck(f, initial[0]!.task_id, initial[0]!.id).exitCode).not.toBe(0)

  await f.runtime.tick()
  const repaired = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === initial[0]!.task_id)
    .at(-1)!
  expect(
    f.store.attempts(f.receipt.planID).filter((attempt) => attempt.task_id === repaired.task_id),
  ).toHaveLength(2)
  f.completeWorker(repaired.session_id)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  const attempts = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === repaired.task_id)
  expect(attempts[0]!.token_count).toBe(100)
  expect(attemptCheck(f, attempts[0]!.task_id, attempts[0]!.id).exitCode).not.toBe(0)
  expect(attemptCheck(f, attempts[1]!.task_id, attempts[1]!.id).exitCode).toBe(0)
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual([
    "accepted",
    "accepted",
  ])
})

test("missing and permission-denied skill suggestions never block admission or dispatch", async () => {
  for (const skillSuggestions of [
    [],
    ["missing-skill — Optional but not installed"],
    ["denied-skill — Optional and may not be permitted"],
  ]) {
    const f = fixture({ skillSuggestions })
    await f.runtime.command(
      { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
      "owner",
    )
    await drive(f.runtime)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
    for (const attempt of f.store.attempts(f.receipt.planID)) {
      expectNoSkillBody(attempt.policy)
      expect(
        JSON.parse(JSON.parse(attempt.policy).context).specification.requirements.skills,
      ).toEqual(skillSuggestions)
    }
  }
})

test("repair handoffs do not copy legacy skill bodies into a new attempt", async () => {
  const f = fixture({ fail: true, repair: true, skillSuggestions: ["sqlite — Optional helper"] })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  const first = f.store.attempts(f.receipt.planID)[0]!
  seedLegacySkillBody(f, first)
  await settleVerification(f.runtime)
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("running")
  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]!.policy).toContain(skillBodyCanary)
  expectNoSkillBody(attempts[1]!.policy)
})

test("verification failure and scope violations cannot unblock a successor", async () => {
  for (const options of [{ fail: true }, { outside: true }, { human: true }]) {
    const f = fixture(options)
    await f.runtime.command(
      { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
      "owner",
    )
    await drive(f.runtime, 5)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
    expect(f.store.nodes(f.receipt.planID)[1]!.state).toBe("queued")
    expect(f.events.filter((e) => e.startsWith("create:"))).toHaveLength(1)
    expect(f.store.repository.get(f.tasks[0]!.id)!.status).toBe("submitted")
  }
})

test("an unchanged evidence wait keeps its version and notification stable until evidence arrives", async () => {
  const f = fixture({ human: true, commit: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 5)
  const blocked = f.store.plan(planID)!
  expect(blocked.state).toBe("blocked")
  const counts = () =>
    f.store.atomic((db) => ({
      blocked: db
        .query("SELECT COUNT(*) AS n FROM runner_transitions WHERE plan_id=? AND event='BLOCKED'")
        .get(planID),
      outcomes: db.query("SELECT COUNT(*) AS n FROM runner_outbox WHERE plan_id=?").get(planID),
    }))
  const before = counts()
  await drive(f.runtime, 4)
  expect(f.store.plan(planID)!.version).toBe(blocked.version)
  expect(counts()).toEqual(before)

  await f.runtime.command(
    {
      requestID: "observed",
      planID,
      expectedVersion: blocked.version,
      action: "human-evidence",
      taskID: f.tasks[0]!.id,
      assertionID: "correct",
      artifact: f.store.nodes(planID)[0]!.artifact!,
      reason: "Observed the fixture acceptance condition.",
    },
    "owner",
  )
  await drive(f.runtime, 4)
  expect(f.store.nodes(planID)[0]!.state).toBe("accepted")
  await f.runtime.command(
    {
      requestID: "continue-observed",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 4)
  expect(f.store.plan(planID)!.state).toBe("accepted")
})

test("a resumed worker verifies its new commit without reusing older receipts or spending a repair", async () => {
  const f = fixture({
    human: true,
    commit: true,
    repair: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, expectedVersion: 1, action: "run" }, "owner")
  await drive(f.runtime, 5)
  const original = f.store.attempts(planID)[0]!
  const originalCheck = f.store.effects(planID).find((effect) => effect.kind === "verify:content")!
  const originalReceipt = originalCheck.receipt
  expect(f.store.plan(planID)?.reason).toContain("correct:human")

  await f.runtime.command(
    {
      requestID: "cancel",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.command(
    {
      requestID: "resume-review-repair",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "resume",
      taskID: original.task_id,
      reason: "Continue the existing worker after review",
    },
    "owner",
  )
  await f.runtime.tick()
  // Same attempt, different valid source commit after the resumed worker finishes.
  writeFileSync(join(original.workspace, "a.txt"), "a\n")
  git(original.workspace, ["add", "a.txt"])
  git(original.workspace, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Repair after review",
  ])
  const repaired = git(original.workspace, ["rev-parse", "HEAD"])
  expect(repaired).not.toBe(original.artifact!)
  await drive(f.runtime, 5)

  expect(f.store.attempts(planID).map((attempt) => attempt.id)).toEqual([original.id])
  expect(f.store.plan(planID)?.reason).toContain("correct:human")
  expect(f.store.nodes(planID)[0]).toMatchObject({ state: "verifying", artifact: repaired })
  const checks = f.store.effects(planID).filter((effect) => effect.kind === "verify:content")
  expect(checks).toHaveLength(2)
  expect(checks.find((effect) => effect.id === originalCheck.id)?.receipt).toBe(originalReceipt)
  expect(new Set(checks.map((effect) => JSON.parse(effect.payload).receiptPath)).size).toBe(2)
  for (const effect of checks) {
    const payload = JSON.parse(effect.payload)
    expect(JSON.parse(effect.receipt!).check).toMatchObject({
      artifact: payload.artifact,
      exitCode: 0,
    })
    expect(existsSync(payload.receiptPath)).toBe(true)
  }
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
})

test("plan evidence binds to the accepted combination and remains separate from task evidence", async () => {
  const f = fixture({ commit: true, startOnly: true })
  const plan = f.store.submit(
    {
      ...f.input,
      acceptance: [
        ...f.input.acceptance,
        {
          id: "native",
          assertion: "Observed the combined behavior",
          evidence: [{ kind: "human", decision: "Observe the app" }],
        },
      ],
    },
    "owner",
  )
  const evidence = {
    requestID: "graph-observed",
    planID: plan.planID,
    expectedVersion: 1,
    action: "human-evidence" as const,
    assertionID: "native",
    artifact: f.base,
    reason: "Observed the combined acceptance condition.",
  }
  await expect(f.runtime.command(evidence, "owner")).rejects.toThrow("all accepted task artifacts")
  await f.runtime.command(
    { requestID: "run", planID: plan.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime, 10)
  expect(f.store.plan(plan.planID)!.reason).toContain("native:human")
  expect(f.store.nodes(plan.planID).every((node) => node.state === "accepted")).toBe(true)
  const artifact = await combineArtifacts(
    f.root,
    f.base,
    f.input.integrationOrder.map(
      (id) => f.store.nodes(plan.planID).find((node) => node.task_id === id)!.artifact!,
    ),
  )
  const current = { ...evidence, expectedVersion: f.store.plan(plan.planID)!.version, artifact }
  await expect(
    f.runtime.command({ ...current, requestID: "wrong-artifact", artifact: f.base }, "owner"),
  ).rejects.toThrow("current assertion/artifact")
  await expect(
    f.runtime.command({ ...current, requestID: "wrong-scope", taskID: f.tasks[0]!.id }, "owner"),
  ).rejects.toThrow("current assertion/artifact")
  const receipt = await f.runtime.command(current, "owner")
  expect(f.store.plan(plan.planID)!.state).toBe("blocked")
  const recorded = () =>
    f.store.atomic((db) =>
      db
        .query(
          "SELECT task_id,artifact FROM runner_evidence WHERE plan_id=? AND assertion_id='native' AND kind='human'",
        )
        .all(plan.planID),
    )
  expect(recorded()).toEqual([{ task_id: null, artifact }])
  await f.runtime.command(
    {
      requestID: "continue-graph",
      planID: plan.planID,
      expectedVersion: f.store.plan(plan.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 4)
  expect(f.store.plan(plan.planID)!.state).toBe("accepted")
  expect(await f.runtime.command(current, "owner")).toEqual(receipt)
  expect(recorded()).toHaveLength(1)
})

test("reconcile retries a conclusively unsent route-guard prompt on the same attempt", async () => {
  const f = fixture({ independent: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const original = f.host.prompt
  f.host.prompt = async () => {
    throw new Error("Worker prompt target is not the exact assigned session and route")
  }
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(0)
  expect(
    f.store.effects(f.receipt.planID).find((effect) => effect.kind === "prompt"),
  ).toMatchObject({
    state: "failed",
    receipt: expect.stringContaining('"notSent":true'),
  })
  f.host.prompt = original
  await f.runtime.command(
    {
      requestID: "reconcile-route-guard",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 8)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
    workspace: attempt.workspace,
  })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test("lost host response reconciles a real accepted prompt without creating another worker", async () => {
  const f = fixture()
  const original = f.host.prompt
  f.host.prompt = async (input) => {
    await original(input)
    throw new Error("response lost")
  }
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime, 2)
  expect(f.store.effects(f.receipt.planID).find((e) => e.kind === "prompt")?.state).toBe(
    "completed",
  )
  expect(f.events.filter((e) => e.startsWith("prompt:"))).toHaveLength(1)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
})

test("lost prompt response after a committed worker turn reconciles through verification", async () => {
  const f = fixture({
    independent: true,
    delayed: false,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { child } = await prepareAfterPlanDependency(f, "lost-committed-child-prompt")
  const original = f.host.prompt
  f.host.prompt = async (input) => {
    await original(input)
    throw new Error("committed prompt response lost")
  }

  await f.runtime.tick()
  const attempt = f.store.attempts(child.planID)[0]!
  const originalPrompt = attempt.message_id
  expect(f.store.plan(child.planID)?.state).toBe("blocked")
  expect(attempt.state).toBe("preparing")
  expect(git(attempt.workspace, ["rev-parse", "HEAD"])).not.toBe(attempt.base_commit)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)

  await f.runtime.tick()
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "prompt")?.state).toBe(
    "completed",
  )
  await f.runtime.command(
    {
      requestID: "reconcile-lost-committed-child-prompt",
      planID: child.planID,
      expectedVersion: f.store.plan(child.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 8)

  expect(f.store.plan(child.planID)?.state).toBe("accepted")
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(f.store.attempts(child.planID)[0]).toMatchObject({ id: attempt.id, state: "accepted" })
  expect(git(attempt.workspace, ["rev-parse", "HEAD"])).not.toBe(attempt.base_commit)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
  expect(f.events.filter((event) => event === `prompt:${originalPrompt}`)).toHaveLength(1)
})

test("leases fence stale owners; expiration does not replay an uncertain effect", async () => {
  const f = fixture()
  const a = f.store.claim("first", 100)!
  expect(f.store.claim("second", 101)).toBeNull()
  const b = f.store.claim("second", 30101)!
  expect(b).toBeGreaterThan(a)
  expect(() => f.store.fenced("first", a, () => true)).toThrow("Stale")
  expect(f.store.fenced("second", b, () => true)).toBe(true)
})

test("schema rejects cycles, foreign dependency IDs and duplicate nodes before persistence", () => {
  const f = fixture()
  expect(
    PlanInput.safeParse({
      ...f.input,
      dependencies: [{ prerequisite: f.tasks[1]!.id, successor: f.tasks[0]!.id }],
    }).success,
  ).toBe(false)
  expect(
    PlanInput.safeParse({ ...f.input, nodes: [f.input.nodes[0], f.input.nodes[0]] }).success,
  ).toBe(false)
  expect(
    PlanInput.safeParse({
      ...f.input,
      dependencies: [{ prerequisite: crypto.randomUUID(), successor: f.tasks[0]!.id }],
    }).success,
  ).toBe(false)
  expect(() =>
    f.runtime.store.submit(
      {
        ...f.input,
        requestID: "foreign",
        nodes: [{ taskID: crypto.randomUUID(), revision: 1 }],
        integrationOrder: [crypto.randomUUID()],
      },
      "owner",
    ),
  ).toThrow()
})

test("historical guessed token caps do not stop useful work and stopped attempts resume without resetting usage", async () => {
  const f = fixture()
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const historicalPolicy = seedLegacySkillBody(f, attempt)
  const worker = f.sessions.get(attempt.session_id)!
  worker.tokens = 65941
  worker.outcome = "interrupted"
  f.store.move(f.receipt.planID, attempt.task_id, "EXHAUST", "Historical guessed token cap")
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='exhausted',token_count=65941 WHERE id=?").run(
      attempt.id,
    )
    db.query("UPDATE runner_plans SET state='blocked' WHERE id=?").run(f.receipt.planID)
  })
  const command = {
    requestID: "resume-existing",
    planID: f.receipt.planID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    action: "resume",
    taskID: attempt.task_id,
    reason: "No model-derived budget is configured",
  }
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  expect(f.store.attempts(f.receipt.planID)[0]!.token_count).toBe(65941)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)[0]!.policy).toBe(historicalPolicy)
  const sameTask = f.store.attempts(f.receipt.planID).filter((a) => a.task_id === attempt.task_id)
  expect(sameTask).toHaveLength(1)
  expect(sameTask[0]!.session_id).toBe(attempt.session_id)
  expect(sameTask[0]!.token_count).toBe(65941)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(3)
})

test("runtime retains the actual directory returned by the host worktree strategy", async () => {
  const f = fixture()
  const create = f.host.worktree
  f.host.worktree = async ({ directory, base }) => create({ directory: directory + "-2", base })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(
    f.store.attempts(f.receipt.planID).every((attempt) => attempt.workspace.endsWith("-2")),
  ).toBe(true)
  expect(f.store.effects(f.receipt.planID).some((effect) => effect.kind === "graph-worktree")).toBe(
    false,
  )
})

test("an explicitly cancelled worker can continue through its owner without replacing its worktree", async () => {
  const f = fixture()
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  await f.runtime.command(
    {
      requestID: "cancel",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cancelled")
  await f.runtime.command(
    {
      requestID: "continue",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "resume",
      taskID: attempt.task_id,
      reason: "Host location corrected",
    },
    "owner",
  )
  // Cancellation also stopped the queued successor; verify this task's continuation independently.
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]!.workspace).toBe(attempt.workspace)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
})

test("a cancelled afterPlans child resumes its retained committed attempt", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { child } = await prepareAfterPlanDependency(f, "resume-committed-child")
  await f.runtime.tick()
  const attempt = f.store.attempts(child.planID)[0]!
  const originalPromptID = attempt.message_id
  const originalHead = git(attempt.workspace, ["rev-parse", "HEAD"])
  expect(originalHead).not.toBe(attempt.base_commit)
  expect(f.store.attempts(child.planID)).toHaveLength(1)

  await f.runtime.command(
    {
      requestID: "cancel-committed-child",
      planID: child.planID,
      expectedVersion: f.store.plan(child.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(child.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(child.planID)[0]).toMatchObject({ id: attempt.id, state: "cancelled" })

  await f.runtime.command(
    {
      requestID: "resume-committed-child-attempt",
      planID: child.planID,
      expectedVersion: f.store.plan(child.planID)!.version,
      action: "resume",
      taskID: attempt.task_id,
      reason: "Continue the committed work in its retained workspace",
    },
    "owner",
  )
  await f.runtime.tick()
  const resumed = f.store.attempts(child.planID)[0]!
  expect(resumed).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
    state: "running",
    base_commit: attempt.base_commit,
  })
  expect(git(resumed.workspace, ["rev-parse", "HEAD"])).toBe(originalHead)
  expect(git(resumed.workspace, ["rev-parse", "HEAD"])).not.toBe(resumed.base_commit)
  const promptIDs = f.events
    .filter((event) => event.startsWith("prompt:"))
    .map((event) => event.slice(7))
  expect(promptIDs).toHaveLength(3)
  expect(promptIDs.filter((id) => id === originalPromptID)).toHaveLength(1)
  expect(resumed.message_id).not.toBe(originalPromptID)

  f.completeWorker(resumed.session_id)
  await drive(f.runtime, 8)
  expect(f.store.plan(child.planID)?.state).toBe("accepted")
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(f.store.attempts(child.planID)[0]?.state).toBe("accepted")
  expect(
    f.events.filter((event) => event.startsWith("prompt:")).map((event) => event.slice(7)),
  ).toEqual(promptIDs)
})

test("retry requeues a cancelled unstarted successor in the admitted graph and waits for dependencies and scope", async () => {
  const f = fixture({ delayed: true })
  const planID = f.receipt.planID
  const predecessorID = f.tasks[0]!.id
  const successorID = f.tasks[1]!.id
  const originalGraph = {
    body: f.store.plan(planID)!.body,
    nodes: f.store.nodes(planID).map((node) => node.task_id),
    dependencies: f.store.atomic((db) =>
      db
        .query<{ prerequisite: string; successor: string }, [string]>(
          "SELECT prerequisite,successor FROM runner_dependencies WHERE plan_id=? ORDER BY rowid",
        )
        .all(planID),
    ),
  }
  await runPlan(f)
  await f.runtime.tick()
  const original = f.store.attempts(planID)[0]!
  expect(original.task_id).toBe(predecessorID)
  expect(f.store.attempts(planID)).toHaveLength(1)

  await f.runtime.command(
    {
      requestID: "cancel-running-graph",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(planID)!.state).toBe("cancelled")
  expect(f.store.nodes(planID).map((node) => node.state)).toEqual(["cancelled", "cancelled"])

  await f.runtime.command(
    {
      requestID: "resume-original-predecessor",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "resume",
      taskID: predecessorID,
      reason: "Continue the admitted prerequisite",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)!.state).toBe("running")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: original.id,
    session_id: original.session_id,
    number: original.number,
    state: "running",
  })

  const requeue = {
    requestID: "requeue-unstarted-successor",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
    action: "retry" as const,
    taskID: successorID,
    reason: "Restore the original dependent task",
  }
  const receipt = await f.runtime.command(requeue, "owner")
  expect(receipt).toMatchObject({ status: "requeued" })
  expect(f.store.plan(planID)!.state).toBe("running")
  expect(f.store.plan(planID)!.body).toBe(originalGraph.body)
  expect(f.store.nodes(planID).map((node) => node.task_id)).toEqual(originalGraph.nodes)
  expect(
    f.store.atomic((db) =>
      db
        .query<{ prerequisite: string; successor: string }, [string]>(
          "SELECT prerequisite,successor FROM runner_dependencies WHERE plan_id=? ORDER BY rowid",
        )
        .all(planID),
    ),
  ).toEqual(originalGraph.dependencies)
  expect(f.store.nodes(planID).find((node) => node.task_id === successorID)?.state).toBe("ready")
  expect(f.store.execution(successorID)?.waitingOn).toEqual([predecessorID])
  expect(
    f.store.attempts(planID).filter((attempt) => attempt.task_id === successorID),
  ).toHaveLength(0)

  const requeuedHistory = f.store.activity(planID, successorID).length
  const reopenedRepository = new TaskRepository(f.repository.path, f.repository.projectDirectory)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopened = new TaskRuntime(reopenedStore, f.host, "project")
  try {
    expect(await reopened.command(requeue, "owner")).toEqual(receipt)
    await expect(
      reopened.command({ ...requeue, reason: "Different recovery intent" }, "owner"),
    ).rejects.toThrow("identity conflict")
    await expect(reopened.command(requeue, "not-the-owner")).rejects.toThrow("identity conflict")
    expect(reopenedStore.activity(planID, successorID)).toHaveLength(requeuedHistory)
  } finally {
    await reopened.stop()
    reopenedRepository.close()
  }
  expect(f.store.activity(planID, successorID)).toHaveLength(requeuedHistory)

  const scopeBlocker = f.createTask("c", "c.txt", ["b.txt", "c.txt"])
  const blockerPlan = f.store.submit(
    f.inputFor([scopeBlocker], { requestID: "scope-blocker-plan" }),
    "owner",
  )
  await f.runtime.command(
    {
      requestID: "run-scope-blocker",
      planID: blockerPlan.planID,
      expectedVersion: blockerPlan.version,
      action: "run",
    },
    "owner",
  )
  await f.runtime.tick()
  const blockerAttempt = f.store.attempts(blockerPlan.planID)[0]!
  expect(f.sessions.get(blockerAttempt.session_id)?.busy).toBe(true)

  f.completeWorker(original.session_id)
  await settleVerification(f.runtime)
  expect(f.store.nodes(planID).find((node) => node.task_id === predecessorID)?.state).toBe(
    "accepted",
  )
  expect(f.store.execution(successorID)?.waitingOn).toEqual([])
  expect(
    f.store.attempts(planID).filter((attempt) => attempt.task_id === successorID),
  ).toHaveLength(0)

  f.completeWorker(blockerAttempt.session_id)
  await settleVerification(f.runtime)
  expect(f.store.plan(blockerPlan.planID)?.state).toBe("accepted")
  // Completion may already have dispatched the now-unblocked successor.

  await f.runtime.tick()
  const successorAttempts = f.store
    .attempts(planID)
    .filter((attempt) => attempt.task_id === successorID)
  expect(successorAttempts).toHaveLength(1)
  expect(successorAttempts[0]).toMatchObject({ number: 1, state: "running" })
  expect(successorAttempts[0]!.base_commit).toBe(f.store.attempts(planID)[0]!.artifact!)
  expect(
    f.store.attempts(planID).filter((attempt) => attempt.task_id === predecessorID),
  ).toHaveLength(1)
  expect(f.store.activity(planID, predecessorID).map((entry) => entry.event)).toContain("RESUME")
  expect(f.store.activity(planID, predecessorID).map((entry) => entry.event)).toContain("CANCEL")

  f.completeWorker(successorAttempts[0]!.session_id)
  await drive(f.runtime)
  expect(f.store.plan(planID)?.state).toBe("accepted")
})

test("requeued unstarted work can be cancelled again before normal dispatch", async () => {
  const f = fixture()
  const planID = f.receipt.planID
  const cancelled = await cancelUnstartedPlan(f)
  expect(cancelled.state).toBe("cancelled")
  const taskID = f.tasks[1]!.id
  const requeue = {
    requestID: "requeue-then-cancel",
    planID,
    expectedVersion: cancelled.version,
    action: "retry" as const,
    taskID,
    reason: "Restore, then stop before dispatch",
  }
  const receipt = await f.runtime.command(requeue, "owner")
  expect(receipt).toMatchObject({ status: "requeued" })
  expect(f.store.attempts(planID)).toHaveLength(0)
  await f.runtime.command(
    {
      requestID: "cancel-requeued-before-dispatch",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)!.state).toBe("cancelled")
  expect(f.store.nodes(planID).find((node) => node.task_id === taskID)?.state).toBe("cancelled")
  expect(f.store.attempts(planID)).toHaveLength(0)
  expect(f.events.some((event) => event.startsWith("create:") || event.startsWith("prompt:"))).toBe(
    false,
  )
})

test("unstarted retry selects an explicit newer baseline without replacing tasks or attempts", async () => {
  const f = fixture({ delayed: true })
  const planID = f.receipt.planID
  const stopped = await cancelUnstartedPlan(f)
  const original = JSON.parse(stopped.body)
  const tasksBefore = f.tasks.map((task) => f.repository.get(task.id))
  writeFileSync(join(f.root, "new-baseline.txt"), "new current source\n")
  git(f.root, ["add", "new-baseline.txt"])
  git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "new baseline",
  ])
  const baseCommit = git(f.root, ["rev-parse", "HEAD"])
  const input = {
    requestID: "refresh-unstarted-baseline",
    planID,
    expectedVersion: stopped.version,
    action: "retry" as const,
    taskID: f.tasks[0]!.id,
    baseCommit,
    reason: "Continue the existing work on reviewed current source",
  }
  const receipt = await f.runtime.command(input, "owner")
  expect(receipt).toMatchObject({ status: "requeued" })
  expect(JSON.parse(f.store.plan(planID)!.body)).toEqual({ ...original, baseCommit })
  expect(f.store.plan(planID)!.revision).toBe(stopped.revision + 1)
  expect(f.tasks.map((task) => f.repository.get(task.id))).toEqual(tasksBefore)
  expect(f.store.attempts(planID)).toHaveLength(0)
  const version = f.store.plan(planID)!.version
  expect(await f.runtime.command(input, "owner")).toEqual(receipt)
  expect(f.store.plan(planID)!.version).toBe(version)
  await f.runtime.tick()
  expect(f.store.attempts(planID)[0]!.base_commit).toBe(baseCommit)
})

test("unstarted baseline selection rejects missing, unrelated and unlanded commits atomically", async () => {
  const f = fixture()
  const stopped = await cancelUnstartedPlan(f)
  const commitTree = (parents: string[]) =>
    git(f.root, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      `${f.base}^{tree}`,
      ...parents,
      "-m",
      "unlanded source",
    ])
  const before = f.store.plan(stopped.id)
  const history = f.store.activity(stopped.id, f.tasks[0]!.id)
  for (const baseCommit of ["f".repeat(40), commitTree([]), commitTree(["-p", f.base])]) {
    await expect(
      f.runtime.command(
        {
          requestID: `invalid-baseline-${baseCommit}`,
          planID: stopped.id,
          expectedVersion: stopped.version,
          action: "retry",
          taskID: f.tasks[0]!.id,
          baseCommit,
          reason: "Refresh unstarted source",
        },
        "owner",
      ),
    ).rejects.toThrow()
    expect(f.store.plan(stopped.id)).toEqual(before)
    expect(f.store.activity(stopped.id, f.tasks[0]!.id)).toEqual(history)
    expect(f.store.attempts(stopped.id)).toHaveLength(0)
  }
})

test("unstarted baseline selection cannot rewrite a plan with a prior worker", async () => {
  const f = fixture({ delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  await f.runtime.command(
    {
      requestID: "cancel-prior-worker-baseline",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  const before = f.store.plan(f.receipt.planID)!
  const attempts = f.store.attempts(before.id)
  expect(attempts).toHaveLength(1)
  expect(before.state).toBe("cancelled")
  expect(before.artifact).toBeNull()
  await expect(
    f.runtime.command(
      {
        requestID: "reject-rewriting-prior-worker-baseline",
        planID: before.id,
        expectedVersion: before.version,
        action: "retry",
        taskID: f.tasks[1]!.id,
        baseCommit: "f".repeat(40),
        reason: "Do not rewrite execution history",
      },
      "owner",
    ),
  ).rejects.toThrow("prior attempts")
  expect(f.store.plan(before.id)).toEqual(before)
  expect(f.store.attempts(before.id)).toEqual(attempts)
})

test("unstarted recovery rejects unauthorized, stale, missing, archived and foreign owners without writes", async () => {
  for (const denial of ["unauthorized", "stale", "missing", "archived", "foreign"] as const) {
    const f = fixture()
    const stopped = await cancelUnstartedPlan(f)
    const planID = stopped.id
    const taskID = f.tasks[1]!.id
    const beforePlan = f.store.plan(planID)!
    const beforeNode = f.store.nodes(planID).find((node) => node.task_id === taskID)!
    const beforeHistory = f.store.activity(planID, taskID)
    const recovery = {
      requestID: `denied-recovery-${denial}`,
      planID,
      expectedVersion: denial === "stale" ? beforePlan.version - 1 : beforePlan.version,
      action: "retry" as const,
      taskID,
      reason: "Attempt a denied recovery",
    }
    if (denial === "missing") f.sessions.delete("owner")
    if (denial === "archived") f.sessions.get("owner")!.archived = true
    if (denial === "foreign") f.sessions.get("owner")!.projectID = "another-project"

    await expect(
      f.runtime.command(recovery, denial === "unauthorized" ? "not-the-owner" : "owner"),
    ).rejects.toThrow(
      denial === "unauthorized"
        ? "Only the plan owner"
        : denial === "stale"
          ? "Stale plan version"
          : denial === "foreign"
            ? "Foreign owner session"
            : "Owner unavailable",
    )
    expect(f.store.plan(planID)).toEqual(beforePlan)
    expect(f.store.nodes(planID).find((node) => node.task_id === taskID)).toEqual(beforeNode)
    expect(f.store.activity(planID, taskID)).toEqual(beforeHistory)
    expect(f.store.attempts(planID)).toHaveLength(0)
    expect(
      f.store.atomic(
        (db) =>
          db
            .query<{ count: number }, [string, string]>(
              "SELECT count(*) AS count FROM runner_commands WHERE project_directory=? AND request_id=?",
            )
            .get(f.store.repository.projectDirectory, recovery.requestID)!.count,
      ),
    ).toBe(0)
    expect(
      f.events.some((event) => event.startsWith("create:") || event.startsWith("prompt:")),
    ).toBe(false)
  }
})

test("unstarted recovery rechecks the plan version after owner lookup races with reassignment", async () => {
  const f = fixture()
  const stopped = await cancelUnstartedPlan(f)
  const planID = stopped.id
  const taskID = f.tasks[1]!.id
  f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner" })
  const recovery = {
    requestID: "racing-unstarted-recovery",
    planID,
    expectedVersion: stopped.version,
    action: "retry" as const,
    taskID,
    reason: "Recover only if ownership remains current",
  }
  const beforeHistory = f.store.activity(planID, taskID)
  const originalSession = f.host.session
  let announceLookup!: () => void
  let releaseLookup!: () => void
  const lookupStarted = new Promise<void>((resolve) => (announceLookup = resolve))
  const lookupGate = new Promise<void>((resolve) => (releaseLookup = resolve))
  f.host.session = async (id, options) => {
    if (id === "owner") {
      announceLookup()
      await lookupGate
    }
    return originalSession(id, options)
  }

  const pendingRecovery = f.runtime.command(recovery, "owner")
  await lookupStarted
  await f.runtime.command(
    {
      requestID: "reassign-during-unstarted-recovery",
      planID,
      expectedVersion: stopped.version,
      action: "reassign",
      targetSessionID: "new-owner",
      reason: "Explicitly change the plan owner",
    },
    "owner",
  )
  releaseLookup()
  await expect(pendingRecovery).rejects.toThrow("Stale plan version")

  expect(f.store.plan(planID)).toMatchObject({ owner: "new-owner", state: "cancelled" })
  expect(f.store.nodes(planID).find((node) => node.task_id === taskID)?.state).toBe("cancelled")
  expect(f.store.activity(planID, taskID)).toEqual(beforeHistory)
  expect(f.store.attempts(planID)).toHaveLength(0)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string, string]>(
            "SELECT count(*) AS count FROM runner_commands WHERE project_directory=? AND request_id=?",
          )
          .get(f.store.repository.projectDirectory, recovery.requestID)!.count,
    ),
  ).toBe(0)
})

test("unstarted recovery rejects invalid node/plan states and unreconciled effects", async () => {
  const queued = fixture()
  await runPlan(queued)
  const queuedPlan = queued.store.plan(queued.receipt.planID)!
  const queuedTask = queued.tasks[1]!.id
  await expect(
    queued.runtime.command(
      {
        requestID: "retry-still-queued-node",
        planID: queuedPlan.id,
        expectedVersion: queuedPlan.version,
        action: "retry",
        taskID: queuedTask,
        reason: "Do not recover a non-cancelled node",
      },
      "owner",
    ),
  ).rejects.toThrow("Only an exhausted or cancelled, stopped attempt can resume")
  expect(queued.store.nodes(queuedPlan.id).find((node) => node.task_id === queuedTask)?.state).toBe(
    "queued",
  )
  expect(queued.store.attempts(queuedPlan.id)).toHaveLength(0)

  const integrated = fixture()
  const integratedPlan = await cancelUnstartedPlan(integrated)
  integrated.store.atomic((db) =>
    db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(integratedPlan.id),
  )
  const integratedNode = integrated.store
    .nodes(integratedPlan.id)
    .find((node) => node.task_id === integrated.tasks[1]!.id)!
  const integratedHistory = integrated.store.activity(integratedPlan.id, integratedNode.task_id)
  await expect(
    integrated.runtime.command(
      {
        requestID: "retry-integrated-plan",
        planID: integratedPlan.id,
        expectedVersion: integrated.store.plan(integratedPlan.id)!.version,
        action: "retry",
        taskID: integratedNode.task_id,
        reason: "Do not revive an integrated plan",
      },
      "owner",
    ),
  ).rejects.toThrow("Only an admitted, nonintegrated plan can requeue an unstarted task")
  expect(
    integrated.store
      .nodes(integratedPlan.id)
      .find((node) => node.task_id === integratedNode.task_id),
  ).toEqual(integratedNode)
  expect(integrated.store.activity(integratedPlan.id, integratedNode.task_id)).toEqual(
    integratedHistory,
  )
  expect(integrated.store.attempts(integratedPlan.id)).toHaveLength(0)

  const unresolved = fixture()
  const unresolvedPlan = await cancelUnstartedPlan(unresolved)
  const unresolvedTask = unresolved.tasks[1]!.id
  unresolved.store.atomic((db) =>
    db
      .query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'intended',?,NULL,0)")
      .run(
        crypto.randomUUID(),
        unresolvedPlan.id,
        unresolvedTask,
        null,
        "recovery-test-effect",
        "{}",
      ),
  )
  const unresolvedNode = unresolved.store
    .nodes(unresolvedPlan.id)
    .find((node) => node.task_id === unresolvedTask)!
  const unresolvedHistory = unresolved.store.activity(unresolvedPlan.id, unresolvedTask)
  await expect(
    unresolved.runtime.command(
      {
        requestID: "retry-with-unresolved-effect",
        planID: unresolvedPlan.id,
        expectedVersion: unresolved.store.plan(unresolvedPlan.id)!.version,
        action: "retry",
        taskID: unresolvedTask,
        reason: "Reconcile the outstanding effect first",
      },
      "owner",
    ),
  ).rejects.toThrow("Reconcile uncertain effects first")
  expect(
    unresolved.store.nodes(unresolvedPlan.id).find((node) => node.task_id === unresolvedTask),
  ).toEqual(unresolvedNode)
  expect(unresolved.store.activity(unresolvedPlan.id, unresolvedTask)).toEqual(unresolvedHistory)
  expect(unresolved.store.attempts(unresolvedPlan.id)).toHaveLength(0)
  expect(
    unresolved.store.effects(unresolvedPlan.id).some((effect) => effect.state === "intended"),
  ).toBe(true)
})

test("serial shared children commit in the current checkout without creating worktrees", async () => {
  const f = fixture({ shared: true })
  f.host.worktree = async () => {
    throw new Error("Serial tasks must not allocate worktrees")
  }
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID).every((attempt) => attempt.workspace === f.root)).toBe(
    true,
  )
  expect(f.store.effects(f.receipt.planID).some((effect) => effect.kind.includes("worktree"))).toBe(
    false,
  )
  expect(git(f.root, ["show", "HEAD:a.txt"])).toBe("a")
  expect(git(f.root, ["show", "HEAD:b.txt"])).toBe("b")
})

test("explicit retry starts a fresh native child and retains the old attempt and usage", async () => {
  const f = fixture({ shared: true })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  const old = f.store.attempts(f.receipt.planID)[0]!
  seedLegacySkillBody(f, old)
  f.store.atomic((db) =>
    db.query("UPDATE runner_attempts SET token_count=65941 WHERE id=?").run(old.id),
  )
  await f.runtime.command(
    {
      requestID: "cancel",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  const command = {
    requestID: "fresh-retry",
    planID: f.receipt.planID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    action: "retry",
    taskID: old.task_id,
    reason: "Use concise task fetch in a fresh child",
    workspaceMode: "shared",
    baseCommit: f.base,
  }
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]!.token_count).toBe(65941)
  expect(attempts[0]!.state).toBe("cancelled")
  expect(attempts[0]!.policy).toContain(skillBodyCanary)
  expectNoSkillBody(attempts[1]!.policy)
  expect(attempts[1]!.session_id).not.toBe(old.session_id)
  expect(attempts[1]!.workspace).toBe(f.root)
})

test("a shared node's first attempt starts at reviewed HEAD, not an older accepted predecessor", async () => {
  const f = fixture({ shared: true })
  let reviewedHead = ""
  const move = f.store.move.bind(f.store)
  f.store.move = (planID, taskID, event, reason) => {
    const result = move(planID, taskID, event, reason)
    if (taskID === f.tasks[0]!.id && event === "ACCEPT") {
      writeFileSync(join(f.root, "reviewer-fix.txt"), "approved\n")
      git(f.root, ["add", "reviewer-fix.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Reviewed repair between shared nodes",
      ])
      reviewedHead = git(f.root, ["rev-parse", "HEAD"])
    }
    return result
  }
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  const predecessor = f.store.attempts(f.receipt.planID)[0]!
  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  await drive(reopened)
  const predecessorArtifact = f.store.attempts(f.receipt.planID)[0]!.artifact
  expect(reviewedHead).not.toBe("")
  expect(reviewedHead).not.toBe(predecessorArtifact)
  const next = f.store
    .attempts(f.receipt.planID)
    .find((attempt) => attempt.task_id === f.tasks[1]!.id)!
  expect(next.base_commit).toBe(reviewedHead)
  expect(JSON.parse(next.policy).source).toBe(reviewedHead)
  expect(next.state).toBe("accepted")
  expect(git(f.root, ["diff", "--name-only", `${next.base_commit}..${next.artifact}`])).toBe(
    "b.txt",
  )
  expect(git(f.root, ["show", `${next.artifact}:reviewer-fix.txt`])).toBe("approved")
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
    id: predecessor.id,
    artifact: predecessorArtifact,
    base_commit: f.base,
    state: "accepted",
  })
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
})

test("an explicit corrected shared baseline wins across reopen and excludes reviewed scope changes", async () => {
  const f = fixture({ shared: true, wrongFirstB: true })
  const { predecessor, failed } = await failSecondSharedTask(f)
  const predecessorArtifact = predecessor.artifact
  const failedArtifact = failed.artifact
  if (!predecessorArtifact || !failedArtifact) throw new Error("Expected Git artifacts")
  expect(failed.token_count).toBe(65941)
  expect(failed.tool_count).toBe(17)
  expect(failed.cost).toBe(1.25)

  writeFileSync(join(f.root, "reviewer-fix.txt"), "approved\n")
  git(f.root, ["add", "reviewer-fix.txt"])
  git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Reviewer correction",
  ])
  const correctedBaseline = git(f.root, ["rev-parse", "HEAD"])
  expect(correctedBaseline).not.toBe(failedArtifact)
  expect(git(f.root, ["show", `${correctedBaseline}:reviewer-fix.txt`])).toBe("approved")

  const retry = await f.runtime.command(
    {
      requestID: "retry-corrected-baseline",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "retry",
      taskID: f.tasks[1]!.id,
      reason: "Start from the reviewed shared baseline",
      workspaceMode: "shared",
      baseCommit: correctedBaseline,
    },
    "owner",
  )
  expect(retry).toMatchObject({ status: "retrying" })
  expect(
    f.store.latestTransition<{ attemptID: string; source: string; explicitBaseline: boolean }>(
      f.receipt.planID,
      f.tasks[1]!.id,
      "WORKSPACE_SELECTED",
    ),
  ).toMatchObject({ source: correctedBaseline, explicitBaseline: true })
  expect(
    f.store.latestTransition<{
      attemptID: string
      selectedBaseline: string | null
      reason: string
      usageRetained: boolean
      budget: null
    }>(f.receipt.planID, f.tasks[1]!.id, "RETRY_REQUESTED"),
  ).toEqual({
    attemptID: failed.id,
    reason: "Start from the reviewed shared baseline",
    usageRetained: true,
    budget: null,
    selectedBaseline: correctedBaseline,
  })

  // A fresh runtime must recover the selected source from durable retry history.
  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  try {
    await drive(reopened)
  } finally {
    reopened.stop()
  }

  const retriedAttempts = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === f.tasks[1]!.id)
  expect(retriedAttempts).toHaveLength(2)
  const retried = retriedAttempts[1]!
  const retriedArtifact = retried.artifact
  if (!retriedArtifact) throw new Error("Expected retry artifact")
  expect(retried.base_commit).toBe(correctedBaseline)
  expect(JSON.parse(retried.policy).source).toBe(correctedBaseline)
  expect(retried.workspace).toBe(f.root)
  expect(retried.state).toBe("accepted")
  expect(retriedAttempts[0]).toMatchObject({
    id: failed.id,
    state: "failed",
    base_commit: predecessorArtifact,
    artifact: failedArtifact,
    token_count: 65941,
    tool_count: 17,
    cost: 1.25,
  })
  expect(f.store.nodes(f.receipt.planID)[1]!.state).toBe("accepted")
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(git(f.root, ["diff", "--name-only", `${correctedBaseline}..${retriedArtifact}`])).toBe(
    "b.txt",
  )
  expect(git(f.root, ["show", `${retriedArtifact}:reviewer-fix.txt`])).toBe("approved")

  const failedCheck = attemptCheck(f, f.tasks[1]!.id, failed.id)
  const retriedCheck = attemptCheck(f, f.tasks[1]!.id, retried.id)
  expect(failedCheck.artifact).toBe(failedArtifact)
  expect(failedCheck.exitCode).not.toBe(0)
  expect(retriedCheck.artifact).toBe(retriedArtifact)
  expect(retriedCheck.inputIdentity).toBe(retriedArtifact)
  expect(retriedCheck.exitCode).toBe(0)
  const checks = f.store
    .effects(f.receipt.planID)
    .filter((effect) => effect.task_id === f.tasks[1]!.id && effect.kind === "verify:content")
  expect(checks.map((effect) => effect.id)).toHaveLength(2)
  expect(new Set(checks.map((effect) => effect.attempt_id)).size).toBe(2)
  const combined = f.store
    .effects(f.receipt.planID)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(combined.receipt!).check.artifact).toBe(retriedArtifact)
})

test("retry without a newly selected baseline continues from the failed artifact and retains history", async () => {
  const f = fixture({ shared: true, wrongFirstB: true })
  const { predecessor, failed } = await failSecondSharedTask(f)
  const predecessorArtifact = predecessor.artifact
  const failedArtifact = failed.artifact
  if (!predecessorArtifact || !failedArtifact) throw new Error("Expected Git artifacts")
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(failedArtifact)

  await f.runtime.command(
    {
      requestID: "retry-existing-baseline",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "retry",
      taskID: f.tasks[1]!.id,
      reason: "Continue the existing shared attempt",
      workspaceMode: "shared",
    },
    "owner",
  )
  expect(
    f.store.latestTransition<{ attemptID: string; selectedBaseline: string | null }>(
      f.receipt.planID,
      f.tasks[1]!.id,
      "RETRY_REQUESTED",
    ),
  ).toMatchObject({ attemptID: failed.id, selectedBaseline: null })
  await drive(f.runtime)

  const retriedAttempts = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === f.tasks[1]!.id)
  expect(retriedAttempts).toHaveLength(2)
  const retried = retriedAttempts[1]!
  const retriedArtifact = retried.artifact
  if (!retriedArtifact) throw new Error("Expected retry artifact")
  expect(retried.base_commit).toBe(failedArtifact)
  expect(JSON.parse(retried.policy).source).toBe(failedArtifact)
  expect(retried.state).toBe("accepted")
  expect(retriedAttempts[0]).toMatchObject({
    id: failed.id,
    state: "failed",
    base_commit: predecessorArtifact,
    artifact: failedArtifact,
    token_count: 65941,
    tool_count: 17,
    cost: 1.25,
  })
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")

  const failedCheck = attemptCheck(f, f.tasks[1]!.id, failed.id)
  const retriedCheck = attemptCheck(f, f.tasks[1]!.id, retried.id)
  expect(failedCheck.artifact).toBe(failedArtifact)
  expect(failedCheck.exitCode).not.toBe(0)
  expect(retriedArtifact).not.toBe(failedArtifact)
  expect(retriedCheck.artifact).toBe(retriedArtifact)
  expect(retriedCheck.inputIdentity).toBe(retriedArtifact)
  expect(retriedCheck.exitCode).toBe(0)
  const combined = f.store
    .effects(f.receipt.planID)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(combined.receipt!).check.artifact).toBe(retriedArtifact)
})

test("native cleanup follows verified integration, preserves dirty work, and retries explicitly", async () => {
  const f = fixture({ commit: true })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  const artifact = f.store.plan(f.receipt.planID)!.artifact!
  const request = (key: string) => ({
    requestID: key,
    planID: f.receipt.planID,
    expectedVersion: f.store.plan(f.receipt.planID)!.version,
    action: "integrated",
    artifact,
    targetBranch: "main",
    reason: "Reviewed task changes and combined checks",
  })
  await expect(f.runtime.command(request("not-merged"), "owner")).rejects.toThrow()
  git(f.root, ["merge", "--ff-only", artifact])
  const worktree = f.store.attempts(f.receipt.planID)[0]!.workspace
  writeFileSync(join(worktree, "unreviewed.txt"), "preserve this")
  await f.runtime.command(request("merged"), "owner")
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cleanup-blocked")
  expect(readFileSync(join(worktree, "unreviewed.txt"), "utf8")).toBe("preserve this")
  expect(f.store.nodes(f.receipt.planID).every((node) => node.state === "accepted")).toBe(true)
  rmSync(join(worktree, "unreviewed.txt"))
  await f.runtime.command(request("retry-cleanup"), "owner")
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.reason).toBeNull()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("integrated")
  expect(await f.host.worktrees()).toEqual([f.root])
  expect(git(f.root, ["show", "HEAD:b.txt"])).toBe("b")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
})

test("cleanup preserves current activity and unknown holds but accepts authoritative worker absence", async () => {
  const f = fixture({ commit: true })
  await runPlan(f)
  await drive(f.runtime)
  const plan = f.store.plan(f.receipt.planID)!
  const artifact = plan.artifact!
  const attempt = f.store.attempts(plan.id)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalBackground = structuredClone(worker.background)
  const worktree = attempt.workspace
  const checksBefore = f.store
    .effects(plan.id)
    .filter(
      (effect) => effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:"),
    )
    .map((effect) => [effect.id, effect.state, effect.receipt])
  const workerAdmissionsBefore = f.events.filter((event) => /^(create|prompt):/.test(event)).length
  git(f.root, ["merge", "--ff-only", artifact])

  const retryCleanup = async (requestID: string) => {
    await f.runtime.command(
      {
        requestID,
        planID: plan.id,
        expectedVersion: f.store.plan(plan.id)!.version,
        action: "integrated",
        artifact,
        targetBranch: "main",
        reason: "Retry cleanup after the worker was observed idle",
      },
      "owner",
    )
    await f.runtime.tick()
    expect(f.store.plan(plan.id)?.state).toBe("cleanup-blocked")
    expect(await f.host.worktrees()).toContain(worktree)
  }

  worker.busy = true
  await retryCleanup("cleanup-busy-worker")
  worker.busy = false
  worker.pendingInput = true
  await retryCleanup("cleanup-pending-input")
  worker.pendingInput = false
  worker.pendingPermissions = 1
  await retryCleanup("cleanup-pending-permission")
  worker.pendingPermissions = 0
  worker.pendingForms = 1
  await retryCleanup("cleanup-pending-form")
  worker.pendingForms = 0
  worker.observationUnstable = true
  await retryCleanup("cleanup-unstable-observation")
  worker.observationUnstable = false
  worker.background = {
    state: "unknown",
    source: "experimental.idle",
    reason: "fixture cannot establish worker quiescence",
  }
  await retryCleanup("cleanup-unknown-background")

  worker.background = originalBackground
  delete worker.pendingInput
  delete worker.pendingPermissions
  delete worker.pendingForms
  // RunnerHost null means the native adapter proved this session is absent;
  // it is not an unavailable observation or an invented zero-background report.
  f.sessions.delete(attempt.session_id)
  await f.runtime.command(
    {
      requestID: "cleanup-after-worker-termination",
      planID: plan.id,
      expectedVersion: f.store.plan(plan.id)!.version,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "The merged worker has terminated and its native session is absent",
    },
    "owner",
  )
  await f.runtime.tick()

  expect(f.store.plan(plan.id)?.state).toBe("integrated")
  expect(await f.host.worktrees()).not.toContain(worktree)
  expect(
    f.store
      .effects(plan.id)
      .filter(
        (effect) => effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:"),
      )
      .map((effect) => [effect.id, effect.state, effect.receipt]),
  ).toEqual(checksBefore)
  expect(f.events.filter((event) => /^(create|prompt):/.test(event)).length).toBe(
    workerAdmissionsBefore,
  )
})

test("location retirement uses active project ownership outside the display plan listing", async () => {
  const f = fixture()
  const plan = f.store.plan(f.receipt.planID)!
  const workspace = join(`${f.root}.worktrees`, "active-owner-checkout")
  const attemptID = crypto.randomUUID()
  f.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_attempts(
           id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,
           policy,state,started_at,token_count,tool_count,retry_count,cost
         ) VALUES(?,?,?,?,?,?,?,?,NULL,?,'running',?,NULL,0,0,NULL)`,
      )
      .run(
        attemptID,
        plan.id,
        f.tasks[0]!.id,
        1,
        "ses_cleanup_active_owner",
        "msg_cleanup_active_owner",
        workspace,
        f.input.baseCommit,
        JSON.stringify({}),
        Date.now(),
      ),
  )
  expect(f.store.activeProjectAttempts().map((attempt) => attempt.id)).toContain(attemptID)

  const displayedPlans = spyOn(f.store, "plans").mockReturnValue([])
  const originalWorktrees = f.host.worktrees
  let inventoryReads = 0
  let retireCalls = 0
  f.host.worktrees = async () => {
    inventoryReads++
    return originalWorktrees()
  }
  f.host.retireWorktreeLocation = async () => {
    retireCalls++
    return "not-loaded"
  }
  const internals = f.runtime as unknown as {
    retireCleanedWorktreeLocation(
      plan: NonNullable<ReturnType<typeof f.store.plan>>,
      workspace: string,
      cleanupCurrent: () => boolean,
    ): Promise<string>
  }

  await expect(internals.retireCleanedWorktreeLocation(plan, workspace, () => true)).resolves.toBe(
    "reserved-by-other-attempt",
  )
  expect(displayedPlans).not.toHaveBeenCalled()
  expect(inventoryReads).toBe(0)
  expect(retireCalls).toBe(0)
})

test("cleanup audit reports the first sampled worker blocker without exposing observed identity details", async () => {
  const { f, planID, attempt, worker } = await cleanupBlockedFixture()
  const valid = structuredClone(worker)
  valid.busy = false
  const sessionCalls: { id: string; options?: { messages?: boolean } }[] = []
  const originalSession = f.host.session
  f.host.session = async (id, options) => {
    sessionCalls.push({ id, options })
    return originalSession(id, options)
  }
  type Diagnostic = {
    binding: {
      projectID: string
      planID: string
      attemptID: string
      sessionID: string
      workspace: string
      assignedMessageID: string
    }
    firstBlocker: { stage: string; code: string } | null
    planVersion: number
    sampledAt: number
    stages: Array<{ stage: string; status: string; code?: string }>
  }
  const auditedWorker = (result: unknown) => {
    const diagnostics = (result as { cleanupDiagnostics?: { workers?: Diagnostic[] } })
      .cleanupDiagnostics
    expect(diagnostics?.workers).toHaveLength(1)
    return diagnostics!.workers![0]!
  }
  const audit = (requestID: string) =>
    f.runtime.command(
      {
        requestID,
        planID,
        expectedVersion: f.store.plan(planID)!.version,
        action: "audit",
      },
      "observer",
    )
  const sample = async (
    requestID: string,
    change?: (session: HostSession) => void,
  ): Promise<Diagnostic> => {
    const session = structuredClone(valid)
    change?.(session)
    f.sessions.set(attempt.session_id, session)
    return auditedWorker(await audit(requestID))
  }
  const cases: Array<{
    name: string
    stage: string
    code: string
    change?: (session: HostSession) => void
    absent?: boolean
    unavailable?: boolean
  }> = [
    { name: "read failure", stage: "session-read", code: "read-unavailable", unavailable: true },
    {
      name: "session identity",
      stage: "session-id",
      code: "session-id-mismatch",
      change: (session) => (session.id = "foreign-session-detail"),
    },
    {
      name: "project identity",
      stage: "project-id",
      code: "project-id-mismatch",
      change: (session) => (session.projectID = "foreign-project-detail"),
    },
    {
      name: "directory identity",
      stage: "directory",
      code: "directory-mismatch",
      change: (session) => (session.directory = "/foreign/workspace-detail"),
    },
    {
      name: "agent identity",
      stage: "agent",
      code: "agent-mismatch",
      change: (session) => (session.agent = "foreign-agent-detail"),
    },
    {
      name: "attempt identity",
      stage: "attempt-id",
      code: "attempt-id-mismatch",
      change: (session) =>
        (session.metadata = { ...session.metadata, lazersAttemptID: "foreign-attempt-detail" }),
    },
    {
      name: "foreground activity",
      stage: "foreground",
      code: "foreground-busy",
      change: (session) => (session.busy = true),
    },
    {
      name: "pending input",
      stage: "pending-input",
      code: "pending-input",
      change: (session) => (session.pendingInput = true),
    },
    {
      name: "unstable observation",
      stage: "observation-stability",
      code: "observation-unstable",
      change: (session) => (session.observationUnstable = true),
    },
    {
      name: "pending permission",
      stage: "pending-permissions",
      code: "pending-permissions",
      change: (session) => (session.pendingPermissions = 1),
    },
    {
      name: "pending form",
      stage: "pending-forms",
      code: "pending-forms",
      change: (session) => (session.pendingForms = 1),
    },
    {
      name: "missing outcome",
      stage: "outcome",
      code: "outcome-absent",
      change: (session) => {
        delete session.outcome
      },
    },
    {
      name: "missing turn",
      stage: "turn",
      code: "turn-absent",
      change: (session) => {
        delete session.turn
      },
    },
    {
      name: "pending turn",
      stage: "turn",
      code: "turn-pending",
      change: (session) => {
        session.turn = { inputID: attempt.message_id, state: "pending" }
      },
    },
    {
      name: "unknown turn",
      stage: "turn",
      code: "turn-unknown",
      change: (session) => {
        session.turn = { inputID: attempt.message_id, state: "unknown" }
      },
    },
    {
      name: "missing background observation",
      stage: "background",
      code: "background-absent",
      change: (session) => {
        delete session.background
      },
    },
    {
      name: "unknown background observation",
      stage: "background",
      code: "background-unknown",
      change: (session) => {
        session.background = {
          state: "unknown",
          source: "experimental.idle",
          reason: "credential=private-background-detail",
        }
      },
    },
    {
      name: "assigned input mismatch",
      stage: "assigned-input",
      code: "assigned-input-mismatch",
      change: (session) => {
        if (session.background?.state === "observed")
          session.background.inputID = "foreign-input-detail"
      },
    },
    {
      name: "turn input mismatch",
      stage: "turn-input",
      code: "turn-input-mismatch",
      change: (session) => {
        if (session.turn) session.turn.inputID = "foreign-turn-input-detail"
      },
    },
    {
      name: "positive background count",
      stage: "background-count",
      code: "positive-background-count",
      change: (session) => {
        if (session.background?.state === "observed") session.background.count = 1
      },
    },
  ]

  for (const [index, item] of cases.entries()) {
    if (item.absent) f.sessions.delete(attempt.session_id)
    else {
      const session = structuredClone(valid)
      item.change?.(session)
      f.sessions.set(attempt.session_id, session)
    }
    const read = f.host.session
    if (item.unavailable) {
      f.host.session = async () => {
        throw new Error("Authorization: Bearer private-secret")
      }
    }
    const diagnostic = auditedWorker(
      await audit(`cleanup-audit-stage-${index}-${item.name.replaceAll(" ", "-")}`),
    )
    f.host.session = read
    expect(diagnostic.firstBlocker).toEqual({ stage: item.stage, code: item.code })
    const blockedIndex = diagnostic.stages.findIndex((stage) => stage.stage === item.stage)
    expect(diagnostic.stages[blockedIndex]).toMatchObject({ status: "blocked", code: item.code })
    expect(
      diagnostic.stages.slice(0, blockedIndex).every((stage) => stage.status === "passed"),
    ).toBe(true)
    expect(
      diagnostic.stages.slice(blockedIndex + 1).every((stage) => stage.status === "not-evaluated"),
    ).toBe(true)
    expect(diagnostic.binding).toEqual({
      projectID: "project",
      planID,
      attemptID: attempt.id,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      assignedMessageID: attempt.message_id,
    })
    expect(diagnostic.planVersion).toBe(f.store.plan(planID)!.version)
    expect(diagnostic.sampledAt).toBeGreaterThan(0)
    const serialized = JSON.stringify(diagnostic)
    expect(serialized).not.toContain("foreign-session-detail")
    expect(serialized).not.toContain("foreign-project-detail")
    expect(serialized).not.toContain("foreign/workspace-detail")
    expect(serialized).not.toContain("foreign-agent-detail")
    expect(serialized).not.toContain("foreign-attempt-detail")
    expect(serialized).not.toContain("private-secret")
    expect(serialized).not.toContain("private-background-detail")
    if (item.absent) f.sessions.set(attempt.session_id, structuredClone(valid))
  }

  for (const state of ["completed", "interrupted"] as const) {
    const diagnostic = await sample(`cleanup-audit-zero-${state}`, (session) => {
      session.outcome = state === "completed" ? "succeeded" : "interrupted"
      session.turn = { inputID: attempt.message_id, state }
      if (session.background?.state === "observed") session.background.count = 0
    })
    expect(diagnostic.firstBlocker).toBeNull()
    expect(diagnostic.stages.every((stage) => stage.status === "passed")).toBe(true)
  }
  const auditor = await sample("cleanup-audit-current-auditor", (session) => {
    session.agent = "auditor"
  })
  expect(auditor.firstBlocker).toBeNull()
  f.sessions.delete(attempt.session_id)
  const absent = auditedWorker(await audit("cleanup-audit-authoritative-absence"))
  expect(absent.firstBlocker).toBeNull()
  expect(absent.stages[0]).toEqual({
    stage: "session-read",
    status: "passed",
    code: "session-absent",
  })
  expect(absent.stages.slice(1).every((stage) => stage.status === "not-evaluated")).toBe(true)
  f.sessions.set(attempt.session_id, structuredClone(valid))
  expect(
    sessionCalls.every((call) => call.id === attempt.session_id && call.options?.messages === true),
  ).toBe(true)
})

test("cleanup audit is neutral, receipt-safe, and later requests sample fresh observations", async () => {
  const { f, planID, attempt, worker } = await cleanupBlockedFixture()
  const planBefore = f.store.plan(planID)!
  const detailBefore = f.store.detail(planID)
  const notificationsBefore = f.notifications.length
  const eventsBefore = [...f.events]
  const sessionCalls: { id: string; options?: { messages?: boolean } }[] = []
  let worktreeReads = 0
  let removals = 0
  const originalSession = f.host.session
  const originalWorktrees = f.host.worktrees
  const originalRemove = f.host.removeWorktree
  f.host.session = async (id, options) => {
    sessionCalls.push({ id, options })
    return originalSession(id, options)
  }
  f.host.worktrees = async () => {
    worktreeReads++
    return originalWorktrees()
  }
  f.host.removeWorktree = async (workspace) => {
    removals++
    return originalRemove(workspace)
  }
  const input = {
    requestID: "cleanup-audit-replay",
    planID,
    expectedVersion: planBefore.version,
    action: "audit" as const,
  }
  const first = await f.runtime.command(input, "observer")
  const firstDiagnostic = (
    first as {
      cleanupDiagnostics: { diagnosticOnly: true; workers: Array<{ firstBlocker: unknown }> }
    }
  ).cleanupDiagnostics
  expect(firstDiagnostic.diagnosticOnly).toBe(true)
  expect(firstDiagnostic.workers[0]?.firstBlocker).toEqual({
    stage: "foreground",
    code: "foreground-busy",
  })
  const detailAfter = f.store.detail(planID)
  expect(detailAfter.plan).toEqual(detailBefore.plan)
  expect(detailAfter.nodes).toEqual(detailBefore.nodes)
  expect(detailAfter.attempts).toEqual(detailBefore.attempts)
  expect(detailAfter.effects).toEqual(detailBefore.effects)
  expect(detailAfter.adoptions).toEqual(detailBefore.adoptions)
  expect(detailAfter.adoptionChecks).toEqual(detailBefore.adoptionChecks)
  expect(detailAfter.adoptionEvidence).toEqual(detailBefore.adoptionEvidence)
  expect(detailAfter.evidence).toEqual(detailBefore.evidence)
  expect(detailAfter.activity).toEqual(detailBefore.activity)
  expect(detailAfter.delivery).toEqual(detailBefore.delivery)
  expect(f.store.plan(planID)).toEqual(planBefore)
  expect(f.notifications).toHaveLength(notificationsBefore)
  expect(f.events).toEqual(eventsBefore)
  expect(sessionCalls).toEqual([{ id: attempt.session_id, options: { messages: true } }])
  expect(worktreeReads).toBe(0)
  expect(removals).toBe(0)

  const idle = structuredClone(worker)
  idle.busy = false
  f.sessions.set(attempt.session_id, idle)
  expect(await f.runtime.command(input, "observer")).toEqual(first)
  expect(sessionCalls).toHaveLength(1)
  const fresh = await f.runtime.command({ ...input, requestID: "cleanup-audit-fresh" }, "observer")
  expect(
    (fresh as { cleanupDiagnostics: { workers: Array<{ firstBlocker: unknown }> } })
      .cleanupDiagnostics.workers[0]?.firstBlocker,
  ).toBeNull()
  expect(sessionCalls).toHaveLength(2)
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cleanup-blocked")
  expect(worktreeReads).toBe(0)
  expect(removals).toBe(0)
  expect(f.notifications).toHaveLength(notificationsBefore)
})

test("cleanup audit publication rejects a concurrent plan-version change", async () => {
  const { f, planID, attempt, artifact } = await cleanupBlockedFixture()
  const version = f.store.plan(planID)!.version
  let started!: () => void
  let release!: () => void
  const sampleStarted = new Promise<void>((resolve) => (started = resolve))
  const sampleGate = new Promise<void>((resolve) => (release = resolve))
  const originalSession = f.host.session
  f.host.session = async (id, options) => {
    started()
    await sampleGate
    return originalSession(id, options)
  }
  const auditInput = {
    requestID: "cleanup-audit-stale",
    planID,
    expectedVersion: version,
    action: "audit" as const,
  }
  const pendingAudit = f.runtime.command(auditInput, "owner")
  await sampleStarted
  await f.runtime.command(
    {
      requestID: "cleanup-audit-race-integrate",
      planID,
      expectedVersion: version,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Advance the cleanup plan while diagnostics are being sampled",
    },
    "owner",
  )
  release()
  await expect(pendingAudit).rejects.toThrow(`Stale plan version; current ${version + 1}`)
  expect(f.store.plan(planID)?.state).toBe("cleaning")
  expect(
    f.store.priorCommand("cleanup-audit-stale", { command: auditInput, caller: "owner" }),
  ).toBeUndefined()
  expect(f.store.effects(planID).some((effect) => effect.kind === "worktree-remove")).toBe(true)
  expect(f.store.attempts(planID).some((item) => item.id === attempt.id)).toBe(true)
})

test("a successful cleanup diagnostic cannot bypass changed worker lineage", async () => {
  const { f, planID, attempt, worker, artifact, workspace } = await cleanupBlockedFixture()
  const idle = structuredClone(worker)
  idle.busy = false
  f.sessions.set(attempt.session_id, idle)
  const version = f.store.plan(planID)!.version
  const diagnostic = await f.runtime.command(
    {
      requestID: "cleanup-audit-clear-before-lineage-change",
      planID,
      expectedVersion: version,
      action: "audit",
    },
    "observer",
  )
  expect(
    (diagnostic as { cleanupDiagnostics: { workers: Array<{ firstBlocker: unknown }> } })
      .cleanupDiagnostics.workers[0]?.firstBlocker,
  ).toBeNull()
  const changed = structuredClone(idle)
  if (changed.turn) changed.turn.inputID = "different-after-diagnostic"
  f.sessions.set(attempt.session_id, changed)
  let removals = 0
  const originalRemove = f.host.removeWorktree
  f.host.removeWorktree = async (directory) => {
    removals++
    return originalRemove(directory)
  }
  await f.runtime.command(
    {
      requestID: "cleanup-retry-after-lineage-change",
      planID,
      expectedVersion: version,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Retry cleanup using a fresh native observation",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cleanup-blocked")
  expect(f.store.plan(planID)?.reason).toContain("worker is not conclusively idle")
  expect(existsSync(workspace)).toBe(true)
  expect(removals).toBe(0)
})

test("explicit Luna Max worker selection preserves the stronger Architect model and reaches acceptance", async () => {
  const model = { providerID: "openai", id: "gpt-6-luna", variant: "max" }
  const f = fixture({ shared: true, workerModel: model })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(JSON.parse(f.store.plan(f.receipt.planID)!.model!)).toEqual(model)
  for (const attempt of f.store.attempts(f.receipt.planID)) {
    expect(f.sessions.get(attempt.session_id)!.model).toEqual(model)
    expect(JSON.parse(attempt.policy).model).toEqual(model)
  }
  expect(f.sessions.get("owner")!.model!.id).toBe("subscription")
})

test("cleanup preserves clean worktrees with commits outside the reviewed integration", async () => {
  const f = fixture({ commit: true })
  await f.runtime.command(
    { requestID: "run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  const artifact = f.store.plan(f.receipt.planID)!.artifact!
  git(f.root, ["merge", "--ff-only", artifact])
  const worktree = f.store.attempts(f.receipt.planID)[0]!.workspace
  writeFileSync(join(worktree, "unmerged.txt"), "retain this commit")
  git(worktree, ["add", "unmerged.txt"])
  git(worktree, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Unreviewed follow-up",
  ])
  const unmerged = git(worktree, ["rev-parse", "HEAD"])
  expect(git(worktree, ["status", "--porcelain"])).toBe("")
  await f.runtime.command(
    {
      requestID: "integrate",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Reviewed accepted artifact",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cleanup-blocked")
  expect(f.store.plan(f.receipt.planID)!.reason).toContain("unmerged commits")
  expect(git(worktree, ["rev-parse", "HEAD"])).toBe(unmerged)
  expect(await f.host.worktrees()).toContain(worktree)
})

test("cleanup preserves a dirty owned worktree even after its accepted commit was merged", async () => {
  const f = fixture({ independent: true, commit: true })
  await runPlan(f)
  await drive(f.runtime)
  const artifact = f.store.plan(f.receipt.planID)!.artifact!
  git(f.root, ["merge", "--ff-only", artifact])
  const worktree = f.store.attempts(f.receipt.planID)[0]!.workspace
  writeFileSync(join(worktree, "a.txt"), "unreviewed dirty edit")

  await f.runtime.command(
    {
      requestID: "integrate-dirty",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "integrated",
      artifact,
      targetBranch: "main",
      reason: "Reviewed only the accepted combined artifact",
    },
    "owner",
  )
  await f.runtime.tick()

  expect(f.store.plan(f.receipt.planID)!.state).toBe("cleanup-blocked")
  expect(f.store.plan(f.receipt.planID)!.reason).toContain("worktree is dirty")
  expect(git(worktree, ["status", "--porcelain"])).toContain("a.txt")
  expect(await f.host.worktrees()).toContain(worktree)
})

test("priority orders conflicting plans without rejecting their overlapping scopes", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: [{ name: "a", path: "src/a.txt", scope: ["src/**"] }],
  })
  const b = f.createTask("b", "src/b.txt", ["src/**"])
  const later = f.store.submit(
    { ...f.inputFor([b], { requestID: "priority-b" }), priority: 10 },
    "owner",
  )
  await runPlan(f, f.receipt.planID, "priority-run-a")
  await runPlan(f, later.planID, "priority-run-b")
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(0)
  const attempt = f.store.attempts(later.planID)[0]!
  expect(attempt).toBeDefined()
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  const updated = await f.runtime.command(
    {
      requestID: "priority-live",
      planID: later.planID,
      expectedVersion: f.store.plan(later.planID)!.version,
      action: "schedule",
      priority: -1,
      reason: "Let another plan take precedence after this worker finishes",
    },
    "owner",
  )
  expect(updated).toMatchObject({ status: "scheduled" })
  expect(f.store.attempts(later.planID)).toHaveLength(1)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
})

test("afterPlans dispatches from combined integration while prerequisite cleanup is still pending", async () => {
  for (const expectedParentState of ["cleaning", "cleanup-blocked"] as const) {
    const f = fixture({
      independent: true,
      delayed: true,
      commit: true,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    const parentID = f.receipt.planID
    const childTask = f.createTask("b", "b.txt")
    const child = f.store.submit(
      {
        ...f.inputFor([childTask], { requestID: `dependent-${expectedParentState}` }),
        afterPlans: [parentID],
        priority: expectedParentState === "cleaning" ? 10 : -10,
      },
      "owner",
    )
    await runPlan(f, child.planID, `run-child-${expectedParentState}`)
    const accepted = await acceptPlan(f, parentID)
    expect(new TaskReads(f.repository).get({ taskID: childTask.id })).toMatchObject({
      recordedState: "queued",
      execution: {
        state: "blocked",
        reason: `Waiting for prerequisite integration: ${f.repository.referenceFor(accepted.attempt.task_id)} (accepted)`,
      },
    })
    const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
    writeFileSync(sentinel, "still owned")
    includeArtifact(f, accepted.plan.artifact!)
    await recordPlanIntegration(f, parentID, { recordTaskLanding: true })
    expect(f.store.plan(parentID)!.state).toBe("cleaning")

    const observations: { parentState: string; workspace: string; source: string }[] = []
    const originalPrompt = f.host.prompt
    f.host.prompt = async (input) => {
      const parent = f.store.plan(parentID)!
      expect(existsSync(accepted.attempt.workspace)).toBe(true)
      expect(readFileSync(sentinel, "utf8")).toBe("still owned")
      expect(input.directory).not.toBe(accepted.attempt.workspace)
      expect(readFileSync(join(input.directory, "a.txt"), "utf8")).toBe("a")
      observations.push({
        parentState: parent.state,
        workspace: input.directory,
        source: git(input.directory, ["rev-parse", "HEAD"]),
      })
      await originalPrompt(input)
    }

    await f.runtime.tick()
    expect(observations).toHaveLength(1)
    expect(observations[0]!.parentState).toBe(expectedParentState)
    expect(observations[0]!.source).toBe(accepted.plan.artifact!)
    expect(f.store.plan(parentID)!.state).toBe("cleanup-blocked")
    const childAttempt = f.store.attempts(child.planID)[0]!
    expect(childAttempt.workspace).toBe(observations[0]!.workspace)
    expect(childAttempt.workspace).not.toBe(accepted.attempt.workspace)
    expect(childAttempt.base_commit).toBe(accepted.plan.artifact!)
  }
})

test("afterPlans rejects a legacy cleanup snapshot after durable prerequisite cancellation", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { parentID, child } = await prepareAfterPlanDependency(f, "legacy-cancelled-prerequisite")
  await f.runtime.command(
    {
      requestID: "cancel-integrated-prerequisite",
      planID: parentID,
      expectedVersion: f.store.plan(parentID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(parentID)?.state).toBe("cancelled")

  // An older persisted view can still report cleanup-blocked. The durable
  // cancellation transition must invalidate its earlier acceptance/integration.
  f.store.atomic((db) => {
    db.query(
      "UPDATE runner_plans SET state='cleanup-blocked',reason=?,version=version+1 WHERE id=?",
    ).run("Legacy cleanup-blocked snapshot", parentID)
  })
  const promptsBefore = f.events.filter((event) => event.startsWith("prompt:")).length
  await f.runtime.tick()

  expect(f.store.attempts(child.planID)).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptsBefore)
})

test("afterPlans cleanup cannot publish over cancellation or reuse the historical integration proof", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { parentID, child, accepted } = await prepareAfterPlanDependency(f, "cancel-cleanup", -10)
  const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(sentinel, "still owned")
  const originalSession = f.host.session
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.session = async (id, options) => {
    if (id === accepted.attempt.session_id && options?.messages) {
      enter()
      await blocked
    }
    return originalSession(id, options)
  }

  const cleanup = f.runtime.tick()
  await entered
  await f.runtime.command(
    {
      requestID: "cancel-during-cleanup",
      planID: parentID,
      expectedVersion: f.store.plan(parentID)!.version,
      action: "cancel",
    },
    "owner",
  )
  release()
  await cleanup

  expect(f.store.plan(parentID)?.state).toBe("cancelling")
  expect(f.store.plan(parentID)?.artifact).toBe(accepted.plan.artifact)
  expect(
    f.store.latestTransition<{ artifact?: string }>(parentID, null, "INTEGRATION_RECORDED")
      ?.artifact,
  ).toBe(accepted.plan.artifact!)
  expect(f.store.attempts(child.planID)).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(existsSync(accepted.attempt.workspace)).toBe(true)
  expect(readFileSync(sentinel, "utf8")).toBe("still owned")
  expect(await f.host.worktrees()).toContain(accepted.attempt.workspace)

  await f.runtime.tick()
  expect(f.store.plan(parentID)?.state).toBe("cancelled")
  expect(f.store.attempts(child.planID)).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test("afterPlans invalidation during child worktree creation keeps the owned workspace and suppresses prompt admission", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { parentID, child, accepted } = await prepareAfterPlanDependency(f, "cancel-worktree")
  const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(sentinel, "still owned")
  const originalWorktree = f.host.worktree
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.worktree = async (input) => {
    if (input.base === accepted.plan.artifact) {
      enter()
      await blocked
    }
    return originalWorktree(input)
  }

  const dispatch = f.runtime.tick()
  await entered
  await f.runtime.command(
    {
      requestID: "cancel-parent-during-child-worktree",
      planID: parentID,
      expectedVersion: f.store.plan(parentID)!.version,
      action: "cancel",
    },
    "owner",
  )
  release()
  await dispatch

  const attempt = f.store.attempts(child.planID)[0]!
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(attempt.state).toBe("preparing")
  expect(attempt.base_commit).toBe(accepted.plan.artifact!)
  expect(existsSync(attempt.workspace)).toBe(true)
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "worktree")?.state).toBe(
    "completed",
  )
  expect(f.store.effects(child.planID).some((effect) => effect.kind === "session")).toBe(false)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(readFileSync(sentinel, "utf8")).toBe("still owned")
  expect(await f.host.worktrees()).toContain(accepted.attempt.workspace)
  expect(await f.host.worktrees()).toContain(attempt.workspace)

  await drive(f.runtime, 2)
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(existsSync(attempt.workspace)).toBe(true)
})

test("cancelling a child during session creation prevents prompt intent and preserves owned resources", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { child, accepted } = await prepareAfterPlanDependency(f, "cancel-session")
  const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(sentinel, "still owned")
  const originalCreate = f.host.create
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.create = async (input) => {
    enter()
    await blocked
    await originalCreate(input)
  }

  const preparation = f.runtime.tick()
  await entered
  await f.runtime.command(
    {
      requestID: "cancel-child-during-session-create",
      planID: child.planID,
      expectedVersion: f.store.plan(child.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  release()
  await preparation

  const attempt = f.store.attempts(child.planID)[0]!
  expect(f.store.plan(child.planID)?.state).toBe("cancelling")
  expect(attempt.state).toBe("preparing")
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "session")?.state).toBe(
    "completed",
  )
  expect(f.store.effects(child.planID).some((effect) => effect.kind === "prompt")).toBe(false)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(existsSync(attempt.workspace)).toBe(true)
  expect(f.sessions.has(attempt.session_id)).toBe(true)
  expect(readFileSync(sentinel, "utf8")).toBe("still owned")

  await f.runtime.tick()
  expect(f.store.plan(child.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(existsSync(attempt.workspace)).toBe(true)
})

test("afterPlans invalidation during retained preparation reconciliation blocks the later prompt", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { parentID, child, accepted } = await prepareAfterPlanDependency(f, "cancel-reconcile")
  const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(sentinel, "still owned")
  const originalCreate = f.host.create
  let createCalls = 0
  f.host.create = async (input) => {
    createCalls++
    await originalCreate(input)
    throw new Error("session creation reply lost")
  }
  await f.runtime.tick()
  const attempt = f.store.attempts(child.planID)[0]!
  expect(f.store.plan(parentID)?.state).toBe("cleanup-blocked")
  expect(f.store.plan(child.planID)?.state).toBe("blocked")
  expect(attempt.state).toBe("preparing")
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "session")?.state).toBe(
    "uncertain",
  )
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)

  const originalSession = f.host.session
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.session = async (id, options) => {
    if (id === attempt.session_id && !options?.messages) {
      enter()
      await blocked
    }
    return originalSession(id, options)
  }
  const reconciliation = f.runtime.tick()
  await entered
  // Model a legacy cleanup-blocked snapshot after a newer durable cancellation
  // invalidation while the retained effect is read.
  f.store.atomic((db) => {
    db.query(
      "UPDATE runner_plans SET state='cleanup-blocked',reason=?,version=version+1 WHERE id=?",
    ).run("Legacy cleanup snapshot after cancellation", parentID)
    f.store.record(parentID, null, "CANCEL_REQUESTED", {
      caller: "owner",
      phase: "retained-preparation-reconciliation",
    })
  })
  release()
  await reconciliation
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "session")?.state).toBe(
    "completed",
  )
  expect(createCalls).toBe(1)

  await f.runtime.command(
    {
      requestID: "resume-retained-child",
      planID: child.planID,
      expectedVersion: f.store.plan(child.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await f.runtime.tick()

  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(f.store.attempts(child.planID)[0]?.state).toBe("preparing")
  expect(f.store.effects(child.planID).some((effect) => effect.kind === "prompt")).toBe(false)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(existsSync(attempt.workspace)).toBe(true)
  expect(f.sessions.has(attempt.session_id)).toBe(true)
  expect(readFileSync(sentinel, "utf8")).toBe("still owned")
})

test("afterPlans dispatches after genuine combined-check recovery while preserving failed receipts", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    requireVerifierPreparation: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const parentID = f.receipt.planID
  const childTask = f.createTask("b", "b.txt")
  const child = f.store.submit(
    {
      ...f.inputFor([childTask], { requestID: "recovered-child" }),
      afterPlans: [parentID],
      priority: 10,
    },
    "owner",
  )
  await runPlan(f, child.planID, "run-recovered-child")
  await runPlan(f, parentID, "run-recovered-parent")
  await f.runtime.tick()
  const parentAttempt = f.store.attempts(parentID)[0]!
  f.completeWorker(parentAttempt.session_id)
  await drive(f.runtime, 6)

  expect(f.store.plan(parentID)?.state).toBe("blocked")
  expect(f.store.attempts(child.planID)).toHaveLength(0)
  const failedReceipt = f.store
    .effects(parentID)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(failedReceipt.receipt!).check.exitCode).not.toBe(0)
  const failedReceiptSnapshot = [failedReceipt.id, failedReceipt.state, failedReceipt.receipt]

  writeFileSync(join(dirname(f.repository.path), "verifier-ready"), "repaired environment")
  await f.runtime.command(
    {
      requestID: "reconcile-genuine-parent",
      planID: parentID,
      expectedVersion: f.store.plan(parentID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 6)
  const accepted = f.store.plan(parentID)!
  expect(accepted.state).toBe("accepted")
  const recoveredArtifact = accepted.artifact
  if (!recoveredArtifact) throw new Error("Expected genuine combined acceptance artifact")
  const acceptedTransition = f.store.latestTransition<{ artifact: string; checks: CheckReceipt[] }>(
    parentID,
    null,
    "PLAN_ACCEPTED",
  )!
  expect(acceptedTransition.artifact).toBe(recoveredArtifact)
  expect(acceptedTransition.checks.every((check) => check.exitCode === 0)).toBe(true)
  expect(f.store.effects(parentID).find((effect) => effect.id === failedReceipt.id)).toMatchObject({
    id: failedReceiptSnapshot[0],
    state: failedReceiptSnapshot[1],
    receipt: failedReceiptSnapshot[2],
  })

  includeArtifact(f, recoveredArtifact)
  await recordPlanIntegration(f, parentID)
  const parentSentinel = join(parentAttempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(parentSentinel, "still owned")
  await f.runtime.tick()

  expect(f.store.plan(parentID)?.state).toBe("cleanup-blocked")
  const childAttempt = f.store.attempts(child.planID)[0]!
  expect(childAttempt.state).toBe("running")
  expect(childAttempt.base_commit).toBe(recoveredArtifact)
  expect(readFileSync(join(childAttempt.workspace, "a.txt"), "utf8")).toBe("a")
  expect(readFileSync(parentSentinel, "utf8")).toBe("still owned")
  expect(f.events.some((event) => event.startsWith("prompt:"))).toBe(true)
  expect(f.store.effects(parentID).find((effect) => effect.id === failedReceipt.id)).toMatchObject({
    id: failedReceiptSnapshot[0],
    state: failedReceiptSnapshot[1],
    receipt: failedReceiptSnapshot[2],
  })
})

test("afterPlans rejects task-only, missing, malformed, mismatched and foreign integration evidence", async () => {
  for (const invalidation of [
    "missing",
    "task-only",
    "malformed",
    "artifact-mismatch",
    "foreign-prerequisite",
  ] as const) {
    const f = fixture({
      independent: true,
      delayed: true,
      commit: true,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    const parentID = f.receipt.planID
    const childTask = f.createTask("b", "b.txt")
    const child = f.store.submit(
      {
        ...f.inputFor([childTask], { requestID: `invalid-${invalidation}` }),
        afterPlans: [parentID],
        priority: 10,
      },
      "owner",
    )
    await runPlan(f, child.planID, `run-invalid-${invalidation}`)
    const accepted = await acceptPlan(f, parentID)
    includeArtifact(f, accepted.plan.artifact!)

    if (invalidation === "task-only") {
      const node = f.store.nodes(parentID)[0]!
      await f.runtime.command(
        {
          requestID: `task-only-${parentID}`,
          planID: parentID,
          expectedVersion: f.store.plan(parentID)!.version,
          action: "integrated",
          taskID: node.task_id,
          artifact: node.artifact!,
          targetBranch: "main",
          reason: "Record task landing without combined plan integration",
        },
        "owner",
      )
    } else await recordPlanIntegration(f, parentID)

    f.store.atomic((db) => {
      if (invalidation === "missing")
        db.query(
          "DELETE FROM runner_transitions WHERE plan_id=? AND task_id IS NULL AND event='INTEGRATION_RECORDED'",
        ).run(parentID)
      if (invalidation === "malformed" || invalidation === "artifact-mismatch") {
        const receipt = db
          .query<{ id: number; payload: string }, [string]>(
            "SELECT id,payload FROM runner_transitions WHERE plan_id=? AND task_id IS NULL AND event='INTEGRATION_RECORDED' ORDER BY id DESC LIMIT 1",
          )
          .get(parentID)
        if (receipt && invalidation === "malformed")
          db.query("UPDATE runner_transitions SET payload=? WHERE id=?").run("{broken", receipt.id)
        else if (receipt) {
          const payload = JSON.parse(receipt.payload) as Record<string, unknown>
          payload.artifact = f.base
          db.query("UPDATE runner_transitions SET payload=? WHERE id=?").run(
            JSON.stringify(payload),
            receipt.id,
          )
        }
      }
      if (invalidation === "foreign-prerequisite") {
        const body = JSON.parse(f.store.plan(child.planID)!.body) as Record<string, unknown>
        body.afterPlans = [crypto.randomUUID()]
        db.query("UPDATE runner_plans SET body=? WHERE id=?").run(
          JSON.stringify(body),
          child.planID,
        )
      }
      // A lifecycle label cannot stand in for a combined integration receipt.
      db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(parentID)
    })
    const promptsBefore = f.events.filter((event) => event.startsWith("prompt:")).length
    await f.runtime.tick()
    expect(f.store.attempts(child.planID)).toHaveLength(0)
    expect(f.events.filter((event) => event.startsWith("prompt:")).length).toBe(promptsBefore)
  }
})

test("afterPlans requires both the integrated artifact and its recorded integration head in selected HEAD", async () => {
  for (const missingSource of ["integration-head", "artifact"] as const) {
    const f = fixture({
      independent: true,
      delayed: true,
      commit: true,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    const parentID = f.receipt.planID
    const childTask = f.createTask("b", "b.txt")
    const child = f.store.submit(
      {
        ...f.inputFor([childTask], { requestID: `missing-${missingSource}` }),
        afterPlans: [parentID],
        priority: 10,
      },
      "owner",
    )
    await runPlan(f, child.planID, `run-missing-${missingSource}`)
    const accepted = await acceptPlan(f, parentID)
    includeArtifact(f, accepted.plan.artifact!)
    if (missingSource === "integration-head") {
      writeFileSync(join(f.root, "after-integration.txt"), "later baseline\n")
      git(f.root, ["add", "after-integration.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "later selected baseline",
      ])
    }
    await recordPlanIntegration(f, parentID)
    git(f.root, [
      "reset",
      "--hard",
      missingSource === "artifact" ? f.base : accepted.plan.artifact!,
    ])
    f.store.atomic((db) =>
      db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(parentID),
    )

    await expect(f.runtime.tick()).resolves.toBeUndefined()
    expect(f.store.attempts(child.planID)).toHaveLength(0)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  }
})

test("every afterPlans prerequisite needs genuine fresh acceptance and integration after cancellation", async () => {
  const f = fixture({ independent: true, delayed: true, commit: true, startOnly: true })
  const parentA = f.store.submit(f.inputFor([f.tasks[0]!], { requestID: "parent-a" }), "owner")
  const parentB = f.store.submit(f.inputFor([f.tasks[1]!], { requestID: "parent-b" }), "owner")
  const childTask = f.createTask("c", "c.txt")
  const child = f.store.submit(
    {
      ...f.inputFor([childTask], { requestID: "all-prerequisites" }),
      afterPlans: [parentA.planID, parentB.planID],
      priority: 10,
    },
    "owner",
  )
  await runPlan(f, child.planID, "run-all-prerequisites")
  await acceptAndIntegratePlan(f, parentA.planID)
  await acceptAndIntegratePlan(f, parentB.planID)

  const beforeCancel = f.store.plan(parentB.planID)!
  await f.runtime.command(
    {
      requestID: "cancel-integrated-parent",
      planID: parentB.planID,
      expectedVersion: beforeCancel.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(parentB.planID)!.state).toBe("cancelled")
  expect(f.store.attempts(child.planID)).toHaveLength(0)
  const transitionID = (event: string) =>
    f.store.atomic(
      (db) =>
        db
          .query<{ id: number }, [string, string]>(
            "SELECT id FROM runner_transitions WHERE plan_id=? AND task_id IS NULL AND event=? ORDER BY id DESC LIMIT 1",
          )
          .get(parentB.planID, event)?.id ?? 0,
    )
  const cancellationID = transitionID("CANCEL_REQUESTED")

  f.store.atomic((db) => {
    db.query(
      "UPDATE runner_plans SET state='cleanup-blocked',reason=?,version=version+1 WHERE id=?",
    ).run("Legacy cleanup snapshot after cancellation", parentB.planID)
  })
  await f.runtime.tick()
  expect(f.store.attempts(child.planID)).toHaveLength(0)

  // Re-enter explicit reconciliation from a recovered blocked snapshot. The
  // runtime must produce new combined-check evidence before dependent work resumes.
  f.store.atomic((db) => {
    db.query("UPDATE runner_plans SET state='blocked',reason=?,version=version+1 WHERE id=?").run(
      "Recovered prerequisite requires fresh verification",
      parentB.planID,
    )
  })
  await f.runtime.command(
    {
      requestID: "reconcile-cancelled-prerequisite",
      planID: parentB.planID,
      expectedVersion: f.store.plan(parentB.planID)!.version,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 6)
  const refreshed = f.store.plan(parentB.planID)!
  expect(refreshed.state).toBe("accepted")
  const refreshedArtifact = refreshed.artifact
  if (!refreshedArtifact) throw new Error("Expected refreshed prerequisite artifact")
  const accepted = f.store.latestTransition<{ artifact: string; checks: CheckReceipt[] }>(
    parentB.planID,
    null,
    "PLAN_ACCEPTED",
  )!
  expect(accepted.artifact).toBe(refreshedArtifact)
  expect(accepted.checks.length).toBeGreaterThan(0)
  expect(accepted.checks.every((check) => check.exitCode === 0 && !check.timedOut)).toBe(true)
  const acceptanceID = transitionID("PLAN_ACCEPTED")
  expect(acceptanceID).toBeGreaterThan(cancellationID)
  includeArtifact(f, refreshedArtifact)
  await f.runtime.command(
    {
      requestID: "fresh-integrated-parent-after-reacceptance",
      planID: parentB.planID,
      expectedVersion: refreshed.version,
      action: "integrated",
      artifact: refreshedArtifact,
      targetBranch: "main",
      reason: "Review the freshly verified combined source after cancellation recovery",
    },
    "owner",
  )
  expect(transitionID("INTEGRATION_RECORDED")).toBeGreaterThan(acceptanceID)
  await f.runtime.tick()
  const childAttempt = f.store.attempts(child.planID)[0]!
  expect(childAttempt).toBeDefined()
  const integration = f.store.latestTransition<{ head: string }>(
    parentB.planID,
    null,
    "INTEGRATION_RECORDED",
  )
  if (!integration?.head) throw new Error("Expected refreshed prerequisite integration head")
  expect(childAttempt.base_commit).toBe(integration.head)
  expect(git(childAttempt.workspace, ["rev-parse", "HEAD"])).not.toBe(childAttempt.base_commit)
  expect(readFileSync(join(childAttempt.workspace, "a.txt"), "utf8")).toBe("a")
  expect(readFileSync(join(childAttempt.workspace, "b.txt"), "utf8")).toBe("b")
})

test("valid afterPlans integration does not bypass shared-checkout admission", async () => {
  const f = fixture({
    shared: true,
    independent: true,
    delayed: true,
    commit: true,
    startOnly: true,
    taskFiles: [
      { name: "a", path: "a.txt" },
      { name: "b", path: "b.txt" },
      { name: "c", path: "c.txt" },
    ],
  })
  const prerequisite = f.store.submit(
    f.inputFor([f.tasks[0]!], { requestID: "shared-parent" }),
    "owner",
  )
  const blocker = f.store.submit(
    f.inputFor([f.tasks[1]!], { requestID: "shared-blocker" }),
    "owner",
  )
  const dependent = f.store.submit(
    {
      ...f.inputFor([f.tasks[2]!], { requestID: "shared-dependent" }),
      afterPlans: [prerequisite.planID],
    },
    "owner",
  )
  await acceptAndIntegratePlan(f, prerequisite.planID)
  await runPlan(f, blocker.planID, "run-shared-blocker")
  await runPlan(f, dependent.planID, "run-shared-dependent")
  await f.runtime.tick()
  expect(f.store.attempts(blocker.planID)).toHaveLength(1)
  expect(f.store.attempts(dependent.planID)).toHaveLength(0)
})

test("cross-plan dependencies wait for integration and dispatch from the integrated source", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const b = f.createTask("b", "b.txt")
  const dependent = f.store.submit(
    {
      ...f.inputFor([b], { requestID: "dependent-b" }),
      afterPlans: [f.receipt.planID],
      priority: 10,
    },
    "owner",
  )
  await runPlan(f, dependent.planID, "dependency-run-b")
  await runPlan(f, f.receipt.planID, "dependency-run-a")
  await f.runtime.tick()
  expect(f.store.attempts(dependent.planID)).toHaveLength(0)
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(f.store.attempts(dependent.planID)).toHaveLength(0)
  const accepted = f.store.plan(f.receipt.planID)!
  git(f.root, ["merge", "--ff-only", accepted.artifact!])
  await f.runtime.command(
    {
      requestID: "dependency-integrated",
      planID: accepted.id,
      expectedVersion: accepted.version,
      action: "integrated",
      artifact: accepted.artifact!,
      targetBranch: "main",
      reason: "Reviewed the result and merged it",
    },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(accepted.id)!.reason).toBeNull()
  expect(f.store.plan(accepted.id)!.state).toBe("integrated")
  const next = f.store.attempts(dependent.planID)[0]!
  expect(next.base_commit).toBe(accepted.artifact!)
  expect(readFileSync(join(next.workspace, "a.txt"), "utf8")).toBe("a")
})

test("schedule updates are versioned, retry-safe and reject dependency cycles or foreign plans", async () => {
  const f = fixture({ startOnly: true, independent: true })
  const a = f.store.submit(f.inputFor([f.tasks[0]!], { requestID: "schedule-a" }), "owner")
  const b = f.store.submit(
    { ...f.inputFor([f.tasks[1]!], { requestID: "schedule-b" }), afterPlans: [a.planID] },
    "owner",
  )
  const original = f.store.plan(a.planID)!
  await expect(
    f.runtime.command(
      {
        requestID: "schedule-cycle",
        planID: a.planID,
        expectedVersion: original.version,
        action: "schedule",
        afterPlans: [b.planID],
        reason: "Invalid cycle",
      },
      "owner",
    ),
  ).rejects.toThrow("cycle")
  await expect(
    f.runtime.command(
      {
        requestID: "schedule-foreign",
        planID: a.planID,
        expectedVersion: original.version,
        action: "schedule",
        afterPlans: [crypto.randomUUID()],
        reason: "Unknown project plan",
      },
      "owner",
    ),
  ).rejects.toThrow("foreign")
  expect(f.store.plan(a.planID)!.body).toBe(original.body)
  const command = {
    requestID: "schedule-valid",
    planID: b.planID,
    expectedVersion: b.version,
    action: "schedule",
    priority: 5,
    afterPlans: [],
    baseCommit: f.base,
    reason: "Independent work can start immediately",
  }
  const first = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(first)
  expect(f.store.plan(b.planID)!.revision).toBe(2)
  const history = f.store.atomic((db) =>
    db
      .query<{ body: string }, [string]>(
        "SELECT body FROM runner_plan_revisions WHERE plan_id=? ORDER BY revision",
      )
      .all(b.planID),
  )
  expect(history).toHaveLength(2)
  expect(JSON.parse(history[0]!.body).afterPlans).toEqual([a.planID])
  expect(JSON.parse(history[1]!.body)).toMatchObject({ priority: 5, afterPlans: [] })
})

test("runtime shutdown joins an in-flight native operation before storage may close", async () => {
  const f = fixture({ delayed: true })
  await runPlan(f)
  const original = f.host.session
  let entered!: () => void
  let release!: () => void
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.session = async (id) => {
    entered()
    await blocked
    return original(id)
  }
  const tick = f.runtime.tick()
  await entering
  let stopped = false
  const stopping = f.runtime.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  release()
  await tick
  await stopping
  expect(stopped).toBe(true)
  const attempts = f.store.attempts(f.receipt.planID).length
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(attempts)
})

test("heartbeat avoids context and rechecks a stopped worker after detailed accounting", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const original = f.host.session
  const calls: { id: string; messages: boolean }[] = []
  let firstFinalRead = true
  f.host.session = async (id, options) => {
    calls.push({ id, messages: options?.messages === true })
    const session = await original(id, options)
    if (session && options?.messages) {
      session.tools = 9
      if (id === attempt.session_id && firstFinalRead) {
        firstFinalRead = false
        session.busy = true
        session.outcome = undefined
      }
    }
    return session
  }

  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  await f.runtime.tick()
  expect(calls.find((call) => call.id === attempt.session_id)?.messages).toBe(false)
  expect(calls.some((call) => call.id === attempt.session_id && call.messages)).toBe(true)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")

  await settleVerification(f.runtime)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)[0]!.tool_count).toBe(9)
})

test.each(["interrupted", "succeeded", "missing"] as const)(
  "cancellation wins over a stale %s detailed worker observation",
  async (result) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await f.runtime.tick()
    const planID = f.receipt.planID
    const attempt = f.store.attempts(planID)[0]!
    const worker = f.sessions.get(attempt.session_id)!
    worker.busy = false
    worker.outcome = result === "succeeded" ? "succeeded" : "interrupted"
    worker.turn = { inputID: attempt.message_id, state: "interrupted" }
    // A succeeded session reaches detailed proof only after the fresh background
    // prerequisite clears. Interrupted/missing cases still exercise unknown idle.
    worker.background =
      result === "succeeded"
        ? {
            state: "observed",
            source: "experimental.idle",
            observedAt: Date.now(),
            inputID: attempt.message_id,
            executionStartSequence: 2,
            eventSequence: 3,
            count: 0,
            kinds: { shell: 0, subagent: 0, image: 0 },
          }
        : {
            state: "unknown",
            source: "experimental.idle",
            reason: "Host restarted before observing an idle report",
          }
    const originalSession = f.host.session
    let raced = false
    f.host.session = async (id, options) => {
      const snapshot = await originalSession(id, options)
      if (id === worker.id && options?.messages && !raced) {
        raced = true
        await f.runtime.command(
          {
            requestID: `cancel-during-${result}-detail`,
            planID,
            expectedVersion: f.store.plan(planID)!.version,
            action: "cancel",
          },
          "owner",
        )
        return result === "missing" ? null : snapshot
      }
      return snapshot
    }

    const prompts = f.events.filter((event) => event.startsWith("prompt:")).length
    await f.runtime.tick()
    expect(raced).toBe(true)
    expect(f.store.plan(planID)?.state).toBe("cancelled")
    expect(f.store.attempts(planID)).toHaveLength(1)
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: attempt.id,
      state: "cancelled",
      session_id: attempt.session_id,
      workspace: attempt.workspace,
    })
    expect(existsSync(attempt.workspace)).toBe(true)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(prompts)
    expect(f.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(false)
  },
)

test("terminal verification waits for active foreground, exact input completion, and background settlement", async () => {
  const f = fixture({ delayed: true, repair: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalSession = f.host.session
  const baseHead = git(f.root, ["rev-parse", "HEAD"])

  // A stale succeeded value after prompt admission cannot outrank the current native handle.
  worker.outcome = "succeeded"
  worker.turn = { inputID: "msg_historical", state: "completed" }
  expect(worker.busy).toBe(true)
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(baseHead)

  // The foreground becomes active after the quiet heartbeat but during the detail read.
  worker.busy = false
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: attempt.message_id,
    executionStartSequence: 2,
    eventSequence: 3,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  let raced = false
  f.host.session = async (id, options) => {
    const session = await originalSession(id, options)
    if (id === attempt.session_id && options?.messages && !raced && session) {
      raced = true
      worker.busy = true
      return { ...session, busy: true, observationUnstable: true, outcome: "succeeded" }
    }
    return session
  }
  await f.runtime.tick()
  expect(raced).toBe(true)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(baseHead)

  f.host.session = originalSession
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "pending" }
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)

  worker.turn = { inputID: attempt.message_id, state: "completed" }
  let blockedDetailReads = 0
  f.host.session = async (id, options) => {
    if (id === attempt.session_id && options?.messages) blockedDetailReads++
    return originalSession(id, options)
  }
  worker.background = {
    state: "unknown",
    source: "experimental.idle",
    reason: "native idle signal was lost",
  }
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(f.store.plan(f.receipt.planID)?.reason).toContain("background observation is unknown")
  // Capture the current terminal assignment once for an explicit correction,
  // then keep unchanged background holds on the lightweight read path.
  expect(blockedDetailReads).toBe(1)
  await f.runtime.tick()
  expect(blockedDetailReads).toBe(1)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(baseHead)

  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: attempt.message_id,
    executionStartSequence: 2,
    eventSequence: 3,
    count: 2,
    kinds: { shell: 1, subagent: 1, image: 0 },
  }
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(baseHead)
  const backgroundWait = f.store.latestTransition<{ background: HostBackgroundObservation }>(
    f.receipt.planID,
    attempt.task_id,
    "WORKER_BACKGROUND_WAIT",
  )
  expect(backgroundWait?.background).toMatchObject({
    state: "observed",
    count: 2,
    kinds: { shell: 1, subagent: 1 },
  })
  expect(blockedDetailReads).toBe(1)

  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: attempt.message_id,
    executionStartSequence: 2,
    eventSequence: 3,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  await settleVerification(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(blockedDetailReads).toBeGreaterThan(0)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(true)
})

test.each(["failed", "interrupted"] as const)(
  "background hold avoids repeated context for %s while preserving interruption evidence",
  async (outcome) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await f.runtime.tick()
    const attempt = f.store.attempts(f.receipt.planID)[0]!
    const worker = f.sessions.get(attempt.session_id)!
    worker.busy = false
    worker.outcome = outcome
    worker.idleAt = 1234
    worker.background = {
      state: "unknown",
      source: "experimental.idle",
      reason: "retained execution has no conclusive idle evidence",
    }
    const original = f.host.session
    let freshReads = 0
    let detailedReads = 0
    f.host.session = async (id, options) => {
      if (id === attempt.session_id) {
        if (options?.messages) detailedReads++
        else freshReads++
      }
      return original(id, options)
    }
    await f.runtime.tick()
    await f.runtime.tick()
    expect(freshReads).toBe(2)
    expect(detailedReads).toBe(outcome === "interrupted" ? 2 : 1)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
    ).toBe(false)
    const stopped = f.store.latestTransition<{ outcome: string }>(
      f.receipt.planID,
      attempt.task_id,
      "WORKER_STOPPED",
    )
    expect(stopped?.outcome).toBe(outcome)
  },
)

test("worker-location permissions and forms block terminal work and surface actionable diagnostics", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.pendingPermissions = 1
  worker.pendingForms = 1

  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.plan(planID)?.reason).toContain(`Worker at ${worker.directory}`)
  expect(f.store.plan(planID)?.reason).toContain("1 pending permission request(s)")
  expect(f.store.plan(planID)?.reason).toContain("1 pending form(s)")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("running")
  expect(f.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(false)
  expect(
    f.store.latestTransition<{
      workspace: string
      directory: string
      pendingPermissions: number
      pendingForms: number
    }>(planID, attempt.task_id, "WORKER_APPROVAL_WAIT"),
  ).toMatchObject({
    workspace: attempt.workspace,
    directory: worker.directory,
    pendingPermissions: 1,
    pendingForms: 1,
  })

  worker.pendingPermissions = 0
  worker.pendingForms = 0
  await settleVerification(f.runtime)
  expect(f.store.plan(planID)?.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
})

test("a durably admitted same-attempt handoff reminder can finish with fresh matching evidence", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const claim = f.runtime.progress.claimReminder(
    attempt.session_id,
    "Provide the remaining handoff",
    "msg_owned_final_handoff",
  )!
  expect(claim).toBeDefined()
  f.runtime.progress.finishReminder(claim, "admitted")
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: claim.messageID, state: "completed" }
  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: claim.messageID,
    executionStartSequence: 10,
    eventSequence: 11,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  await drive(f.runtime, 10)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test("a verifying attempt reconciles its actual review input and resumes the same worker for correction", async () => {
  const { f, attempt, reviewInputID } = await heldReviewInputFixture()
  const planID = f.receipt.planID
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='verifying' WHERE id=?").run(attempt.id)
    db.query("UPDATE runner_nodes SET state='verifying' WHERE plan_id=? AND task_id=?").run(
      planID,
      attempt.task_id,
    )
  })
  const effects = f.store.effects(planID)
  const reconciled = await f.runtime.command(reviewInputCommand(f, attempt, reviewInputID), "owner")
  expect(reconciled).toMatchObject({ relationshipRecorded: true })
  expect(f.store.attempts(planID)[0]!.state).toBe("verifying")
  f.store.atomic((db) =>
    db
      .query(
        "UPDATE runner_plans SET state='blocked',reason='Review found a concrete defect' WHERE id=?",
      )
      .run(planID),
  )
  const command = {
    requestID: "resume-verifying-for-real-correction",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
    action: "resume" as const,
    taskID: attempt.task_id,
    attemptID: attempt.id,
    reason: "Correct the defect found during verification in the same worker",
  }
  expect(await f.runtime.command(command, "owner")).toMatchObject({ status: "resuming" })
  const resumed = f.store.attempts(planID)[0]!
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(resumed).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
    workspace: attempt.workspace,
    policy: attempt.policy,
    state: "preparing",
  })
  expect(resumed.message_id).not.toBe(attempt.message_id)
  expect(f.store.effects(planID)).toEqual(effects)
  expect(f.store.nodes(planID)[0]!.state).toBe("running")
  expect(await f.runtime.command(command, "owner")).toMatchObject({ status: "resuming" })
  expect(f.store.attempts(planID)[0]!.message_id).toBe(resumed.message_id)
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
})

test("owner reconciliation binds an observed review input without replacing the assignment", async () => {
  const {
    f,
    attempt: initialAttempt,
    worker,
    reviewInputID,
    reviewRequestID,
  } = await heldReviewInputFixture()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  expect(attempt.id).toBe(initialAttempt.id)
  const originalAssignment = {
    id: attempt.id,
    session_id: attempt.session_id,
    message_id: attempt.message_id,
    workspace: attempt.workspace,
    base_commit: attempt.base_commit,
    policy: attempt.policy,
    token_count: attempt.token_count,
    tool_count: attempt.tool_count,
    cost: attempt.cost,
  }
  const promptCount = f.events.filter((event) => event.startsWith("prompt:")).length
  const command = reviewInputCommand(f, attempt, reviewInputID)

  const first = await f.runtime.command(command, "owner")
  expect(first).toMatchObject({
    status: "reconciling",
    reviewInputID,
    relationshipRecorded: true,
  })
  expect(f.store.plan(f.receipt.planID)?.state).toBe("running")
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject(originalAssignment)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:")).length).toBe(1)
  expect(f.events.filter((event) => event.startsWith("prompt:")).length).toBe(promptCount)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)

  const alias = f.store.latestTransition<{
    source: string
    runtimeSentMessage: boolean
    projectDirectory: string
    projectID: string
    planID: string
    taskID: string
    attemptID: string
    sessionID: string
    workspace: string
    assignedMessageID: string
    reviewInputID: string
    reviewRequestID: string
    commandRequestID: string
    input: Record<string, unknown>
    observation: { inputID: string; turnState: string; idle: Record<string, unknown> }
  }>(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED")!
  expect(alias).toMatchObject({
    source: "observed-native-review-input",
    runtimeSentMessage: false,
    projectDirectory: f.root,
    projectID: "project",
    planID: f.receipt.planID,
    taskID: attempt.task_id,
    attemptID: attempt.id,
    sessionID: attempt.session_id,
    workspace: attempt.workspace,
    assignedMessageID: attempt.message_id,
    reviewInputID,
    reviewRequestID,
    commandRequestID: command.requestID,
    input: {
      type: "synthetic",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      requestID: reviewRequestID,
    },
    observation: {
      outcome: "succeeded",
      inputID: reviewInputID,
      turnState: "completed",
      idle: {
        inputID: reviewInputID,
        count: 0,
        terminalSequence: 12,
        terminalEventID: "event_review_success",
        terminalMessageID: "msg_review_terminal",
      },
    },
  })
  expect(alias.input).not.toHaveProperty("delivery")
  expect(alias.input).not.toHaveProperty("resume")
  const parsedAlias = parseReviewInputAlias(alias)
  expect(parsedAlias).toBeDefined()
  for (const sequence of ["executionStartSequence", "eventSequence", "terminalSequence"] as const) {
    const malformed = structuredClone(alias) as typeof alias
    ;(malformed.observation.idle as Record<string, unknown>)[sequence] = -1
    expect(parseReviewInputAlias(malformed)).toBeUndefined()
  }
  expect(
    matchesReviewInputAlias(parsedAlias!, {
      projectDirectory: f.root,
      projectID: "project",
      planID: f.receipt.planID,
      taskID: attempt.task_id,
      attemptID: attempt.id,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      assignedMessageID: attempt.message_id,
      reviewInputID,
    }),
  ).toBe(true)
  expect(worker.messages.find((message) => message.id === reviewInputID)?.metadata).toEqual({
    lazersReview: {
      taskID: attempt.task_id,
      attemptID: attempt.id,
      requestID: reviewRequestID,
    },
  })

  expect(await f.runtime.command(command, "owner")).toEqual(first)
  const replay = await f.runtime.command(
    reviewInputCommand(f, attempt, reviewInputID, "reconcile-review-steer-duplicate"),
    "owner",
  )
  expect(replay).toMatchObject({ relationshipRecorded: false, reviewInputID })
  const aliasCount = f.store.atomic(
    (db) =>
      db
        .query<{ count: number }, [string, string]>(
          "SELECT count(*) AS count FROM runner_transitions WHERE plan_id=? AND task_id=? AND event='WORKER_REVIEW_INPUT_RECONCILED'",
        )
        .get(f.receipt.planID, attempt.task_id)!.count,
  )
  expect(aliasCount).toBe(1)

  const reopened = new TaskRuntime(f.store, f.host, "project")
  cleanup.push(() => reopened.stop())
  expireRunnerLease(f)
  await drive(reopened, 6)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject(originalAssignment)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:")).length).toBe(promptCount)
  expect(f.store.effects(f.receipt.planID).some((effect) => effect.kind === "verify:content")).toBe(
    true,
  )
})

test("review input identity accepts unrelated additive native message metadata", async () => {
  const { f, attempt, worker, reviewInputID } = await heldReviewInputFixture()
  worker.messages.find((message) => message.id === reviewInputID)!.metadata!.trace = "native-note"
  const result = await f.runtime.command(
    reviewInputCommand(f, attempt, reviewInputID, "review-input-extra-metadata"),
    "owner",
  )
  expect(result).toMatchObject({ status: "reconciling", relationshipRecorded: true })
  expect(
    f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
  ).toBeDefined()
})

test.each(["OWNER_CONTINUED", "OWNER_REASSIGNED"] as const)(
  "an admitted review-input alias survives later %s with the original worker assignment",
  async (ownerEvent) => {
    const { f, attempt, worker, reviewInputID } = await heldReviewInputFixture()
    await f.runtime.command(
      reviewInputCommand(f, attempt, reviewInputID, `review-before-${ownerEvent}`),
      "owner",
    )
    const nextOwner: HostSession = {
      ...structuredClone(f.sessions.get("owner")!),
      id: `next-${ownerEvent.toLowerCase()}`,
    }
    f.sessions.set(nextOwner.id, nextOwner)
    if (ownerEvent === "OWNER_CONTINUED") {
      expect(f.store.updatePlanOwner(f.receipt.planID, "owner", nextOwner.id)).toBe(true)
    } else {
      await f.runtime.command(
        {
          requestID: "reassign-after-review-alias",
          planID: f.receipt.planID,
          expectedVersion: f.store.plan(f.receipt.planID)!.version,
          action: "reassign",
          targetSessionID: nextOwner.id,
          reason: "Transfer ownership after exact review-input reconciliation",
        },
        "owner",
      )
    }
    expect(f.store.latestTransition(f.receipt.planID, null, ownerEvent)).toBeDefined()
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
      id: attempt.id,
      session_id: attempt.session_id,
      message_id: attempt.message_id,
      workspace: attempt.workspace,
      base_commit: attempt.base_commit,
      policy: attempt.policy,
    })
    expect(worker.turn).toEqual({ inputID: reviewInputID, state: "completed" })

    const reopened = new TaskRuntime(f.store, f.host, "project")
    cleanup.push(() => reopened.stop())
    expireRunnerLease(f)
    await drive(reopened, 6)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.store.attempts(f.receipt.planID)[0]?.id).toBe(attempt.id)
  },
)

type HeldReviewInput = Awaited<ReturnType<typeof heldReviewInputFixture>>

const invalidReviewInputs: {
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
    name: "stale idle assignment",
    mutate: ({ attempt, f }) => {
      f.store.atomic((db) =>
        db
          .query("UPDATE runner_attempts SET message_id=? WHERE id=?")
          .run("msg_reassigned_original", attempt.id),
      )
    },
  },
  {
    name: "unknown background",
    mutate: ({ worker }) => {
      worker.background = {
        state: "unknown",
        source: "experimental.idle",
        reason: "No native idle confirmation",
      }
    },
  },
  {
    name: "nonzero background",
    mutate: ({ worker }) => {
      if (worker.background?.state === "observed") {
        worker.background.count = 1
        worker.background.kinds.shell = 1
      }
    },
  },
  {
    name: "negative execution start sequence",
    mutate: ({ worker }) => {
      if (worker.background?.state === "observed") worker.background.executionStartSequence = -1
    },
  },
  {
    name: "negative idle event sequence",
    mutate: ({ worker }) => {
      if (worker.background?.state === "observed") worker.background.eventSequence = -1
    },
  },
  {
    name: "negative terminal sequence",
    mutate: ({ worker }) => {
      if (worker.background?.state === "observed") worker.background.terminalSequence = -1
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

test.each(invalidReviewInputs)(
  "review reconciliation rejects $name without recording an alias",
  async ({ mutate }) => {
    const context = await heldReviewInputFixture()
    mutate(context)
    const { f, attempt, reviewInputID } = context
    const promptCount = f.events.filter((event) => event.startsWith("prompt:")).length
    await expect(
      f.runtime.command(reviewInputCommand(f, attempt, reviewInputID), "owner"),
    ).rejects.toThrow()
    expect(
      f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
    ).toBeUndefined()
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.events.filter((event) => event.startsWith("prompt:")).length).toBe(promptCount)
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
    ).toBe(false)
  },
)

test.each(["wrong-owner", "stale-version", "wrong-task", "wrong-attempt"] as const)(
  "review reconciliation rejects %s command identity",
  async (scenario) => {
    const { f, attempt, reviewInputID } = await heldReviewInputFixture()
    const command = reviewInputCommand(f, attempt, reviewInputID)
    const caller = scenario === "wrong-owner" ? "not-owner" : "owner"
    if (scenario === "stale-version") command.expectedVersion++
    if (scenario === "wrong-task") command.taskID = crypto.randomUUID()
    if (scenario === "wrong-attempt") command.attemptID = crypto.randomUUID()
    await expect(f.runtime.command(command, caller)).rejects.toThrow()
    expect(
      f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
    ).toBeUndefined()
  },
)

test.each(["intended", "uncertain"] as const)(
  "review reconciliation does not record lineage while an effect is %s",
  async (state) => {
    const { f, attempt, reviewInputID } = await heldReviewInputFixture()
    f.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_effects(id,plan_id,task_id,attempt_id,kind,state,payload,receipt,fence)
         VALUES(?,?,?,?,?,?,?,NULL,0)`,
        )
        .run(
          crypto.randomUUID(),
          f.receipt.planID,
          attempt.task_id,
          attempt.id,
          "review-test-effect",
          state,
          "{}",
        ),
    )
    const result = await f.runtime.command(
      reviewInputCommand(f, attempt, reviewInputID, `review-effect-${state}`),
      "owner",
    )
    expect(result).toMatchObject({ status: "blocked" })
    expect(
      f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
    ).toBeUndefined()
  },
)

test("cancellation and assignment changes during review observation fence stale aliases", async () => {
  const cancelled = await heldReviewInputFixture()
  const originalSession = cancelled.f.host.session
  let didCancel = false
  cancelled.f.host.session = async (id, options) => {
    const snapshot = await originalSession(id, options)
    if (id === cancelled.attempt.session_id && options?.messages && !didCancel) {
      didCancel = true
      await cancelled.f.runtime.command(
        {
          requestID: "cancel-during-review-observation",
          planID: cancelled.f.receipt.planID,
          expectedVersion: cancelled.f.store.plan(cancelled.f.receipt.planID)!.version,
          action: "cancel",
        },
        "owner",
      )
    }
    return snapshot
  }
  await expect(
    cancelled.f.runtime.command(
      reviewInputCommand(
        cancelled.f,
        cancelled.attempt,
        cancelled.reviewInputID,
        "review-cancel-race",
      ),
      "owner",
    ),
  ).rejects.toThrow("Stale plan version")
  expect(cancelled.f.store.plan(cancelled.f.receipt.planID)?.state).toBe("cancelling")
  expect(
    cancelled.f.store.latestTransition(
      cancelled.f.receipt.planID,
      cancelled.attempt.task_id,
      "WORKER_REVIEW_INPUT_RECONCILED",
    ),
  ).toBeUndefined()

  const reassigned = await heldReviewInputFixture()
  const replacementOwner: HostSession = {
    ...reassigned.f.sessions.get("owner")!,
    id: "new-owner",
  }
  reassigned.f.sessions.set(replacementOwner.id, replacementOwner)
  const originalReassignmentSession = reassigned.f.host.session
  let didReassign = false
  reassigned.f.host.session = async (id, options) => {
    const snapshot = await originalReassignmentSession(id, options)
    if (id === reassigned.attempt.session_id && options?.messages && !didReassign) {
      didReassign = true
      await reassigned.f.runtime.command(
        {
          requestID: "reassign-during-review-observation",
          planID: reassigned.f.receipt.planID,
          expectedVersion: reassigned.f.store.plan(reassigned.f.receipt.planID)!.version,
          action: "reassign",
          targetSessionID: replacementOwner.id,
          reason: "Move current ownership during review reconciliation",
        },
        "owner",
      )
    }
    return snapshot
  }
  await expect(
    reassigned.f.runtime.command(
      reviewInputCommand(
        reassigned.f,
        reassigned.attempt,
        reassigned.reviewInputID,
        "review-owner-race",
      ),
      "owner",
    ),
  ).rejects.toThrow("Stale plan version")
  expect(reassigned.f.store.plan(reassigned.f.receipt.planID)?.owner).toBe(replacementOwner.id)
  expect(
    reassigned.f.store.latestTransition(
      reassigned.f.receipt.planID,
      reassigned.attempt.task_id,
      "WORKER_REVIEW_INPUT_RECONCILED",
    ),
  ).toBeUndefined()
})

test.each(["new-input", "new-execution"] as const)(
  "a concurrent %s during deferred owner observation rejects review reconciliation",
  async (change) => {
    const { f, attempt, worker, reviewInputID } = await heldReviewInputFixture()
    const originalSession = f.host.session
    let ownerReads = 0
    let signalOwnerRead!: () => void
    let resumeOwnerRead!: () => void
    const ownerReadStarted = new Promise<void>((resolve) => {
      signalOwnerRead = resolve
    })
    const ownerReadGate = new Promise<void>((resolve) => {
      resumeOwnerRead = resolve
    })
    f.host.session = async (id, options) => {
      const snapshot = await originalSession(id, options)
      if (id === "owner" && !options?.messages && ++ownerReads === 2) {
        signalOwnerRead()
        await ownerReadGate
      }
      return snapshot
    }
    const pendingReconciliation = f.runtime.command(
      reviewInputCommand(f, attempt, reviewInputID, `review-${change}-race`),
      "owner",
    )
    await ownerReadStarted
    if (change === "new-input") {
      worker.messages.push({ id: "msg_later_input", type: "synthetic", text: "Later input" })
      worker.turn = { inputID: "msg_later_input", state: "completed" }
      if (worker.background?.state === "observed") worker.background.inputID = "msg_later_input"
    } else {
      worker.busy = true
      worker.outcome = undefined
    }
    resumeOwnerRead()
    await expect(pendingReconciliation).rejects.toThrow()
    expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
    expect(
      f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
    ).toBeUndefined()
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
    ).toBe(false)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  },
)

test("an admitted review alias does not match a later unrelated native current input", async () => {
  const { f, attempt, worker, reviewInputID } = await heldReviewInputFixture()
  await f.runtime.command(
    reviewInputCommand(f, attempt, reviewInputID, "review-then-later-input"),
    "owner",
  )
  worker.messages.push({ id: "msg_later_unrelated_input", type: "synthetic", text: "Later input" })
  worker.turn = { inputID: "msg_later_unrelated_input", state: "completed" }
  if (worker.background?.state === "observed")
    worker.background.inputID = "msg_later_unrelated_input"
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
})

test("a changed current attempt during native review observation rejects the stale alias", async () => {
  const { f, attempt, reviewInputID } = await heldReviewInputFixture()
  const originalSession = f.host.session
  let ownerReads = 0
  let signalOwnerRead!: () => void
  let resumeOwnerRead!: () => void
  const ownerReadStarted = new Promise<void>((resolve) => {
    signalOwnerRead = resolve
  })
  const ownerReadGate = new Promise<void>((resolve) => {
    resumeOwnerRead = resolve
  })
  f.host.session = async (id, options) => {
    const snapshot = await originalSession(id, options)
    if (id === "owner" && !options?.messages && ++ownerReads === 2) {
      signalOwnerRead()
      await ownerReadGate
    }
    return snapshot
  }
  const pendingReconciliation = f.runtime.command(
    reviewInputCommand(f, attempt, reviewInputID, "review-attempt-race"),
    "owner",
  )
  await ownerReadStarted
  const replacementAttemptID = crypto.randomUUID()
  const replacementSessionID = "ses_changed_during_review_observation"
  const replacementMessageID = "msg_changed_during_review_observation"
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(attempt.id)
    db.query(
      `INSERT INTO runner_attempts(
         id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,
         policy,state,started_at,token_count,tool_count,retry_count,cost
       ) VALUES(?,?,?,?,?,?,?,?,NULL,?,'running',?,NULL,0,0,NULL)`,
    ).run(
      replacementAttemptID,
      attempt.plan_id,
      attempt.task_id,
      attempt.number + 1,
      replacementSessionID,
      replacementMessageID,
      attempt.workspace,
      attempt.base_commit,
      attempt.policy,
      Date.now() + 1,
    )
  })
  resumeOwnerRead()
  await expect(pendingReconciliation).rejects.toThrow(
    "Review input worker assignment changed during native observation",
  )
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
  expect(f.store.attempts(f.receipt.planID)[1]).toMatchObject({
    id: replacementAttemptID,
    session_id: replacementSessionID,
    message_id: replacementMessageID,
    state: "running",
  })
  expect(
    f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
  ).toBeUndefined()
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
})

test.each(["projectID", "taskID", "attemptID", "sessionID", "assignedMessageID"] as const)(
  "a persisted foreign %s review alias cannot verify the original attempt",
  async (field) => {
    const { f, attempt, reviewInputID } = await heldReviewInputFixture()
    await f.runtime.command(
      reviewInputCommand(f, attempt, reviewInputID, `review-foreign-alias-${field}`),
      "owner",
    )
    const row = f.store.atomic((db) =>
      db
        .query<{ id: number; payload: string }, [string, string]>(
          `SELECT id,payload FROM runner_transitions
           WHERE plan_id=? AND task_id=? AND event='WORKER_REVIEW_INPUT_RECONCILED'`,
        )
        .get(f.receipt.planID, attempt.task_id)!,
    )
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    payload[field] = field === "projectID" ? "foreign-project" : crypto.randomUUID()
    f.store.atomic((db) =>
      db
        .query("UPDATE runner_transitions SET payload=? WHERE id=?")
        .run(JSON.stringify(payload), row.id),
    )
    await f.runtime.tick()
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
    expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
    ).toBe(false)
  },
)

test.each(["unconfirmed", "foreign", "stale-assignment", "pre-reminder-report"])(
  "reminder completion rejects %s lineage",
  async (mode) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await f.runtime.tick()
    const attempt = f.store.attempts(f.receipt.planID)[0]!
    const worker = f.sessions.get(attempt.session_id)!
    const claim = f.runtime.progress.claimReminder(
      attempt.session_id,
      "Remaining handoff",
      "msg_claimed_handoff",
    )!
    f.runtime.progress.finishReminder(claim, mode === "unconfirmed" ? "unknown" : "admitted")
    if (mode === "stale-assignment")
      f.store.atomic((db) =>
        db
          .query("UPDATE runner_attempts SET message_id=? WHERE id=?")
          .run("msg_resumed_assignment", attempt.id),
      )
    const inputID = mode === "foreign" ? "msg_foreign_synthetic" : claim.messageID
    worker.busy = false
    worker.outcome = "succeeded"
    worker.turn = { inputID, state: "completed" }
    worker.background = {
      state: "observed",
      source: "experimental.idle",
      observedAt: Date.now(),
      inputID: mode === "pre-reminder-report" ? attempt.message_id : inputID,
      executionStartSequence: 10,
      eventSequence: 11,
      count: 0,
      kinds: { shell: 0, subagent: 0, image: 0 },
    }
    await f.runtime.tick()
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
    ).toBe(false)
  },
)

test("terminal verification rejects a fresh idle report from a different native input", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: "msg_from_an_older_execution",
    executionStartSequence: 3,
    eventSequence: 4,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }

  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(f.store.plan(f.receipt.planID)?.reason).toContain(
    "Native idle background observation does not match the current worker input lineage",
  )
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
})

test.each([false, true])(
  "a deferred blocked tick cannot undo resume or a later cancellation (cancel=%s)",
  async (cancelAfterResume) => {
    const f = fixture({ wrongFirstA: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await drive(f.runtime, 4)
    const planID = f.receipt.planID
    const attempt = f.store.attempts(planID)[0]!
    expect(f.store.plan(planID)?.state).toBe("blocked")
    expect(attempt.state).toBe("failed")

    const originalSession = f.host.session
    let entered!: () => void
    let release!: () => void
    const reading = new Promise<void>((resolve) => (entered = resolve))
    const paused = new Promise<void>((resolve) => (release = resolve))
    let defer = true
    f.host.session = async (id, options) => {
      const session = await originalSession(id, options)
      if (id === "owner" && defer) {
        defer = false
        entered()
        await paused
      }
      return session
    }

    const staleTick = f.runtime.tick()
    await reading
    let resumedInput: string
    try {
      await f.runtime.command(
        {
          requestID: "resume-during-owner-read",
          planID,
          expectedVersion: f.store.plan(planID)!.version,
          action: "resume",
          taskID: attempt.task_id,
          reason: "Continue the stopped attempt after repairing its verification failure",
        },
        "owner",
      )
      resumedInput = f.store.attempts(planID)[0]!.message_id
      expect(resumedInput).not.toBe(attempt.message_id)
      if (cancelAfterResume)
        await f.runtime.command(
          {
            requestID: "cancel-after-resume",
            planID,
            expectedVersion: f.store.plan(planID)!.version,
            action: "cancel",
          },
          "owner",
        )
    } finally {
      release()
    }
    await staleTick

    if (cancelAfterResume)
      expect(["cancelling", "cancelled"]).toContain(f.store.plan(planID)!.state)
    else expect(f.store.plan(planID)?.state).toBe("running")
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: attempt.id,
      session_id: attempt.session_id,
      workspace: attempt.workspace,
      message_id: resumedInput!,
    })
    if (cancelAfterResume)
      expect(["preparing", "cancelled"]).toContain(f.store.attempts(planID)[0]!.state)
    else expect(f.store.attempts(planID)[0]?.state).toBe("preparing")
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
    await f.runtime.tick()
    expect(f.store.attempts(planID)[0]?.state).toBe(cancelAfterResume ? "cancelled" : "running")
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(
      cancelAfterResume ? 1 : 2,
    )
    expect(f.store.attempts(planID)).toHaveLength(1)
  },
)

test("native heartbeat failures retain structured holds without repeatedly reading context", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.pendingInput = false
  worker.outcome = "failed"
  worker.idleAt = 1000
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.background = {
    state: "unknown",
    source: "experimental.idle",
    reason: "No idle hook after failure",
  }
  const original = f.host.session
  let detailReads = 0
  f.host.session = async (id, options) => {
    const session = await original(id, options)
    if (id !== attempt.session_id || !session) return session
    if (options?.messages) {
      detailReads++
      return session
    }
    return { ...session, turn: undefined, messages: [] }
  }
  await f.runtime.tick()
  await f.runtime.tick()
  expect(detailReads).toBe(1)
  expect(f.store.latestTransition(planID, null, "BLOCKED")).toMatchObject({
    workerObservation: { inputID: attempt.message_id, outcome: "failed", idleAt: 1000 },
  })
  await f.runtime.command(
    {
      requestID: "resume-native-heartbeat-failure",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "resume",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      reason: "Continue the exact failed worker",
    },
    "owner",
  )
  await f.runtime.tick()
  const resumed = f.store.attempts(planID)[0]!
  const readsBeforeNewFailure = detailReads
  worker.busy = false
  worker.pendingInput = false
  worker.outcome = "failed"
  worker.idleAt = 2000
  worker.turn = { inputID: resumed.message_id, state: "completed" }
  await f.runtime.tick()
  await f.runtime.tick()
  expect(detailReads).toBe(readsBeforeNewFailure + 1)
  expect(f.store.latestTransition(planID, null, "BLOCKED")).toMatchObject({
    workerObservation: { inputID: resumed.message_id, outcome: "failed", idleAt: 2000 },
  })
  expect(f.store.attempts(planID)).toHaveLength(1)
})

test("owner can resume completed but unaccepted work for a correction while background stays unknown", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const original = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(original.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: original.message_id, state: "completed" }
  worker.background = {
    state: "unknown",
    source: "experimental.idle",
    reason: "Completed foreground turn has no matching background observation",
  }
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  const command = {
    requestID: "resume-completed-worker-for-correction",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
    action: "resume",
    taskID: original.task_id,
    attemptID: original.id,
    reason: "Apply the visual review correction in the original worker",
  }
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  expect(receipt).toMatchObject({ status: "resuming" })
  const assigned = f.store.attempts(planID)[0]!
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(assigned).toMatchObject({
    id: original.id,
    session_id: original.session_id,
    workspace: original.workspace,
    policy: original.policy,
    base_commit: original.base_commit,
  })
  expect(assigned.message_id).not.toBe(original.message_id)
  expect(worker.background?.state).toBe("unknown")
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
  expect(f.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(false)
  expect(f.store.nodes(planID)[0]?.state).not.toBe("accepted")

  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: assigned.message_id, state: "completed" }
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(worker.background?.state).toBe("unknown")
})

test("retained repair continuation preserves authority across process replacement and verifies the original attempt", async () => {
  const state = await acceptedRetainedRepairFixture()
  const { f, planID, task, attempt, artifact, repair, worker } = state
  const original = structuredClone(attempt)
  const nativeParentID = worker.parentID
  const nativeRoute = structuredClone(worker.model)
  worker.tokens = 777
  worker.tools = 23
  worker.cost = 2.5
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: repair.messageID, state: "interrupted" }
  worker.background = {
    state: "unknown",
    source: "experimental.idle",
    reason: "The replaced process no longer has a current background snapshot",
  }
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)

  await f.runtime.stop()
  const reopened = reopenRuntime(f)
  const resume = {
    requestID: "resume-retained-repair-after-restart",
    planID,
    expectedVersion: reopened.store.plan(planID)!.version,
    action: "resume" as const,
    taskID: task.id,
    attemptID: attempt.id,
    reason: "Continue the exact interrupted retained repair after process replacement.",
  }
  const receipt = await reopened.runtime.command(resume, "owner")
  expect(await reopened.runtime.command(resume, "owner")).toEqual(receipt)
  const resumed = reopened.store.attempts(planID)[0]!
  expect(receipt).toMatchObject({ status: "resuming" })
  expect(resumed).toMatchObject({
    id: original.id,
    state: "preparing",
    session_id: original.session_id,
    workspace: original.workspace,
    base_commit: original.base_commit,
    policy: original.policy,
    artifact,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(resumed.message_id).not.toBe(repair.messageID)
  const resumeEvent = reopened.store
    .activity(planID, task.id)
    .filter((entry) => entry.event === "ATTEMPT_RESUMED")
    .at(-1)!
  expect(JSON.parse(resumeEvent.payload)).toMatchObject({
    attemptID: original.id,
    previousMessageID: repair.messageID,
    messageID: resumed.message_id,
    terminalInputID: repair.messageID,
    terminalOutcome: "interrupted",
    interruptedInputID: repair.messageID,
    retainedRepairContinuation: {
      schema: "lazers-retained-repair-continuation/v1",
      operationID: repair.operationID,
      owner: "owner",
      ownerEpoch: repair.ownerEpoch,
    },
    usageRetained: true,
  })

  await reopened.runtime.tick()
  const continuationPrompt = reopened.store.effects(planID).find((effect) => {
    if (effect.kind !== "prompt") return false
    const payload = JSON.parse(effect.payload) as Record<string, unknown>
    return payload.messageID === resumed.message_id
  })!
  expect(continuationPrompt.state).toBe("completed")
  expect(worker).toMatchObject({
    id: original.session_id,
    parentID: nativeParentID,
    directory: original.workspace,
    model: nativeRoute,
    metadata: { lazersAttemptID: original.id },
  })
  expect(JSON.parse(continuationPrompt.payload)).toMatchObject({
    sessionID: original.session_id,
    messageID: resumed.message_id,
    workspace: original.workspace,
    repairID: repair.operationID,
    repairMessageID: repair.messageID,
    continuedFromInputID: repair.messageID,
  })
  expect(JSON.parse(continuationPrompt.receipt!)).toMatchObject({
    messageID: resumed.message_id,
    taskID: task.id,
    repairID: repair.operationID,
    continuedFromInputID: repair.messageID,
  })
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(3)
  expect(reopened.store.attempts(planID)).toHaveLength(1)

  f.completeWorker(original.session_id)
  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: resumed.message_id,
    executionStartSequence: 20,
    eventSequence: 21,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  await drive(reopened.runtime, 10)
  expect(reopened.store.plan(planID)?.state).toBe("accepted")
  expect(reopened.store.nodes(planID)[0]).toMatchObject({ task_id: task.id, state: "accepted" })
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(reopened.store.attempts(planID)[0]).toMatchObject({
    id: original.id,
    session_id: original.session_id,
    workspace: original.workspace,
    base_commit: original.base_commit,
    policy: original.policy,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(
    reopened.store.effects(planID).find((effect) => effect.kind === "verify:content"),
  ).toMatchObject({ state: "completed" })
  expect(
    reopened.store.effects(planID).find((effect) => effect.kind === "graph-verify:combined"),
  ).toMatchObject({ state: "completed" })
  expect(reopened.store.latestRetainedRepair<{ artifact: string }>(planID, task.id)?.artifact).toBe(
    artifact,
  )
})

test("a pre-existing retained-repair fence failure recovers the exact cancelled reservation without losing dirty work", async () => {
  const { f, planID, task, attempt, repair, reopened, failedReservation } =
    await reproduceLegacyRetainedRepairFenceFailure()
  const worker = f.sessions.get(attempt.session_id)!
  const nativeParentID = worker.parentID
  const nativeRoute = structuredClone(worker.model)

  const dirtyWork = "unsaved retained-repair progress\n"
  writeFileSync(join(attempt.workspace, "repair-notes.txt"), dirtyWork)
  git(attempt.workspace, ["add", "repair-notes.txt"])
  const recoveryCommand = {
    requestID: "recover-retained-repair-fence-failure",
    planID,
    expectedVersion: reopened.store.plan(planID)!.version,
    action: "resume" as const,
    taskID: task.id,
    attemptID: attempt.id,
    reason: "Recover the original retained repair after its proven runtime fence failure.",
  }
  const recovered = await reopened.runtime.command(recoveryCommand, "owner")
  expect(await reopened.runtime.command(recoveryCommand, "owner")).toEqual(recovered)
  expect(recovered).toMatchObject({ status: "retained-repair-recovered", attemptID: attempt.id })
  const resumed = reopened.store.attempts(planID)[0]!
  expect(resumed).toMatchObject({
    id: attempt.id,
    state: "preparing",
    session_id: attempt.session_id,
    workspace: attempt.workspace,
    base_commit: attempt.base_commit,
    policy: attempt.policy,
    artifact: attempt.artifact,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(resumed.message_id).not.toBe(failedReservation.message_id)
  expect(readFileSync(join(attempt.workspace, "repair-notes.txt"), "utf8")).toBe(dirtyWork)
  const recoveryEvent = reopened.store
    .activity(planID, task.id)
    .filter((entry) => entry.event === "ATTEMPT_RESUMED")
    .at(-1)!
  expect(JSON.parse(recoveryEvent.payload)).toMatchObject({
    attemptID: attempt.id,
    previousMessageID: failedReservation.message_id,
    messageID: resumed.message_id,
    terminalInputID: repair.messageID,
    interruptedInputID: repair.messageID,
    retainedRepairRecovery: {
      schema: "lazers-retained-repair-recovery/v1",
      operationID: repair.operationID,
      failedMessageID: failedReservation.message_id,
      interruptedInputID: repair.messageID,
      owner: "owner",
      ownerEpoch: repair.ownerEpoch,
    },
    usageRetained: true,
  })

  await reopened.runtime.tick()
  const prompt = reopened.store.effects(planID).find((effect) => {
    if (effect.kind !== "prompt") return false
    return (JSON.parse(effect.payload) as { messageID?: unknown }).messageID === resumed.message_id
  })!
  expect(prompt.state).toBe("completed")
  expect(worker).toMatchObject({
    id: attempt.session_id,
    parentID: nativeParentID,
    directory: attempt.workspace,
    model: nativeRoute,
    metadata: { lazersAttemptID: attempt.id },
  })
  expect(JSON.parse(prompt.receipt!)).toMatchObject({
    messageID: resumed.message_id,
    repairID: repair.operationID,
    continuedFromInputID: repair.messageID,
  })
  expect(readFileSync(join(attempt.workspace, "repair-notes.txt"), "utf8")).toBe(dirtyWork)
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(3)
})

test("retained repair recovery preserves dirty progress that changes during native revalidation", async () => {
  const state = await reproduceLegacyRetainedRepairFenceFailure()
  const path = join(state.attempt.workspace, "repair-progress.txt")
  writeFileSync(path, "earlier progress\n")
  const originalSession = state.f.host.session
  let ownerReads = 0
  state.f.host.session = async (sessionID, options) => {
    if (sessionID === "owner" && ++ownerReads === 2) writeFileSync(path, "new useful progress\n")
    return originalSession(sessionID, options)
  }
  try {
    const result = await state.reopened.runtime.command(
      recoveryCommand(state, "recover-with-new-dirty-progress"),
      "owner",
    )
    expect(result).toMatchObject({
      status: "retained-repair-recovered",
      attemptID: state.attempt.id,
    })
    expect(ownerReads).toBeGreaterThanOrEqual(2)
    expect(readFileSync(path, "utf8")).toBe("new useful progress\n")
    expect(state.reopened.store.attempts(state.planID)).toHaveLength(1)
    expect(state.reopened.store.attempts(state.planID)[0]).toMatchObject({
      id: state.attempt.id,
      session_id: state.attempt.session_id,
      workspace: state.attempt.workspace,
      state: "preparing",
      token_count: 777,
      tool_count: 23,
      cost: 2.5,
    })
  } finally {
    state.f.host.session = originalSession
  }
})

test("an owner cancellation after the fence failure is not eligible for retained-repair recovery", async () => {
  const { f, planID, task, attempt, reopened } = await reproduceLegacyRetainedRepairFenceFailure()
  const promptsBeforeCancel = f.events.filter((event) => event.startsWith("prompt:")).length
  await reopened.runtime.command(
    {
      requestID: "cancel-retained-repair-after-fence-failure",
      planID,
      expectedVersion: reopened.store.plan(planID)!.version,
      action: "cancel",
      reason: "Do not continue this retained repair.",
    },
    "owner",
  )
  const cancellation = reopened.store.plan(planID)!
  expect(cancellation.state).toBe("cancelling")
  expect(reopened.store.latestTransition(planID, null, "CANCEL_REQUESTED")).toBeDefined()
  await expect(
    reopened.runtime.command(
      {
        requestID: "resume-after-actual-cancellation",
        planID,
        expectedVersion: cancellation.version,
        action: "resume",
        taskID: task.id,
        attemptID: attempt.id,
        reason: "This actual cancellation must not be recovered.",
      },
      "owner",
    ),
  ).rejects.toThrow()
  expect(reopened.store.plan(planID)?.state).toBe("cancelling")
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(reopened.store.attempts(planID)[0]).toMatchObject({ id: attempt.id, state: "cancelled" })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptsBeforeCancel)
})

test.each([
  {
    name: "native route",
    caller: "owner",
    mutate: (state: LegacyFenceState) => {
      state.worker.model = { providerID: "openai", id: "wrong-recovery-route" }
    },
  },
  {
    name: "repair artifact",
    caller: "owner",
    mutate: (state: LegacyFenceState) => {
      const transition = state.reopened.store
        .activity(state.planID, state.task.id)
        .filter((entry) => entry.event === "RETAINED_REPAIR_REQUESTED")
        .at(-1)!
      const payload = JSON.parse(transition.payload) as Record<string, unknown>
      payload.artifact = "f".repeat(40)
      state.reopened.store.atomic((db) =>
        db
          .query("UPDATE runner_transitions SET payload=? WHERE id=?")
          .run(JSON.stringify(payload), transition.id),
      )
    },
  },
  {
    name: "owner",
    caller: "not-the-plan-owner",
    mutate: () => {},
  },
  {
    name: "uncertain effect",
    caller: "owner",
    mutate: (state: LegacyFenceState) => {
      const check = state.reopened.store
        .effects(state.planID)
        .find((effect) => effect.kind === "verify:content")!
      state.reopened.store.atomic((db) =>
        db.query("UPDATE runner_effects SET state='uncertain' WHERE id=?").run(check.id),
      )
    },
  },
  {
    name: "pending executable controls",
    caller: "owner",
    mutate: (state: LegacyFenceState) => {
      Object.assign(state.worker, {
        pendingInput: true,
        pendingPermissions: 1,
        pendingForms: 1,
      })
    },
  },
])(
  "registered retained-repair recovery rejects a mismatched $name",
  async ({ name, caller, mutate }) => {
    const state = await reproduceLegacyRetainedRepairFenceFailure()
    mutate(state)
    const before = recoveryAdmissionSnapshot(state)
    await expect(
      state.reopened.runtime.command(
        recoveryCommand(state, `reject-retained-repair-${name}-${crypto.randomUUID()}`),
        caller,
      ),
    ).rejects.toThrow()
    expectNoRecoveryAdmission(state, before)
  },
)

test.each(["revision", "project"] as const)(
  "registered retained-repair recovery rechecks changed task %s after deferred native revalidation",
  async (binding) => {
    const state = await reproduceLegacyRetainedRepairFenceFailure()
    const before = recoveryAdmissionSnapshot(state)
    const paused = await pauseRecoveryAtWorktrees(state, `deferred-task-${binding}`)
    try {
      const task = state.f.repository.get(state.task.id)!
      const changed = structuredClone(task)
      if (binding === "revision") changed.revision += 1
      else changed.provenance.projectID = "foreign-project"
      state.f.repository.atomic((db) =>
        db
          .query("UPDATE tasks SET body=? WHERE project_directory=? AND id=?")
          .run(JSON.stringify(changed), state.f.repository.projectDirectory, state.task.id),
      )
    } finally {
      paused.release()
    }
    await expect(paused.pending).rejects.toThrow()
    expectNoRecoveryAdmission(state, before)
  },
)

test("registered retained-repair recovery rechecks task disposition after deferred native revalidation", async () => {
  const state = await reproduceLegacyRetainedRepairFenceFailure()
  const before = recoveryAdmissionSnapshot(state)
  const paused = await pauseRecoveryAtWorktrees(state, "deferred-task-disposition")
  try {
    expect(
      state.f.repository.recordDisposition(
        {
          taskID: state.task.id,
          requestID: "dispose-during-retained-recovery",
          disposition: "rejected",
          reason: "The task is obsolete while native recovery validation is pending.",
          evidence: [{ kind: "human", reference: "Deferred recovery race regression" }],
        },
        { sessionID: "owner", agent: "architect" },
      ).status,
    ).toBe("recorded")
    expect(state.reopened.store.plan(state.planID)?.version).toBe(before.version)
  } finally {
    paused.release()
  }
  await expect(paused.pending).rejects.toThrow()
  expectNoRecoveryAdmission(state, before)
})

test("registered retained-repair recovery loses to an owner reassignment during deferred native revalidation", async () => {
  const state = await reproduceLegacyRetainedRepairFenceFailure()
  const { f, reopened, planID, attempt } = state
  const owner = f.sessions.get("owner")!
  f.sessions.set("owner-b", { ...structuredClone(owner), id: "owner-b" })
  const paused = await pauseRecoveryAtWorktrees(state, "recovery-raced-by-reassign")
  const originalResumes = reopened.store
    .activity(planID, state.task.id)
    .filter((entry) => entry.event === "ATTEMPT_RESUMED").length
  const originalPrompts = f.events.filter((event) => event.startsWith("prompt:")).length
  try {
    await reopened.runtime.command(
      {
        requestID: "reassign-during-retained-recovery",
        planID,
        expectedVersion: reopened.store.plan(planID)!.version,
        action: "reassign",
        targetSessionID: "owner-b",
        reason: "Reassign while original-worker recovery is awaiting native evidence.",
      },
      "owner",
    )
  } finally {
    paused.release()
  }
  await expect(paused.pending).rejects.toThrow()
  expect(reopened.store.plan(planID)).toMatchObject({ owner: "owner-b", state: "blocked" })
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(reopened.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    state: "cancelled",
    message_id: state.failedReservation.message_id,
    session_id: attempt.session_id,
    workspace: attempt.workspace,
    base_commit: attempt.base_commit,
    policy: attempt.policy,
  })
  expect(
    reopened.store
      .activity(planID, state.task.id)
      .filter((entry) => entry.event === "ATTEMPT_RESUMED"),
  ).toHaveLength(originalResumes)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(originalPrompts)
})

test("registered retained-repair recovery rejects a native input that changes between revalidation reads", async () => {
  const state = await reproduceLegacyRetainedRepairFenceFailure()
  const before = recoveryAdmissionSnapshot(state)
  const ownerRead = deferred<void>()
  const releaseOwnerRead = deferred<void>()
  const originalSession = state.f.host.session
  let ownerReads = 0
  state.f.host.session = async (sessionID, options) => {
    if (sessionID === "owner" && ++ownerReads === 2) {
      ownerRead.resolve()
      await releaseOwnerRead.promise
    }
    return originalSession(sessionID, options)
  }
  const pending = state.reopened.runtime.command(
    recoveryCommand(state, "recovery-raced-by-native-input"),
    "owner",
  )
  try {
    await ownerRead.promise
    state.worker.messages.push({
      id: "msg-new-native-input",
      type: "user",
      text: "A newer native input arrived during recovery revalidation.",
    })
    state.worker.outcome = "interrupted"
    state.worker.turn = { inputID: "msg-new-native-input", state: "interrupted" }
  } finally {
    releaseOwnerRead.resolve()
    state.f.host.session = originalSession
  }
  await expect(pending).rejects.toThrow()
  expectNoRecoveryAdmission(state, before)
})

test("an explicit resume continues one process-replaced interrupted attempt without inventing idle proof", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalMessageID = attempt.message_id
  const originalSessionID = attempt.session_id
  const originalWorkspace = attempt.workspace
  const originalBase = attempt.base_commit
  const originalPolicy = attempt.policy
  worker.tokens = 777
  worker.tools = 23
  worker.cost = 2.5
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: originalMessageID, state: "interrupted" }
  worker.background = {
    state: "unknown",
    source: "experimental.idle",
    reason: "The replaced process no longer reports its idle hook state",
  }

  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({ id: attempt.id, state: "running" })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(
    f.store.latestTransition(planID, attempt.task_id, "WORKER_BACKGROUND_UNKNOWN"),
  ).toBeDefined()

  // Reopening the runtime preserves the running attempt and still cannot infer
  // that the retained native process is idle or authorize a continuation.
  await f.runtime.stop()
  const replaced = reopenRuntime(f)
  await replaced.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)

  const resume = {
    requestID: "resume-interrupted-process-replacement",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
    action: "resume",
    taskID: attempt.task_id,
    attemptID: attempt.id,
    reason: "Explicitly continue the matching interrupted attempt after process replacement",
  }
  const receipt = await replaced.runtime.command(resume, "owner")
  expect(await replaced.runtime.command(resume, "owner")).toEqual(receipt)
  const assigned = f.store.attempts(planID)[0]!
  expect(receipt).toMatchObject({ status: "resuming" })
  expect(assigned).toMatchObject({
    id: attempt.id,
    state: "preparing",
    session_id: originalSessionID,
    workspace: originalWorkspace,
    base_commit: originalBase,
    policy: originalPolicy,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(assigned.message_id).not.toBe(originalMessageID)
  const resumed = f.store
    .activity(planID, attempt.task_id)
    .filter((entry) => entry.event === "ATTEMPT_RESUMED")
  expect(resumed).toHaveLength(1)
  expect(JSON.parse(resumed[0]!.payload)).toMatchObject({
    attemptID: attempt.id,
    previousMessageID: originalMessageID,
    messageID: assigned.message_id,
    interruptedInputID: originalMessageID,
    usageRetained: true,
  })
  expect(worker.background?.state).toBe("unknown")
  expect(readFileSync(join(originalWorkspace, "a.txt"), "utf8")).toBe("a")
  expect(git(originalWorkspace, ["status", "--porcelain"])).not.toBe("")

  await replaced.runtime.stop()
  const reopened = reopenRuntime(f)
  expect(await reopened.runtime.command(resume, "owner")).toEqual(receipt)
  await reopened.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("create:")).length).toBe(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.message_id).toBe(assigned.message_id)

  worker.busy = false
  worker.outcome = undefined
  worker.turn = { inputID: assigned.message_id, state: "pending" }
  await reopened.runtime.tick()
  expect(reopened.store.plan(planID)?.state).toBe("running")
  expect(reopened.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(
    false,
  )

  // A delayed pre-resume native observation is ignored, not treated as evidence
  // for or a new hold on the assigned continuation.
  const nativeSession = f.host.session
  f.host.session = async (id, options) => {
    const session = await nativeSession(id, options)
    if (id !== originalSessionID || !session) return session
    return {
      ...session,
      busy: false,
      outcome: "interrupted",
      turn: { inputID: originalMessageID, state: "interrupted" },
      background: {
        state: "observed",
        source: "experimental.idle",
        observedAt: Date.now(),
        inputID: originalMessageID,
        executionStartSequence: 2,
        eventSequence: 3,
        count: 0,
        kinds: { shell: 0, subagent: 0, image: 0 },
      },
    }
  }
  await reopened.runtime.tick()
  expect(reopened.store.plan(planID)?.state).toBe("running")
  expect(reopened.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(
    false,
  )

  f.host.session = nativeSession
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: assigned.message_id, state: "completed" }
  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: assigned.message_id,
    executionStartSequence: 4,
    eventSequence: 5,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  await drive(reopened.runtime, 8)
  expect(reopened.store.plan(planID)?.state).toBe("accepted")
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(reopened.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    session_id: originalSessionID,
    workspace: originalWorkspace,
    base_commit: originalBase,
    policy: originalPolicy,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
})

test("manual continuation accepts a real failed outcome only for its completed current assigned input", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt, worker } = await holdFailedAttempt(f)
  expect(worker.outcome).toBe("failed")
  expect(worker.turn).toEqual({ inputID: attempt.message_id, state: "completed" })
  expect(attempt.state).toBe("running")
  const stopped = f.store.latestTransition<Record<string, unknown>>(
    planID,
    attempt.task_id,
    "WORKER_STOPPED",
  )
  expect(stopped).toMatchObject({
    attemptID: attempt.id,
    sessionID: attempt.session_id,
    workspace: attempt.workspace,
    outcome: "failed",
    inputID: attempt.message_id,
  })
  const blocked = f.store.latestTransition<{ workerObservation?: Record<string, unknown> }>(
    planID,
    null,
    "BLOCKED",
  )
  expect(blocked?.workerObservation).toMatchObject({
    kind: "terminal-worker-observation",
    attemptID: attempt.id,
    sessionID: attempt.session_id,
    workspace: attempt.workspace,
    outcome: "failed",
    inputID: attempt.message_id,
    turnState: "completed",
    background: { state: "unknown" },
  })
  expect(f.store.plan(planID)?.reason).toContain("Worker execution failed")

  const receipt = await f.runtime.command(
    {
      requestID: "resume-failed-foreground",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "resume",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      reason: "Continue the exact terminal failed foreground input",
    },
    "owner",
  )
  expect(receipt).toMatchObject({ status: "resuming" })
  const resumed = f.store.attempts(planID)[0]!
  expect(resumed).toMatchObject({ id: attempt.id, state: "preparing" })
  expect(resumed.message_id).not.toBe(attempt.message_id)
  const event = f.store
    .activity(planID, attempt.task_id)
    .find((entry) => entry.event === "ATTEMPT_RESUMED")!
  expect(JSON.parse(event.payload)).toMatchObject({
    attemptID: attempt.id,
    previousMessageID: attempt.message_id,
    messageID: resumed.message_id,
    terminalInputID: attempt.message_id,
    terminalOutcome: "failed",
    usageRetained: true,
  })
  expect(JSON.parse(event.payload)).not.toHaveProperty("interruptedInputID")
  expect(worker.outcome).toBe("failed")
  await f.runtime.tick()
  expect(f.events.filter((item) => item.startsWith("prompt:"))).toHaveLength(2)
  expect(f.store.attempts(planID)).toHaveLength(1)
})

test("a failed fresh continuation input is processed despite the unchanged prior unknown background", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt, worker } = await holdInterruptedAttempt(f)
  const previousBackground = structuredClone(worker.background)
  await f.runtime.command(
    {
      requestID: "resume-before-fresh-terminal-failure",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "resume",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      reason: "Continue the same attempt before observing its fresh input",
    },
    "owner",
  )
  await f.runtime.tick()
  const current = f.store.attempts(planID)[0]!
  expect(current.id).toBe(attempt.id)
  expect(current.message_id).not.toBe(attempt.message_id)
  expect(worker.background).toEqual(previousBackground)
  expect(worker.turn).toEqual({ inputID: current.message_id, state: "pending" })

  worker.busy = false
  worker.outcome = "failed"
  worker.turn = { inputID: current.message_id, state: "completed" }
  await f.runtime.tick()

  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.plan(planID)?.reason).toContain("Worker execution failed")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    state: "running",
    message_id: current.message_id,
  })
  expect(
    f.store.latestTransition<Record<string, unknown>>(planID, attempt.task_id, "WORKER_STOPPED"),
  ).toMatchObject({ outcome: "failed", inputID: current.message_id })
  expect(
    f.store.latestTransition<{ workerObservation?: Record<string, unknown> }>(
      planID,
      null,
      "BLOCKED",
    )?.workerObservation,
  ).toMatchObject({ outcome: "failed", inputID: current.message_id, turnState: "completed" })
  expect(worker.background).toEqual(previousBackground)
})

test.each(["permission", "form"] as const)(
  "a current-input %s hold is not suppressed by the unchanged prior unknown background",
  async (approval) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const { planID, attempt, worker } = await holdInterruptedAttempt(f)
    const previousBackground = structuredClone(worker.background)
    await f.runtime.command(
      {
        requestID: `resume-before-current-${approval}`,
        planID,
        expectedVersion: f.store.plan(planID)!.version,
        action: "resume",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        reason: "Continue the same attempt before observing a current approval",
      },
      "owner",
    )
    await f.runtime.tick()
    const current = f.store.attempts(planID)[0]!
    expect(worker.turn).toEqual({ inputID: current.message_id, state: "pending" })
    expect(worker.background).toEqual(previousBackground)
    if (approval === "permission") worker.pendingPermissions = 1
    else worker.pendingForms = 1

    await f.runtime.tick()

    expect(f.store.plan(planID)?.state).toBe("blocked")
    expect(f.store.plan(planID)?.reason).toContain(
      approval === "permission" ? "permission request" : "form",
    )
    expect(f.store.attempts(planID)).toHaveLength(1)
    expect(f.store.attempts(planID)[0]?.message_id).toBe(current.message_id)
    expect(
      f.store.latestTransition<Record<string, unknown>>(
        planID,
        attempt.task_id,
        "WORKER_APPROVAL_WAIT",
      ),
    ).toMatchObject({
      attemptID: attempt.id,
      pendingPermissions: approval === "permission" ? 1 : 0,
      pendingForms: approval === "form" ? 1 : 0,
    })
  },
)

test("terminal failed worker with a genuine current-input idle report can resume from failed state", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "failed"
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: attempt.message_id,
    executionStartSequence: 2,
    eventSequence: 3,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  await f.runtime.tick()

  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.nodes(planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(planID)[0]?.state).toBe("failed")
  expect(
    f.store.latestTransition<Record<string, unknown>>(planID, attempt.task_id, "WORKER_STOPPED"),
  ).toMatchObject({ outcome: "failed", inputID: attempt.message_id })
  expect(
    f.store.latestTransition<{ workerObservation?: Record<string, unknown> }>(
      planID,
      null,
      "BLOCKED",
    )?.workerObservation,
  ).toMatchObject({ outcome: "failed", inputID: attempt.message_id, turnState: "completed" })

  const receipt = await f.runtime.command(
    {
      requestID: "resume-failed-with-current-idle",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "resume",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      reason: "Continue after the matching terminal failed worker was observed idle",
    },
    "owner",
  )
  expect(receipt).toMatchObject({ status: "resuming" })
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({ id: attempt.id, state: "preparing" })
  expect(worker.outcome).toBe("failed")
})

test.each([
  ["a failed turn for a foreign input", "foreign-input"],
  ["a failed turn with no native input ID", null],
] as const)("native continuation rejects %s", async (_label, inputID) => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt } = await holdFailedAttempt(f, inputID)
  const before = f.store.attempts(planID)[0]!
  await expect(
    f.runtime.command(
      {
        requestID: `resume-failed-invalid-${inputID ?? "missing"}`,
        planID,
        expectedVersion: f.store.plan(planID)!.version,
        action: "resume",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        reason: "Only the current assigned failed input can continue",
      },
      "owner",
    ),
  ).rejects.toThrow()
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: before.id,
    state: "running",
    message_id: before.message_id,
  })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test.each(["active", "pending-input", "pending-approval", "unstable", "known-background"] as const)(
  "failed-worker continuation rejects a %s native observation",
  async (state) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const { planID, attempt, worker } = await holdFailedAttempt(f)
    switch (state) {
      case "active":
        worker.busy = true
        break
      case "pending-input":
        worker.pendingInput = true
        break
      case "pending-approval":
        worker.pendingForms = 1
        break
      case "unstable":
        worker.observationUnstable = true
        break
      case "known-background":
        worker.background = {
          state: "observed",
          source: "experimental.idle",
          observedAt: Date.now(),
          inputID: attempt.message_id,
          executionStartSequence: 1,
          eventSequence: 2,
          count: 1,
          kinds: { shell: 1, subagent: 0, image: 0 },
        }
        break
    }
    await expect(
      f.runtime.command(
        {
          requestID: `resume-failed-unsafe-${state}`,
          planID,
          expectedVersion: f.store.plan(planID)!.version,
          action: "resume",
          taskID: attempt.task_id,
          attemptID: attempt.id,
          reason: "Continue only when the current terminal observation remains safe",
        },
        "owner",
      ),
    ).rejects.toThrow()
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: attempt.id,
      state: "running",
      message_id: attempt.message_id,
    })
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  },
)

test("a completed turn for another input cannot authorize terminal continuation", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt, worker } = await holdFailedAttempt(f, "other-input", "succeeded")
  expect(worker.turn).toEqual({ inputID: "other-input", state: "completed" })
  await expect(
    f.runtime.command(
      {
        requestID: "resume-completed-turn-not-failure",
        planID,
        expectedVersion: f.store.plan(planID)!.version,
        action: "resume",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        reason: "A completed turn for another input does not authorize this assignment",
      },
      "owner",
    ),
  ).rejects.toThrow()
  expect(f.store.attempts(planID)[0]).toMatchObject({ id: attempt.id, state: "running" })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test.each([
  "wrong-attempt",
  "foreign-worker",
  "archived-worker",
  "route-mismatch",
  "active-worker",
  "pending-input",
  "pending-approval",
  "unstable-observation",
  "input-lineage",
  "known-background",
  "unrelated-hold",
  "uncertain-effect",
] as const)("interrupted continuation rejects %s", async (caseName) => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt, worker } = await holdInterruptedAttempt(f)
  let attemptID = attempt.id
  switch (caseName) {
    case "foreign-worker":
      worker.projectID = "foreign-project"
      break
    case "archived-worker":
      worker.archived = true
      break
    case "route-mismatch":
      worker.model = { providerID: "other", id: "other" }
      break
    case "active-worker":
      worker.busy = true
      break
    case "pending-input":
      worker.pendingInput = true
      break
    case "pending-approval":
      worker.pendingPermissions = 1
      break
    case "unstable-observation":
      worker.observationUnstable = true
      break
    case "input-lineage":
      worker.turn = { inputID: "msg-foreign", state: "interrupted" }
      break
    case "known-background":
      worker.background = {
        state: "observed",
        source: "experimental.idle",
        observedAt: Date.now(),
        inputID: attempt.message_id,
        executionStartSequence: 2,
        eventSequence: 3,
        count: 1,
        kinds: { shell: 1, subagent: 0, image: 0 },
      }
      break
    case "unrelated-hold":
      f.store.record(planID, null, "BLOCKED", { reason: "A different hold" })
      break
    case "uncertain-effect":
      f.store.atomic((db) =>
        db
          .query("UPDATE runner_effects SET state='uncertain' WHERE plan_id=? AND kind='prompt'")
          .run(planID),
      )
      break
    case "wrong-attempt":
      attemptID = crypto.randomUUID()
      break
  }
  const before = f.store.attempts(planID)[0]!
  await expect(
    f.runtime.command(
      {
        requestID: `unsafe-resume-${caseName}`,
        planID,
        expectedVersion: f.store.plan(planID)!.version,
        action: "resume",
        taskID: attempt.task_id,
        attemptID,
        reason: "Attempt explicit continuation only if every current guard passes",
      },
      "owner",
    ),
  ).rejects.toThrow()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: before.id,
    state: "running",
    message_id: before.message_id,
  })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test.each(["cancel", "reassign"] as const)(
  "cancellation or reassignment during interrupted-worker observation wins (%s)",
  async (race) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const { planID, attempt } = await holdInterruptedAttempt(f)
    const originalSession = f.host.session
    let entered!: () => void
    let release!: () => void
    const reading = new Promise<void>((resolve) => (entered = resolve))
    const paused = new Promise<void>((resolve) => (release = resolve))
    let waiting = false
    f.host.session = async (id, options) => {
      const session = await originalSession(id, options)
      if (id === attempt.session_id && options?.messages && !waiting) {
        waiting = true
        entered()
        await paused
      }
      return session
    }
    const resume = f.runtime.command(
      {
        requestID: `resume-race-${race}`,
        planID,
        expectedVersion: f.store.plan(planID)!.version,
        action: "resume",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        reason: "Resume only if the interrupted observation remains current",
      },
      "owner",
    )
    await reading
    if (race === "cancel") {
      await f.runtime.command(
        {
          requestID: "cancel-during-interrupted-observation",
          planID,
          expectedVersion: f.store.plan(planID)!.version,
          action: "cancel",
        },
        "owner",
      )
    } else {
      f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner" })
      await f.runtime.command(
        {
          requestID: "reassign-during-interrupted-observation",
          planID,
          expectedVersion: f.store.plan(planID)!.version,
          action: "reassign",
          targetSessionID: "new-owner",
          reason: "Transfer orchestration while the native observation is pending",
        },
        "owner",
      )
    }
    release()
    await expect(resume).rejects.toThrow("Stale plan version")
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: attempt.id,
      state: "running",
      message_id: attempt.message_id,
    })
    expect(
      f.store
        .activity(planID, attempt.task_id)
        .filter((entry) => entry.event === "ATTEMPT_RESUMED"),
    ).toHaveLength(0)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  },
)

test("ambiguous interrupted continuation delivery stays uncertain after runtime reopen", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt } = await holdInterruptedAttempt(f)
  const resume = {
    requestID: "resume-ambiguous-interrupted-delivery",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
    action: "resume",
    taskID: attempt.task_id,
    attemptID: attempt.id,
    reason: "Continue once and retain an ambiguous delivery for reconciliation",
  }
  await f.runtime.command(resume, "owner")
  const resumedMessageID = f.store.attempts(planID)[0]!.message_id
  const prompt = f.host.prompt
  let continuationSends = 0
  f.host.prompt = async (input) => {
    if (input.id === resumedMessageID) {
      continuationSends++
      throw new Error("native admission response lost")
    }
    await prompt(input)
  }
  await f.runtime.tick()
  expect(continuationSends).toBe(1)
  const effect = f.store
    .effects(planID)
    .find(
      (candidate) =>
        candidate.kind === "prompt" && JSON.parse(candidate.payload).messageID === resumedMessageID,
    )
  expect(effect?.state).toBe("uncertain")

  await f.runtime.stop()
  const reopened = reopenRuntime(f)
  await reopened.runtime.tick()
  await reopened.runtime.tick()
  expect(continuationSends).toBe(1)
  expect(
    reopened.store
      .effects(planID)
      .find(
        (candidate) =>
          candidate.kind === "prompt" &&
          JSON.parse(candidate.payload).messageID === resumedMessageID,
      )?.state,
  ).toBe("uncertain")
  expect(reopened.store.attempts(planID)[0]?.message_id).toBe(resumedMessageID)
})

test("explicit cancellation after process replacement resumes the same dirty attempt exactly once", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalSession = f.host.session
  const originalMessageID = attempt.message_id
  const originalWorkspace = attempt.workspace
  const originalPolicy = attempt.policy
  const originalBase = attempt.base_commit
  worker.outcome = "succeeded"
  worker.tokens = 777
  worker.tools = 23
  worker.cost = 2.5
  let replaced = true
  f.host.session = async (id, options) => {
    const session = await originalSession(id, options)
    if (id !== attempt.session_id || !replaced || !session) return session
    return {
      ...session,
      busy: false,
      outcome: "interrupted",
      turn: { inputID: originalMessageID, state: "interrupted" },
      background: {
        state: "unknown",
        source: "experimental.idle",
        reason: "The replaced process no longer reports its idle hook state",
      },
    }
  }

  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.plan(planID)?.reason).toContain("Worker execution was interrupted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("running")
  expect(
    (f.store.detail(planID).activity as { event: string }[]).some(
      (entry) => entry.event === "REPAIR",
    ),
  ).toBe(false)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)

  await f.runtime.command(
    {
      requestID: "cancel-replaced",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cancelled")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    state: "cancelled",
    session_id: attempt.session_id,
    workspace: originalWorkspace,
    base_commit: originalBase,
    policy: originalPolicy,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(
    f.store.latestTransition(planID, attempt.task_id, "WORKER_BACKGROUND_UNKNOWN"),
  ).toBeDefined()
  expect(git(originalWorkspace, ["status", "--porcelain"])).not.toBe("")
  expect(readFileSync(join(originalWorkspace, "a.txt"), "utf8")).toBe("a")

  replaced = false
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: originalMessageID, state: "interrupted" }
  const promptCount = f.events.filter((event) => event.startsWith("prompt:")).length
  const resume = {
    requestID: "resume-replaced-same-attempt",
    planID,
    expectedVersion: f.store.plan(planID)!.version,
    action: "resume",
    taskID: attempt.task_id,
    reason: "Continue the retained dirty attempt after confirming the old process is interrupted",
  }
  const first = await f.runtime.command(resume, "owner")
  const replay = await f.runtime.command(resume, "owner")
  expect(replay).toEqual(first)
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    state: "preparing",
    session_id: attempt.session_id,
    workspace: originalWorkspace,
    base_commit: originalBase,
    policy: originalPolicy,
  })
  const resumedMessageID = f.store.attempts(planID)[0]!.message_id
  expect(resumedMessageID).not.toBe(originalMessageID)
  expect(
    (f.store.detail(planID).activity as { event: string }[]).filter(
      (entry) => entry.event === "ATTEMPT_RESUMED",
    ),
  ).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptCount)

  worker.background = {
    state: "observed",
    source: "experimental.idle",
    observedAt: Date.now(),
    inputID: attempt.message_id,
    executionStartSequence: 2,
    eventSequence: 3,
    count: 0,
    kinds: { shell: 0, subagent: 0, image: 0 },
  }
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptCount + 1)
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.message_id).toBe(resumedMessageID)
  expect(worker.model).toEqual(JSON.parse(originalPolicy).model)
  expect(readFileSync(join(originalWorkspace, "a.txt"), "utf8")).toBe("a")
  expect(git(originalWorkspace, ["status", "--porcelain"])).not.toBe("")
  expect(f.store.attempts(planID)[0]).toMatchObject({ token_count: 777, tool_count: 23, cost: 2.5 })

  f.completeWorker(worker.id, "succeeded")
  await drive(f.runtime, 4)
  expect(f.store.plan(planID)?.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.effects(planID).some((effect) => effect.kind === "verify:content")).toBe(true)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptCount + 1)
})

test("cancellation does not settle when foreground activity reappears during its detail read", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalSession = f.host.session
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: attempt.message_id, state: "interrupted" }
  await f.runtime.command(
    {
      requestID: "cancel-detail-race",
      planID,
      expectedVersion: f.store.plan(planID)!.version,
      action: "cancel",
    },
    "owner",
  )

  let raced = false
  f.host.session = async (id, options) => {
    const session = await originalSession(id, options)
    if (id === attempt.session_id && options?.messages && !raced && session) {
      raced = true
      worker.busy = true
      return { ...session, busy: true, observationUnstable: true }
    }
    return session
  }
  await f.runtime.tick()
  expect(raced).toBe(true)
  expect(f.store.plan(planID)?.state).toBe("cancelling")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("running")

  f.host.session = originalSession
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: attempt.message_id, state: "interrupted" }
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cancelled")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("cancelled")
})

async function prepareIdleArchitect(f: ReturnType<typeof fixture>, now: number, idleFor: number) {
  await runPlan(f)
  await drive(f.runtime, 2)
  const owner = f.sessions.get("owner")!
  owner.busy = false
  owner.idleAt = now - idleFor
  await f.runtime.recordArchitectContinuity(owner.id, {
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  return f.store.attempts(f.receipt.planID)[0]!
}

async function prepareSourceChangeFixture(now: number) {
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "source-notice.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  if (renewal.state !== "committed") throw new Error("Source fixture renewal did not commit")
  const input = {
    id: `msg_source_fixture_${now}`,
    type: "user",
    delivery: "queue",
    metadata: { source: "test" },
  }
  f.inbox.set(renewal.previous_session_id, [input])
  await f.runtime.tick()
  const pointer = f.store
    .architectSourceNoticeRows(renewal.previous_session_id)
    .find(
      (row) =>
        row.session_id === renewal.successor_session_id &&
        JSON.parse(row.payload).status === "architect-source-change",
    )
  if (!pointer) throw new Error("Source fixture compact pointer was not created")
  return { f, renewal, input, pointer }
}

function seedLegacySourceNotice(
  f: ReturnType<typeof fixture>,
  sourceSessionID: string,
  owner: string,
  options: { state?: string; suffix?: string; foreign?: boolean; queue?: boolean } = {},
) {
  const planID = f.receipt.planID
  const sourceRevision = f.store.architectSource(sourceSessionID)!.revision
  const outboxID = `legacy-source-reference-${options.suffix ?? "one"}`
  const messageID = `msg_legacy_source_reference_${options.suffix ?? "one"}`
  const payload = {
    status: "architect-source-reference",
    version: sourceRevision,
    sourceSessionID,
    sourceRevision,
    inputIDs: [{ id: `msg_old_${options.suffix ?? "one"}`, type: "user", disposition: "pending" }],
    results: [],
    planID,
  }
  const metadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: options.foreign ? "another-project" : "project",
    lazersProjectDirectory: f.repository.projectDirectory,
    lazersPlanID: planID,
    lazersOutboxID: outboxID,
    lazersMessageID: messageID,
    lazersSessionID: owner,
    lazersStatus: payload.status,
    lazersVersion: sourceRevision,
  }
  const receipt = JSON.stringify({
    history: [{ kind: "native-admission", sessionID: owner, messageID, retained: true }],
  })
  f.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_outbox(
           id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt
         ) VALUES(?,?,?,?,?,?,0,?,?)`,
      )
      .run(
        outboxID,
        planID,
        owner,
        messageID,
        JSON.stringify(payload),
        options.state ?? "admitted",
        JSON.stringify(metadata),
        receipt,
      ),
  )
  if (options.queue !== false) {
    f.inbox.set(owner, [
      ...(f.inbox.get(owner) ?? []),
      {
        id: messageID,
        type: "synthetic",
        delivery: "queue",
        metadata,
      },
    ])
  }
  return { outboxID, messageID, payload: JSON.stringify(payload), metadata, receipt }
}

function seedLargeLegacySourceNoticeBacklog(
  f: ReturnType<typeof fixture>,
  sourceSessionID: string,
  owner: string,
  count: number,
  options: {
    queue?: boolean
    payloadBytes?: number
    ownerForIndex?: (index: number) => string
  } = {},
) {
  const padding = "historical-source-notice-payload-"
    .repeat(Math.ceil((options.payloadBytes ?? 12_000) / 33))
    .slice(0, options.payloadBytes ?? 12_000)
  return Array.from({ length: count }, (_, index) => {
    const notice = seedLegacySourceNotice(
      f,
      sourceSessionID,
      options.ownerForIndex?.(index) ?? owner,
      {
        suffix: `large-${String(index).padStart(4, "0")}`,
        queue: options.queue,
      },
    )
    const payload = JSON.stringify({ ...JSON.parse(notice.payload), historicalPadding: padding })
    f.store.atomic((db) =>
      db.query("UPDATE runner_outbox SET payload=? WHERE id=?").run(payload, notice.outboxID),
    )
    return { ...notice, payload }
  })
}

function reconcileSourceNotice(
  f: ReturnType<typeof fixture>,
  owner: string,
  sourceSessionID: string,
  requestID: string,
) {
  const plan = f.store.plan(f.receipt.planID)!
  return f.runtime.command(
    {
      requestID,
      planID: plan.id,
      expectedVersion: plan.version,
      action: "reconcile-source-notices",
      sourceSessionID,
    },
    owner,
  )
}

test("normal source scans do not materialize historical notice payloads across a large multi-owner backlog", async () => {
  const now = 2_000_000_239_000
  const { f, renewal, input } = await prepareSourceChangeFixture(now)
  const owner = renewal.successor_session_id
  const backlog = seedLargeLegacySourceNoticeBacklog(f, renewal.previous_session_id, owner, 128, {
    queue: false,
    payloadBytes: 16_000,
    ownerForIndex: (index) => (index % 2 ? owner : "ses_retired_notice_owner"),
  })
  expect(backlog).toHaveLength(128)
  const backlogBytes = f.store.atomic(
    (db) =>
      db
        .query<{ payloadBytes: number }, [string, string]>(
          `SELECT sum(length(o.payload)) AS payloadBytes FROM runner_outbox o
         JOIN runner_plans p ON p.id=o.plan_id
         WHERE p.project_directory=? AND json_extract(o.payload,'$.sourceSessionID')=?
           AND json_extract(o.payload,'$.status')='architect-source-reference'`,
        )
        .get(f.repository.projectDirectory, renewal.previous_session_id)!.payloadBytes,
  )
  expect(backlogBytes).toBeGreaterThan(2_000_000)

  const readAll = f.store.architectSourceNoticeRows.bind(f.store)
  let historicalRowsRead = 0
  f.store.architectSourceNoticeRows = (sourceSessionID) => {
    historicalRowsRead++
    return readAll(sourceSessionID)
  }
  const changedInput = {
    id: "msg_normal_ensure_after_large_backlog",
    type: "user",
    delivery: "queue",
    metadata: { source: "normal-ensure-regression" },
  }
  f.inbox.set(renewal.previous_session_id, [input, changedInput])
  // F-S3-1: fake the native enqueue notification alongside the inbox mutation.
  f.runtime.observeArchitectSourceEvent(renewal.previous_session_id)
  await f.runtime.tick()

  expect(historicalRowsRead).toBe(0)
  expect(
    f.store.architectSourceInputs(renewal.previous_session_id).map((row) => row.message_id),
  ).toContain(changedInput.id)
  expect(
    f.store
      .architectCurrentSourceChangeNoticeRows(renewal.previous_session_id)
      .map((row) => row.session_id),
  ).toContain(owner)
})

test("legacy reconciliation resolves exact replacement IDs without loading its large historical payload backlog", async () => {
  const now = 2_000_000_239_500
  const { f, renewal } = await prepareSourceChangeFixture(now)
  const owner = renewal.successor_session_id
  const backlog = seedLargeLegacySourceNoticeBacklog(f, renewal.previous_session_id, owner, 96, {
    queue: true,
    payloadBytes: 12_000,
  })
  expect(backlog).toHaveLength(96)
  const backlogBytes = f.store.atomic(
    (db) =>
      db
        .query<{ payloadBytes: number }, [string, string]>(
          `SELECT sum(length(o.payload)) AS payloadBytes FROM runner_outbox o
         JOIN runner_plans p ON p.id=o.plan_id
         WHERE p.project_directory=? AND json_extract(o.payload,'$.sourceSessionID')=?
           AND json_extract(o.payload,'$.status')='architect-source-reference'`,
        )
        .get(f.repository.projectDirectory, renewal.previous_session_id)!.payloadBytes,
  )
  expect(backlogBytes).toBeGreaterThan(1_000_000)

  const readAll = f.store.architectSourceNoticeRows.bind(f.store)
  let historicalRowsRead = 0
  f.store.architectSourceNoticeRows = (sourceSessionID) => {
    historicalRowsRead++
    return readAll(sourceSessionID)
  }
  const result = (await reconcileSourceNotice(
    f,
    owner,
    renewal.previous_session_id,
    "reconcile-large-payload-backlog",
  )) as { results: Array<unknown> }
  expect(historicalRowsRead).toBe(0)
  expect(result).toMatchObject({
    status: "deferred",
    legacyNoticeCount: 96,
    processedLegacyNoticeCount: 20,
    remainingLegacyNoticeCount: 76,
  })
  expect(result.results).toHaveLength(20)
  expect(
    f.events.filter((event) => event.startsWith("cancel:msg_legacy_source_reference_large-")),
  ).toHaveLength(20)
  const first = f.store.atomic((db) =>
    db
      .query<{ state: string; payload: string; receipt: string }, [string]>(
        "SELECT state,payload,receipt FROM runner_outbox WHERE id=?",
      )
      .get(backlog[0]!.outboxID)!,
  )
  expect(first.state).toBe("superseded")
  expect(first.payload).toBe(backlog[0]!.payload)
  expect(JSON.parse(first.receipt).history[0]).toMatchObject({ kind: "native-admission" })
})

test("explicit reconciliation cancels disjoint equal-revision notices only after pointer coverage", async () => {
  const now = 2_000_000_240_000
  const { f, renewal, pointer } = await prepareSourceChangeFixture(now)
  const owner = renewal.successor_session_id
  const legacy = seedLegacySourceNotice(f, renewal.previous_session_id, owner)
  const secondLegacy = seedLegacySourceNotice(f, renewal.previous_session_id, owner, {
    suffix: "disjoint",
  })
  f.inbox.set(owner, [
    ...(f.inbox.get(owner) ?? []),
    { id: "msg_unrelated_user_input", type: "user", delivery: "queue" },
  ])
  f.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_outbox(
           id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt
         ) VALUES(?,?,?,?,?,'admitted',0,NULL,?)`,
      )
      .run(
        "independent-worker-outcome",
        f.receipt.planID,
        owner,
        "msg_independent_worker_outcome",
        JSON.stringify({ status: "task-accepted", taskID: "independent-task" }),
        JSON.stringify({ history: [{ kind: "native-admission", retained: true }] }),
      ),
  )
  const independentSnapshot = () =>
    (
      f.store.detail(f.receipt.planID).delivery as {
        id: string
        message_id: string
        state: string
        payload: string
        receipt: string | null
      }[]
    )
      .filter((row) => {
        const status = JSON.parse(row.payload).status
        return !["architect-source-reference", "architect-source-change"].includes(status)
      })
      .map(({ id, message_id, state, payload, receipt }) => ({
        id,
        message_id,
        state,
        payload,
        receipt,
      }))
  const baselineIndependent = independentSnapshot()
  const cancel = f.host.cancelOutcome!
  let entered!: () => void
  let release!: () => void
  const cancellationRead = new Promise<void>((resolve) => (entered = resolve))
  const gate = new Promise<void>((resolve) => (release = resolve))
  const outcomeInbox = f.host.outcomeInbox!
  f.host.outcomeInbox = async (sessionID) => {
    const entries = await outcomeInbox(sessionID)
    if (entries.some((entry) => [legacy.messageID, secondLegacy.messageID].includes(entry.id))) {
      entered()
      await gate
    }
    return entries
  }
  f.host.cancelOutcome = async (input) => {
    expect([legacy.messageID, secondLegacy.messageID]).toContain(input.inboxID)
    expect(f.inbox.get(owner)?.some((entry) => entry.id === pointer.message_id)).toBe(true)
    await cancel(input)
  }
  const first = reconcileSourceNotice(f, owner, renewal.previous_session_id, "reconcile-legacy-one")
  await cancellationRead
  const concurrent = await reconcileSourceNotice(
    f,
    owner,
    renewal.previous_session_id,
    "reconcile-legacy-concurrent",
  )
  expect(concurrent).toMatchObject({ status: "deferred" })
  release()
  const result = await first

  expect(result).toMatchObject({
    status: "reconciled",
    legacyNoticeCount: 2,
    processedLegacyNoticeCount: 2,
    remainingLegacyNoticeCount: 0,
    results: [
      {
        outboxID: legacy.outboxID,
        state: "superseded",
        disposition: "cancelled-and-read-back-absent",
      },
      {
        outboxID: secondLegacy.outboxID,
        state: "superseded",
        disposition: "cancelled-and-read-back-absent",
      },
    ],
  })
  for (const expected of [legacy, secondLegacy]) {
    const row = f.store
      .architectSourceNoticeRows(renewal.previous_session_id)
      .find((candidate) => candidate.id === expected.outboxID)!
    expect(row).toMatchObject({ message_id: expected.messageID, state: "superseded" })
    expect(row.payload).toBe(expected.payload)
    const receipt = JSON.parse(row.receipt!) as { history: Array<Record<string, unknown>> }
    expect(receipt.history[0]).toMatchObject({
      kind: "native-admission",
      sessionID: owner,
      messageID: expected.messageID,
      retained: true,
    })
    expect(receipt.history.map((entry) => entry.kind)).toContain(
      "source-notice-cancellation-confirmed-by-native-readback",
    )
    expect(f.inbox.get(owner)?.some((entry) => entry.id === expected.messageID)).toBe(false)
  }
  expect(independentSnapshot()).toEqual(baselineIndependent)
  expect(f.inbox.get(owner)?.some((entry) => entry.id === "msg_unrelated_user_input")).toBe(true)
  expect(
    f.events.filter((event) => event.startsWith("cancel:msg_legacy_source_reference")),
  ).toHaveLength(2)
})

test("foreign and ambiguously absent legacy notices remain visible and are never cancelled", async () => {
  const now = 2_000_000_241_000
  const { f, renewal } = await prepareSourceChangeFixture(now)
  const owner = renewal.successor_session_id
  const foreign = seedLegacySourceNotice(f, renewal.previous_session_id, owner, {
    suffix: "foreign",
    foreign: true,
  })
  const foreignResult = await reconcileSourceNotice(
    f,
    owner,
    renewal.previous_session_id,
    "reconcile-foreign-source",
  )
  expect(foreignResult).toMatchObject({ status: "deferred" })
  expect(foreignResult).toMatchObject({
    results: [
      {
        outboxID: foreign.outboxID,
        state: "ownership-unavailable",
        disposition: "ownership-unavailable",
      },
    ],
  })
  expect(
    f.store
      .architectSourceNoticeRows(renewal.previous_session_id)
      .find((row) => row.id === foreign.outboxID)?.payload,
  ).toBe(foreign.payload)
  expect(f.events).not.toContain(`cancel:${foreign.messageID}`)

  const absent = seedLegacySourceNotice(f, renewal.previous_session_id, owner, {
    suffix: "ambiguous",
    queue: false,
  })
  const absentResult = (await reconcileSourceNotice(
    f,
    owner,
    renewal.previous_session_id,
    "reconcile-ambiguous-absence",
  )) as { status: string; results: Array<{ outboxID: string; state: string; disposition: string }> }
  expect(absentResult).toMatchObject({ status: "deferred" })
  expect(absentResult.results).toContainEqual({
    outboxID: absent.outboxID,
    state: "unknown",
    disposition: "missing",
  })
  const absentRow = f.store
    .architectSourceNoticeRows(renewal.previous_session_id)
    .find((row) => row.id === absent.outboxID)!
  expect(absentRow.payload).toBe(absent.payload)
  expect(
    JSON.parse(absentRow.receipt!).history.map((entry: { kind: string }) => entry.kind),
  ).toContain("source-notice-absence-ambiguous")
  expect(f.events).not.toContain(`cancel:${absent.messageID}`)
})

test("source-notice cancellation API unavailability is recoverable without altering legacy receipts", async () => {
  const now = 2_000_000_242_000
  const { f, renewal } = await prepareSourceChangeFixture(now)
  const owner = renewal.successor_session_id
  const legacy = seedLegacySourceNotice(f, renewal.previous_session_id, owner)
  const cancel = f.host.cancelOutcome!
  f.host.cancelOutcome = undefined
  const deferred = await reconcileSourceNotice(
    f,
    owner,
    renewal.previous_session_id,
    "reconcile-without-cancel-api",
  )
  expect(deferred).toMatchObject({
    status: "deferred",
    results: [
      { outboxID: legacy.outboxID, state: "reconciling", disposition: "cancellation-unavailable" },
    ],
  })
  expect(f.inbox.get(owner)?.some((entry) => entry.id === legacy.messageID)).toBe(true)
  f.host.cancelOutcome = cancel
  const recovered = await reconcileSourceNotice(
    f,
    owner,
    renewal.previous_session_id,
    "retry-with-cancel-api",
  )
  expect(recovered).toMatchObject({
    status: "reconciled",
    results: [{ outboxID: legacy.outboxID, state: "superseded" }],
  })
  const finalRow = f.store
    .architectSourceNoticeRows(renewal.previous_session_id)
    .find((row) => row.id === legacy.outboxID)!
  expect(finalRow.payload).toBe(legacy.payload)
  expect(JSON.parse(finalRow.receipt!).history[0]).toEqual(JSON.parse(legacy.receipt).history[0])
  expect(f.inbox.get(owner)?.some((entry) => entry.id === legacy.messageID)).toBe(false)
})

test("source-notice reconciliation processes only a bounded batch and resumes remaining legacy notices", async () => {
  const now = 2_000_000_242_500
  const { f, renewal } = await prepareSourceChangeFixture(now)
  const owner = renewal.successor_session_id
  const legacy = Array.from({ length: 21 }, (_, index) =>
    seedLegacySourceNotice(f, renewal.previous_session_id, owner, {
      suffix: `bounded-${String(index).padStart(2, "0")}`,
    }),
  )
  const first = await reconcileSourceNotice(
    f,
    owner,
    renewal.previous_session_id,
    "reconcile-bounded-first-page",
  )
  expect(first).toMatchObject({
    status: "deferred",
    legacyNoticeCount: 21,
    processedLegacyNoticeCount: 20,
    remainingLegacyNoticeCount: 1,
  })
  const firstPageRows = f.store.architectLegacySourceNoticePage(renewal.previous_session_id, 20)
  expect(firstPageRows.total).toBe(1)
  expect(firstPageRows.rows).toHaveLength(1)
  expect(firstPageRows.rows[0]?.id).toBe(legacy[20]?.outboxID)

  const second = await reconcileSourceNotice(
    f,
    owner,
    renewal.previous_session_id,
    "reconcile-bounded-second-page",
  )
  expect(second).toMatchObject({
    status: "reconciled",
    legacyNoticeCount: 1,
    processedLegacyNoticeCount: 1,
    remainingLegacyNoticeCount: 0,
  })
  for (const expected of legacy) {
    const row = f.store
      .architectSourceNoticeRows(renewal.previous_session_id)
      .find((candidate) => candidate.id === expected.outboxID)!
    expect(row).toMatchObject({ message_id: expected.messageID, state: "superseded" })
    expect(row.payload).toBe(expected.payload)
    expect(JSON.parse(row.receipt!).history[0]).toMatchObject({
      kind: "native-admission",
      messageID: expected.messageID,
    })
  }
  expect(
    f.events.filter((event) => event.startsWith("cancel:msg_legacy_source_reference")),
  ).toHaveLength(21)
})

test("reconciliation keeps separate current-owner pointers and receipts for multiple retained sources", async () => {
  const now = 2_000_000_242_625
  const { f, renewal: firstRenewal, pointer: firstPointer } = await prepareSourceChangeFixture(now)
  const firstOwner = firstRenewal.successor_session_id
  const firstOwnerSession = f.sessions.get(firstOwner)!
  f.inbox.set(
    firstOwner,
    (f.inbox.get(firstOwner) ?? []).filter((entry) => entry.id !== firstPointer.message_id),
  )
  firstOwnerSession.messages.push({
    id: firstPointer.message_id,
    type: "synthetic",
    text: "The first source pointer was read.",
    metadata: JSON.parse(firstPointer.metadata!),
  })
  firstOwnerSession.busy = false
  firstOwnerSession.idleAt = now - 1_000
  await f.runtime.tick()
  const secondRenewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(secondRenewal.state).toBe("committed")
  expect(secondRenewal.previous_session_id).toBe(firstOwner)
  const currentOwner = secondRenewal.successor_session_id

  f.inbox.set(firstOwner, [{ id: "msg_second_source_input", type: "user", delivery: "queue" }])
  f.runtime.observeArchitectSourceEvent(firstOwner)
  await f.runtime.tick()
  for (const sourceSessionID of [
    firstRenewal.previous_session_id,
    secondRenewal.previous_session_id,
  ]) {
    const pointers = f.store
      .architectSourceNoticeRows(sourceSessionID)
      .filter((row) => row.session_id === currentOwner)
      .filter((row) => JSON.parse(row.payload).status === "architect-source-change")
    expect(pointers).toHaveLength(1)
    const legacy = seedLegacySourceNotice(f, sourceSessionID, currentOwner, {
      suffix: `multi-${sourceSessionID}`,
    })
    const result = await reconcileSourceNotice(
      f,
      currentOwner,
      sourceSessionID,
      `reconcile-${sourceSessionID}`,
    )
    expect(result).toMatchObject({ status: "reconciled", legacyNoticeCount: 1 })
    const row = f.store
      .architectSourceNoticeRows(sourceSessionID)
      .find((candidate) => candidate.id === legacy.outboxID)!
    expect(row).toMatchObject({ state: "superseded", message_id: legacy.messageID })
    expect(row.payload).toBe(legacy.payload)
  }
  expect(
    f.inbox
      .get(currentOwner)
      ?.filter((entry) => entry.metadata?.lazersStatus === "architect-source-change"),
  ).toHaveLength(2)
})

test("lost native cancellation response remains unknown and never becomes a false cancellation claim", async () => {
  const now = 2_000_000_242_750
  const { f, renewal } = await prepareSourceChangeFixture(now)
  const owner = renewal.successor_session_id
  const legacy = seedLegacySourceNotice(f, renewal.previous_session_id, owner)
  const cancel = f.host.cancelOutcome!
  f.host.cancelOutcome = async (input) => {
    await cancel(input)
    throw new Error("native cancellation response was lost")
  }
  const result = await reconcileSourceNotice(
    f,
    owner,
    renewal.previous_session_id,
    "reconcile-lost-cancel-response",
  )
  expect(result).toMatchObject({
    status: "deferred",
    results: [
      { outboxID: legacy.outboxID, state: "unknown", disposition: "cancel-failed-missing" },
    ],
  })
  const row = f.store
    .architectSourceNoticeRows(renewal.previous_session_id)
    .find((candidate) => candidate.id === legacy.outboxID)!
  expect(row).toMatchObject({
    state: "unknown",
    message_id: legacy.messageID,
    payload: legacy.payload,
  })
  const history = JSON.parse(row.receipt!).history as Array<{ kind: string }>
  expect(history[0]?.kind).toBe("native-admission")
  expect(history.map((entry) => entry.kind)).toContain(
    "source-notice-cancellation-absence-ambiguous",
  )
  expect(history.map((entry) => entry.kind)).not.toContain(
    "source-notice-cancellation-confirmed-by-native-readback",
  )
  expect(f.inbox.get(owner)?.some((entry) => entry.id === legacy.messageID)).toBe(false)
  expect(f.events.filter((event) => event === `cancel:${legacy.messageID}`)).toHaveLength(1)
})

test("ownership changes during native observation defer cancellation and establish a pointer for the new owner", async () => {
  const now = 2_000_000_243_000
  const { f, renewal } = await prepareSourceChangeFixture(now)
  const owner = renewal.successor_session_id
  const legacy = seedLegacySourceNotice(f, renewal.previous_session_id, owner)
  const nextOwner = "owner_after_source_notice_race"
  f.sessions.set(nextOwner, {
    ...structuredClone(f.sessions.get(owner)!),
    id: nextOwner,
  })
  const outcomeInbox = f.host.outcomeInbox!
  let transferred = false
  let legacyReads = 0
  f.host.outcomeInbox = async (sessionID) => {
    const entries = await outcomeInbox(sessionID)
    if (entries.some((entry) => entry.id === legacy.messageID)) legacyReads++
    if (!transferred && legacyReads > 1) {
      transferred = f.store.updatePlanOwner(f.receipt.planID, owner, nextOwner)
    }
    return entries
  }
  await expect(
    reconcileSourceNotice(f, owner, renewal.previous_session_id, "owner-changes-during-read"),
  ).rejects.toThrow("Stale plan version")
  expect(transferred).toBe(true)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(nextOwner)
  expect(f.inbox.get(owner)?.some((entry) => entry.id === legacy.messageID)).toBe(true)
  expect(f.events).not.toContain(`cancel:${legacy.messageID}`)
  const legacyRow = f.store
    .architectSourceNoticeRows(renewal.previous_session_id)
    .find((row) => row.id === legacy.outboxID)!
  expect(legacyRow).toMatchObject({ state: "reconciling", payload: legacy.payload })
  const pointers = f.store
    .architectSourceNoticeRows(renewal.previous_session_id)
    .filter((row) => row.session_id === nextOwner)
    .filter((row) => JSON.parse(row.payload).status === "architect-source-change")
  expect(pointers).toHaveLength(1)
})

test("source-notice cancellation racing with consumption records consumption, not cancellation", async () => {
  const now = 2_000_000_244_000
  const { f, renewal } = await prepareSourceChangeFixture(now)
  const owner = renewal.successor_session_id
  const legacy = seedLegacySourceNotice(f, renewal.previous_session_id, owner)
  f.host.cancelOutcome = async () => {
    f.inbox.set(
      owner,
      (f.inbox.get(owner) ?? []).filter((entry) => entry.id !== legacy.messageID),
    )
    f.sessions.get(owner)!.messages.push({
      id: legacy.messageID,
      type: "synthetic",
      metadata: legacy.metadata,
      text: "The legacy source notice was consumed during cancellation.",
    })
    throw new Error("cancel response lost during native consumption")
  }
  const result = await reconcileSourceNotice(
    f,
    owner,
    renewal.previous_session_id,
    "reconcile-consumption-race",
  )
  expect(result).toMatchObject({
    status: "reconciled",
    results: [
      { outboxID: legacy.outboxID, state: "consumed", disposition: "cancel-failed-consumed" },
    ],
  })
  const row = f.store
    .architectSourceNoticeRows(renewal.previous_session_id)
    .find((candidate) => candidate.id === legacy.outboxID)!
  expect(row).toMatchObject({ state: "consumed", payload: legacy.payload })
  expect(JSON.parse(row.receipt!).history.map((entry: { kind: string }) => entry.kind)).toContain(
    "source-notice-cancellation-raced-with-consumption",
  )
  expect(
    JSON.parse(row.receipt!).history.map((entry: { kind: string }) => entry.kind),
  ).not.toContain("source-notice-cancellation-confirmed-by-native-readback")
})

test("the registered scheduler reuses recent/busy Architects and renews at the default threshold", async () => {
  const now = 2_000_000_000_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  expect(architectIdleWindowMs(undefined)).toBe(30 * 60 * 1000)
  expect(DEFAULT_ARCHITECT_IDLE_WINDOW_MS).toBe(30 * 60 * 1000)
  expect(() => architectIdleWindowMs(0)).toThrow("positive integer")
  const attempt = await prepareIdleArchitect(f, now, 0)
  const owner = f.sessions.get("owner")!
  owner.messages.push({ id: "old-transcript", text: "SECRET_TRANSCRIPT_SHOULD_NOT_REPLAY" })
  await f.runtime.recordArchitectContinuity(owner.id, {
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  owner.idleAt = now - DEFAULT_ARCHITECT_IDLE_WINDOW_MS + 1

  await f.runtime.tick()
  expect(f.store.architectRenewalsNeedingRecovery()).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(0)
  expect(owner.archived).toBe(false)

  owner.idleAt = now - DEFAULT_ARCHITECT_IDLE_WINDOW_MS
  const peer = new TaskRuntime(f.store, f.host, "project", undefined, {
    architectPromptHook: true,
    now: () => now,
  })
  cleanup.push(() => peer.stop())
  const createInputs: Parameters<RunnerHost["createArchitect"]>[0][] = []
  const create = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    createInputs.push(input)
    await create(input)
  }
  const update = f.host.updateSession!
  let archiveSawDurableTransfer = false
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
      const handoff = f.store
        .outboxForDelivery()
        .find((row) => row.id === renewal.handoff_outbox_id)
      expect(renewal.state).toBe("archiving")
      expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
      expect(handoff?.state).toBe("pending")
      archiveSawDurableTransfer = true
    }
    await update(input)
  }

  await Promise.all([f.runtime.tick(), peer.tick()])

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successor = f.sessions.get(renewal.successor_session_id)!
  expect(renewal.state).toBe("committed")
  expect(archiveSawDurableTransfer).toBe(true)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successor.id)
  expect(owner.archived).toBe(true)
  expect(successor.parentID).toBeUndefined()
  expect(successor.model).toEqual(owner.model)
  expect(f.store.architectContinuity(successor.id)).toMatchObject({
    revision: 2,
    decisions: JSON.stringify(["Keep the existing approved implementation direction."]),
    unresolved_questions: JSON.stringify(["Confirm whether the follow-up needs additional scope."]),
  })
  expect(successor.metadata?.lazersPlanID).toBe(f.receipt.planID)
  expect(successor.metadata?.lazersPlanIDs).toContain(f.receipt.planID)
  expect(createInputs).toHaveLength(1)
  expect(createInputs[0]).toMatchObject({
    planID: f.receipt.planID,
    sourceSessionID: "owner",
    title: expect.stringContaining("Implement a"),
    model: owner.model,
  })
  expect(f.store.attempts(f.receipt.planID)[0]?.session_id).toBe(attempt.session_id)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  expect(owner.messages).toEqual([
    { id: "old-transcript", text: "SECRET_TRANSCRIPT_SHOULD_NOT_REPLAY" },
  ])
  await f.runtime.tick()
  const wake = f.notifications.find(
    (notice) =>
      notice.sessionID === successor.id && notice.text.includes("Architect continuity handoff"),
  )!
  expect(wake.text).toContain("lz-inspect-plan")
  expect(wake.text).toContain("Keep the existing approved implementation direction.")
  expect(wake.text).toContain("Confirm whether the follow-up needs additional scope.")
  expect(wake.text).not.toContain("SECRET_TRANSCRIPT_SHOULD_NOT_REPLAY")
  expect(f.inbox.get(successor.id)).toHaveLength(2)
  expect(
    f.notifications.find(
      (notice) =>
        notice.sessionID === successor.id &&
        notice.text.includes("LAZERS Architect source changed"),
    ),
  ).toMatchObject({
    resume: false,
  })
  expect(f.store.architectSourceInputs("owner").map((input) => input.message_id)).toContain(
    "old-transcript",
  )
  expect(wake.resume).toBe(true)
  const committed = f.store.latestTransition<{ wakeContext: { bytes: number; tokens: null } }>(
    f.receipt.planID,
    null,
    "ARCHITECT_RENEWAL_COMMITTED",
  )!
  expect(committed.wakeContext.bytes).toBe(new TextEncoder().encode(wake.text).byteLength)
  expect(committed.wakeContext.tokens).toBeNull()
  expect(committed.wakeContext.bytes).toBeGreaterThan(0)
})

test("idle-window overrides, busy sessions, unsupported hooks, and pre-create input fail closed", async () => {
  const now = 2_000_000_100_000
  expect(architectIdleWindowMs(5_000)).toBe(5_000)

  const overridden = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 5_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(overridden, now, 4_999)
  await overridden.runtime.tick()
  expect(overridden.events.filter((event) => event.startsWith("create-architect:")).length).toBe(0)
  overridden.sessions.get("owner")!.idleAt = now - 5_000
  await overridden.runtime.tick()
  expect(overridden.store.architectRenewalForPlan(overridden.receipt.planID)?.state).toBe(
    "committed",
  )

  for (const scenario of ["busy", "unsupported-hook", "input-before-create"] as const) {
    const f = fixture({
      delayed: true,
      architectPromptHook: scenario !== "unsupported-hook",
      architectIdleWindowMs: 5_000,
      now: () => now,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    await prepareIdleArchitect(f, now, 5_000)
    const owner = f.sessions.get("owner")!
    if (scenario === "busy") owner.busy = true
    if (scenario === "input-before-create") {
      await f.runtime.observeArchitectPrompt(owner.id, "pre-create-user-message")
      await f.runtime.observeArchitectPrompt(owner.id, "pre-create-user-message")
      expect(
        f.store.atomic(
          (db) =>
            db
              .query<{ count: number }, [string]>(
                "SELECT count(*) AS count FROM runner_architect_inputs WHERE session_id=?",
              )
              .get(owner.id)!.count,
        ),
      ).toBe(1)
    }
    await f.runtime.tick()
    expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(0)
    expect(f.events.filter((event) => event.startsWith("update-session:")).length).toBe(0)
    expect(owner.archived).toBe(false)
  }
})

test("renewal requires an explicit checkpoint and retains queued native inputs by ID", async () => {
  const now = 2_000_000_125_000
  const missingCheckpoint = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(missingCheckpoint)
  await drive(missingCheckpoint.runtime, 2)
  missingCheckpoint.sessions.get("owner")!.idleAt = now - 1_000
  await missingCheckpoint.runtime.tick()
  expect(
    missingCheckpoint.store.architectRenewalForPlan(missingCheckpoint.receipt.planID),
  ).toBeNull()
  expect(missingCheckpoint.events.some((event) => event.startsWith("create-architect:"))).toBe(
    false,
  )
  expect(missingCheckpoint.sessions.get("owner")?.archived).toBe(false)

  const reconciledHost = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(reconciledHost, now, 1_000)
  const foreign = {
    id: "msg_external_queue_before_creation",
    type: "synthetic",
    delivery: "queue",
    metadata: { source: "another-plugin" },
  }
  reconciledHost.inbox.set("owner", [foreign])
  await reconciledHost.runtime.tick()
  const renewal = reconciledHost.store.architectRenewalForPlan(reconciledHost.receipt.planID)!
  expect(renewal.state).toBe("committed")
  expect(reconciledHost.store.plan(reconciledHost.receipt.planID)?.owner).toBe(
    renewal.successor_session_id,
  )
  expect(
    reconciledHost.events.filter((event) => event === "update-session:owner:true"),
  ).toHaveLength(1)
  expect(reconciledHost.inbox.get("owner")).toEqual([foreign])
  expect(reconciledHost.sessions.get("owner")?.archived).toBe(true)
  expect(reconciledHost.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: foreign.id, disposition: "pending" }),
  )
  expect(
    reconciledHost.notifications.some((notification) =>
      notification.text.includes("LAZERS Architect source changed"),
    ),
  ).toBe(true)
  expect(
    reconciledHost.notifications.some((notification) => notification.text.includes(foreign.id)),
  ).toBe(false)
})

test("one successor receives every live plan owned by the same Architect", async () => {
  const now = 2_000_000_150_000
  const f = fixture({
    delayed: true,
    independent: true,
    architectPromptHook: true,
    architectIdleWindowMs: 5_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a/a.txt" }],
  })
  const taskB = f.createTask("b", "b/b.txt")
  const planB = f.store.submit(f.inputFor([taskB], { requestID: "second-owner-plan" }), "owner")
  await runPlan(f)
  await runPlan(f, planB.planID, "run-second-owner-plan")
  await drive(f.runtime, 2)
  await f.runtime.recordArchitectContinuity("owner", {
    decisions: ["Keep both task plans under the current Architect."],
    unresolvedQuestions: ["Confirm cross-plan ordering after integration."],
  })
  const attempts = [f.store.attempts(f.receipt.planID)[0]!, f.store.attempts(planB.planID)[0]!]
  expect(attempts.every((attempt) => f.sessions.get(attempt.session_id)?.busy)).toBe(true)
  f.sessions.get("owner")!.idleAt = now - 5_000

  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successor = f.sessions.get(renewal.successor_session_id)!
  expect(renewal.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successor.id)
  expect(f.store.plan(planB.planID)?.owner).toBe(successor.id)
  expect(successor.metadata?.lazersPlanIDs).toEqual([f.receipt.planID, planB.planID].sort())
  expect(f.store.continuation(f.receipt.planID)?.session_id).toBe(successor.id)
  expect(f.store.continuation(planB.planID)?.session_id).toBe(successor.id)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
  expect(attempts.map((attempt) => f.store.attempts(attempt.plan_id)[0]?.session_id)).toEqual(
    attempts.map((attempt) => attempt.session_id),
  )
  expect(attempts.every((attempt) => f.sessions.get(attempt.session_id)?.busy)).toBe(true)
  const handoff = f.store
    .outboxForDelivery()
    .find((row) => JSON.parse(row.payload).status === "architect-handoff")!
  expect(JSON.parse(handoff.payload).planIDs).toEqual([f.receipt.planID, planB.planID].sort())
  expect(JSON.parse(handoff.payload).continuity).toEqual({
    revision: 1,
    decisions: ["Keep both task plans under the current Architect."],
    unresolvedQuestions: ["Confirm cross-plan ordering after integration."],
  })
})

test("input during a deferred native create prevents transfer and predecessor archival", async () => {
  const now = 2_000_000_200_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const create = f.host.createArchitect
  let startCreate!: () => void
  let releaseCreate!: () => void
  const started = new Promise<void>((resolve) => (startCreate = resolve))
  const gate = new Promise<void>((resolve) => (releaseCreate = resolve))
  f.host.createArchitect = async (input) => {
    startCreate()
    await gate
    await create(input)
  }

  const tick = f.runtime.tick()
  await started
  await f.runtime.observeArchitectPrompt("owner", "input-during-create")
  f.sessions.get("owner")!.messages.push({ id: "input-during-create", text: "Keep this input" })
  releaseCreate()
  await tick

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("deferred")
  expect(renewal.input_message_id).toBe("input-during-create")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(f.events.filter((event) => event.startsWith("update-session:")).length).toBe(0)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("a continuity edit during successor creation blocks stale ownership transfer", async () => {
  const now = 2_000_000_205_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const create = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    await create(input)
    await f.runtime.recordArchitectContinuity("owner", {
      decisions: ["Use the revised approved direction."],
      unresolvedQuestions: ["Confirm the revised rollout."],
    })
  }

  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("deferred")
  expect(renewal.error).toContain("continuity changed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(f.store.architectContinuity("owner")).toMatchObject({
    revision: 2,
    decisions: JSON.stringify(["Use the revised approved direction."]),
    unresolved_questions: JSON.stringify(["Confirm the revised rollout."]),
  })
  expect(f.store.architectContinuity(renewal.successor_session_id)).toBeNull()
  expect(f.notifications).toHaveLength(0)
})

test("native queued synthetic input is retained and referenced across creation, transfer, and archive", async () => {
  const phases = ["creation", "transfer", "archive"] as const
  for (const [index, phase] of phases.entries()) {
    const now = 2_000_000_210_000 + index * 10_000
    const f = fixture({
      delayed: true,
      architectPromptHook: true,
      architectIdleWindowMs: 1_000,
      now: () => now,
      taskFiles: [{ name: "a", path: `a-${phase}.txt` }],
    })
    await prepareIdleArchitect(f, now, 1_000)
    const foreign = {
      id: `msg_synthetic_${phase}`,
      type: "synthetic",
      delivery: "queue",
      metadata: { source: "another-plugin" },
    }
    if (phase === "creation") {
      const create = f.host.createArchitect
      f.host.createArchitect = async (input) => {
        await create(input)
        f.inbox.set("owner", [foreign])
      }
    } else if (phase === "transfer") {
      const transfer = f.store.transferArchitectRenewal.bind(f.store)
      f.store.transferArchitectRenewal = (input) => {
        const result = transfer(input)
        f.inbox.set("owner", [foreign])
        return result
      }
    } else {
      const update = f.host.updateSession!
      f.host.updateSession = async (input) => {
        if (input.sessionID === "owner" && input.archived) f.inbox.set("owner", [foreign])
        await update(input)
      }
    }

    await f.runtime.tick()

    const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
    expect(renewal.state).toBe("committed")
    expect(f.inbox.get("owner")).toEqual([foreign])
    expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
    expect(f.sessions.get("owner")?.archived).toBe(true)
    expect(f.store.architectRenewalHasInput(renewal.id)).toBe(true)
    expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(1)
    expect(
      (f.store.detail(f.receipt.planID).delivery as { state: string; payload: string }[]).find(
        (row) => JSON.parse(row.payload).status === "architect-handoff",
      )?.state,
    ).toBe("admitted")
    expect(
      f.notifications.some((notification) =>
        notification.text.includes("LAZERS Architect source changed"),
      ),
    ).toBe(true)
    expect(f.notifications.some((notification) => notification.text.includes(foreign.id))).toBe(
      false,
    )
    expect(f.store.architectSourceInputs("owner").map((input) => input.message_id)).toContain(
      foreign.id,
    )
  }
})

test("late input on an archived predecessor is reconciled to the current owner without waking or replay", async () => {
  const now = 2_000_000_275_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "late-input.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const currentOwner = renewal.successor_session_id
  expect(renewal.state).toBe("committed")
  expect(f.sessions.get("owner")?.archived).toBe(true)

  const late = {
    id: "msg_late_after_archive",
    type: "synthetic",
    delivery: "queue",
    metadata: { source: "another-plugin" },
  }
  f.inbox.set("owner", [late])
  const before = f.notifications.length
  await f.runtime.tick()

  expect(f.store.plan(f.receipt.planID)?.owner).toBe(currentOwner)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.inbox.get("owner")).toEqual([late])
  expect(f.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: late.id, disposition: "pending" }),
  )
  const sourceChange = f.notifications
    .slice(before)
    .find((notification) => notification.text.includes("LAZERS Architect source changed"))
  if (sourceChange) expect(sourceChange).toMatchObject({ sessionID: currentOwner, resume: false })
  expect(
    f.inbox
      .get(currentOwner)
      ?.filter((entry) => entry.metadata?.lazersStatus === "architect-source-change"),
  ).toHaveLength(1)
  expect(
    f.notifications.slice(before).some((notification) => notification.text.includes(late.id)),
  ).toBe(false)
  await f.runtime.tick()
  expect(
    f.inbox
      .get(currentOwner)
      ?.filter((entry) => entry.metadata?.lazersStatus === "architect-source-change"),
  ).toHaveLength(1)
})

test("predecessor reconciliation persists native message pagination across scheduler ticks", async () => {
  const now = 2_000_000_280_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "paged-source.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const pages: (string | undefined)[] = []
  f.host.architectInputPage = async (_sessionID, cursor) => {
    pages.push(cursor)
    return cursor
      ? {
          inbox: [],
          messages: [{ id: "msg_page_two_input", type: "user" }],
          nextCursor: null,
        }
      : { inbox: [], messages: [], nextCursor: "page-two" }
  }

  await f.runtime.tick()
  expect(f.store.architectSource(renewal.previous_session_id)?.scan_cursor).toBe("page-two")
  expect(f.store.architectSourceInputs(renewal.previous_session_id)).not.toContainEqual(
    expect.objectContaining({ message_id: "msg_page_two_input" }),
  )
  await f.runtime.tick()

  expect(pages).toEqual([undefined, "page-two"])
  expect(f.store.architectSource(renewal.previous_session_id)?.scan_cursor).toBeNull()
  expect(f.store.architectSourceInputs(renewal.previous_session_id)).toContainEqual(
    expect.objectContaining({ message_id: "msg_page_two_input", disposition: "delivered" }),
  )
  expect(
    f.notifications.some(
      (notification) =>
        notification.sessionID === renewal.successor_session_id &&
        notification.text.includes("LAZERS Architect source changed"),
    ),
  ).toBe(true)
  expect(
    f.notifications.some((notification) => notification.text.includes("msg_page_two_input")),
  ).toBe(false)
})

test("selected source-message retrieval is current-owner authorized and journal-ID bounded", async () => {
  const now = 2_000_000_280_500
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "selected-source-message.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  f.host.architectInputPage = async () => ({
    inbox: [],
    messages: [
      { id: "msg_selected_source_input", type: "user" },
      {
        id: "msg_selected_source_result",
        type: "assistant",
        result: {
          state: "completed",
          finish: "stop",
          toolCounts: { running: 0, completed: 1, failed: 0, other: 0 },
        },
      },
    ],
    nextCursor: null,
  })
  await f.runtime.tick()
  const calls: string[] = []
  f.host.architectSourceMessage = async (sessionID, messageID) => {
    calls.push(`${sessionID}:${messageID}`)
    return {
      id: messageID,
      type: messageID.endsWith("input") ? "user" : "assistant",
      text: messageID.endsWith("input") ? "selected safe input" : "selected safe result",
      privacy: { ...privacyStats() },
    }
  }
  const response = await f.runtime.inspectArchitectSourceMessages(
    {
      planID: f.receipt.planID,
      view: "source-messages",
      sourceSessionID: renewal.previous_session_id,
      messageIDs: ["msg_selected_source_input", "msg_selected_source_result"],
    },
    renewal.successor_session_id,
  )
  expect(calls).toEqual(["owner:msg_selected_source_input", "owner:msg_selected_source_result"])
  expect(response).toMatchObject({
    mode: "source-messages",
    selected: 2,
    coverage: {
      authenticatedNativeRead: true,
      privacyFiltered: true,
      transcriptCompleteness: "unknown",
      nativeConsumption: "unknown",
    },
    messages: [
      { id: "msg_selected_source_input", kind: "input", type: "user" },
      { id: "msg_selected_source_result", kind: "result", type: "assistant" },
    ],
  })
  await expect(
    f.runtime.inspectArchitectSourceMessages(
      {
        planID: f.receipt.planID,
        view: "source-messages",
        sourceSessionID: renewal.previous_session_id,
        messageIDs: ["msg_not_in_journal"],
      },
      renewal.successor_session_id,
    ),
  ).rejects.toThrow("Every selected message ID must identify a journaled source input or result")
  await expect(
    f.runtime.inspectArchitectSourceMessages(
      {
        planID: f.receipt.planID,
        view: "source-messages",
        sourceSessionID: renewal.previous_session_id,
        messageIDs: ["msg_selected_source_input"],
      },
      "owner",
    ),
  ).rejects.toThrow("current plan owner")
})

test("large predecessor histories coalesce to a compact progressive source-change pointer", async () => {
  const now = 2_000_000_281_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "bounded-references.txt" }],
  })
  const ids = Array.from(
    { length: 45 },
    (_, index) => `msg_reference_${index.toString().padStart(2, "0")}`,
  )
  f.host.architectInputPage = async () => ({
    inbox: [],
    messages: ids.map((id) => ({ id, type: "user" })),
    nextCursor: null,
  })
  await prepareIdleArchitect(f, now, 1_000)

  await f.runtime.tick()
  let rows = f.store.detail(f.receipt.planID).delivery as { payload: string }[]
  let notices = rows
    .map((row) => JSON.parse(row.payload))
    .filter((payload) => payload.status === "architect-source-change")
  expect(notices).toHaveLength(1)
  expect(JSON.stringify(notices)).not.toContain(ids[0]!)
  expect(JSON.stringify(notices)).not.toContain("inputIDs")
  expect(JSON.stringify(notices)).not.toContain("results")
  expect(JSON.stringify(notices).length).toBeLessThan(600)
  await f.runtime.tick()
  await f.runtime.tick()

  rows = f.store.detail(f.receipt.planID).delivery as { payload: string }[]
  notices = rows
    .map((row) => JSON.parse(row.payload))
    .filter((payload) => payload.status === "architect-source-change")
  expect(notices).toHaveLength(1)
  const handoff = rows
    .map((row) => JSON.parse(row.payload))
    .find((payload) => payload.status === "architect-handoff")
  expect(handoff).not.toHaveProperty("inputSources")
  expect(
    f.notifications.filter((notification) =>
      notification.text.includes("LAZERS Architect source changed"),
    ),
  ).toHaveLength(1)
  expect(f.notifications.some((notification) => notification.text.includes(ids[0]!))).toBe(false)
  const journal = f.store.architectSourceJournalPage(f.receipt.planID, 100)
  expect(journal.page.hasMore).toBe(false)
  expect(journal.records).toHaveLength(46)
  expect(
    journal.records.some((record) => record.kind === "input" && record.messageID === ids[0]),
  ).toBe(true)
})

test("a previously seen pending input that disappears without history stays unknown, never cancelled or replayed", async () => {
  const now = 2_000_000_282_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "unknown-input.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const late = {
    id: "msg_disappeared_without_transcript",
    type: "user",
    delivery: "queue",
  }
  f.inbox.set("owner", [late])
  await f.runtime.tick()
  expect(f.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: late.id, disposition: "pending" }),
  )

  f.inbox.set("owner", [])
  // F-S3-1: the native cancellation invalidates a completed source scan.
  f.runtime.observeArchitectSourceEvent("owner")
  await f.runtime.tick()

  expect(f.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: late.id, disposition: "unknown" }),
  )
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.notifications.some((notification) => notification.text.includes(late.id))).toBe(false)
  expect(f.notifications.some((notification) => notification.text.includes("source changed"))).toBe(
    true,
  )
  expect(f.notifications.at(-1)?.resume).toBe(false)
})

test("generated renewal notifications are authenticated and do not form A-to-B-to-C input loops", async () => {
  const now = 2_000_000_284_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "notification-loop.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const first = f.store.architectRenewalForPlan(f.receipt.planID)!
  const middle = f.sessions.get(first.successor_session_id)!
  expect(f.inbox.get(middle.id)).toHaveLength(1)

  middle.idleAt = now - 1_000
  await f.runtime.tick()
  const second = f.store.architectRenewalForSource(middle.id)!

  expect(second.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(second.successor_session_id)
  expect(f.store.architectSourceInputs(middle.id)).toHaveLength(0)
  expect(f.inbox.get(middle.id)).toHaveLength(0)
  expect(
    f.notifications.filter((notification) =>
      notification.text.includes("retained Architect input update"),
    ),
  ).toHaveLength(0)
})

test("a retired Architect predecessor cannot reclaim a transferred plan through reassign", async () => {
  const now = 2_000_000_285_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "reassign.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const plan = f.store.plan(f.receipt.planID)!
  f.sessions.set("active-target", {
    ...f.sessions.get(renewal.successor_session_id)!,
    id: "active-target",
    parentID: undefined,
    metadata: {},
  })
  const reassign = {
    requestID: "retired-predecessor-reassign",
    planID: plan.id,
    expectedVersion: plan.version,
    action: "reassign",
    targetSessionID: "active-target",
    reason: "Test the retired-owner guard",
  }

  await expect(f.runtime.command(reassign, "owner")).rejects.toThrow(
    "retired Architect predecessor",
  )
  expect(f.store.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  await f.runtime.command(
    { ...reassign, requestID: "active-owner-reassign" },
    renewal.successor_session_id,
  )
  expect(f.store.plan(plan.id)?.owner).toBe("active-target")
})

test("input racing native archival remains on the retained source and is referenced to the new owner", async () => {
  const now = 2_000_000_300_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  let startArchive!: () => void
  let releaseArchive!: () => void
  const started = new Promise<void>((resolve) => (startArchive = resolve))
  const gate = new Promise<void>((resolve) => (releaseArchive = resolve))
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      startArchive()
      await gate
    }
    await update(input)
  }

  const tick = f.runtime.tick()
  await started
  await f.runtime.observeArchitectPrompt("owner", "input-during-archive")
  f.sessions.get("owner")!.messages.push({ id: "input-during-archive", text: "Keep this input" })
  releaseArchive()
  await tick
  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const handoff = f.store.detail(f.receipt.planID).delivery as { state: string; payload: string }[]
  expect(renewal.state).toBe("committed")
  expect(renewal.input_message_id).toBe("input-during-archive")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.sessions.get("owner")?.messages.at(-1)?.id).toBe("input-during-archive")
  expect(f.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: "input-during-archive", disposition: "delivered" }),
  )
  expect(handoff.find((row) => JSON.parse(row.payload).status === "architect-handoff")?.state).toBe(
    "admitted",
  )
  expect(
    f.notifications.some((notification) =>
      notification.text.includes("LAZERS Architect source changed"),
    ),
  ).toBe(true)
  expect(
    f.notifications.some((notification) => notification.text.includes("input-during-archive")),
  ).toBe(false)
  expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(1)
  expect(f.events.filter((event) => event === "update-session:owner:false")).toHaveLength(0)
})

test("input on the reserved successor is preserved there without reversing predecessor transfer", async () => {
  const now = 2_000_000_325_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  let startArchive!: () => void
  let releaseArchive!: () => void
  const started = new Promise<void>((resolve) => (startArchive = resolve))
  const gate = new Promise<void>((resolve) => (releaseArchive = resolve))
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      startArchive()
      await gate
    }
    await update(input)
  }

  const tick = f.runtime.tick()
  await started
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  await f.runtime.observeArchitectPrompt(renewal.successor_session_id, "successor-user-input")
  const successor = f.sessions.get(renewal.successor_session_id)!
  successor.busy = true
  successor.messages.push({ id: "successor-user-input", text: "Keep input on successor" })
  expect(f.store.architectRenewalHasInput(renewal.id)).toBe(false)
  releaseArchive()
  await tick

  expect(f.store.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successor.id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(successor.messages.at(-1)?.id).toBe("successor-user-input")
  expect(successor.busy).toBe(true)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ session_id: string }, [string]>(
            "SELECT session_id FROM runner_architect_inputs WHERE message_id=?",
          )
          .get("successor-user-input")?.session_id,
    ),
  ).toBe(successor.id)
})

test("an outcome admitted during archival is blocked then retargeted to the renewed owner", async () => {
  const now = 2_000_000_350_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const beforeCreatePlan = f.store.plan(f.receipt.planID)!
  f.store.atomic((db) =>
    db
      .query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',1,?,NULL)",
      )
      .run(
        "task-outcome-before-create",
        beforeCreatePlan.id,
        "owner",
        "task-outcome-before-create-message",
        JSON.stringify({
          planID: beforeCreatePlan.id,
          version: beforeCreatePlan.version,
          status: "task-accepted",
          taskID: f.tasks[0]!.id,
          artifact: "worker-artifact",
        }),
        JSON.stringify({
          lazersKind: "runner-outcome",
          lazersProjectID: "project",
          lazersProjectDirectory: f.root,
          lazersPlanID: beforeCreatePlan.id,
          lazersOutboxID: "task-outcome-before-create",
          lazersMessageID: "task-outcome-before-create-message",
          lazersSessionID: "owner",
          lazersStatus: "task-accepted",
          lazersVersion: beforeCreatePlan.version,
        }),
      ),
  )
  const update = f.host.updateSession!
  let startArchive!: () => void
  let releaseArchive!: () => void
  const started = new Promise<void>((resolve) => (startArchive = resolve))
  const gate = new Promise<void>((resolve) => (releaseArchive = resolve))
  let oldOutcomeID = ""
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      const plan = f.store.plan(f.receipt.planID)!
      const renewal = f.store.architectRenewalForPlan(plan.id)!
      oldOutcomeID = "task-outcome-during-archive"
      const oldPayload = {
        planID: plan.id,
        version: plan.version,
        status: "task-accepted",
        taskID: f.tasks[0]!.id,
        artifact: "worker-artifact",
      }
      const oldMetadata = {
        lazersKind: "runner-outcome",
        lazersProjectID: "project",
        lazersProjectDirectory: f.root,
        lazersPlanID: plan.id,
        lazersOutboxID: oldOutcomeID,
        lazersMessageID: "old-task-outcome-message",
        lazersSessionID: "owner",
        lazersStatus: "task-accepted",
        lazersVersion: plan.version,
      }
      f.store.atomic((db) =>
        db
          .query(
            "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',1,?,NULL)",
          )
          .run(
            oldOutcomeID,
            plan.id,
            "owner",
            "old-task-outcome-message",
            JSON.stringify(oldPayload),
            JSON.stringify(oldMetadata),
          ),
      )
      expect(renewal.state).toBe("archiving")
      expect(plan.owner).toBe(renewal.successor_session_id)
      expect(f.notifications).toHaveLength(0)
      expect(f.store.outboxForDelivery().find((row) => row.id === oldOutcomeID)?.state).toBe(
        "pending",
      )
      startArchive()
      await gate
    }
    await update(input)
  }

  const tick = f.runtime.tick()
  await started
  expect(f.notifications).toHaveLength(0)
  releaseArchive()
  await tick

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successor = renewal.successor_session_id
  let oldOutcome = f.store.outboxForDelivery().find((row) => row.id === oldOutcomeID)!
  expect(renewal.state).toBe("committed")
  expect(
    (f.store.detail(f.receipt.planID).delivery as { id: string; state: string }[]).find(
      (row) => row.id === "task-outcome-before-create",
    )?.state,
  ).toBe("superseded")
  expect(oldOutcome.session_id).toBe(successor)
  expect(oldOutcome.message_id).not.toBe("old-task-outcome-message")
  expect(JSON.parse(oldOutcome.receipt!).history).toContainEqual(
    expect.objectContaining({ kind: "owner-retargeted-current-outcome", toSessionID: successor }),
  )
  expect(f.notifications).toHaveLength(2)
  expect(f.notifications.every((notice) => notice.sessionID === successor)).toBe(true)

  await f.runtime.tick()
  oldOutcome = f.store.outboxForDelivery().find((row) => row.id === oldOutcomeID)!
  expect(oldOutcome.state).toBe("admitted")
  expect(f.notifications.some((notice) => notice.text.includes('"status":"task-accepted"'))).toBe(
    true,
  )
  expect(f.notifications.every((notice) => notice.sessionID === successor)).toBe(true)
})

test("renewal follows durable ownership when continuation history names an older Architect", async () => {
  // Recovery liveness: a historical continuation cannot veto the durable current owner.
  const now = 2_000_000_369_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "owner-history.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  f.store.atomic((db) => {
    db.query("INSERT INTO runner_continuations VALUES(?,?,?,?,?,?)").run(
      f.receipt.planID,
      "historical-architect",
      "older-parent",
      f.root,
      JSON.stringify({ providerID: "openai", id: "test-model" }),
      9,
    )
  })

  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.store.continuation(f.receipt.planID)).toMatchObject({
    session_id: renewal.successor_session_id,
    parent_id: "owner",
    generation: 10,
  })
  expect(f.store.attempts(f.receipt.planID)[0]?.id).toBe(attempt.id)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.notifications.some((notice) => notice.sessionID === renewal.successor_session_id)).toBe(
    true,
  )
  await f.runtime.tick()
  expect(f.store.architectRenewal(renewal.id)?.state).toBe("committed")
})

test("unavailable renewal successor fails before history sweeps and retries with fresh complete proofs", async () => {
  const now = 2_000_000_370_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  const read = f.host.session
  const page = f.host.architectInputPage!
  let unavailable = true
  let successorReads = 0
  let pages = 0
  f.host.session = async (id, options) => {
    if (id !== "owner" && id !== attempt.session_id) {
      successorReads++
      if (unavailable) throw new Error("successor lookup unavailable")
    }
    return read(id, options)
  }
  f.host.architectInputPage = async (input) => {
    pages++
    return page(input)
  }
  // The first failure starts the durable renewal; later recovery attempts must
  // remain retryable without rescanning history or publishing the same issue.
  await f.runtime.tick()
  await f.runtime.tick()
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("creating")
  expect(successorReads).toBeGreaterThanOrEqual(3)
  expect(pages).toBe(0)
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(0)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.sessions.get("owner")?.archived).toBe(false)

  unavailable = false
  await f.runtime.tick()
  expect(pages).toBeGreaterThanOrEqual(2)
  expect(f.store.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]?.id).toBe(attempt.id)
})

test("native archive failure remains visible and retries without restoring predecessor authority", async () => {
  const now = 2_000_000_375_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  let failArchive = true
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived && failArchive) {
      failArchive = false
      throw new Error("native archive temporarily unavailable")
    }
    await update(input)
  }

  await f.runtime.tick()

  const failed = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successorID = failed.successor_session_id
  expect(failed.state).toBe("archiving")
  expect(failed.error).toContain("native archive temporarily unavailable")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successorID)
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(
    f.store.latestTransition<{ error: string }>(
      f.receipt.planID,
      null,
      "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
    )?.error,
  ).toContain("native archive temporarily unavailable")

  f.sessions.get("owner")!.idleAt = now - 1_000
  f.host.updateSession = update
  await f.runtime.tick()

  const recovered = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(recovered.id).toBe(failed.id)
  expect(recovered.state).toBe("committed")
  expect(recovered.successor_session_id).toBe(successorID)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successorID)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("a reopened scheduler recovers a durable transfer before archival without changing workers", async () => {
  const now = 2_000_000_400_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  const ownerID = f.runtime.owner
  const fence = f.store.claim(ownerID, now)!
  const plan = f.store.plan(f.receipt.planID)!
  const renewal = f.store.beginArchitectRenewal({
    schedulerOwner: ownerID,
    fence,
    anchorPlanID: plan.id,
    previousSessionID: plan.owner,
    directory: f.sessions.get(plan.owner)!.directory,
    model: JSON.stringify(f.sessions.get(plan.owner)!.model),
    idleAt: f.sessions.get(plan.owner)!.idleAt!,
    now,
    handoffMessageID: "reopen-handoff-message",
  })!
  await f.host.createArchitect({
    id: renewal.successor_session_id,
    parentID: renewal.previous_session_id,
    directory: renewal.directory,
    model: JSON.parse(renewal.model),
    title: "LAZERS · reopened plan",
    planID: renewal.anchor_plan_id,
    planIDs: f.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id),
    sourceSessionID: renewal.previous_session_id,
  })
  const payload = {
    status: "architect-handoff",
    planID: plan.id,
    version: plan.version + 1,
    planIDs: [plan.id],
    label: "reopened plan",
    continuity: JSON.parse(renewal.continuity_json!),
    predecessorSessionID: renewal.previous_session_id,
    successorSessionID: renewal.successor_session_id,
  }
  const metadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: "project",
    lazersProjectDirectory: f.root,
    lazersPlanID: plan.id,
    lazersOutboxID: "reopen-handoff-outbox",
    lazersMessageID: renewal.handoff_message_id,
    lazersSessionID: renewal.successor_session_id,
    lazersStatus: "architect-handoff",
    lazersVersion: plan.version + 1,
  }
  expect(
    f.store.transferArchitectRenewal({
      schedulerOwner: ownerID,
      fence,
      renewalID: renewal.id,
      outboxID: "reopen-handoff-outbox",
      payload: JSON.stringify(payload),
      metadata: JSON.stringify(metadata),
    }),
  ).toBe(true)
  expect(f.store.architectRenewal(renewal.id)?.state).toBe("archiving")
  expect(f.store.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get(renewal.previous_session_id)?.archived).toBe(false)
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())

  const reopenedRepository = new TaskRepository(f.repository.path, f.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopened = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    architectIdleWindowMs: 1_000,
    architectPromptHook: true,
    now: () => now,
  })
  cleanup.push(() => {
    void reopened.stop()
    reopenedRepository.close()
  })
  await reopened.tick()

  expect(reopenedStore.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(JSON.parse(reopenedStore.architectRenewal(renewal.id)!.continuity_json!)).toEqual({
    revision: 1,
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  expect(reopenedStore.architectContinuity(renewal.successor_session_id)).toMatchObject({
    revision: 1,
    decisions: JSON.stringify(["Keep the existing approved implementation direction."]),
    unresolved_questions: JSON.stringify(["Confirm whether the follow-up needs additional scope."]),
  })
  expect(reopenedStore.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get(renewal.previous_session_id)?.archived).toBe(true)
  expect(reopenedStore.attempts(plan.id)[0]?.session_id).toBe(attempt.session_id)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
  expect(f.notifications).toHaveLength(1)
})

test("a reopened two-scheduler runtime archives only after durable transfer and reconciles queued input", async () => {
  const now = 2_000_000_450_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const schedulerOwner = f.runtime.owner
  const fence = f.store.claim(schedulerOwner, now)!
  const plan = f.store.plan(f.receipt.planID)!
  const predecessor = f.sessions.get(plan.owner)!
  const renewal = f.store.beginArchitectRenewal({
    schedulerOwner,
    fence,
    anchorPlanID: plan.id,
    previousSessionID: predecessor.id,
    directory: predecessor.directory,
    model: JSON.stringify(predecessor.model),
    idleAt: predecessor.idleAt!,
    now,
    handoffMessageID: "unsupported-hook-handoff",
  })!
  await f.host.createArchitect({
    id: renewal.successor_session_id,
    parentID: predecessor.id,
    directory: renewal.directory,
    model: JSON.parse(renewal.model),
    title: "LAZERS · unsupported-hook case",
    planID: plan.id,
    planIDs: [plan.id],
    sourceSessionID: predecessor.id,
  })
  const payload = {
    status: "architect-handoff",
    planID: plan.id,
    version: plan.version + 1,
    planIDs: [plan.id],
    label: "unsupported-hook case",
    predecessorSessionID: predecessor.id,
    successorSessionID: renewal.successor_session_id,
  }
  const metadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: "project",
    lazersProjectDirectory: f.root,
    lazersPlanID: plan.id,
    lazersOutboxID: "unsupported-hook-outbox",
    lazersMessageID: renewal.handoff_message_id,
    lazersSessionID: renewal.successor_session_id,
    lazersStatus: "architect-handoff",
    lazersVersion: plan.version + 1,
  }
  expect(
    f.store.transferArchitectRenewal({
      schedulerOwner,
      fence,
      renewalID: renewal.id,
      outboxID: "unsupported-hook-outbox",
      payload: JSON.stringify(payload),
      metadata: JSON.stringify(metadata),
    }),
  ).toBe(true)
  const foreign = {
    id: "msg_synthetic_during_process_restart",
    type: "synthetic",
    delivery: "queue",
    metadata: { source: "another-plugin" },
  }
  f.inbox.set(predecessor.id, [foreign])
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())

  const reopenedRepository = new TaskRepository(f.repository.path, f.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const first = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    architectIdleWindowMs: 1_000,
    architectPromptHook: true,
    now: () => now,
  })
  const second = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    architectIdleWindowMs: 1_000,
    architectPromptHook: true,
    now: () => now,
  })
  cleanup.push(() => {
    void first.stop()
    void second.stop()
    reopenedRepository.close()
  })

  await Promise.all([first.tick(), second.tick()])

  expect(reopenedStore.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(JSON.parse(reopenedStore.architectRenewal(renewal.id)!.continuity_json!)).toEqual({
    revision: 1,
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  expect(reopenedStore.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(predecessor.archived).toBe(true)
  expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(1)
  expect(f.inbox.get(predecessor.id)).toEqual([foreign])
  expect(reopenedStore.architectRenewalHasInput(renewal.id)).toBe(true)
  expect(reopenedStore.architectSourceInputs(predecessor.id)).toContainEqual(
    expect.objectContaining({ message_id: foreign.id, disposition: "pending" }),
  )
  expect(
    f.notifications.some((notification) =>
      notification.text.includes("LAZERS Architect source changed"),
    ),
  ).toBe(true)
  expect(f.notifications.some((notification) => notification.text.includes(foreign.id))).toBe(false)
})

test("cancellation interrupts workers while a transferred renewal still has failed archival recovery", async () => {
  const now = 2_000_000_500_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "cancel-during-archive.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  let archiveAttempts = 0
  f.host.updateSession = async ({ sessionID, archived }) => {
    if (sessionID === "owner" && archived) {
      archiveAttempts++
      throw new Error("archive remains unavailable during cancellation")
    }
  }

  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("archiving")
  const plan = f.store.plan(f.receipt.planID)!
  await f.runtime.command(
    {
      requestID: "cancel-during-archive-recovery",
      planID: plan.id,
      expectedVersion: plan.version,
      action: "cancel",
    },
    renewal.successor_session_id,
  )
  expect(f.store.plan(plan.id)?.state).toBe("cancelling")
  expect(f.store.architectRenewalForPlan(plan.id)?.id).toBe(renewal.id)
  let failedHistoryReads = 0
  let historyError = "retained predecessor history is temporarily unavailable"
  f.host.architectInputPage = async () => {
    failedHistoryReads++
    throw new Error(historyError)
  }
  const failureHistory = () =>
    f.store.atomic((db) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_transitions WHERE plan_id=? AND event='ARCHITECT_RENEWAL_RECOVERY_FAILED' ORDER BY id",
        )
        .all(plan.id)
        .map((row) => JSON.parse(row.payload)),
    )

  await f.runtime.tick()
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(false)
  expect(f.sessions.get(attempt.session_id)?.outcome).toBe("interrupted")
  expect(f.store.plan(plan.id)?.state).toBe("cancelling")
  await f.runtime.tick()
  await f.runtime.tick()

  expect(f.store.plan(plan.id)?.state).toBe("cancelled")
  expect(f.store.architectRenewal(renewal.id)).toMatchObject({
    state: "archiving",
    error: "retained predecessor history is temporarily unavailable",
  })
  expect(f.store.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(archiveAttempts).toBe(1)
  expect(failedHistoryReads).toBeGreaterThanOrEqual(6)
  expect(failureHistory()).toEqual([
    { renewalID: renewal.id, state: "archiving", error: historyError },
  ])
  historyError = "retained predecessor history failed differently"
  await f.runtime.tick()
  expect(failureHistory()).toHaveLength(2)
  expect(failureHistory().at(-1)?.error).toBe(historyError)
  historyError = "retained predecessor history is temporarily unavailable"
  await f.runtime.tick()
  expect(failureHistory()).toHaveLength(3)
  expect(failureHistory().at(-1)?.error).toBe(historyError)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("a continuity checkpoint cannot outlive a later observed user input", async () => {
  let now = 2_000_000_510_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "checkpoint-coverage.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const owner = f.sessions.get("owner")!
  now += 100
  owner.messages.push({ id: "msg_new_user_decision", type: "user", text: "Use the new decision" })
  await f.runtime.observeArchitectPrompt(owner.id, "msg_new_user_decision")
  owner.busy = false
  owner.idleAt = now + 100
  now = owner.idleAt + 1_000

  await f.runtime.tick()
  expect(f.store.architectRenewalForPlan(f.receipt.planID)).toBeNull()
  expect(owner.archived).toBe(false)
  expect(
    f.store.latestTransition<{ uncoveredInputID: string }>(
      f.receipt.planID,
      null,
      "ARCHITECT_RENEWAL_BLOCKED_STALE_CHECKPOINT",
    )?.uncoveredInputID,
  ).toBe("msg_new_user_decision")

  // F-S4-3: an unchanged stale checkpoint records one condition, not one per drain.
  for (let tick = 0; tick < 5; tick++) await f.runtime.tick()
  expect(
    (f.store.detail(f.receipt.planID).activity as { event: string }[]).filter(
      (row) => row.event === "ARCHITECT_RENEWAL_BLOCKED_STALE_CHECKPOINT",
    ),
  ).toHaveLength(1)

  await f.runtime.recordArchitectContinuity(owner.id, {
    decisions: ["Use the newly observed user decision."],
    unresolvedQuestions: [],
  })
  expect(f.store.architectContinuityCoverage(owner.id)).toContain("msg_new_user_decision")
  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("committed")
  expect(JSON.parse(renewal.continuity_json!).decisions).toEqual([
    "Use the newly observed user decision.",
  ])
  const handoff = (f.store.detail(f.receipt.planID).delivery as { payload: string }[])
    .map((row) => JSON.parse(row.payload))
    .find((payload) => payload.status === "architect-handoff")
  expect(handoff.continuityCoverage).toMatchObject({ revision: 2, inputCount: 1 })
})

test("renewal finishes all preparation pages before transferring a checkpoint", async () => {
  const now = 2_000_000_515_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "page-three-checkpoint.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const cursors: (string | undefined)[] = []
  f.host.architectInputPage = async (_sessionID, cursor) => {
    cursors.push(cursor)
    if (cursor === undefined) return { inbox: [], messages: [], nextCursor: "page-two" }
    if (cursor === "page-two") return { inbox: [], messages: [], nextCursor: "page-three" }
    return {
      inbox: [],
      messages: [{ id: "msg_page_three_user", type: "user" }],
      nextCursor: null,
    }
  }

  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(cursors).toEqual([undefined, "page-two", "page-three"])
  expect(renewal.state).toBe("deferred")
  expect(renewal.input_message_id).toBe("msg_page_three_user")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(0)
  expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(0)
})

test("F-S3-1 archived sources leave polling while their history and native-event recovery survive", async () => {
  const now = 2_000_000_519_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "source-retirement.txt" }],
  })
  let reads = 0
  const read = f.host.architectInputPage!.bind(f.host)
  f.host.architectInputPage = (...args) => {
    reads++
    return read(...args)
  }
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.architectSource("owner")).toMatchObject({
    state: "retired",
    scan_complete_at: now,
  })
  const scans = reads
  const revision = f.store.architectSource("owner")!.revision
  const inputTimes = () =>
    f.repository.read((db) =>
      db
        .query(
          "SELECT message_id,observed_at,updated_at FROM runner_architect_inputs WHERE session_id='owner' ORDER BY message_id",
        )
        .all(),
    )
  const before = inputTimes()
  for (let tick = 0; tick < 4; tick++) await f.runtime.tick()
  expect(reads).toBe(scans)
  expect(f.store.architectSources()).toEqual([])
  expect(f.store.architectSourceJournalPage(f.receipt.planID, 100).records).not.toHaveLength(0)
  f.runtime.observeArchitectSourceEvent("owner")
  expect(f.store.architectSource("owner")!.state).toBe("active")
  await f.runtime.tick()
  expect(reads).toBe(scans + 1)
  expect(f.store.architectSource("owner")).toMatchObject({ state: "retired", revision })
  expect(inputTimes()).toEqual(before)
  f.runtime.observeArchitectSourceEvent()
  expect(f.store.architectSource("owner")!.state).toBe("active")
  await f.runtime.tick()
  expect(reads).toBe(scans + 2)
  expect(new RunnerStore(f.repository).architectSources()).toEqual([])
})

test("F-S3-1 activity during a source read keeps it scheduled for a fresh pass", async () => {
  const now = 2_000_000_519_500
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "source-race.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  await f.runtime.tick()
  f.runtime.observeArchitectSourceEvent("owner")
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const read = f.host.architectInputPage!.bind(f.host)
  let held = true
  f.host.architectInputPage = async (...args) => {
    const page = await read(...args)
    if (held) {
      started.resolve()
      await release.promise
    }
    return page
  }
  const tick = f.runtime.tick()
  await started.promise
  f.runtime.observeArchitectSourceEvent("owner")
  held = false
  release.resolve()
  await tick
  expect(f.store.architectSource("owner")).toMatchObject({
    state: "active",
    scan_complete_at: null,
  })
  await f.runtime.tick()
  expect(f.store.architectSource("owner")!.state).toBe("retired")
})

test("late and mutable assistant tool results are signalled through the progressive source journal", async () => {
  const now = 2_000_000_520_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "mutable-source-result.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("committed")

  const privateCanary = "RAW_TOOL_ARGUMENTS_AND_REASONING_MUST_NOT_ESCAPE"
  let result: ArchitectSourceResult = {
    state: "running" as const,
    finish: null,
    toolCounts: { running: 1, completed: 0, failed: 0, other: 0 },
  }
  f.host.architectInputPage = async () => ({
    inbox: [],
    messages: [
      {
        id: "msg_late_tool_result",
        type: "assistant",
        metadata: { private: privateCanary },
        result,
      },
    ],
    nextCursor: null,
  })

  await f.runtime.tick()
  result = {
    state: "completed",
    finish: "stop",
    toolCounts: { running: 0, completed: 1, failed: 0, other: 0 },
  }
  // F-S3-1: the native tool completion invalidates a retired source without polling it forever.
  f.runtime.observeArchitectSourceEvent(renewal.previous_session_id)
  const predecessor = renewal.previous_session_id
  const successor = renewal.successor_session_id
  const firstPointer = f.store
    .architectSourceNoticeRows(predecessor)
    .find((row) => JSON.parse(row.payload).status === "architect-source-change")!
  f.inbox.set(
    successor,
    (f.inbox.get(successor) ?? []).filter((entry) => entry.id !== firstPointer.message_id),
  )
  f.sessions.get(successor)!.messages.push({
    id: firstPointer.message_id,
    type: "synthetic",
    metadata: JSON.parse(firstPointer.metadata!),
    text: "The preceding compact source-change pointer was read.",
  })
  await f.runtime.tick()

  const stored = f.store.atomic((db) =>
    db
      .query<
        {
          state: string
          result_revision: number
          referenced_revision: number
          result_fingerprint: string
        },
        [string, string]
      >(
        `SELECT state,result_revision,referenced_revision,result_fingerprint
         FROM runner_architect_source_results WHERE session_id=? AND message_id=?`,
      )
      .get("owner", "msg_late_tool_result"),
  )!
  expect(stored).toMatchObject({
    state: "completed",
    result_revision: 2,
    referenced_revision: expect.any(Number),
  })
  expect(stored.referenced_revision).toEqual(2)
  const notices = (f.store.detail(f.receipt.planID).delivery as { payload: string }[])
    .map((row) => JSON.parse(row.payload))
    .filter((payload) => payload.status === "architect-source-change")
  expect(notices).toHaveLength(2)
  const journal = f.store.architectSourceJournalPage(f.receipt.planID, 100)
  expect(journal.records).toContainEqual(
    expect.objectContaining({
      kind: "result",
      messageID: "msg_late_tool_result",
      state: "completed",
      resultRevision: 2,
    }),
  )
  const resultNotices = f.notifications.filter((notice) =>
    notice.text.includes("LAZERS Architect source changed"),
  )
  expect(resultNotices).toHaveLength(2)
  expect(resultNotices.every((notice) => notice.resume === false)).toBe(true)
  expect(JSON.stringify(notices)).not.toContain(privateCanary)
  expect(JSON.stringify(resultNotices)).not.toContain(privateCanary)
  expect(f.store.attempts(f.receipt.planID)[0]?.session_id).toBe(attempt.session_id)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
})

test("concurrent plan admission joins the fixed successor and survives two-scheduler reopen", async () => {
  const now = 2_000_000_530_000
  const f = fixture({
    shared: true,
    delayed: true,
    independent: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "concurrent-admission.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  const peer = new TaskRuntime(f.store, f.host, "project", undefined, {
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
  })
  cleanup.push(() => void peer.stop())
  let signalCreated!: () => void
  let releaseCreate!: () => void
  const created = new Promise<void>((resolve) => (signalCreated = resolve))
  const createGate = new Promise<void>((resolve) => (releaseCreate = resolve))
  const nativeCreate = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    await nativeCreate(input)
    signalCreated()
    await createGate
  }
  let failArchive = true
  const nativeUpdate = f.host.updateSession!
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived && failArchive) {
      failArchive = false
      throw new Error("hold transfer for reopen")
    }
    await nativeUpdate(input)
  }

  const tick = f.runtime.tick()
  await created
  const lateTask = f.createTask("late", "late-concurrent-plan.txt")
  const lateReceipt = f.store.submit(
    f.inputFor([lateTask], { requestID: "late-plan-during-successor-create" }),
    "owner",
  )
  await peer.tick()
  releaseCreate()
  await tick

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("archiving")
  expect(f.store.architectRenewalForPlan(lateReceipt.planID)?.id).toBe(renewal.id)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.store.plan(lateReceipt.planID)?.owner).toBe(renewal.successor_session_id)
  const handoff = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>("SELECT payload FROM runner_outbox WHERE id=?")
      .get(renewal.handoff_outbox_id!)!,
  )
  const handoffPayload = JSON.parse(handoff.payload)
  expect(handoffPayload.planIDs).toContain(lateReceipt.planID)
  expect(handoffPayload.planVersions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ planID: f.receipt.planID }),
      expect.objectContaining({ planID: lateReceipt.planID }),
    ]),
  )
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)

  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopenedRepository = new TaskRepository(f.repository.path, f.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopenedA = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
  })
  const reopenedB = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
  })
  cleanup.unshift(() => {
    void reopenedA.stop()
    void reopenedB.stop()
    reopenedRepository.close()
  })
  await Promise.all([reopenedA.tick(), reopenedB.tick()])

  expect(reopenedStore.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(reopenedStore.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(reopenedStore.plan(lateReceipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  expect(reopenedStore.attempts(f.receipt.planID)[0]?.session_id).toBe(attempt.session_id)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("shared-database renewal recovery is invisible to a different canonical project", async () => {
  const now = 2_000_000_540_000
  const f = fixture({
    shared: true,
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "project-isolation.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived)
      throw new Error("foreign scheduler must not retry this archive")
    await update(input)
  }
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("archiving")

  const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "lazers-other-project-")))
  const otherRepository = new TaskRepository(f.repository.path, otherRoot)
  const otherStore = new RunnerStore(otherRepository)
  const otherRuntime = new TaskRuntime(otherStore, f.host, "other-project", undefined, {
    now: () => now,
    architectPromptHook: true,
  })
  cleanup.unshift(() => {
    void otherRuntime.stop()
    otherRepository.close()
    rmSync(otherRoot, { recursive: true, force: true })
  })
  let foreignSessionReads = 0
  const session = f.host.session
  f.host.session = async (id, options) => {
    foreignSessionReads++
    return session(id, options)
  }

  await otherRuntime.tick()

  expect(foreignSessionReads).toBe(0)
  expect(otherStore.architectRenewalsNeedingRecovery()).toEqual([])
  expect(otherStore.architectSources()).toEqual([])
  expect(otherStore.architectRenewal(renewal.id)).toBeNull()
  expect(otherStore.architectRenewalForSource("owner")).toBeNull()
  expect(otherStore.architectSource("owner")).toBeNull()
  expect(otherStore.architectSourceInputs("owner")).toEqual([])
  expect(
    otherStore.observeArchitectInput("owner", "foreign-user-input", now, {
      type: "user",
      userPrompt: true,
    }),
  ).toMatchObject({ renewal: null, state: null })
  expect(f.store.architectRenewal(renewal.id)).toMatchObject({
    state: "archiving",
    error: "foreign scheduler must not retry this archive",
  })
})

test.each(["workspace", "baseline"] as const)(
  "terminal continuation preserves the retained assignment against %s changes",
  async (change) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const { planID, attempt } = await holdInterruptedAttempt(f)
    await expect(
      f.runtime.command(
        {
          requestID: `preserve-terminal-${change}`,
          planID,
          expectedVersion: f.store.plan(planID)!.version,
          action: "resume",
          taskID: attempt.task_id,
          attemptID: attempt.id,
          ...(change === "workspace"
            ? { workspaceMode: "shared" }
            : { baseCommit: "f".repeat(40) }),
          reason: "Continue the retained assignment",
        },
        "owner",
      ),
    ).rejects.toThrow("preserves its workspace and baseline")
    expect(f.store.attempts(planID)[0]).toEqual(attempt)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  },
)

test.each([false, true])(
  "terminal continuation retains a redundant workspace selection (shared=%s)",
  async (shared) => {
    const f = fixture({ shared, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const { planID, attempt } = await holdInterruptedAttempt(f)
    await f.runtime.command(
      {
        requestID: "preserve-terminal-redundant",
        planID,
        expectedVersion: f.store.plan(planID)!.version,
        action: "resume",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        workspaceMode: shared ? "shared" : "isolated",
        baseCommit: attempt.base_commit,
        reason: "Continue the same workspace and baseline",
      },
      "owner",
    )
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: attempt.id,
      workspace: attempt.workspace,
      base_commit: attempt.base_commit,
      state: "preparing",
    })
    expect(
      f.store
        .activity(planID, attempt.task_id)
        .filter((entry) => entry.event === "WORKSPACE_SELECTED"),
    ).toHaveLength(0)
  },
)

test("Auditor dispatch retains its role and selected model and waits for Architect review", async () => {
  const model = { providerID: "opencode-go", id: "muse-spark-1.3-contributor" }
  const f = fixture({ shared: true, human: true, workerAgent: "auditor", personas: ["systems"] })
  const requested: unknown[] = []
  f.host.workerModel = async (agent) => {
    requested.push(agent)
    return model
  }
  await f.runtime.command(
    { requestID: "audit-run", planID: f.receipt.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  expect(requested).toContain("auditor")
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  expect(f.sessions.get(attempt.session_id)!.agent).toBe("auditor")
  expect(JSON.parse(attempt.policy)).toMatchObject({ agent: "auditor", model })
  expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
  expect(f.store.plan(f.receipt.planID)!.reason).toContain("correct:human")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test("archived owners leave unresolved plans with a durable wake even after their outcome was consumed", async () => {
  const f = fixture({
    fail: true,
    shared: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  // The old Architect read the failure but retired before resolving it.
  f.store.atomic((db) =>
    db.query("UPDATE runner_outbox SET state='consumed' WHERE plan_id=?").run(f.receipt.planID),
  )
  f.inbox.set("owner", [])
  f.sessions.get("owner")!.archived = true
  const attempts = f.store.attempts(f.receipt.planID).map((attempt) => attempt.id)
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  try {
    await drive(reopened, 3)
    const owner = f.store.plan(f.receipt.planID)!.owner
    expect(owner).not.toBe("owner")
    const wakes = f.inbox.get(owner) ?? []
    expect(wakes).toHaveLength(1)
    expect(f.notifications.find((notice) => notice.id === wakes[0]!.id)?.resume).toBe(true)
    expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.id)).toEqual(attempts)
    await drive(reopened, 3)
    expect(f.inbox.get(owner)).toHaveLength(1)
  } finally {
    await reopened.stop()
  }
})

test("cancelled prerequisites block transitive dependents once, survive restart and clear after replanning", async () => {
  const f = fixture({ delayed: true, shared: true })
  const parentTask = f.createTask("parent")
  const parent = f.store.submit(f.inputFor([parentTask], { requestID: "cancel-root" }), "owner")
  await f.runtime.command(
    {
      requestID: "wait-root",
      action: "schedule",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      afterPlans: [parent.planID],
      reason: "Requires parent feature",
    },
    "owner",
  )
  const leafTask = f.createTask("leaf")
  const leaf = f.store.submit(
    { ...f.inputFor([leafTask], { requestID: "cancel-leaf" }), afterPlans: [f.receipt.planID] },
    "owner",
  )
  await runPlan(f)
  await runPlan(f, leaf.planID, "run-leaf")
  await f.runtime.command(
    {
      requestID: "cancel-parent",
      action: "cancel",
      planID: parent.planID,
      expectedVersion: f.store.plan(parent.planID)!.version,
      reason: "Feature intentionally cancelled",
    },
    "owner",
  )
  await drive(f.runtime, 3)
  const reference = f.repository.referenceFor(parentTask.id)!
  for (const id of [f.receipt.planID, leaf.planID]) {
    expect(f.store.plan(id)).toMatchObject({
      state: "blocked",
      reason: `Prerequisite cancelled: ${reference}`,
    })
    expect(f.store.nodes(id).every((node) => node.state === "blocked")).toBe(true)
    expect(f.store.attempts(id)).toHaveLength(0)
  }
  expect(f.notifications.some((notice) => notice.text.includes(reference) && notice.resume)).toBe(
    true,
  )
  const records = () =>
    f.store.atomic(
      (db) =>
        db
          .query<{ n: number }, [string]>(
            "SELECT count(*) AS n FROM runner_transitions WHERE plan_id=? AND event='DEPENDENCY_CANCELLATION'",
          )
          .get(f.receipt.planID)!.n,
    )
  const before = records()
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  try {
    await drive(reopened, 3)
    expect(records()).toBe(before)
    await reopened.command(
      {
        requestID: "replace-root",
        action: "schedule",
        planID: f.receipt.planID,
        expectedVersion: f.store.plan(f.receipt.planID)!.version,
        afterPlans: [],
        reason: "Feature scope no longer needs cancelled producer",
      },
      "owner",
    )
    await drive(reopened, 3)
    expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
    expect(f.store.plan(f.receipt.planID)!.reason).toBeNull()
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.store.plan(leaf.planID)!.state).toBe("running")
    expect(f.store.attempts(leaf.planID)).toHaveLength(0)
    expect(f.store.plan(parent.planID)!.state).toBe("cancelled")
    expect(JSON.parse(f.store.plan(leaf.planID)!.body).afterPlans).toEqual([f.receipt.planID])
  } finally {
    await reopened.stop()
  }
})

test("cancelled same-plan prerequisites block their descendants while independent work dispatches", async () => {
  const original = fixture({
    startOnly: true,
    delayed: true,
    independent: true,
    taskFiles: [
      { name: "a", path: "a.txt" },
      { name: "b", path: "b.txt" },
      { name: "c", path: "c.txt" },
    ],
  })
  const f = {
    ...original,
    receipt: original.store.submit(
      {
        ...original.input,
        dependencies: [{ prerequisite: original.tasks[0]!.id, successor: original.tasks[1]!.id }],
      },
      "owner",
    ),
  }
  await runPlan(f)
  f.store.move(f.receipt.planID, f.tasks[0]!.id, "CANCEL")
  await f.runtime.tick()
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual([
    "cancelled",
    "blocked",
    "running",
  ])
  expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
  expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.task_id)).toEqual([
    f.tasks[2]!.id,
  ])
})

test("dispatch pause lets active work finish and unpause admits the next task", async () => {
  const f = fixture({ delayed: true, shared: true, commit: true })
  await runPlan(f)
  await f.runtime.tick()
  const first = f.store.attempts(f.receipt.planID)[0]!
  await f.runtime.command(
    {
      requestID: "pause",
      action: "pause",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      reason: "Wait for coordination",
    },
    "owner",
  )
  expect(f.store.dispatchPause(f.receipt.planID)).toEqual({
    reason: "Wait for coordination",
    untilPlans: [],
  })
  expect(f.sessions.get(first.session_id)!.busy).toBe(true)
  f.completeWorker(first.session_id)
  await drive(f.runtime, 4)
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.events.some((event) => event.startsWith("interrupt:"))).toBe(false)
  await f.runtime.command(
    {
      requestID: "unpause",
      action: "unpause",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
    },
    "owner",
  )
  await drive(f.runtime, 2)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
  expect(f.store.dispatchPause(f.receipt.planID)).toBeUndefined()
})

test("dispatch pause survives restart and automatically clears only after recorded integration", async () => {
  const f = fixture({ delayed: true, commit: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const dependency = f.receipt.planID
  const childTask = f.createTask("b")
  const child = f.store.submit(f.inputFor([childTask], { requestID: "paused-child" }), "owner")
  await f.runtime.command(
    {
      requestID: "pause-child",
      action: "pause",
      planID: child.planID,
      expectedVersion: f.store.plan(child.planID)!.version,
      reason: "Coordinate after prerequisite",
      resumeAfterPlans: [dependency],
    },
    "owner",
  )
  await runPlan(f, child.planID, "run-paused-child")
  const accepted = await acceptPlan(f, dependency)
  expect(f.store.attempts(child.planID)).toHaveLength(0)
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project")
  try {
    await drive(reopened, 2)
    expect(f.store.dispatchPause(child.planID)?.untilPlans).toEqual([dependency])
    expect(f.store.attempts(child.planID)).toHaveLength(0)
    includeArtifact(f, accepted.plan.artifact!)
    await recordPlanIntegration({ ...f, runtime: reopened }, dependency)
    await drive(reopened, 3)
    expect(f.store.dispatchPause(child.planID)).toBeUndefined()
    expect(f.store.attempts(child.planID)).toHaveLength(1)
  } finally {
    await reopened.stop()
  }
})

test("pause conditions cannot silently wait on cancellation or create a coordination cycle", async () => {
  const f = fixture({ delayed: true, shared: true })
  const prerequisiteTask = f.createTask("prerequisite")
  const prerequisite = f.store.submit(
    f.inputFor([prerequisiteTask], { requestID: "paused-prerequisite" }),
    "owner",
  )
  await f.runtime.command(
    {
      requestID: "pause-with-condition",
      action: "pause",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      resumeAfterPlans: [prerequisite.planID],
    },
    "owner",
  )
  await expect(
    f.runtime.command(
      {
        requestID: "cycle",
        action: "pause",
        planID: prerequisite.planID,
        expectedVersion: f.store.plan(prerequisite.planID)!.version,
        resumeAfterPlans: [f.receipt.planID],
      },
      "owner",
    ),
  ).rejects.toThrow("cycle")
  await runPlan(f)
  await f.runtime.command(
    {
      requestID: "cancel-condition",
      action: "cancel",
      planID: prerequisite.planID,
      expectedVersion: f.store.plan(prerequisite.planID)!.version,
    },
    "owner",
  )
  await drive(f.runtime, 3)
  expect(f.store.plan(f.receipt.planID)).toMatchObject({
    state: "blocked",
    reason: `Prerequisite cancelled: ${f.repository.referenceFor(prerequisiteTask.id)}`,
  })
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(0)
  await f.runtime.command(
    {
      requestID: "clear-pause",
      action: "unpause",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
    },
    "owner",
  )
  await drive(f.runtime, 2)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test("cancellation propagation stops at an already integrated dependency", () => {
  const f = fixture({ shared: true })
  const rootTask = f.createTask("root")
  const root = f.store.submit(f.inputFor([rootTask], { requestID: "old-root" }), "owner")
  const middleTask = f.createTask("middle")
  const middle = f.store.submit(
    { ...f.inputFor([middleTask], { requestID: "integrated-middle" }), afterPlans: [root.planID] },
    "owner",
  )
  f.store.revisePlan(
    f.store.plan(f.receipt.planID)!,
    PlanInput.parse({ ...f.input, afterPlans: [middle.planID] }),
    "TEST_SCHEDULE",
    {},
  )
  // Exercise historical lifecycle facts; this does not fabricate runtime acceptance.
  f.store.atomic((db) => {
    db.query("UPDATE runner_plans SET state='cancelled' WHERE id=?").run(root.planID)
    db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(middle.planID)
  })
  expect(f.store.cancelledDependencyPlans(f.receipt.planID)).toEqual([])
})

test("pause does not invalidate a verification that is already in flight", async () => {
  const f = fixture({
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    checkCommand: 'sleep 0.1; test "$(cat a.txt)" = a',
  })
  await runPlan(f)
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("verifying")
  await f.runtime.command(
    {
      requestID: "pause-checking",
      action: "pause",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      reason: "Hold next dispatch only",
    },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("accepted")
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test.each(["initial", "detailed", "unknown"] as const)(
  "a definitively deleted worker at %s read can be cancelled and retried without losing retained work",
  async (disappearsAt) => {
    const f = fixture({ delayed: true })
    await runPlan(f)
    await f.runtime.tick()
    const attempt = f.store.attempts(f.receipt.planID)[0]!
    const retained = join(attempt.workspace, "retained-notes.txt")
    writeFileSync(retained, "useful partial work\n")
    if (disappearsAt === "initial" || disappearsAt === "unknown") {
      if (disappearsAt === "unknown")
        f.repository.atomic((db) =>
          db.query("UPDATE runner_attempts SET state='unknown' WHERE id=?").run(attempt.id),
        )
      f.sessions.delete(attempt.session_id)
    } else {
      const worker = f.sessions.get(attempt.session_id)!
      worker.busy = false
      worker.outcome = "succeeded"
      worker.turn = { inputID: attempt.message_id, state: "completed" }
      const read = f.host.session
      f.host.session = async (id, options) => {
        if (id === attempt.session_id && options?.messages) {
          f.sessions.delete(id)
          return null
        }
        return read(id, options)
      }
    }
    await f.runtime.command(
      {
        requestID: "cancel-deleted-worker",
        planID: f.receipt.planID,
        expectedVersion: f.store.plan(f.receipt.planID)!.version,
        action: "cancel",
      },
      "owner",
    )
    await f.runtime.tick()
    expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
    expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
      id: attempt.id,
      state: "cancelled",
      workspace: attempt.workspace,
    })
    expect(readFileSync(retained, "utf8")).toBe("useful partial work\n")
    expect(f.events).not.toContain(`stop:${attempt.session_id}`)
    // A cleanup tick must preserve the dirty checkout without blocking retry.
    await f.runtime.tick()
    expect(
      f.store.effects(f.receipt.planID).find((effect) => effect.kind === "worktree-remove")?.state,
    ).toBe("held")
    await f.runtime.command(
      {
        requestID: "retry-deleted-worker",
        planID: f.receipt.planID,
        expectedVersion: f.store.plan(f.receipt.planID)!.version,
        action: "retry",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        reason: "Continue after native worker deletion; retain the old checkout for review",
      },
      "owner",
    )
    await f.runtime.tick()
    const attempts = f.store.attempts(f.receipt.planID).filter((a) => a.task_id === attempt.task_id)
    expect(attempts).toHaveLength(2)
    expect(attempts[1]!.session_id).not.toBe(attempt.session_id)
    expect(readFileSync(retained, "utf8")).toBe("useful partial work\n")
  },
)

test("worker lookup failure preserves cancellation without starving independent dispatch", async () => {
  const f = fixture({ independent: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const read = f.host.session
  f.host.session = async (id, options) => {
    if (id === attempt.session_id) throw new Error("Native worker lookup temporarily unavailable")
    return read(id, options)
  }
  await f.runtime.command(
    {
      requestID: "cancel-temporarily-unobserved-worker",
      planID: f.receipt.planID,
      expectedVersion: f.store.plan(f.receipt.planID)!.version,
      action: "cancel",
    },
    "owner",
  )
  const independent = f.createTask("independent", "other/independent.txt")
  const next = f.store.submit(f.inputFor([independent], { requestID: "independent" }), "owner")
  await runPlan(f, next.planID, "run-independent")
  await f.runtime.tick()
  expect(f.store.attempts(next.planID)[0]?.state).toBe("running")
  await f.runtime.tick()
  const activity = f.store.detail(f.receipt.planID).activity as { event: string; payload: string }[]
  const failures = activity.filter((row) => row.event === "PLAN_STEP_FAILED")
  expect(failures).toHaveLength(1)
  expect(JSON.parse(failures[0]!.payload)).toEqual({
    error: "Native worker lookup temporarily unavailable",
  })
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
  f.host.session = read
  f.sessions.delete(attempt.session_id)
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("cancelled")
})

test("an authorized same-worker resume retires its superseded held verification and dispatches", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt } = await holdInterruptedAttempt(f)
  const plan = f.store.plan(planID)!
  const operationID = crypto.randomUUID()
  f.store.atomic((db) =>
    createRetainedVerification(db, f.root, {
      schemaVersion: 1,
      id: operationID,
      generation: 1,
      projectID: "project",
      projectDirectory: f.root,
      planID,
      planRevision: plan.revision,
      planVersion: plan.version,
      owner: "owner",
      ownerEpoch: f.store.planControlEpoch(planID),
      taskID: attempt.task_id,
      taskRevision: 1,
      attemptID: attempt.id,
      originalSessionID: attempt.session_id,
      originalMessageID: attempt.message_id,
      originalWorkspace: attempt.workspace,
      artifact: attempt.base_commit,
      combinedArtifact: null,
      taskWorkspace: null,
      taskWorkspaceState: null,
      combinedWorkspace: null,
      combinedWorkspaceState: null,
      inputFingerprint: "fixture",
      environmentIdentity: "fixture",
      reason: "Earlier verification",
      state: "held",
      holdReason: "Interrupted check",
      cleanupState: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  )
  await f.runtime.command(
    {
      requestID: "resume-after-held-verification",
      planID,
      expectedVersion: plan.version,
      action: "resume",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      reason: "Continue the original worker",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.attempts(planID)).toEqual([
    expect.objectContaining({ id: attempt.id, session_id: attempt.session_id, state: "running" }),
  ])
  expect(f.store.atomic((db) => retainedVerification(db, operationID))).toMatchObject({
    state: "cancelled",
    originalMessageID: attempt.message_id,
  })
})

test("an authoritatively missing worker releases its reservation without deleting partial work", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "shared.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const old = f.store.attempts(f.receipt.planID)[0]!
  const partial = join(old.workspace, "shared.txt")
  writeFileSync(partial, "partial work")
  const task = f.createTask("b", "shared.txt")
  const next = f.store.submit(f.inputFor([task], { requestID: "after-missing-worker" }), "owner")
  await runPlan(f, next.planID, "run-after-missing-worker")
  f.sessions.delete(old.session_id)
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("failed")
  expect(f.store.nodes(f.receipt.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(next.planID)[0]?.state).toBe("running")
  expect(readFileSync(partial, "utf8")).toBe("partial work")
})

test("a settled verification timeout preserves its attempt and releases a conflicting isolated task", async () => {
  const f = fixture({
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "shared.txt" }],
    checkCommand: (name) => (name === "a" ? "sleep 5" : "true"),
  })
  await runPlan(f)
  await f.runtime.tick()
  const old = f.store.attempts(f.receipt.planID)[0]!
  cleanup.push(registerSourceGuard(f.store, old.workspace))
  const next = f.createTask("b", "shared.txt")
  const queued = f.store.submit(f.inputFor([next], { requestID: "after-timed-out-check" }), "owner")
  await runPlan(f, queued.planID, "run-after-timed-out-check")
  f.completeWorker(old.session_id)
  Object.assign(f.sessions.get(old.session_id)!, {
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
  })
  await settleVerification(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.reason).toBe("Verification content timed out")
  await f.runtime.tick()
  expect(sourceQuarantine(f.store, old.id)?.phase).toBe("sealed")
  expect(f.store.attempts(queued.planID)[0]?.state).toBe("running")
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("verifying")
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.reason).toBe("Verification content timed out")
  expect(readFileSync(join(old.workspace, "shared.txt"), "utf8")).toBe("a")
})

test("a stalled queue requests one Architect review and leaves scheduling decisions with the Architect", async () => {
  let now = Date.now()
  const f = fixture({
    independent: true,
    delayed: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const prerequisite = f.receipt.planID
  const plans = []
  for (const name of ["b", "c"]) {
    const task = f.createTask(name, `${name}.txt`)
    const plan = f.store.submit(
      {
        ...f.inputFor([task], { requestID: `queue-review-${name}` }),
        afterPlans: [prerequisite],
      },
      "owner",
    )
    plans.push(plan.planID)
    await runPlan(f, plan.planID, `run-queue-review-${name}`)
  }
  const review = () =>
    f.notifications.filter((notice) => notice.text.includes('"status":"queue-review"'))
  await runPlan(f)
  await f.runtime.tick()
  expect(f.store.attempts(prerequisite)[0]?.state).toBe("running")
  expect(review()).toHaveLength(0)
  const worker = f.store.attempts(prerequisite)[0]!
  const session = f.sessions.get(worker.session_id)!
  session.busy = false
  await f.runtime.tick()
  await f.runtime.tick()
  expect(review()).toHaveLength(1)
  expect(review()[0]).toMatchObject({ sessionID: "owner", resume: true })
  expect(review()[0]?.text).toContain("Unblock the queue now")
  expect(review()[0]?.text).toContain("Own sequencing, parallelism, and retries")
  for (const planID of plans) {
    expect(review()[0]?.text).toContain(planID)
    expect(f.store.attempts(planID)).toHaveLength(0)
  }

  now += 5 * 60_000
  await f.runtime.tick()
  expect(review()).toHaveLength(1) // The first request still owns its native inbox entry.
  const inbox = f.inbox.get("owner")!
  const delivered = inbox.find((entry) => entry.id === review()[0]!.id)!
  const architect = f.sessions.get("owner")!
  architect.messages.push({
    id: delivered.id,
    type: "synthetic",
    text: "Queue review",
    metadata: delivered.metadata,
  })
  f.inbox.set(
    "owner",
    inbox.filter((entry) => entry.id !== delivered.id),
  )
  architect.pendingForms = 1
  await f.runtime.tick()
  expect(review()).toHaveLength(1)
  architect.pendingForms = 0
  await f.runtime.tick()
  expect(review()).toHaveLength(2)
  await f.runtime.tick()
  expect(review()).toHaveLength(2)
})
