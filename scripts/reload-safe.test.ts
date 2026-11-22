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
import { RELOAD_READ_PAGE_SIZE } from "../src/runner/reload-pages.ts"
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

test("reload-safe pages all stale attempts instead of refusing a large inventory", async () => {
  const f = fixture()
  try {
    const db = new Database(f.databasePath)
    db.run("INSERT INTO runner_plans VALUES('p','running',NULL)")
    const insert = db.query("INSERT INTO runner_attempts VALUES(?,?,?,?)")
    const count = RELOAD_READ_PAGE_SIZE * 4 + 1
    for (let i = 0; i < count; i++)
      insert.run(
        `attempt-${String(i).padStart(4, "0")}`,
        "p",
        "running",
        `session-${String(i).padStart(4, "0")}`,
      )
    db.close()

    const result = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], f.dependencies)
    const staleLine = result.stdout.split("\n").find((line) => line.startsWith("Stale attempts:"))
    expect(result.exitCode).toBe(0)
    expect(staleLine).toContain(`attempt-${String(count - 1).padStart(4, "0")}`)
    expect(staleLine?.match(/attempt-\d+/g)).toHaveLength(count)
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

test("reload-safe blocks host-active sessions outside active runner records", async () => {
  const f = fixture()
  try {
    for (const sessionID of ["ses_native_child", "ses_architect_without_plan"]) {
      const result = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
        ...f.dependencies,
        observeSessions: async () => ({ kind: "observed", sessionIDs: [sessionID] }),
      })
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain("1 other host session active")
      expect(result.stdout).toContain("safe to reload: no")
    }

    const db = new Database(f.databasePath)
    db.run("INSERT INTO runner_plans VALUES('cancelled','cancelled',NULL)")
    db.run(
      "INSERT INTO runner_attempts VALUES('cancelled-worker','cancelled','running','ses-cancelled')",
    )
    db.close()
    const cancelledWorker = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeSessions: async () => ({ kind: "observed", sessionIDs: ["ses-cancelled"] }),
    })
    expect(cancelledWorker.exitCode).toBe(1)
    expect(cancelledWorker.stdout).toContain("1 other host session active")
    expect(cancelledWorker.stdout).toContain("safe to reload: no")
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

