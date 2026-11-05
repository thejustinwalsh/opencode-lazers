import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { fingerprint } from "../identity.ts"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import type { ArchitectObservedMessage } from "./store.ts"
import { RunnerStore } from "./store.ts"
import { registerRunnerTools } from "./tools.ts"
import type { TaskRuntime } from "./runtime.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

const callContext = (agent: string) =>
  ({
    sessionID: Session.ID.make("ses_test"),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_test"),
    id: Tool.CallID.make("call_test"),
    progress: () => Effect.void,
  }) as Parameters<RegisteredTool["execute"]>[1]

test("authorized callers read native catalog advice; only orchestration requires Architect", async () => {
  const tools = new Map<string, RegisteredTool>()
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const permissionChecks: string[] = []
  const continuityCalls: { sessionID: string; input: unknown }[] = []
  let catalogCalls = 0
  let denied = false
  const ctx = {
    location: { directory: "/project" },
    agent: {
      get: () =>
        Effect.succeed({
          data: { model: { providerID: "opencode-go", id: "qwen3.8-flash", variant: "xhigh" } },
        }),
    },
    model: {
      list: () => {
        catalogCalls++
        return Effect.succeed({
          data: [
            {
              providerID: "opencode-go",
              id: "qwen3.8-flash",
              name: "Qwen3.8 Flash",
              enabled: true,
              capabilities: { tools: false, input: ["text"], output: ["text"] },
              limit: { context: 256_000 },
              cost: [],
              variants: [{ id: "xhigh" }],
            },
          ],
        })
      },
    },
    permission: {
      assert: ({ action }: { action: string }) => {
        permissionChecks.push(action)
        if (denied) return Effect.fail(new Error("permission denied"))
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
  const runtime = {
    recordArchitectContinuity: async (sessionID: string, input: unknown) => {
      continuityCalls.push({ sessionID, input })
      return { status: "recorded", sessionID, revision: 1 }
    },
  } as unknown as TaskRuntime
  await Effect.runPromise(Effect.scoped(registerRunnerTools(ctx, runtime)))
  for (const tool of tools.values()) expect(tool.options?.codemode).toBe(true)
  expect(tools.get("lz-plan-command")?.description).toContain("retained-repair")

  const catalog = tools.get("lz-worker-catalog")!
  expect(catalog.options).toMatchObject({ codemode: true, permission: "lz-worker-catalog" })
  const result = await Effect.runPromise(catalog.execute({}, callContext("architect")))
  const advice = JSON.parse(String(result.content))
  expect(advice.options[0]).toMatchObject({
    providerID: "opencode-go",
    id: "qwen3.8-flash",
    capabilities: { tools: false },
    variants: ["xhigh"],
    pricesUSDPerMillionTokens: null,
  })
  expect(advice.advisoryOnly).toBe(true)
  expect(permissionChecks).toEqual(["lz-worker-catalog"])
  expect(catalogCalls).toBe(1)

  const worker = await Effect.runPromise(catalog.execute({}, callContext("lazers-implementor")))
  const workerAdvice = JSON.parse(String(worker.content))
  expect(workerAdvice.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  expect({ ...workerAdvice, observedAt: advice.observedAt }).toEqual(advice)
  expect(permissionChecks).toEqual(["lz-worker-catalog", "lz-worker-catalog"])
  expect(catalogCalls).toBe(2)
  const continuity = tools.get("lz-record-architect-continuity")!
  expect(continuity.options).toMatchObject({
    codemode: true,
    permission: "lz-record-architect-continuity",
  })
  const checkpoint = {
    decisions: ["Keep the accepted direction."],
    unresolvedQuestions: ["Confirm rollout."],
  }
  const recorded = await Effect.runPromise(continuity.execute(checkpoint, callContext("architect")))
  expect(JSON.parse(String(recorded.content))).toMatchObject({
    status: "recorded",
    sessionID: "ses_test",
    revision: 1,
  })
  expect(continuityCalls).toEqual([{ sessionID: "ses_test", input: checkpoint }])
  expect(tools.get("lz-plan-command")!.description).toContain(
    "settle a terminal failed isolated-worktree startup",
  )
  await expect(
    Effect.runPromise(continuity.execute(checkpoint, callContext("lazers-implementor"))),
  ).rejects.toThrow("Plan orchestration is restricted to Architect")
  denied = true
  await expect(
    Effect.runPromise(continuity.execute(checkpoint, callContext("architect"))),
  ).rejects.toThrow("permission denied")
  expect(continuityCalls).toHaveLength(1)
  denied = false
  for (const name of ["lz-submit-plan", "lz-plan-command"])
    await expect(
      Effect.runPromise(tools.get(name)!.execute({}, callContext("lazers-implementor"))),
    ).rejects.toThrow("Plan orchestration is restricted to Architect")
  denied = true
  await expect(
    Effect.runPromise(catalog.execute({}, callContext("lazers-implementor"))),
  ).rejects.toThrow("permission denied")
  expect(catalogCalls).toBe(2)
})

test("journal inspection is permission-gated before bounded store reads", async () => {
  const tools = new Map<string, RegisteredTool>()
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const permissionChecks: string[] = []
  const reads: unknown[][] = []
  const sourceReads: unknown[][] = []
  let denied = true
  const ctx = {
    location: { directory: "/project" },
    permission: {
      assert: ({ action }: { action: string }) => {
        permissionChecks.push(action)
        return denied ? Effect.fail(new Error("permission denied")) : Effect.void
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
  const runtime = {
    inspectArchitectSourceMessages: (...args: unknown[]) => {
      sourceReads.push(args)
      return { mode: "source-messages", selected: 1, messages: [] }
    },
    store: {
      architectSourceJournalPage: (...args: unknown[]) => {
        reads.push(args)
        return { mode: "journal", planID: "11111111-1111-4111-8111-111111111111", records: [] }
      },
    },
  } as unknown as TaskRuntime
  await Effect.runPromise(Effect.scoped(registerRunnerTools(ctx, runtime)))

  const inspection = tools.get("lz-inspect-plan")!
  expect(inspection.options).toMatchObject({
    codemode: true,
    permission: "lz-inspect-plan",
  })
  const input = {
    planID: "11111111-1111-4111-8111-111111111111",
    view: "journal",
    limit: 25,
  }
  await expect(
    Effect.runPromise(inspection.execute(input, callContext("lazers-implementor"))),
  ).rejects.toThrow("permission denied")
  expect(reads).toEqual([])

  denied = false
  const result = await Effect.runPromise(
    inspection.execute(input, callContext("lazers-implementor")),
  )
  expect(JSON.parse(String(result.content))).toMatchObject({
    mode: "journal",
    planID: input.planID,
    records: [],
  })
  expect(reads).toEqual([[input.planID, 25, undefined]])
  const sourceInput = {
    planID: input.planID,
    view: "source-messages",
    sourceSessionID: "ses_predecessor",
    messageIDs: ["msg_original"],
  }
  const sourceResult = await Effect.runPromise(
    inspection.execute(sourceInput, callContext("architect")),
  )
  expect(JSON.parse(String(sourceResult.content))).toMatchObject({
    mode: "source-messages",
    selected: 1,
  })
  expect(sourceReads).toEqual([[sourceInput, "ses_test"]])
  await expect(
    Effect.runPromise(
      inspection.execute({ ...input, limit: 101 }, callContext("lazers-implementor")),
    ),
  ).rejects.toThrow()
  await expect(
    Effect.runPromise(
      inspection.execute(
        { ...input, view: "journal", cursor: "cursor-without-plan-scope", full: true },
        callContext("lazers-implementor"),
      ),
    ),
  ).rejects.toThrow()
  await expect(
    Effect.runPromise(
      inspection.execute(
        { ...sourceInput, messageIDs: ["duplicate", "duplicate"] },
        callContext("architect"),
      ),
    ),
  ).rejects.toThrow()
  expect(reads).toHaveLength(1)
  expect(sourceReads).toHaveLength(1)
  expect(permissionChecks).toEqual([
    "lz-inspect-plan",
    "lz-inspect-plan",
    "lz-inspect-plan",
    "lz-inspect-plan",
    "lz-inspect-plan",
    "lz-inspect-plan",
  ])
})

test("registered journal traversal survives unrelated worker progress in the same project", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-journal-tool-"))
  const projectDirectory = join(directory, "project")
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), projectDirectory)
  try {
    const task = repository.insert({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      revision: 1,
      status: "submitted",
      createdAt: new Date().toISOString(),
      provenance: {
        projectID: "project",
        projectDirectory,
        workspaceDirectory: projectDirectory,
        sessionID: "ses_test",
        startingRevision: { kind: "unborn" },
      },
      proposal: validProposal(),
    })
    const unrelatedTask = repository.insert({ ...task, id: crypto.randomUUID() })
    const store = new RunnerStore(repository)
    const plan = store.submit(
      {
        requestID: "registered-source-journal",
        title: "Source journal pagination",
        objective: "Inspect retained Architect references progressively",
        baseCommit: "b".repeat(40),
        nodes: [{ taskID: task.id, revision: 1 as const }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: task.proposal.verification,
        acceptance: task.proposal.acceptance,
      },
      "ses_test",
    )
    const unrelatedPlan = store.submit(
      {
        requestID: "unrelated-worker-progress-plan",
        title: "Unrelated worker progress",
        objective: "Keep unrelated project activity outside journal traversal",
        baseCommit: "c".repeat(40),
        nodes: [{ taskID: unrelatedTask.id, revision: 1 as const }],
        dependencies: [],
        integrationOrder: [unrelatedTask.id],
        verification: unrelatedTask.proposal.verification,
        acceptance: unrelatedTask.proposal.acceptance,
      },
      "ses_unrelated_worker",
    )
    const renewalID = crypto.randomUUID()
    const sourceSessionID = "ses_architect_predecessor"
    const originalResult = {
      state: "completed" as const,
      finish: "stop" as const,
      toolCounts: { running: 0, completed: 0, failed: 0, other: 0 },
    }
    store.atomic((db) => {
      db.query(
        `INSERT INTO runner_architect_renewals(
           id,anchor_plan_id,previous_session_id,successor_session_id,directory,model,idle_at,
           generation,state,handoff_message_id,started_at
         ) VALUES(?,?,?,?,?,?,?,1,'committed',?,?)`,
      ).run(
        renewalID,
        plan.planID,
        sourceSessionID,
        "ses_architect_successor",
        projectDirectory,
        "{}",
        1,
        "msg_handoff",
        2,
      )
      db.query(
        "INSERT INTO runner_architect_renewal_plans(renewal_id,plan_id,transferred) VALUES(?,?,1)",
      ).run(renewalID, plan.planID)
      db.query(
        `INSERT INTO runner_architect_sources(
           session_id,renewal_id,anchor_plan_id,scan_cursor,scan_sweep,revision,state,updated_at
         ) VALUES(?,?,?,NULL,1,1,'active',3)`,
      ).run(sourceSessionID, renewalID, plan.planID)
      db.query(
        `INSERT INTO runner_architect_inputs(
           session_id,message_id,observed_at,renewal_id,native_type,delivery,disposition,
           metadata_json,last_seen_sweep,referenced_revision,updated_at
         ) VALUES(?,?,4,?,'user',NULL,'pending',NULL,1,1,4)`,
      ).run(sourceSessionID, "msg_architect_input", renewalID)
      const result = db.query(
        `INSERT INTO runner_architect_source_results(
           session_id,renewal_id,message_id,state,finish,tool_running,tool_completed,tool_failed,
           tool_other,result_fingerprint,result_revision,referenced_revision,updated_at
          ) VALUES(?,?,?,'completed','stop',0,0,0,0,?,1,1,?)`,
      )
      result.run(
        sourceSessionID,
        renewalID,
        "msg_architect_result_1",
        fingerprint(originalResult),
        5,
      )
      result.run(
        sourceSessionID,
        renewalID,
        "msg_architect_result_2",
        fingerprint(originalResult),
        6,
      )
    })

    const tools = new Map<string, RegisteredTool>()
    const editor: ToolEditor = {
      add: (tool) => tools.set(tool.name, tool),
      list: () => [],
      get: () => undefined,
      namespace: () => {},
      update: () => {},
      remove: () => {},
    }
    const ctx = {
      location: { directory: projectDirectory },
      permission: { assert: () => Effect.void },
      tool: {
        transform: (transform: (editor: ToolEditor) => void) =>
          Effect.sync(() => {
            transform(editor)
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Plugin.Context
    await Effect.runPromise(
      Effect.scoped(registerRunnerTools(ctx, { store } as unknown as TaskRuntime)),
    )
    const inspect = tools.get("lz-inspect-plan")!
    const read = async (input: unknown) => {
      const result = await Effect.runPromise(
        inspect.execute(input, callContext("lazers-implementor")),
      )
      return JSON.parse(String(result.content)) as {
        records: Array<{ recordID: string }>
        nextCursor: string | null
        page: { hasMore: boolean }
      }
    }
    const journalSnapshot = () =>
      store.atomic((db) => ({
        revision:
          db
            .query<{ revision: number }, [string, string]>(
              `SELECT revision FROM runner_architect_journal_revisions
               WHERE project_directory=? AND plan_id=?`,
            )
            .get(projectDirectory, plan.planID)?.revision ?? 0,
        sourceRevision: db
          .query<{ revision: number }, [string]>(
            "SELECT revision FROM runner_architect_sources WHERE session_id=?",
          )
          .get(sourceSessionID),
        input: db
          .query(
            "SELECT message_id,native_type,delivery,disposition,referenced_revision FROM runner_architect_inputs WHERE session_id=?",
          )
          .get(sourceSessionID),
        results: db
          .query(
            "SELECT message_id,state,finish,tool_running,tool_completed,tool_failed,tool_other,result_fingerprint,result_revision,referenced_revision FROM runner_architect_source_results WHERE session_id=? ORDER BY message_id",
          )
          .all(sourceSessionID),
      }))
    const scanDiagnostics = () =>
      store.atomic((db) =>
        db
          .query(
            "SELECT scan_cursor,scan_sweep,updated_at FROM runner_architect_sources WHERE session_id=?",
          )
          .get(sourceSessionID),
      )
    const projectRevision = () =>
      store.atomic(
        (db) =>
          db
            .query<{ revision: number }, [string]>(
              "SELECT revision FROM observation_revisions WHERE project_directory=?",
            )
            .get(projectDirectory)?.revision ?? 0,
      )

    const first = await read({ planID: plan.planID, view: "journal", limit: 1 })
    expect(first.records).toHaveLength(1)
    expect(first.nextCursor).toBeString()
    const beforeProjectRevision = projectRevision()
    const beforeJournal = journalSnapshot()
    store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_progress(
             project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
             source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          projectDirectory,
          "project",
          unrelatedPlan.planID,
          unrelatedTask.id,
          "unrelated-attempt",
          "ses_unrelated_worker",
          Date.now(),
          Date.now(),
          "native",
          "[]",
          "progress",
          "[]",
          null,
          null,
          "unrelated-worker-progress",
          "{}",
        ),
    )
    expect(projectRevision()).toBeGreaterThan(beforeProjectRevision)
    expect(journalSnapshot()).toEqual(beforeJournal)

    const beforeNoOpScanDiagnostics = scanDiagnostics()
    const runScan = (
      cursor: string | null,
      nextCursor: string | null,
      now: number,
      inputDelivery?: "steer",
      result: NonNullable<ArchitectObservedMessage["result"]> = originalResult,
    ) => {
      const schedulerOwner = "journal-scan-test"
      const fence = store.claim(schedulerOwner, now)
      expect(fence).not.toBeNull()
      return store.recordArchitectSourcePage({
        schedulerOwner,
        fence: fence!,
        sessionID: sourceSessionID,
        cursor,
        nextCursor,
        inbox: [
          {
            id: "msg_architect_input",
            type: "user",
            ...(inputDelivery ? { delivery: inputDelivery } : {}),
          },
        ],
        messages: [
          { id: "msg_architect_input", type: "user" },
          { id: "msg_architect_result_1", type: "assistant", result },
          { id: "msg_architect_result_2", type: "assistant", result },
        ],
        now,
        projectID: "project",
      })
    }
    runScan(null, "native-cursor-1", 10)
    runScan("native-cursor-1", "native-cursor-2", 11)
    expect(journalSnapshot()).toEqual(beforeJournal)
    expect(scanDiagnostics()).not.toEqual(beforeNoOpScanDiagnostics)

    const recordIDs = first.records.map((record) => record.recordID)
    let cursor: string | undefined = first.nextCursor ?? undefined
    while (cursor) {
      const page = await read({ planID: plan.planID, view: "journal", limit: 1, cursor })
      recordIDs.push(...page.records.map((record) => record.recordID))
      expect(page.page.hasMore).toBe(page.nextCursor !== null)
      cursor = page.nextCursor ?? undefined
    }
    expect(recordIDs).toEqual([
      `source:${sourceSessionID}`,
      `input:${sourceSessionID}:msg_architect_input`,
      `result:${sourceSessionID}:msg_architect_result_1`,
      `result:${sourceSessionID}:msg_architect_result_2`,
    ])
    expect(new Set(recordIDs).size).toBe(recordIDs.length)
    expect(journalSnapshot()).toEqual(beforeJournal)

    const inputCursorPage = await read({ planID: plan.planID, view: "journal", limit: 1 })
    expect(inputCursorPage.nextCursor).toBeString()
    runScan("native-cursor-2", "native-cursor-3", 12, "steer")
    await expect(
      read({
        planID: plan.planID,
        view: "journal",
        limit: 1,
        cursor: inputCursorPage.nextCursor,
      }),
    ).rejects.toThrow("Journal changed since this page; restart the journal view")

    const resultCursorPage = await read({ planID: plan.planID, view: "journal", limit: 1 })
    expect(resultCursorPage.nextCursor).toBeString()
    runScan("native-cursor-3", "native-cursor-4", 13, "steer", {
      state: "running",
      finish: null,
      toolCounts: { running: 1, completed: 0, failed: 0, other: 0 },
    })
    await expect(
      read({
        planID: plan.planID,
        view: "journal",
        limit: 1,
        cursor: resultCursorPage.nextCursor,
      }),
    ).rejects.toThrow("Journal changed since this page; restart the journal view")
  } finally {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
