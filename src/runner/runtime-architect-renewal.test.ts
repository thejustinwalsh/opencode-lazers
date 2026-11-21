import { expect, test } from "bun:test"
import type { RunnerHost } from "./host.ts"
import { DEFAULT_ARCHITECT_CACHE_WINDOW_MS } from "./architect-routing.ts"
import { architectIdleWindowMs } from "./runtime.ts"
import { privacyStats } from "../trajectory/privacy.ts"
import { ModelMappingStore } from "../models/mapping-store.ts"
import {
  TaskRuntime,
  cleanup,
  codeProject,
  drive,
  fixture,
  prepareIdleArchitect,
  queueArchitectNotice,
  runPlan,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("the registered scheduler reuses recent/busy Architects and renews at the default threshold", async () => {
  const now = 2_000_000_000_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  codeProject(f, "ONS")
  expect(architectIdleWindowMs(undefined)).toBe(5 * 60 * 1000)
  expect(DEFAULT_ARCHITECT_CACHE_WINDOW_MS).toBe(5 * 60 * 1000)
  expect(() => architectIdleWindowMs(0)).toThrow("positive integer")
  const attempt = await prepareIdleArchitect(f, now, 0)
  const owner = f.sessions.get("owner")!
  owner.messages.push({ id: "old-transcript", text: "SECRET_TRANSCRIPT_SHOULD_NOT_REPLAY" })
  await f.runtime.recordArchitectContinuity(owner.id, {
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  owner.idleAt = now - DEFAULT_ARCHITECT_CACHE_WINDOW_MS + 1

  await f.runtime.tick()
  expect(f.store.architectRenewalsNeedingRecovery()).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(0)
  expect(owner.archived).toBe(false)

  owner.idleAt = now - DEFAULT_ARCHITECT_CACHE_WINDOW_MS
  // The warm owner already received the first notice; renewal waits for new news.
  queueArchitectNotice(f)
  const peer = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    architectPromptHook: true,
    now: () => now,
  })
  cleanup.push(() => peer.stop())
  const createInputs: Parameters<RunnerHost["createArchitect"]>[0][] = []
  const create = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    createInputs.push(input)
    await create(input)
  }
  const update = f.host.updateSession!
  let archiveSawDurableTransfer = false
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
      const handoff = f.store
        .outboxForDelivery()
        .find((row) => row.id === renewal.handoff_outbox_id)
      expect(renewal.state).toBe("archiving")
      expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
      expect(handoff?.state).toBe("pending")
      archiveSawDurableTransfer = true
    }
    await update(input)
  }

  await Promise.all([f.runtime.tick(), peer.tick()])

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successor = f.sessions.get(renewal.successor_session_id)!
  expect(renewal.state).toBe("committed")
  expect(archiveSawDurableTransfer).toBe(true)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successor.id)
  expect(owner.archived).toBe(true)
  expect(successor.parentID).toBeUndefined()
  expect(successor.model).toEqual(owner.model)
  expect(f.store.architectContinuity(successor.id)).toMatchObject({
    revision: 2,
    decisions: JSON.stringify(["Keep the existing approved implementation direction."]),
    unresolved_questions: JSON.stringify(["Confirm whether the follow-up needs additional scope."]),
  })
  expect(successor.metadata?.lazersPlanID).toBe(f.receipt.planID)
  expect(successor.metadata?.lazersPlanIDs).toContain(f.receipt.planID)
  expect(createInputs).toHaveLength(1)
  expect(createInputs[0]).toMatchObject({
    planID: f.receipt.planID,
    sourceSessionID: "owner",
    title: expect.stringMatching(/^ONS · .*Implement a/),
    model: owner.model,
  })
  expect(f.store.attempts(f.receipt.planID)[0]?.session_id).toBe(attempt.session_id)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  expect(owner.messages).toEqual([
    { id: "old-transcript", text: "SECRET_TRANSCRIPT_SHOULD_NOT_REPLAY" },
  ])
  await f.runtime.tick()
  const wake = f.notifications.find(
    (notice) =>
      notice.sessionID === successor.id && notice.text.includes("Architect continuity handoff"),
  )!
  expect(wake.text).toContain("lz-inspect-plan")
  expect(wake.text).toContain("Keep the existing approved implementation direction.")
  expect(wake.text).toContain("Confirm whether the follow-up needs additional scope.")
  expect(wake.text).not.toContain("SECRET_TRANSCRIPT_SHOULD_NOT_REPLAY")
  // The handoff is the only notice: the retained source's journal is not announced.
  expect(f.inbox.get(successor.id)).toHaveLength(1)
  expect(
    f.notifications.some(
      (notice) =>
        notice.sessionID === successor.id &&
        notice.text.includes("LAZERS Architect source changed"),
    ),
  ).toBe(false)
  expect(f.store.architectSourceInputs("owner").map((input) => input.message_id)).toContain(
    "old-transcript",
  )
  expect(wake.resume).toBe(true)
  const committed = f.store.latestTransition<{ wakeContext: { bytes: number; tokens: null } }>(
    f.receipt.planID,
    null,
    "ARCHITECT_RENEWAL_COMMITTED",
  )!
  // The notice that triggered the renewal rides in the same wake as the handoff.
  expect(new TextEncoder().encode(wake.text).byteLength).toBeGreaterThan(
    committed.wakeContext.bytes,
  )
  expect(wake.text).toContain("Awaiting Architect judgement")
  expect(committed.wakeContext.tokens).toBeNull()
  expect(committed.wakeContext.bytes).toBeGreaterThan(0)
})

test("a cold Architect with a small context is reused on every tick, never renewed", async () => {
  const now = 2_000_000_200_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, DEFAULT_ARCHITECT_CACHE_WINDOW_MS * 4)
  const owner = f.sessions.get("owner")!
  owner.contextTokens = 12_000
  const count = (event: string) =>
    f.repository.read(
      (db) =>
        db
          .query<{ n: number }, [string]>(
            "SELECT count(*) AS n FROM runner_transitions WHERE event=?",
          )
          .get(event)!.n,
    )
  const watched = [
    "ARCHITECT_RENEWAL_STARTED",
    "ARCHITECT_RENEWAL_COMMITTED",
    "OWNER_CONTINUED",
    "ARCHITECT_ROUTED",
  ]
  const before = watched.map(count)
  for (let tick = 0; tick < 12; tick++) await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(0)
  expect(f.store.architectRenewalForPlan(f.receipt.planID)).toBeFalsy()
  expect(owner.archived).toBe(false)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  const after = watched.map(count)
  expect(after[0]).toBe(before[0]!)
  expect(after[1]).toBe(before[1]!)
  expect(after[2]).toBe(before[2]!)
  // The routing decision is recorded once per change, not once per tick.
  expect(after[3]! - before[3]!).toBeLessThanOrEqual(1)
})

