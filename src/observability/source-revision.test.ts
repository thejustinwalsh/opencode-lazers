import { expect, test } from "bun:test"
import { makeFixture, firstAttemptID, taskID } from "../../test/trajectory/fixture.ts"
import { observationRevisionStamp } from "../core/stamp-gate.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { ensureObservationRevision } from "./source-revision.ts"

/** The project's observation revision, the stamp the decision worker's keep-warm gate reads. */
const revisionOf = (fixture: ReturnType<typeof makeFixture>) =>
  fixture.repository.read((db) => observationRevisionStamp(db, fixture.directory))

test("observation invalidation is transactional, project scoped, and ignores unchanged writes", () => {
  const fixture = makeFixture()
  const stamp = () => revisionOf(fixture)
  try {
    const initial = stamp()
    fixture.store.atomic((db) => db.exec("UPDATE runner_plans SET state=state"))
    expect(stamp()).toBe(initial)
    expect(() =>
      fixture.store.atomic((db) => {
        db.query("UPDATE runner_plans SET reason='rolled back' WHERE id=?").run(
          fixture.receipt.planID,
        )
        throw new Error("rollback")
      }),
    ).toThrow("rollback")
    expect(stamp()).toBe(initial)
    fixture.store.atomic((db) =>
      db
        .query("INSERT INTO task_changes(project_directory,kind) VALUES(?,?)")
        .run("/unrelated", "mutation"),
    )
    expect(stamp()).toBe(initial)
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_plans SET reason='changed' WHERE id=?").run(fixture.receipt.planID),
    )
    const updated = stamp()
    expect(updated).not.toBe(initial)
    fixture.store.atomic((db) => {
      db.query(
        "INSERT INTO runner_continuations(plan_id,session_id,directory,generation) VALUES(?,?,?,1)",
      ).run(fixture.receipt.planID, "ses-continuation", fixture.directory)
    })
    const inserted = stamp()
    expect(inserted).not.toBe(updated)
    fixture.store.atomic((db) =>
      db.query("DELETE FROM runner_continuations WHERE plan_id=?").run(fixture.receipt.planID),
    )
    expect(stamp()).not.toBe(inserted)
    const deleted = stamp()
    fixture.store.atomic(ensureObservationRevision)
    expect(stamp()).toBe(deleted)
  } finally {
    fixture.close()
  }
})

test("progress, continuation and outbox inserts and updates move the observation revision", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const stepStart = {
      id: "evt-revision-step-start",
      type: "session.step.started",
      created: 10_000,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg-revision",
        agent: "lazers-implementor",
        model: { providerID: "openai", id: "gpt-6-luna" },
        started: 9_999,
      },
    }
    let revision = revisionOf(fixture)
    const assertChanged = () => {
      const next = revisionOf(fixture)
      expect(next).not.toBe(revision)
      revision = next
    }

    recorder.recordNativeEvent(stepStart)
    assertChanged()
    recorder.recordNativeEvent(stepStart)
    expect(revisionOf(fixture)).toBe(revision)
    recorder.recordNativeEvent({
      id: "evt-revision-step-end",
      type: "session.step.ended",
      created: 10_100,
      data: { sessionID: "ses-failed", assistantMessageID: "msg-revision" },
    })
    assertChanged()

    fixture.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_continuations(plan_id,session_id,parent_id,directory,model,generation)
         VALUES(?,?,?,?,?,?)`,
        )
        .run(
          fixture.receipt.planID,
          "ses-continuation",
          "ses-owner",
          fixture.directory,
          JSON.stringify({ providerID: "openai", id: "gpt-6-luna" }),
          1,
        ),
    )
    assertChanged()
    fixture.store.atomic((db) =>
      db
        .query("UPDATE runner_continuations SET generation=generation+1 WHERE plan_id=?")
        .run(fixture.receipt.planID),
    )
    assertChanged()

    fixture.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_outbox
         (id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt)
         VALUES(?,?,?,?,?,'pending',0,NULL,NULL)`,
        )
        .run(
          "outbox-revision",
          fixture.receipt.planID,
          "ses-owner",
          "msg-outbox-revision",
          "private payload",
        ),
    )
    assertChanged()
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_outbox SET state='admitted' WHERE id=?").run("outbox-revision"),
    )
    assertChanged()
  } finally {
    fixture.close()
  }
})

test("runner tool-count changes move the revision even when the repository watermark is unchanged", () => {
  const fixture = makeFixture()
  try {
    const repositoryVersion = fixture.repository.version()
    const revision = revisionOf(fixture)
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE id=?").run(firstAttemptID)
    })
    expect(fixture.repository.version()).toBe(repositoryVersion)
    expect(revisionOf(fixture)).not.toBe(revision)
  } finally {
    fixture.close()
  }
})

test("adoption and adoption-check changes move the observation revision", () => {
  const fixture = makeFixture()
  try {
    let revision = revisionOf(fixture)
    fixture.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_adoptions(
            id,plan_id,task_id,request_id,owner,plan_version,task_revision,attempt_id,
            node_state,attempt_state,old_artifact,descendant_commit,target_branch,landing_head,
            reviewed_baseline,candidate_tree,input_fingerprint,environment_identity,reason,
            combined_artifact,state,created_at,updated_at
          ) VALUES(?,?,?,?,?,1,1,?,'accepted','accepted','old','descendant','main','landing',
            'baseline','tree','input','environment','reason','combined','accepted',1,1)`,
        )
        .run(
          "revision-adoption",
          fixture.receipt.planID,
          taskID,
          "request",
          "ses-owner",
          firstAttemptID,
        ),
    )
    expect(revisionOf(fixture)).not.toBe(revision)
    revision = revisionOf(fixture)
    fixture.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_adoption_checks(
            adoption_id,phase,check_id,check_json,workspace,artifact,input_fingerprint,
            environment_identity,receipt_path,state,receipt,created_at
          ) VALUES(?,'task','check','{}','/worktree','artifact','input','environment',
            '/receipt','completed','{"exitCode":0}',1)`,
        )
        .run("revision-adoption"),
    )
    expect(revisionOf(fixture)).not.toBe(revision)
    revision = revisionOf(fixture)
    fixture.store.atomic((db) =>
      db
        .query(
          "UPDATE runner_adoption_checks SET receipt=? WHERE adoption_id=? AND phase='task' AND check_id='check'",
        )
        .run('{"exitCode":1}', "revision-adoption"),
    )
    expect(revisionOf(fixture)).not.toBe(revision)
  } finally {
    fixture.close()
  }
})
