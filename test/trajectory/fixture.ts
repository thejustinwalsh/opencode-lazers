import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../proposal.ts"
import { TaskRepository } from "../../src/storage.ts"
import { RunnerStore } from "../../src/runner/store.ts"
import type { AttemptRow } from "../../src/runner/store.ts"
import type { TrajectoryHost, TrajectorySession } from "../../src/trajectory/native.ts"

export const taskID = "bb53fd1c-85cc-4d67-932d-b8b69a197d8b"
export const firstAttemptID = "73cf4094-c79a-4e16-9705-aac76becaa44"
export const secondAttemptID = "509e5ba7-6b7e-40eb-8f49-25b3789c1ba6"
export const finalCommit = "b".repeat(40)
export const cursorSecret = new Uint8Array(32).fill(7)

export function makeMessages(which: "failed" | "accepted") {
  if (which === "failed")
    return [
      {
        id: "msg-old-user",
        type: "user",
        time: { created: 1010 },
        text: "Try this: sk-proj-12345678901234567890 https://service.invalid/?token=private",
        files: [{ data: "secret attachment", mime: "text/plain" }],
      },
      {
        id: "msg-old-tool",
        type: "assistant",
        time: { created: 1020, streamed: 1030, completed: 1040 },
        agent: "lazers-implementor",
        model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
        native: { replay: "provider-only" },
        content: [
          { type: "reasoning", text: "PRIVATE REASONING DO NOT EXPORT" },
          {
            type: "tool",
            id: "call-failed",
            name: "Read",
            native: { replay: "private native" },
            state: {
              status: "error",
              input: {
                filePath: "src/index.ts",
                headers: { Authorization: "Bearer never-export-this" },
                nested: { api_key: "sk-secret-key-12345678901234567890", ok: true },
                serialized: JSON.stringify({
                  headers: { Authorization: "serialized-json-secret" },
                }),
              },
              error: {
                type: "ToolError",
                message: "failed at https://private.invalid/path; token=credential-value",
                response: { body: "RAW RESPONSE BODY MUST NOT EXPORT" },
              },
              response: { body: "raw body" },
            },
            time: { created: 1030, ran: 1035, completed: 1040 },
          },
        ],
        metadata: { system: "hidden" },
        tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 5, write: 0 } },
      },
      {
        id: "msg-old-retry",
        type: "assistant",
        time: { created: 1050 },
        model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
        content: [],
        retry: {
          attempt: 2,
          at: 1052,
          error: { type: "ProviderError", message: "Bearer retry-secret-value" },
        },
      },
    ]

  return [
    {
      id: "msg-new-user",
      type: "user",
      time: { created: 2010 },
      text: `${"x".repeat(3990)} api_key=hidden-after-the-boundary`,
    },
    {
      id: "msg-new-tool",
      type: "assistant",
      time: { created: 2020 },
      agent: "lazers-implementor",
      model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
      content: [
        {
          type: "tool",
          id: "call-success",
          name: "Bash",
          state: {
            status: "completed",
            input: { command: "bun test", password: "hidden-value", directory: "src" },
            content: [
              { type: "text", text: "All good. GitHub token ghp_123456789012345678901234567890" },
              { type: "file", uri: "file:///private/body", mime: "text/plain", name: "secret.txt" },
              { type: "future-private-part", text: "unknown part should fail closed" },
            ],
            metadata: { key: "private metadata" },
          },
          time: { created: 2021, ran: 2022, completed: 2030 },
        },
        { type: "reasoning", text: "Another private chain of thought" },
        { type: "text", text: "The visible implementation is ready." },
        { type: "image", source: "private image data" },
      ],
    },
    {
      id: "msg-compaction",
      type: "compaction",
      time: { created: 2040 },
      status: "completed",
      reason: "auto",
      summary: "PRIVATE COMPACTION SUMMARY",
      native: { messages: [{ text: "REPLAY DATA" }] },
      metadata: { sensitive: "secret" },
    },
    {
      id: "msg-system",
      type: "system",
      time: { created: 2050 },
      text: "SYSTEM INSTRUCTIONS MUST NOT EXPORT",
    },
    {
      id: "msg-location",
      type: "location-switched",
      time: { created: 2075 },
      location: { directory: "/private/worktree/secret" },
    },
    {
      id: "msg-idle",
      type: "idle",
      time: { created: 2100 },
      outcome: "succeeded",
    },
    {
      id: "msg-unknown",
      type: "future-private-message",
      time: { created: 2110 },
      content: "unknown message payload must not export",
    },
  ]
}

