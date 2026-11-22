import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CheckRunProfile } from "../src/projects/profile-runtime.ts"
import { runDeclaredCheck } from "../src/runner/artifacts.ts"
import type { ReloadObservationDependencies } from "../src/runner/reload-observation.ts"
import { observeVerificationProcesses } from "../src/runner/reload-process-observation.ts"
import { runReloadSafe } from "./reload-safe.ts"

const PROFILE_REVISION_ID = 17

test("reload-safe uses a pinned non-Bun profile for live and settled check phases", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-reload-profile-"))
  const databasePath = join(root, "tasks.sqlite")
  const workspace = join(root, "workspace")
  const releaseFile = join(root, "release-check")
  const receiptPath = join(root, "receipts", "profile-check.json")
  const missingOpenCodeDB = join(root, "opencode.db")
  mkdirSync(workspace)

  const firstPhase = "printf profile-phase-one"
  const lastPhase = `while [ ! -f ${releaseFile} ]; do sleep 0.05; done`
  const command = `${firstPhase} && ${lastPhase}`
  const profile: CheckRunProfile = {
    revisionID: PROFILE_REVISION_ID,
    toolchains: ["rust"],
    commands: {
      toolchains: ["rust"],
      verify: [firstPhase, lastPhase],
      fix: [],
    },
    identity: {
      revision: 1,
      toolchains: ["rust"],
      env: [],
      toolVersions: {},
    },
  }

  const db = new Database(databasePath)
  db.exec(`
    CREATE TABLE runner_plans(id TEXT, state TEXT, owner TEXT);
    CREATE TABLE runner_attempts(id TEXT, plan_id TEXT, state TEXT, session_id TEXT);
    CREATE TABLE runner_effects(
      id TEXT, plan_id TEXT, kind TEXT, state TEXT, payload TEXT, receipt TEXT
    );
    CREATE TABLE runner_transitions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT,
      event TEXT,
      payload TEXT,
      created_at INTEGER
    );
    CREATE TABLE lazers_profile_revisions(
      id INTEGER PRIMARY KEY, project_key TEXT, revision INTEGER, state TEXT, payload TEXT,
      sha256 TEXT, author_kind TEXT, session_id TEXT, agent TEXT, reason TEXT, map_preview TEXT,
      created_at INTEGER, decided_at INTEGER, decided_by TEXT
    );
    CREATE TABLE lazers_profile_proofs(
      revision_id INTEGER, command_key TEXT, command TEXT, effective_command TEXT, outcome TEXT,
      exit_code INTEGER, timed_out INTEGER, duration_ms INTEGER, reason TEXT, stdout_tail TEXT,
      stderr_tail TEXT, tool_version TEXT, ran_at INTEGER,
      PRIMARY KEY(revision_id, command_key)
    );
  `)
  const profilePayload = {
    toolchains: ["rust"],
    verify: [
      { id: "format", command: firstPhase },
      { id: "test", command: lastPhase },
    ],
    fix: [],
    env: [],
    audit: "off",
    source: { include: ["src/**"], exclude: [] },
  }
  db.run(
    `INSERT INTO lazers_profile_revisions
     VALUES(?, 'project', 1, 'superseded', ?, 'profile-sha', 'owner', NULL, NULL, 'test',
       NULL, ?, NULL, NULL)`,
    [PROFILE_REVISION_ID, JSON.stringify(profilePayload), Date.now()],
  )
  db.run(
    `INSERT INTO runner_effects(id,plan_id,kind,state,payload,receipt)
     VALUES('profile-check','p','verify:profile-check','intended',?,NULL)`,
    [
      JSON.stringify({
        check: {
          id: "profile-check",
          command,
          inactivityTimeoutMs: 60_000,
          hardTimeoutMs: 120_000,
        },
        verificationDeadline: { effectiveHardTimeoutMs: 120_000 },
        profileRevisionID: PROFILE_REVISION_ID,
        workspace,
        receiptPath,
      }),
    ],
  )
  const intentStartedAt = Date.now()
  db.run(
    "INSERT INTO runner_transitions(plan_id,event,payload,created_at) VALUES('p','EFFECT_INTENDED',?,?)",
    [JSON.stringify({ effectID: "profile-check" }), intentStartedAt],
  )
  db.close()

  const dependencies: ReloadObservationDependencies = {
    observeSessions: async () => ({ kind: "observed", sessionIDs: [] }),
    observeVerifications: (readonlyDB) => observeVerificationProcesses(readonlyDB),
  }
  let execution: ReturnType<typeof runDeclaredCheck> | undefined
  try {
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "profile-check" }))
    execution = runDeclaredCheck(
      workspace,
      "artifact",
      {
        id: "profile-check",
        command,
        inactivityTimeoutMs: 60_000,
        hardTimeoutMs: 120_000,
      },
      receiptPath,
      { profile },
    )
    for (let attempt = 0; attempt < 200 && !existsSync(`${receiptPath}.phase-0.json`); attempt++)
      await Bun.sleep(20)
    expect(existsSync(`${receiptPath}.phase-0.json`)).toBe(true)
    await Bun.sleep(100)

    const live = await runReloadSafe([databasePath, missingOpenCodeDB], dependencies)
    expect(live.exitCode).toBe(1)
    expect(live.stdout).toContain("1 verification running")
    expect(live.stdout).not.toContain("live activity observation unavailable")

    writeFileSync(releaseFile, "done")
    const receipt = await execution
    expect(receipt.phases?.map((phase) => phase.command)).toEqual([firstPhase, lastPhase])
    expect(receipt.phases?.every((phase) => phase.processCleanup?.state === "settled")).toBe(true)

    const settled = await runReloadSafe([databasePath, missingOpenCodeDB], dependencies)
    expect(settled.exitCode).toBe(0)
    expect(settled.stdout).toContain("0 verifications running")
    expect(settled.stdout).not.toContain("live activity observation unavailable")
  } finally {
    if (execution && !existsSync(releaseFile)) writeFileSync(releaseFile, "done")
    await execution?.catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})
