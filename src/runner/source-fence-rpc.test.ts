import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Exit, Cause } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import plugin from "../index.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { registerWorker } from "./roles.ts"
import { registerSourceFence } from "./source-fence-rpc.ts"
import {
  beginSourceGuard,
  sourceGuardInstalled,
  sourceGuardMatches,
  sourceReservationExcluded,
} from "./source-quarantine.ts"

test("the exact native location reports its installed guard only for its live hook scope", async () => {
  const f = makeFixture()
  let status: (() => Effect.Effect<unknown>) | undefined
  const ctx = {
    location: { directory: f.repository.projectDirectory, project: { id: "project" } },
    agent: { transform: () => Effect.void },
    permission: { hook: () => Effect.void },
    session: { hook: () => Effect.void },
    tool: {
      hook: () =>
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            expect(sourceGuardInstalled(f.store, f.repository.projectDirectory)).toBe(false)
          }),
        ),
    },
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

test("a replacement fences unguarded generations and restores the installed survivor on disposal", () => {
  const f = makeFixture()
  const path = f.repository.projectDirectory
  const old = beginSourceGuard({ directory: path, projectDirectory: f.repository.projectDirectory })
  const current = beginSourceGuard({
    directory: path,
    projectDirectory: f.repository.projectDirectory,
  })
  try {
    current.install(f.store)
    expect(sourceGuardInstalled(f.store, path)).toBe(false)
    old.dispose()
    expect(sourceGuardMatches(f.store, path, current.registrationID)).toBe(true)
    expect(sourceGuardMatches(f.store, path, old.registrationID)).toBe(false)
    const replacement = beginSourceGuard({
      directory: path,
      projectDirectory: f.repository.projectDirectory,
    })
    try {
      expect(sourceGuardInstalled(f.store, path)).toBe(false)
      replacement.install(f.store)
      expect(sourceGuardMatches(f.store, path, replacement.registrationID)).toBe(true)
    } finally {
      replacement.dispose()
    }
    // S1-1: disposing a replacement restores the surviving installed hook scope.
    expect(sourceGuardInstalled(f.store, path)).toBe(true)
    expect(sourceGuardMatches(f.store, path, current.registrationID)).toBe(true)
  } finally {
    old.dispose()
    current.dispose()
    f.close()
  }
})

test("full plugin early setup failure restores the surviving predecessor guard", async () => {
  for (const failure of ["project-index", "options", "repository"] as const) {
    const f = makeFixture()
    const workspace = join(f.directory, "retained-source")
    mkdirSync(workspace)
    const retained = { ...f.attempts[1]!, state: "verifying" as const, workspace }
    f.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET state='verifying',workspace=? WHERE id=?").run(
        workspace,
        retained.id,
      )
      db.query(
        `INSERT INTO runner_source_quarantines
        (attempt_id,plan_id,session_id,assigned_message_id,requested_owner,workspace,request_id,reason,phase,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'retained resources','sealed',0,0)`,
      ).run(
        retained.id,
        retained.plan_id,
        retained.session_id,
        retained.message_id,
        "ses-owner",
        workspace,
        crypto.randomUUID(),
      )
    })
    let hookLive = false
    const prior = {
      location: { directory: workspace, project: { id: "project", canonical: f.directory } },
      agent: { transform: () => Effect.void },
      permission: { hook: () => Effect.void },
      session: { hook: () => Effect.void },
      tool: {
        hook: () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              hookLive = true
            }),
            () =>
              Effect.sync(() => {
                hookLive = false
              }),
          ),
      },
    } as unknown as Plugin.Context
    const blockedPath = join(f.directory, failure === "project-index" ? "context" : "blocked-data")
    writeFileSync(blockedPath, "not a directory")
    const next = {
      // S1-1: reach the intended setup fault after the budget registration added before the guard.
      rpc: { register: () => Effect.void },
      options: {
        dataDirectory:
          failure === "options" ? 1 : failure === "repository" ? blockedPath : f.directory,
      },
      location: prior.location,
    } as unknown as Plugin.Context
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerWorker(prior, f.store)
            expect(sourceReservationExcluded(f.store, retained, { mode: "isolated" })).toBe(true)
            const failed = yield* Effect.exit(Effect.scoped(plugin.effect(next)))
            expect(Exit.isFailure(failed)).toBe(true)
            if (failure === "project-index" && Exit.isFailure(failed)) {
              expect(Cause.pretty(failed.cause)).toContain("EEXIST")
              expect(Cause.pretty(failed.cause)).toContain("context")
            }
            expect(hookLive).toBe(true)
            // S1-1: failed plugin setup must not disable the surviving native guard.
            expect(sourceGuardInstalled(f.store, workspace)).toBe(true)
            expect(sourceReservationExcluded(f.store, retained, { mode: "isolated" })).toBe(true)
          }),
        ),
      )
      expect(hookLive).toBe(false)
    } finally {
      f.close()
    }
  }
})
