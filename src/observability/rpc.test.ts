import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { ObservationReads } from "./read.ts"
import { registerObservability } from "./rpc.ts"
import { makeFixture, taskID } from "../../test/trajectory/fixture.ts"

test("history cache hits remain permission-first and continuation data stays scoped", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(2)
  let denied = false
  let foreignProject = false
  let contextReads = 0
  const permissionCalls: string[] = []
  const reads = new ObservationReads(
    fixture.store,
    {
      session: async (id) => {
        contextReads++
        return fixture.host.session(id)
      },
      status: async (id) => {
        const session = fixture.sessions.get(id)
        return session
          ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
          : null
      },
    },
    "project",
    secret,
  )
  let handlers:
    | {
        trajectoryHistory(
          input: unknown,
          context: {
            error(type: string, message: string, data: unknown): unknown
          },
        ): Effect.Effect<unknown, unknown>
        trajectoryStatus(input: unknown): Effect.Effect<unknown>
      }
    | undefined
  const rpcContext = {
    error: (type: string, message: string, data: unknown) => ({ type, message, data }),
  }
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: typeof handlers) => {
        handlers = methods
        return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed({
          id: sessionID,
          projectID: foreignProject ? "foreign-project" : "project",
          agent: "architect",
          time: { archived: undefined },
        }),
    },
    permission: {
      assert: (input: { action: string }) => {
        permissionCalls.push(input.action)
        return denied ? Effect.fail(new Error("native permission denied")) : Effect.void
      },
    },
    event: { subscribe: () => Stream.empty },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerObservability(ctx, reads, "project")
        }),
      ),
    )
    const scope = { kind: "project" as const, sessionID: "ses-owner" }
    const first = (await Effect.runPromise(
      handlers!.trajectoryHistory({ scope, taskID, limit: 2 }, rpcContext),
    )) as {
      report: { trajectory: { events: unknown[]; nextCursor: string | null } }
      eventIDs: string[]
    }
    expect(first.report.trajectory.events).toHaveLength(2)
    expect(first.report.trajectory.nextCursor).not.toBeNull()
    expect(contextReads).toBe(2)

    denied = true
    await expect(
      Effect.runPromise(
        handlers!.trajectoryHistory(
          {
            scope,
            taskID,
            limit: 2,
            cursor: first.report.trajectory.nextCursor,
          },
          rpcContext,
        ),
      ),
    ).rejects.toThrow("native permission denied")
    expect(contextReads).toBe(2)
    denied = false

    const second = (await Effect.runPromise(
      handlers!.trajectoryHistory(
        {
          scope,
          taskID,
          limit: 2,
          cursor: first.report.trajectory.nextCursor,
        },
        rpcContext,
      ),
    )) as { report: { trajectory: { page: number; events: unknown[] } } }
    expect(second.report.trajectory.page).toBe(2)
    expect(second.report.trajectory.events).toHaveLength(2)
    expect(contextReads).toBe(2)

    const originalCursor = first.report.trajectory.nextCursor!
    const tamperedCursor = `${originalCursor.slice(0, -1)}${originalCursor.endsWith("A") ? "B" : "A"}`
    await expect(
      Effect.runPromise(
        handlers!.trajectoryHistory(
          { scope, taskID, limit: 2, cursor: tamperedCursor },
          rpcContext,
        ),
      ),
    ).rejects.toMatchObject({
      type: "trajectory_history_unavailable",
      data: { reason: "invalid-cursor", recovery: "recapture" },
    })
    expect(contextReads).toBe(2)

    await expect(
      Effect.runPromise(
        handlers!.trajectoryHistory(
          {
            scope: { kind: "session", sessionID: "ses-unrelated" },
            taskID,
            limit: 2,
            cursor: first.report.trajectory.nextCursor,
          },
          rpcContext,
        ),
      ),
    ).rejects.toThrow("No observation in this scope")

    foreignProject = true
    await expect(
      Effect.runPromise(
        handlers!.trajectoryHistory(
          {
            scope,
            taskID,
            limit: 2,
            cursor: first.report.trajectory.nextCursor,
          },
          rpcContext,
        ),
      ),
    ).rejects.toThrow("Observation scope is unavailable")
    expect(permissionCalls).toEqual([
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
      "lz-inspect-trajectory",
    ])
  } finally {
    fixture.close()
  }
})
