import { AuditHistory } from "../audit/history.ts"
import { refreshProgressDisplay } from "../progress/display-store.ts"
import { RecoveryDetector } from "../recovery/detector.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"
import { RunnerStore } from "../runner/store.ts"
import { recordTaskAdvice } from "./advice.ts"
import { insertTask, openFixture, submitPlan, type Fixture } from "./schedule/fixture.ts"
import { TaskScheduleOwner } from "./schedule/owner.ts"

/**
 * The Tasks detail corpus: every shape the selected-task pane, `lz-get-task`, `lz-query-tasks` and
 * the current-activity read show. A loose task, a retired one, a task with an advice history and a
 * classification correction, a plan waiting on another, a paused plan, a struggling task with two
 * attempts (a recorded model, tool calls with edited files, a concern with advice, scope reports),
 * an Architect takeover, a blocked plan's held task, an audit run, and a session that only ran
 * an attempt. Names are the objectives (`names`), so a recording carries no run's ids.
 */
export async function detailCorpus() {
  const f: Fixture = openFixture()
  const owner = new TaskScheduleOwner(f.repository)
  const taskNames = new Map<string, string>()
  const task = (name: string, session = "ses_a") => {
    const id = insertTask(f.repository, name, session)
    taskNames.set(id, name)
    return id
  }
  /** The session id of attempt `number` of a task. */
  const workerSession = (taskID: string, number: number) =>
    `ses_w${number}_${taskNames.get(taskID)}`
  const loose = task("loose")
  const retired = task("retired")
  const advised = task("advised")
  const other = task("other-session", "ses_b")
  const first = task("first")
  const waiting = task("waiting")
  const held = task("held")
  const grind = task("grind")
  const calm = task("calm")
  const stuck = task("stuck")
  const firstPlan = submitPlan(f, "first", [first])
  const waitingPlan = submitPlan(f, "waiting", [waiting], { afterPlans: [firstPlan] })
  const heldPlan = submitPlan(f, "held", [held])
  const grindPlan = submitPlan(f, "grind", [grind, calm], { dependencies: [[grind, calm]] })
  const stuckPlan = submitPlan(f, "stuck", [stuck])
  f.reads.runner.setDispatchPause(heldPlan, { reason: "hold", untilPlans: [] }, { caller: "t" })
  f.repository.recordDisposition(
    {
      taskID: retired,
      requestID: "retire-corpus",
      disposition: "superseded",
      reason: "Replaced by a runner plan.",
      evidence: [{ kind: "artifact", reference: "design/plan.md" }],
    },
    { sessionID: "architect", agent: "architect" },
  )
  for (const [requestID, findings] of [
    ["advice-1", ["Read the boundary first."]],
    ["advice-2", ["Keep attachments separate."]],
  ] as const)
    recordTaskAdvice(
      f.repository,
      {
        taskID: advised,
        specRevision: 1,
        requestID,
        expectedRevision: requestID === "advice-1" ? 0 : 1,
        findings: [...findings],
        implementationAdvice: ["Use the stored read."],
        references: [],
      },
      { sessionID: "architect", agent: "architect" },
    )
  f.repository.recordTaskClassification(
    {
      taskID: advised,
      requestID: "classify-corpus",
      expectedRevision: 1,
      classification: { taxonomy: "task-kind/v1", primaryKind: "documentation" },
      reason: "The outcome is documentation.",
    },
    { sessionID: "architect", agent: "architect" },
  )
  new AuditHistory(f.repository)
  const attempts = new Map<string, string>()
  f.repository.atomic((db) => {
    db.query(
      `INSERT INTO audit_runs(id,project_directory,task_id,attempt_id,session_id,request_id,started_at,payload)
       VALUES(?,?,?,NULL,'architect',?,?,'{}')`,
    ).run(crypto.randomUUID(), f.repository.projectDirectory, advised, "audit-1", 1_000)
    db.query(
      `INSERT INTO audit_runs(id,project_directory,task_id,attempt_id,session_id,request_id,started_at,payload)
       VALUES(?,?,?,NULL,'architect',?,?,'{}')`,
    ).run(crypto.randomUUID(), f.repository.projectDirectory, advised, "audit-2", 2_000)
    db.query("UPDATE runner_plans SET state='running',reason=NULL WHERE id IN (?,?,?)").run(
      firstPlan,
      waitingPlan,
      grindPlan,
    )
    db.query("UPDATE runner_plans SET state='blocked',reason='reconcile hold' WHERE id=?").run(
      stuckPlan,
    )
    db.query("UPDATE runner_nodes SET state='running',reason=NULL WHERE plan_id IN (?,?)").run(
      grindPlan,
      stuckPlan,
    )
    const attempt = (
      plan: string,
      taskID: string,
      number: number,
      state: string,
      policy: object,
      session = workerSession(taskID, number),
    ) => {
      const id = crypto.randomUUID()
      attempts.set(id, `attempt ${number} of ${taskNames.get(taskID)}`)
      db.query(
        `INSERT INTO runner_attempts
          (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count,tool_count)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        plan,
        taskID,
        number,
        session,
        `m-${taskID}-${number}`,
        "/worktree",
        "a".repeat(40),
        number === 1 ? "b".repeat(40) : null,
        JSON.stringify(policy),
        state,
        1_000 * number,
        number * 1_000_000,
        number * 10,
      )
      return id
    }
    attempt(grindPlan, calm, 1, "running", { takeover: { reason: "Architect finishes it" } })
    attempt(grindPlan, grind, 1, "failed", {})
    const latest = attempt(grindPlan, grind, 2, "running", {
      model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
    })
    attempt(stuckPlan, stuck, 1, "accepted", {}, "ses_stuck_worker")
    const progress = (at: number, status: string, files: string[], kind = "tool") => {
      db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,sources_json,kind,event_ids_json,call_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,'native','[]',?,'[]',?,?,?)`,
      ).run(
        f.repository.projectDirectory,
        "global",
        grindPlan,
        grind,
        latest,
        workerSession(grind, 2),
        at,
        kind,
        kind === "tool" ? `call-${at}` : null,
        `dedupe-${at}`,
        JSON.stringify({ status, fileTargets: { operation: "edit", paths: files } }),
      )
      const seq = db
        .query<{ seq: number }, []>("SELECT max(seq) AS seq FROM runner_progress")
        .get()!
      refreshProgressDisplay(db, seq.seq)
    }
    progress(2_100, "succeeded", ["a.ts"])
    progress(2_400, "failed", ["b.ts"])
    progress(2_700, "running", [], "message")
    const transition = db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,?,?,?)",
    )
    for (let round = 0; round < 3; round++)
      transition.run(grindPlan, grind, "VERIFY", "{}", round + 1)
    transition.run(
      grindPlan,
      grind,
      "REPAIR",
      JSON.stringify({ from: "verifying", to: "ready" }),
      4,
    )
    transition.run(
      grindPlan,
      grind,
      "SCOPE_REPORTED",
      JSON.stringify({ divergences: [{ path: "src/x.ts" }], accepted: [{ path: "src/y.ts" }] }),
      5,
    )
    // Tied times: the transition id decides the order.
    transition.run(grindPlan, grind, "SCOPE_AMENDED", JSON.stringify({ reason: "widened" }), 5)
  })
  new RecoveryDetector({
    store: f.reads.runner,
    handoff: new HandoffStore(f.repository),
    now: Date.now,
  }).evaluate("owner", f.reads.runner.claim("owner", Date.now())!)
  await owner.settle()
  const names = new Map<string, string>(attempts)
  f.repository.read((db) => {
    for (const row of db
      .query<{ id: string; objective: string }, []>(
        "SELECT id,json_extract(body,'$.proposal.objective') AS objective FROM tasks",
      )
      .all())
      names.set(row.id, row.objective)
    for (const row of db
      .query<{ id: string; objective: string }, []>(
        "SELECT id,json_extract(body,'$.objective') AS objective FROM runner_plans",
      )
      .all())
      names.set(row.id, `plan ${row.objective}`)
    for (const row of db.query<{ id: string }, []>("SELECT id FROM audit_runs").all())
      names.set(row.id, "audit run")
  })
  return {
    f,
    owner,
    names,
    runner: f.reads.runner as RunnerStore,
    workerSession,
    tasks: { loose, retired, advised, other, first, waiting, held, grind, calm, stuck },
    close() {
      owner.close()
      f.close()
    },
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * A read in the corpus's names, without the instants of the run: ids become the names the
 * fixture chose, and wall-clock times (an ISO instant of a run, or an epoch above 10^12 ms)
 * become `<time>`. Fixture times (`createdAt` of the corpus, small epochs) are kept.
 */
export function named(value: unknown, names: ReadonlyMap<string, string>): unknown {
  const json = JSON.stringify(value, (key, item) => {
    if (key === "serverTime" || key === "attemptMs" || key === "observedAt") return undefined
    if (typeof item === "number" && item > 1e12) return "<time>"
    if (typeof item === "string" && ISO.test(item) && !item.startsWith("2026-10-31"))
      return "<time>"
    return item
  })
  return JSON.parse(json.replace(UUID, (id) => names.get(id) ?? "<id>"))
}
