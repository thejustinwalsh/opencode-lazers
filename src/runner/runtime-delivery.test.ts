import { expect, test } from "bun:test"

import { retireOutboxLifecycle } from "./retire-gates.ts"
import {
  architectBacklog,
  countArchitectContact,
  drive,
  fixture,
  handOverPlan,
  outboxStates,
  prepareIdleArchitect,
  runPlan,
  transitions,
  withoutDraft,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("submitting a plan admits it; only an explicit draft waits for run", async () => {
  const f = fixture({ startOnly: true })
  const admitted = (await f.runtime.submitPlan(
    withoutDraft(f.inputFor(f.tasks.slice(0, 1), { requestID: "submit-admit" })),
    "owner",
  )) as { planID: string }
  expect(f.store.plan(admitted.planID)!.state).toBe("running")
  expect(f.store.latestTransition(admitted.planID, null, "ADMITTED")).toBeDefined()

  const drafted = (await f.runtime.submitPlan(
    { ...f.inputFor(f.tasks.slice(1), { requestID: "submit-draft" }), draft: true },
    "owner",
  )) as { planID: string }
  await f.runtime.tick()
  expect(f.store.plan(drafted.planID)!.state).toBe("draft")
  await f.runtime.command(
    {
      requestID: "run-explicit-draft",
      planID: drafted.planID,
      action: "run",
    },
    "owner",
  )
  expect(f.store.plan(drafted.planID)!.state).toBe("running")
})

test("a draft that was never explicitly drafted is admitted by the scheduler", async () => {
  const f = fixture({ startOnly: true })
  const { planID } = f.store.submit(
    withoutDraft(f.inputFor(f.tasks.slice(0, 1), { requestID: "legacy-draft" })),
    "owner",
  )
  expect(f.store.plan(planID)!.state).toBe("draft")
  await drive(f.runtime, 2)
  expect(f.store.plan(planID)!.state).not.toBe("draft")
})

test("any live Architect of the project may command a plan and is adopted as owner", async () => {
  const f = fixture()
  const planID = f.receipt.planID
  f.sessions.set("successor", { ...structuredClone(f.sessions.get("owner")!), id: "successor" })
  await f.runtime.command({ requestID: "run-by-successor", planID, action: "run" }, "successor")
  const plan = f.store.plan(planID)!
  expect(plan.owner).toBe("successor")
  expect(plan.state).toBe("running")
  expect(f.store.latestTransition(planID, null, "OWNER_ADOPTED")).toBeDefined()
  await expect(
    f.runtime.command(
      {
        requestID: "pause-by-stranger",
        planID,
        action: "pause",
        reason: "A session that is not an Architect cannot command",
      },
      "not-a-session",
    ),
  ).rejects.toThrow("live Architect session")
})

test("a missing owner is replaced by a fresh Architect and the routing reason is recorded", async () => {
  const f = fixture()
  const planID = f.receipt.planID
  await runPlan(f)
  f.sessions.get("owner")!.archived = true
  await drive(f.runtime, 2)
  const routed = (f.store.detail(planID).activity as { event: string; payload: string }[])
    .filter((row) => row.event === "ARCHITECT_ROUTED")
    .map((row) => JSON.parse(row.payload) as { reason: string; action: string })
  expect(routed).toContainEqual(expect.objectContaining({ reason: "missing", action: "fresh" }))
  expect(f.store.plan(planID)!.owner).not.toBe("owner")
})

test("a cancelled prerequisite plan drops its edge, notifies the Architect and does not hold dependents", async () => {
  const f = fixture({ startOnly: true, independent: true })
  const first = f.store.submit(
    f.inputFor(f.tasks.slice(0, 1), { requestID: "prerequisite" }),
    "owner",
  )
  const second = f.store.submit(
    { ...f.inputFor(f.tasks.slice(1), { requestID: "dependent" }), afterPlans: [first.planID] },
    "owner",
  )
  await runPlan(f, first.planID, "run-prerequisite")
  await f.runtime.command(
    {
      requestID: "cancel-prerequisite",
      planID: first.planID,
      action: "cancel",
      reason: "Cancel the prerequisite",
    },
    "owner",
  )
  await drive(f.runtime, 6)
  expect(f.store.plan(first.planID)!.state).toBe("cancelled")
  await runPlan(f, second.planID, "run-dependent")
  await drive(f.runtime, 6)
  const dependent = f.store.plan(second.planID)!
  expect(JSON.parse(dependent.body).afterPlans).toEqual([])
  expect(dependent.reason ?? "").not.toContain("Prerequisite cancelled")
  const dropped = f.store.latestTransition<{ planPrerequisites: string[] }>(
    second.planID,
    null,
    "DEPENDENCY_EDGE_DROPPED",
  )
  expect(dropped?.planPrerequisites).toEqual([first.planID])
})

test("Start from a non-Architect session admits the plan without an Architect command", async () => {
  const f = fixture({ startOnly: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  f.sessions.get("owner")!.agent = "build"
  const result = await f.runtime.startTask({
    taskID: f.tasks[0]!.id,
    revision: 1,
    sessionID: "owner",
  })
  expect(result.status).toBe("started")
  expect(f.store.plan(result.planID)!.state).toBe("running")
})

test("Architect contact is a machine: enabled cannot unpause and invalid changes are rejected", () => {
  const f = fixture()
  expect(f.store.architectContact()).toMatchObject({ state: "enabled", updatedAt: null })
  expect(() => f.store.setArchitectContact("enabled", "")).toThrow("Invalid Architect contact")
  expect(f.store.setArchitectContact("paused", "Recovery mode")).toMatchObject({
    state: "paused",
    reason: "Recovery mode",
  })
  expect(f.store.setArchitectContact("paused", "Still recovering").state).toBe("paused")
  expect(f.store.setArchitectContact("enabled", "").state).toBe("enabled")
})

test("while Architect contact is paused a missing owner is not replaced, and workers keep running", async () => {
  const f = fixture({ taskFiles: [{ name: "a", path: "a.txt" }] })
  const spy = countArchitectContact(f)
  f.store.setArchitectContact("paused", "Recovery mode")
  await runPlan(f)
  f.sessions.get("owner")!.archived = true
  await drive(f.runtime, 4)
  expect(spy.created).toEqual([])
  expect(f.store.latestTransition(f.receipt.planID, null, "ARCHITECT_ROUTED")).toBeUndefined()
  // The scheduler still dispatches the worker without an Architect.
  expect(f.store.attempts(f.receipt.planID).length).toBeGreaterThan(0)
  f.store.setArchitectContact("enabled", "")
  await drive(f.runtime, 3)
  expect(spy.created.length).toBe(1)
})

test("while Architect contact is paused a cold large Architect is not renewed", async () => {
  const now = 1_700_000_000_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const spy = countArchitectContact(f)
  f.store.setArchitectContact("paused", "Recovery mode")
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  expect(f.store.architectRenewalForPlan(f.receipt.planID)).toBeNull()
  expect(spy.created).toEqual([])
  f.store.setArchitectContact("enabled", "")
  await f.runtime.tick()
  expect(f.store.architectRenewalForPlan(f.receipt.planID)?.state).toBe("committed")
  expect(spy.created.length).toBe(1)
})

test("while Architect contact is paused notices stay queued and deliver after unpause", async () => {
  const f = fixture({ taskFiles: [{ name: "a", path: "a.txt" }] })
  f.store.setArchitectContact("paused", "Recovery mode")
  await runPlan(f)
  await drive(f.runtime, 3)
  const queued = f.store.atomic((db) =>
    db.query("SELECT COUNT(*) AS n FROM runner_outbox WHERE state='pending'").get(),
  ) as { n: number }
  expect(queued.n).toBeGreaterThan(0)
  expect(f.notifications).toEqual([])
  f.store.setArchitectContact("enabled", "")
  await drive(f.runtime, 3)
  expect(f.notifications.length).toBeGreaterThan(0)
})

test("a pause set while a tick is delivering still stops the send to the Architect", async () => {
  const f = fixture({ taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  const read = f.host.outcomeInbox!
  let paused = false
  f.host.outcomeInbox = async (id) => {
    // The operator pauses after the tick began delivering, before the notice is sent.
    if (!paused) {
      paused = true
      f.store.setArchitectContact("paused", "Recovery mode")
    }
    return read(id)
  }
  await drive(f.runtime, 4)
  expect(paused).toBe(true)
  expect(f.notifications).toEqual([])
})

test("repeated outcomes for one Architect yield one inbox item that states every plan's latest outcome", async () => {
  const f = fixture()
  const { ids, emit, deliver } = architectBacklog(f, 5)
  for (const id of ids) emit(id, { status: "blocked", reason: `first-${id}` })
  await deliver()
  expect(f.inbox.get("owner")).toHaveLength(1)
  expect(f.notifications).toHaveLength(1)
  for (const id of ids) expect(f.notifications[0]!.text).toContain(id)

  // A later outcome for one plan replaces the queued notice instead of joining it.
  emit(ids[2]!, { status: "blocked", reason: "second-backlog-2" })
  await deliver()
  const queued = f.inbox.get("owner")!
  expect(queued).toHaveLength(1)
  expect(f.notifications).toHaveLength(2)
  const text = f.notifications[1]!.text
  for (const id of ids) expect(text).toContain(id)
  expect(text).toContain("second-backlog-2")
  expect(text).not.toContain("first-backlog-2")
  expect(text).toContain("first-backlog-0")
  expect(queued[0]!.id).toBe(f.notifications[1]!.id)
  expect(f.events.filter((event) => event.startsWith("cancel:"))).toEqual([
    `cancel:${f.notifications[0]!.id}`,
  ])
  expect(outboxStates(f).filter((row) => row.state === "pending")).toEqual([])
})

test("a notice consumed before the next outcome is not cancelled or repeated", async () => {
  const f = fixture()
  const { ids, emit, deliver } = architectBacklog(f, 2)
  emit(ids[0]!, { status: "blocked", reason: "one" })
  await deliver()
  f.inbox.set("owner", [])
  emit(ids[1]!, { status: "blocked", reason: "two" })
  await deliver()
  expect(f.events.filter((event) => event.startsWith("cancel:"))).toEqual([])
  expect(f.inbox.get("owner")).toHaveLength(1)
  expect(f.notifications[1]!.text).toContain("two")
  expect(f.notifications[1]!.text).not.toContain("one")
})

test("unpausing a backlog of notices for one Architect delivers one", async () => {
  const f = fixture()
  const { ids, emit, deliver } = architectBacklog(f, 12)
  f.store.setArchitectContact("paused", "Recovery mode")
  for (const id of ids) emit(id, { status: "blocked", reason: `held-${id}` })
  await deliver()
  expect(f.notifications).toEqual([])
  expect(outboxStates(f).find((row) => row.state === "pending")!.n).toBeGreaterThanOrEqual(12)
  f.store.setArchitectContact("enabled", "")
  await deliver()
  expect(f.notifications).toHaveLength(1)
  expect(f.inbox.get("owner")).toHaveLength(1)
  for (const id of ids) expect(f.notifications[0]!.text).toContain(id)
  expect(outboxStates(f).find((row) => row.state === "pending")).toBeUndefined()
  // Nothing is left to deliver on the next pass.
  await deliver()
  expect(f.notifications).toHaveLength(1)
})

test("a failed send leaves the notices pending and the next pass sends one", async () => {
  const f = fixture()
  const { ids, emit, deliver } = architectBacklog(f, 3)
  for (const id of ids) emit(id, { status: "blocked", reason: id })
  const notify = f.host.notify
  f.host.notify = async () => {
    throw new Error("native inbox unavailable")
  }
  await deliver()
  expect(f.inbox.get("owner") ?? []).toHaveLength(0)
  f.host.notify = notify
  await deliver()
  expect(f.inbox.get("owner")).toHaveLength(1)
  expect(outboxStates(f).find((row) => row.state === "pending")).toBeUndefined()
})

test("changes to the Architect inbox emit no notice about notices or the journal", async () => {
  const f = fixture()
  f.inbox.set("owner", [
    { id: "msg_user_1", type: "user", delivery: "queue" },
    {
      id: "msg_notice",
      type: "synthetic",
      delivery: "queue",
      metadata: { lazersKind: "runner-outcome", lazersOutboxID: "some-notice" },
    },
  ])
  await f.runtime.tick()
  await f.runtime.tick()
  const notices = f.store.atomic((db) =>
    db
      .query<{ status: string }, []>(
        "SELECT json_extract(payload,'$.status') AS status FROM runner_outbox",
      )
      .all(),
  )
  expect(notices.some((row) => String(row.status).startsWith("architect-source"))).toBe(false)
})

test("real outcomes still reach the Architect, once, with the action to take", async () => {
  const f = fixture({ taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await drive(f.runtime, 8)
  const notices = f.notifications.filter((notice) => notice.sessionID === "owner")
  expect(notices.length).toBeGreaterThan(0)
  expect(f.inbox.get("owner")!.length).toBeLessThanOrEqual(1)
  expect(notices.at(-1)!.text).toContain("LAZERS outcome")
  expect(notices.at(-1)!.text).toContain(f.receipt.planID)
})

test("migration retires source-change notices unsent and collapses the old outbox states", () => {
  const f = fixture()
  f.store.atomic((db) => {
    const insert = db.query(
      "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,?,?,?,?,0)",
    )
    for (const [index, state] of [
      "pending",
      "sending",
      "uncertain",
      "admitted",
      "consumed",
    ].entries())
      insert.run(
        `legacy-${index}`,
        f.receipt.planID,
        "owner",
        `msg_legacy_${index}`,
        JSON.stringify({ status: "architect-source-change", version: index }),
        state,
      )
    for (const [index, state] of ["sending", "unknown", "reconciling"].entries())
      insert.run(
        `kept-${index}`,
        f.receipt.planID,
        "owner",
        `msg_kept_${index}`,
        JSON.stringify({ status: "blocked", version: index }),
        state,
      )
    retireOutboxLifecycle(db)
  })
  const state = (id: string) =>
    f.store.atomic(
      (db) =>
        db.query<{ state: string }, [string]>("SELECT state FROM runner_outbox WHERE id=?").get(id)!
          .state,
    )
  expect(["legacy-0", "legacy-1", "legacy-2"].map(state)).toEqual([
    "superseded",
    "superseded",
    "superseded",
  ])
  expect(["legacy-3", "legacy-4"].map(state)).toEqual(["delivered", "delivered"])
  expect(["kept-0", "kept-1", "kept-2"].map(state)).toEqual(["pending", "delivered", "delivered"])
})

test("queued outcomes follow an archived Architect to its replacement as one notice", async () => {
  const f = fixture({
    fail: true,
    shared: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  f.store.setArchitectContact("paused", "Recovery mode")
  await runPlan(f)
  await drive(f.runtime, 4)
  expect(f.store.outboxForDelivery().length).toBeGreaterThan(0)
  f.sessions.get("owner")!.archived = true
  f.store.setArchitectContact("enabled", "")
  await drive(f.runtime, 4)
  const owner = f.store.plan(f.receipt.planID)!.owner
  expect(owner).not.toBe("owner")
  expect(f.inbox.get("owner") ?? []).toHaveLength(0)
  expect(f.inbox.get(owner)).toHaveLength(1)
  expect(f.store.outboxForDelivery()).toEqual([])
  const rows = f.store.detail(f.receipt.planID).delivery as { session_id: string }[]
  expect(rows.every((row) => row.session_id === owner)).toBe(true)
})

test("an interrupted worker resumes without an Architect command", async () => {
  const f = fixture({
    autoResume: true,
    delayed: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: attempt.message_id, state: "interrupted" }
  await f.runtime.tick()
  expect(transitions(f, planID, "WORKER_AUTO_RESUME_ATTEMPTED")).toHaveLength(1)
  expect(f.store.latestTransition(planID, attempt.task_id, "WORKER_AUTO_RESUMED")).toMatchObject({
    attemptID: attempt.id,
  })
  expect(transitions(f, planID, "WORKER_AUTO_RESUME_REFUSED")).toHaveLength(0)
  // The same worker continues; the plan is not left waiting for an explicit command.
  expect(f.store.plan(planID)!.state).toBe("running")
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
  })
  await f.runtime.tick()
  expect(f.store.attempts(planID)[0]!.state).toBe("running")
})

// Live LZ-216: three "resumed" rows were recorded while every resume command was refused and the
// error was lost. A refused resume says so, carries the host's reason to the hold, and stays bounded.
test("a refused automatic resume is recorded as refused with its reason, never as resumed", async () => {
  const f = fixture({
    autoResume: true,
    delayed: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "interrupted"
  // The shape the pre-fix adapter reported: an interrupted outcome over a "completed" turn.
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  for (let tick = 0; tick < 8; tick++) await f.runtime.tick()
  expect(transitions(f, planID, "WORKER_AUTO_RESUMED")).toHaveLength(0)
  expect(transitions(f, planID, "WORKER_AUTO_RESUME_ATTEMPTED")).toHaveLength(3)
  const refused = transitions(f, planID, "WORKER_AUTO_RESUME_REFUSED").map(
    (row) => JSON.parse(row.payload) as { attemptID: string; error: string },
  )
  expect(refused).toHaveLength(3)
  expect(refused[0]).toMatchObject({
    attemptID: attempt.id,
    error: "Terminal worker outcome does not match the current assigned input lineage",
  })
  const plan = f.store.plan(planID)!
  expect(plan.state).toBe("blocked")
  expect(plan.reason).toBe(
    "Worker execution was interrupted; automatic resume was refused: Terminal worker outcome does not match the current assigned input lineage",
  )
  // Past the bound the hold is stable: no new resume, no re-hold per tick.
  const holds = transitions(f, planID, "BLOCKED").length
  for (let tick = 0; tick < 4; tick++) await f.runtime.tick()
  expect(transitions(f, planID, "BLOCKED")).toHaveLength(holds)
  expect(transitions(f, planID, "WORKER_AUTO_RESUME_ATTEMPTED")).toHaveLength(3)
  // The Architect's notice carries the same reason.
  expect(
    f.store
      .outboxForDelivery()
      .concat(f.notifications.map((n) => ({ payload: n.text }) as never))
      .some((row: { payload: string }) => row.payload.includes("automatic resume was refused")),
  ).toBe(true)
})

test("a worker that went idle without answering its input fails the attempt instead of holding", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "interrupted" }
  await f.runtime.tick()
  const reason = f.store.plan(planID)!.reason ?? ""
  expect(reason).not.toContain("does not match a completed response")
  expect(f.store.attempts(planID)[0]!.state).toBe("failed")
})

test("an unreadable Architect inbox does not hold the notice back and is recorded on the plan", async () => {
  const f = fixture()
  const { ids, emit, deliver } = architectBacklog(f, 2)
  f.host.outcomeInbox = async () => {
    throw new Error("404 session inbox not found")
  }
  for (const id of ids) emit(id, { status: "blocked", reason: id })
  expect(await deliver()).toBe(false)
  expect(f.notifications).toHaveLength(1)
  expect(outboxStates(f).find((row) => row.state === "pending")).toBeUndefined()
  expect(transitions(f, ids[0]!, "OUTCOME_INBOX_UNREADABLE")).toHaveLength(1)
  expect(transitions(f, ids[1]!, "OUTCOME_INBOX_UNREADABLE")).toHaveLength(1)
})

test("a send that fails stays pending, is recorded once, and asks to be retried", async () => {
  const f = fixture()
  const { ids, emit, deliver } = architectBacklog(f, 1)
  emit(ids[0]!, { status: "blocked", reason: "x" })
  f.host.notify = async () => {
    throw new Error("native inbox unavailable")
  }
  expect(await deliver()).toBe(true)
  expect(await deliver()).toBe(true)
  expect(outboxStates(f).find((row) => row.state === "pending")!.n).toBe(1)
  expect(transitions(f, ids[0]!, "OUTCOME_DELIVERY_FAILED")).toHaveLength(1)
})

test("a plan with no live Architect records the hold and asks to be retried", async () => {
  const f = fixture()
  const { ids, emit, deliver } = architectBacklog(f, 1)
  emit(ids[0]!, { status: "blocked", reason: "x" })
  f.sessions.get("owner")!.archived = true
  f.host.createArchitect = async () => {
    throw new Error("cannot create an Architect")
  }
  expect(await deliver()).toBe(true)
  expect(outboxStates(f).find((row) => row.state === "pending")!.n).toBe(1)
  expect(transitions(f, ids[0]!, "OUTCOME_NO_ARCHITECT")).toHaveLength(1)
})

test("an owner change cancels this ledger's queued notice in the old session and leaves others", async () => {
  const f = fixture()
  const { ids, emit, deliver } = architectBacklog(f, 1)
  emit(ids[0]!, { status: "blocked", reason: "first" })
  await deliver()
  const first = f.inbox.get("owner")![0]!
  f.inbox.get("owner")!.push(
    { id: "msg_user", type: "user", delivery: "queue" },
    {
      id: "msg_lookalike",
      type: "synthetic",
      delivery: "queue",
      metadata: { ...first.metadata, lazersMessageID: "msg_lookalike", lazersOutboxID: "none" },
    },
  )
  handOverPlan(f, ids[0]!)
  emit(ids[0]!, { status: "blocked", reason: "second" })
  await deliver()
  expect(f.inbox.get("owner")!.map((entry) => entry.id)).toEqual(["msg_user", "msg_lookalike"])
  expect(f.inbox.get("owner-2")).toHaveLength(1)
  const cleaned = (f.store.detail(ids[0]!).delivery as { receipt: string | null }[]).filter((row) =>
    row.receipt?.includes("retired-session-cleaned"),
  )
  expect(cleaned).toHaveLength(1)
  // Cleaned once: a later delivery does not list or cancel again.
  const cancels = f.events.filter((event) => event.startsWith("cancel:")).length
  emit(ids[0]!, { status: "blocked", reason: "third" })
  await deliver()
  expect(f.events.filter((event) => event.startsWith("cancel:")).length).toBe(cancels + 1)
})

test("an unreadable old inbox is recorded once and never blocks the new owner", async () => {
  const f = fixture()
  const { ids, emit, deliver } = architectBacklog(f, 1)
  emit(ids[0]!, { status: "blocked", reason: "first" })
  await deliver()
  handOverPlan(f, ids[0]!)
  const read = f.host.outcomeInbox!
  f.host.outcomeInbox = async (id) => {
    if (id === "owner") throw new Error("404 session inbox not found")
    return read(id)
  }
  emit(ids[0]!, { status: "blocked", reason: "second" })
  expect(await deliver()).toBe(false)
  expect(f.inbox.get("owner-2")).toHaveLength(1)
  expect(transitions(f, ids[0]!, "OUTCOME_OLD_INBOX_UNREADABLE")).toHaveLength(1)
  emit(ids[0]!, { status: "blocked", reason: "third" })
  await deliver()
  expect(transitions(f, ids[0]!, "OUTCOME_OLD_INBOX_UNREADABLE")).toHaveLength(1)
  expect(f.inbox.get("owner-2")).toHaveLength(1)
})
