import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fingerprint, fingerprintStrings } from "../identity.ts"
import { TaskRepository } from "../storage.ts"
import { meterReads, meterRepository } from "./read-meter.fixture.ts"
import { backfillRenewalCoverage, RunnerStore } from "./store.ts"

/**
 * The Architect-session tables grow with session length. A renewal used to list every covered
 * message id, three times, to compare a count and a fingerprint; it now reads a COUNT, finds the
 * first uncovered input in SQL and keeps the count and fingerprint as columns of the renewal.
 */

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const INPUTS = 3_000
const show = (name: string, before: unknown, after: unknown) => {
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(
      `[architect-reads] ${name} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    )
}

function seeded() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-architect-reads-")))
  const repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  cleanups.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const ids = Array.from({ length: INPUTS }, (_, index) => `msg_${String(index).padStart(5, "0")}`)
  repository.atomic((db) => {
    db.query(
      "INSERT INTO runner_plans VALUES('plan-1',?,'owner',1,1,'blocked',?,NULL,NULL,NULL)",
    ).run(root, JSON.stringify({ priority: 1 }))
    const insert = db.query(
      `INSERT INTO runner_architect_inputs(
        session_id,message_id,observed_at,native_type,delivery,disposition
      ) VALUES('owner',?,?,'user',NULL,'prompt')`,
    )
    ids.forEach((id, index) => insert.run(id, 1_000 + index))
  })
  return { root, repository, store, ids }
}

test("fingerprintStrings equals fingerprint of the same list", () => {
  for (const list of [
    [],
    ["a"],
    ["a", 'b"q', "ü"],
    Array.from({ length: 1_001 }, (_, i) => `m${i}`),
  ])
    expect(fingerprintStrings(list)).toEqual({ count: list.length, fingerprint: fingerprint(list) })
})

test("a checkpoint and a renewal cover every input; a renewal pages the checkpoint ids once and lists no inputs", () => {
  const f = seeded()
  const now = 10_000_000
  const sorted = f.ids.toSorted()

  const saved = f.store.saveArchitectContinuity({
    sessionID: "owner",
    decisions: ["ship"],
    unresolvedQuestions: [],
    coverageInputs: [],
    now,
  })
  expect(saved.revision).toBe(1)
  expect(f.store.hasArchitectContinuity("owner")).toBe(true)
  expect(f.store.hasArchitectContinuity("nobody")).toBe(false)
  expect(f.store.architectContinuityCoverage("owner")).toEqual(sorted)
  const checkpoint = f.repository.read((db) =>
    db
      .query<{ input_count: number; input_fingerprint: string }, []>(
        "SELECT input_count,input_fingerprint FROM runner_architect_continuity_coverage",
      )
      .get(),
  )
  expect(checkpoint).toEqual({ input_count: INPUTS, input_fingerprint: fingerprint(sorted) })

  const fence = f.store.claim("scheduler", now)!
  const meter = meterRepository(f.repository)
  const renewal = f.store.beginArchitectRenewal({
    schedulerOwner: "scheduler",
    fence,
    anchorPlanID: "plan-1",
    previousSessionID: "owner",
    directory: f.root,
    model: "model",
    idleAt: 1_000_000,
    now,
    handoffMessageID: "handoff",
  })!
  meter.stop()
  expect(renewal).toBeTruthy()
  expect(renewal.coverage_count).toBe(INPUTS)
  expect(renewal.coverage_fingerprint).toBe(fingerprint(sorted))
  const copied = f.repository.read((db) =>
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM runner_architect_renewal_coverage WHERE renewal_id=?",
      )
      .get(renewal.id),
  )
  expect(copied?.n).toBe(INPUTS)

  // Before: the continuity ids, then every user input, as arrays, to compare in JavaScript.
  const old = meterReads(f.store)
  f.store.read((db) => {
    db.query("SELECT message_id FROM runner_architect_continuity_inputs ORDER BY message_id").all()
    db.query(
      "SELECT message_id FROM runner_architect_inputs WHERE session_id='owner' AND native_type='user' ORDER BY observed_at,message_id",
    ).all()
  })
  old.stop()
  // The renewal reads the checkpoint's ids once, a page per statement, to verify its fingerprint;
  // the session's inputs are tested in SQL and none is listed.
  const begin = meter.of(/runner_architect_(continuity_inputs|inputs)/)
  expect(meter.of(/message_id>\? ORDER BY message_id LIMIT/).rows).toBe(INPUTS)
  expect(begin.rows).toBeLessThanOrEqual(INPUTS + 1)
  expect(
    meter.statements.filter((sql) => /message_id>\? ORDER BY message_id LIMIT/.test(sql)).length,
  ).toBeGreaterThan(1)
  show("beginArchitectRenewal ids", old.of(/runner_architect/), begin)

  // Evidence: before listed the renewal's ids; now the stored columns answer.
  const evidenceOld = meterReads(f.store)
  f.store.read((db) =>
    db
      .query("SELECT message_id FROM runner_architect_renewal_coverage WHERE renewal_id=?")
      .all(renewal.id),
  )
  evidenceOld.stop()
  const evidence = meterReads(f.store)
  const got = f.store.architectRenewalCoverageEvidence(renewal.id)
  evidence.stop()
  expect(got).toEqual({
    revision: 1,
    inputCount: INPUTS,
    inputFingerprint: fingerprint(sorted),
  })
  expect(evidence.of(/renewal_coverage/).rows).toBe(0)
  show("coverage evidence", evidenceOld.of(/renewal_coverage/), evidence.of(/renewal_coverage/))

  // A renewal written before the columns existed is summarized from its rows, once.
  f.repository.atomic((db) => {
    db.query(
      "UPDATE runner_architect_renewals SET coverage_count=NULL,coverage_fingerprint=NULL",
    ).run()
  })
  expect(f.store.architectRenewalCoverageEvidence(renewal.id)?.inputFingerprint).toBe(
    fingerprint(sorted),
  )
  f.repository.atomic(backfillRenewalCoverage)
  expect(f.store.architectRenewal(renewal.id)).toMatchObject({
    coverage_count: INPUTS,
    coverage_fingerprint: fingerprint(sorted),
  })
})

test("a user input the checkpoint does not cover blocks the renewal", () => {
  const f = seeded()
  const now = 10_000_000
  f.store.saveArchitectContinuity({
    sessionID: "owner",
    decisions: [],
    unresolvedQuestions: [],
    coverageInputs: [],
    now,
  })
  f.repository.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_architect_inputs(
          session_id,message_id,observed_at,native_type,delivery,disposition
        ) VALUES('owner','msg_late',500,'user',NULL,'delivered')`,
      )
      .run(),
  )
  const fence = f.store.claim("scheduler", now)!
  expect(
    f.store.beginArchitectRenewal({
      schedulerOwner: "scheduler",
      fence,
      anchorPlanID: "plan-1",
      previousSessionID: "owner",
      directory: f.root,
      model: "model",
      idleAt: 1_000_000,
      now,
      handoffMessageID: "handoff",
    }),
  ).toBeNull()
})

