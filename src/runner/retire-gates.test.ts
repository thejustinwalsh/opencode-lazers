import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { retireHumanEvidenceGate } from "./retire-gates.ts"
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
