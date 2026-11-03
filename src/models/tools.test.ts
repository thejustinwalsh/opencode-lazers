import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { registerModelTools } from "./tools.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]
const directories: string[] = []
const repositories: TaskRepository[] = []

function open() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-model-tools-"))
  directories.push(directory)
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  repositories.push(repository)
  return { directory, repository }
}

function context(agent: string) {
  return {
    sessionID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))("ses_tool"),
    agent: Agent.ID.make(agent),
    messageID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Session.Message.ID")))(
      "msg",
    ),
    id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))("call"),
    progress: () => Effect.void,
  } satisfies Parameters<RegisteredTool["execute"]>[1]
}

function hasMappingsTable(path: string) {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    return Boolean(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='model_mappings'",
        )
        .get(),
    )
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("registered Code Mode tools permission-check, restrict writes to Architect and use owned connections", async () => {
  const { repository } = open()
  const tools = new Map<string, RegisteredTool>()
  const actions: string[] = []
  let denied = false
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const toolContext = {
    permission: {
      assert: ({ action }: { action: string }) => {
        actions.push(action)
        return denied ? Effect.fail(new Error("native permission denied")) : Effect.void
      },
    },
    tool: {
      transform: (callback: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  } as unknown as Pick<Plugin.Context, "permission" | "tool">
  await Effect.runPromise(Effect.scoped(registerModelTools(toolContext, repository)))

  const settings = tools.get("lz-get-model-settings")!
  const configure = tools.get("lz-configure-models")!
  expect(settings.options).toMatchObject({ codemode: true, pinned: true })
  expect(configure.options).toMatchObject({ codemode: true, pinned: true })

  denied = true
  await expect(
    Effect.runPromise(
      configure.execute(
        {
          target: { scope: "shared" },
          persona: "ui",
          expectedRevision: 0,
          route: { providerID: "private", id: "private-model", variant: "xhigh" },
        },
        context("architect"),
      ),
    ),
  ).rejects.toThrow("native permission denied")
  expect(hasMappingsTable(repository.path)).toBe(false)

  denied = false
  await expect(
    Effect.runPromise(
      configure.execute(
        {
          target: { scope: "shared" },
          persona: "ui",
          expectedRevision: 0,
          route: { providerID: "private", id: "private-model", variant: "xhigh" },
        },
        context("implementor"),
      ),
    ),
  ).rejects.toThrow("restricted to Architect")
  expect(hasMappingsTable(repository.path)).toBe(false)

  repository.close()
  const input = {
    target: { scope: "shared" },
    persona: "ui",
    expectedRevision: 0,
    route: {
      providerID: "provider-not-catalogued",
      id: "model-not-catalogued",
      variant: "native/xhigh",
    },
  }
  const write = await Effect.runPromise(configure.execute(input, context("architect")))
  expect(write.output).toMatchObject({
    status: "updated",
    mapping: { revision: 1, route: input.route },
  })
  const read = await Effect.runPromise(settings.execute({}, context("architect")))
  expect(read.output).toMatchObject({ projectDirectory: "/project" })
  const uiSettings = (
    read.output as { personas: Array<{ persona: string; layers: unknown; resolution: unknown }> }
  ).personas.find((persona) => persona.persona === "ui")
  expect(uiSettings).toMatchObject({
    layers: { shared: { revision: 1, route: input.route } },
    resolution: { status: "assigned", route: input.route },
  })

  const replay = await Effect.runPromise(configure.execute(input, context("architect")))
  expect(replay.output).toMatchObject({
    status: "conflict",
    expectedRevision: 0,
    currentRevision: 1,
    current: { revision: 1, route: input.route },
  })
  expect(actions).toEqual([
    "lz-configure-models",
    "lz-configure-models",
    "lz-configure-models",
    "lz-get-model-settings",
    "lz-configure-models",
  ])
})
