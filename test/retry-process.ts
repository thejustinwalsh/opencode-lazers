import { Agent, Location } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { TaskRepository } from "../src/storage.ts"
import { registerTaskTools } from "../src/tools.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

/** Reconstruct the public native-tool adapter, without a host server or model. */
export async function nativeTools(
  repository: TaskRepository,
  options: { workspace?: string; session?: string; denied?: () => boolean } = {},
) {
  const tools = new Map<string, RegisteredTool>()
  const assertions: string[] = []
  const context = {
    sessionID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))(
      options.session ?? "session",
    ),
    agent: Agent.ID.make("architect"),
    messageID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Session.Message.ID")))(
      "message",
    ),
    id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))("call"),
    progress: () => Effect.void,
  } satisfies Parameters<RegisteredTool["execute"]>[1]
  const editor: ToolEditor = {
    add: (tool) => {
      tools.set(tool.name, tool)
    },
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  await Effect.runPromise(
    Effect.scoped(
      registerTaskTools(
        {
          location: Schema.decodeUnknownSync(Location.Info)({
            directory: options.workspace ?? repository.projectDirectory,
            project: {
              id: "project",
              directory: repository.projectDirectory,
              canonical: repository.projectDirectory,
            },
          }),
          permission: {
            assert: ({ action }) =>
              Effect.suspend(() => {
                assertions.push(action)
                return options.denied?.() ? Effect.die(new Error("Permission denied")) : Effect.void
              }),
          },
          tool: {
            transform: (callback) =>
              Effect.sync(() => {
                callback(editor)
                return { dispose: Effect.void }
              }),
          },
        },
        repository,
      ),
    ),
  )
  async function call(name: string, input: unknown) {
    const result = await Effect.runPromise(tools.get(name)!.execute(input, context))
    return JSON.parse(String(result.content))
  }
  return { tools, context, assertions, call }
}

export type RetryProcessOptions = {
  path: string
  project: string
  workspace: string
  session: string
  input: unknown
  discard?: boolean
  inspect?: boolean
  gate?: boolean
}

if (import.meta.main) {
  const options: RetryProcessOptions = JSON.parse(process.argv[2]!)
  const repository = new TaskRepository(options.path, options.project)
  try {
    const { call } = await nativeTools(repository, options)
    if (options.gate) {
      // Parent releases all contenders only after independent connections/tools exist.
      await new Promise<void>((resolve) => {
        process.once("message", () => resolve())
        process.send!("ready")
      })
      process.disconnect!()
    }
    const receipt = await call("lz-submit-task", options.input)
    if (!options.discard) {
      console.log(
        JSON.stringify(
          options.inspect
            ? {
                receipt,
                get: await call("lz-get-task", { taskID: receipt.taskID }),
                list: await call("lz-list-tasks", { limit: 100 }),
              }
            : receipt,
        ),
      )
    }
  } finally {
    repository.close()
  }
}
