import { expect, test } from "bun:test"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { registerToolResults } from "../tool-results.ts"
import { endStalenessSession, ProgressStaleness, STALE_PROGRESS_CALLS } from "./stale-reminder.ts"

test("the reminder is due once per stale stretch and again only after a report goes stale", () => {
  const staleness = new ProgressStaleness(3)
  for (let call = 0; call < 2; call++) staleness.record("s", "shell", true)
  expect(staleness.due("s")).toBeUndefined()
  staleness.record("s", "shell", true)
  expect(staleness.due("s")).toContain("3 tool calls since your last lz-report-progress")
  for (let call = 0; call < 10; call++) staleness.record("s", "shell", true)
  expect(staleness.due("s")).toBeUndefined()
  staleness.record("s", "lz-report-progress", true)
  for (let call = 0; call < 2; call++) staleness.record("s", "shell", false)
  expect(staleness.due("s")).toBeUndefined()
  staleness.record("s", "shell", true)
  expect(staleness.due("s")).toBeDefined()
  // A failed report records nothing, so it does not reset the count.
  staleness.record("s", "lz-report-progress", false)
  expect(staleness.due("s")).toBeUndefined()
  expect(new ProgressStaleness().due("other")).toBeUndefined()
  expect(STALE_PROGRESS_CALLS).toBeGreaterThan(0)
})

function harness(owned = true) {
  let handler: ((event: never) => Effect.Effect<void>) | undefined
  const ctx = {
    location: { directory: "/project" },
    session: {
      get: () =>
        Effect.succeed({
          projectID: owned ? "project" : "elsewhere",
          location: { directory: "/project" },
        }),
    },
    tool: {
      hook: (_name: string, callback: typeof handler) =>
        Effect.sync(() => {
          handler = callback
          return { dispose: Effect.void }
        }),
      list: () => Effect.succeed([]),
    },
  }
  Effect.runSync(
    Effect.scoped(registerToolResults(ctx as never, "project", new ProgressStaleness(3))),
  )
  let counter = 0
  return {
    call: async (tool: string, extra: object = {}) => {
      const event = {
        tool,
        agent: "lazers-implementor",
        sessionID: "ses",
        input: {},
        status: "completed",
        result: { content: [{ type: "text", text: "answer" }] },
        id: `call-${counter++}`,
        ...extra,
      }
      await Effect.runPromise(handler!(event as never))
      return event as unknown as {
        status: string
        result: { content: unknown; output?: unknown }
        error: Tool.Error
      }
    },
  }
}

const text = (content: unknown) =>
  typeof content === "string"
    ? content
    : (content as { text: string }[]).map((part) => part.text).join("\n")

test("a worker with stale progress gets one reminder line on its next LAZERS result", async () => {
  const { call } = harness()
  for (const tool of ["shell", "read", "edit"]) {
    const result = await call(tool)
    expect(text(result.result.content)).toBe("answer")
  }
  // Non-LAZERS results never carry the reminder, even when due.
  expect(text((await call("shell")).result.content)).toBe("answer")
  const due = await call("lz-get-task", {
    result: { content: "instructions", output: "instructions" },
  })
  expect(due.result.content).toContain("tool calls since your last lz-report-progress")
  expect(due.result.output).toContain("tool calls since your last lz-report-progress")
  const next = await call("lz-list-tasks")
  expect(text(next.result.content)).toBe("answer")
  // A structured output carries the line beside its data, where a Code Mode script reads it.
  const reported = await call("lz-report-progress")
  expect(text(reported.result.content)).toBe("answer")
  for (let index = 0; index < 3; index++) await call("shell")
  const again = await call("lz-query-tasks", { result: { content: "{}", output: { rows: [] } } })
  expect((again.result.output as { reminder: string }).reminder).toContain("Reminder:")
  expect(text(again.result.content)).toContain("Reminder:")
})

test("the reminder is advice on a failure too, and never replaces or blocks anything", async () => {
  const { call } = harness()
  for (let index = 0; index < 3; index++) await call("shell")
  const failed = await call("lz-get-task", {
    status: "error",
    error: new Tool.Error({ message: "task not found" }),
  })
  expect(failed.status).toBe("error")
  expect(failed.error.message.startsWith("task not found\n\nReminder:")).toBe(true)
})

test("the Code Mode wrapper, other agents and sessions of another project are not counted", async () => {
  const { call } = harness()
  for (let index = 0; index < 5; index++) await call("execute")
  for (let index = 0; index < 5; index++) await call("shell", { agent: "architect" })
  expect(text((await call("lz-get-task")).result.content)).toBe("answer")
  const elsewhere = harness(false)
  for (let index = 0; index < 5; index++) await elsewhere.call("shell")
  expect(text((await elsewhere.call("lz-get-task")).result.content)).toBe("answer")
})

test("a session end drops its staleness entry in every live counter", () => {
  const first = new ProgressStaleness(2)
  const second = new ProgressStaleness(2)
  for (const staleness of [first, second]) staleness.record("ended", "shell", true)
  endStalenessSession("ended")
  for (const staleness of [first, second]) staleness.record("ended", "shell", true)
  // Each counter restarted at one call, below the threshold of two.
  expect(first.due("ended")).toBeUndefined()
  expect(second.due("ended")).toBeUndefined()
})
