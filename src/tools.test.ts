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
import { RunnerStore } from "./runner/store.ts"
import { GetInstructionsOutput } from "./tasks/contract.ts"
import { registerTaskTools } from "./tools.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]
type CodeModeResult = {
  output?: unknown
  content?:
    | string
    | ReadonlyArray<{ type: "text"; text: string } | { type: "file"; uri: string; mime: string }>
}

// Pinned OpenCode 2.2.5 resultValue: output wins when defined; otherwise join
// text content and return null for empty content.
function resultValue(result: CodeModeResult) {
  if (result.output !== undefined) return result.output
  const content =
    typeof result.content === "string"
      ? result.content
      : (result.content ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("")
  return content.length ? content : null
}

test("pinned Code Mode resultValue prefers defined output and joins text only as fallback", () => {
  expect(resultValue({ output: { typed: true }, content: "ignored text" })).toEqual({
    typed: true,
  })
  expect(
    resultValue({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    }),
  ).toBe("firstsecond")
  expect(resultValue({ content: [] })).toBeNull()
})

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
  expect(submitted).toMatchObject({
    reference: "LZ-1",
    title: "Keep submitted tasks after the plugin restarts",
    goal: "Keep submitted tasks after the plugin restarts",
    doneWhen: [{ id: "reopen", assertion: "A task can be retrieved after reopening the database" }],
    boundaries: {
      writeScope: ["src/**", "README.md"],
      exclusions: ["Do not dispatch workers"],
      constraints: ["Use plugin-owned SQLite storage"],
    },
    state: "submitted",
  })
  expect(submitted.note).toContain("does not start execution")
  const get = await Effect.runPromise(
    tools.get("lazers_get_task")!.execute({ taskID: submitted.taskID }, context),
  )
  expect(JSON.parse(String(get.content)).task.provenance.sessionID).toBe("session")
  const byReference = await Effect.runPromise(
    tools.get("lazers_get_task")!.execute({ taskID: submitted.reference }, context),
  )
  expect(JSON.parse(String(byReference.content))).toMatchObject({
    status: "found",
    reference: submitted.reference,
    task: { id: submitted.taskID },
  })
  const list = await Effect.runPromise(
    tools.get("lazers_list_tasks")!.execute({ limit: 5 }, context),
  )
  expect(JSON.parse(String(list.content)).tasks[0].taskID).toBe(submitted.taskID)
  expect(JSON.parse(String(list.content)).tasks[0].reference).toBe(submitted.reference)
  expect(tools.get("lazers_list_tasks")!.output).toBeUndefined()
  expect(list).not.toHaveProperty("output")
  expect(tools.get("lazers_get_task")!.output).toBeDefined()
  expect(get.output).toEqual(JSON.parse(String(get.content)))
  expect(repository.list()).toHaveLength(1)
  expect(assertions).toEqual([
    "lazers_submit_task",
    "lazers_get_task",
    "lazers_get_task",
    "lazers_list_tasks",
  ])
})

test("a replayed submission receipt reports current queued state without claiming execution", async () => {
  const { tools, repository } = await setup()
  const input = keyedProposal()
  const first = await Effect.runPromise(tools.get("lazers_submit_task")!.execute(input, context))
  const receipt = JSON.parse(String(first.content))
  const task = repository.get(receipt.taskID)!
  new RunnerStore(repository).submit(
    {
      requestID: "queued-summary",
      objective: task.proposal.objective,
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: task.id, revision: task.revision }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: task.proposal.verification,
      acceptance: task.proposal.acceptance,
    },
    "architect",
  )
  const replay = await Effect.runPromise(tools.get("lazers_submit_task")!.execute(input, context))
  expect(JSON.parse(String(replay.content))).toMatchObject({
    taskID: receipt.taskID,
    reference: receipt.reference,
    state: "queued",
    note: "Submission records the task; it does not start execution.",
  })
})

test("Architect can durably retire a legacy task and replay the same disposition", async () => {
  const { tools, repository, assertions } = await setup()
  const submit = await Effect.runPromise(
    tools.get("lazers_submit_task")!.execute(keyedProposal(), context),
  )
  const { taskID } = JSON.parse(String(submit.content))
  const input = {
    taskID,
    requestID: "dispose-tool-test",
    disposition: "superseded",
    reason: "Replaced by the integrated implementation.",
    evidence: [{ kind: "verification", reference: "bun test" }],
    relatedTaskIDs: [],
  }
  const dispose = tools.get("lazers_dispose_task")!
  const recorded = JSON.parse(
    String(
      await Effect.runPromise(dispose.execute(input, context)).then((result) => result.content),
    ),
  )
  expect(recorded.status).toBe("recorded")
  const replayed = JSON.parse(
    String(
      await Effect.runPromise(dispose.execute(input, context)).then((result) => result.content),
    ),
  )
  expect(replayed.status).toBe("replayed")
  expect(repository.list()).toHaveLength(0)
  expect(
    JSON.parse(
      String(
        await Effect.runPromise(
          tools.get("lazers_query_tasks")!.execute({ includeRetired: true }, context),
        ).then((result) => result.content),
      ),
    ).tasks[0].disposition.disposition,
  ).toBe("superseded")
  expect(assertions).toContain("lazers_dispose_task")
})

