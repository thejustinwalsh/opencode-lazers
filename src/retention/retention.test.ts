import { afterEach, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { ObservationChangeTracker } from "../observability/changes.ts"
import { ObservationReads } from "../observability/read.ts"
import { AssociationTaskReads } from "../observability/task-reads.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { ModelEvidenceStore } from "../models/source-store.ts"
import { PlanningStore } from "../planning/store.ts"
import { validProposal } from "../../test/proposal.ts"
import {
  makeFixture,
  taskID,
  firstAttemptID,
  secondAttemptID,
} from "../../test/trajectory/fixture.ts"
import { ensureTranscriptMetaSchema, writeTranscriptPage } from "../transcript-meta/schema.ts"
import {
  AUDIT_RECEIPTS_KEPT,
  classifyPlans,
  previewRetention,
  retireSlice,
  type SliceResult,
} from "./retention.ts"

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 19)
const fixtures: Array<ReturnType<typeof makeFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

function setup() {
  const fixture = makeFixture()
  fixtures.push(fixture)
  // Installs the progress, tool-call and recovery-fact tables the recorder owns.
  new ProgressRecorder(fixture.store, "project")
  const { directory, receipt, store } = fixture
  store.atomic((db) => {
    db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(receipt.planID)
    // Old noise, then the events a reader selects by name, then the plan's latest transition.
    const transition = db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
    )
    for (let i = 0; i < 6; i++)
      transition.run(
        receipt.planID,
        null,
        10 + i,
        "OUTCOME_HOST_ADMITTED",
        JSON.stringify({ i }),
        1600 + i,
      )
    transition.run(
      receipt.planID,
      null,
      20,
      "PLAN_ACCEPTED",
      JSON.stringify({ proof: "c".repeat(40) }),
      1700,
    )
    transition.run(
      receipt.planID,
      null,
      21,
      "INTEGRATION_RECORDED",
      JSON.stringify({ commit: "d".repeat(40) }),
      1800,
    )
    transition.run(receipt.planID, null, 22, "OUTCOME_CONSUMED", "{}", 5000)
    const progress = db.query(
      `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,sources_json,kind,event_ids_json,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    let n = 0
    for (const attempt of [firstAttemptID, secondAttemptID])
      for (const kind of ["tool", "step", "native-observation", "verification", "usage-snapshot"])
        for (let i = 0; i < 3; i++)
          progress.run(
            directory,
            "project",
            receipt.planID,
            taskID,
            attempt,
            "ses",
            1000 + n,
            "runtime",
            "[]",
            kind,
            "[]",
            `key-${n++}`,
            JSON.stringify({ status: "completed", text: "x".repeat(300) }),
          )
    const calls = db.query(
      `INSERT INTO native_tool_calls(project_directory,project_id,session_id,identity_kind,invocation_id,plan_id,task_id,attempt_id,first_observed_at,last_observed_at,sources_json,event_ids_json,payload,context_call_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (let i = 0; i < 4; i++)
      calls.run(
        directory,
        "project",
        "ses-failed",
        "native-call",
        `call-${i}`,
        receipt.planID,
        taskID,
        firstAttemptID,
        1000,
        1100,
        "[]",
        "[]",
        "{}",
        "context",
      )
    // An Architect-session call with no plan: retired only by age.
    calls.run(
      directory,
      "project",
      "ses-owner",
      "local-invocation",
      "old",
      null,
      null,
      null,
      1000,
      1100,
      "[]",
      "[]",
      "{}",
      "context",
    )
    calls.run(
      directory,
      "project",
      "ses-owner",
      "local-invocation",
      "new",
      null,
      null,
      null,
      NOW,
      NOW,
      "[]",
      "[]",
      "{}",
      "context",
    )
    const outbox = db.query(
      "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,?,?,?,?,0)",
    )
    outbox.run("o1", receipt.planID, "ses-owner", "m1", "{}", "delivered")
    outbox.run("o2", receipt.planID, "ses-owner", "m2", "{}", "superseded")
  })
  return fixture
}

/** A second plan on its own task, left in `state`. */
function addPlan(fixture: ReturnType<typeof makeFixture>, state: string, activity: number) {
  const id = crypto.randomUUID()
  const proposal = validProposal()
  fixture.repository.insert({
    schemaVersion: 1,
    id,
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-01T00:00:00.000Z",
    provenance: {
      projectID: "project",
      projectDirectory: fixture.directory,
      workspaceDirectory: fixture.directory,
      sessionID: "ses-owner",
      startingRevision: { kind: "git", commit: "a".repeat(40) },
    },
    proposal,
  })
  const receipt = fixture.store.submit(
    {
      requestID: `plan-${id}`,
      objective: "Another plan",
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: id, revision: 1 }],
      dependencies: [],
      integrationOrder: [id],
      verification: proposal.verification,
      acceptance: proposal.acceptance,
    },
    "ses-owner",
  )
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_plans SET state=? WHERE id=?").run(state, receipt.planID)
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,'OUTCOME_HOST_ADMITTED','{}',?)",
    ).run(receipt.planID, null, activity - 1)
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,2,'BLOCKED','{}',?)",
    ).run(receipt.planID, null, activity)
    db.query(
      `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,sources_json,kind,event_ids_json,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      fixture.directory,
      "project",
      receipt.planID,
      id,
      "a-" + id,
      "ses",
      activity,
      "runtime",
      "[]",
      "tool",
      "[]",
      `k-${id}`,
      "{}",
    )
  })
  return { taskID: id, planID: receipt.planID }
}

const count = (db: Database, sql: string, ...bind: string[]) =>
  db.query<{ n: number }, string[]>(sql).get(...bind)!.n

async function purge(fixture: ReturnType<typeof makeFixture>, days: number, now = NOW) {
  const totals: SliceResult["removed"] = {}
  for (let guard = 0; guard < 200; guard++) {
    const slice = await retireSlice(
      (run) => fixture.store.atomic(run),
      (run) => fixture.repository.read(run),
      { now, days, budgetMs: 10_000, batch: 3 },
    )
    for (const [kind, total] of Object.entries(slice.removed)) {
      const entry = (totals[kind] ??= { rows: 0, bytes: 0 })
      entry.rows += total.rows
      entry.bytes += total.bytes
    }
    if (slice.done) return totals
  }
  throw new Error("purge did not finish")
}

const handle = (fixture: ReturnType<typeof makeFixture>) => fixture.repository.read((db) => db)

test("the dry run equals the real run; the plan's proofs, latest transition and kept records survive", async () => {
  const fixture = setup()
  const db = handle(fixture)
  const live = addPlan(fixture, "running", NOW - 1000)
  const tasks = count(db, "SELECT COUNT(*) AS n FROM tasks")
  const liveTransitions = count(
    db,
    "SELECT COUNT(*) AS n FROM runner_transitions WHERE plan_id=?",
    live.planID,
  )
  const preview = await previewRetention(db, { now: NOW, days: 30 })
  const rows = Object.fromEntries(preview.kinds.map((kind) => [kind.id, kind]))
  expect(rows.progress?.rows).toBe(2 * 3 * 3) // tool, step, native-observation of two attempts
  expect(rows["tool-calls"]?.rows).toBe(5)
  expect(rows.transitions?.rows).toBe(6) // the six old noise events; the newest event stays
  expect(rows.notices?.rows).toBe(2)
  expect(rows["recovery-facts"]?.rows).toBeGreaterThan(0)
  expect(preview.plans.retired).toBe(1)

  const removed = await purge(fixture, 30)
  for (const kind of preview.kinds) {
    expect(removed[kind.id]?.rows ?? 0).toBe(kind.rows)
    expect(removed[kind.id]?.bytes ?? 0).toBe(kind.bytes)
  }
  const after = await previewRetention(db, { now: NOW, days: 30 })
  expect(after.rows).toBe(0)

  const plan = fixture.receipt.planID
  expect(count(db, "SELECT COUNT(*) AS n FROM tasks")).toBe(tasks)
  expect(
    count(
      db,
      "SELECT COUNT(*) AS n FROM runner_transitions WHERE plan_id=? AND event IN ('PLAN_ACCEPTED','INTEGRATION_RECORDED','ACCEPT','RETRY_REQUESTED')",
      plan,
    ),
  ).toBe(4)
  expect(
    count(
      db,
      "SELECT COUNT(*) AS n FROM runner_transitions WHERE plan_id=? AND event='OUTCOME_CONSUMED'",
      plan,
    ),
  ).toBe(1)
  expect(
    count(
      db,
      "SELECT COUNT(*) AS n FROM runner_progress WHERE plan_id=? AND kind IN ('verification','usage-snapshot')",
      plan,
    ),
  ).toBe(12)
  expect(count(db, "SELECT COUNT(*) AS n FROM runner_progress WHERE plan_id=?", live.planID)).toBe(
    1,
  )
  expect(
    count(db, "SELECT COUNT(*) AS n FROM runner_transitions WHERE plan_id=?", live.planID),
  ).toBe(liveTransitions)
  expect(count(db, "SELECT COUNT(*) AS n FROM native_tool_calls WHERE invocation_id='new'")).toBe(1)
  expect(count(db, "SELECT COUNT(*) AS n FROM runner_effects WHERE plan_id=?", plan)).toBe(3)
  expect(count(db, "SELECT COUNT(*) AS n FROM runner_attempts WHERE plan_id=?", plan)).toBe(2)
})

test("age boundary: activity at the cutoff stays, one millisecond older is retired", () => {
  const fixture = setup()
  const db = handle(fixture)
  const cutoff = NOW - 30 * DAY
  const at = (activity: number) => {
    fixture.store.atomic((write) => {
      write
        .query("DELETE FROM runner_transitions WHERE plan_id=? AND created_at>=1700")
        .run(fixture.receipt.planID)
      write
        .query("UPDATE runner_attempts SET started_at=1 WHERE plan_id=?")
        .run(fixture.receipt.planID)
      write
        .query(
          "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(fixture.receipt.planID, null, 99, "BLOCKED", "{}", activity)
    })
    return classifyPlans(db, NOW, 30).retired.length
  }
  expect(at(cutoff)).toBe(0)
  expect(at(cutoff - 1)).toBe(1)
})

test("work that is not finished, or still waited on, is never retired", () => {
  const fixture = setup()
  const db = handle(fixture)
  const old = 1000
  const states = ["running", "blocked", "accepted", "cleanup-blocked", "cancelling"]
  for (const state of states) addPlan(fixture, state, old)
  const finishedPending = addPlan(fixture, "cancelled", old)
  const finishedHeld = addPlan(fixture, "integrated", old)
  const finishedTakeover = addPlan(fixture, "integrated", old)
  const shared = addPlan(fixture, "integrated", old)
  fixture.store.atomic((write) => {
    write
      .query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES('pending',?,'s','mp','{}','pending',0)",
      )
      .run(finishedPending.planID)
    write
      .query(
        "INSERT INTO runner_effects(id,plan_id,kind,state,payload,fence) VALUES('held',?,'worktree-remove','held','{}',1)",
      )
      .run(finishedHeld.planID)
    write
      .query(
        "INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at) VALUES('att',?,?,1,'sx','mx',?,'b','{}','failed',5)",
      )
      .run(finishedTakeover.planID, finishedTakeover.taskID, fixture.directory)
    write
      .query(
        "INSERT INTO runner_takeovers(id,project_directory,plan_id,task_id,attempt_id,architect_session_id,state,payload,created_at,updated_at) VALUES('tk',?,?,?,'att','arch','stopping','{}',1,1)",
      )
      .run(fixture.directory, finishedTakeover.planID, finishedTakeover.taskID)
  })
  // The task of `shared` also belongs to a running plan.
  fixture.store.atomic((write) => {
    const running = addPlan(fixture, "running", old)
    write
      .query("UPDATE runner_nodes SET task_id=?, spec_revision=2 WHERE plan_id=?")
      .run(shared.taskID, running.planID)
  })
  const result = classifyPlans(db, NOW, 30)
  expect(result.retired.map((plan) => plan.id)).toEqual([fixture.receipt.planID])
  const reasons = [...result.kept.keys()].join("\n")
  expect(reasons).toContain("not finished")
  expect(reasons).toContain("notice is still pending")
  expect(reasons).toContain("effect is held")
  expect(reasons).toContain("takeover is open")
  expect(reasons).toContain("not finished")
})

test("notice sizing counts the receipt child rows that go with a delivered notice", async () => {
  const fixture = setup()
  const db = handle(fixture)
  const notices = async () =>
    (await previewRetention(db, { now: NOW, days: 30 })).kinds.find(
      (kind) => kind.id === "notices",
    )!
  const before = await notices()
  const body = JSON.stringify({ kind: "delivered", text: "x".repeat(4000) })
  fixture.store.atomic((write) => {
    for (let seq = 0; seq < 3; seq++)
      write
        .query("INSERT INTO runner_outbox_receipts(outbox_id,seq,kind,body) VALUES('o1',?,?,?)")
        .run(seq, "delivered", body)
  })
  const after = await notices()
  expect(after.rows).toBe(before.rows)
  expect(after.bytes - before.bytes).toBe(3 * (body.length + 56))
  const removed = await purge(fixture, 30)
  expect(removed.notices?.bytes).toBe(after.bytes)
  expect(count(db, "SELECT COUNT(*) AS n FROM runner_outbox_receipts WHERE outbox_id='o1'")).toBe(0)
})

test("progress facts are removed only up to the slowest consumer's cursor", async () => {
  const fixture = setup()
  const db = handle(fixture)
  const total = count(db, "SELECT COUNT(*) AS n FROM recovery_progress_facts")
  expect(total).toBeGreaterThan(20)
  const cursor = count(
    db,
    "SELECT change_id AS n FROM recovery_progress_facts ORDER BY change_id LIMIT 1 OFFSET 10",
  )
  fixture.store.atomic((write) =>
    write
      .query(
        "INSERT INTO recovery_progress_consumers(project_directory,consumer_id,change_id) VALUES(?,?,?)",
      )
      .run(fixture.directory, "detector", cursor),
  )
  const unseen = count(
    db,
    "SELECT COUNT(*) AS n FROM recovery_progress_facts WHERE change_id>?",
    String(cursor),
  )
  await purge(fixture, 30)
  expect(
    count(
      db,
      "SELECT COUNT(*) AS n FROM recovery_progress_facts WHERE change_id>?",
      String(cursor),
    ),
  ).toBe(unseen)
  expect(
    count(
      db,
      "SELECT COUNT(*) AS n FROM recovery_progress_facts WHERE change_id<=? AND plan_id IN (SELECT id FROM runner_plans)",
      String(cursor),
    ),
  ).toBe(0)
  expect(count(db, "SELECT COUNT(*) AS n FROM recovery_progress_facts")).toBeGreaterThan(0)
})

test("an interrupted purge resumes and ends with the same totals; a repeat finds nothing", async () => {
  const fixture = setup()
  const db = handle(fixture)
  const preview = await previewRetention(db, { now: NOW, days: 30 })
  let calls = 0
  const totals: SliceResult["removed"] = {}
  const add = (removed: SliceResult["removed"]) => {
    for (const [kind, total] of Object.entries(removed)) {
      const entry = (totals[kind] ??= { rows: 0, bytes: 0 })
      entry.rows += total.rows
      entry.bytes += total.bytes
    }
  }
  const flaky = <T>(run: (database: Database) => T) => {
    if (++calls === 6) throw new Error("interrupted")
    return fixture.store.atomic(run)
  }
  let failure: unknown
  try {
    await retireSlice(flaky, (run) => fixture.repository.read(run), {
      now: NOW,
      days: 30,
      budgetMs: 10_000,
      batch: 2,
    })
  } catch (error) {
    failure = error
  }
  expect(String(failure)).toContain("interrupted")
  // Batches that committed before the interruption are counted by what is now missing.
  const midway = await previewRetention(db, { now: NOW, days: 30 })
  expect(midway.rows).toBeGreaterThan(0)
  expect(midway.rows).toBeLessThan(preview.rows)
  add(await purge(fixture, 30))
  expect(Object.values(totals).reduce((sum, kind) => sum + kind.rows, 0)).toBe(midway.rows)
  expect((await previewRetention(db, { now: NOW, days: 30 })).rows).toBe(0)
  expect(await purge(fixture, 30)).toEqual({})
})

test("a retired task still opens in Tasks, Radar and the snapshot reads", async () => {
  const fixture = setup()
  const secret = new Uint8Array(32).fill(5)
  const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
  tracker.initialize()
  const sessions = {
    get: async () => null,
    project: async () => ({ sessions: [], truncated: false }),
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret, sessions)
  await purge(fixture, 30)
  const snapshot = reads.snapshot({ kind: "session", sessionID: "ses-failed" }, tracker)
  expect(snapshot.plans[0]?.nodes[0]).toMatchObject({ taskID, state: "accepted" })
  const tasks = new AssociationTaskReads(fixture.repository)
  expect(tasks.get({ taskID: "LZ-1", sessionID: "ses-failed" })).toMatchObject({
    status: "found",
    reference: "LZ-1",
  })
  expect(fixture.repository.list(10, true)).toHaveLength(1)
  tracker.close()
})

test("superseded counters, audit receipts and model snapshots: only what is never read again goes", async () => {
  const fixture = setup()
  const db = handle(fixture)
  const dir = fixture.directory
  const big = "x".repeat(70_000)
  fixture.store.atomic((write) => {
    for (let i = 0; i < AUDIT_RECEIPTS_KEPT + 3; i++)
      write
        .query("INSERT INTO runner_commands VALUES(?,?,?,?)")
        .run(dir, `audit-${i}`, "f", JSON.stringify({ status: "audited", pad: big }))
    write
      .query("INSERT INTO runner_commands VALUES(?,?,?,?)")
      .run(dir, "submit-1", "f", JSON.stringify({ status: "submitted", pad: big }))
  })
  for (let i = 0; i < 50; i++) fixture.repository.changed()
  const version = fixture.repository.version()
  new ModelEvidenceStore(fixture.repository.path, dir)
  fixture.store.atomic((write) => {
    const snapshot = write.query("INSERT INTO model_evidence_snapshots VALUES(?,?,?,?,?,?,?)")
    for (let generation = 1; generation <= 4; generation++)
      snapshot.run(
        `s${generation}`,
        dir,
        "native-catalog",
        generation,
        new Date(NOW - [200, 100, 5, 1][generation - 1]! * DAY).toISOString(),
        1,
        "{}",
      )
    write
      .query(
        "INSERT INTO model_evidence_refreshes(project_directory,source,state,generation,latest_snapshot_id,latest_snapshot_generation) VALUES(?,?,?,?,?,?)",
      )
      .run(dir, "native-catalog", "succeeded", 4, "s4", 4)
  })
  await purge(fixture, 30)
  expect(
    count(db, "SELECT COUNT(*) AS n FROM runner_commands WHERE request_id LIKE 'audit-%'"),
  ).toBe(AUDIT_RECEIPTS_KEPT)
  expect(count(db, "SELECT COUNT(*) AS n FROM runner_commands WHERE request_id='submit-1'")).toBe(1)
  expect(fixture.repository.version()).toBe(version)
  expect(count(db, "SELECT COUNT(*) AS n FROM task_changes WHERE kind='mutation'")).toBe(1)
  // generation 1 and 2 are older than 30 days and superseded; 3 is recent enough; 4 is the latest.
  const left = db
    .query<{ snapshot_id: string }, []>(
      "SELECT snapshot_id FROM model_evidence_snapshots ORDER BY generation",
    )
    .all()
    .map((row) => row.snapshot_id)
  expect(left).toEqual(["s3", "s4"])
})

test("fresh churn events do not make a finished plan look active", () => {
  const fixture = setup()
  const db = handle(fixture)
  fixture.store.atomic((write) =>
    write
      .query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,NULL,?,?,?,?)",
      )
      .run(fixture.receipt.planID, 99, "OUTCOME_OWNER_TRANSFER_UNCERTAIN", "{}", NOW),
  )
  expect(classifyPlans(db, NOW, 30).retired.map((plan) => plan.id)).toEqual([
    fixture.receipt.planID,
  ])
  fixture.store.atomic((write) =>
    write
      .query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,NULL,?,?,?,?)",
      )
      .run(fixture.receipt.planID, 100, "CLEANUP_BLOCKED", "{}", NOW),
  )
  expect(classifyPlans(db, NOW, 30).retired).toEqual([])
})

test("81b1d6ba-1: a plan that stops being finished between batches loses nothing more", async () => {
  const fixture = setup()
  const db = handle(fixture)
  const detail =
    "SELECT COUNT(*) AS n FROM runner_progress WHERE kind IN ('tool','step','native-observation')"
  const before = count(db, detail)
  let calls = 0
  const retried = <T>(run: (database: Database) => T) => {
    const result = fixture.store.atomic(run)
    // After the first batch commits, the plan is retried: it is no longer terminal.
    if (++calls === 1)
      fixture.store.atomic((database) =>
        database
          .query("UPDATE runner_plans SET state='running' WHERE id=?")
          .run(fixture.receipt.planID),
      )
    return result
  }
  await retireSlice(retried, (run) => fixture.repository.read(run), {
    now: NOW,
    days: 30,
    budgetMs: 10_000,
    batch: 3,
  })
  // Only the first batch, taken while the plan was finished, may have gone.
  expect(before - count(db, detail)).toBeLessThanOrEqual(3)
})

function planning(
  fixture: ReturnType<typeof makeFixture>,
  id: string,
  state: string,
  plan: string | null,
  updatedAt: number,
) {
  const store = new PlanningStore(fixture.repository)
  store.createPlanning({
    id,
    projectKey: "proj",
    projectDirectory: fixture.directory,
    sessionId: "s",
    title: id,
    createdAt: 1,
    updatedAt,
  })
  for (let n = 1; n <= 5; n++)
    store.appendRevision(id, undefined, { n }, {}, {}, undefined, updatedAt)
  for (const revision of [2, 4])
    store.createReview({
      id: `${id}-r${revision}`,
      planningId: id,
      revision,
      stage: "review",
      selectionJson: "{}",
      createdAt: 1,
    })
  store.createRun({
    id: `${id}-run`,
    reviewId: `${id}-r2`,
    agent: "critic",
    attempt: 1,
    state: "starting",
    startedAt: 1,
    rawReply: "x".repeat(500),
    inputTokens: 7,
  })
  fixture.store.atomic((db) =>
    db
      .query("UPDATE planning_plannings SET state=?, tasked_plan_id=?, updated_at=? WHERE id=?")
      .run(state, plan, updatedAt, id),
  )
}

const revisions = (db: Database, id: string) =>
  db
    .query<{ revision: number }, [string]>(
      "SELECT revision FROM planning_revisions WHERE planning_id=? ORDER BY revision",
    )
    .all(id)
    .map((row) => row.revision)

test("finished planning detail loses intermediate revisions and raw replies, nothing else", async () => {
  const fixture = setup()
  const db = handle(fixture)
  const old = NOW - 40 * DAY
  planning(fixture, "done", "tasked", fixture.receipt.planID, old)
  planning(fixture, "open", "in-review", null, old)
  const preview = await previewRetention(db, { now: NOW, days: 30 })
  const detail = preview.kinds.find((kind) => kind.id === "planning-detail")!
  // Revision 3 of "done", and the raw reply of its one run.
  expect(detail.rows).toBe(2)
  await purge(fixture, 30)
  expect(revisions(db, "done")).toEqual([1, 2, 4, 5])
  expect(revisions(db, "open")).toEqual([1, 2, 3, 4, 5])
  const run = db
    .query<{ raw_reply: string | null; input_tokens: number }, []>(
      "SELECT raw_reply, input_tokens FROM planning_runs WHERE id='done-run'",
    )
    .get()!
  expect(run).toEqual({ raw_reply: null, input_tokens: 7 })
  expect(db.query("SELECT COUNT(*) AS n FROM planning_reviews").get()).toEqual({ n: 4 })
  const again = await previewRetention(db, { now: NOW, days: 30 })
  expect(again.kinds.find((kind) => kind.id === "planning-detail")!.rows).toBe(0)
})

test("an abandoned plan older than the age is retirable; a recent one is not", async () => {
  const fixture = setup()
  const db = handle(fixture)
  planning(fixture, "dropped", "abandoned", null, NOW - 40 * DAY)
  planning(fixture, "fresh", "abandoned", null, NOW - 2 * DAY)
  await purge(fixture, 30)
  expect(revisions(db, "dropped")).toEqual([1, 2, 4, 5])
  expect(revisions(db, "fresh")).toEqual([1, 2, 3, 4, 5])
})

test("transcript metadata follows the finished-plan age: a retired plan's sessions go, others stay", async () => {
  const fixture = setup()
  ensureTranscriptMetaSchema(fixture.repository)
  const sessions = ["ses-failed", "ses-accepted", "ses-elsewhere"]
  fixture.repository.atomic((db) => {
    for (const session of sessions)
      writeTranscriptPage(
        db,
        fixture.directory,
        session,
        { cursor: null, base: 0, messageCount: 0, state: "not-read" },
        [
          { id: `u-${session}`, type: "user", text: "hello" },
          {
            id: `m-${session}`,
            type: "assistant",
            model: { providerID: "openai", id: "gpt-6-luna" },
            time: { created: 1_000 },
          },
        ],
        undefined,
      )
  })
  const db = handle(fixture)
  const preview = await previewRetention(db, { now: NOW, days: 30 })
  // The retired plan's two attempt sessions: a step row and a session row each.
  expect(preview.kinds.find((kind) => kind.id === "transcript-meta")?.rows).toBe(4)
  const removed = await purge(fixture, 30)
  expect(removed["transcript-meta"]?.rows).toBe(4)
  const left = (table: string) =>
    db.query<{ session_id: string }, []>(`SELECT session_id FROM ${table}`).all()
  expect(left("transcript_steps")).toEqual([{ session_id: "ses-elsewhere" }])
  expect(left("transcript_sessions")).toEqual([{ session_id: "ses-elsewhere" }])
})
