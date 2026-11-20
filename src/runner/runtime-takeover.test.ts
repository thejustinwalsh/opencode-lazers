import { RECOVERY_STALE_MS } from "./recovery-bundle.ts"
import { classifyPlans } from "../retention/retention.ts"
import { runbook } from "../guidance/index.ts"
import { expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { git } from "./artifacts.ts"
import {
  TaskRuntime,
  cleanup,
  commitWorkInProgress,
  drive,
  fixture,
  runPlan,
  submitTakeover,
  takeoverFixture,
  workerWritesHandoff,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("takeover: the worker writes its handoff in time, stops, and the Architect's result is verified and accepted", async () => {
  const { f, worker, steered } = await takeoverFixture()
  f.host.steerWorker = async (input) => {
    steered.push(input.id)
    expect(input.text).toContain("lz-takeover-handoff")
    commitWorkInProgress(worker)
    f.runtime.takeoverHandoff(
      {
        done: "a first a.txt",
        remaining: "the right content",
        workspaceState: "committed",
        struggledWith: "the content check",
        tried: "writing a.txt",
      },
      worker.session_id,
    )
  }
  const result = await f.runtime.takeover(
    { attemptID: worker.id, reason: "Not converging", requestID: "take-1" },
    "owner",
  )
  expect(result.status).toBe("taken-over")
  expect(result.guidance).toBe(runbook("takeover"))
  expect(result.handoff).toMatchObject({ author: "worker", struggledWith: "the content check" })
  // Recorded facts accompany the worker's own account.
  expect(result.facts).toMatchObject({ attempts: 1 })
  expect(steered).toHaveLength(1)
  expect(result.commits?.some((line) => line.includes("WIP before takeover"))).toBe(true)
  expect(f.events).toContain(`stop:${worker.session_id}`)
  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts.find((a) => a.id === worker.id)!.state).toBe("cancelled")
  const mine = attempts.find((a) => a.id === result.attemptID)!
  expect(mine.state).toBe("running")
  expect(mine.workspace).toBe(worker.workspace)
  expect(JSON.parse(mine.policy).takeover.architectSessionID).toBe("owner")
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("running")
  // A repeated call joins the same takeover and sends nothing again.
  const again = await f.runtime.takeover(
    { attemptID: worker.id, reason: "Not converging", requestID: "take-1" },
    "owner",
  )
  expect(again.takeoverID).toBe(result.takeoverID)
  expect(steered).toHaveLength(1)

  // The scheduler leaves the Architect's attempt alone until it is submitted.
  await drive(f.runtime, 3)
  expect(f.store.attempts(f.receipt.planID).find((a) => a.id === mine.id)!.state).toBe("running")

  writeFileSync(join(worker.workspace, "a.txt"), "a")
  await f.runtime.command(
    {
      requestID: "submit-1",
      planID: f.receipt.planID,
      action: "takeover-submit",
      taskID: worker.task_id,
      reason: "Finished by the Architect",
    },
    "owner",
  )
  await drive(f.runtime, 10)
  const accepted = f.store.attempts(f.receipt.planID).find((a) => a.id === mine.id)!
  expect(accepted.state).toBe("accepted")
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("accepted")
  // The worker's commits are kept under the Architect's result.
  expect(
    git(worker.workspace, ["merge-base", "--is-ancestor", result.head!, accepted.artifact!]),
  ).toBe("")
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
})

// Live LZ-200: the Architect's takeover result was accepted, then combined verification failed
// on it. No command reopened the accepted takeover: takeover-submit wanted a running attempt,
// retained repair a native worker. The Architect now corrects its own work and resubmits.
test("takeover: an accepted takeover held on combined verification is corrected and resubmitted by the Architect", async () => {
  const { f, worker } = await takeoverFixture()
  f.completeWorker(worker.session_id, "interrupted")
  const taken = await f.runtime.takeover({ attemptID: worker.id, reason: "Dead worker" }, "owner")
  expect(taken.status).toBe("taken-over")
  writeFileSync(join(worker.workspace, "a.txt"), "a")
  await submitTakeover(f, worker.task_id, "submit-1")
  await drive(f.runtime, 10)
  const planID = f.receipt.planID
  const accepted = f.store.attempts(planID).find((a) => a.id === taken.attemptID)!
  expect(accepted.state).toBe("accepted")
  f.store.atomic((db) =>
    db
      .query(
        "UPDATE runner_plans SET state='blocked',reason='Combined artifact verification failed',artifact=NULL,version=version+1 WHERE id=?",
      )
      .run(planID),
  )

  git(worker.workspace, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Correct the combined failure",
  ])
  const corrected = git(worker.workspace, ["rev-parse", "HEAD"])
  const resubmitted = (await submitTakeover(f, worker.task_id, "submit-2")) as { status: string }
  expect(resubmitted.status).toBe("takeover-submitted")
  expect(f.store.plan(planID)!.state).toBe("running")
  expect(f.store.nodes(planID)[0]!.state).toBe("verifying")
  await drive(f.runtime, 10)
  const again = f.store.attempts(planID).find((a) => a.id === taken.attemptID)!
  expect(again.state).toBe("accepted")
  expect(again.artifact).toBe(corrected)
  expect(f.store.nodes(planID)[0]!.artifact).toBe(corrected)
  expect(f.store.attempts(planID)).toHaveLength(accepted.number)
  expect(f.store.plan(planID)!.state).toBe("accepted")
})

