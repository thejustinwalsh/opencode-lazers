import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, DateTime } from "effect"
import { nativeTrajectoryHost } from "./native.ts"

const sessionRecord = (projectID = "project") => ({
  id: "ses-owned",
  projectID,
  parentID: "ses-owner",
  model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
  outcome: "succeeded",
  time: {
    created: DateTime.nowUnsafe(),
    updated: DateTime.nowUnsafe(),
    busy: undefined,
    idle: DateTime.nowUnsafe(),
  },
  tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 4, write: 1 } },
})

test("native adapter reads only the owned session context and projects public times/usage", async () => {
  const calls: string[] = []
  const host = nativeTrajectoryHost(
    {
      session: {
        get: (input: { sessionID: string }) =>
          Effect.sync(() => {
            calls.push(`get:${input.sessionID}`)
            return sessionRecord()
          }),
        context: (input: { sessionID: string }) =>
          Effect.sync(() => {
            calls.push(`context:${input.sessionID}`)
            return []
          }),
      },
    } as unknown as Plugin.Context,
    "project",
  )
  const result = await host.session("ses-owned")
  expect(calls).toEqual(["get:ses-owned", "context:ses-owned"])
  expect(result?.projectID).toBe("project")
  expect(result?.model).toEqual({ providerID: "openai", id: "gpt-6-luna", variant: "max" })
  expect(result?.tokens).toEqual({
    input: 12,
    output: 3,
    reasoning: 2,
    cache: { read: 4, write: 1 },
  })
  expect(result?.time.created).toBeGreaterThan(0)
  expect(result?.messages).toEqual([])
})

test("native adapter refuses a foreign project before reading its transcript", async () => {
  const calls: string[] = []
  const host = nativeTrajectoryHost(
    {
      session: {
        get: () =>
          Effect.sync(() => {
            calls.push("get")
            return sessionRecord("foreign-project")
          }),
        context: () =>
          Effect.sync(() => {
            calls.push("context")
            return []
          }),
      },
    } as unknown as Plugin.Context,
    "project",
  )
  await expect(host.session("ses-owned")).rejects.toThrow("outside this project")
  expect(calls).toEqual(["get"])
})

test("native context access failures remain explicit and redact credentials", async () => {
  const host = nativeTrajectoryHost(
    {
      session: {
        get: () => Effect.succeed(sessionRecord()),
        context: () => Effect.fail(new Error("Authorization: Bearer native-secret-value")),
      },
    } as unknown as Plugin.Context,
    "project",
  )
  const result = await host.session("ses-owned")
  expect(result?.messageStatus).toBe("unavailable")
  expect(result?.messageError).toContain("[REDACTED]")
  expect(result?.messageError).not.toContain("native-secret-value")
})