/**
 * The checkpoint's stored count and fingerprint summarize its rows. When they disagree, the rows
 * are the truth: beginning a renewal rebuilds the summary from them a page at a time, records that
 * it did, and the renewal goes on carrying the rebuilt summary.
 */
function beginRenewal(f: ReturnType<typeof seeded>, now: number) {
  const fence = f.store.claim("scheduler", now)!
  return f.store.beginArchitectRenewal({
    schedulerOwner: "scheduler",
    fence,
    anchorPlanID: "plan-1",
    previousSessionID: "owner",
    directory: f.root,
    model: "model",
    idleAt: 1_000_000,
    now,
    handoffMessageID: "handoff",
  })
}
const storedCheckpoint = (f: ReturnType<typeof seeded>) =>
  f.repository.read((db) =>
    db
      .query<{ input_count: number; input_fingerprint: string }, []>(
        "SELECT input_count,input_fingerprint FROM runner_architect_continuity_coverage",
      )
      .get(),
  )

test("checkpoint ids altered with the same count are detected, repaired and the renewal continues", () => {
  const f = seeded()
  const now = 10_000_000
  f.store.saveArchitectContinuity({
    sessionID: "owner",
    decisions: [],
    unresolvedQuestions: [],
    coverageInputs: [{ id: "ctx_1", type: "user" }],
    now,
  })
  const stale = storedCheckpoint(f)!
  f.repository.atomic((db) =>
    db
      .query(
        "UPDATE runner_architect_continuity_inputs SET message_id='ctx_2' WHERE message_id='ctx_1'",
      )
      .run(),
  )
  const rows = [...f.ids, "ctx_2"].toSorted()
  const renewal = beginRenewal(f, now)
  expect(renewal).toBeTruthy()
  expect(renewal!.coverage_count).toBe(rows.length)
  expect(renewal!.coverage_fingerprint).toBe(fingerprint(rows))
  expect(storedCheckpoint(f)).toEqual({
    input_count: rows.length,
    input_fingerprint: fingerprint(rows),
  })
  expect(
    f.store.latestTransition("plan-1", null, "ARCHITECT_CONTINUITY_COVERAGE_REPAIRED"),
  ).toEqual({
    sessionID: "owner",
    continuityRevision: 1,
    stored: { count: stale.input_count, fingerprint: stale.input_fingerprint },
    rebuilt: { count: rows.length, fingerprint: fingerprint(rows) },
  })
})

test("a checkpoint whose stored count disagrees with its rows is repaired instead of stopping renewal", () => {
  const f = seeded()
  const now = 10_000_000
  f.store.saveArchitectContinuity({
    sessionID: "owner",
    decisions: [],
    unresolvedQuestions: [],
    coverageInputs: [],
    now,
  })
  f.repository.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_architect_continuity_inputs(
          project_directory,session_id,continuity_revision,message_id
        ) VALUES(?,'owner',1,'ctx_extra')`,
      )
      .run(f.root),
  )
  const rows = [...f.ids, "ctx_extra"].toSorted()
  const renewal = beginRenewal(f, now)
  expect(renewal).toBeTruthy()
  expect(renewal!.coverage_count).toBe(rows.length)
  expect(renewal!.coverage_fingerprint).toBe(fingerprint(rows))
  expect(storedCheckpoint(f)?.input_count).toBe(rows.length)
})

test("a checkpoint whose summary matches its rows records no repair", () => {
  const f = seeded()
  const now = 10_000_000
  f.store.saveArchitectContinuity({
    sessionID: "owner",
    decisions: [],
    unresolvedQuestions: [],
    coverageInputs: [],
    now,
  })
  expect(beginRenewal(f, now)).toBeTruthy()
  expect(
    f.store.latestTransition("plan-1", null, "ARCHITECT_CONTINUITY_COVERAGE_REPAIRED"),
  ).toBeUndefined()
})