test("a cold Architect with a large context is renewed exactly once", async () => {
  const now = 2_000_000_300_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, DEFAULT_ARCHITECT_CACHE_WINDOW_MS * 4)
  const owner = f.sessions.get("owner")!
  owner.contextTokens = 180_000
  for (let tick = 0; tick < 12; tick++) await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("committed")
  expect(owner.archived).toBe(true)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
})

// Live: an idle Architect lineage renewed about five times an hour for a day (130 committed
// renewals), each successor cold and over the reuse threshold five minutes after its handoff.
test("an idle, cold, large Architect with nothing new to deliver is never renewed", async () => {
  const now = 2_000_000_320_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, DEFAULT_ARCHITECT_CACHE_WINDOW_MS * 4, false)
  const owner = f.sessions.get("owner")!
  owner.contextTokens = 60_000
  const notified = f.notifications.length
  for (let tick = 0; tick < 24; tick++) await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(0)
  expect(f.events.filter((event) => event.startsWith("update-session:"))).toHaveLength(0)
  expect(f.notifications).toHaveLength(notified)
  expect(f.store.architectRenewalForPlan(f.receipt.planID)).toBeFalsy()
  expect(owner.archived).toBe(false)
})

test("a new notice for a cold, large Architect renews once; the idle successor is left alone", async () => {
  const now = 2_000_000_330_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, DEFAULT_ARCHITECT_CACHE_WINDOW_MS * 4, false)
  f.sessions.get("owner")!.contextTokens = 60_000
  for (let tick = 0; tick < 4; tick++) await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(0)

  queueArchitectNotice(f)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("committed")
  const successor = f.sessions.get(renewal.successor_session_id)!
  expect(f.inbox.get(successor.id)).toHaveLength(1)

  // The successor handled its handoff and went idle over the threshold, as live successors do.
  successor.busy = false
  successor.idleAt = now - DEFAULT_ARCHITECT_CACHE_WINDOW_MS * 4
  successor.contextTokens = 60_000
  for (let tick = 0; tick < 24; tick++) await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successor.id)
})

test("ownership-only version bumps do not re-send the closeout reminder for one accepted artifact", async () => {
  const now = 2_000_000_340_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 0, false)
  const artifact = f.store.attempts(f.receipt.planID)[0]!.base_commit
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_plans SET state='accepted',reason=NULL,artifact=? WHERE id=?")
      .run(artifact, f.receipt.planID),
  )
  const reminders = () =>
    f.store.atomic((db) =>
      db
        .query<{ id: string }, [string]>(
          "SELECT id FROM runner_outbox WHERE plan_id=? AND json_extract(payload,'$.closeoutReminder')=1",
        )
        .all(f.receipt.planID),
    )
  await f.runtime.tick()
  expect(reminders()).toHaveLength(1)
  // Each renewal transfer bumps the plan version without changing what the reminder says.
  for (let renewal = 0; renewal < 5; renewal++) {
    f.store.atomic((db) =>
      db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(f.receipt.planID),
    )
    await f.runtime.tick()
  }
  expect(reminders()).toHaveLength(1)
  expect(f.store.closeoutReviewPlanIDs()).not.toContain(f.receipt.planID)
})

// Live LZ-200 (renewal b298778b): the predecessor ran gpt-6.1-sol/high, the shared Architect
// route was gpt-6.1-sol with no effort. The successor was created on the route, the renewal
// recorded the predecessor's model, and every tick refused the successor it had created.
test("a renewal records and creates its successor on the configured Architect route", async () => {
  const now = 2_000_000_310_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const configured = { providerID: "openai", id: "subscription" }
  expect(
    new ModelMappingStore(f.repository).update({
      target: { scope: "shared" },
      persona: "architect",
      expectedRevision: 0,
      route: configured,
    }).status,
  ).toBe("updated")
  await prepareIdleArchitect(f, now, DEFAULT_ARCHITECT_CACHE_WINDOW_MS * 4)
  const owner = f.sessions.get("owner")!
  expect(owner.model).toEqual({ ...configured, variant: "high" })
  owner.contextTokens = 180_000
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(JSON.parse(renewal.model)).toEqual(configured)
  expect(f.sessions.get(renewal.successor_session_id)?.model).toEqual(configured)
  expect(renewal.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
})

// The recorded live state: a renewal still `creating` whose successor exists on another route.
// Its identity cannot change, so the renewal defers once and the plan's own step runs again.
test("a renewal whose existing successor has another identity defers once instead of retrying every tick", async () => {
  const now = 2_000_000_320_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, DEFAULT_ARCHITECT_CACHE_WINDOW_MS * 4)
  const owner = f.sessions.get("owner")!
  owner.contextTokens = 180_000
  const create = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    await create(input)
    f.sessions.get(input.id)!.model = { providerID: "openai", id: "subscription" }
  }
  const events = (...names: string[]) =>
    f.store.atomic((db) =>
      db
        .query<{ event: string }, [string]>(
          "SELECT event FROM runner_transitions WHERE plan_id=? ORDER BY id",
        )
        .all(f.receipt.planID)
        .filter((row) => !names.length || names.includes(row.event)),
    )
  for (let tick = 0; tick < 4; tick++) await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("deferred")
  expect(renewal.error).toBe("Native Architect renewal ID belongs to another session or route")
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
  expect(events("ARCHITECT_RENEWAL_RECOVERY_FAILED", "PLAN_STEP_FAILED")).toHaveLength(0)
  expect(events("ARCHITECT_RENEWAL_DEFERRED")).toHaveLength(1)
  // The predecessor keeps the plan; nothing was archived or transferred.
  expect(owner.archived).toBe(false)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  // The deferred renewal is not retried onto the foreign successor, and says so once.
  const after = events().length
  for (let tick = 0; tick < 4; tick++) await f.runtime.tick()
  expect(f.store.architectRenewal(renewal.id)?.state).toBe("deferred")
  expect(events("ARCHITECT_RENEWAL_RETRY_BLOCKED")).toHaveLength(1)
  expect(events().slice(after)).toEqual([])
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
})