export function makeFixture(
  options: { withoutPolicy?: boolean; defaultVerificationTiming?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "lazers-trajectory-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), directory)
  const store = new RunnerStore(repository)
  const baseCommit = "a".repeat(40)
  const proposal = validProposal()
  if (options.withoutPolicy) delete proposal.requirements.policyReference
  proposal.guidance =
    "Reuse src/runner/store.ts for recorded attempts; api_key=fake-guidance-secret"
  proposal.objective = "Inspect a worker attempt without disclosing private data"
  proposal.acceptance = [
    {
      id: "accepted",
      assertion: "A successful retry follows a failed attempt",
      evidence: [{ kind: "verification", verificationID: "attempt-check" }],
    },
  ]
  proposal.verification = [
    {
      id: "attempt-check",
      command: "bun test",
      ...(options.defaultVerificationTiming ? {} : { timeoutMs: 60000 }),
    },
  ]
  const task = repository.insert({
    schemaVersion: 1,
    id: taskID,
    revision: 1,
    status: "submitted",
    createdAt: "2026-10-31T12:00:00.000Z",
    provenance: {
      projectID: "project",
      projectDirectory: directory,
      workspaceDirectory: directory,
      sessionID: "ses-owner",
      startingRevision: { kind: "git", commit: baseCommit },
    },
    proposal,
  })
  const receipt = store.submit(
    {
      requestID: "trajectory-plan",
      objective: "Inspect worker effort",
      baseCommit,
      workspaceMode: "shared",
      workerModel: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
      nodes: [{ taskID, revision: 1 }],
      dependencies: [],
      integrationOrder: [taskID],
      verification: [{ id: "combined", command: "bun test", timeoutMs: 60000 }],
      acceptance: [
        {
          id: "graph-accepted",
          assertion: "Combined checks pass",
          evidence: [{ kind: "verification", verificationID: "combined" }],
        },
      ],
    },
    "ses-owner",
  )
  const policy = JSON.stringify({
    model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
    repairAttempt: false,
  })
  const attempts: AttemptRow[] = [
    {
      id: firstAttemptID,
      plan_id: receipt.planID,
      task_id: taskID,
      number: 1,
      session_id: "ses-failed",
      message_id: "msg-first",
      workspace: directory,
      base_commit: baseCommit,
      artifact: null,
      policy,
      state: "failed",
      started_at: 1000,
      token_count: 99,
      tool_count: 2,
      retry_count: 1,
      cost: null,
    },
    {
      id: secondAttemptID,
      plan_id: receipt.planID,
      task_id: taskID,
      number: 2,
      session_id: "ses-accepted",
      message_id: "msg-second",
      workspace: directory,
      base_commit: baseCommit,
      artifact: finalCommit,
      policy,
      state: "accepted",
      started_at: 2000,
      token_count: 88,
      tool_count: 3,
      retry_count: 0,
      cost: null,
    },
  ]
  store.atomic((db) => {
    for (const attempt of attempts)
      db.query(
        "INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count,tool_count,retry_count,cost) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        attempt.id,
        attempt.plan_id,
        attempt.task_id,
        attempt.number,
        attempt.session_id,
        attempt.message_id,
        attempt.workspace,
        attempt.base_commit,
        attempt.artifact,
        attempt.policy,
        attempt.state,
        attempt.started_at,
        attempt.token_count,
        attempt.tool_count,
        attempt.retry_count,
        attempt.cost,
      )
    db.query(
      "UPDATE runner_plans SET state='accepted',model=?,artifact=?,version=version+1 WHERE id=?",
    ).run(
      JSON.stringify({ providerID: "openai", id: "gpt-6-luna", variant: "max" }),
      finalCommit,
      receipt.planID,
    )
    db.query(
      "UPDATE runner_nodes SET state='accepted',artifact=?,version=version+1 WHERE plan_id=? AND task_id=?",
    ).run(finalCommit, receipt.planID, taskID)
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,'RETRY_REQUESTED',?,1500)",
    ).run(
      receipt.planID,
      taskID,
      JSON.stringify({ attemptID: firstAttemptID, reason: "retry without losing prior effort" }),
    )
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,2,'ACCEPT',?,4000)",
    ).run(
      receipt.planID,
      taskID,
      JSON.stringify({ from: "verifying", to: "accepted", attemptID: secondAttemptID }),
    )
    const insertEffect = (
      id: string,
      attemptID: string | null,
      kind: string,
      receiptText: string,
    ) =>
      db
        .query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'completed','{}',?,1)")
        .run(id, receipt.planID, attemptID ? taskID : null, attemptID, kind, receiptText)
    insertEffect(
      "check-failed",
      firstAttemptID,
      "verify:attempt-check",
      JSON.stringify({
        check: {
          id: "attempt-check",
          command: "bun test",
          cwd: directory,
          artifact: baseCommit,
          inputIdentity: baseCommit,
          environmentIdentity: "safe",
          startedAt: 1100,
          endedAt: 1200,
          exitCode: 7,
          timedOut: false,
          stdout: "Failure; api_key=logged-secret",
          stderr: "",
          unchanged: true,
        },
      }),
    )
    insertEffect(
      "check-success",
      secondAttemptID,
      "verify:attempt-check",
      JSON.stringify({
        check: {
          id: "attempt-check",
          command: "bun test",
          cwd: directory,
          artifact: finalCommit,
          inputIdentity: finalCommit,
          environmentIdentity: "safe",
          startedAt: 3000,
          endedAt: 3500,
          exitCode: 0,
          timedOut: false,
          stdout: "All tests passed",
          stderr: "",
          unchanged: true,
        },
      }),
    )
    insertEffect(
      "check-combined",
      null,
      "graph-verify:combined",
      JSON.stringify({
        check: {
          id: "combined",
          command: "bun test",
          cwd: directory,
          artifact: finalCommit,
          inputIdentity: finalCommit,
          environmentIdentity: "safe",
          startedAt: 3600,
          endedAt: 3800,
          exitCode: 0,
          timedOut: false,
          stdout: "Combined pass",
          stderr: "",
          unchanged: true,
        },
      }),
    )
  })

  const sessions = new Map<string, TrajectorySession>([
    [
      "ses-failed",
      {
        id: "ses-failed",
        projectID: "project",
        parentID: "ses-owner",
        model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
        outcome: "failed",
        busy: false,
        time: { created: 900, updated: 1200, busy: 950, idle: 1200 },
        tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 5, write: 0 } },
        messages: makeMessages("failed") as never,
        messageStatus: "available",
        messageError: null,
      },
    ],
    [
      "ses-accepted",
      {
        id: "ses-accepted",
        projectID: "project",
        parentID: "ses-owner",
        model: { providerID: "openai", id: "gpt-6.1-sol", variant: "high" },
        outcome: "succeeded",
        busy: false,
        time: { created: 1900, updated: 2100, busy: 1950, idle: 2100 },
        tokens: { input: 20, output: 4, reasoning: 3, cache: { read: 7, write: 1 } },
        messages: makeMessages("accepted") as never,
        messageStatus: "available",
        messageError: null,
      },
    ],
  ])
  const host: TrajectoryHost = {
    session: async (id) => sessions.get(id) ?? null,
  }
  const close = () => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
  return { directory, repository, store, task, receipt, attempts, sessions, host, close }
}
