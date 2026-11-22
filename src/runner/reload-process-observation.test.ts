import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { observeVerificationProcesses } from "./reload-process-observation.ts"
import { verificationProcessCandidates } from "./reload-verification-candidates.ts"
import { RELOAD_READ_PAGE_SIZE } from "./reload-pages.ts"

function database() {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE runner_effects(
      id TEXT, plan_id TEXT, kind TEXT, state TEXT, payload TEXT, receipt TEXT
    );
    CREATE TABLE runner_transitions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
  return db
}

function addEffect(
  db: Database,
  input: { id: string; command: string; workspace: string; receipt?: unknown; startedAt?: number },
) {
  const startedAt = input.startedAt ?? Date.now()
  db.run("INSERT INTO runner_effects VALUES(?, 'p', 'verify:tests', 'uncertain', ?, ?)", [
    input.id,
    JSON.stringify({
      check: { id: "quality", command: input.command },
      workspace: input.workspace,
    }),
    input.receipt === undefined ? null : JSON.stringify(input.receipt),
  ])
  db.run("INSERT INTO runner_transitions(event,payload,created_at) VALUES('EFFECT_INTENDED',?,?)", [
    JSON.stringify({ effectID: input.id }),
    startedAt,
  ])
}

test("effect candidates are read across bounded keyset pages", () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-candidate-query-"))
  try {
    const count = RELOAD_READ_PAGE_SIZE * 4 + 1
    const startedAt = Date.now()
    for (let i = 0; i < count; i++)
      addEffect(db, {
        id: `verify-${String(i).padStart(4, "0")}`,
        command: "bun check",
        workspace,
        startedAt,
      })

    const candidates = verificationProcessCandidates(db)
    expect(candidates).toHaveLength(count)
    expect(candidates[0]?.key).toBe("verify-0000")
    expect(candidates.at(-1)?.key).toBe(`verify-${String(count - 1).padStart(4, "0")}`)
    expect(candidates.every((candidate) => candidate.startedAt === startedAt)).toBe(true)
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("required intent evidence is paged past newer history and still detects live work", async () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-old-intent-"))
  try {
    const startedAt = Date.now() - 1_000
    addEffect(db, { id: "old", command: "printf reload", workspace, startedAt })
    for (let i = 0; i < RELOAD_READ_PAGE_SIZE * 20 + 1; i++)
      db.run(
        "INSERT INTO runner_transitions(event,payload,created_at) VALUES('EFFECT_INTENDED',?,?)",
        [JSON.stringify({ effectID: `unrelated-${i}` }), startedAt + i],
      )
    const candidates = verificationProcessCandidates(db)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.startedAt).toBe(startedAt)
    const observed = await observeVerificationProcesses(db, {
      now: () => Date.now(),
      list: () => ({ status: 0, stdout: "7654 1 7654 00:01 printf reload\n" }),
      cwd: (pid) => ({ status: 0, stdout: `p${pid}\nfcwd\nn${workspace}\n` }),
    })
    expect(observed).toEqual({ kind: "observed", processIDs: [7654] })
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("retained and adoption checks page through tied timestamps without skipping identities", () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-check-pages-"))
  try {
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
    const startedAt = Date.now()
    const count = RELOAD_READ_PAGE_SIZE * 4 + 1
    const check = (id: string) => JSON.stringify({ id, command: "bun check" })
    const retained = db.query(
      `INSERT INTO runner_retained_verification_checks
       VALUES(?,?,?, ?,?,?,?,NULL,'completed')`,
    )
    const adoption = db.query(
      `INSERT INTO runner_adoption_checks
       VALUES(?,?,?, ?,?,?,?,NULL,'completed')`,
    )
    db.run("INSERT INTO runner_retained_verifications VALUES('retained','accepted')")
    for (let i = 0; i < count; i++) {
      const id = `quality-${String(i).padStart(4, "0")}`
      const receiptPath = join(workspace, `${id}.json`)
      retained.run("retained", "task", id, check(id), workspace, startedAt, receiptPath)
      adoption.run("adoption", "task", id, check(id), workspace, startedAt, receiptPath)
    }

    const candidates = verificationProcessCandidates(db)
    expect(candidates).toHaveLength(count * 2)
    expect(candidates.map((candidate) => candidate.key)).toContain(
      `retained:retained/task/quality-${String(count - 1).padStart(4, "0")}`,
    )
    expect(candidates.map((candidate) => candidate.key)).toContain(
      `adoption:adoption/task/quality-${String(count - 1).padStart(4, "0")}`,
    )
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("a surviving child in an observed verification process group blocks reload", async () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-child-group-"))
  try {
    const startedAt = Date.now() - 1_000
    addEffect(db, {
      id: "child-group",
      command: "bun run check",
      workspace,
      startedAt,
      receipt: {
        check: {
          id: "quality",
          command: "bun run check",
          cwd: workspace,
          startedAt,
          endedAt: startedAt + 500,
          processCleanup: {
            state: "uncertain",
            capability: "process-group",
            rootPID: 7654,
          },
        },
      },
    })
    const observation = await observeVerificationProcesses(db, {
      now: () => Date.now(),
      list: () => ({
        status: 0,
        stdout: "7655 7654 7654 00:01 /bin/sleep 30\n",
      }),
      cwd: (pid) => ({
        status: 0,
        stdout: `p${pid}\nfcwd\nn${workspace}\n`,
      }),
    })
    expect(observation).toEqual({ kind: "observed", processIDs: [7654] })
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("an uncertain direct-child PID is not mistaken for an empty process group", async () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-direct-child-"))
  try {
    const startedAt = Date.now() - 1_000
    addEffect(db, {
      id: "direct-child",
      command: "bun run check",
      workspace,
      startedAt,
      receipt: {
        check: {
          id: "quality",
          command: "bun run check",
          cwd: workspace,
          startedAt,
          endedAt: startedAt + 500,
          processCleanup: {
            state: "uncertain",
            capability: "direct-child",
            rootPID: 7654,
          },
        },
      },
    })
    const observation = await observeVerificationProcesses(db, {
      list: () => ({ status: 0, stdout: "" }),
      cwd: () => ({ status: 0, stdout: "" }),
    })
    expect(observation.kind).toBe("unavailable")
    if (observation.kind === "unavailable") expect(observation.reason).toContain("direct-child")
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("retained and adoption checks without process or settlement evidence stay unknown", async () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-aux-checks-"))
  try {
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
    const now = Date.now()
    const checkJSON = JSON.stringify({ id: "quality", command: "bun run check" })
    const missingReceipt = join(workspace, "not-written.json")
    db.run("INSERT INTO runner_retained_verifications VALUES('retained','pending')")
    db.run(
      `INSERT INTO runner_retained_verification_checks
       VALUES('retained','task','quality',?,?,?, ?,NULL,'intended')`,
      [checkJSON, workspace, now, missingReceipt],
    )
    db.run(
      "INSERT INTO runner_adoption_checks VALUES('adoption','task','quality',?,?,?, ?,NULL,'uncertain')",
      [checkJSON, workspace, now, missingReceipt],
    )
    const observation = await observeVerificationProcesses(db, {
      list: () => ({ status: 0, stdout: "" }),
      cwd: () => ({ status: 0, stdout: "" }),
    })
    expect(observation.kind).toBe("unavailable")
    if (observation.kind === "unavailable") {
      expect(observation.reason).toContain("retained:retained/task/quality")
      expect(observation.reason).toContain("adoption:adoption/task/quality")
    }
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("completed checks under terminal operations keep unsettled subprocess groups observable", async () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-terminal-checks-"))
  try {
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
    const startedAt = Date.now() - 1_000
    const checkJSON = JSON.stringify({ id: "quality", command: "bun run check" })
    const receiptFor = (rootPID: number) =>
      JSON.stringify({
        id: "quality",
        command: "bun run check",
        cwd: workspace,
        startedAt,
        endedAt: startedAt + 500,
        processCleanup: { state: "uncertain", capability: "process-group", rootPID },
      })
    db.run("INSERT INTO runner_retained_verifications VALUES('retained','failed')")
    db.run(
      `INSERT INTO runner_retained_verification_checks
       VALUES('retained','task','quality',?,?,?, ?,?,'completed')`,
      [checkJSON, workspace, startedAt, join(workspace, "retained-receipt.json"), receiptFor(7654)],
    )
    db.run(
      `INSERT INTO runner_adoption_checks
       VALUES('adoption','task','quality',?,?,?, ?,?,'completed')`,
      [checkJSON, workspace, startedAt, join(workspace, "adoption-receipt.json"), receiptFor(8764)],
    )

    const live = await observeVerificationProcesses(db, {
      now: () => Date.now(),
      list: () => ({
        status: 0,
        stdout: "7655 7654 7654 00:01 /bin/sleep 30\n8765 8764 8764 00:01 /bin/sleep 30\n",
      }),
      cwd: (pid) => ({
        status: 0,
        stdout: `p${pid}\nfcwd\nn${workspace}\n`,
      }),
    })
    expect(live).toEqual({ kind: "observed", processIDs: [7654, 8764] })

    const exited = await observeVerificationProcesses(db, {
      list: () => ({ status: 0, stdout: "" }),
      cwd: () => ({ status: 0, stdout: "" }),
    })
    expect(exited).toEqual({
      kind: "observed",
      processIDs: [],
      staleChecks: ["retained:retained/task/quality"],
    })
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("unknown receipts under terminal retained operations are stale, not observation failures", async () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-terminal-unknown-"))
  try {
    db.exec(`
      CREATE TABLE runner_retained_verifications(id TEXT, state TEXT);
      CREATE TABLE runner_retained_verification_checks(
        operation_id TEXT, phase TEXT, check_id TEXT, check_json TEXT, workspace TEXT,
        created_at INTEGER, receipt_path TEXT, receipt TEXT, state TEXT
      );
    `)
    const startedAt = Date.now()
    const insertOperation = db.query("INSERT INTO runner_retained_verifications VALUES(?,?)")
    const insertCheck = db.query(
      `INSERT INTO runner_retained_verification_checks
       VALUES(?,?,?,?,?,?,?,?,'completed')`,
    )
    const terminal = [
      {
        operationID: "accepted-op",
        state: "accepted",
        checkJSON: JSON.stringify({ id: "quality", command: "bun check" }),
        receipt: null,
      },
      {
        operationID: "cancelled-op",
        state: "cancelled",
        checkJSON: JSON.stringify({ id: "quality", command: "bun check" }),
        receipt: "{ invalid receipt",
      },
      {
        operationID: "failed-op",
        state: "failed",
        checkJSON: "invalid check metadata",
        receipt: null,
      },
    ]
    for (const item of terminal) {
      insertOperation.run(item.operationID, item.state)
      insertCheck.run(
        item.operationID,
        item.operationID,
        "quality",
        item.checkJSON,
        workspace,
        startedAt,
        join(workspace, `${item.operationID}.json`),
        item.receipt,
      )
    }

    const observed = await observeVerificationProcesses(db, {
      list: () => ({ status: 0, stdout: "" }),
      cwd: () => ({ status: 0, stdout: "" }),
    })
    expect(observed).toEqual({
      kind: "observed",
      processIDs: [],
      staleChecks: [
        "retained:accepted-op/accepted-op/quality",
        "retained:cancelled-op/cancelled-op/quality",
        "retained:failed-op/failed-op/quality",
      ],
    })
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("a reused recorded root PID with a different command is not treated as the check", async () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-reused-root-pid-"))
  try {
    const startedAt = Date.now() - 1_000
    addEffect(db, {
      id: "reused-root",
      command: "bun run check",
      workspace,
      startedAt,
      receipt: {
        check: {
          id: "quality",
          command: "bun run check",
          cwd: workspace,
          startedAt,
          endedAt: startedAt + 500,
          processCleanup: {
            state: "uncertain",
            capability: "process-group",
            rootPID: 7654,
          },
        },
      },
    })
    const observation = await observeVerificationProcesses(db, {
      now: () => Date.now(),
      list: () => ({
        status: 0,
        stdout: "7654 1 7654 00:01 /bin/sleep 30\n",
      }),
      cwd: (pid) => ({
        status: 0,
        stdout: `p${pid}\nfcwd\nn${workspace}\n`,
      }),
    })
    expect(observation.kind).toBe("unavailable")
    if (observation.kind === "unavailable") expect(observation.reason).toContain("reused-root")
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("malformed current check metadata fails closed", async () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-malformed-check-"))
  try {
    db.run("INSERT INTO runner_effects VALUES('malformed','p','verify:tests','intended','{}',NULL)")
    db.run(
      "INSERT INTO runner_transitions(event,payload,created_at) VALUES('EFFECT_INTENDED',?,?)",
      [JSON.stringify({ effectID: "malformed" }), Date.now()],
    )
    const observation = await observeVerificationProcesses(db, {
      list: () => ({ status: 0, stdout: "" }),
      cwd: () => ({ status: 0, stdout: "" }),
    })
    expect(observation.kind).toBe("unavailable")
    if (observation.kind === "unavailable")
      expect(observation.reason).toContain("missing check identity metadata")
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})
