import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TaskRepository } from "../storage.ts"
import { validProposal } from "../../test/proposal.ts"
import { git } from "./artifacts.ts"
import type { HostSession } from "./host.ts"
import { OutcomeDelivery } from "./outcome-delivery.ts"
import { coalescedOutcomeText, outcomeText } from "./outcome.ts"
import {
  RECOVERY_BUNDLE_EVENT,
  RECOVERY_REPRAISE_MS,
  RECOVERY_STALE_MS,
  RecoveryBundles,
  recoveryBundleText,
  recommend,
  type RecoveryFacts,
  type RecoveryReuse,
} from "./recovery-bundle.ts"
import { RunnerStore } from "./store.ts"
import { RecoveryDetector } from "../recovery/detector.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const HOUR = 3_600_000

function architect(id: string, archived = false): HostSession {
  return {
    id,
    projectID: "project",
    directory: "/",
    agent: "architect",
    archived,
    busy: false,
    model: { providerID: "openai", id: "subscription", variant: "high" },
    tokens: 0,
    tools: 0,
    cost: null,
    messages: [],
  }
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-recovery-bundle-")))
  git(root, ["init", "--initial-branch=main"])
  writeFileSync(join(root, "seed.txt"), "baseline\n")
  git(root, ["add", "seed.txt"])
  git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "baseline",
  ])
  const base = git(root, ["rev-parse", "HEAD"])
  const repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  cleanups.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const sessions = new Map<string, HostSession>([["architect-1", architect("architect-1")]])
  const sent: { sessionID: string; id: string; text: string }[] = []
  const host = {
    session: async (id: string) => structuredClone(sessions.get(id) ?? null),
    notify: async (input: { sessionID: string; id: string; text: string }) => {
      sent.push(input)
    },
  }
  const clock = { at: Date.now() + 3 * HOUR }
  const validArchitect = (session: HostSession | null | undefined): session is HostSession =>
    Boolean(session && !session.archived && session.agent === "architect")
  let created = 0
  const ensureArchitectOwner = async () => {
    const id = `created-${++created}`
    sessions.set(id, architect(id))
    return sessions.get(id)!
  }
  const reconciler = (owner: string) => {
    const bundles = new RecoveryBundles({
      store,
      host,
      directory: root,
      projectID: "project",
      owner,
      now: () => clock.at,
      validArchitect,
      ensureArchitectOwner,
    })
    const delivery = new OutcomeDelivery({
      directory: root,
      ensureArchitectOwner,
      host: host as never,
      owner,
      projectID: "project",
      reconcilePlan: async (
        _id: string,
        _fence: number,
        _label: string,
        run: () => Promise<void>,
      ) => {
        await run()
      },
      store,
      validArchitect,
    } as never)
    return { bundles, delivery, owner, fence: store.claim(owner, clock.at)! }
  }
  let count = 0
  /** A plan with one task, put into the given recorded states. */
  const plan = (input: {
    state: string
    reason?: string | null
    node?: string
    nodeReason?: string | null
    owner?: string
    artifact?: string | null
  }) => {
    const n = ++count
    const proposal = validProposal()
    proposal.objective = `Task number ${n}.`
    proposal.writeScope = [`out${n}.txt`]
    proposal.verification = [{ id: "tests", command: "true", timeoutMs: 1000 }]
    const task = repository.insert({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      revision: 1,
      status: "submitted",
      createdAt: new Date().toISOString(),
      provenance: {
        projectID: "project",
        projectDirectory: root,
        workspaceDirectory: root,
        sessionID: "architect-1",
        startingRevision: { kind: "git", commit: base },
      },
      proposal,
    })
    const submitted = store.submit(
      {
        requestID: `plan-${n}`,
        objective: `Plan number ${n}`,
        baseCommit: base,
        workspaceMode: "isolated",
        workerModel: { providerID: "openai", id: "test" },
        nodes: [{ taskID: task.id, revision: 1 }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: [{ id: "combined", command: "true", timeoutMs: 1000 }],
        acceptance: [
          {
            id: "combined",
            assertion: "combined",
            evidence: [{ kind: "verification", verificationID: "combined" }],
          },
        ],
      },
      input.owner ?? "architect-1",
    )
    store.atomic((db) => {
      db.query("UPDATE runner_plans SET state=?,reason=?,artifact=? WHERE id=?").run(
        input.state,
        input.reason ?? null,
        input.artifact ?? null,
        submitted.planID,
      )
      if (input.node)
        db.query("UPDATE runner_nodes SET state=?,reason=? WHERE plan_id=?").run(
          input.node,
          input.nodeReason ?? null,
          submitted.planID,
        )
    })
    return { planID: submitted.planID, taskID: task.id }
  }
  /** A real recorded action `ago` ms before the fixture clock. */
  const touch = (planID: string, ago = 0, event = "RECONCILE_REQUESTED") =>
    store.atomic((db) =>
      db
        .query(
          "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,NULL,1,?,'{}',?)",
        )
        .run(planID, event, clock.at - ago),
    )
  const setState = (planID: string, state: string) =>
    store.atomic((db) => db.query("UPDATE runner_plans SET state=? WHERE id=?").run(state, planID))
  const outbox = () =>
    store.atomic((db) =>
      db
        .query<{ id: string; state: string; session_id: string; payload: string }, []>(
          "SELECT id,state,session_id,payload FROM runner_outbox WHERE json_extract(payload,'$.status')='recovery-bundle' ORDER BY rowid",
        )
        .all(),
    )
  return {
    root,
    base,
    store,
    sessions,
    sent,
    clock,
    reconciler,
    plan,
    touch,
    setState,
    outbox,
    repository,
  }
}