test("idle-window overrides, busy sessions, unsupported hooks, and pre-create input fail closed", async () => {
  const now = 2_000_000_100_000
  expect(architectIdleWindowMs(5_000)).toBe(5_000)

  const overridden = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 5_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(overridden, now, 4_999)
  await overridden.runtime.tick()
  expect(overridden.events.filter((event) => event.startsWith("create-architect:")).length).toBe(0)
  overridden.sessions.get("owner")!.idleAt = now - 5_000
  queueArchitectNotice(overridden)
  await overridden.runtime.tick()
  expect(overridden.store.architectRenewalForPlan(overridden.receipt.planID)?.state).toBe(
    "committed",
  )

  for (const scenario of ["busy", "unsupported-hook", "input-before-create"] as const) {
    const f = fixture({
      delayed: true,
      architectPromptHook: scenario !== "unsupported-hook",
      architectIdleWindowMs: 5_000,
      now: () => now,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    await prepareIdleArchitect(f, now, 5_000)
    const owner = f.sessions.get("owner")!
    if (scenario === "busy") owner.busy = true
    if (scenario === "input-before-create") {
      await f.runtime.observeArchitectPrompt(owner.id, "pre-create-user-message")
      await f.runtime.observeArchitectPrompt(owner.id, "pre-create-user-message")
      expect(
        f.store.atomic(
          (db) =>
            db
              .query<{ count: number }, [string]>(
                "SELECT count(*) AS count FROM runner_architect_inputs WHERE session_id=?",
              )
              .get(owner.id)!.count,
        ),
      ).toBe(1)
    }
    await f.runtime.tick()
    expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(0)
    expect(f.events.filter((event) => event.startsWith("update-session:")).length).toBe(0)
    expect(owner.archived).toBe(false)
  }
})

test("Architect renewal waits for native questions and permissions to clear", async () => {
  const now = 2_000_000_124_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
  })
  await prepareIdleArchitect(f, now, 1_000)
  const owner = f.sessions.get("owner")!
  owner.pendingForms = 1
  await f.runtime.tick()
  owner.pendingForms = 0
  owner.pendingPermissions = 1
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.events.some((event) => event.startsWith("create-architect:"))).toBe(false)
  expect(owner.archived).toBe(false)

  owner.pendingPermissions = 0
  queueArchitectNotice(f)
  await f.runtime.tick()
  expect(f.store.architectRenewalForPlan(f.receipt.planID)?.state).toBe("committed")
})

test("renewal requires an explicit checkpoint and retains queued native inputs by ID", async () => {
  const now = 2_000_000_125_000
  const missingCheckpoint = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(missingCheckpoint)
  await drive(missingCheckpoint.runtime, 2)
  missingCheckpoint.sessions.get("owner")!.idleAt = now - 1_000
  await missingCheckpoint.runtime.tick()
  expect(
    missingCheckpoint.store.architectRenewalForPlan(missingCheckpoint.receipt.planID),
  ).toBeNull()
  expect(missingCheckpoint.events.some((event) => event.startsWith("create-architect:"))).toBe(
    false,
  )
  expect(missingCheckpoint.sessions.get("owner")?.archived).toBe(false)

  const reconciledHost = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(reconciledHost, now, 1_000)
  const foreign = {
    id: "msg_external_queue_before_creation",
    type: "synthetic",
    delivery: "queue",
    metadata: { source: "another-plugin" },
  }
  reconciledHost.inbox.set("owner", [foreign])
  await reconciledHost.runtime.tick()
  const renewal = reconciledHost.store.architectRenewalForPlan(reconciledHost.receipt.planID)!
  expect(renewal.state).toBe("committed")
  expect(reconciledHost.store.plan(reconciledHost.receipt.planID)?.owner).toBe(
    renewal.successor_session_id,
  )
  expect(
    reconciledHost.events.filter((event) => event === "update-session:owner:true"),
  ).toHaveLength(1)
  expect(reconciledHost.inbox.get("owner")).toEqual([foreign])
  expect(reconciledHost.sessions.get("owner")?.archived).toBe(true)
  expect(reconciledHost.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: foreign.id, disposition: "pending" }),
  )
  expect(
    reconciledHost.notifications.some((notification) =>
      notification.text.includes("LAZERS Architect source changed"),
    ),
  ).toBe(false)
  expect(
    reconciledHost.notifications.some((notification) => notification.text.includes(foreign.id)),
  ).toBe(false)
})

test("one successor receives every live plan owned by the same Architect", async () => {
  const now = 2_000_000_150_000
  const f = fixture({
    delayed: true,
    independent: true,
    architectPromptHook: true,
    architectIdleWindowMs: 5_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a/a.txt" }],
  })
  const taskB = f.createTask("b", "b/b.txt")
  const planB = f.store.submit(f.inputFor([taskB], { requestID: "second-owner-plan" }), "owner")
  await runPlan(f)
  await runPlan(f, planB.planID, "run-second-owner-plan")
  await drive(f.runtime, 2)
  await f.runtime.recordArchitectContinuity("owner", {
    decisions: ["Keep both task plans under the current Architect."],
    unresolvedQuestions: ["Confirm cross-plan ordering after integration."],
  })
  const attempts = [f.store.attempts(f.receipt.planID)[0]!, f.store.attempts(planB.planID)[0]!]
  expect(attempts.every((attempt) => f.sessions.get(attempt.session_id)?.busy)).toBe(true)
  f.sessions.get("owner")!.idleAt = now - 5_000
  f.store.atomic((db) =>
    db
      .query(
        "UPDATE runner_plans SET state='blocked',reason='Awaiting Architect judgement' WHERE owner='owner'",
      )
      .run(),
  )
  queueArchitectNotice(f)

  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successor = f.sessions.get(renewal.successor_session_id)!
  expect(renewal.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successor.id)
  expect(f.store.plan(planB.planID)?.owner).toBe(successor.id)
  expect(successor.metadata?.lazersPlanIDs).toEqual([f.receipt.planID, planB.planID].sort())
  expect(f.store.continuation(f.receipt.planID)?.session_id).toBe(successor.id)
  expect(f.store.continuation(planB.planID)?.session_id).toBe(successor.id)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
  expect(attempts.map((attempt) => f.store.attempts(attempt.plan_id)[0]?.session_id)).toEqual(
    attempts.map((attempt) => attempt.session_id),
  )
  expect(attempts.every((attempt) => f.sessions.get(attempt.session_id)?.busy)).toBe(true)
  const handoff = (f.store.detail(f.receipt.planID).delivery as { payload: string }[]).find(
    (row) => JSON.parse(row.payload).status === "architect-handoff",
  )!
  expect(JSON.parse(handoff.payload).planIDs).toEqual([f.receipt.planID, planB.planID].sort())
  expect(JSON.parse(handoff.payload).continuity).toEqual({
    revision: 1,
    decisions: ["Keep both task plans under the current Architect."],
    unresolvedQuestions: ["Confirm cross-plan ordering after integration."],
  })
})

