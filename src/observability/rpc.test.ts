import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Fiber } from "effect"
import { ObservationReads } from "./read.ts"
import { registerObservability } from "./rpc.ts"
import { sharedScheduler } from "../runner/scheduler-coordinator.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"

test("progress diagnostics are project-isolated and process scheduler totals are Architect-only", async () => {
  const fixture = makeFixture()
  let denied = false
  let foreignProject = false
  let archived = false
  let agent = "architect"
  let permissionCalls = 0
  let processSamples = 0
  let delayedSessionRead: (() => Effect.Effect<unknown, unknown, never>) | undefined
  let handlers:
    | {
        progressDiagnostics(input: unknown): Effect.Effect<unknown>
      }
    | undefined
  const originalSnapshot = sharedScheduler.snapshot.bind(sharedScheduler)
  sharedScheduler.snapshot = () => {
    processSamples++
    return originalSnapshot()
  }
  const reads = new ObservationReads(fixture.store, "project")
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: typeof handlers) => {
        handlers = methods
        return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        delayedSessionRead?.() ??
        Effect.succeed({
          id: sessionID,
          projectID: foreignProject ? "foreign-project" : "project",
          agent,
          time: { archived: archived ? 1 : undefined },
        }),
    },
    permission: {
      assert: () => {
        permissionCalls++
        return denied ? Effect.fail(new Error("native permission denied")) : Effect.void
      },
    },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session">
  const scope = { kind: "project" as const, sessionID: "ses-private-anchor" }

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
        }),
      ),
    )
    const response = (await Effect.runPromise(handlers!.progressDiagnostics({ scope }))) as Record<
      string,
      unknown
    >
    expect(response.scope).toEqual({ kind: "project" })
    expect(response.state).toBe("absent")
    expect(response.processSchedulerTotals).toMatchObject({
      status: "available",
      scope: "process",
      audience: "architect-only",
      source: "sharedScheduler.snapshot",
      implementation: "scheduler/v2",
    })
    expect((response.processSchedulerTotals as { generation: string }).generation).toMatch(
      /^[0-9a-f-]{36}$/,
    )
    expect(processSamples).toBe(1)
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain("ses-private-anchor")
    expect(serialized).not.toContain(fixture.directory)

    denied = true
    await expect(Effect.runPromise(handlers!.progressDiagnostics({ scope }))).rejects.toThrow(
      "native permission denied",
    )
    expect(processSamples).toBe(1)
    denied = false

    foreignProject = true
    await expect(Effect.runPromise(handlers!.progressDiagnostics({ scope }))).rejects.toThrow(
      "Observation scope is unavailable",
    )
    expect(processSamples).toBe(1)
    foreignProject = false

    archived = true
    // S8: archival retires execution, not permission to read project telemetry.
    expect(await Effect.runPromise(handlers!.progressDiagnostics({ scope }))).toMatchObject({
      processSchedulerTotals: { status: "available" },
    })
    expect(processSamples).toBe(2)
    archived = false

    agent = "lazers-implementor"
    const nonArchitect = (await Effect.runPromise(handlers!.progressDiagnostics({ scope }))) as {
      processSchedulerTotals: { status: string; reason?: string }
    }
    expect(nonArchitect.processSchedulerTotals).toEqual({
      status: "unavailable",
      reason: "architect-only",
    })
    expect(processSamples).toBe(2)

    agent = "architect"
    const getStarted = Promise.withResolvers<void>()
    const releaseGet = Promise.withResolvers<unknown>()
    delayedSessionRead = () =>
      Effect.promise(() => {
        getStarted.resolve()
        return releaseGet.promise
      })
    const cancelled = Effect.runFork(handlers!.progressDiagnostics({ scope }))
    await getStarted.promise
    await Effect.runPromise(Fiber.interrupt(cancelled))
    releaseGet.resolve({
      id: scope.sessionID,
      projectID: "project",
      agent,
      time: { archived: undefined },
    })
    const permissionCountAfterCancel = permissionCalls + 1
    const deadline = Date.now() + 2_000
    while (permissionCalls < permissionCountAfterCancel && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    expect(permissionCalls).toBe(permissionCountAfterCancel)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(processSamples).toBe(2)
  } finally {
    sharedScheduler.snapshot = originalSnapshot
    fixture.close()
  }
})
