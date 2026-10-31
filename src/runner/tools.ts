import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import { CommandInput, PlanInput } from "./schema.ts"
import type { TaskRuntime } from "./runtime.ts"

export function registerRunnerTools(ctx: Plugin.Context, runtime: TaskRuntime) {
  return ctx.tool.transform((editor) => {
    for (const definition of [
      {
        name: "lazers_submit_plan",
        description:
          "Persist a versioned task dependency plan referencing existing exact task revisions. Resolve audit overlap candidates with explicit distinct/duplicate/supplement rationales. Does not run until lazers_plan_command action run. Stable requestID is mandatory for safe retries.",
        schema: PlanInput,
        run: (input: unknown, sessionID: string) => runtime.store.submit(input, sessionID),
      },
      {
        name: "lazers_plan_command",
        description:
          "Request execution, cancel, audit, reconcile, explicitly reassign, retry an ended task in a fresh child or resume an exhausted or cancelled stopped task with taskID/reason (workspaceMode shared selects the current checkout), or record assertion-bound human evidence. Requires current expectedVersion and a stable requestID. No force-accept; resume retains measured usage and history.",
        schema: CommandInput,
        run: (input: unknown, sessionID: string) => runtime.command(input, sessionID),
      },
      {
        name: "lazers_inspect_plan",
        description:
          "Inspect plan, dependencies, execution, attempts, effects, evidence, delivery and current audit. Without planID returns all project plans and deterministic overlap/unplanned findings.",
        schema: z.strictObject({ planID: z.uuid().optional() }),
        run: (input: unknown) => {
          const { planID } = input as { planID?: string }
          return planID
            ? runtime.store.detail(planID)
            : { plans: runtime.store.plans(), audit: runtime.store.audit() }
        },
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
                    if (call.agent !== "architect" && definition.name !== "lazers_inspect_plan")
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