test("input during a deferred native create prevents transfer and predecessor archival", async () => {
  const now = 2_000_000_200_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const create = f.host.createArchitect
  let startCreate!: () => void
  let releaseCreate!: () => void
  const started = new Promise<void>((resolve) => (startCreate = resolve))
  const gate = new Promise<void>((resolve) => (releaseCreate = resolve))
  f.host.createArchitect = async (input) => {
    startCreate()
    await gate
    await create(input)
  }

  const tick = f.runtime.tick()
  await started
  await f.runtime.observeArchitectPrompt("owner", "input-during-create")
  f.sessions.get("owner")!.messages.push({ id: "input-during-create", text: "Keep this input" })
  releaseCreate()
  await tick

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("deferred")
  expect(renewal.input_message_id).toBe("input-during-create")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(f.events.filter((event) => event.startsWith("update-session:")).length).toBe(0)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("a continuity edit during successor creation blocks stale ownership transfer", async () => {
  const now = 2_000_000_205_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const create = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    await create(input)
    await f.runtime.recordArchitectContinuity("owner", {
      decisions: ["Use the revised approved direction."],
      unresolvedQuestions: ["Confirm the revised rollout."],
    })
  }

  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("deferred")
  expect(renewal.error).toContain("continuity changed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(f.store.architectContinuity("owner")).toMatchObject({
    revision: 2,
    decisions: JSON.stringify(["Use the revised approved direction."]),
    unresolved_questions: JSON.stringify(["Confirm the revised rollout."]),
  })
  expect(f.store.architectContinuity(renewal.successor_session_id)).toBeNull()
  expect(f.notifications).toHaveLength(0)
})

test("native queued synthetic input is retained and referenced across creation, transfer, and archive", async () => {
  const phases = ["creation", "transfer", "archive"] as const
  for (const [index, phase] of phases.entries()) {
    const now = 2_000_000_210_000 + index * 10_000
    const f = fixture({
      delayed: true,
      architectPromptHook: true,
      architectIdleWindowMs: 1_000,
      now: () => now,
      taskFiles: [{ name: "a", path: `a-${phase}.txt` }],
    })
    await prepareIdleArchitect(f, now, 1_000)
    const foreign = {
      id: `msg_synthetic_${phase}`,
      type: "synthetic",
      delivery: "queue",
      metadata: { source: "another-plugin" },
    }
    if (phase === "creation") {
      const create = f.host.createArchitect
      f.host.createArchitect = async (input) => {
        await create(input)
        f.inbox.set("owner", [foreign])
      }
    } else if (phase === "transfer") {
      const transfer = f.store.transferArchitectRenewal.bind(f.store)
      f.store.transferArchitectRenewal = (input) => {
        const result = transfer(input)
        f.inbox.set("owner", [foreign])
        return result
      }
    } else {
      const update = f.host.updateSession!
      f.host.updateSession = async (input) => {
        if (input.sessionID === "owner" && input.archived) f.inbox.set("owner", [foreign])
        await update(input)
      }
    }

    await f.runtime.tick()

    const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
    expect(renewal.state).toBe("committed")
    expect(f.inbox.get("owner")).toEqual([foreign])
    expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
    expect(f.sessions.get("owner")?.archived).toBe(true)
    expect(f.store.architectRenewalHasInput(renewal.id)).toBe(true)
    expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(1)
    expect(
      (f.store.detail(f.receipt.planID).delivery as { state: string; payload: string }[]).find(
        (row) => JSON.parse(row.payload).status === "architect-handoff",
      )?.state,
    ).toBe("delivered")
    expect(
      f.notifications.some((notification) =>
        notification.text.includes("LAZERS Architect source changed"),
      ),
    ).toBe(false)
    expect(f.notifications.some((notification) => notification.text.includes(foreign.id))).toBe(
      false,
    )
    expect(f.store.architectSourceInputs("owner").map((input) => input.message_id)).toContain(
      foreign.id,
    )
  }
})

test("late input on an archived predecessor is reconciled to the current owner without waking or replay", async () => {
  const now = 2_000_000_275_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "late-input.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const currentOwner = renewal.successor_session_id
  expect(renewal.state).toBe("committed")
  expect(f.sessions.get("owner")?.archived).toBe(true)

  const late = {
    id: "msg_late_after_archive",
    type: "synthetic",
    delivery: "queue",
    metadata: { source: "another-plugin" },
  }
  f.inbox.set("owner", [late])
  const before = f.notifications.length
  await f.runtime.tick()

  expect(f.store.plan(f.receipt.planID)?.owner).toBe(currentOwner)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.inbox.get("owner")).toEqual([late])
  expect(f.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: late.id, disposition: "pending" }),
  )
  // A journal change on the retained source is not an event the Architect must be told about.
  const afterArchive = f.notifications.slice(before)
  expect(afterArchive.some((notification) => notification.text.includes("source changed"))).toBe(
    false,
  )
  expect(afterArchive.some((notification) => notification.text.includes(late.id))).toBe(false)
  expect(
    f.inbox
      .get(currentOwner)
      ?.filter((entry) => entry.metadata?.lazersStatus === "architect-source-change") ?? [],
  ).toHaveLength(0)
  await f.runtime.tick()
  expect(f.notifications.slice(before)).toEqual(afterArchive)
})

