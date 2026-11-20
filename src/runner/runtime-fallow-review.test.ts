import { allPlans } from "./store-plans.fixture.ts"
import { RECOVERY_STALE_MS } from "./recovery-bundle.ts"
import { FallowConfigRequiredError, refusalMessage } from "../audit/fallow-refusal.ts"
import { expect, test } from "bun:test"
import { setFallowConfig } from "../audit/config.ts"
import { outcomeText } from "./outcome.ts"
import { TaskProposalSchema } from "../task.ts"
import { settleVerification } from "../../test/runner/verification-driver.ts"
import {
  cleanFallowResult,
  drive,
  fallowFinding,
  fixture,
  introducedResult,
  planAcceptedOutcomes,
  planFallowEffects,
  planLevelRecords,
  reviewOf,
  runPlan,
  scriptedReview,
  singleTask,
  taskAcceptedOutcomes,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("fallow findings alone send one repair carrying the guidance, then accept with the remainder", async () => {
  const review = scriptedReview(introducedResult(fallowFinding("src/a.ts", 12)))
  const f = fixture({
    repair: true,
    taskFiles: singleTask,
    fallowReviewRun: review.run,
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await f.runtime.tick()
  await settleVerification(f.runtime)
  const repairs = f.store
    .activity(planID, f.tasks[0]!.id)
    .filter((event) => event.event === "REPAIR")
  expect(repairs).toHaveLength(1)
  expect(JSON.stringify(repairs[0])).toContain(
    "Verification fallow-audit warn: 0 errors, 1 warnings",
  )
  const attempts = f.store.attempts(planID)
  expect(attempts).toHaveLength(2)
  await f.runtime.tick()
  const prompt = f.sessions.get(attempts[1]!.session_id)!.messages[0]!.text
  expect(prompt).toContain("- fallow-audit: `lazers:fallow-audit` exit 1")
  expect(prompt).toContain("src/a.ts:12-20")
  await drive(f.runtime)
  // The repair attempt's review still has findings and no repair remains: accepted, never failed or held.
  expect(f.store.plan(planID)?.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(2)
  expect(
    f.store.activity(planID, f.tasks[0]!.id).filter((event) => event.event === "REPAIR"),
  ).toHaveLength(1)
  const outcomes = taskAcceptedOutcomes(f)
  expect(outcomes).toHaveLength(1)
  // The repair left the warning in place and said nothing: the outcome records that, typed.
  expect(outcomes[0]!.fallow).toMatchObject({
    package: { findings: [{ file: "src/a.ts", line: 12, severity: "warn" }] },
    dispositions: [
      { findingID: "duplication:code-duplication:src/a.ts", disposition: "remaining" },
    ],
  })
  expect(outcomeText(JSON.stringify(outcomes[0]))).toContain("no reason stated")
  expect(outcomes[0]!.evidence).toEqual(["content"])
  expect(review.calls).toHaveLength(2)
  // The repair attempt starts from the first attempt's artifact, but the review still measures
  // what the task introduced: both reviews use the first attempt's base.
  const [first, repair] = f.store.attempts(planID)
  expect(repair!.base_commit).toBe(first!.artifact!)
  expect(review.bases).toEqual([first!.base_commit, first!.base_commit])
  // A retry from a new baseline starts a new chain.
  f.store.atomic((db) =>
    db.query("UPDATE runner_attempts SET base_commit=? WHERE id=?").run(f.base, repair!.id),
  )
  const fresh = f.store.attempts(planID)[1]!
  expect(Reflect.get(f.runtime, "verificationReview").taskChainBase(fresh)).toBe(f.base)
  expect(
    Reflect.get(f.runtime, "verificationReview").taskChainBase(f.store.attempts(planID)[0]!),
  ).toBe(first!.base_commit)
})

test("fallow findings and a failing check give exactly one repair carrying both", async () => {
  const review = scriptedReview(introducedResult(fallowFinding("src/b.ts", 30)))
  const f = fixture({
    repair: true,
    taskFiles: singleTask,
    checkCommand: "echo content-out; exit 7",
    fallowReviewRun: review.run,
  })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await f.runtime.tick()
  await settleVerification(f.runtime)
  const repairs = f.store
    .activity(planID, f.tasks[0]!.id)
    .filter((event) => event.event === "REPAIR")
  expect(repairs).toHaveLength(1)
  expect(JSON.stringify(repairs[0])).toContain(
    "Verification content exited with code 7; Verification fallow-audit warn: 0 errors, 1 warnings",
  )
  const attempts = f.store.attempts(planID)
  expect(attempts).toHaveLength(2)
  await f.runtime.tick()
  const prompt = f.sessions.get(attempts[1]!.session_id)!.messages[0]!.text
  expect(prompt).toContain("content-out")
  expect(prompt).toContain("src/b.ts:30-38")
})

test("a clean review accepts without a fallow field", async () => {
  const f = fixture({ taskFiles: singleTask })
  await runPlan(f)
  await f.runtime.tick()
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  const outcomes = taskAcceptedOutcomes(f)
  expect(outcomes).toHaveLength(1)
  expect("fallow" in outcomes[0]!).toBe(false)
})

test("an unavailable review accepts and records FALLOW_UNAVAILABLE once", async () => {
  const review = scriptedReview({
    ...cleanFallowResult,
    status: "unavailable",
    reason: "analyzer crashed",
  })
  const f = fixture({ repair: true, taskFiles: singleTask, fallowReviewRun: review.run })
  const planID = f.receipt.planID
  await runPlan(f)
  await f.runtime.tick()
  await drive(f.runtime)
  expect(f.store.plan(planID)?.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  const unavailable = f.store
    .activity(planID, f.tasks[0]!.id)
    .filter((event) => event.event === "FALLOW_UNAVAILABLE")
  expect(unavailable).toHaveLength(1)
  expect(JSON.stringify(unavailable[0])).toContain("analyzer crashed")
})

test("fallowReview off records no review effect", async () => {
  const review = scriptedReview(introducedResult(fallowFinding("src/a.ts", 1)))
  const f = fixture({ taskFiles: singleTask, fallowReview: "off", fallowReviewRun: review.run })
  await runPlan(f)
  await f.runtime.tick()
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(review.calls).toHaveLength(0)
  expect(
    f.store.effects(f.receipt.planID).filter((effect) => effect.kind === "verify:fallow-audit"),
  ).toHaveLength(0)
})

test("fallow-audit, and its old name lazers-fallow, are reserved verification IDs", () => {
  const f = fixture({ taskFiles: singleTask })
  for (const id of ["fallow-audit", "lazers-fallow"]) {
    const plan = {
      ...f.input,
      requestID: `reserved-${id}`,
      verification: [{ id, command: "true" }],
    }
    expect(() => f.runtime.submitPlan(plan, "owner")).toThrow("reserved")
  }
  const reserved = { id: "fallow-audit", command: "true" }
  const task = f.tasks[0]!
  const proposal = structuredClone(task.proposal)
  proposal.verification = [reserved]
  proposal.acceptance = []
  expect(TaskProposalSchema.safeParse(proposal).error?.message).toContain("reserved")
})

test("inherited findings alone are context: no repair, nothing for the Architect", async () => {
  const review = scriptedReview(
    reviewOf(fallowFinding("src/c.ts", 5, { attribution: "inherited" })),
  )
  const f = fixture({ repair: true, taskFiles: singleTask, fallowReviewRun: review.run })
  const planID = f.receipt.planID
  await runPlan(f)
  await f.runtime.tick()
  await drive(f.runtime)
  expect(f.store.plan(planID)?.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect("fallow" in taskAcceptedOutcomes(f)[0]!).toBe(false)
})

test("after the one repair, each finding of the first audit is fixed, remaining or suppressed", async () => {
  const warning = fallowFinding("src/a.ts", 12, { id: "w", rule: "code-duplication" })
  const error = fallowFinding("src/b.ts", 3, {
    id: "e",
    rule: "complexity",
    class: "complexity",
    severity: "error",
  })
  const waived = fallowFinding("src/c.ts", 1, {
    id: "d",
    rule: "added-suppression",
    class: "diff-risk",
    suppression: { kinds: ["complexity"], reason: "legacy parser, tracked in #12" },
  })
  // The repair fixed the error, kept the warning, and waived src/c.ts with a reason.
  const review = scriptedReview(
    reviewOf(
      warning,
      error,
      fallowFinding("src/c.ts", 1, { id: "d2", class: "complexity", rule: "complexity" }),
    ),
    reviewOf(warning, waived),
  )
  const f = fixture({ repair: true, taskFiles: singleTask, fallowReviewRun: review.run })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await f.runtime.tick()
  await settleVerification(f.runtime)
  await f.runtime.tick()
  await drive(f.runtime)
  expect(f.store.plan(planID)?.state).toBe("accepted")
  const fallow = taskAcceptedOutcomes(f)[0]!.fallow as {
    dispositions: { findingID: string; disposition: string; reason?: string }[]
  }
  const byID = Object.fromEntries(fallow.dispositions.map((d) => [d.findingID, d]))
  expect(byID.w).toMatchObject({ disposition: "remaining" })
  expect(byID.e).toMatchObject({ disposition: "fixed" })
  expect(byID.d2).toMatchObject({
    disposition: "suppressed",
    reason: "legacy parser, tracked in #12",
  })
})

test("plan-level findings never hold the plan and reach the accepted outcome with their task", async () => {
  const review = scriptedReview(
    reviewOf(
      fallowFinding("a.txt", 1),
      fallowFinding("a.txt", 3, {
        id: "cycle",
        class: "architecture",
        rule: "circular-dependency",
      }),
    ),
  )
  const f = fixture({ taskFiles: singleTask, fallowPlanReviewRun: review.run })
  const planID = f.receipt.planID
  await runPlan(f)
  await f.runtime.tick()
  await drive(f.runtime)
  expect(f.store.plan(planID)?.state).toBe("accepted")
  expect(review.calls).toHaveLength(1)
  expect(review.bases).toEqual([f.base])
  expect(planFallowEffects(f)).toHaveLength(1)
  const [outcome] = planAcceptedOutcomes(f)
  const taskID = f.tasks[0]!.id
  expect(outcome!.fallow).toMatchObject({
    package: {
      findings: [
        { file: "a.txt", line: 1, taskID },
        { rule: "circular-dependency", taskID },
      ],
    },
  })
  // The review's receipt is not evidence: only the authored checks are.
  expect((outcome!.evidence as { id: string }[]).map((check) => check.id)).toEqual(["combined"])
  const record = planLevelRecords(f, "PLAN_ACCEPTED")
  expect(JSON.parse(record[0]!.payload).fallow.package.findings).toHaveLength(2)
  const text = outcomeText(JSON.stringify(outcome))
  expect(text).toContain("Fallow audit of the combined plan, verdict warn (2 findings):")
  expect(text).toContain(`code-duplication a.txt:1-9 cloned block (task ${taskID})`)
  expect(f.store.effects(planID).every((effect) => effect.state === "completed")).toBe(true)
})

test("a clean plan review accepts without a fallow field", async () => {
  const f = fixture({ taskFiles: singleTask })
  await runPlan(f)
  await f.runtime.tick()
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(planFallowEffects(f)).toHaveLength(1)
  expect("fallow" in planAcceptedOutcomes(f)[0]!).toBe(false)
})

test("a throwing plan review accepts and records FALLOW_UNAVAILABLE once for the plan", async () => {
  const f = fixture({
    taskFiles: singleTask,
    fallowPlanReviewRun: async () => {
      throw new Error("plan analyzer crashed")
    },
  })
  await runPlan(f)
  await f.runtime.tick()
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  const records = planLevelRecords(f, "FALLOW_UNAVAILABLE")
  expect(records).toHaveLength(1)
  expect(records[0]!.payload).toContain("plan analyzer crashed")
  expect("fallow" in planAcceptedOutcomes(f)[0]!).toBe(false)
})

test("fallowReview off records no plan review effect", async () => {
  const review = scriptedReview(introducedResult(fallowFinding("a.txt", 1)))
  const f = fixture({
    taskFiles: singleTask,
    fallowReview: "off",
    fallowPlanReviewRun: review.run,
  })
  await runPlan(f)
  await f.runtime.tick()
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(review.calls).toHaveLength(0)
  expect(planFallowEffects(f)).toHaveLength(0)
})

test("a failing authored combined check still holds and the plan review never runs", async () => {
  const review = scriptedReview(introducedResult(fallowFinding("a.txt", 1)))
  const f = fixture({
    taskFiles: singleTask,
    combinedCheckCommand: "exit 1",
    fallowPlanReviewRun: review.run,
  })
  await runPlan(f)
  await f.runtime.tick()
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(f.store.plan(f.receipt.planID)?.reason).toBe("Combined artifact verification failed")
  expect(review.calls).toHaveLength(0)
  expect(planAcceptedOutcomes(f)).toHaveLength(0)
})

test("an Auditor attempt starts exactly one baseline and one follow-up; an implementor starts none", async () => {
  const runs: { requestID: string; phase: string; workspace: string; sessionID: string }[] = []
  const auditorReportRun = async (input: (typeof runs)[number]) => {
    runs.push(input)
  }
  const f = fixture({
    shared: true,
    workerAgent: "auditor",
    personas: ["systems"],
    taskFiles: singleTask,
    auditorReportRun,
  })
  await runPlan(f)
  await f.runtime.tick()
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  expect(runs.map((run) => run.phase)).toEqual(["baseline"])
  expect(runs[0]).toMatchObject({
    requestID: `runtime-baseline:${attempt.id}`,
    workspace: attempt.workspace,
    sessionID: attempt.session_id,
  })
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(runs.map((run) => run.requestID)).toEqual([
    `runtime-baseline:${attempt.id}`,
    `runtime-follow-up:${attempt.id}`,
  ])
  // A restarted runtime ticks the same state again; request IDs make the stored runs replay.
  const plain = fixture({ taskFiles: singleTask, auditorReportRun })
  const before = runs.length
  await runPlan(plain)
  await drive(plain.runtime)
  expect(runs).toHaveLength(before)
})

test("with the review on, a project with no Fallow config refuses plan submission with a typed result and queues nothing", async () => {
  const f = fixture({ taskFiles: singleTask, fallowConfig: "none" })
  const before = f.store.read((db) => db.query("SELECT count(*) AS n FROM runner_plans").get()) as {
    n: number
  }
  const refused = await f.runtime.submitPlan({ ...f.input, requestID: "gated" }, "owner")
  expect(refused).toMatchObject({
    status: "refused",
    code: "FALLOW_CONFIG_REQUIRED",
    nothingQueued: true,
    next: [
      "lz-fallow-config (mode suggest)",
      "lz-fallow-config (mode dry-run)",
      "lz-fallow-config-set",
    ],
  })
  const after = f.store.read((db) => db.query("SELECT count(*) AS n FROM runner_plans").get()) as {
    n: number
  }
  expect(after.n).toBe(before.n)
  setFallowConfig(
    f.store.repository,
    { entry: [] },
    { sessionID: "architect", agent: "architect" },
    "entry points reviewed",
  )
  expect(await f.runtime.fallowGate()).toBeUndefined()
})

test("with the review off there is no config gate", async () => {
  const f = fixture({ taskFiles: singleTask, fallowConfig: "none", fallowReview: "off" })
  expect(await f.runtime.fallowGate()).toBeUndefined()
})

test("a plan queued before the project had a config holds with the actionable result, then resumes once one exists", async () => {
  const f = fixture({ taskFiles: singleTask, fallowConfig: "none" })
  const planID = f.receipt.planID
  await runPlan(f)
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.plan(planID)?.reason).toStartWith("FALLOW_CONFIG_REQUIRED")
  expect(f.store.plan(planID)?.reason).toContain("call lz-fallow-config with mode suggest")
  expect(f.store.plan(planID)?.reason).toContain("mode guide returns it again")
  setFallowConfig(
    f.store.repository,
    { entry: [] },
    { sessionID: "architect", agent: "architect" },
    "entry points reviewed",
  )
  await f.runtime.tick()
  await drive(f.runtime)
  expect(f.store.plan(planID)?.state).toBe("accepted")
})

test("a review recorded under the old effect kind verify:lazers-fallow is still recognised, not re-run", async () => {
  const review = scriptedReview(reviewOf(fallowFinding("src/a.ts", 12)))
  const f = fixture({ repair: true, taskFiles: singleTask, fallowReviewRun: review.run })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await f.runtime.tick()
  await settleVerification(f.runtime)
  expect(review.calls).toHaveLength(1)
  // History written before the rename keeps its old kind; no migration rewrites it.
  f.store.atomic((db) =>
    db
      .query(
        "UPDATE runner_effects SET kind='verify:lazers-fallow' WHERE kind='verify:fallow-audit'",
      )
      .run(),
  )
  const effect = f.store
    .effects(planID)
    .find((e) => e.kind === "verify:lazers-fallow" && e.state === "completed")!
  expect(effect).toBeDefined()
  const payload = JSON.parse(effect.payload) as { artifact: string; identity: string }
  const attempt = f.store.attempts(planID).find((a) => a.id === effect.attempt_id)!
  const known = await Reflect.get(f.runtime, "verificationReview").fallowReviewResult(
    f.store.plan(planID)!,
    attempt,
    { commit: payload.artifact, identity: payload.identity },
    undefined,
    0,
  )
  expect(known).not.toBe("pending")
  expect(review.calls).toHaveLength(1)
  expect(f.store.effects(planID).filter((e) => e.kind === "verify:fallow-audit")).toHaveLength(0)
})

test("stale held work reaches one Architect as one recovery bundle once contact is enabled", async () => {
  const clock = { at: Date.now() }
  const f = fixture({ now: () => clock.at })
  const planID = f.receipt.planID
  f.store.atomic((db) =>
    db
      .query(
        "UPDATE runner_plans SET state='blocked',reason='Dispatch failed: route lost' WHERE id=?",
      )
      .run(planID),
  )
  f.sessions.set("successor", { ...structuredClone(f.sessions.get("owner")!), id: "successor" })
  f.sessions.get("owner")!.archived = true
  const bundles = () =>
    f.notifications.filter((notice) => notice.text.includes("LAZERS recovery bundle"))

  // Fresh work is not stale yet.
  await f.runtime.tick()
  expect(bundles()).toHaveLength(0)

  // Stale, but contact is paused: nothing is created or sent, and the set is retained.
  clock.at += RECOVERY_STALE_MS + 60_000
  f.store.setArchitectContact("paused", "operator")
  await f.runtime.tick()
  expect(bundles()).toHaveLength(0)
  expect(f.store.latestTransition(planID, null, "RECOVERY_BUNDLE_RAISED")).toBeUndefined()

  // Unpausing delivers one bundle to the live Architect; further ticks add none.
  f.store.setArchitectContact("enabled", "")
  await f.runtime.tick()
  await f.runtime.tick()
  expect(bundles()).toHaveLength(1)
  // The archived owner was replaced by the existing continuation path during the first tick.
  const receiver = f.store.plan(planID)!.owner
  expect(bundles()[0]!.sessionID).toBe(receiver)
  expect(receiver).not.toBe("owner")
  expect(bundles()[0]!.text).toContain(planID)

  // Another live Architect commands the plan owned by the receiver and is adopted.
  await f.runtime.command({ requestID: "recover-run", planID, action: "run" }, "successor")
  expect(f.store.plan(planID)!.owner).toBe("successor")
  expect(f.store.latestTransition(planID, null, "OWNER_ADOPTED")).toBeDefined()
})

test("Start of a task in a project with no Fallow config is refused with the typed result and queues no plan", async () => {
  const f = fixture({ shared: true, commit: true, startOnly: true, fallowConfig: "none" })
  const error = await f.runtime
    .startTask({ taskID: f.tasks[0]!.id, revision: 1, sessionID: "owner" })
    .catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(FallowConfigRequiredError)
  const refusal = (error as FallowConfigRequiredError).refusal
  expect(refusal).toMatchObject({
    status: "refused",
    code: "FALLOW_CONFIG_REQUIRED",
    nothingQueued: true,
  })
  expect(refusalMessage(refusal)).toContain("Nothing was queued.")
  expect(allPlans(f.store)).toHaveLength(0)
})