test("takeover: a worker that writes nothing is stopped when the window passes; uncommitted work is kept", async () => {
  const { f, worker, steered } = await takeoverFixture()
  f.host.steerWorker = async (input) => void steered.push(input.id)
  writeFileSync(join(worker.workspace, "notes.txt"), "half done")
  const result = await f.runtime.takeover({ attemptID: worker.id, reason: "Stalled" }, "owner")
  expect(result.status).toBe("taken-over")
  expect(steered).toHaveLength(1)
  expect(result.handoff?.author).toBe("runtime")
  expect(result.uncommitted?.some((line) => line.endsWith("notes.txt"))).toBe(true)
  expect(result.wipRef).toStartWith("refs/lazers/takeover/")
  expect(readFileSync(join(worker.workspace, "notes.txt"), "utf8")).toBe("half done")
  expect(git(worker.workspace, ["cat-file", "-t", result.wipRef!])).toBe("tree")
  expect(f.events).toContain(`stop:${worker.session_id}`)
})

test("takeover: a worker that already stopped is not notified", async () => {
  const { f, worker, steered } = await takeoverFixture()
  f.host.steerWorker = async (input) => void steered.push(input.id)
  f.completeWorker(worker.session_id, "interrupted")
  const result = await f.runtime.takeover({ attemptID: worker.id, reason: "Dead worker" }, "owner")
  expect(result.status).toBe("taken-over")
  expect(steered).toHaveLength(0)
  expect(result.handoff?.author).toBe("runtime")
})

test("takeover: a call cut short by a reload is finished by the scheduler, notified once, and a repeated call returns it", async () => {
  const { f, worker, steered } = await takeoverFixture({
    takeover: { handoffWindowMs: 60_000, stopWaitMs: 50, pollMs: 5 },
  })
  f.host.steerWorker = async (input) => void steered.push(input.id)
  const cut = new AbortController()
  setTimeout(() => cut.abort(), 40)
  const first = await f.runtime.takeover(
    { attemptID: worker.id, reason: "Reload mid-call", requestID: "take-reload" },
    "owner",
    cut.signal,
  )
  expect(first.status).toBe("in-progress")
  expect(steered).toHaveLength(1)
  // While the window is open the worker keeps running and the scheduler does not verify it.
  await drive(f.runtime, 2)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")

  // A reload: the old process is gone and its scheduler lease has lapsed.
  await f.runtime.stop()
  f.store.atomic((db) => db.query("DELETE FROM runner_leases").run())
  const reloaded = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    takeoverHandoffWindowMs: 60_000,
    takeoverStopWaitMs: 50,
    takeoverPollMs: 5,
  })
  cleanup.push(() => reloaded.stop())
  workerWritesHandoff(f, worker, `takeover:${first.takeoverID}`)
  await drive(reloaded, 4)
  const notices = f.notifications.filter((n) => n.text.includes("takeover-ready"))
  expect(notices).toHaveLength(1)
  const repeated = await reloaded.takeover(
    { attemptID: worker.id, reason: "Reload mid-call", requestID: "take-reload" },
    "owner",
  )
  expect(repeated).toMatchObject({ status: "taken-over", takeoverID: first.takeoverID })
  expect(repeated.handoff?.author).toBe("worker")
  expect(steered).toHaveLength(1)
  await drive(reloaded, 3)
  expect(f.notifications.filter((n) => n.text.includes("takeover-ready"))).toHaveLength(1)
})