test("predecessor reconciliation persists native message pagination across scheduler ticks", async () => {
  const now = 2_000_000_280_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "paged-source.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const pages: (string | undefined)[] = []
  f.host.architectInputPage = async (_sessionID, cursor) => {
    pages.push(cursor)
    return cursor
      ? {
          inbox: [],
          messages: [{ id: "msg_page_two_input", type: "user" }],
          nextCursor: null,
        }
      : { inbox: [], messages: [], nextCursor: "page-two" }
  }

  await f.runtime.tick()
  expect(f.store.architectSource(renewal.previous_session_id)?.scan_cursor).toBe("page-two")
  expect(f.store.architectSourceInputs(renewal.previous_session_id)).not.toContainEqual(
    expect.objectContaining({ message_id: "msg_page_two_input" }),
  )
  await f.runtime.tick()

  expect(pages).toEqual([undefined, "page-two"])
  expect(f.store.architectSource(renewal.previous_session_id)?.scan_cursor).toBeNull()
  expect(f.store.architectSourceInputs(renewal.previous_session_id)).toContainEqual(
    expect.objectContaining({ message_id: "msg_page_two_input", disposition: "delivered" }),
  )
  expect(
    f.notifications.some(
      (notification) =>
        notification.sessionID === renewal.successor_session_id &&
        notification.text.includes("LAZERS Architect source changed"),
    ),
  ).toBe(false)
  expect(
    f.notifications.some((notification) => notification.text.includes("msg_page_two_input")),
  ).toBe(false)
})

test("selected source-message retrieval is current-owner authorized and journal-ID bounded", async () => {
  const now = 2_000_000_280_500
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "selected-source-message.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  f.host.architectInputPage = async () => ({
    inbox: [],
    messages: [
      { id: "msg_selected_source_input", type: "user" },
      {
        id: "msg_selected_source_result",
        type: "assistant",
        result: {
          state: "completed",
          finish: "stop",
          toolCounts: { running: 0, completed: 1, failed: 0, other: 0 },
        },
      },
    ],
    nextCursor: null,
  })
  await f.runtime.tick()
  const calls: string[] = []
  f.host.architectSourceMessage = async (sessionID, messageID) => {
    calls.push(`${sessionID}:${messageID}`)
    return {
      id: messageID,
      type: messageID.endsWith("input") ? "user" : "assistant",
      text: messageID.endsWith("input") ? "selected safe input" : "selected safe result",
      privacy: { ...privacyStats() },
    }
  }
  const response = await f.runtime.inspectArchitectSourceMessages(
    {
      planID: f.receipt.planID,
      view: "source-messages",
      sourceSessionID: renewal.previous_session_id,
      messageIDs: ["msg_selected_source_input", "msg_selected_source_result"],
    },
    renewal.successor_session_id,
  )
  expect(calls).toEqual(["owner:msg_selected_source_input", "owner:msg_selected_source_result"])
  expect(response).toMatchObject({
    mode: "source-messages",
    selected: 2,
    coverage: {
      authenticatedNativeRead: true,
      privacyFiltered: true,
      transcriptCompleteness: "unknown",
      nativeConsumption: "unknown",
    },
    messages: [
      { id: "msg_selected_source_input", kind: "input", type: "user" },
      { id: "msg_selected_source_result", kind: "result", type: "assistant" },
    ],
  })
  await expect(
    f.runtime.inspectArchitectSourceMessages(
      {
        planID: f.receipt.planID,
        view: "source-messages",
        sourceSessionID: renewal.previous_session_id,
        messageIDs: ["msg_not_in_journal"],
      },
      renewal.successor_session_id,
    ),
  ).rejects.toThrow("Every selected message ID must identify a journaled source input or result")
  await expect(
    f.runtime.inspectArchitectSourceMessages(
      {
        planID: f.receipt.planID,
        view: "source-messages",
        sourceSessionID: renewal.previous_session_id,
        messageIDs: ["msg_selected_source_input"],
      },
      "owner",
    ),
  ).rejects.toThrow("current plan owner")
})

test("large predecessor histories stay in the journal and produce no notice about it", async () => {
  const now = 2_000_000_281_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "bounded-references.txt" }],
  })
  const ids = Array.from(
    { length: 45 },
    (_, index) => `msg_reference_${index.toString().padStart(2, "0")}`,
  )
  f.host.architectInputPage = async () => ({
    inbox: [],
    messages: ids.map((id) => ({ id, type: "user" })),
    nextCursor: null,
  })
  await prepareIdleArchitect(f, now, 1_000)

  await f.runtime.tick()
  await f.runtime.tick()
  await f.runtime.tick()

  const rows = f.store.detail(f.receipt.planID).delivery as { payload: string }[]
  const payloads = rows.map((row) => JSON.parse(row.payload))
  expect(payloads.some((payload) => String(payload.status).startsWith("architect-source"))).toBe(
    false,
  )
  expect(payloads.find((payload) => payload.status === "architect-handoff")).not.toHaveProperty(
    "inputSources",
  )
  expect(f.notifications.some((notification) => notification.text.includes("source changed"))).toBe(
    false,
  )
  expect(f.notifications.some((notification) => notification.text.includes(ids[0]!))).toBe(false)
  const journal = f.store.architectSourceJournalPage(f.receipt.planID, 100)
  expect(journal.page.hasMore).toBe(false)
  expect(journal.records).toHaveLength(46)
  expect(
    journal.records.some((record) => record.kind === "input" && record.messageID === ids[0]),
  ).toBe(true)
})

test("a previously seen pending input that disappears without history stays unknown, never cancelled or replayed", async () => {
  const now = 2_000_000_282_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "unknown-input.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const late = {
    id: "msg_disappeared_without_transcript",
    type: "user",
    delivery: "queue",
  }
  f.inbox.set("owner", [late])
  await f.runtime.tick()
  expect(f.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: late.id, disposition: "pending" }),
  )

  f.inbox.set("owner", [])
  // F-S3-1: the native cancellation invalidates a completed source scan.
  f.runtime.observeArchitectSourceEvent("owner")
  f.runtime.flushSourceInvalidations()
  await f.runtime.tick()

  expect(f.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: late.id, disposition: "unknown" }),
  )
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.notifications.some((notification) => notification.text.includes(late.id))).toBe(false)
  expect(f.notifications.some((notification) => notification.text.includes("source changed"))).toBe(
    false,
  )
})

