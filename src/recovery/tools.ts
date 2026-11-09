import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Tool } from "@opencode/schema/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { z } from "zod"
import { isWorkerAgent } from "../runner/worker-agent.ts"
import type { TaskRepository } from "../storage.ts"
import { LocalInference } from "../webgpu/rpc.ts"
import { HandoffReviewer } from "./handoff/review.ts"
import { HandoffStore } from "./handoff/store.ts"
import {
  HandoffDispositionInput,
  HandoffDraftSubmissionInput,
  HandoffEvidence,
  HandoffFinalizeInput,
  HandoffRequestInput,
  RecoveryCheckpointInput,
  RecoveryConcernInput,
  RecoveryDispositionInput,
} from "./handoff/schema.ts"
import type { HandoffActor } from "./handoff/schema.ts"

type RecoveryContext = Pick<Plugin.Context, "tool" | "permission" | "location" | "session" | "rpc">
const limit = z.int().positive().max(100).default(20)
const concernLimit = z.int().positive().max(50).default(20)
const evidence = z.array(HandoffEvidence).max(100).default([])
const HandoffVerifyInput = z.union([
  z.strictObject({
    ...HandoffDraftSubmissionInput.shape,
    evidence,
    reviewID: z.uuid().optional(),
  }),
  z.strictObject({
    requestID: HandoffDraftSubmissionInput.shape.requestID,
    draftVersion: z.int().positive(),
    evidence,
    reviewID: z.uuid().optional(),
  }),
])

function actor(call: { sessionID: string; agent: string }): HandoffActor {
  const agent = String(call.agent)
  if (agent === "architect") return { sessionID: call.sessionID, agent, role: "architect" }
  if (isWorkerAgent(agent)) return { sessionID: call.sessionID, agent, role: "worker" }
  throw new Error(
    "Recovery controls are limited to the source plan's Architect and assigned worker",
  )
}

function output(value: unknown) {
  return { content: JSON.stringify(value ?? null), output: value ?? null }
}

function safeMessage(error: unknown): string {
  return String(error).slice(0, 500)
}