test("takeover: cancelling the plan cancels an open takeover", async () => {
  const { f, worker } = await takeoverFixture({
    takeover: { handoffWindowMs: 60_000, stopWaitMs: 50, pollMs: 5 },
  })
  f.host.steerWorker = async () => {}
  const cut = new AbortController()
  setTimeout(() => cut.abort(), 30)
  const open = await f.runtime.takeover(
    { attemptID: worker.id, reason: "Then cancel" },
    "owner",
    cut.signal,
  )
  expect(open.status).toBe("in-progress")
  await f.runtime.command(
    { requestID: "cancel-takeover", planID: f.receipt.planID, action: "cancel", reason: "stop" },
    "owner",
  )
  const latest = f.store.latestTransition<{ takeoverID: string }>(
    f.receipt.planID,
    worker.task_id,
    "TAKEOVER_CANCELLED",
  )
  expect(latest?.takeoverID).toBe(open.takeoverID)
})

test("a worker concern reaches the live Architect while the worker runs, waits out a contact pause, and is sent once", async () => {
  const f = fixture({
    delayed: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    workerSpendCeilingTokens: 1_000_000,
  })
  await runPlan(f)
  await f.runtime.tick()
  const worker = f.store.attempts(f.receipt.planID)[0]!
  f.sessions.get(worker.session_id)!.tokens = 5_000_000
  f.store.setArchitectContact("paused", "operator")
  await drive(f.runtime, 4)
  const bundles = () => f.notifications.filter((n) => n.text.includes("LAZERS recovery bundle"))
  // The concern is recorded, but nothing reaches an Architect while contact is paused.
  expect(
    f.store.latestTransition(f.receipt.planID, worker.task_id, "WORKER_CONCERN_RAISED"),
  ).toBeDefined()
  expect(bundles()).toHaveLength(0)
  f.store.setArchitectContact("enabled", "")
  await drive(f.runtime, 4)
  expect(bundles()).toHaveLength(1)
  expect(bundles()[0]!.sessionID).toBe("owner")
  expect(bundles()[0]!.text).toContain("worker-concern")
  expect(bundles()[0]!.text).toContain("lz-request-handoff")
  // The worker was never held, interrupted or stopped by the concern.
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")
  expect(f.sessions.get(worker.session_id)!.busy).toBe(true)
  expect(f.events).not.toContain(`stop:${worker.session_id}`)
  await drive(f.runtime, 4)
  expect(bundles()).toHaveLength(1)
  // A reload neither raises the concern again nor sends it twice.
  await f.runtime.stop()
  f.store.atomic((db) => db.query("DELETE FROM runner_leases").run())
  const reloaded = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    workerSpendCeilingTokens: 1_000_000,
  })
  cleanup.push(() => reloaded.stop())
  await drive(reloaded, 4)
  expect(bundles()).toHaveLength(1)
  expect(
    f.store
      .activity(f.receipt.planID, worker.task_id)
      .filter((event) => event.event === "WORKER_CONCERN_RAISED"),
  ).toHaveLength(1)
})

test("takeover: a worker handoff that does not fit the fields is kept verbatim as the worker's", async () => {
  const { f, worker } = await takeoverFixture()
  f.host.steerWorker = async () => {
    f.runtime.takeoverHandoff(
      { summary: ["fixed half", "tests still red"], done: 3 },
      worker.session_id,
    )
  }
  const result = await f.runtime.takeover({ attemptID: worker.id, reason: "Odd handoff" }, "owner")
  expect(result.handoff).toMatchObject({ author: "worker", done: "3" })
  expect((result.handoff as { raw?: string }).raw).toContain("tests still red")
  expect(() => f.runtime.takeoverHandoff({ done: "late" }, worker.session_id)).toThrow(
    "No takeover is waiting",
  )
})