test("generated renewal notifications are authenticated and do not form A-to-B-to-C input loops", async () => {
  const now = 2_000_000_284_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "notification-loop.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const first = f.store.architectRenewalForPlan(f.receipt.planID)!
  const middle = f.sessions.get(first.successor_session_id)!
  expect(f.inbox.get(middle.id)).toHaveLength(1)

  middle.idleAt = now - 1_000
  middle.tokens = null
  queueArchitectNotice(f)
  await f.runtime.tick()
  const second = f.store.architectRenewalForSource(middle.id)!

  expect(second.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(second.successor_session_id)
  expect(f.store.architectSourceInputs(middle.id)).toHaveLength(0)
  // The middle Architect's handoff was replaced by the second one: it is cancelled, not left to cost a turn.
  expect(f.inbox.get(middle.id)).toHaveLength(0)
  expect(
    f.notifications.filter((notification) =>
      notification.text.includes("retained Architect input update"),
    ),
  ).toHaveLength(0)
})

test("a retired Architect predecessor cannot reclaim a transferred plan through reassign", async () => {
  const now = 2_000_000_285_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "reassign.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const plan = f.store.plan(f.receipt.planID)!
  f.sessions.set("active-target", {
    ...f.sessions.get(renewal.successor_session_id)!,
    id: "active-target",
    parentID: undefined,
    metadata: {},
  })
  const reassign = {
    requestID: "retired-predecessor-reassign",
    planID: plan.id,
    action: "reassign",
    targetSessionID: "active-target",
    reason: "Test the retired-owner guard",
  }

  await expect(f.runtime.command(reassign, "owner")).rejects.toThrow(
    "A live Architect session of this project must command the plan",
  )
  expect(f.store.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  await f.runtime.command(
    { ...reassign, requestID: "active-owner-reassign" },
    renewal.successor_session_id,
  )
  expect(f.store.plan(plan.id)?.owner).toBe("active-target")
})

test("input racing native archival remains on the retained source and is referenced to the new owner", async () => {
  const now = 2_000_000_300_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  let startArchive!: () => void
  let releaseArchive!: () => void
  const started = new Promise<void>((resolve) => (startArchive = resolve))
  const gate = new Promise<void>((resolve) => (releaseArchive = resolve))
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      startArchive()
      await gate
    }
    await update(input)
  }

  const tick = f.runtime.tick()
  await started
  await f.runtime.observeArchitectPrompt("owner", "input-during-archive")
  f.sessions.get("owner")!.messages.push({ id: "input-during-archive", text: "Keep this input" })
  releaseArchive()
  await tick
  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const handoff = f.store.detail(f.receipt.planID).delivery as { state: string; payload: string }[]
  expect(renewal.state).toBe("committed")
  expect(renewal.input_message_id).toBe("input-during-archive")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.sessions.get("owner")?.messages.at(-1)?.id).toBe("input-during-archive")
  expect(f.store.architectSourceInputs("owner")).toContainEqual(
    expect.objectContaining({ message_id: "input-during-archive", disposition: "delivered" }),
  )
  expect(handoff.find((row) => JSON.parse(row.payload).status === "architect-handoff")?.state).toBe(
    "delivered",
  )
  expect(
    f.notifications.some((notification) =>
      notification.text.includes("LAZERS Architect source changed"),
    ),
  ).toBe(false)
  expect(
    f.notifications.some((notification) => notification.text.includes("input-during-archive")),
  ).toBe(false)
  expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(1)
  expect(f.events.filter((event) => event === "update-session:owner:false")).toHaveLength(0)
})

test("input on the reserved successor is preserved there without reversing predecessor transfer", async () => {
  const now = 2_000_000_325_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  let startArchive!: () => void
  let releaseArchive!: () => void
  const started = new Promise<void>((resolve) => (startArchive = resolve))
  const gate = new Promise<void>((resolve) => (releaseArchive = resolve))
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      startArchive()
      await gate
    }
    await update(input)
  }

  const tick = f.runtime.tick()
  await started
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  await f.runtime.observeArchitectPrompt(renewal.successor_session_id, "successor-user-input")
  const successor = f.sessions.get(renewal.successor_session_id)!
  successor.busy = true
  successor.messages.push({ id: "successor-user-input", text: "Keep input on successor" })
  expect(f.store.architectRenewalHasInput(renewal.id)).toBe(false)
  releaseArchive()
  await tick

  expect(f.store.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successor.id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(successor.messages.at(-1)?.id).toBe("successor-user-input")
  expect(successor.busy).toBe(true)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ session_id: string }, [string]>(
            "SELECT session_id FROM runner_architect_inputs WHERE message_id=?",
          )
          .get("successor-user-input")?.session_id,
    ),
  ).toBe(successor.id)
})

