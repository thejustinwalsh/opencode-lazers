import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import { tolerantJsonSchema } from "../legacy-fields.ts"
import { nativeWorkerOptions } from "./catalog.ts"
import { InspectPlanInput, inspectPlan } from "./inspection.ts"
import { ArchitectContinuityInput, CommandInput, PlanSubmissionInput } from "./schema.ts"
import type { TaskRuntime } from "./runtime.ts"
import { TakeoverInput, WorkerHandoffInput } from "./takeover.ts"

export function registerRunnerTools(ctx: Plugin.Context, runtime: TaskRuntime) {
  return ctx.tool.transform((editor) => {
    for (const definition of [
      {
        name: "lz-submit-plan",
        description:
          "Persist a versioned task dependency plan referencing existing exact task revisions. `workerModel` is an optional exact user-selected native route; each node may independently choose one optional UI, Systems or Small task/refactoring persona. Use priority for dispatch order (1 is top, 0 is none, larger integers are lower) and afterPlans for integration prerequisites. Overlapping scopes serialize; resolve duplicate candidates with an explicit relation. Submitting admits the plan and the scheduler runs it, with no separate run command; set draft true only to save it without admitting (run it later with lz-plan-command run). Stable requestID is mandatory for safe retries.",
        schema: PlanSubmissionInput,
        run: (input: unknown, sessionID: string) => runtime.submitPlan(input, sessionID),
      },
      {
        name: "lz-plan-command",
        description:
          "Use a stable requestID; the plan's state decides what applies and a refusal lists the available actions. Resume without taskID re-runs the combined check on the current candidate. Defaults: 15m inactivity/60m hard; project/per-check timing overrides. retained-repair recovers runtime-fenced retained repair; user cancellation is excluded. verify-retained verifies the given commit in a temporary worktree without an implementation turn and records pass or fail; run it again after a failure; handles startup settlement.",
        schema: CommandInput,
        run: (input: unknown, sessionID: string) => runtime.command(input, sessionID),
      },
      {
        name: "lz-request-handoff",
        description:
          "Take a task over from its worker: tells the worker, waits up to 5 minutes for its handoff, stops it, and returns the handoff, workspace, commits and uncommitted paths.",
        schema: TakeoverInput,
        run: (input: unknown, sessionID: string) => runtime.takeover(input, sessionID),
      },
      {
        name: "lz-takeover-handoff",
        description:
          "Worker only, after a takeover notice: hand your task to the Architect in one call. Plain text: done, remaining, workspace state, struggled with, tried. Then end your turn.",
        schema: WorkerHandoffInput,
        run: (input: unknown, sessionID: string) => runtime.takeoverHandoff(input, sessionID),
      },
      {
        name: "lz-inspect-plan",
        description:
          "Inspect plans, read-only. Without a view: all project plans, or one plan by planID, compact: IDs, title/objective, state/version/reason, model, schedule, node states and waiting reasons, attempt/effect/outcome counts, check exit status; no policies, transcripts or check output. full=true adds troubleshooting detail: the latest retained verification per task and the activity, evidence and delivery history, newest `limit` rows (default 200, max 1000) oldest-first; pass `paging.<list>.next` back as activityBefore, evidenceBefore or deliveryBefore for the next older page (null when exhausted). Commands, output, paths, private reasons and environment contents are redacted. view='journal' with planID pages the plan's Architect source journal (limit 1-100, default 50; pass nextCursor back): metadata-only session/message references, no message bodies, no proof of transcript completeness or native consumption; a cursor stays valid until that plan's journal changes. view='source-messages' with planID, sourceSessionID and up to 10 journaled messageIDs fetches those original messages with secrets and URLs redacted and metadata, reasoning, tools and attachments omitted. Inspection never acknowledges or advances anything.",
        schema: InspectPlanInput,
        run: (input: unknown, sessionID?: string) => {
          const parsed = InspectPlanInput.parse(input)
          return "view" in parsed && parsed.view === "source-messages"
            ? runtime.inspectArchitectSourceMessages(parsed, sessionID ?? "")
            : inspectPlan(runtime.store, parsed)
        },
      },
      {
        name: "lz-record-architect-continuity",
        description:
          "Replace the active Architect owner session's durable continuity checkpoint with exact, still-relevant decisions and unresolved questions from the conversation (maximum 12 KB). This is authored structured state, not a transcript summary. Call after material decisions or changes to open questions; use empty arrays to explicitly record that none remain.",
        schema: ArchitectContinuityInput,
        run: (input: unknown, sessionID: string) =>
          runtime.recordArchitectContinuity(sessionID, input),
      },
      {
        name: "lz-worker-catalog",
        description:
          "Read the live native OpenCode model catalog, current implementor selection, listed prices, variants and capability metadata to advise the user. Informational only: does not infer a ranking, validate or change a route, or launch model inference.",
        schema: z.strictObject({}),
        run: (_input: unknown, _sessionID: string) => nativeWorkerOptions(ctx),
      },
    ]) {
      editor.add({
        name: definition.name,
        description: definition.description,
        input: tolerantJsonSchema(definition.schema),
        options: { codemode: true, permission: definition.name },
        execute: (input, call) =>
          ctx.permission
            .assert({
              sessionID: call.sessionID,
              agent: call.agent,
              action: definition.name,
              resources: ["*"],
            })
            .pipe(
              Effect.flatMap(() =>
                Effect.tryPromise({
                  try: async () => {
                    if (
                      call.agent !== "architect" &&
                      [
                        "lz-submit-plan",
                        "lz-plan-command",
                        "lz-record-architect-continuity",
                        "lz-request-handoff",
                      ].includes(definition.name)
                    )
                      throw new Error("Plan orchestration is restricted to Architect")
                    const output = await definition.run(input, call.sessionID)
                    return { content: JSON.stringify(output) }
                  },
                  catch: (error) =>
                    new Tool.Error({
                      message: error instanceof Error ? error.message : String(error),
                    }),
                }),
              ),
            ),
      })
    }
  })
}
