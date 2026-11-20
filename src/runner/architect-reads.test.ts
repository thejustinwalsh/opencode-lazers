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

test("a checkpoint and a renewal cover every input, and a renewal reads a count, not the ids", () => {
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
  const begin = meter.of(/runner_architect_(continuity_inputs|inputs)/)
  expect(begin.rows).toBeLessThanOrEqual(2)
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
