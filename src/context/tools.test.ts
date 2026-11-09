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
import { nativeContextPermission, registerContextTools } from "./tools.ts"
import { registerTaskTools } from "../tools.ts"
import { validProposal } from "../../test/proposal.ts"

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
  const deniedPaths = new Set<string>()
  const index = new ProjectIndex(
    root,
    join(root, "cache"),
    repository,
    async (path) => !deniedPaths.has(path),
  )
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
  await Effect.runPromise(Effect.scoped(registerTaskTools(context, repository, index)))
  cleanup.push(() => {
    index.close()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, index, tools, assertions, deniedPaths }
}

test("one canonical worker fetch delivers task and cached source without a discovery or refresh call", async () => {
  const f = await setup()
  const task = await Effect.runPromise(
    f.tools.get("lz-submit-task")!.execute(
      {
        ...validProposal(),
        idempotencyKey: "one-fetch",
        context: [{ reference: "README.md:1", revision: null }],
        guidance: "Start from README.md; preserve the existing contract.",
      },
      callContext("architect"),
    ),
  )
  const taskID = JSON.parse(String(task.content)).taskID as string
  const fetch = () =>
    Effect.runPromise(
      f.tools.get("lz-get-task")!.execute({ taskID }, callContext("lazers-implementor")),
    )
  const absent = await fetch()
  expect(absent.output).toContain("## Done when")
  expect(absent.output).toContain("Cached source context is unavailable")
  const snapshot = await f.index.refresh({ sessionID: "architect", agent: "architect" })
  writeFileSync(join(f.root, "README.md"), "live checkout changed")
  f.assertions.length = 0
  const result = await fetch()
  expect(typeof result.output).toBe("string")
  expect(result.output).toContain("## Done when")
  expect(result.output).toContain("## Verification")
  expect(result.output).toContain("## Implementation guidance")
  expect(result.output).toContain("cached project source")
  expect(result.output).toContain(snapshot.id)
  expect(result.output).not.toContain("live checkout changed")
  expect(result.output).not.toContain('"proposal"')
  expect(f.assertions).toEqual(["lz-get-task"])
  expect(f.tools.has("lz-get-task-instructions")).toBe(false)
  f.deniedPaths.add("README.md")
  expect((await fetch()).output).not.toContain("cached project source")
})

test("read tools report an absent index without building, and an explicit Architect refresh publishes it", async () => {
  const f = await setup()
  const read = f.tools.get("lz-project-read")!
  await expect(
    Effect.runPromise(read.execute({ paths: ["src"] }, callContext("lazers-implementor"))),
  ).rejects.toThrow("Architect must refresh")
  expect(f.assertions).toEqual(["lz-project-read"])

  const refresh = f.tools.get("lz-project-refresh")!
  expect(refresh.options).toMatchObject({ codemode: true, pinned: true })
  const built = await Effect.runPromise(refresh.execute({}, callContext("architect")))
  expect(f.assertions.at(-1)).toBe("lz-project-refresh")
  expect(built.output).toMatchObject({
    snapshotID: expect.any(String),
    freshness: "as-of-refresh",
    workspace: f.index.root,
    totalFiles: 1,
  })
  const indexTool = f.tools.get("lz-project-index")!
  expect(indexTool.output).toBeDefined()
  expect(indexTool.description).toContain(
    "totalFiles counts authorized matches before the 100-file response limit",
  )
  expect(indexTool.description).toContain("without paths, it counts all currently permitted files")
})

test("native permission and Architect role both gate refresh; reads remain available to permitted implementors", async () => {
  const f = await setup()
  const refresh = f.tools.get("lz-project-refresh")!
  await expect(
    Effect.runPromise(refresh.execute({}, callContext("lazers-implementor"))),
  ).rejects.toThrow("Only Architect")
  expect(f.assertions).toEqual(["lz-project-refresh"])

  await Effect.runPromise(refresh.execute({}, callContext("architect")))
  const read = f.tools.get("lz-project-index")!
  const output = await Effect.runPromise(
    read.execute({ paths: [] }, callContext("lazers-implementor")),
  )
  expect(output.output).toMatchObject({ freshness: "as-of-refresh" })
  const source = await Effect.runPromise(
    f.tools
      .get("lz-project-read")!
      .execute({ paths: ["README.md"], level: "full" }, callContext("lazers-implementor")),
  )
  expect(source.output.sources[0]!.text).toBe("cached project source")
  expect(f.assertions).toEqual([
    "lz-project-refresh",
    "lz-project-refresh",
    "lz-project-index",
    "lz-project-read",
  ])
})

test("native permission denial prevents Architect refresh from creating a snapshot", async () => {
  const f = await setup("lz-project-refresh")
  const refresh = f.tools.get("lz-project-refresh")!
  await expect(Effect.runPromise(refresh.execute({}, callContext("architect")))).rejects.toThrow(
    "Permission denied",
  )
  expect(f.assertions).toEqual(["lz-project-refresh"])
  await expect(f.index.manifest({ sessionID: "architect", agent: "architect" })).rejects.toThrow(
    "Architect must refresh",
  )
})

test("cancelling an index tool interrupts its native permission wait and stops the scan", async () => {
  const f = await setup()
  writeFileSync(join(f.root, "second.ts"), "export const value = 2")
  await f.index.refresh({ sessionID: "architect", agent: "architect" })
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let finish!: () => void
  let checks = 0
  let interrupted = false
  let principalSignal: AbortSignal | undefined
  const native = nativeContextPermission({
    permission: {
      assert: () =>
        Effect.callback<void>((resume) => {
          checks++
          enter()
          finish = () => resume(Effect.void)
          return Effect.sync(() => {
            interrupted = true
          })
        }),
    },
  } as unknown as Plugin.Context)
  Object.defineProperty(f.index, "allow", {
    value: (path: string, principal: Parameters<typeof native>[1], workspace: string) => {
      principalSignal = principal.signal
      return native(path, principal, workspace)
    },
  })
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    f.tools.get("lz-project-index")!.execute({}, callContext("lazers-implementor")),
    { signal: controller.signal },
  )
  try {
    await entered
    controller.abort()
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(principalSignal?.aborted).toBe(true)
    expect(interrupted).toBe(true)
    expect(checks).toBe(1)
  } finally {
    finish?.()
  }
})