test("reload-safe blocks surviving groups from completed checks after their parents terminate", async () => {
  const f = fixture()
  const workspace = join(f.root, "workspace")
  mkdirSync(workspace)
  const startedAt = Date.now() - 1_000
  const checkJSON = JSON.stringify({ id: "quality", command: "bun run check" })
  const receipt = (rootPID: number) =>
    JSON.stringify({
      id: "quality",
      command: "bun run check",
      cwd: workspace,
      startedAt,
      endedAt: startedAt + 500,
      processCleanup: { state: "uncertain", capability: "process-group", rootPID },
    })
  const db = new Database(f.databasePath)
  db.exec(`
    CREATE TABLE runner_retained_verifications(id TEXT, state TEXT);
    CREATE TABLE runner_retained_verification_checks(
      operation_id TEXT, phase TEXT, check_id TEXT, check_json TEXT, workspace TEXT,
      created_at INTEGER, receipt_path TEXT, receipt TEXT, state TEXT
    );
    CREATE TABLE runner_adoption_checks(
      adoption_id TEXT, phase TEXT, check_id TEXT, check_json TEXT, workspace TEXT,
      created_at INTEGER, receipt_path TEXT, receipt TEXT, state TEXT
    );
  `)
  db.run("INSERT INTO runner_retained_verifications VALUES('retained','failed')")
  db.run(
    `INSERT INTO runner_retained_verification_checks
     VALUES('retained','task','quality',?,?,?, ?,?,'completed')`,
    [checkJSON, workspace, startedAt, join(f.root, "retained-receipt.json"), receipt(7654)],
  )
  db.run(
    `INSERT INTO runner_adoption_checks
     VALUES('adoption','task','quality',?,?,?, ?,?,'completed')`,
    [checkJSON, workspace, startedAt, join(f.root, "adoption-receipt.json"), receipt(8764)],
  )
  db.close()
  const observeProcesses = (stdout: string) => (readonlyDB: Database) =>
    observeVerificationProcesses(readonlyDB, {
      now: () => Date.now(),
      list: () => ({ status: 0, stdout }),
      cwd: (pid) => ({
        status: 0,
        stdout: `p${pid}\nfcwd\nn${workspace}\n`,
      }),
    })
  try {
    const live = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeProcesses(
        "7655 7654 7654 00:01 /bin/sleep 30\n8765 8764 8764 00:01 /bin/sleep 30\n",
      ),
    })
    expect(live.exitCode).toBe(1)
    expect(live.stdout).toContain("2 verifications running")
    expect(live.stdout).toContain("safe to reload: no")

    const exited = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeProcesses(""),
    })
    expect(exited.exitCode).toBe(0)
    expect(exited.stdout).toContain("0 verifications running")
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("reload-safe lists terminal unknown checks as stale and still blocks a live check beyond page one", async () => {
  const f = fixture()
  const workspace = join(f.root, "workspace")
  mkdirSync(workspace)
  const startedAt = Date.now() - 1_000
  const count = RELOAD_READ_PAGE_SIZE * 4 + 1
  const checkID = (index: number) => `quality-${String(index).padStart(4, "0")}`
  const command = (index: number) => `printf reload-check-${String(index).padStart(4, "0")}`
  const terminalCheck = (index: number) => {
    const id = checkID(index)
    return JSON.stringify({ id, command: command(index) })
  }
  const liveReceipt = (index: number) =>
    JSON.stringify({
      id: checkID(index),
      command: command(index),
      cwd: workspace,
      startedAt,
      endedAt: startedAt + 1,
      processCleanup: { state: "uncertain", capability: "process-group", rootPID: 7654 },
    })

  const db = new Database(f.databasePath)
  db.exec(`
    CREATE TABLE runner_retained_verifications(id TEXT, state TEXT);
    CREATE TABLE runner_retained_verification_checks(
      operation_id TEXT, phase TEXT, check_id TEXT, check_json TEXT, workspace TEXT,
      created_at INTEGER, receipt_path TEXT, receipt TEXT, state TEXT
    );
  `)
  db.run("INSERT INTO runner_retained_verifications VALUES('retained','accepted')")
  const insert = db.query(
    `INSERT INTO runner_retained_verification_checks
     VALUES('retained','task',?,?,?,?,?,?,'completed')`,
  )
  for (let i = 0; i < count; i++) {
    const isLive = i === count - 1
    insert.run(
      checkID(i),
      terminalCheck(i),
      workspace,
      startedAt,
      join(f.root, "missing-receipts", `${checkID(i)}.json`),
      isLive ? liveReceipt(i) : null,
    )
  }
  db.close()

  const observeProcesses = (stdout: string) => (readonlyDB: Database) =>
    observeVerificationProcesses(readonlyDB, {
      now: () => Date.now(),
      list: () => ({ status: 0, stdout }),
      cwd: (pid) => ({
        status: 0,
        stdout: `p${pid}\nfcwd\nn${workspace}\n`,
      }),
    })
  try {
    const idle = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeProcesses(""),
    })
    expect(idle.exitCode).toBe(0)
    expect(idle.stdout).toContain(`Stale verification checks: retained:retained/task/${checkID(0)}`)
    expect(idle.stdout).toContain(`retained:retained/task/${checkID(count - 1)}`)

    const live = await runReloadSafe([f.databasePath, f.missingOpenCodeDB], {
      ...f.dependencies,
      observeVerifications: observeProcesses(`7655 7654 7654 00:01 /bin/sleep 30\n`),
    })
    expect(live.exitCode).toBe(1)
    expect(live.stdout).toContain("1 verification running")
    expect(live.stdout).toContain(`Stale verification checks: retained:retained/task/${checkID(0)}`)
    expect(live.stdout).not.toContain(`retained:retained/task/${checkID(count - 1)}`)

    const unchanged = new Database(f.databasePath, { readonly: true })
    expect(
      unchanged
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM runner_retained_verification_checks WHERE state='completed'",
        )
        .get()?.n,
    ).toBe(count)
    unchanged.close()
  } finally {
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
