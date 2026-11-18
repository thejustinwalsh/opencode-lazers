import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import {
  retireHumanEvidenceGate,
  retireSourceQuarantines,
  retireStaleHolds,
} from "./retire-gates.ts"
import { RunnerStore } from "./store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-retire-gates-"))
  directories.push(directory)
  const projectDirectory = join(directory, "project")
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), projectDirectory)
  repositories.push(repository)
  const store = new RunnerStore(repository)
  const submit = (requestID: string) => {
    const task = repository.insert({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      revision: 1,
      status: "submitted",
      createdAt: new Date().toISOString(),
      provenance: {
        projectID: "project",
        projectDirectory,
        workspaceDirectory: projectDirectory,
        sessionID: "owner",
        startingRevision: { kind: "unborn" },
      },
      proposal: validProposal(),
    })
    return store.submit(
      {
        requestID,
        objective: "Retire the human evidence gate",
        baseCommit: "b".repeat(40),
        draft: true,
        nodes: [{ taskID: task.id, revision: 1 as const }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: task.proposal.verification,
        acceptance: task.proposal.acceptance,
      },
      "owner",
    )
  }
  return { store, submit }
}

function block(store: RunnerStore, planID: string, reason: string) {
  store.atomic((db) =>
    db.query("UPDATE runner_plans SET state='blocked',reason=? WHERE id=?").run(reason, planID),
  )
}

test("a plan blocked solely on human evidence leaves blocked through the plan machine, once", () => {
  const f = fixture()
  const human = f.submit("human-only").planID
  const mixed = f.submit("mixed").planID
  const failing = f.submit("failing-check").planID
  block(f.store, human, "Combined artifact evidence missing: native-visual:human, review:human")
  block(
    f.store,
    mixed,
    "Combined artifact evidence missing: native-visual:human, other:evidence/x.md",
  )
  block(f.store, failing, "Combined artifact verification failed")

  const moves = f.store.atomic((db) => retireHumanEvidenceGate(db))
  expect(moves.map((move) => move.planID)).toEqual([human])
  expect(f.store.plan(human)).toMatchObject({ state: "running", reason: null })
  expect(f.store.plan(mixed)!.state).toBe("blocked")
  expect(f.store.plan(failing)!.state).toBe("blocked")
  expect(f.store.latestTransition(human, null, "PLAN_GATE_RETIRED")).toMatchObject({
    gate: "human-evidence",
  })

  // Idempotent: the second pass finds nothing to move.
  expect(f.store.atomic((db) => retireHumanEvidenceGate(db))).toEqual([])
})

test("retired waiting-human adoption states resume their check phase", () => {
  const f = fixture()
  const planID = f.submit("adoption").planID
  f.store.atomic((db) => {
    db.query(
      `INSERT INTO runner_adoptions(
         id,plan_id,task_id,request_id,owner,plan_version,task_revision,attempt_id,node_state,
         attempt_state,old_artifact,descendant_commit,target_branch,landing_head,candidate_tree,
         input_fingerprint,environment_identity,reason,combined_artifact,state,created_at,updated_at
       ) VALUES('a1',?,?,'r','owner',1,1,'attempt','verifying','verifying','o','d','main','l','t',
         'i','e','reason','c','waiting-human',0,0)`,
    ).run(planID, f.store.nodes(planID)[0]!.task_id)
  })
  f.store.atomic((db) => retireHumanEvidenceGate(db))
  expect(f.store.adoption("a1")?.state).toBe("task-checks")
})

test("a plan blocked by a source quarantine resumes through the plan machine and the table is dropped", () => {
  const f = fixture()
  const quarantined = f.submit("quarantined").planID
  const failing = f.submit("quarantine-unrelated").planID
  block(
    f.store,
    quarantined,
    "The verifying worker's checkout is quarantined. Run verify-retained on its candidate in an isolated checkout.",
  )
  block(f.store, failing, "Combined artifact verification failed")
  f.store.atomic((db) => {
    db.exec("CREATE TABLE runner_source_quarantines(attempt_id TEXT PRIMARY KEY, phase TEXT)")
    db.exec("CREATE INDEX runner_source_quarantines_pending ON runner_source_quarantines(phase)")
  })
  const tableExists = () =>
    f.store.atomic(
      (db) =>
        db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get("runner_source_quarantines") !== null,
    )
  expect(tableExists()).toBe(true)

  const moves = f.store.atomic((db) => retireSourceQuarantines(db))
  expect(moves.map((move) => move.planID)).toEqual([quarantined])
  expect(f.store.plan(quarantined)).toMatchObject({ state: "running", reason: null })
  expect(f.store.plan(failing)!.state).toBe("blocked")
  expect(f.store.latestTransition(quarantined, null, "PLAN_GATE_RETIRED")).toMatchObject({
    gate: "source-quarantine",
  })
  expect(tableExists()).toBe(false)

  expect(f.store.atomic((db) => retireSourceQuarantines(db))).toEqual([])
  expect(f.store.plan(quarantined)!.state).toBe("running")
  expect(tableExists()).toBe(false)
})

test("plans held by retired reasons move through the plan machine; real failures stay; idempotent", () => {
  const f = fixture()
  const reasons = {
    idle: "Native idle background observation is unknown: No experimental.idle background report was observed",
    lineage: "Native idle background observation does not match the current worker input lineage",
    interrupted:
      "Worker execution was interrupted; explicit reconciliation or cancellation is required",
    scope:
      "Mechanical candidate preparation is blocked by an active scope reservation; no files were changed",
    recovery:
      "Recovery uncertain for verify:content 0123abcd: No conclusive host/artifact receipt; effect was not repeated",
  }
  const stale = Object.entries(reasons).map(([name, reason]) => {
    const planID = f.submit(`stale-${name}`).planID
    block(f.store, planID, reason)
    return planID
  })
  const failing = f.submit("real-failure").planID
  block(f.store, failing, "Combined artifact verification failed")
  const conflict = f.submit("real-conflict").planID
  block(f.store, conflict, "Combined artifact conflict: Conflicting accepted artifacts a and b")
  const cleanup = f.submit("cleanup-idle").planID
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_plans SET state='cleanup-blocked',reason=? WHERE id=?")
      .run(
        "A current confirmed experimental.idle background report is unavailable; preserve the worktree",
        cleanup,
      ),
  )
  // A verification effect that never produced a receipt is superseded so the check re-runs.
  const recoveryPlan = stale[stale.length - 1]!
  f.store.atomic((db) =>
    db
      .query(
        "INSERT INTO runner_effects VALUES('e1',?,NULL,NULL,'verify:content','uncertain','{}',?,1)",
      )
      .run(
        recoveryPlan,
        JSON.stringify({ error: "No conclusive host/artifact receipt; effect was not repeated" }),
      ),
  )

  const moves = f.store.atomic((db) => retireStaleHolds(db))
  expect(moves.map((move) => move.planID).sort()).toEqual([...stale, cleanup].sort())
  for (const planID of stale)
    expect(f.store.plan(planID)).toMatchObject({ state: "running", reason: null })
  expect(f.store.plan(cleanup)!.state).toBe("cleaning")
  expect(f.store.plan(failing)!.state).toBe("blocked")
  expect(f.store.plan(conflict)!.state).toBe("blocked")
  const effect = f.store.effects(recoveryPlan).find((item) => item.id === "e1")!
  expect(effect.state).toBe("failed")
  expect(JSON.parse(effect.receipt!)).toMatchObject({ superseded: true })

  expect(f.store.atomic((db) => retireStaleHolds(db))).toEqual([])
})