test("an outcome admitted during archival is blocked then retargeted to the renewed owner", async () => {
  const now = 2_000_000_350_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const createArchitect = f.host.createArchitect!
  f.host.createArchitect = async (input) => {
    // Inject after closeout delivery, but before successor creation starts.
    const beforeCreatePlan = f.store.plan(f.receipt.planID)!
    f.store.atomic((db) =>
      db
        .query(
          "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',1,?,NULL)",
        )
        .run(
          "task-outcome-before-create",
          beforeCreatePlan.id,
          "owner",
          "task-outcome-before-create-message",
          JSON.stringify({
            planID: beforeCreatePlan.id,
            version: beforeCreatePlan.version,
            status: "task-accepted",
            taskID: f.tasks[0]!.id,
            artifact: "worker-artifact",
          }),
          JSON.stringify({
            lazersKind: "runner-outcome",
            lazersProjectID: "project",
            lazersProjectDirectory: f.root,
            lazersPlanID: beforeCreatePlan.id,
            lazersOutboxID: "task-outcome-before-create",
            lazersMessageID: "task-outcome-before-create-message",
            lazersSessionID: "owner",
            lazersStatus: "task-accepted",
            lazersVersion: beforeCreatePlan.version,
          }),
        ),
    )
    return createArchitect(input)
  }
  const update = f.host.updateSession!
  let startArchive!: () => void
  let releaseArchive!: () => void
  const started = new Promise<void>((resolve) => (startArchive = resolve))
  const gate = new Promise<void>((resolve) => (releaseArchive = resolve))
  let oldOutcomeID = ""
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived) {
      const plan = f.store.plan(f.receipt.planID)!
      const renewal = f.store.architectRenewalForPlan(plan.id)!
      oldOutcomeID = "task-outcome-during-archive"
      const oldPayload = {
        planID: plan.id,
        version: plan.version,
        status: "task-accepted",
        taskID: f.tasks[0]!.id,
        artifact: "worker-artifact",
      }
      const oldMetadata = {
        lazersKind: "runner-outcome",
        lazersProjectID: "project",
        lazersProjectDirectory: f.root,
        lazersPlanID: plan.id,
        lazersOutboxID: oldOutcomeID,
        lazersMessageID: "old-task-outcome-message",
        lazersSessionID: "owner",
        lazersStatus: "task-accepted",
        lazersVersion: plan.version,
      }
      f.store.atomic((db) =>
        db
          .query(
            "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',1,?,NULL)",
          )
          .run(
            oldOutcomeID,
            plan.id,
            "owner",
            "old-task-outcome-message",
            JSON.stringify(oldPayload),
            JSON.stringify(oldMetadata),
          ),
      )
      expect(renewal.state).toBe("archiving")
      expect(plan.owner).toBe(renewal.successor_session_id)
      expect(f.notifications).toHaveLength(0)
      expect(f.store.outboxForDelivery().find((row) => row.id === oldOutcomeID)?.state).toBe(
        "pending",
      )
      startArchive()
      await gate
    }
    await update(input)
  }

  const tick = f.runtime.tick()
  try {
    await Promise.race([
      started,
      tick.then(() => {
        throw new Error("Renewal ended before archival admission")
      }),
    ])
    expect(f.notifications).toHaveLength(0)
  } finally {
    releaseArchive()
    await tick
  }

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successor = renewal.successor_session_id
  const outcomeRow = () =>
    (
      f.store.detail(f.receipt.planID).delivery as {
        id: string
        session_id: string
        message_id: string
        state: string
        receipt: string | null
      }[]
    ).find((row) => row.id === oldOutcomeID)!
  let oldOutcome = outcomeRow()
  expect(renewal.state).toBe("committed")
  expect(
    (f.store.detail(f.receipt.planID).delivery as { id: string; state: string }[]).find(
      (row) => row.id === "task-outcome-before-create",
    )?.state,
  ).toBe("superseded")
  expect(oldOutcome.session_id).toBe(successor)
  expect(oldOutcome.message_id).not.toBe("old-task-outcome-message")
  expect(JSON.parse(oldOutcome.receipt!).history).toContainEqual(
    expect.objectContaining({ kind: "owner-retargeted-queued-notice", toSessionID: successor }),
  )
  // The handoff and the retargeted outcome reach the successor as one notice.
  expect(f.notifications).toHaveLength(1)
  expect(f.notifications[0]!.text).toContain("Architect continuity handoff")
  expect(f.notifications.every((notice) => notice.sessionID === successor)).toBe(true)

  await f.runtime.tick()
  oldOutcome = outcomeRow()
  expect(oldOutcome.state).toBe("delivered")
  expect(f.notifications.some((notice) => notice.text.includes('"status":"task-accepted"'))).toBe(
    true,
  )
  expect(f.notifications.every((notice) => notice.sessionID === successor)).toBe(true)
})

test("renewal follows durable ownership when continuation history names an older Architect", async () => {
  // Recovery liveness: a historical continuation cannot veto the durable current owner.
  const now = 2_000_000_369_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "owner-history.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  f.store.atomic((db) => {
    db.query("INSERT INTO runner_continuations VALUES(?,?,?,?,?,?)").run(
      f.receipt.planID,
      "historical-architect",
      "older-parent",
      f.root,
      JSON.stringify({ providerID: "openai", id: "test-model" }),
      9,
    )
  })

  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.store.continuation(f.receipt.planID)).toMatchObject({
    session_id: renewal.successor_session_id,
    parent_id: "owner",
    generation: 10,
  })
  expect(f.store.attempts(f.receipt.planID)[0]?.id).toBe(attempt.id)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.notifications.some((notice) => notice.sessionID === renewal.successor_session_id)).toBe(
    true,
  )
  await f.runtime.tick()
  expect(f.store.architectRenewal(renewal.id)?.state).toBe("committed")
})

test("unavailable renewal successor fails before history sweeps and retries with fresh complete proofs", async () => {
  const now = 2_000_000_370_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  const read = f.host.session
  const page = f.host.architectInputPage!
  let unavailable = true
  let successorReads = 0
  let pages = 0
  f.host.session = async (id, options) => {
    if (id !== "owner" && id !== attempt.session_id) {
      successorReads++
      if (unavailable) throw new Error("successor lookup unavailable")
    }
    return read(id, options)
  }
  f.host.architectInputPage = async (input) => {
    pages++
    return page(input)
  }
  // The first failure starts the durable renewal; later recovery attempts must
  // remain retryable without rescanning history or publishing the same issue.
  await f.runtime.tick()
  await f.runtime.tick()
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("creating")
  expect(successorReads).toBeGreaterThanOrEqual(3)
  expect(pages).toBe(0)
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(0)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.sessions.get("owner")?.archived).toBe(false)

  unavailable = false
  await f.runtime.tick()
  expect(pages).toBeGreaterThanOrEqual(2)
  expect(f.store.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]?.id).toBe(attempt.id)
})

test("native archive failure remains visible and retries without restoring predecessor authority", async () => {
  const now = 2_000_000_375_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  let failArchive = true
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived && failArchive) {
      failArchive = false
      throw new Error("native archive temporarily unavailable")
    }
    await update(input)
  }

  await f.runtime.tick()

  const failed = f.store.architectRenewalForPlan(f.receipt.planID)!
  const successorID = failed.successor_session_id
  expect(failed.state).toBe("archiving")
  expect(failed.error).toContain("native archive temporarily unavailable")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successorID)
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(
    f.store.latestTransition<{ error: string }>(
      f.receipt.planID,
      null,
      "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
    )?.error,
  ).toContain("native archive temporarily unavailable")

  f.sessions.get("owner")!.idleAt = now - 1_000
  f.host.updateSession = update
  await f.runtime.tick()

  const recovered = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(recovered.id).toBe(failed.id)
  expect(recovered.state).toBe("committed")
  expect(recovered.successor_session_id).toBe(successorID)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(successorID)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("a second renewal of a session that already has a source row reuses that row", async () => {
  const now = 2_000_000_400_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const fence = f.store.claim(f.runtime.owner, now)!
  const plan = f.store.plan(f.receipt.planID)!
  const owner = f.sessions.get(plan.owner)!
  const begin = (handoffMessageID: string) =>
    f.store.beginArchitectRenewal({
      schedulerOwner: f.runtime.owner,
      fence,
      anchorPlanID: plan.id,
      previousSessionID: plan.owner,
      directory: owner.directory,
      model: JSON.stringify(owner.model),
      idleAt: owner.idleAt!,
      now,
      handoffMessageID,
    })
  const first = begin("first-handoff")!
  // The first renewal committed earlier and left its source scanning (state active).
  f.store.atomic((db) => {
    db.query("UPDATE runner_architect_renewals SET state='committed' WHERE id=?").run(first.id)
    db.query(
      "UPDATE runner_architect_sources SET state='active',revision=226,scan_cursor='cursor' WHERE session_id=?",
    ).run(plan.owner)
  })
  const second = begin("second-handoff")!
  expect(second!.id).not.toBe(first.id)
  const sources = f.store.atomic((db) =>
    db
      .query<{ renewal_id: string; state: string; scan_cursor: string | null }, [string]>(
        "SELECT renewal_id,state,scan_cursor FROM runner_architect_sources WHERE session_id=?",
      )
      .all(plan.owner),
  )
  expect(sources).toEqual([{ renewal_id: second!.id, state: "preparing", scan_cursor: null }])
})