export function registerRecoveryTools(ctx: RecoveryContext, repository: TaskRepository) {
  const store = new HandoffStore(repository)
  const reviewer = new HandoffReviewer(
    store,
    {
      systemOne: (input, options) =>
        Effect.runPromise(ctx.rpc(LocalInference).review(input), {
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
    },
    async (caller, _requestID, _phase) => {
      await Effect.runPromise(
        ctx.permission.assert({
          sessionID: Session.ID.make(String(caller.sessionID)),
          agent: Agent.ID.make(String(caller.agent)),
          action: "lz-verify-handoff",
          resources: ["*"],
        }),
      )
    },
  )

  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-inspect-recovery",
      description:
        "Read bounded, source-attached recovery concerns, evidence boundaries and Architect decisions for one exact attempt. This is read-only: it does not prompt a worker, change execution, or mark acceptance.",
      input: z.strictObject({
        attemptID: z.uuid(),
        limit: concernLimit,
        cursor: z.string().optional(),
      }),
      output: z.unknown(),
      options: { codemode: true, permission: "lz-inspect-recovery" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-inspect-recovery",
            resources: ["*"],
          })
          .pipe(Effect.map(() => output(store.readConcerns(input, actor(call))))),
    })

    editor.add({
      name: "lz-record-recovery-concern",
      description:
        "Attach a bounded recovery concern to an exact project-owned attempt. Use expectedVersion 0 for its first version and the latest version when adding evidence. Immutable history and evidence boundaries are retained; this does not deliver a notification or change task authority.",
      input: z.strictObject({
        ...RecoveryConcernInput.shape,
        requestID: z.string().min(1).max(200).optional(),
      }),
      output: z.unknown(),
      options: { codemode: true, permission: "lz-record-recovery-concern" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-record-recovery-concern",
            resources: ["*"],
          })
          .pipe(
            Effect.map(() =>
              output(
                store.recordConcern(
                  { ...input, requestID: input.requestID ?? call.id },
                  actor(call),
                ),
              ),
            ),
          ),
    })

    editor.add({
      name: "lz-disposition-recovery-concern",
      description:
        "Append an Architect acknowledgement or a concrete time/condition follow-up against an exact reviewed concern version and evidence boundary. Acknowledgement covers only that boundary; follow-up is durable data, not an automatic wake or task-state transition.",
      input: z.strictObject({
        ...RecoveryDispositionInput.shape,
        requestID: z.string().min(1).max(200).optional(),
      }),
      output: z.unknown(),
      options: { codemode: true, permission: "lz-disposition-recovery-concern" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-disposition-recovery-concern",
            resources: ["*"],
          })
          .pipe(
            Effect.map(() =>
              output(
                store.recordRecoveryDisposition(
                  { ...input, requestID: input.requestID ?? call.id },
                  actor(call),
                ),
              ),
            ),
          ),
    })

    editor.add({
      name: "lz-checkpoint-recovery-worker",
      description:
        "Prepare and steer one immutable checkpoint to the exact current admitted worker for the selected concern. It asks the worker to continue the same task and workspace; admission is not consumption or response, and uncertain delivery is never resent.",
      input: z.strictObject({
        ...RecoveryCheckpointInput.shape,
        requestID: z.string().min(1).max(200).optional(),
      }),
      output: z.unknown(),
      options: { codemode: true, permission: "lz-checkpoint-recovery-worker" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-checkpoint-recovery-worker",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const caller = actor(call)
                  const requestID = input.requestID ?? call.id
                  const prepared = store.prepareCheckpoint({ ...input, requestID }, caller)
                  if (prepared.status === "conflict") return output(prepared)
                  if (prepared.status === "replayed")
                    return output(store.checkpointStateForArchitect(requestID, caller))
                  const command = store.claimCheckpointDelivery(prepared.record.requestID, caller)
                  if (!command)
                    return output(
                      store.checkpointStateForArchitect(prepared.record.requestID, caller),
                    )
                  try {
                    const session = await Effect.runPromise(
                      ctx.session.get({ sessionID: Session.ID.make(command.source.sessionID) }),
                    )
                    if (
                      session.id !== command.source.sessionID ||
                      session.projectID !== command.source.projectID ||
                      session.agent !== command.source.workerAgent ||
                      session.location.directory !== command.source.workspace
                    ) {
                      const state = store.finishCheckpointDelivery(
                        command.requestID,
                        command.messageID,
                        false,
                        "Native session project, agent, or workspace no longer matches the source attempt.",
                      )
                      return output(state)
                    }
                    store.assertCheckpointTarget(command.requestID, caller)
                    const admitted = await Effect.runPromise(
                      ctx.session.synthetic({
                        sessionID: Session.ID.make(command.source.sessionID),
                        id: SessionMessage.ID.make(command.messageID),
                        description: "LAZERS recovery checkpoint — continue in place",
                        text: [
                          "Architect checkpoint request (continue the same task and workspace; do not stop or surrender ownership):",
                          `requestID: ${command.requestID}`,
                          `concernID: ${command.concernID} version ${command.expectedVersion}`,
                          `evidence boundary: ${command.evidenceBoundary.fromSequence}–${command.evidenceBoundary.throughSequence}`,
                          command.guidance ??
                            "Report concrete progress, current blockers, and the next useful approach.",
                          "After reassessing the agreed outcome, use lz-respond-recovery-checkpoint with this requestID. A response is a report, not completion or proof of quiescence.",
                        ].join("\n"),
                        metadata: { lazersRecoveryCheckpoint: command.requestID },
                        delivery: "steer",
                      }),
                    )
                    return output(
                      store.finishCheckpointDelivery(
                        command.requestID,
                        command.messageID,
                        admitted.id === command.messageID,
                        admitted.id === command.messageID
                          ? undefined
                          : "Native admission returned a different message identity; delivery remains unknown.",
                      ),
                    )
                  } catch (error) {
                    return output(
                      store.finishCheckpointDelivery(
                        command.requestID,
                        command.messageID,
                        false,
                        `Native admission outcome is unknown: ${safeMessage(error)}`,
                      ),
                    )
                  }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })

    editor.add({
      name: "lz-respond-recovery-checkpoint",
      description:
        "Record the assigned worker's concise checkpoint response. The native context must contain the exact persisted synthetic request before this tool call; consumption and response are saved separately and neither proves completion or writer release.",
      input: z.strictObject({
        requestID: z.string().min(1).max(200),
        completed: z.string().min(1).max(8_000),
        attempted: z.array(z.string().min(1).max(8_000)).max(20),
        currentBlockers: z.array(z.string().min(1).max(8_000)).max(20),
        nextApproach: z.string().min(1).max(8_000),
        evidence,
      }),
      output: z.unknown(),
      options: { codemode: true, permission: "lz-respond-recovery-checkpoint" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-respond-recovery-checkpoint",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const caller = actor(call)
                  const checkpoint = store.checkpointForWorker(input.requestID, caller)
                  if (!checkpoint) throw new Error("Checkpoint request was not found")
                  const messages = await Effect.runPromise(
                    ctx.session.context({ sessionID: Session.ID.make(call.sessionID) }),
                  )
                  const requestIndex = messages.findIndex(
                    (message) =>
                      message.type === "synthetic" && message.id === checkpoint.command.messageID,
                  )
                  const responseIndex = messages.findIndex(
                    (message) => message.id === call.messageID,
                  )
                  if (requestIndex < 0 || responseIndex <= requestIndex)
                    throw new Error(
                      "The exact checkpoint request is not observed before this response",
                    )
                  return output(
                    store.recordCheckpointResponse(
                      {
                        ...input,
                        responseID: call.id,
                      },
                      caller,
                      call.id,
                    ),
                  )
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })

    editor.add({
      name: "lz-request-handoff",
      description:
        "Persist an Architect's structured request for a handoff attached to the exact source attempt. The request ID is the durable reference; it does not grant another writer, prove stopped activity, or mark task completion.",
      input: z.strictObject({
        ...HandoffRequestInput.shape,
        requestID: z.string().min(1).max(200).optional(),
      }),
      output: z.unknown(),
      options: { codemode: true, permission: "lz-request-handoff" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-request-handoff",
            resources: ["*"],
          })
          .pipe(
            Effect.map(() =>
              output(
                store.request({ ...input, requestID: input.requestID ?? call.id }, actor(call)),
              ),
            ),
          ),
    })

    editor.add({
      name: "lz-verify-handoff",
      description:
        "The assigned worker submits structured handoff data; an Architect may instead review or recover an existing worker-authored draft by requestID and draftVersion. Existing data is read as stored and cannot be replaced by the Architect. Use the returned draftVersion, reviewID and round with lz-submit-handoff to finalize this exact reviewed version. Disabled/unavailable review is an explicit limitation, never a pass; neither tool changes task acceptance or authorizes another writer.",
      input: HandoffVerifyInput,
      output: z.unknown(),
      options: { codemode: true, permission: "lz-verify-handoff" },
      execute: (rawInput, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-verify-handoff",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async (signal) => {
                  const input = HandoffVerifyInput.parse(rawInput)
                  const caller = actor(call)
                  let draftID: string
                  let draftVersion: number
                  let reviewInput: {
                    requestID: string
                    draftVersion: number
                    evidence: typeof input.evidence
                    reviewID?: string
                  }
                  if ("draftVersion" in input) {
                    const existing = store.readReviewContext(
                      { requestID: input.requestID, draftVersion: input.draftVersion },
                      caller,
                    ).draft
                    if (existing.author.role !== "worker")
                      throw new Error("Only an existing worker-authored draft can be reviewed")
                    draftID = existing.draftID
                    draftVersion = existing.draftVersion
                    reviewInput = {
                      requestID: input.requestID,
                      draftVersion,
                      evidence: input.evidence,
                      ...(input.reviewID ? { reviewID: input.reviewID } : {}),
                    }
                  } else {
                    if (caller.role !== "worker")
                      throw new Error(
                        "Architects may review only an existing worker-authored draft version",
                      )
                    const saved = store.saveDraft(
                      {
                        requestID: input.requestID,
                        draftID: input.draftID,
                        draft: input.draft,
                      },
                      caller,
                    )
                    if (saved.status === "conflict") return output(saved)
                    draftID = saved.record.draftID
                    draftVersion = saved.record.draftVersion
                    reviewInput = {
                      requestID: input.requestID,
                      draftVersion,
                      evidence: input.evidence,
                      ...(input.reviewID ? { reviewID: input.reviewID } : {}),
                    }
                  }
                  const reviewed = await reviewer.review(reviewInput, caller, signal)
                  return output({
                    ...reviewed,
                    draftID,
                    draftVersion,
                  })
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })

    editor.add({
      name: "lz-submit-handoff",
      description:
        "Finalize the exact handoff draft version and review round returned by lz-verify-handoff. This persists the reviewed report and notification intent; it is not task completion, proof that writes/background work stopped, or authority for another writer.",
      input: HandoffFinalizeInput,
      output: z.unknown(),
      options: { codemode: true, permission: "lz-submit-handoff" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-submit-handoff",
            resources: ["*"],
          })
          .pipe(Effect.map(() => output(store.finalize(input, actor(call))))),
    })

    editor.add({
      name: "lz-disposition-handoff",
      description:
        "Append an Architect interpretation or correction to a finalized handoff, using expectedVersion from the current report disposition history. Corrections never overwrite earlier reports and do not change task authority.",
      input: z.strictObject({
        ...HandoffDispositionInput.shape,
        expectedVersion: z.int().nonnegative(),
      }),
      output: z.unknown(),
      options: { codemode: true, permission: "lz-disposition-handoff" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-disposition-handoff",
            resources: ["*"],
          })
          .pipe(Effect.map(() => output(store.recordDisposition(input, actor(call))))),
    })

    editor.add({
      name: "lz-read-handoff",
      description:
        "Read a bounded source-attached handoff request, drafts, reviewed reports, Architect corrections and paged history. Access is restricted to the current source plan Architect or exact assigned worker; it never proves task completion or writer quiescence.",
      input: z.strictObject({
        requestID: z.string().min(1).max(200),
        limit,
        cursor: z.string().optional(),
      }),
      output: z.unknown(),
      options: { codemode: true, permission: "lz-read-handoff" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-read-handoff",
            resources: ["*"],
          })
          .pipe(Effect.map(() => output(store.readHandoff(input, actor(call))))),
    })
  })
}
