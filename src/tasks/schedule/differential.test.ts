import { afterEach, expect, test } from "bun:test"
import { setPause } from "../../projects/pause.ts"
import { installTaskScheduleSchema } from "./schema.ts"
import { backfillPage } from "./backfill.ts"
import { compareReads } from "./parity.ts"
import { insertTask, openFixture, submitPlan } from "./fixture.ts"
import type { Fixture } from "./fixture.ts"

const fixtures: Fixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

function prng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NODE = [
  "queued",
  "ready",
  "running",
  "verifying",
  "accepted",
  "incorporated",
  "failed",
  "exhausted",
  "cancelled",
  "blocked",
]
const PLAN = ["running", "blocked", "cancelled", "integrated", "accepted", "cleaning", "draft"]
const ATTEMPT = ["preparing", "running", "verifying", "accepted", "failed", "cancelled"]

const SNAPSHOT_TABLES = [
  "task_schedule",
  "task_schedule_plans",
  "task_schedule_edges",
  "task_schedule_blockers",
  "task_schedule_waits",
  "task_schedule_sessions",
  "task_schedule_scopes",
  "task_schedule_counts",
]
function snapshot(f: Fixture) {
  return f.repository.read((db) =>
    Object.fromEntries(
      SNAPSHOT_TABLES.map((table) => [
        table,
        db
          .query(
            `SELECT * FROM ${table} ${table === "task_schedule_counts" ? "WHERE n<>0" : ""} ORDER BY 1,2`,
          )
          .all(),
      ]),
    ),
  )
}

/** A full rebuild into the same tables must equal what the incremental drain stored. */
function rebuildEqual(f: Fixture) {
  const before = snapshot(f)
  f.repository.atomic((db) => {
    installTaskScheduleSchema(db)
    while (!backfillPage(db, f.repository.projectDirectory, 50).done);
  })
  expect(snapshot(f)).toEqual(before)
}

