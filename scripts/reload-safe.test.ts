import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  observeVerificationProcesses,
  type ReloadObservationDependencies,
} from "../src/runner/reload-observation.ts"
import { runReloadSafe } from "./reload-safe.ts"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-reload-safe-"))
  const databasePath = join(root, "tasks.sqlite")
  const db = new Database(databasePath)
  db.exec(`
    CREATE TABLE runner_plans(id TEXT, state TEXT, owner TEXT);
    CREATE TABLE runner_attempts(id TEXT, plan_id TEXT, state TEXT, session_id TEXT);
    CREATE TABLE runner_effects(id TEXT, kind TEXT, state TEXT, payload TEXT, receipt TEXT);
    CREATE TABLE runner_transitions(event TEXT, payload TEXT, created_at INTEGER);
  `)
  db.close()
  const missingOpenCodeDB = join(root, "opencode.db")
  const dependencies: ReloadObservationDependencies = {
    observeSessions: async () => ({ kind: "observed", sessionIDs: [] }),
    observeVerifications: async () => ({ kind: "observed", processIDs: [] }),
  }
  return { root, databasePath, missingOpenCodeDB, dependencies }
}

function addActiveAttempt(path: string) {
  const db = new Database(path)
  db.run("INSERT INTO runner_plans VALUES('p','running',NULL)")
  db.run("INSERT INTO runner_attempts VALUES('attempt-1','p','running','ses-worker')")
  db.close()
}

test("reload-safe prints idle stale attempt identifiers and returns success", async () => {
  const f = fixture()
  try {
    addActiveAttempt(f.databasePath)
    const result = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], f.dependencies)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      "0 workers running, 0 verifications running, 0 Architect turns in flight, safe to reload: yes",
    )
    expect(result.stdout).toContain("Stale attempts: attempt-1 (session ses-worker)")
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("reload-safe blocks a busy worker and unavailable host observations", async () => {
  const f = fixture()
  try {
    addActiveAttempt(f.databasePath)
    const busy = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeSessions: async () => ({ kind: "observed", sessionIDs: ["ses-worker"] }),
    })
    expect(busy.exitCode).toBe(1)
    expect(busy.stdout).toContain("1 worker running")
    expect(busy.stdout).not.toContain("Stale attempts:")

    const unavailable = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeSessions: async () => ({ kind: "unavailable", reason: "service offline" }),
    })
    expect(unavailable.exitCode).toBe(1)
    expect(unavailable.stdout).toContain("live activity observation unavailable: service offline")
    expect(unavailable.stdout).not.toContain("Stale attempts:")
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("reload-safe verifies process identity, then observes a verification live and after exit", async () => {
  const f = fixture()
  const workspace = join(f.root, "workspace")
  mkdirSync(workspace)
  const releaseFile = join(f.root, "release-check")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const command = `while [ ! -f ${quote(releaseFile)} ]; do sleep 0.05; done`
  const startedAt = Date.now()
  const db = new Database(f.databasePath)
  db.run("INSERT INTO runner_effects VALUES('verify-live','verify:tests','intended',?,NULL)", [
    JSON.stringify({ check: { command }, workspace }),
  ])
  db.run("INSERT INTO runner_transitions VALUES('EFFECT_INTENDED',?,?)", [
    JSON.stringify({ effectID: "verify-live" }),
    startedAt,
  ])
  db.close()
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    cwd: workspace,
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    const recordProcessIdentity = (processStartedAt: number) => {
      const receiptDB = new Database(f.databasePath)
      receiptDB.run("UPDATE runner_effects SET receipt=? WHERE id='verify-live'", [
        JSON.stringify({
          check: {
            startedAt: processStartedAt,
            processCleanup: { rootPID: child.pid },
          },
        }),
      ])
      receiptDB.close()
    }
    recordProcessIdentity(startedAt - 60_000)
    const reusedPID = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeVerificationProcesses,
    })
    expect(reusedPID.exitCode).toBe(0)
    expect(reusedPID.stdout).toContain("0 verifications running")

    recordProcessIdentity(startedAt)
    const live = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeVerificationProcesses,
    })
    expect(live.exitCode).toBe(1)
    expect(live.stdout).toContain("1 verification running")

    writeFileSync(releaseFile, "finish")
    await child.exited

    const exited = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeVerificationProcesses,
    })
    expect(exited.exitCode).toBe(0)
    expect(exited.stdout).toContain("0 verifications running")
  } finally {
    if (child.exitCode === null) {
      writeFileSync(releaseFile, "finish")
      await child.exited
    }
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("reload-safe reports failed process observation rather than assuming idle", async () => {
  const f = fixture()
  try {
    const result = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: async () => ({
        kind: "unavailable",
        reason: "process listing failed",
      }),
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("live activity observation unavailable: process listing failed")
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
