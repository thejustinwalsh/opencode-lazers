import { expect, test } from "bun:test"
import { meterRepository } from "./read-meter.fixture.ts"
import { acceptAndIntegratePlan, fixture, useRuntimeFixtureCleanup } from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

/**
 * Idle behaviour (design/data-handling.md, principle 8): a scheduler tick with nothing to do reads
 * no history and asks the host nothing. The store holds one integrated plan; the test measures an
 * idle tick, buries the plan under history, and measures again. The two reads must be the same.
 */

/** Count every call made to the fake host, whatever its name. */
function countHostCalls(host: Record<string, unknown>) {
  const calls: string[] = []
  for (const [name, value] of Object.entries(host)) {
    if (typeof value !== "function") continue
    host[name] = (...args: unknown[]) => {
      calls.push(name)
      return (value as (...a: unknown[]) => unknown).apply(host, args)
    }
  }
  return calls
}

function bury(f: ReturnType<typeof fixture>, planID: string, taskID: string) {
  const body = JSON.stringify({ log: "x".repeat(4_000) })
  f.store.atomic((db) => {
    const attempt = db
      .query<{ workspace: string; base_commit: string }, [string]>(
        "SELECT workspace,base_commit FROM runner_attempts WHERE plan_id=? LIMIT 1",
      )
      .get(planID)!
    const insertTransition = db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,?,?,?)",
    )
    const insertAttempt = db.query(
      `INSERT INTO runner_attempts(id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at)
       VALUES(?,?,?,?,?,?,?,?,?,NULL,'{}','accepted',?)`,
    )
    const insertEvidence = db.query(
      "INSERT INTO runner_evidence(id,plan_id,task_id,attempt_id,assertion_id,kind,artifact,body,created_at) VALUES(?,?,?,NULL,NULL,'verification','a',?,?)",
    )
    const insertProgress = db.query(
      `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,source,sources_json,kind,event_ids_json,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,'seed','[]','tool','[]',?,?)`,
    )
    for (let n = 0; n < 1500; n++)
      insertTransition.run(
        planID,
        taskID,
        n % 3 ? "VERIFY" : "RECONCILE_REQUESTED",
        body,
        1_000 + n,
      )
    for (let n = 0; n < 150; n++) {
      insertAttempt.run(
        `seed-attempt-${n}`,
        planID,
        f.root,
        taskID,
        1_000 + n,
        `seed-session-${n}`,
        `seed-message-${n}`,
        attempt.workspace,
        attempt.base_commit,
        1_000 + n,
      )
      insertEvidence.run(`seed-evidence-${n}`, planID, taskID, body, 1_000 + n)
    }
    for (let n = 0; n < 400; n++)
      insertProgress.run(
        f.root,
        "project",
        planID,
        taskID,
        "seed-attempt-0",
        "seed-session-0",
        n,
        n,
        `seed:${n}`,
        body,
      )
  })
}

test("an idle runner tick reads the same rows with or without history behind it, and asks the host nothing", async () => {
  const f = fixture({ commit: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await acceptAndIntegratePlan(f, f.receipt.planID)
  for (let i = 0; i < 4; i++) await f.runtime.tick()
  const hostCalls = countHostCalls(f.host as unknown as Record<string, unknown>)

  const idle = async () => {
    const meter = meterRepository(f.repository)
    const before = hostCalls.length
    await f.runtime.tick()
    meter.stop()
    return { meter, hostCalls: hostCalls.slice(before) }
  }
  const first = await idle()
  expect(first.hostCalls).toEqual([])

  bury(f, f.receipt.planID, f.tasks[0]!.id)
  await f.runtime.tick()
  const second = await idle()

  if (process.env.READ_SWEEP_NUMBERS)
    console.log(
      `[read-sweep] idle runner tick rows=${first.meter.rows} bytes=${first.meter.bytes} statements=${first.meter.statements.length}; after burying: rows=${second.meter.rows} bytes=${second.meter.bytes}`,
    )
  expect(second.hostCalls).toEqual([])
  // History (1500 transitions, 150 attempts and evidence rows, 400 progress rows) adds no row to
  // what the tick reads.
  expect(second.meter.rows).toBe(first.meter.rows)
  expect(second.meter.bytes).toBe(first.meter.bytes)
  expect(second.meter.statements.length).toBe(first.meter.statements.length)
  for (const table of ["runner_transitions", "runner_evidence", "runner_progress"])
    expect(second.meter.of(new RegExp(`FROM ${table}`)).rows).toBe(0)
}, 60_000)