test("cancellation interrupts workers while a transferred renewal still has failed archival recovery", async () => {
  const now = 2_000_000_500_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "cancel-during-archive.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  let archiveAttempts = 0
  f.host.updateSession = async ({ sessionID, archived }) => {
    if (sessionID === "owner" && archived) {
      archiveAttempts++
      throw new Error("archive remains unavailable during cancellation")
    }
  }

  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("archiving")
  const plan = f.store.plan(f.receipt.planID)!
  await f.runtime.command(
    {
      requestID: "cancel-during-archive-recovery",
      planID: plan.id,
      action: "cancel",
    },
    renewal.successor_session_id,
  )
  expect(f.store.plan(plan.id)?.state).toBe("cancelling")
  expect(f.store.architectRenewalForPlan(plan.id)?.id).toBe(renewal.id)
  let failedHistoryReads = 0
  let historyError = "retained predecessor history is temporarily unavailable"
  f.host.architectInputPage = async () => {
    failedHistoryReads++
    throw new Error(historyError)
  }
  const failureHistory = () =>
    f.store.atomic((db) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_transitions WHERE plan_id=? AND event='ARCHITECT_RENEWAL_RECOVERY_FAILED' ORDER BY id",
        )
        .all(plan.id)
        .map((row) => JSON.parse(row.payload)),
    )

  await f.runtime.tick()
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(false)
  expect(f.sessions.get(attempt.session_id)?.outcome).toBe("interrupted")
  expect(f.store.plan(plan.id)?.state).toBe("cancelling")
  await f.runtime.tick()
  await f.runtime.tick()

  expect(f.store.plan(plan.id)?.state).toBe("cancelled")
  expect(f.store.architectRenewal(renewal.id)).toMatchObject({
    state: "archiving",
    error: "retained predecessor history is temporarily unavailable",
  })
  expect(f.store.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(archiveAttempts).toBe(1)
  expect(failedHistoryReads).toBeGreaterThanOrEqual(6)
  expect(failureHistory()).toEqual([
    { renewalID: renewal.id, state: "archiving", error: historyError },
  ])
  historyError = "retained predecessor history failed differently"
  await f.runtime.tick()
  expect(failureHistory()).toHaveLength(2)
  expect(failureHistory().at(-1)?.error).toBe(historyError)
  historyError = "retained predecessor history is temporarily unavailable"
  await f.runtime.tick()
  expect(failureHistory()).toHaveLength(3)
  expect(failureHistory().at(-1)?.error).toBe(historyError)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("a continuity checkpoint cannot outlive a later observed user input", async () => {
  let now = 2_000_000_510_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "checkpoint-coverage.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const owner = f.sessions.get("owner")!
  now += 100
  owner.messages.push({ id: "msg_new_user_decision", type: "user", text: "Use the new decision" })
  await f.runtime.observeArchitectPrompt(owner.id, "msg_new_user_decision")
  owner.busy = false
  owner.idleAt = now + 100
  now = owner.idleAt + 1_000

  await f.runtime.tick()
  expect(f.store.architectRenewalForPlan(f.receipt.planID)).toBeNull()
  expect(owner.archived).toBe(false)
  expect(
    f.store.latestTransition<{ uncoveredInputID: string }>(
      f.receipt.planID,
      null,
      "ARCHITECT_RENEWAL_BLOCKED_STALE_CHECKPOINT",
    )?.uncoveredInputID,
  ).toBe("msg_new_user_decision")

  // F-S4-3: an unchanged stale checkpoint records one condition, not one per drain.
  for (let tick = 0; tick < 5; tick++) await f.runtime.tick()
  expect(
    (f.store.detail(f.receipt.planID).activity as { event: string }[]).filter(
      (row) => row.event === "ARCHITECT_RENEWAL_BLOCKED_STALE_CHECKPOINT",
    ),
  ).toHaveLength(1)

  await f.runtime.recordArchitectContinuity(owner.id, {
    decisions: ["Use the newly observed user decision."],
    unresolvedQuestions: [],
  })
  expect(f.store.architectContinuityCoverage(owner.id)).toContain("msg_new_user_decision")
  queueArchitectNotice(f)
  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("committed")
  expect(JSON.parse(renewal.continuity_json!).decisions).toEqual([
    "Use the newly observed user decision.",
  ])
  const handoff = (f.store.detail(f.receipt.planID).delivery as { payload: string }[])
    .map((row) => JSON.parse(row.payload))
    .find((payload) => payload.status === "architect-handoff")
  expect(handoff.continuityCoverage).toMatchObject({ revision: 2, inputCount: 1 })
})

test("renewal finishes all preparation pages before transferring a checkpoint", async () => {
  const now = 2_000_000_515_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "page-three-checkpoint.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const cursors: (string | undefined)[] = []
  f.host.architectInputPage = async (_sessionID, cursor) => {
    cursors.push(cursor)
    if (cursor === undefined) return { inbox: [], messages: [], nextCursor: "page-two" }
    if (cursor === "page-two") return { inbox: [], messages: [], nextCursor: "page-three" }
    return {
      inbox: [],
      messages: [{ id: "msg_page_three_user", type: "user" }],
      nextCursor: null,
    }
  }

  await f.runtime.tick()

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(cursors).toEqual([undefined, "page-two", "page-three"])
  expect(renewal.state).toBe("deferred")
  expect(renewal.input_message_id).toBe("msg_page_three_user")
  expect(f.store.plan(f.receipt.planID)?.owner).toBe("owner")
  expect(f.sessions.get("owner")?.archived).toBe(false)
  expect(f.events.filter((event) => event.startsWith("create-architect:"))).toHaveLength(0)
  expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(0)
})
