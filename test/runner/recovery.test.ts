import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TaskRepository } from "../../src/storage.ts"
import { RunnerStore } from "../../src/runner/store.ts"
import { git } from "../../src/runner/artifacts.ts"
import { validProposal } from "../proposal.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
function fixture(crashVerifier = false) {
  const root = mkdtempSync(join(tmpdir(), "lazers-process-recovery-"))
  git(root, ["init", "--initial-branch=main"])
  writeFileSync(join(root, "seed.txt"), "source")
  git(root, ["add", "seed.txt"])
  git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "baseline",
  ])
  const base = git(root, ["rev-parse", "HEAD"])
  const repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root),
    store = new RunnerStore(repository)
  const proposal = validProposal()
  proposal.writeScope = ["result.txt"]
  proposal.limits.maxRepairAttempts = 0
  proposal.verification = [
    {
      id: "test",
      command: crashVerifier
        ? `if [ ! -e "${join(root, "verifier-crashed")}" ]; then touch "${join(root, "verifier-crashed")}"; kill -KILL "$LAZERS_TEST_RUNNER_PID"; fi; test $(cat result.txt) = correct`
        : "test $(cat result.txt) = correct",
      timeoutMs: 1000,
    },
  ]
  proposal.acceptance = [
    {
      id: "correct",
      assertion: "exact output",
      evidence: [{ kind: "verification", verificationID: "test" }],
    },
  ]
  const task = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "fixture",
      projectDirectory: root,
      workspaceDirectory: root,
      sessionID: "owner",
      startingRevision: { kind: "git", commit: base },
    },
    proposal,
  })
  const plan = store.submit(
    {
      requestID: "plan",
      objective: "Crash-recover one real artifact",
      baseCommit: base,
      workspaceMode: "isolated",
      workerModel: { providerID: "openai", id: "subscription", variant: "high" },
      nodes: [{ taskID: task.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: [
        { id: "combined", command: "test $(cat result.txt) = correct", timeoutMs: 1000 },
      ],
      acceptance: [
        {
          id: "combined",
          assertion: "exact integrated content",
          evidence: [{ kind: "verification", verificationID: "combined" }],
        },
      ],
    },
    "owner",
  )
  writeFileSync(join(root, "fixture.json"), JSON.stringify({ planID: plan.planID }))
  writeFileSync(
    join(root, "host.json"),
    JSON.stringify({
      sessions: {
        owner: {
          id: "owner",
          projectID: "fixture",
          directory: root,
          agent: "architect",
          archived: false,
          busy: false,
          model: { providerID: "openai", id: "subscription", variant: "high" },
          tokens: 0,
          tools: 0,
          cost: null,
          messages: [],
        },
      },
      calls: [],
    }),
  )
  cleanups.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, repository, store, plan, task }
}
async function run(root: string, fault: string) {
  const child = Bun.spawn(
    [process.execPath, new URL("./crash-fixture.ts", import.meta.url).pathname, root, fault],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

test("legacy delivered outbox rows reopen as delivered", () => {
  const f = fixture()
  // S2-4: the legacy delivery marker predates the runner generation migration.
  f.store.atomic((db) => db.query("DELETE FROM schema_modules WHERE module='runner'").run())
  const payload = { planID: f.plan.planID, planRevision: 1, version: 1, status: "accepted" }
  f.store.atomic((db) =>
    db
      .query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES('legacy-outbox',?,?,? ,?,'delivered',1,NULL,NULL)",
      )
      .run(f.plan.planID, "owner", "msg_legacy_outcome", JSON.stringify(payload)),
  )

  new RunnerStore(f.repository)
  const migrated = f.store.atomic((db) =>
    db
      .query<{ id: string; message_id: string; state: string; receipt: string }, []>(
        "SELECT id,message_id,state,receipt FROM runner_outbox WHERE id='legacy-outbox'",
      )
      .get(),
  )
  expect(migrated).toMatchObject({
    id: "legacy-outbox",
    message_id: "msg_legacy_outcome",
    state: "delivered",
  })

  new RunnerStore(f.repository)
  expect(
    f.store.atomic((db) =>
      db
        .query<{ state: string; receipt: string }, []>(
          "SELECT state,receipt FROM runner_outbox WHERE id='legacy-outbox'",
        )
        .get(),
    ),
  ).toEqual({ state: "delivered", receipt: migrated!.receipt })
})

test("fresh processes recover accepted session/prompt effects without replay", async () => {
  for (const fault of ["after-session", "after-prompt"]) {
    const f = fixture()
    const crashed = await run(f.root, fault)
    expect(crashed.code).not.toBe(0)
    // Advance the fixture lease clock only after the old OS process has exited.
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    const resumed = await run(f.root, "none")
    expect(resumed.code, resumed.stderr).toBe(0)
    expect(f.store.plan(f.plan.planID)?.state).toBe("accepted")
    const state = JSON.parse(readFileSync(join(f.root, "host.json"), "utf8")) as {
      calls: { kind: string; id: string }[]
    }
    expect(state.calls.filter((c) => c.kind === "create")).toHaveLength(1)
    expect(state.calls.filter((c) => c.kind === "prompt")).toHaveLength(1)
    expect(f.store.attempts(f.plan.planID)).toHaveLength(1)
  }
}, 20000)

test("scope instruction intent survives process death before and after native keyed delivery", async () => {
  for (const fault of ["before-instruction", "after-instruction"]) {
    const f = fixture()
    writeFileSync(
      join(f.root, "fixture.json"),
      JSON.stringify({ planID: f.plan.planID, scopeUpdate: true }),
    )
    expect((await run(f.root, fault)).code).not.toBe(0)
    const intended = f.store
      .effects(f.plan.planID)
      .find((effect) => effect.kind === "scope-instruction")!
    expect(intended.state).toBe("intended")
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    const resumed = await run(f.root, "none")
    expect(resumed.code, resumed.stderr).toBe(0)
    expect(f.store.plan(f.plan.planID)!.state).toBe("accepted")
    const effect = f.store.effects(f.plan.planID).find((item) => item.id === intended.id)!
    expect(effect.state).toBe("completed")
    const state = JSON.parse(readFileSync(join(f.root, "host.json"), "utf8")) as {
      calls: { kind: string; id: string }[]
      instructions: Record<string, Record<string, string>>
    }
    expect(state.calls.filter((item) => item.kind === "instruction")).toHaveLength(1)
    expect(state.calls.filter((item) => item.kind === "create")).toHaveLength(1)
    expect(state.calls.filter((item) => item.kind === "prompt")).toHaveLength(1)
    const payload = JSON.parse(effect.payload)
    expect(state.instructions[payload.sessionID]![payload.key]).toBe(payload.text)
    expect(f.repository.get(f.task.id)!.proposal.writeScope).toEqual(["result.txt"])
    expect(f.store.attempts(f.plan.planID)).toHaveLength(1)
  }
}, 20000)

test("uncertain dispatch stays blocked and a crashed verifier is superseded without repeating its effect", async () => {
  for (const fault of ["before-session", "before-prompt", "verifier"]) {
    const f = fixture(fault === "verifier")
    const crash = await run(f.root, fault)
    const diagnostic = crash.stdout
      ? JSON.parse(crash.stdout).detail.effects.filter((e: { kind: string }) =>
          e.kind.startsWith("verify"),
        )
      : []
    expect(crash.code, `${fault}: ${crash.stderr} ${JSON.stringify(diagnostic)}`).not.toBe(0)
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    const resumed = await run(f.root, "none")
    expect(resumed.code, resumed.stderr).toBe(0)
    if (fault === "verifier") {
      // A check without a receipt is re-runnable: the crashed effect is superseded, not repeated.
      const effects = f.store.effects(f.plan.planID)
      expect(effects.some((effect) => effect.state === "uncertain")).toBe(false)
      expect(
        effects.some(
          (effect) =>
            effect.kind.startsWith("verify") &&
            effect.state === "failed" &&
            JSON.parse(effect.receipt ?? "{}").superseded === true,
        ),
      ).toBe(true)
    } else {
      expect(f.store.plan(f.plan.planID)?.state).toBe("blocked")
      expect(f.store.effects(f.plan.planID).some((effect) => effect.state === "uncertain")).toBe(
        true,
      )
    }
    const before = f.store.effects(f.plan.planID).map((effect) => effect.id)
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    expect((await run(f.root, "none")).code).toBe(0)
    expect(f.store.effects(f.plan.planID).map((effect) => effect.id)).toEqual(before)
  }
}, 20000)

test("durable outbox survives process death before/after host delivery without duplicate notices", async () => {
  for (const fault of ["before-notify", "after-notify"]) {
    const f = fixture()
    expect((await run(f.root, fault)).code).not.toBe(0)
    f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
    const resumed = await run(f.root, "none")
    expect(resumed.code, resumed.stderr).toBe(0)
    const state = JSON.parse(readFileSync(join(f.root, "host.json"), "utf8")) as {
      calls: { kind: string; id: string }[]
    }
    const notices = state.calls.filter((c) => c.kind === "notify")
    expect(new Set(notices.map((c) => c.id)).size).toBe(notices.length)
    const latest = f.store.atomic((db) =>
      db
        .query<{ state: string; payload: string; receipt: string | null }, [string]>(
          // Receipts are child rows; the newest one is the last entry of the old history.
          `SELECT o.state,o.payload,
             (SELECT r.body FROM runner_outbox_receipts r WHERE r.outbox_id=o.id ORDER BY r.seq DESC LIMIT 1) AS receipt
           FROM runner_outbox o WHERE o.plan_id=? ORDER BY o.rowid DESC LIMIT 1`,
        )
        .get(f.plan.planID),
    )
    expect(JSON.parse(latest!.payload).status).toBe("accepted")
    // Delivery ends at the host's inbox; consumption is never polled.
    expect(latest?.state).toBe("delivered")
    expect(JSON.parse(latest!.receipt!)).toMatchObject({ kind: "host-admitted" })
    expect(state.calls.filter((c) => c.kind === "prompt")).toHaveLength(1)
  }
}, 20000)

test("a crash after native admission neither repeats the notice nor loses its delivery", async () => {
  const f = fixture()
  writeFileSync(
    join(f.root, "fixture.json"),
    JSON.stringify({ planID: f.plan.planID, unownedTranscript: true }),
  )
  expect((await run(f.root, "after-notify")).code).not.toBe(0)
  const interruptedState = JSON.parse(readFileSync(join(f.root, "host.json"), "utf8")) as {
    calls: { kind: string; id: string }[]
  }
  const interruptedNotice = interruptedState.calls.find((call) => call.kind === "notify")!
  expect(interruptedNotice).toBeDefined()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const resumed = await run(f.root, "none")
  expect(resumed.code, resumed.stderr).toBe(0)
  const latest = f.store.atomic((db) =>
    db
      .query<{ state: string; receipt: string; message_id: string }, []>(
        `SELECT o.state,o.message_id,
           (SELECT r.body FROM runner_outbox_receipts r WHERE r.outbox_id=o.id ORDER BY r.seq DESC LIMIT 1) AS receipt
         FROM runner_outbox o ORDER BY o.rowid DESC LIMIT 1`,
      )
      .get()!,
  )
  expect(latest.state).toBe("delivered")
  expect(JSON.parse(latest.receipt)).toMatchObject({ kind: "host-admitted" })
  const state = JSON.parse(readFileSync(join(f.root, "host.json"), "utf8")) as {
    calls: { kind: string; id: string }[]
  }
  const notices = state.calls.filter((call) => call.kind === "notify")
  // Task and combined acceptance may each notify; recovery must not duplicate either identity.
  expect(new Set(notices.map((call) => call.id)).size).toBe(notices.length)
  expect(notices.filter((call) => call.id === interruptedNotice.id)).toHaveLength(1)
  expect(notices.filter((call) => call.id === latest.message_id)).toHaveLength(1)
  const interruptedDelivery = f.store.atomic((db) =>
    db
      .query<{ state: string }, [string]>("SELECT state FROM runner_outbox WHERE message_id=?")
      .get(interruptedNotice.id),
  )
  expect(interruptedDelivery?.state).toBeDefined()
  expect(interruptedDelivery?.state).not.toBe("consumed")
}, 20000)
