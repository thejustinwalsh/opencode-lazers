import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { ObservationReads } from "./read.ts"
import { ObservationChangeTracker } from "./changes.ts"
import { TopologyOutput } from "./contract.ts"

// History volume must not decide whether the current task graph is available.
test("topology preserves the full current graph above the snapshot history ceiling without reading history payloads", () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(9)
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret)
  const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  try {
    tracker.initialize()
    const original = reads.snapshot(scope, tracker)
    fixture.store.atomic((db) => {
      const insert = db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,NULL,1,'HISTORICAL','{}',1)",
      )
      for (let i = 0; i < 10_001; i++) insert.run(original.plans[0]!.id)
    })
    const queries = spyOn(Database.prototype, "query")
    let topology
    try {
      topology = reads.topology(scope, tracker)
      const sql = queries.mock.calls.map(([query]) => query).join("\n")
      expect(sql).not.toMatch(/FROM runner_transitions|FROM runner_effects/i)
      // Attempt identities remain legitimate scope evidence; attempt timelines do not.
      expect(sql).not.toContain("number,state,started_at FROM runner_attempts")
    } finally {
      queries.mockRestore()
    }
    expect(TopologyOutput.safeParse(topology).success).toBe(true)
    expect(topology.plans).toEqual(original.plans)
    expect(topology.unplannedTasks).toEqual(original.unplannedTasks)
    expect(topology).not.toHaveProperty("transitions")
    expect(topology.boundary).not.toHaveProperty("transitionSequence")
    // S8-2: broad history returns a bounded window; topology remains history-free.
    const snapshot = reads.snapshot(scope, tracker)
    expect(snapshot.transitions).toHaveLength(10_000)
    expect(snapshot.coverage?.transitionsTruncated).toBe(true)
  } finally {
    fixture.close()
  }
})

test("topology shares session after-plan closure and excludes foreign project plans", () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(9)
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret)
  const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
  try {
    const baseID = fixture.attempts[0]!.plan_id
    const dependencyID = crypto.randomUUID()
    const foreignID = crypto.randomUUID()
    fixture.store.atomic((db) => {
      const source = db
        .query<{ body: string }, [string]>("SELECT body FROM runner_plans WHERE id=?")
        .get(baseID)!
      const body = JSON.parse(source.body)
      const insert = db.query(
        "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES(?,?,?,1,1,'accepted',?)",
      )
      insert.run(dependencyID, fixture.directory, "ses-other", JSON.stringify(body))
      insert.run(foreignID, "/foreign-project", "ses-failed", JSON.stringify(body))
      db.query("UPDATE runner_plans SET body=? WHERE id=?").run(
        JSON.stringify({ ...body, afterPlans: [dependencyID, foreignID] }),
        baseID,
      )
    })
    tracker.initialize()
    const scope = { kind: "session" as const, sessionID: "ses-failed" }
    const topology = reads.topology(scope, tracker)
    const full = reads.snapshot(scope, tracker)
    expect(topology.plans).toEqual(full.plans)
    expect(topology.plans.map((plan) => plan.id)).toEqual([baseID, dependencyID])
    expect(topology.plans[0]!.afterPlans).toEqual([dependencyID])
    expect(reads.topology({ kind: "session", sessionID: "ses-unrelated" }, tracker).plans).toEqual(
      [],
    )
    expect(
      reads
        .topology({ kind: "project", sessionID: "ses-owner" }, tracker)
        .plans.map((plan) => plan.id),
    ).toEqual([baseID, dependencyID])
  } finally {
    fixture.close()
  }
})
