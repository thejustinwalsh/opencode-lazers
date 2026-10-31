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
        ? 'kill -KILL "$LAZERS_TEST_RUNNER_PID"'
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

test("legacy delivered outbox rows reopen as host-admitted with unknown consumption", () => {
  const f = fixture()
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
    state: "admitted",
  })
  expect(JSON.parse(migrated!.receipt)).toEqual({
    kind: "legacy-host-admitted",
    consumption: "unknown",
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
  ).toEqual({ state: "admitted", receipt: migrated!.receipt })
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

test("uncertain dispatch or verifier crash stays blocked without repeating its effect", async () => {
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
    expect(f.store.plan(f.plan.planID)?.state).toBe("blocked")
    expect(f.store.effects(f.plan.planID).some((effect) => effect.state === "uncertain")).toBe(true)
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
        .query<{ state: string; payload: string }, [string]>(
          "SELECT state,payload FROM runner_outbox WHERE plan_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(f.plan.planID),
    )
    expect(JSON.parse(latest!.payload).status).toBe("accepted")
    expect(latest?.state).toBe(fault === "before-notify" ? "admitted" : "unknown")
    expect(state.calls.filter((c) => c.kind === "prompt")).toHaveLength(1)
  }
}, 20000)
