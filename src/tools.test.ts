import { afterEach, expect, test } from "bun:test"
import { Agent, Location } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../test/proposal.ts"
import { TaskRepository } from "./storage.ts"
import { registerTaskTools } from "./tools.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]
const context = {
  sessionID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))("session"),
  agent: Agent.ID.make("architect"),
  messageID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Session.Message.ID")))(
    "message",
  ),
  id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))("call"),
  progress: () => Effect.void,
} satisfies Parameters<RegisteredTool["execute"]>[1]
const cleanup: (() => void)[] = []
const keyedProposal = () => ({ ...validProposal(), idempotencyKey: "test-submission" })
afterEach(() => {
  for (const clean of cleanup.splice(0)) clean()
})

async function setup(deny = false) {
  const directory = mkdtempSync(join(tmpdir(), "lazers-tool-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), process.cwd())
  cleanup.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const tools = new Map<string, RegisteredTool>()
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
  const assertions: string[] = []
  await Effect.runPromise(
    Effect.scoped(
      registerTaskTools(
        {
          location: Schema.decodeUnknownSync(Location.Info)({
            directory: process.cwd(),
            project: { id: "project", directory: process.cwd(), canonical: process.cwd() },
          }),
          permission: {
            assert: ({ action }) => {
              assertions.push(action)
              return deny ? Effect.die(new Error("Permission denied")) : Effect.void
            },
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
  return { tools, repository, assertions }
}

test("registered tools submit, retrieve, and list the same durable task", async () => {
  const { tools, repository, assertions } = await setup()
  const submit = await Effect.runPromise(
    tools.get("lazers_submit_task")!.execute(keyedProposal(), context),
  )
  const submitted = JSON.parse(String(submit.content))
  // OpenCode rejects undeclared structured output after tool execution. In the
  // submit path that would discard a receipt after the database commit.
  expect(tools.get("lazers_submit_task")!.output).toBeUndefined()
  expect(submit).not.toHaveProperty("output")
  expect(submitted.status).toBe("submitted")
  const get = await Effect.runPromise(
    tools.get("lazers_get_task")!.execute({ taskID: submitted.taskID }, context),
  )
  expect(JSON.parse(String(get.content)).task.provenance.sessionID).toBe("session")
  const list = await Effect.runPromise(
    tools.get("lazers_list_tasks")!.execute({ limit: 5 }, context),
  )
  expect(JSON.parse(String(list.content)).tasks[0].taskID).toBe(submitted.taskID)
  expect(tools.get("lazers_list_tasks")!.output).toBeUndefined()
  expect(list).not.toHaveProperty("output")
  expect(tools.get("lazers_get_task")!.output).toBeDefined()
  expect(get.output).toEqual(JSON.parse(String(get.content)))
  expect(repository.list()).toHaveLength(1)
  expect(assertions).toEqual(["lazers_submit_task", "lazers_get_task", "lazers_list_tasks"])
})

test("permission denial prevents task writes", async () => {
  const { tools, repository } = await setup(true)
  await expect(
    Effect.runPromise(tools.get("lazers_submit_task")!.execute(keyedProposal(), context)),
  ).rejects.toThrow("Permission denied")
  expect(repository.list()).toEqual([])
})

test("retained tool callbacks survive disposal of the registration connection", async () => {
  const { tools, repository } = await setup()
  const path = repository.path
  const projectDirectory = repository.projectDirectory
  repository.close()
  const submit = await Effect.runPromise(
    tools.get("lazers_submit_task")!.execute(keyedProposal(), context),
  )
  const receipt = JSON.parse(String(submit.content))
  expect(receipt.status).toBe("submitted")
  for (const [name, input] of [
    ["lazers_get_task", { taskID: receipt.taskID }],
    ["lazers_list_tasks", { limit: 5 }],
    ["lazers_query_tasks", {}],
  ] as const) {
    const read = await Effect.runPromise(tools.get(name)!.execute(input, context))
    expect(String(read.content)).toContain(receipt.taskID)
  }
  const reopened = new TaskRepository(path, projectDirectory)
  try {
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.get(receipt.taskID)?.provenance.sessionID).toBe("session")
  } finally {
    reopened.close()
  }
})

test("tool execution returns validation guidance without persisting an invalid task", async () => {
  const { tools, repository } = await setup()
  const result = await Effect.runPromise(
    tools.get("lazers_submit_task")!.execute({ objective: "Incomplete" }, context),
  )
  const output = JSON.parse(String(result.content))
  expect(output.status).toBe("invalid")
  expect(output.errors.length).toBeGreaterThan(0)
  expect(repository.list()).toEqual([])
})

test("task reads expose structured Code Mode outputs and require their own permissions", async () => {
  const { tools, assertions } = await setup()
  await Effect.runPromise(tools.get("lazers_submit_task")!.execute(keyedProposal(), context))
  const query = tools.get("lazers_query_tasks")!
  const output = await Effect.runPromise(query.execute({ search: "" }, context))
  expect(query.options?.codemode).toBe(true)
  expect(query.output).toBeDefined()
  expect(output.output).toEqual(JSON.parse(String(output.content)))
  expect(tools.get("lazers_submit_task")!.options?.codemode).toBe(false)
  expect(assertions.at(-1)).toBe("lazers_query_tasks")
  const denied = await setup(true)
  for (const [name, input] of [
    ["lazers_query_tasks", {}],
    ["lazers_get_task", { taskID: crypto.randomUUID() }],
    ["lazers_list_tasks", { limit: 2 }],
  ] as const) {
    await expect(
      Effect.runPromise(denied.tools.get(name)!.execute(input, context)),
    ).rejects.toThrow("Permission denied")
  }
})