test("task disposition is Architect-only even when native permission allows the tool", async () => {
  const { tools } = await setup()
  const implementor = { ...context, agent: Agent.ID.make("lazers-implementor") }
  await expect(
    Effect.runPromise(
      tools.get("lazers_dispose_task")!.execute(
        {
          taskID: crypto.randomUUID(),
          requestID: "implementor-dispose",
          disposition: "rejected",
          reason: "No.",
          evidence: [{ kind: "human", reference: "review" }],
        },
        implementor,
      ),
    ),
  ).rejects.toThrow("restricted to Architect")
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
    ["lazers_get_task_instructions", { taskID: receipt.taskID }],
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
    ["lazers_get_task_instructions", { taskID: crypto.randomUUID() }],
    ["lazers_list_tasks", { limit: 2 }],
  ] as const) {
    await expect(
      Effect.runPromise(denied.tools.get(name)!.execute(input, context)),
    ).rejects.toThrow("Permission denied")
  }
})

test("registered Code Mode implementor fetch yields readable instructions before typed data", async () => {
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
  const instructionsTool = tools.get("lazers_get_task_instructions")!
  const result = await Effect.runPromise(
    tools
      .get("lazers_get_task_instructions")!
      .execute({ taskID }, { ...context, agent: Agent.ID.make("lazers-implementor") }),
  )
  expect(instructionsTool.options).toMatchObject({ codemode: true, pinned: true })
  expect(instructionsTool.output).toBeDefined()
  const value = resultValue(result)
  if (typeof value !== "string") throw new Error("Readable Code Mode output must be a string")
  expect(typeof value).toBe("string")
  expect(GetInstructionsOutput.parse(value)).toBe(value)
  const prose = value
  expect(prose).toContain(`# Task ${taskID}`)
  expect(prose).toContain("## Done when")
  expect(prose).toContain("## Verification")
  expect(prose.indexOf("## Done when")).toBeLessThan(prose.indexOf("## Constraints"))
  expect(prose).toContain("## Implementation guidance (advisory)")
  expect(prose).toContain(proposal.guidance)
  expect(prose).toContain("## Write scope")
  expect(prose).toContain("## Exclusions")
  expect(prose).toContain("## Context references")
  expect(prose).not.toContain('"proposal"')
  expect(result.output).toBe(prose)
  expect(resultValue({ ...result, content: "This fallback must not override output" })).toBe(
    result.output,
  )

  const structured = await Effect.runPromise(
    tools
      .get("lazers_get_task")!
      .execute({ taskID }, { ...context, agent: Agent.ID.make("lazers-implementor") }),
  )
  const structuredValue = resultValue(structured)
  expect(structuredValue).toHaveProperty("task.id", taskID)
  expect(structuredValue).toHaveProperty("task.proposal.objective", validProposal().objective)
  expect(structuredValue).toHaveProperty("task.proposal.guidance", proposal.guidance)
})

test("readable task fetch handles missing and unavailable revisions", async () => {
  const { tools } = await setup()
  const receipt = await Effect.runPromise(
    tools.get("lazers_submit_task")!.execute(keyedProposal(), context),
  )
  const { taskID } = JSON.parse(String(receipt.content))
  const instructions = tools.get("lazers_get_task_instructions")!

  const missing = await Effect.runPromise(
    instructions.execute({ taskID: crypto.randomUUID() }, context),
  )
  const unavailable = await Effect.runPromise(
    instructions.execute({ taskID, revision: 2 }, context),
  )
  expect(resultValue(missing)).toBe("Task not_found.")
  expect(resultValue(unavailable)).toBe("Task revision_unavailable.")
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
    ["lazers_get_task_instructions", { taskID: receipt.taskID }],
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
    const isolatedInstructions = await Effect.runPromise(
      isolated.tools
        .get("lazers_get_task_instructions")!
        .execute({ taskID: receipt.taskID }, isolated.context),
    )
    expect(resultValue(isolatedInstructions)).toBe("Task not_found.")
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