async function collect(f: ReturnType<typeof fixture>) {
  return f.reconciler("scheduler").bundles.collect()
}

test("stale held, failed, accepted, cleanup-blocked and cancelling work is collected; the rest is not", async () => {
  const f = fixture()
  const held = f.plan({ state: "blocked", reason: "Mechanical candidate did not apply" })
  const failed = f.plan({
    state: "running",
    node: "failed",
    nodeReason: "Task exited 1: verification failed",
  })
  const accepted = f.plan({ state: "accepted", artifact: f.base })
  const cleanup = f.plan({ state: "cleanup-blocked", reason: "worktree is not idle" })
  const cancelling = f.plan({ state: "cancelling", reason: "cancellation not progressing" })
  // Not collected.
  f.plan({ state: "cancelled" })
  f.plan({ state: "integrated" })
  const fresh = f.plan({ state: "blocked", reason: "Dispatch failed" })
  f.touch(fresh.planID)
  const waitingForHuman = f.plan({ state: "blocked", reason: "pending permission request" })
  const disposed = f.plan({ state: "running", node: "failed", nodeReason: "Task exited 1" })
  f.store.atomic((db) =>
    db
      .query(
        "INSERT INTO task_dispositions(project_directory,task_id,request_id,payload,disposition,reason,evidence,related_task_ids,session_id,agent,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        f.root,
        disposed.taskID,
        "dispose-1",
        "{}",
        "superseded",
        "Replaced by a fresh task",
        JSON.stringify([{ kind: "artifact", reference: "replaced" }]),
        "[]",
        "architect-1",
        "architect",
        new Date().toISOString(),
      ),
  )

  const items = await collect(f)
  const byPlan = new Map(items.map((item) => [item.planID + (item.taskID ?? ""), item]))
  const kinds = (planID: string) =>
    items.filter((item) => item.planID === planID).map((item) => item.kind)
  expect(kinds(held.planID)).toContain("held-plan")
  expect(kinds(failed.planID)).toEqual(["failed-task"])
  expect(kinds(accepted.planID)).toEqual(["accepted-unintegrated"])
  expect(kinds(cleanup.planID)).toEqual(["cleanup-blocked"])
  expect(kinds(cancelling.planID)).toEqual(["stuck-cancelling"])
  expect(kinds(fresh.planID)).toEqual([])
  expect(kinds(waitingForHuman.planID)).toEqual([])
  expect(items.some((item) => item.state === "cancelled" || item.state === "integrated")).toBe(
    false,
  )
  const task = byPlan.get(failed.planID + failed.taskID)!
  expect(task.reference).toMatch(/^LZ-\d+$/)
  expect(task.title).toBe("Task number 2.")
  expect(task.holdFamily).toBe("check-failed")
  expect(task.actions).toContain("retry")
  expect(task.actions).toContain("cancel")
  expect(task.ageMs).toBeGreaterThanOrEqual(RECOVERY_STALE_MS)
})

