import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDeclaredCheck } from "../src/runner/artifacts.ts"
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
    CREATE TABLE runner_effects(
      id TEXT,
      plan_id TEXT,
      kind TEXT,
      state TEXT,
      payload TEXT,
      receipt TEXT
    );
    CREATE TABLE runner_transitions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT,
      event TEXT,
      payload TEXT,
      created_at INTEGER
    );
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

test("reload-safe observes a late runDeclaredCheck phase and its process group through the CLI", async () => {
  const f = fixture()
  const workspace = join(f.root, "workspace")
  mkdirSync(workspace)
  const releaseFile = join(f.root, "release-check")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const phaseScript = `while [ ! -f ${quote(releaseFile)} ]; do sleep 0.05; done`
  const command = "bun run first && bun run second"
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({
      scripts: { first: "true", second: `sh -c ${quote(phaseScript)}` },
    }),
  )
  const receiptPath = join(f.root, "receipts", "check.json")
  const startedAt = Date.now() - 30_000
  const db = new Database(f.databasePath)
  db.run(
    `INSERT INTO runner_effects(id,plan_id,kind,state,payload,receipt)
     VALUES('verify-live','p','verify:tests','intended',?,NULL)`,
    [
      JSON.stringify({
        check: {
          id: "quality",
          command,
          inactivityTimeoutMs: 60_000,
          hardTimeoutMs: 120_000,
        },
        verificationDeadline: { effectiveHardTimeoutMs: 120_000 },
        workspace,
        receiptPath,
      }),
    ],
  )
  db.run(
    "INSERT INTO runner_transitions(plan_id,event,payload,created_at) VALUES('p','EFFECT_INTENDED',?,?)",
    [JSON.stringify({ effectID: "verify-live" }), startedAt],
  )
  db.close()
  let execution: ReturnType<typeof runDeclaredCheck> | undefined
  try {
    execution = runDeclaredCheck(
      workspace,
      "artifact",
      {
        id: "quality",
        command,
        inactivityTimeoutMs: 60_000,
        hardTimeoutMs: 120_000,
      },
      receiptPath,
    )
    for (let attempt = 0; attempt < 200 && !existsSync(`${receiptPath}.phase-0.json`); attempt++)
      await Bun.sleep(20)
    expect(existsSync(`${receiptPath}.phase-0.json`)).toBe(true)
    await Bun.sleep(100)

    const live = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeVerificationProcesses,
    })
    expect(live.exitCode).toBe(1)
    expect(live.stdout).toContain("1 verification running")

    writeFileSync(releaseFile, "finish")
    const receipt = await execution
    expect(receipt.phases).toHaveLength(2)
    expect(receipt.phases?.every((phase) => phase.processCleanup?.state === "settled")).toBe(true)

    // The effect label is intentionally left `intended`; the durable execution receipt proves
    // every runDeclaredCheck phase and process group has actually settled.
    const settled = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeVerificationProcesses,
    })
    expect(settled.exitCode).toBe(0)
    expect(settled.stdout).toContain("0 verifications running")
  } finally {
    if (execution && !existsSync(releaseFile)) writeFileSync(releaseFile, "finish")
    await execution?.catch(() => undefined)
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("reload-safe fails closed for synthetic Fallow work until its completion receipt exists", async () => {
  const f = fixture()
  const workspace = join(f.root, "workspace")
  mkdirSync(workspace)
  const receiptPath = join(f.root, "fallow.json")
  const startedAt = Date.now()
  const db = new Database(f.databasePath)
  db.run(
    `INSERT INTO runner_effects(id,plan_id,kind,state,payload,receipt)
     VALUES('fallow','p','verify:fallow-audit','intended',?,NULL)`,
    [
      JSON.stringify({
        check: { id: "fallow-audit", command: "lazers:fallow-audit" },
        workspace,
        receiptPath,
      }),
    ],
  )
  db.run(
    "INSERT INTO runner_transitions(plan_id,event,payload,created_at) VALUES('p','EFFECT_INTENDED',?,?)",
    [JSON.stringify({ effectID: "fallow" }), startedAt],
  )
  db.close()
  try {
    const unknown = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeVerificationProcesses,
    })
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stdout).toContain("live activity observation unavailable")
    expect(unknown.stdout).toContain("fallow")

    writeFileSync(
      receiptPath,
      JSON.stringify({
        id: "fallow-audit",
        command: "lazers:fallow-audit",
        cwd: workspace,
        startedAt,
        endedAt: Date.now(),
        fallow: {},
      }),
    )
    const incomplete = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeVerificationProcesses,
    })
    expect(incomplete.exitCode).toBe(1)
    expect(incomplete.stdout).toContain("live activity observation unavailable")

    writeFileSync(
      receiptPath,
      JSON.stringify({
        id: "fallow-audit",
        command: "lazers:fallow-audit",
        cwd: workspace,
        startedAt,
        endedAt: Date.now(),
        fallow: { status: "unavailable", reason: "test review settled" },
      }),
    )
    const settled = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeVerificationProcesses,
    })
    expect(settled.exitCode).toBe(0)
    expect(settled.stdout).toContain("0 verifications running")
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("reload-safe does not treat a reused PID as the recorded process group", async () => {
  const f = fixture()
  const workspace = join(f.root, "workspace")
  mkdirSync(workspace)
  const command = "bun run verify"
  const oldStartedAt = Date.now() - 2 * 120_000
  const db = new Database(f.databasePath)
  db.run(
    `INSERT INTO runner_effects(id,plan_id,kind,state,payload,receipt)
     VALUES('verify-old','p','verify:tests','uncertain',?,?)`,
    [
      JSON.stringify({
        check: { id: "quality", command, hardTimeoutMs: 120_000 },
        workspace,
        receiptPath: join(f.root, "missing-receipt.json"),
      }),
      JSON.stringify({
        check: {
          id: "quality",
          command,
          cwd: workspace,
          startedAt: oldStartedAt,
          endedAt: oldStartedAt + 1,
          processCleanup: {
            state: "uncertain",
            capability: "process-group",
            rootPID: 7654,
          },
        },
      }),
    ],
  )
  db.run(
    "INSERT INTO runner_transitions(plan_id,event,payload,created_at) VALUES('p','EFFECT_INTENDED',?,?)",
    [JSON.stringify({ effectID: "verify-old" }), oldStartedAt],
  )
  db.close()
  try {
    const result = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: (readOnlyDB) =>
        observeVerificationProcesses(readOnlyDB, {
          now: Date.now,
          list: () => ({
            status: 0,
            stdout: `7654 1 7654 00:00 ${command}\n`,
          }),
          cwd: () => ({
            status: 0,
            stdout: "p7654\nfcwd\nn" + workspace + "\n",
          }),
        }),
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("live activity observation unavailable")
    expect(result.stdout).not.toContain("1 verification running")
  } finally {
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
