import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { ProgressRecorder } from "../progress/recorder.ts"
import { registerObservability } from "./rpc.ts"
import type { ObservationReads } from "./read.ts"
import type { LiveRadarResponse } from "./contract.ts"
import { LiveReadStore } from "./live-store.ts"
import { firstAttemptID, makeFixture } from "../../test/trajectory/fixture.ts"
import { operationalReads } from "../../test/radar/operational.ts"

type Handlers = {
  liveRadar(input: {
    scope: { kind: "session" | "project"; sessionID: string }
    includeUnmanagedSessions: boolean
  }): Effect.Effect<unknown>
}

const worker = { sessionID: "ses-failed", agent: "lazers-implementor" }

test("a worker's calls show what ran, redacted, and survive a large result", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const calls = [
      {
        tool: "bash",
        callID: "call-bash",
        input: {
          command:
            "API_TOKEN=SECRET-ENV-DECOY bun test src/runner/resume.test.ts --token SECRET-FLAG-DECOY",
        },
      },
      { tool: "read", callID: "call-read", input: { filePath: "src/runner/lifecycle.ts" } },
      { tool: "grep", callID: "call-grep", input: { pattern: "interrupted", path: "src/runner" } },
    ]
    for (const call of calls) {
      recorder.recordToolTargets({
        ...worker,
        messageID: `msg-${call.callID}`,
        ...call,
      })
    }
    // A finished call whose result is far over the live payload limit must still be listed.
    recorder.recordToolHook({
      ...worker,
      tool: "bash",
      messageID: "msg-call-bash",
      callID: "call-bash",
      status: "completed",
      input: calls[0]!.input,
      result: { content: "x".repeat(9_000) } as never,
    })

    const reads = operationalReads(fixture) as ObservationReads
    let handlers: Handlers | undefined
    const context = {
      rpc: {
        register: (_definition: unknown, methods: Handlers) => {
          handlers = methods
          return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
        },
      },
      permission: { assert: () => Effect.void },
      session: {
        get: ({ sessionID }: { sessionID: string }) =>
          Effect.succeed({
            id: sessionID,
            projectID: "project",
            agent: "architect",
            time: { archived: undefined },
          }),
      },
      event: { subscribe: () => Stream.empty },
    } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(context, reads, "project")
          const live = (yield* handlers!.liveRadar({
            scope: { kind: "session", sessionID: "ses-failed" },
            includeUnmanagedSessions: false,
          })) as LiveRadarResponse
          const byCall = new Map(live.calls.map((call) => [call.callID, call]))
          expect(byCall.get("call-bash")?.detail).toBe(
            "API_TOKEN=[REDACTED] bun test src/runner/resume.test.ts --token …",
          )
          expect(byCall.get("call-read")?.detail).toBe("src/runner/lifecycle.ts")
          expect(byCall.get("call-grep")?.detail).toBe('"interrupted" src/runner')
          const exposed = JSON.stringify(live)
          expect(exposed).not.toContain("SECRET-ENV-DECOY")
          expect(exposed).not.toContain("SECRET-FLAG-DECOY")
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test("a session with no runner assignment still gets its call summaries", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    recorder.recordToolBefore({
      tool: "execute",
      sessionID: "ses-architect",
      agent: "architect",
      messageID: "msg-architect",
      callID: "call-execute",
      input: { code: "const plan = await lz-inspect-plan({ planID }); await lz-query-tasks({})" },
    })
    recorder.recordToolBefore({
      tool: "read",
      sessionID: "ses-architect",
      agent: "architect",
      messageID: "msg-architect",
      callID: "call-read",
      input: { filePath: "DESIGN.md" },
    })
    const store = new LiveReadStore(
      fixture.store.repository.path,
      fixture.store.repository.projectDirectory,
      "project",
    )
    const details = store.toolDetails(["ses-architect", "ses-other"], new AbortController().signal)
    expect(details.get("ses-architect\u0000call-execute")).toBe("lz-inspect-plan · lz-query-tasks")
    expect(details.get("ses-architect\u0000call-read")).toBe("DESIGN.md")
    expect([...details.keys()].some((key) => key.startsWith("ses-other"))).toBe(false)
  } finally {
    fixture.close()
  }
})

test("the Architect's native calls reach the live read with details and no runner assignment", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const scoped = (callID: string, tool: string, input: unknown) => ({
      tool,
      sessionID: "ses-owner",
      agent: "architect",
      messageID: `msg-${callID}`,
      callID,
      input,
    })
    recorder.recordToolBefore(
      scoped("a1", "execute", { code: 'await tools["lz-query-tasks"]({})' }),
    )
    recorder.recordToolHook({
      ...scoped("a1", "execute", { code: 'await tools["lz-query-tasks"]({})' }),
      status: "completed",
      result: { content: "ok" } as never,
    })
    recorder.recordToolBefore(scoped("a2", "read", { filePath: `${fixture.directory}/DESIGN.md` }))
    const reads = operationalReads(fixture) as ObservationReads
    let handlers: Handlers | undefined
    const context = {
      rpc: {
        register: (_definition: unknown, methods: Handlers) => {
          handlers = methods
          return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
        },
      },
      permission: { assert: () => Effect.void },
      session: {
        get: ({ sessionID }: { sessionID: string }) =>
          Effect.succeed({
            id: sessionID,
            projectID: "project",
            agent: "architect",
            time: { archived: undefined },
          }),
      },
      event: { subscribe: () => Stream.empty },
    } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(context, reads, "project")
          const live = (yield* handlers!.liveRadar({
            scope: { kind: "project", sessionID: "ses-owner" },
            includeUnmanagedSessions: false,
          } as never)) as LiveRadarResponse
          const mine = live.calls.filter((call) => call.sessionID === "ses-owner")
          const byCall = new Map(mine.map((call) => [call.callID, call]))
          expect(byCall.get("a1")).toMatchObject({
            tool: "execute",
            status: "succeeded",
            attemptID: null,
            detail: "lz-query-tasks",
          })
          expect(byCall.get("a2")).toMatchObject({
            tool: "read",
            status: "running",
            detail: "DESIGN.md",
          })
          expect(JSON.stringify(live)).not.toContain(fixture.directory)
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})
