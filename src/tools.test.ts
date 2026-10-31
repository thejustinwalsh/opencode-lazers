import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Agent, Location } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../test/proposal.ts"
import { nativeTools } from "../test/retry-process.ts"
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

test("implementors fetch prose instructions through the existing task tool with typed data intact", async () => {
  const { tools } = await setup()
  const proposal = {
    ...keyedProposal(),
    guidance:
      "Reuse `TaskRepository` in src/storage.ts. Keep advice separate from required outcomes.",
  }
  const receipt = await Effect.runPromise(
    tools.get("lazers_submit_task")!.execute(proposal, context),
  )
  const { taskID } = JSON.parse(String(receipt.content))
  const result = await Effect.runPromise(
    tools
      .get("lazers_get_task")!
      .execute({ taskID }, { ...context, agent: Agent.ID.make("lazers-implementor") }),
  )
  expect(result.content).toContain(`# Task ${taskID}`)
  expect(result.content).toContain("## Done when")
  expect(result.content).toContain("## Verification")
  const prose = String(result.content)
  expect(prose.indexOf("## Done when")).toBeLessThan(prose.indexOf("## Constraints"))
  expect(prose).toContain("## Implementation guidance (advisory)")
  expect(prose).toContain(proposal.guidance)
  expect(result.content).not.toContain('"proposal"')
  expect(result.output).toHaveProperty("task.id", taskID)
  expect(result.output).toHaveProperty("task.proposal.objective", validProposal().objective)
  expect(result.output).toHaveProperty("task.proposal.guidance", proposal.guidance)
})

test("native schema/runtime require keys, validate before database access, and leave rejected keys reusable", async () => {
  const { repository } = await setup()
  const { tools, call } = await nativeTools(repository, { workspace: "/no-git-access" })
  const schema = tools.get("lazers_submit_task")!.input as {
    required: string[]
    properties: { idempotencyKey: { minLength: number; maxLength: number; pattern: string } }
  }
  expect(schema.required).toContain("idempotencyKey")
  expect(schema.properties.idempotencyKey).toMatchObject({
    minLength: 1,
    maxLength: 200,
    pattern: "\\S",
  })
  const query = spyOn(Database.prototype, "query")
  const exec = spyOn(Database.prototype, "exec")
  try {
    for (const idempotencyKey of [undefined, null, 1, "", " \t", "k".repeat(201)]) {
      const result = await call("lazers_submit_task", { ...validProposal(), idempotencyKey })
      expect(result.status).toBe("invalid")
      expect(result.errors[0].path).toBe("idempotencyKey")
    }
    const result = await call("lazers_submit_task", { ...keyedProposal(), verification: [] })
    expect(result.status).toBe("invalid")
    expect(result.errors[0].path).toBe("acceptance.0.evidence.0.verificationID")
    expect(query).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  } finally {
    query.mockRestore()
    exec.mockRestore()
  }
  const allowed = await nativeTools(repository)
  expect((await allowed.call("lazers_submit_task", keyedProposal())).status).toBe("submitted")
  expect(repository.list()).toHaveLength(1)
})

test("permission denial precedes every lookup/write for first, replay, conflict and read invocations", async () => {
  const { repository } = await setup()
  let deny = false
  const { tools, call, assertions } = await nativeTools(repository, { denied: () => deny })
  const receipt = await call("lazers_submit_task", keyedProposal())
  const original = repository.get(receipt.taskID)
  deny = true
  const query = spyOn(Database.prototype, "query")
  const exec = spyOn(Database.prototype, "exec")
  const calls = [
    ["lazers_submit_task", { ...keyedProposal(), idempotencyKey: "new-denied-key" }],
    ["lazers_submit_task", keyedProposal()],
    ["lazers_submit_task", { ...keyedProposal(), objective: "Changed content" }],
    ["lazers_submit_task", validProposal()],
    ["lazers_get_task", { taskID: receipt.taskID }],
    ["lazers_list_tasks", { limit: 20 }],
    ["lazers_query_tasks", {}],
  ] as const
  try {
    for (const [name, input] of calls) {
      await expect(Effect.runPromise(tools.get(name)!.execute(input, context))).rejects.toThrow(
        "Permission denied",
      )
    }
    expect(query).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  } finally {
    query.mockRestore()
    exec.mockRestore()
  }
  expect(assertions).toEqual(["lazers_submit_task", ...calls.map(([name]) => name)])
  expect(repository.list()).toEqual([original!])
  deny = false
  expect(await call("lazers_submit_task", keyedProposal())).toEqual(receipt)
  expect(
    (await call("lazers_submit_task", { ...keyedProposal(), idempotencyKey: "new-denied-key" }))
      .status,
  ).toBe("submitted")
})

test("native retries and conflicts skip inaccessible Git; canonical project scope crosses worktrees but not repositories", async () => {
  const { repository } = await setup()
  const first = await nativeTools(repository)
  const receipt = await first.call("lazers_submit_task", keyedProposal())
  const original = repository.get(receipt.taskID)
  const retry = await nativeTools(repository, {
    workspace: "/unavailable-worktree",
    session: "other-session",
  })
  expect(await retry.call("lazers_submit_task", keyedProposal())).toEqual(receipt)
  expect(
    await retry.call("lazers_submit_task", { ...keyedProposal(), objective: "Changed" }),
  ).toEqual({
    status: "conflict",
    message: "idempotencyKey already identifies different validated content",
  })
  expect(repository.list()).toEqual([original!])
  const other = new TaskRepository(repository.path, "/another-canonical-repository")
  try {
    // Use an accessible Git worktree, but an independent host canonical identity.
    const isolated = await nativeTools(other, { workspace: process.cwd() })
    expect(await isolated.call("lazers_get_task", { taskID: receipt.taskID })).toEqual({
      status: "not_found",
    })
    expect((await isolated.call("lazers_list_tasks", { limit: 20 })).tasks).toEqual([])
    const independent = await isolated.call("lazers_submit_task", {
      ...keyedProposal(),
      objective: "Other repository",
    })
    expect(independent.status).toBe("submitted")
    expect(independent.taskID).not.toBe(receipt.taskID)
    expect((await isolated.call("lazers_list_tasks", { limit: 20 })).tasks).toHaveLength(1)
    expect(await first.call("lazers_get_task", { taskID: independent.taskID })).toEqual({
      status: "not_found",
    })
  } finally {
    other.close()
  }
})
