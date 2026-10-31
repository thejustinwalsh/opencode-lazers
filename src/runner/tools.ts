import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import { nativeWorkerOptions } from "./catalog.ts"
import { InspectPlanInput, inspectPlan } from "./inspection.ts"
import { CommandInput, PlanInput } from "./schema.ts"
import type { TaskRuntime } from "./runtime.ts"

export function registerRunnerTools(ctx: Plugin.Context, runtime: TaskRuntime) {
  return ctx.tool.transform((editor) => {
    for (const definition of [
      {
        name: "lazers_submit_plan",
        description:
          "Persist a versioned task dependency plan referencing existing exact task revisions. `workerModel` is an optional exact user-selected native route; each node may independently choose one optional UI, Systems or Small task/refactoring persona. Use priority for dispatch order and afterPlans for integration prerequisites. Overlapping scopes serialize; resolve duplicate candidates with an explicit relation. Does not run until lazers_plan_command action run. Stable requestID is mandatory for safe retries.",
        schema: PlanInput,
        run: (input: unknown, sessionID: string) => runtime.store.submit(input, sessionID),
      },
      {
        name: "lazers_plan_command",
        description:
          "Schedule priority/afterPlans and an unstarted plan baseline with reason; amend-scope adds authorized scopeAdditions for taskID with reason without rewriting its specification; request execution, cancel, audit, reconcile, reassign, retry or resume stopped work, or record assertion/artifact-bound human evidence (omit taskID for combined-plan acceptance). Requires current expectedVersion and stable requestID. Resume/retry use taskID/reason; workspaceMode shared selects this checkout. After review/merge, integrated records artifact/targetBranch/reason and requests native non-forced cleanup. No force-accept; history remains.",
        schema: CommandInput,
        run: (input: unknown, sessionID: string) => runtime.command(input, sessionID),
      },
      {
        name: "lazers_inspect_plan",
        description:
          "Compact by default: inspect all project plans or one plan with IDs, authored title/objective, state/version/reason, model, schedule, node states/waiting reasons, attempt/effect/outcome counts and concise check exit status. It omits policies, transcripts and check output. Set full=true only for progressive troubleshooting; it returns the existing full plan detail, or all plan source and audit when planID is omitted.",
        schema: InspectPlanInput,
        run: (input: unknown) => {
          return inspectPlan(runtime.store, InspectPlanInput.parse(input))
        },
      },
      {
        name: "lazers_worker_catalog",
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
                      ["lazers_submit_plan", "lazers_plan_command"].includes(definition.name)
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