test("takeover: a failed verification goes back to the Architect on the same attempt, advertised and bundled, and a resubmission is accepted", async () => {
  let offset = 0
  const { f, worker } = await takeoverFixture({ now: () => Date.now() + offset })
  f.host.steerWorker = async () => {}
  const taken = await f.runtime.takeover({ attemptID: worker.id, reason: "Finish it" }, "owner")
  expect(taken.status).toBe("taken-over")
  const submit = (requestID: string) =>
    f.runtime.command(
      {
        requestID,
        planID: f.receipt.planID,
        action: "takeover-submit",
        taskID: worker.task_id,
        reason: "Architect result",
      },
      "owner",
    )
  // The worker left "wrong" in a.txt; the first submission fails its check.
  await submit("submit-wrong")
  await drive(f.runtime, 8)
  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.state).toBe("blocked")
  expect(plan.reason).toStartWith("Takeover verification failed:")
  const mine = f.store.attempts(f.receipt.planID).find((a) => a.id === taken.attemptID)!
  expect(mine.state).toBe("running")
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("running")
  const notice = f.notifications.findLast((n) => n.text.includes("Takeover verification failed"))
  expect(notice?.text).toContain("takeover-submit")
  // Left unanswered, the hold reaches the recovery bundle with its actions.
  offset += RECOVERY_STALE_MS + 60_000
  await drive(f.runtime, 3)
  const bundle = f.notifications.findLast((n) => n.text.includes("LAZERS recovery bundle"))
  expect(bundle?.text).toContain("takeover-submit")
  // Fixed and submitted again on the same attempt: accepted.
  writeFileSync(join(worker.workspace, "a.txt"), "a")
  await submit("submit-fixed")
  await drive(f.runtime, 10)
  expect(f.store.attempts(f.receipt.planID).find((a) => a.id === mine.id)!.state).toBe("accepted")
  expect(
    f.store
      .activity(f.receipt.planID, worker.task_id)
      .filter((event) => event.event === "TAKEOVER_SUBMITTED"),
  ).toHaveLength(2)
})

test("takeover: every submission is a fresh candidate; the mechanical fix and checks re-run on the resubmitted tree", async () => {
  const { f, worker } = await takeoverFixture({
    taskFiles: [{ name: "a", path: "src/result.ts" }],
    beforeCheck: "grep -q good src/result.ts",
    checkCommand: "bun fmt --check src/result.ts",
    combinedCheckCommand: "test -f src/result.ts",
  })
  f.host.steerWorker = async () => {}
  const taken = await f.runtime.takeover({ attemptID: worker.id, reason: "Finish it" }, "owner")
  expect(taken.status).toBe("taken-over")
  const submit = async (requestID: string, source: string) => {
    writeFileSync(join(worker.workspace, "src/result.ts"), source)
    git(worker.workspace, ["add", "-A"])
    git(worker.workspace, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      requestID,
    ])
    await f.runtime.command(
      {
        requestID,
        planID: f.receipt.planID,
        action: "takeover-submit",
        taskID: worker.task_id,
        reason: "Architect result",
      },
      "owner",
    )
    await drive(f.runtime, 18)
  }
  // Unformatted and wrong: the mechanical fix formats it, then the check fails.
  await submit("submit-1", 'export const x="bad"')
  expect(f.store.plan(f.receipt.planID)!.reason).toStartWith("Takeover verification failed:")
  // Unformatted again, now right: the fix must run again on this tree, not reuse the first receipt.
  await submit("submit-2", 'export const x="good"')
  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.reason ?? "").not.toContain("Mechanical candidate changed")
  const mine = f.store.attempts(f.receipt.planID).find((a) => a.id === taken.attemptID)!
  expect(mine.state).toBe("accepted")
  const fixes = f.store
    .effects(plan.id)
    .filter((effect) => effect.kind === "mechanical-fix" && effect.attempt_id === mine.id)
  expect(fixes.length).toBeGreaterThanOrEqual(2)
})

