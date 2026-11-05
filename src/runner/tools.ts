import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import { nativeWorkerOptions } from "./catalog.ts"
import { InspectPlanInput, inspectPlan } from "./inspection.ts"
import { ArchitectContinuityInput, CommandInput, PlanInput } from "./schema.ts"
import type { TaskRuntime } from "./runtime.ts"

export function registerRunnerTools(ctx: Plugin.Context, runtime: TaskRuntime) {
  return ctx.tool.transform((editor) => {
    for (const definition of [
      {
        name: "lz-submit-plan",
        description:
          "Persist a versioned task dependency plan referencing existing exact task revisions. `workerModel` is an optional exact user-selected native route; each node may independently choose one optional UI, Systems or Small task/refactoring persona. Use priority for dispatch order and afterPlans for integration prerequisites. Overlapping scopes serialize; resolve duplicate candidates with an explicit relation. Does not run until lz-plan-command action run. Stable requestID is mandatory for safe retries.",
        schema: PlanInput,
        run: (input: unknown, sessionID: string) => runtime.store.submit(input, sessionID),
      },
      {
        name: "lz-plan-command",
        description:
          "Schedule priority/afterPlans and an unstarted plan baseline with reason; amend-scope adds authorized scopeAdditions for taskID with reason without rewriting its specification; request execution, cancel, audit, reconcile, reassign, retry or resume stopped work, or record assertion/artifact-bound human evidence (omit taskID for combined-plan acceptance). adopt-descendant verifies a reviewed commit currently at targetBranch HEAD against the exact failed/accepted attempt artifact, with taskID, attemptID, artifact, descendantCommit and reason; fresh task and combined checks run without a worker turn. Adoption human evidence supplies adoptionID and exact task or combined artifact. Retry can requeue a cancelled zero-attempt task in an admitted plan without starting it; dependencies and scopes still gate dispatch. Requires current expectedVersion and stable requestID. Resume/retry use taskID/reason; terminal interrupted or failed continuation also requires exact attemptID, and unknown background remains unknown; workspaceMode shared selects this checkout. quarantine-source requests guarded archival of an isolated retained verifying attempt with an uncertain check, using attemptID/reason; inspect its pending/sealed control before proceeding. It releases only source-writing admission for independent isolated work; old checks/resources and acceptance remain. After review/merge, integrated with taskID records that accepted task's source landing without plan finalization or cleanup; omit taskID to record the accepted combined artifact and request native non-forced cleanup. No force-accept; history remains.",
        schema: CommandInput,
        run: (input: unknown, sessionID: string) => runtime.command(input, sessionID),
      },
      {
        name: "lz-inspect-plan",
        description:
          "Compact by default: inspect all project plans or one plan with IDs, authored title/objective, state/version/reason, model, schedule, node states/waiting reasons, attempt/effect/outcome counts and concise check exit status. It omits policies, transcripts and check output. Set full=true only for progressive troubleshooting; it returns the existing full plan detail, or all plan source and audit when planID is omitted. Explicitly set view='journal' with planID to page that plan's retained Architect source journal (limit 1-100, default 50, then pass nextCursor). Journal entries are metadata-only original session/message references; they contain no message bodies, do not prove transcript completeness or native consumption, and inspection does not acknowledge or advance anything. Cursor traversal is invalidated by changes to that selected plan's source journal, not unrelated project activity.",
        schema: InspectPlanInput,
        run: (input: unknown) => {
          return inspectPlan(runtime.store, InspectPlanInput.parse(input))
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
        input: z.toJSONSchema(definition.schema, { io: "input" }),
        options: { codemode: false, permission: definition.name },
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
