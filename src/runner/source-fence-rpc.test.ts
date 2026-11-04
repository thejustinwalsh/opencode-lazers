import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { registerWorker } from "./roles.ts"
import { registerSourceFence } from "./source-fence-rpc.ts"
import { beginSourceGuard, sourceGuardInstalled, sourceGuardMatches } from "./source-quarantine.ts"

test("the exact native location reports its installed guard only for its live hook scope", async () => {
  const f = makeFixture()
  let status: (() => Effect.Effect<unknown>) | undefined
  const ctx = {
    location: { directory: f.repository.projectDirectory, project: { id: "project" } },
    agent: { transform: () => Effect.void },
    session: { hook: () => Effect.void },
    tool: { hook: () => Effect.void },
    rpc: {
      register: (_definition: unknown, handlers: { status: () => Effect.Effect<unknown> }) =>
        Effect.sync(() => {
          status = handlers.status
          return {}
        }),
    },
  } as unknown as Plugin.Context
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const guard = yield* registerWorker(ctx, f.store)
          yield* registerSourceFence(ctx, f.store, guard)
          expect(yield* status!()).toEqual({
            pid: process.pid,
            projectID: "project",
            directory: f.repository.projectDirectory,
            databasePath: f.repository.path,
            registrationID: guard.registrationID,
          })
        }),
      ),
    )
    expect(sourceGuardInstalled(f.store, f.repository.projectDirectory)).toBe(false)
    await expect(Effect.runPromise(status!())).rejects.toThrow("current location generation")
  } finally {
    f.close()
  }
})

test("a replacement cannot fall back to old or known unguarded generation registrations", () => {
  const f = makeFixture()
  const path = f.repository.projectDirectory
  const old = beginSourceGuard(f.store, path)
  const current = beginSourceGuard(f.store, path)
  try {
    current.install()
    expect(sourceGuardInstalled(f.store, path)).toBe(false)
    old.dispose()
    expect(sourceGuardMatches(f.store, path, current.registrationID)).toBe(true)
    expect(sourceGuardMatches(f.store, path, old.registrationID)).toBe(false)
    const replacement = beginSourceGuard(f.store, path)
    try {
      expect(sourceGuardInstalled(f.store, path)).toBe(false)
      replacement.install()
      expect(sourceGuardMatches(f.store, path, replacement.registrationID)).toBe(true)
    } finally {
      replacement.dispose()
    }
    // A disposed replacement never resurrects an old still-live scope.
    expect(sourceGuardInstalled(f.store, path)).toBe(false)
  } finally {
    old.dispose()
    current.dispose()
    f.close()
  }
})