test("takeover: the stale-attempt settler never fails a takeover attempt for its absent synthetic session", async () => {
  let offset = 0
  // A check that cannot run holds the verification without journaling new effects each tick,
  // as the live mechanical-fix hold did.
  const { f, worker } = await takeoverFixture({
    now: () => Date.now() + offset,
    beforeCheck: "lazers-no-such-command",
  })
  f.host.steerWorker = async () => {}
  const taken = await f.runtime.takeover({ attemptID: worker.id, reason: "Finish it" }, "owner")
  const state = () =>
    f.store.attempts(f.receipt.planID).find((a) => a.id === taken.attemptID)!.state
  writeFileSync(join(worker.workspace, "a.txt"), "a")
  await submitTakeover(f, worker.task_id, "submit-1")
  await drive(f.runtime, 8)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
  expect(state()).toBe("verifying")
  for (let n = 0; n < 4; n++) {
    offset += 120_000
    await f.runtime.tick()
  }
  expect(state()).toBe("verifying")
  expect(
    f.store.latestTransition(f.receipt.planID, worker.task_id, "ATTEMPT_STALE_SETTLED"),
  ).toBeUndefined()
  // A held verification is resubmitted as a new candidate.
  const resubmitted = (await submitTakeover(f, worker.task_id, "submit-2")) as { status: string }
  expect(resubmitted.status).toBe("takeover-submitted")
  expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
  expect(
    f.store.attempts(f.receipt.planID).find((a) => a.id === taken.attemptID)!.message_id,
  ).toEndWith("submission-2")
})

test("takeover: an abandoned takeover holds for any live Architect, is bundled, and continues on takeover-submit", async () => {
  let offset = 0
  const { f, worker } = await takeoverFixture({ now: () => Date.now() + offset })
  f.host.steerWorker = async () => {}
  const taken = await f.runtime.takeover({ attemptID: worker.id, reason: "Finish it" }, "owner")
  f.sessions.get("owner")!.archived = true
  f.sessions.set("owner-2", {
    ...structuredClone(f.sessions.get("owner")!),
    id: "owner-2",
    archived: false,
  })
  await drive(f.runtime, 3)
  const plan = f.store.plan(f.receipt.planID)!
  expect(plan.state).toBe("blocked")
  expect(plan.reason).toStartWith("Takeover abandoned:")
  expect(f.store.attempts(plan.id).find((a) => a.id === taken.attemptID)!.state).toBe("running")
  offset += RECOVERY_STALE_MS + 60_000
  await drive(f.runtime, 3)
  const bundle = f.notifications.findLast((n) => n.text.includes("LAZERS recovery bundle"))
  expect(bundle?.text).toContain("Takeover abandoned")
  expect(bundle?.text).toContain("takeover-submit")
  writeFileSync(join(worker.workspace, "a.txt"), "a")
  await submitTakeover(f, worker.task_id, "submit-by-successor", "owner-2")
  await drive(f.runtime, 10)
  expect(f.store.attempts(plan.id).find((a) => a.id === taken.attemptID)!.state).toBe("accepted")
})

test("takeover: from a failed takeover attempt on a held plan, lz-request-handoff and takeover-submit continue the committed work", async () => {
  const { f, worker } = await takeoverFixture()
  f.host.steerWorker = async () => {}
  const first = await f.runtime.takeover({ attemptID: worker.id, reason: "Finish it" }, "owner")
  // The live LZ-200 state: the Architect committed its fix, the takeover attempt was failed by the
  // stale settler while its verification was held, the node stayed verifying.
  writeFileSync(join(worker.workspace, "a.txt"), "a")
  git(worker.workspace, ["add", "-A"])
  git(worker.workspace, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Architect fix",
  ])
  const architectCommit = git(worker.workspace, ["rev-parse", "HEAD"])
  f.store.move(f.receipt.planID, worker.task_id, "VERIFY")
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(first.attemptID!)
    db.query(
      "UPDATE runner_plans SET state='blocked',reason='Mechanical candidate changed after its authorized fix receipt; no stale artifact was accepted' WHERE id=?",
    ).run(f.receipt.planID)
  })
  const steersBefore = f.events.filter((e) => e.startsWith("stop:")).length
  const again = await f.runtime.takeover(
    { attemptID: first.attemptID!, reason: "Continue the takeover" },
    "owner",
  )
  expect(again.status).toBe("taken-over")
  expect(again.handoff?.author).toBe("runtime")
  expect(again.head).toBe(architectCommit)
  expect(again.commits?.some((line) => line.includes("Architect fix"))).toBe(true)
  expect(f.events.filter((e) => e.startsWith("stop:")).length).toBe(steersBefore)
  const second = f.store.attempts(f.receipt.planID).find((a) => a.id === again.attemptID)!
  expect(second.workspace).toBe(worker.workspace)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
  await submitTakeover(f, worker.task_id, "submit-continued")
  await drive(f.runtime, 10)
  const accepted = f.store.attempts(f.receipt.planID).find((a) => a.id === again.attemptID)!
  expect(accepted.state).toBe("accepted")
  expect(
    git(worker.workspace, ["merge-base", "--is-ancestor", architectCommit, accepted.artifact!]),
  ).toBe("")
})

