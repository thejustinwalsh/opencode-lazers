import { expect, test } from "bun:test"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { collectTools } from "../test/tool-inventory.ts"
import { explainInvalidInput, exampleFor, usageFor, zodInput } from "./tool-input.ts"
import { registerToolResults } from "./tool-results.ts"

const tools = await collectTools()

test("every registered tool renders full usage with a valid example", () => {
  expect(tools.size).toBeGreaterThan(40)
  for (const [name, tool] of tools) {
    const schema = zodInput(tool.input)
    expect(schema, `${name} has a Zod schema behind its input`).toBeDefined()
    const usage = usageFor(name, tool.input)
    expect(usage, name).toContain(`Usage of ${name}`)
    const example = exampleFor(name, tool.input)
    expect(example, `${name} has an example that its own schema accepts`).toBeDefined()
    expect(schema!.safeParse(example).success).toBe(true)
    expect(usage).toContain(JSON.stringify(example))
  }
})

test("usage names every top-level field and marks it required or optional", () => {
  const usage = usageFor("lz-submit-task", tools.get("lz-submit-task")!.input)!
  expect(usage).toMatch(/idempotencyKey {2}string, required/)
  expect(usage).toMatch(/guidance {2}string, optional/)
  expect(usage).toMatch(/evidence {2}array of object \| object, required/)
})

test("a wrong call names what was wrong in plain words, then the usage, and nothing else", () => {
  const input = tools.get("lz-submit-task")!.input
  const text = explainInvalidInput("lz-submit-task", input, {
    objective: 7,
    taskObjective: "typo",
    idempotencyKey: "",
  })!
  const [head, ...rest] = text.split("\n\nUsage of ")
  expect(head).toContain("lz-submit-task was called with arguments that do not match its input:")
  expect(head).toContain("- objective: expected string, got the number 7.")
  expect(head).toContain("- idempotencyKey: must be at least 1 character")
  expect(head).toContain('unknown field "taskObjective"; allowed: ')
  expect(head).toContain("- acceptance: required, missing.")
  expect(rest).toHaveLength(1)
  expect(rest[0]).toMatch(/\nExample:\n {2}\{/)
  expect(text).not.toContain("Arguments provided")
})

test("a correct call, or a failure that is not about the arguments, explains nothing", () => {
  const input = tools.get("lz-report-progress")!.input
  expect(explainInvalidInput("lz-report-progress", input, { message: "done" })).toBeUndefined()
  expect(explainInvalidInput("lz-unknown", { type: "object" }, {})).toBeUndefined()
})

function hooked(listed = [...tools.entries()].map(([name, tool]) => ({ ...tool, id: name }))) {
  let handler: ((event: never) => Effect.Effect<void>) | undefined
  const ctx = {
    tool: {
      hook: (_name: string, callback: typeof handler) =>
        Effect.sync(() => {
          handler = callback
          return { dispose: Effect.void }
        }),
      list: () => Effect.succeed(listed),
    },
  }
  Effect.runSync(Effect.scoped(registerToolResults(ctx as never)))
  return (event: object) => Effect.runPromise(handler!(event as never))
}

test("the shared after-hook rewrites an argument failure and leaves everything else alone", async () => {
  const run = hooked()
  const bad = {
    tool: "lz-report-progress",
    input: { note: "wrong field" },
    status: "error",
    error: new Tool.Error({
      message: 'Invalid arguments for tool "lz-report-progress":\n- message',
    }),
  }
  await run(bad)
  expect(bad.error).toBeInstanceOf(Tool.Error)
  expect(bad.error.message).toContain("- message: required, missing.")
  expect(bad.error.message).toContain('unknown field "note"; allowed: message')
  expect(bad.error.message).toContain("Usage of lz-report-progress")
  expect(bad.error.message).toContain('{"message":"x"}')
  expect(bad.error.message).not.toContain("Invalid arguments for tool")

  const repaired = {
    ...bad,
    error: new Tool.Error({
      message: `bad\n\nThere is no "bash" tool, so this ran as "lz-report-progress". Call "lz-report-progress" directly.`,
    }),
  }
  await run(repaired)
  expect(repaired.error.message).toContain("Usage of lz-report-progress")
  expect(repaired.error.message).toMatch(/Call "lz-report-progress" directly\.$/)

  const failedForAnotherReason = {
    ...bad,
    input: { message: "fine" },
    error: new Tool.Error({ message: "database is locked" }),
  }
  await run(failedForAnotherReason)
  expect(failedForAnotherReason.error.message).toBe("database is locked")

  const foreign = { ...bad, tool: "shell", error: new Tool.Error({ message: "nope" }) }
  await run(foreign)
  expect(foreign.error.message).toBe("nope")

  const ok = {
    tool: "lz-report-progress",
    input: { message: "fine" },
    status: "completed",
    result: { content: "ok" },
  }
  await run(ok)
  expect(ok.result).toEqual({ content: "ok" })
})
