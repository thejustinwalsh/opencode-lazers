import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { observeVerificationProcesses } from "./reload-process-observation.ts"
import {
  MAX_OPEN_VERIFICATION_CANDIDATES,
  MAX_RECENT_TRANSITION_ROWS,
  RECENT_EFFECT_INTENTS_SQL,
  verificationProcessCandidates,
} from "./reload-verification-candidates.ts"

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

test("effect start lookup reads one bounded primary-key tail, not correlated JSON history", () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-candidate-query-"))
  try {
    db.run(
      "INSERT INTO runner_transitions(event,payload,created_at) VALUES('EFFECT_INTENDED',?,1)",
      [JSON.stringify({ effectID: "verify-bounded" })],
    )
    for (let i = 0; i < MAX_RECENT_TRANSITION_ROWS + 10; i++)
      db.run("INSERT INTO runner_transitions(event,payload,created_at) VALUES('OTHER','{}',?)", [
        i + 2,
      ])
    const recentStartedAt = Date.now()
    db.run(
      "INSERT INTO runner_transitions(event,payload,created_at) VALUES('EFFECT_INTENDED',?,?)",
      [JSON.stringify({ effectID: "verify-recent" }), recentStartedAt],
    )
    db.run(
      "INSERT INTO runner_effects VALUES('verify-recent','p','verify:tests','intended',?,NULL)",
      [
        JSON.stringify({
          check: { id: "quality", command: "bun check" },
          workspace,
        }),
      ],
    )
    const candidates = verificationProcessCandidates(db)
    expect(candidates.map((candidate) => candidate.key)).toEqual(["verify-recent"])
    expect(candidates[0]?.startedAt).toBe(recentStartedAt)
    expect(RECENT_EFFECT_INTENTS_SQL).toContain(
      `ORDER BY id DESC LIMIT ${MAX_RECENT_TRANSITION_ROWS}`,
    )
    expect(RECENT_EFFECT_INTENTS_SQL).not.toMatch(/MIN\s*\(|json_extract/i)
    const plan = db
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${RECENT_EFFECT_INTENTS_SQL}`)
      .all()
    expect(plan.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE")
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("an intent outside the bounded evidence tail is unknown, not assumed idle", () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-old-intent-"))
  try {
    addEffect(db, { id: "old", command: "bun check", workspace, startedAt: 1 })
    for (let i = 0; i < MAX_RECENT_TRANSITION_ROWS + 1; i++)
      db.run("INSERT INTO runner_transitions(event,payload,created_at) VALUES('OTHER','{}',?)", [
        i + 2,
      ])
    expect(() => verificationProcessCandidates(db)).toThrow("missing bounded start-time evidence")
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
    expect(exited).toEqual({ kind: "observed", processIDs: [] })
  } finally {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("terminal check acquisition is bounded and preserves unknown cleanup identity", async () => {
  const db = database()
  const workspace = mkdtempSync(join(tmpdir(), "reload-terminal-bound-"))
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
    const checkJSON = JSON.stringify({ id: "quality", command: "bun run check" })
    db.run("INSERT INTO runner_retained_verifications VALUES('retained','cancelled')")
    const insert = db.query(
      `INSERT INTO runner_retained_verification_checks
       VALUES('retained','task',?,?,?,?,?,?,'completed')`,
    )
    const unsettled = JSON.stringify({
      id: "quality",
      command: "bun run check",
      cwd: workspace,
      startedAt,
      endedAt: startedAt + 1,
      processCleanup: { state: "uncertain", capability: "process-group", rootPID: 7654 },
    })
    for (let i = 0; i < MAX_OPEN_VERIFICATION_CANDIDATES + 1; i++)
      insert.run(
        `quality-${i}`,
        checkJSON,
        workspace,
        startedAt,
        join(workspace, `receipt-${i}.json`),
        unsettled,
      )
    expect(() => verificationProcessCandidates(db)).toThrow(
      "Too many retained verification checks to inspect",
    )

    db.exec("DELETE FROM runner_retained_verification_checks")
    db.run(
      `INSERT INTO runner_adoption_checks
       VALUES('adoption','task','quality',?,?,?, ?,?,'completed')`,
      [
        checkJSON,
        workspace,
        startedAt,
        join(workspace, "unknown-receipt.json"),
        JSON.stringify({
          id: "quality",
          command: "bun run check",
          cwd: workspace,
          startedAt,
          endedAt: startedAt + 1,
          processCleanup: { state: "uncertain", capability: "direct-child", rootPID: 7654 },
        }),
      ],
    )
    db.run(
      `INSERT INTO runner_adoption_checks
       VALUES('adoption-phase','task','quality',?,?,?, ?,?,'completed')`,
      [
        checkJSON,
        workspace,
        startedAt,
        join(workspace, "phase-receipt.json"),
        JSON.stringify({
          id: "quality",
          command: "bun run check",
          cwd: workspace,
          startedAt,
          endedAt: startedAt + 1,
          phases: [{ command: "bun run check" }],
        }),
      ],
    )
    const unknown = await observeVerificationProcesses(db, {
      list: () => ({ status: 0, stdout: "" }),
      cwd: () => ({ status: 0, stdout: "" }),
    })
    expect(unknown.kind).toBe("unavailable")
    if (unknown.kind === "unavailable") {
      expect(unknown.reason).toContain("adoption:adoption/task/quality")
      expect(unknown.reason).toContain("adoption:adoption-phase/task/quality")
    }
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
