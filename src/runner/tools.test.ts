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
import { ProgressRecorder } from "../progress/recorder.ts"
import { registerToolCallWrappers } from "../progress/tool-observation.ts"
import { TaskRepository } from "../storage.ts"
import type { ArchitectObservedMessage } from "./store.ts"
import { RunnerStore } from "./store.ts"
import { createRetainedVerification } from "./retained-verification/store.ts"
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
  expect(tools.get("lz-plan-command")?.description).toContain("runtime-fenced retained repair")
  expect(tools.get("lz-plan-command")?.description).toContain("user cancellation is excluded")

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
  const planCommandDescription = tools.get("lz-plan-command")!.description
  expect(planCommandDescription).toContain("expectedVersion and stable requestID")
  expect(planCommandDescription).toContain("without taskID")
  expect(planCommandDescription).toContain("settled combined checks")
  expect(planCommandDescription).toContain("extend-verification-deadline")
  expect(planCommandDescription).toContain("verify-retained")
  expect(planCommandDescription).toContain("without an implementation turn")
  expect(planCommandDescription).toContain("startup settlement")
  expect(planCommandDescription.length).toBeLessThan(600)
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

test("registered selected full inspection reads retained verification without runtime or native calls", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-retained-tool-"))
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
    const store = new RunnerStore(repository)
    const plan = store.submit(
      {
        requestID: "registered-retained-inspection",
        title: "Read retained checks",
        objective: "Show persisted verification facts without runtime control",
        baseCommit: "b".repeat(40),
        nodes: [{ taskID: task.id, revision: 1 as const }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: task.proposal.verification,
        acceptance: task.proposal.acceptance,
      },
      "ses_test",
    )
    const foreignTask = repository.insert({ ...task, id: crypto.randomUUID() })
    const foreignPlan = store.submit(
      {
        requestID: "foreign-retained-inspection",
        title: "Foreign retained checks",
        objective: "Keep another plan outside selected inspection",
        baseCommit: "c".repeat(40),
        nodes: [{ taskID: foreignTask.id, revision: 1 as const }],
        dependencies: [],
        integrationOrder: [foreignTask.id],
        verification: foreignTask.proposal.verification,
        acceptance: foreignTask.proposal.acceptance,
      },
      "ses_test",
    )
    const operation = {
      schemaVersion: 1 as const,
      id: crypto.randomUUID(),
      generation: 3,
      projectID: "project",
      projectDirectory,
      planID: plan.planID,
      planRevision: 1,
      planVersion: 1,
      owner: "ses_test",
      ownerEpoch: 0,
      taskID: task.id,
      taskRevision: 1,
      attemptID: crypto.randomUUID(),
      originalSessionID: "ses_private_canary",
      originalMessageID: "msg_private_canary",
      originalWorkspace: "/private/ORIGINAL_WORKSPACE_CANARY",
      artifact: "a".repeat(40),
      combinedArtifact: null,
      combinedInputFingerprint: null,
      taskWorkspace: null,
      taskWorkspaceState: null,
      combinedWorkspace: null,
      combinedWorkspaceState: null,
      inputFingerprint: fingerprint("input"),
      environmentIdentity: JSON.stringify({ PATH: "/private/ENVIRONMENT_CONTENT_CANARY" }),
      reason: "PRIVATE_REASON_CANARY",
      state: "accepted" as const,
      holdReason: "PRIVATE_HOLD_CANARY",
      cleanupState: "failed" as const,
      createdAt: 100,
      updatedAt: 200,
    }
    for (const generation of [1, 2])
      store.atomic((db) =>
        createRetainedVerification(db, projectDirectory, {
          ...operation,
          id: crypto.randomUUID(),
          generation,
          state: "failed",
          cleanupState: "complete",
        }),
      )
    store.atomic((db) => createRetainedVerification(db, projectDirectory, operation))
    const foreignOperation = {
      ...operation,
      id: crypto.randomUUID(),
      planID: foreignPlan.planID,
      taskID: foreignTask.id,
      generation: 1,
      state: "accepted" as const,
    }
    store.atomic((db) => createRetainedVerification(db, projectDirectory, foreignOperation))
    store.atomic((db) => {
      db.query(
        `INSERT INTO runner_retained_verification_checks(
          operation_id,phase,check_id,check_json,workspace,artifact,input_fingerprint,
          environment_identity,receipt_path,state,receipt,context_path,cleanup_state,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'completed',?,?,?,?)`,
      ).run(
        operation.id,
        "task",
        "tests",
        JSON.stringify({ id: "tests", command: "PRIVATE_COMMAND_CANARY" }),
        "/private/CHECK_WORKSPACE_CANARY",
        operation.artifact,
        fingerprint("check-input"),
        JSON.stringify({ PATH: "/private/CHECK_ENV_CANARY" }),
        "/private/CHECK_RECEIPT_CANARY",
        JSON.stringify({
          id: "tests",
          command: "PRIVATE_COMMAND_CANARY",
          cwd: "/private/CHECK_WORKSPACE_CANARY",
          artifact: operation.artifact,
          inputIdentity: operation.artifact,
          environmentIdentity: JSON.stringify({ PATH: "/private/CHECK_ENV_CANARY" }),
          startedAt: 1_000,
          endedAt: 1_100,
          exitCode: 0,
          timedOut: false,
          stdout: "PRIVATE_STDOUT_CANARY",
          stderr: "PRIVATE_STDERR_CANARY",
        }),
        "/private/CHECK_CONTEXT_CANARY",
        "failed",
        900,
      )
      db.query(
        `INSERT INTO runner_retained_verification_resources(
          project_directory,operation_id,generation,phase,check_id,resource_name,canonical_path,
          device,inode,state,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'uncertain',?,?)`,
      ).run(
        projectDirectory,
        operation.id,
        operation.generation,
        "task",
        "tests",
        "PRIVATE_RESOURCE_CANARY",
        "/private/RESOURCE_CANARY",
        1,
        2,
        1_050,
        1_060,
      )
    })

    const tools = new Map<string, RegisteredTool>()
    const editor: ToolEditor = {
      add: (tool) => tools.set(tool.name, Object.assign(tool, { id: tool.name })),
      list: () => [...tools.values()] as never,
      get: (id) => tools.get(id) as never,
      namespace: () => {},
      update: (id, update) => {
        const entry = tools.get(id)
        if (entry) update(entry as never)
      },
      remove: () => {},
    }
    let permissionChecks = 0
    let runtimeCalls = 0
    let nativeCalls = 0
    let inferenceCalls = 0
    const ctx = {
      location: { directory: projectDirectory },
      session: {
        get: () =>
          Effect.succeed({ projectID: "project", location: { directory: projectDirectory } }),
      },
      permission: { assert: () => (permissionChecks++, Effect.void) },
      model: { list: () => (inferenceCalls++, Effect.succeed({ data: [] })) },
      tool: {
        transform: (transform: (editor: ToolEditor) => void) =>
          Effect.sync(() => {
            transform(editor)
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Plugin.Context
    const runtime = {
      store,
      command: () => (runtimeCalls++, Promise.reject(new Error("unexpected control call"))),
      inspectArchitectSourceMessages: () => (
        nativeCalls++,
        Promise.reject(new Error("unexpected native-context call"))
      ),
    } as unknown as TaskRuntime
    await Effect.runPromise(Effect.scoped(registerRunnerTools(ctx, runtime)))
    const progress = new ProgressRecorder(store, "project")
    await Effect.runPromise(Effect.scoped(registerToolCallWrappers(ctx, progress, "project")))
    const inspect = tools.get("lz-inspect-plan")!
    const before = store.atomic((db) => ({
      operations: db
        .query("SELECT id,generation,state,payload FROM runner_retained_verifications")
        .all(),
      checks: db
        .query(
          "SELECT operation_id,phase,check_id,state,receipt,cleanup_state FROM runner_retained_verification_checks",
        )
        .all(),
      resources: db
        .query(
          "SELECT operation_id,phase,check_id,state,updated_at FROM runner_retained_verification_resources",
        )
        .all(),
      evidence: db.query("SELECT * FROM runner_retained_verification_evidence").all(),
      nodes: db
        .query("SELECT plan_id,task_id,state,version FROM runner_nodes WHERE plan_id=?")
        .all(plan.planID),
      attempts: db
        .query("SELECT id,plan_id,task_id,state FROM runner_attempts WHERE plan_id=?")
        .all(plan.planID),
      effects: db
        .query("SELECT id,plan_id,task_id,state FROM runner_effects WHERE plan_id=?")
        .all(plan.planID),
    }))
    const result = await Effect.runPromise(
      inspect.execute({ planID: plan.planID, full: true }, callContext("architect")),
    )
    const output = JSON.parse(String(result.content)) as {
      retainedVerifications: {
        latest: Array<{
          operationID: string
          generation: number
          taskID: string
          attemptID: string
          candidateArtifact: string
          state: string
          cleanup: { state: string; resourcesByState: { uncertain: number } }
          checks: Array<{ result: { status: string }; cleanupState: string }>
        }>
        history: { records: Array<{ generation: number }>; nextCursor: string | null }
      }
    }
    const firstPageResult = await Effect.runPromise(
      inspect.execute(
        { planID: plan.planID, view: "retained-verifications", limit: 1 },
        callContext("architect"),
      ),
    )
    const firstPage = JSON.parse(String(firstPageResult.content)) as {
      latest: Array<{ generation: number; operationID: string }>
      history: { records: Array<{ generation: number }>; nextCursor: string | null }
    }
    expect(firstPage.history.nextCursor).toBeString()
    store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_attempts(
          id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,
          base_commit,policy,state,started_at,tool_count,retry_count
        ) VALUES(?,?,?,?,1,?,?,? ,?,'{}','running',?,0,0)`,
        )
        .run(
          "unrelated-progress-attempt",
          foreignPlan.planID,
          projectDirectory,
          foreignTask.id,
          "ses-unrelated-progress",
          "msg-unrelated-progress",
          projectDirectory,
          "b".repeat(40),
          Date.now(),
        ),
    )
    expect(
      progress.report({
        sessionID: "ses-unrelated-progress",
        agent: "lazers-implementor",
        callID: "unrelated-progress-call",
        messageID: "msg-unrelated-progress",
        message: "Unrelated worker progress",
      }).sequence,
    ).toBeGreaterThan(0)
    expect(store.claim("unrelated-scheduler")).toBeGreaterThan(0)
    expect(store.move(foreignPlan.planID, foreignTask.id, "READY")).toBe("ready")
    const secondPageResult = await Effect.runPromise(
      inspect.execute(
        {
          planID: plan.planID,
          view: "retained-verifications",
          limit: 1,
          cursor: firstPage.history.nextCursor,
        },
        callContext("architect"),
      ),
    )
    const secondPage = JSON.parse(String(secondPageResult.content)) as {
      history: { records: Array<{ generation: number }> }
    }
    await expect(
      Effect.runPromise(
        inspect.execute(
          {
            planID: foreignPlan.planID,
            view: "retained-verifications",
            limit: 1,
            cursor: firstPage.history.nextCursor,
          },
          callContext("architect"),
        ),
      ),
    ).rejects.toThrow("does not match this plan")
    await expect(
      Effect.runPromise(
        inspect.execute(
          {
            planID: plan.planID,
            view: "retained-verifications",
            taskIDs: [foreignTask.id],
            limit: 1,
            cursor: firstPage.history.nextCursor,
          },
          callContext("architect"),
        ),
      ),
    ).rejects.toThrow()
    const after = store.atomic((db) => ({
      operations: db
        .query("SELECT id,generation,state,payload FROM runner_retained_verifications")
        .all(),
      checks: db
        .query(
          "SELECT operation_id,phase,check_id,state,receipt,cleanup_state FROM runner_retained_verification_checks",
        )
        .all(),
      resources: db
        .query(
          "SELECT operation_id,phase,check_id,state,updated_at FROM runner_retained_verification_resources",
        )
        .all(),
      evidence: db.query("SELECT * FROM runner_retained_verification_evidence").all(),
      nodes: db
        .query("SELECT plan_id,task_id,state,version FROM runner_nodes WHERE plan_id=?")
        .all(plan.planID),
      attempts: db
        .query("SELECT id,plan_id,task_id,state FROM runner_attempts WHERE plan_id=?")
        .all(plan.planID),
      effects: db
        .query("SELECT id,plan_id,task_id,state FROM runner_effects WHERE plan_id=?")
        .all(plan.planID),
    }))
    const latest = output.retainedVerifications.latest[0]!
    expect(latest.state).toBe("accepted")
    expect(latest).toMatchObject({
      generation: 3,
      taskID: task.id,
      attemptID: operation.attemptID,
      candidateArtifact: operation.artifact,
    })
    expect(latest.cleanup).toMatchObject({ state: "failed", resourcesByState: { uncertain: 1 } })
    expect(latest.checks).toHaveLength(1)
    expect(latest.checks[0]).toMatchObject({
      result: { status: "passed" },
      cleanupState: "failed",
    })
    expect(firstPage.latest[0]).toMatchObject({ operationID: operation.id, generation: 3 })
    expect(firstPage.history.records.map((record) => record.generation)).toEqual([2])
    expect(secondPage.history.records.map((record) => record.generation)).toEqual([1])
    expect(JSON.stringify(output)).not.toContain(foreignOperation.id)
    expect(JSON.stringify(output)).not.toContain("PRIVATE_REASON_CANARY")
    expect(JSON.stringify(output)).not.toContain("PRIVATE_COMMAND_CANARY")
    expect(JSON.stringify(output)).not.toContain("PRIVATE_STDOUT_CANARY")
    expect(JSON.stringify(output)).not.toContain("PRIVATE_STDERR_CANARY")
    expect(JSON.stringify(output)).not.toContain("ENVIRONMENT_CONTENT_CANARY")
    expect(JSON.stringify(output)).not.toContain("RESOURCE_CANARY")
    expect(after).toEqual(before)
    expect(progress.toolCalls("ses_test").length).toBeGreaterThan(0)
    expect(progress.toolCalls("ses_test").some((call) => call.tool === "lz-inspect-plan")).toBe(
      true,
    )
    expect(permissionChecks).toBe(5)
    expect(runtimeCalls).toBe(0)
    expect(nativeCalls).toBe(0)
    expect(inferenceCalls).toBe(0)
  } finally {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