function run(seed: number, events: number) {
  const f = openFixture()
  fixtures.push(f)
  const random = prng(seed)
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
  const unplanned: string[] = []
  const nodes: { plan: string; task: string }[] = []
  const plans: string[] = []
  let clock = 1000
  let counter = 0
  const log: string[] = []
  for (let step = 0; step < events; step++) {
    const kind = pick([
      "task",
      "task",
      "plan",
      "plan",
      "node",
      "node",
      "node",
      "planState",
      "priority",
      "pause",
      "attempt",
      "attemptState",
      "dispose",
      "amend",
      "global",
    ])
    log.push(kind)
    if (kind === "task")
      unplanned.push(insertTask(f.repository, `t${counter++}`, pick(["session-a", "session-b"])))
    else if (kind === "plan" && unplanned.length) {
      const count = Math.min(unplanned.length, 1 + Math.floor(random() * 3))
      const members = unplanned.splice(0, count)
      const after = plans.length && random() < 0.4 ? [pick(plans)] : undefined
      const id = submitPlan(f, `p${counter++}`, members, {
        dependencies: members.slice(1).map((m, i) => [members[i]!, m] as [string, string]),
        ...(after ? { afterPlans: after } : {}),
        ...(random() < 0.5 ? { priority: 1 + Math.floor(random() * 3) } : {}),
      })
      plans.push(id)
      for (const task of members) nodes.push({ plan: id, task })
    } else if (kind === "node" && nodes.length) {
      const node = pick(nodes)
      const state = pick(NODE)
      f.repository.atomic((db) => {
        db.query("UPDATE runner_nodes SET state=? WHERE plan_id=? AND task_id=?").run(
          state,
          node.plan,
          node.task,
        )
        {
          db.query(
            "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
          ).run(
            node.plan,
            node.task,
            1,
            "MOVE",
            JSON.stringify({ from: "queued", to: state }),
            clock++,
          )
        }
      })
    } else if (kind === "planState" && plans.length)
      f.repository.atomic((db) => {
        const plan = pick(plans)
        db.query("UPDATE runner_plans SET state=?,reason=? WHERE id=?").run(
          pick(PLAN),
          random() < 0.5 ? "why" : null,
          plan,
        )
        if (random() < 0.5)
          db.query(
            "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
          ).run(plan, null, 1, "PLAN", JSON.stringify({ to: "cancelled" }), clock++)
      })
    else if (kind === "priority" && plans.length)
      f.repository.atomic((db) =>
        db
          .query("UPDATE runner_plans SET body=json_set(body,'$.priority',?) WHERE id=?")
          .run(Math.floor(random() * 4), pick(plans)),
      )
    else if (kind === "pause" && plans.length) {
      const plan = pick(plans)
      f.reads.runner.setDispatchPause(
        plan,
        random() < 0.5
          ? null
          : {
              reason: "hold",
              untilPlans:
                plans.length > 1 && random() < 0.5 ? [pick(plans.filter((p) => p !== plan))] : [],
            },
        { caller: "t" },
      )
    } else if (kind === "attempt" && nodes.length) {
      const node = pick(nodes)
      f.repository.atomic((db) => {
        const number = db
          .query<{ n: number }, [string]>(
            "SELECT COALESCE(MAX(number),0)+1 AS n FROM runner_attempts WHERE task_id=?",
          )
          .get(node.task)!.n
        db.query(
          `INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          crypto.randomUUID(),
          node.plan,
          node.task,
          number,
          `w-${counter++}`,
          `m-${counter++}`,
          random() < 0.5 ? "/project" : "/worktree",
          "a".repeat(40),
          null,
          random() < 0.3 ? JSON.stringify({ takeover: { sessionID: "x" } }) : "{}",
          pick(ATTEMPT),
          clock++,
        )
      })
    } else if (kind === "attemptState")
      f.repository.atomic((db) => {
        const attempt = db
          .query<{ id: string }, []>("SELECT id FROM runner_attempts ORDER BY RANDOM() LIMIT 1")
          .get()
        if (attempt)
          db.query("UPDATE runner_attempts SET state=? WHERE id=?").run(pick(ATTEMPT), attempt.id)
      })
    else if (kind === "dispose" && nodes.length && random() < 0.3)
      f.repository.atomic((db) =>
        db
          .query(
            `INSERT INTO task_dispositions(project_directory,task_id,request_id,payload,disposition,reason,evidence,related_task_ids,session_id,agent,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            f.repository.projectDirectory,
            pick(nodes).task,
            `d-${counter++}`,
            "{}",
            "obsolete",
            "r",
            "[]",
            "[]",
            "s",
            "a",
            "2026-01-01",
          ),
      )
    else if (kind === "amend" && nodes.length) {
      const node = pick(nodes)
      f.repository.atomic((db) =>
        db
          .query(
            "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(
            node.plan,
            node.task,
            1,
            "SCOPE_AMENDED",
            JSON.stringify({ writeScope: [`src/${pick(["a", "b", "c"])}/**`] }),
            clock++,
          ),
      )
    } else if (kind === "global")
      setPause(f.repository, { kind: "global" }, { paused: random() < 0.5, reason: "r", by: "o" })
    const divergences = compareReads(f.repository, f.reads)
    if (divergences.length && process.env.DEBUG_SCHEDULE) {
      const rows = f.repository.read((db) =>
        db
          .query<{ t: string; s: string }, []>(
            "SELECT substr(task_id,1,4) t, rank||':'||node_state||':'||plan_state||':f'||finished_at||':'||COALESCE(finished_basis,'-')||':p'||priority_key||':q'||COALESCE(plan_seq,'-')||':s'||seq AS s FROM task_schedule ORDER BY sort_key",
          )
          .all(),
      )
      const old = f.reads
        .query({ sort: "schedule", state: "all", limit: 100 })
        .tasks.map((t) => t.taskID.slice(0, 4))
      const by = new Map(rows.map((r) => [r.t, r.s]))
      console.log(
        JSON.stringify(
          f.repository.read((db) =>
            db
              .query(
                "SELECT substr(plan_id,1,4) p,substr(task_id,1,4) t,id,event,payload,created_at FROM runner_transitions WHERE task_id IN (SELECT task_id FROM task_schedule WHERE rank=4) ORDER BY id",
              )
              .all(),
          ),
        ),
      )
      console.log(
        "NEW",
        rows.map((r) => `${r.t} ${r.s}`).join("\n"),
        "\nOLD",
        old.map((t) => `${t} ${by.get(t)}`).join("\n"),
      )
    }
    if (divergences.length)
      throw new Error(
        `seed ${seed} step ${step} (${log.slice(-6).join(",")}): ${JSON.stringify(divergences.slice(0, 3))}`,
      )
    if (step % 40 === 39) rebuildEqual(f)
  }
  rebuildEqual(f)
  return f
}

for (const seed of [1, 2, 3, 4, 5])
  test(`differential: seed ${seed} keeps the projection equal to the old read and to a rebuild`, () => {
    run(seed, 160)
  })