test("84e85b0f-1: a notice claimed before a restart does not strand the takeover in notifying", async () => {
  const { f, worker, steered } = await takeoverFixture()
  f.host.steerWorker = async (input) => {
    steered.push(input.id)
  }
  const input = { attemptID: worker.id, reason: "Hung tool call", requestID: "take-crash" }
  // The crash: the claim was persisted, the notice was never sent, the worker stays busy.
  const row = await (f.runtime as any).takeovers.start(input, "owner")
  f.store.atomic((db) =>
    db
      .query(
        "UPDATE runner_takeovers SET payload=json_set(payload,'$.noticeSent',json('true')) WHERE id=?",
      )
      .run(row.id),
  )
  const result = await f.runtime.takeover(input, "owner")
  expect(result.status).toBe("taken-over")
  expect(steered).toEqual([])
})

test("84e85b0f-2: a finished takeover does not keep its plan out of retention", async () => {
  const { f, worker } = await takeoverFixture()
  f.completeWorker(worker.session_id, "interrupted")
  const taken = await f.runtime.takeover({ attemptID: worker.id, reason: "Dead worker" }, "owner")
  expect(taken.status).toBe("taken-over")
  const planID = f.receipt.planID
  // The plan integrated long ago.
  f.store.atomic((db) => {
    db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(planID)
    db.query("UPDATE runner_attempts SET state='failed', started_at=1 WHERE plan_id=?").run(planID)
    db.query("UPDATE runner_transitions SET created_at=1 WHERE plan_id=?").run(planID)
  })
  const { retired, kept } = classifyPlans(
    f.repository.read((db) => db),
    Date.now(),
    30,
  )
  expect([...kept.keys()].join("\n")).not.toContain("handoff is open")
  expect(retired.map((plan) => plan.id)).toContain(planID)
})

test("7abe4acd-2: a handoff saved while a host read is in flight survives the transition", async () => {
  const { f, worker } = await takeoverFixture({
    takeover: { handoffWindowMs: 60_000, stopWaitMs: 50, pollMs: 5 },
  })
  f.host.steerWorker = async () => {}
  const takeovers = (f.runtime as any).takeovers
  const row = await takeovers.start(
    { attemptID: worker.id, reason: "Not converging", requestID: "take-race" },
    "owner",
  )
  await takeovers.advance(row) // notifying -> awaiting-handoff
  const read = f.host.session.bind(f.host)
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  f.host.session = async (id: string, options?: never) => {
    const session = await read(id, options)
    await gate
    // By the time the read returns, the worker's turn has ended.
    return session && id === worker.session_id ? { ...session, busy: false } : session
  }
  const advancing = takeovers.advance(takeovers.open(f.receipt.planID)[0])
  await Bun.sleep(20)
  f.runtime.takeoverHandoff({ done: "half", remaining: "the final warning" }, worker.session_id)
  release()
  await advancing
  const saved = f.store.read(
    (db) =>
      JSON.parse(
        db
          .query<{ payload: string }, [string]>("SELECT payload FROM runner_takeovers WHERE id=?")
          .get(row.id)!.payload,
      ) as { workerHandoff?: { remaining?: string } },
  )
  expect(saved.workerHandoff?.remaining).toBe("the final warning")
})
