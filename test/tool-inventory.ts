import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { registerAuditTools } from "../src/audit/tools.ts"
import { registerContextTools } from "../src/context/tools.ts"
import { ProgressInput } from "../src/progress/schema.ts"
import { registerModelTools } from "../src/models/tools.ts"
import { registerRecoveryTools } from "../src/recovery/tools.ts"
import { registerRunnerTools } from "../src/runner/tools.ts"
import { registerTaskTools } from "../src/tools.ts"
import { registerTrajectoryTools } from "../src/trajectory/tools.ts"
import { registerInferenceTools } from "../src/webgpu/tools.ts"
import { registerTaskReviewTool } from "../src/webgpu/review-tool.ts"
import { TaskRepository } from "../src/storage.ts"
import { TaskAdviceToolInput } from "../src/tasks/advice.ts"
import { tolerantJsonSchema } from "../src/legacy-fields.ts"
import { declareInput } from "../src/tool-input.ts"
import { slimTool } from "../src/tool-signature.ts"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type RegisteredTool = Parameters<ToolEditor["add"]>[0]

// A stand-in for services the registrations only touch when a tool runs.
function inert(): never {
  const target = () => undefined
  const proxy: unknown = new Proxy(target, {
    get: (_target, key) => (key === "then" ? undefined : proxy),
    apply: () => proxy,
    construct: () => proxy as object,
  })
  return proxy as never
}

/**
 * Every `lz-*` tool as the plugin registers it, by name, with the editor's `add` captured. The
 * services behind each tool are inert: registration reads only names, descriptions and schemas.
 */
export async function collectTools(
  options: { raw?: boolean } = {},
): Promise<Map<string, RegisteredTool>> {
  const tools = new Map<string, RegisteredTool>()
  const editor: ToolEditor = {
    // `raw` keeps results as registered; otherwise the signature slimming the plugin applies after
    // registration is applied here too, so callers see what a model sees.
    add: (tool) => {
      tools.set(tool.name, options.raw ? tool : slimTool(tool))
    },
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const ctx = {
    tool: {
      transform: (callback: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
    permission: { assert: () => Effect.void },
    location: { directory: "/inventory", project: { id: "inventory", directory: "/inventory" } },
    rpc: inert(),
  } as unknown as Plugin.Context
  const directory = mkdtempSync(join(tmpdir(), "lazers-inventory-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), directory)
  try {
    const registrations = [
      registerTaskTools(ctx as never, repository),
      registerContextTools(ctx, inert()),
      registerModelTools(ctx as never, repository),
      registerAuditTools(ctx, repository),
      registerRunnerTools(ctx, inert()),
      registerTrajectoryTools(ctx as never, inert(), inert(), "inventory"),
      registerRecoveryTools(ctx as never, repository, {} as never),
      registerInferenceTools(ctx as never),
      registerTaskReviewTool(ctx as never, inert()),
    ]
    await Promise.all(
      registrations.map((registration) => Effect.runPromise(Effect.scoped(registration as never))),
    )
  } finally {
    repository.close()
  }
  // These two register inside larger setup effects; their schemas are what a model sees.
  tools.set("lz-report-progress", {
    name: "lz-report-progress",
    description:
      "Record a concise progress note or handoff for this assigned worker attempt. Commentary is an annotation only: it cannot verify, accept, schedule, or change task state. Identity is resolved from the current native worker session.",
    input: declareInput(ProgressInput),
    options: { codemode: true },
  } as unknown as RegisteredTool)
  tools.set("lz-attach-task-advice", {
    name: "lz-attach-task-advice",
    description: "",
    input: tolerantJsonSchema(TaskAdviceToolInput),
    options: { codemode: true },
  } as unknown as RegisteredTool)
  return tools
}