test("a hold that is only re-observed stays stale; an Architect action makes it fresh", async () => {
  const f = fixture()
  const { planID } = f.plan({ state: "blocked", reason: "Dispatch failed" })
  f.touch(planID, 0, "OUTCOME_OWNER_TRANSFER_UNCERTAIN")
  f.touch(planID, 0, "CLEANUP_BLOCKED")
  expect((await collect(f)).length).toBe(1)
  f.touch(planID, HOUR, "RECONCILE_REQUESTED")
  expect(await collect(f)).toEqual([])
})

test("a live worker or a pending question keeps the work out", async () => {
  const f = fixture()
  const { planID, taskID } = f.plan({ state: "blocked", reason: "Dispatch failed" })
  f.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_attempts(id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at)
         VALUES('a1',?,?,?,1,'worker-1','m1',?,?,NULL,'{}','running',?)`,
      )
      .run(planID, f.root, taskID, f.root, f.base, Date.now()),
  )
  f.sessions.set("worker-1", { ...architect("worker-1"), agent: "worker", busy: true })
  expect(await collect(f)).toEqual([])
  f.sessions.set("worker-1", { ...architect("worker-1"), agent: "worker", pendingInput: true })
  expect(await collect(f)).toEqual([])
  f.sessions.set("worker-1", { ...architect("worker-1"), agent: "worker" })
  expect((await collect(f)).length).toBe(1)
})

const reuse = (patch: Partial<RecoveryReuse> = {}): RecoveryReuse => ({
  artifact: null,
  artifactInLanding: null,
  checksPassed: null,
  worktree: null,
  worker: "none",
  ...patch,
})
const facts = (
  patch: Partial<Omit<RecoveryFacts, "reuse">> & { reuse?: Partial<RecoveryReuse> },
): RecoveryFacts => ({
  kind: "failed-task",
  family: undefined,
  hasTask: true,
  actions: ["resume", "retry", "retained-repair", "verify-retained", "integrated", "cancel"],
  ...patch,
  reuse: reuse(patch.reuse),
})

test("the recommendation follows the recorded facts", () => {
  const sha = "1234567890abcdef"
  expect(
    recommend(
      facts({
        kind: "accepted-unintegrated",
        hasTask: false,
        reuse: { artifact: sha, artifactInLanding: true },
      }),
    ).action,
  ).toBe("integrated")
  expect(recommend(facts({ reuse: { artifact: sha, artifactInLanding: true } })).action).toBe(
    "cancel",
  )
  expect(
    recommend(
      facts({
        reuse: {
          artifact: sha,
          checksPassed: true,
          worktree: { path: "/w", unmergedCommits: 2, uncommitted: false },
        },
      }),
    ).action,
  ).toBe("verify-retained")
  expect(
    recommend(facts({ reuse: { worktree: { path: "/w", unmergedCommits: 0, uncommitted: true } } }))
      .action,
  ).toBe("retained-repair")
  expect(recommend(facts({ reuse: { worker: "present" } })).action).toBe("resume")
  expect(recommend(facts({ reuse: { worker: "missing" } })).action).toBe("retry")
  expect(
    recommend(facts({ family: "scope-violation", actions: ["amend-scope", "cancel"] })).action,
  ).toBe("amend-scope")
  expect(
    recommend(facts({ family: "uncertain-effect", actions: ["reconcile", "cancel"] })).action,
  ).toBe("reconcile")
  expect(
    recommend(
      facts({
        kind: "accepted-unintegrated",
        hasTask: false,
        reuse: { artifact: sha, artifactInLanding: false },
      }),
    ).action,
  ).toBeNull()
  // An action the state does not offer falls back to one it does.
  expect(recommend(facts({ reuse: { worker: "missing" }, actions: ["cancel"] })).action).toBe(
    "cancel",
  )
})

test("reuse facts are read from git: an artifact already in the landing branch is recommended as done", async () => {
  const f = fixture()
  const accepted = f.plan({ state: "accepted", artifact: f.base })
  const item = (await collect(f)).find((entry) => entry.planID === accepted.planID)!
  expect(item.reuse.artifact).toBe(f.base)
  expect(item.reuse.artifactInLanding).toBe(true)
  expect(item.recommendation.action).toBe("integrated")
  expect(item.actions).toContain("integrated")
})

test("nothing is sent while contact is paused; one bundle is sent on unpause", async () => {
  const f = fixture()
  f.plan({ state: "blocked", reason: "Dispatch failed" })
  f.plan({ state: "running", node: "failed", nodeReason: "Task exited 1" })
  f.store.setArchitectContact("paused", "operator")
  const a = f.reconciler("scheduler")
  expect(await a.bundles.reconcile(a.fence)).toBeUndefined()
  expect(await a.delivery.deliver(a.fence)).toBe(false)
  expect(f.outbox()).toEqual([])
  expect(f.sent).toEqual([])
  // The pending set is retained while paused.
  expect((await a.bundles.collect()).length).toBeGreaterThan(1)

  f.store.setArchitectContact("enabled", "")
  const bundle = await a.bundles.reconcile(a.fence)
  expect(bundle?.count).toBeGreaterThan(1)
  await a.delivery.deliver(a.fence)
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]!.sessionID).toBe("architect-1")
  expect(f.sent[0]!.text).toContain("LAZERS recovery bundle")
  expect(f.sent[0]!.text).toMatch(/LZ-\d+/)
  expect(f.outbox().map((row) => row.state)).toEqual(["delivered"])
  expect(f.store.plans().length).toBeGreaterThan(1)
  const status = await a.bundles.status()
  expect(status.items).toBe(bundle!.count)
  expect(status.open).toMatchObject({ state: "delivered", count: bundle!.count })
})

test("a restart or a second reconciler does not send a second bundle", async () => {
  const f = fixture()
  f.plan({ state: "blocked", reason: "Dispatch failed" })
  const a = f.reconciler("scheduler")
  const b = { ...f.reconciler("scheduler"), fence: a.fence }
  const raised = await Promise.all([a.bundles.reconcile(a.fence), b.bundles.reconcile(b.fence)])
  expect(raised.filter(Boolean)).toHaveLength(1)
  await a.delivery.deliver(a.fence)
  expect(f.sent).toHaveLength(1)
  // Restart: a new scheduler owner after the lease lapses.
  f.clock.at += 60_000
  const restarted = f.reconciler("scheduler-after-restart")
  expect(await restarted.bundles.reconcile(restarted.fence)).toBeUndefined()
  await restarted.delivery.deliver(restarted.fence)
  expect(f.sent).toHaveLength(1)
  expect(f.outbox()).toHaveLength(1)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ n: number }, [string]>(
            "SELECT count(*) AS n FROM runner_transitions WHERE event=?",
          )
          .get(RECOVERY_BUNDLE_EVENT)!.n,
    ),
  ).toBe(1)
})

test("resolving an item drops it; a new stale item raises one replacing bundle", async () => {
  const f = fixture()
  const first = f.plan({ state: "blocked", reason: "Dispatch failed" })
  const second = f.plan({ state: "blocked", reason: "Dispatch failed" })
  const a = f.reconciler("scheduler")
  await a.bundles.reconcile(a.fence)
  await a.delivery.deliver(a.fence)
  expect(f.sent).toHaveLength(1)

  // Resolve one: the remaining item is still covered, so nothing new is sent.
  f.setState(first.planID, "cancelled")
  f.touch(first.planID)
  expect((await a.bundles.collect()).map((item) => item.planID)).toEqual([second.planID])
  expect(await a.bundles.reconcile(a.fence)).toBeUndefined()

  // A new stale item: one new bundle that lists everything and replaces the old.
  const third = f.plan({ state: "blocked", reason: "Dispatch failed" })
  const replaced = await a.bundles.reconcile(a.fence)
  expect(replaced?.planIDs.toSorted()).toEqual([second.planID, third.planID].toSorted())
  expect(replaced?.replaces).toBe(f.outbox()[0]!.id)
  await a.delivery.deliver(a.fence)
  expect(f.sent).toHaveLength(2)
  expect(f.sent[1]!.text).toContain("replaces the earlier one")

  // Unchanged items are not raised again until the re-raise interval passes.
  expect(await a.bundles.reconcile(a.fence)).toBeUndefined()
  f.clock.at += RECOVERY_REPRAISE_MS + 1
  const again = await a.bundles.reconcile(a.fence)
  expect(again?.count).toBe(2)
  expect(again?.generation).toBe(3)
})

test("a pending bundle is superseded by its replacement instead of piling up", async () => {
  const f = fixture()
  f.plan({ state: "blocked", reason: "Dispatch failed" })
  const a = f.reconciler("scheduler")
  await a.bundles.reconcile(a.fence)
  f.plan({ state: "blocked", reason: "Dispatch failed" })
  await a.bundles.reconcile(a.fence)
  expect(f.outbox().map((row) => row.state)).toEqual(["superseded", "pending"])
  await a.delivery.deliver(a.fence)
  expect(f.sent).toHaveLength(1)
})

test("the bundle goes to a live Architect even when the plans are owned by an archived session", async () => {
  const f = fixture()
  f.sessions.set("old-owner", architect("old-owner", true))
  const { planID } = f.plan({ state: "blocked", reason: "Dispatch failed", owner: "old-owner" })
  const a = f.reconciler("scheduler")
  await a.bundles.reconcile(a.fence)
  await a.delivery.deliver(a.fence)
  // No handover is needed: the live Architect is addressed, and its command adopts the plan.
  expect(f.sent.map((message) => message.sessionID)).toEqual(["architect-1"])
  expect(f.store.plan(planID)!.owner).toBe("old-owner")
  expect(f.store.adoptPlanOwner(planID, "old-owner", "architect-1")).toBe(true)
  expect(f.store.plan(planID)!.owner).toBe("architect-1")
  expect(f.store.latestTransition(planID, null, "OWNER_ADOPTED")).toBeDefined()
})

test("with no live Architect the existing continuation path creates one", async () => {
  const f = fixture()
  f.sessions.set("architect-1", architect("architect-1", true))
  f.plan({ state: "blocked", reason: "Dispatch failed" })
  const a = f.reconciler("scheduler")
  await a.bundles.reconcile(a.fence)
  await a.delivery.deliver(a.fence)
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]!.sessionID).toBe("created-1")
})

test("a bundle replaced by an unreachable Architect is retried later, not every tick", async () => {
  const f = fixture()
  f.plan({ state: "blocked", reason: "Dispatch failed" })
  const a = f.reconciler("scheduler")
  await a.bundles.reconcile(a.fence)
  f.sessions.get("architect-1")!.archived = true
  await a.delivery.deliver(a.fence)
  expect(f.outbox().map((row) => row.state)).toEqual(["superseded"])
  expect(await a.bundles.reconcile(a.fence)).toBeUndefined()
  f.clock.at += 10 * 60_000
  f.sessions.get("architect-1")!.archived = false
  expect(await a.bundles.reconcile(a.fence)).toBeDefined()
})

test("the bundle text states what to do and lists each item with its advice", async () => {
  const f = fixture()
  f.plan({ state: "blocked", reason: "Dispatch failed" })
  const a = f.reconciler("scheduler")
  const bundle = (await a.bundles.reconcile(a.fence))!
  const text = outcomeText(JSON.stringify(bundle))
  expect(text).toContain("Work through all of it in this one pass")
  expect(text).toContain("Recommended:")
  expect(coalescedOutcomeText([{ planID: bundle.planID, payload: JSON.stringify(bundle) }])).toBe(
    text,
  )
})

/** A running task with `rounds` verification rounds; from three on, one failed after 60M tokens. */
function runningTask(f: ReturnType<typeof fixture>, rounds: number) {
  const { planID, taskID } = f.plan({ state: "running", node: "running" })
  const attemptID = crypto.randomUUID()
  f.store.atomic((db) => {
    db.query(
      `INSERT INTO runner_attempts(id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count)
       VALUES(?,?,?,?,1,?,?,?,?,NULL,'{}','running',?,?)`,
    ).run(
      attemptID,
      planID,
      f.root,
      taskID,
      `worker-${attemptID}`,
      `m-${attemptID}`,
      f.root,
      f.base,
      Date.now(),
      rounds >= 3 ? 60_000_000 : 11_000_000,
    )
    for (let round = 0; round < rounds; round++)
      db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,'VERIFY','{}',?)",
      ).run(planID, taskID, f.clock.at - round)
    if (rounds >= 3)
      db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,'REPAIR',?,?)",
      ).run(planID, taskID, JSON.stringify({ from: "verifying", to: "ready" }), f.clock.at)
  })
  f.sessions.set(`worker-${attemptID}`, {
    ...architect(`worker-${attemptID}`),
    agent: "worker",
    busy: true,
  })
  return { planID, taskID, attemptID }
}
const detector = (f: ReturnType<typeof fixture>) =>
  new RecoveryDetector({
    store: f.store,
    handoff: new HandoffStore(f.repository),
    now: () => f.clock.at,
  })

test("the detector records one concern per rule, the bundle carries it once, and replay adds nothing", async () => {
  const f = fixture()
  const calm = runningTask(f, 1)
  const grind = runningTask(f, 3)
  const { fence } = f.reconciler("scheduler")
  const first = detector(f).evaluate("scheduler", fence)
  expect(first.map((c) => c.ruleID)).toEqual(["verify-rounds-repeated"])
  expect(detector(f).evaluate("scheduler", fence)).toEqual([])
  expect(
    f.store.latestTransition(grind.planID, grind.taskID, "WORKER_CONCERN_RAISED"),
  ).toMatchObject({ ruleID: "verify-rounds-repeated", version: 1 })
  expect(
    f.store.latestTransition(calm.planID, calm.taskID, "WORKER_CONCERN_RAISED"),
  ).toBeUndefined()

  const items = await collect(f)
  expect(items.map((item) => [item.kind, item.taskID])).toEqual([["worker-concern", grind.taskID]])
  expect(items[0]!.concern).toMatchObject({ ruleID: "verify-rounds-repeated", version: 1 })
  const bundle = await f.reconciler("scheduler").bundles.reconcile(fence)
  expect(bundle?.items).toHaveLength(1)
  expect(recoveryBundleText(JSON.stringify(bundle))).toContain("Concern verify-rounds-repeated")
  expect(await f.reconciler("scheduler").bundles.reconcile(fence)).toBeUndefined()
})

test("an acknowledgement suppresses reviewed evidence; only materially new evidence or a due follow-up returns", async () => {
  const f = fixture()
  const grind = runningTask(f, 3)
  const { fence } = f.reconciler("scheduler")
  detector(f).evaluate("scheduler", fence)
  const handoff = new HandoffStore(f.repository)
  const concern = (await collect(f))[0]!.concern!
  const decide = (requestID: string, input: object) =>
    handoff.recordRecoveryDisposition(
      {
        requestID,
        dispositionID: crypto.randomUUID(),
        concernID: concern.concernID,
        reason: "reviewed",
        evidenceBoundary: concern.boundary,
        ...input,
      },
      { sessionID: "architect-1", agent: "architect", role: "architect" },
    )
  expect(decide("ack-1", { decision: "acknowledge" }).status).toBe("recorded")
  expect(await collect(f)).toEqual([])
  // 30M more tokens is not double the 60M the Architect reviewed ... 60M more is.
  const addTokens = (count: number) =>
    f.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET token_count=token_count+? WHERE id=?").run(
        count,
        grind.attemptID,
      )
    })
  addTokens(30_000_000)
  expect(detector(f).evaluate("scheduler", fence)).toEqual([])
  addTokens(30_000_000)
  expect(detector(f).evaluate("scheduler", fence)).toHaveLength(1)
  expect((await collect(f))[0]!.concern!.version).toBe(2)
  // A deferred follow-up is honoured: nothing before it is due, a new version when it is.
  const due = new Date(f.clock.at + HOUR).toISOString()
  const latest = (await collect(f))[0]!.concern!
  handoff.recordRecoveryDisposition(
    {
      requestID: "follow-1",
      dispositionID: crypto.randomUUID(),
      concernID: latest.concernID,
      decision: "follow-up",
      reason: "look again",
      evidenceBoundary: latest.boundary,
      followUp: { kind: "at", dueAt: due },
    },
    { sessionID: "architect-1", agent: "architect", role: "architect" },
  )
  expect(await collect(f)).toEqual([])
  expect(detector(f).evaluate("scheduler", fence)).toEqual([])
  f.clock.at += 2 * HOUR
  expect(detector(f).evaluate("scheduler", fence)).toHaveLength(1)
  expect((await collect(f))[0]!.concern!.version).toBe(3)
})

test("the detector is idempotent across ticks and a reload, and an unanswered concern escalates once the measure doubles", async () => {
  const f = fixture()
  const grind = runningTask(f, 3)
  const { fence } = f.reconciler("scheduler")
  expect(detector(f).evaluate("scheduler", fence)).toHaveLength(1)
  // Same instance, a new instance on the same database (a reload), and a new process clock.
  const again = detector(f)
  expect(again.evaluate("scheduler", fence)).toEqual([])
  expect(again.evaluate("scheduler", fence)).toEqual([])
  expect(detector(f).evaluate("scheduler", fence)).toEqual([])
  const first = (await collect(f))[0]!
  expect(first.concern).toMatchObject({ version: 1 })
  expect(first.recommendation.action).toBe("steer")

  // Unanswered and the spend has not doubled: still one notice.
  const addTokens = (count: number) =>
    f.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET token_count=token_count+? WHERE id=?").run(
        count,
        grind.attemptID,
      )
    })
  addTokens(30_000_000)
  expect(detector(f).evaluate("scheduler", fence)).toEqual([])

  // Doubled and still unanswered: a new version in stronger words, so the bundle key changes.
  addTokens(30_000_000)
  const escalated = detector(f).evaluate("scheduler", fence)
  expect(escalated).toMatchObject([{ ruleID: "verify-rounds-repeated", version: 2 }])
  const second = (await collect(f))[0]!
  expect(second.concern?.line).toStartWith("Escalated, still unanswered: now ")
  expect(second.concern?.line).toContain("after 120M tokens")
  expect(second.key).not.toBe(first.key)
  expect(second.recommendation.action).toBe("takeover")
  // The escalation itself is recorded once, by this instance or a reloaded one.
  expect(detector(f).evaluate("scheduler", fence)).toEqual([])
  expect(detector(f).evaluate("scheduler", fence)).toEqual([])
})

test("a new attempt of the same task does not raise a task-wide concern again", async () => {
  const f = fixture()
  const grind = runningTask(f, 3)
  const { fence } = f.reconciler("scheduler")
  expect(detector(f).evaluate("scheduler", fence)).toHaveLength(1)
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(grind.attemptID)
    db.query(
      `INSERT INTO runner_attempts(id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count)
       VALUES(?,?,?,?,2,?,?,?,?,NULL,'{}','running',?,0)`,
    ).run(
      crypto.randomUUID(),
      grind.planID,
      f.root,
      grind.taskID,
      "worker-two",
      "m-two",
      f.root,
      f.base,
      Date.now(),
    )
  })
  expect(detector(f).evaluate("scheduler", fence)).toEqual([])
  expect(await collect(f)).toHaveLength(1)
})

test("the detector never evaluates a takeover attempt: that is the Architect working", async () => {
  const f = fixture()
  const grind = runningTask(f, 3)
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET policy=? WHERE id=?").run(
      JSON.stringify({ takeover: { planID: grind.planID, reason: "finish it" } }),
      grind.attemptID,
    )
  })
  const { fence } = f.reconciler("scheduler")
  expect(detector(f).evaluate("scheduler", fence)).toEqual([])
  expect(await collect(f)).toEqual([])
})

test("the spend ceiling records a takeover concern past the ceiling and leaves the worker alone", async () => {
  const f = fixture()
  const calm = runningTask(f, 1)
  const { fence } = f.reconciler("scheduler")
  const ceiling = new RecoveryDetector({
    store: f.store,
    handoff: new HandoffStore(f.repository),
    now: () => f.clock.at,
    spendCeilingTokens: 10_000_000,
  })
  expect(ceiling.evaluate("scheduler", fence).map((c) => c.ruleID)).toEqual(["spend-ceiling"])
  const item = (await collect(f))[0]!
  expect(item.recommendation.action).toBe("takeover")
  expect(f.store.plan(calm.planID)!.state).toBe("running")
  expect(f.store.nodes(calm.planID).map((n) => n.state)).toEqual(["running"])
})

test("an edit outside the write scope is recorded as a concern with its paths, never a hold", async () => {
  const f = fixture()
  const { planID, taskID, attemptID } = runningTask(f, 0)
  f.store.atomic((db) => {
    const tool = (seq: number, operation: string, path: string) =>
      db
        .query(
          `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,sources_json,kind,event_ids_json,call_id,dedupe_key,payload)
           VALUES(?,?,?,?,?,?,?,'t','[]','tool','[]',?,?,?)`,
        )
        .run(
          f.root,
          "project",
          planID,
          taskID,
          attemptID,
          `worker-${attemptID}`,
          seq,
          `call-${seq}`,
          `k${seq}`,
          JSON.stringify({ status: "completed", fileTargets: { operation, paths: [path] } }),
        )
    tool(1, "patch", "out1.txt")
    tool(2, "patch", "docs/outside.md")
    tool(3, "patch", "docs/also-outside.md")
    tool(4, "patch", "docs/third.md")
  })
  const { fence } = f.reconciler("scheduler")
  const recorded = detector(f).evaluate("scheduler", fence)
  expect(recorded.map((c) => c.ruleID)).toEqual(["out-of-scope-write"])
  const item = (await collect(f))[0]!
  expect(item.concern?.line).toBe(
    "edited outside the write scope: docs/also-outside.md, docs/outside.md, docs/third.md",
  )
  expect(item.recommendation.action).toBe("steer")
  expect(f.store.plan(planID)!.state).toBe("running")
})
