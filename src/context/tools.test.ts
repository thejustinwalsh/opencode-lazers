import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent, Location } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "../runner/artifacts.ts"
import { TaskRepository } from "../storage.ts"
import { ProjectIndex } from "./index.ts"
import { registerContextTools } from "./tools.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

const sessionID = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))("session")
const messageID = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Session.Message.ID")))(
  "message",
)
const callContext = (agent: string) =>
  ({
    sessionID,
    agent: Agent.ID.make(agent),
    messageID,
    id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))("call"),
    progress: () => Effect.void,
  }) satisfies Parameters<RegisteredTool["execute"]>[1]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const clean of cleanup.splice(0)) clean()
})

async function setup(deniedAction?: string) {
  const root = mkdtempSync(join(tmpdir(), "lazers-context-tools-"))
  git(root, ["init", "--initial-branch=main"])
  writeFileSync(join(root, "README.md"), "cached project source")
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  const index = new ProjectIndex(root, join(root, "cache"), repository, async () => true)
  const tools = new Map<string, RegisteredTool>()
  const assertions: string[] = []
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const context = {
    location: Schema.decodeUnknownSync(Location.Info)({
      directory: root,
      project: { id: "project", directory: root, canonical: root },
    }),
    permission: {
      assert: ({ action }: { action: string }) => {
        assertions.push(action)
        return action === deniedAction ? Effect.die(new Error("Permission denied")) : Effect.void
      },
    },
    tool: {
      transform: (callback: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  } as unknown as Plugin.Context
  await Effect.runPromise(Effect.scoped(registerContextTools(context, index)))
  cleanup.push(() => {
    index.close()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, index, tools, assertions }
}

test("read tools report an absent index without building, and an explicit Architect refresh publishes it", async () => {
  const f = await setup()
  const read = f.tools.get("lazers_project_read")!
  await expect(
    Effect.runPromise(read.execute({ paths: ["src"] }, callContext("lazers-implementor"))),
  ).rejects.toThrow("Architect must refresh")
  expect(f.assertions).toEqual(["lazers_project_read"])

  const refresh = f.tools.get("lazers_project_refresh")!
  expect(refresh.options).toMatchObject({ codemode: true, pinned: true })
  const built = await Effect.runPromise(refresh.execute({}, callContext("architect")))
  expect(f.assertions.at(-1)).toBe("lazers_project_refresh")
  expect(built.output).toMatchObject({
    snapshotID: expect.any(String),
    freshness: "as-of-refresh",
    workspace: f.index.root,
    totalFiles: 1,
  })
  expect(f.tools.get("lazers_project_index")!.output).toBeDefined()
})

test("native permission and Architect role both gate refresh; reads remain available to permitted implementors", async () => {
  const f = await setup()
  const refresh = f.tools.get("lazers_project_refresh")!
  await expect(
    Effect.runPromise(refresh.execute({}, callContext("lazers-implementor"))),
  ).rejects.toThrow("Only Architect")
  expect(f.assertions).toEqual(["lazers_project_refresh"])

  await Effect.runPromise(refresh.execute({}, callContext("architect")))
  const read = f.tools.get("lazers_project_index")!
  const output = await Effect.runPromise(
    read.execute({ paths: [] }, callContext("lazers-implementor")),
  )
  expect(output.output).toMatchObject({ freshness: "as-of-refresh" })
  const source = await Effect.runPromise(
    f.tools
      .get("lazers_project_read")!
      .execute({ paths: ["README.md"], level: "full" }, callContext("lazers-implementor")),
  )
  expect(source.output.sources[0]!.text).toBe("cached project source")
  expect(f.assertions).toEqual([
    "lazers_project_refresh",
    "lazers_project_refresh",
    "lazers_project_index",
    "lazers_project_read",
  ])
})

test("native permission denial prevents Architect refresh from creating a snapshot", async () => {
  const f = await setup("lazers_project_refresh")
  const refresh = f.tools.get("lazers_project_refresh")!
  await expect(Effect.runPromise(refresh.execute({}, callContext("architect")))).rejects.toThrow(
    "Permission denied",
  )
  expect(f.assertions).toEqual(["lazers_project_refresh"])
  await expect(f.index.manifest({ sessionID: "architect", agent: "architect" })).rejects.toThrow(
    "Architect must refresh",
  )
})
