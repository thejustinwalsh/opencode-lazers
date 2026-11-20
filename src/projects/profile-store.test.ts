import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerProject, resetProjectAliasCache } from "../project-key.ts"
import { TaskRepository } from "../storage.ts"
import { parseProfile, type ProjectProfile } from "./profile.ts"
import {
  activeProfile,
  activeProfileForKey,
  confirmRevision,
  discardRevision,
  pendingRevision,
  profileRevisionByID,
  profileRevisions,
  proposeRevision,
  ProfileStoreError,
  type ProofRecord,
} from "./profile-store.ts"
import { profileRevisionMachine } from "./profile-machine.ts"
import { lifecycleTransition } from "../runner/lifecycle-machines.ts"
import { projectSettings, setProjectSetting } from "./settings.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  resetProjectAliasCache()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function setup() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "lazers-profile-store-")))
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }))
  const directory = join(parent, "project")
  mkdirSync(directory)
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["remote", "add", "origin", "git@h.com:a/p.git"],
  ])
    Bun.spawnSync(["git", "-C", directory, ...args])
  const repository = new TaskRepository(join(parent, "db.sqlite"), directory)
  cleanups.push(() => repository.close())
  const { key } = await registerProject(repository, { directory, opencodeProjectID: "p1" })
  return { repository, directory, key }
}

const make = (command: string, extra: Partial<ProjectProfile> = {}): ProjectProfile => {
  const parsed = parseProfile({
    toolchains: ["cargo"],
    verify: [{ id: "tests", command }],
    source: { include: ["src/**/*.rs"] },
    ...extra,
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.profile
}
const proof = (key: string, outcome: ProofRecord["outcome"] = "proven"): ProofRecord => ({
  key,
  command: "cargo test",
  outcome,
  exitCode: outcome === "proven" ? 0 : 1,
  timedOut: false,
  durationMs: 12,
  stdoutTail: "ok",
  stderrTail: "",
  ranAt: 1,
})
const author = { kind: "architect", sessionID: "s1", agent: "architect" } as const
const propose = (repository: TaskRepository, key: string, command: string) =>
  proposeRevision(repository, {
    projectKey: key,
    profile: make(command),
    author,
    reason: "test",
    proofs: [proof("verify:tests")],
  })

test("a proposal is stored with its proofs and is never active", async () => {
  const { repository, directory, key } = await setup()
  const row = propose(repository, key, "cargo test")
  expect(row).toMatchObject({ revision: 1, state: "proposed", projectKey: key })
  expect(row.proofs.map((p) => p.key)).toEqual(["verify:tests"])
  expect(activeProfile(repository, directory)).toBeUndefined()
  expect(activeProfileForKey(repository, key)).toBeUndefined()
  expect(pendingRevision(repository, key)?.revision).toBe(1)
})

test("confirming makes the revision active, with its proofs", async () => {
  const { repository, directory, key } = await setup()
  propose(repository, key, "cargo test")
  const confirmed = confirmRevision(repository, { projectKey: key, revision: 1, by: "owner" })
  expect(confirmed).toMatchObject({ state: "confirmed", decidedBy: "owner" })
  const active = activeProfile(repository, directory)
  expect(active).toMatchObject({ revision: 1, projectKey: key })
  expect(active?.profile.verify[0]?.command).toBe("cargo test")
  expect(active?.proofs.get("verify:tests")?.outcome).toBe("proven")
  expect(active?.confirmedAt).toBe(confirmed.decidedAt!)
})

test("a pending edit never replaces the running revision; a new proposal replaces the pending one", async () => {
  const { repository, directory, key } = await setup()
  propose(repository, key, "cargo test")
  confirmRevision(repository, { projectKey: key, revision: 1, by: "owner" })
  const second = propose(repository, key, "cargo test --locked")
  expect(second.revision).toBe(2)
  expect(activeProfile(repository, directory)?.revision).toBe(1)
  const third = propose(repository, key, "cargo test --all")
  expect(third.revision).toBe(3)
  const states = Object.fromEntries(
    profileRevisions(repository, key).map((r) => [r.revision, r.state]),
  )
  expect(states).toEqual({ 1: "confirmed", 2: "discarded", 3: "proposed" })
  expect(profileRevisions(repository, key).map((r) => r.revision)).toEqual([3, 2, 1])
  expect(activeProfile(repository, directory)?.revision).toBe(1)
})

test("a later confirmation supersedes, and a pinned revision stays readable", async () => {
  const { repository, directory, key } = await setup()
  const first = propose(repository, key, "cargo test")
  confirmRevision(repository, { projectKey: key, revision: 1, by: "owner" })
  propose(repository, key, "cargo test --locked")
  const third = propose(repository, key, "cargo test --all")
  confirmRevision(repository, { projectKey: key, revision: 3, by: "owner" })
  expect(activeProfile(repository, directory)?.revision).toBe(3)
  expect(profileRevisionByID(repository, first.id)?.profile.verify[0]?.command).toBe("cargo test")
  expect(profileRevisionByID(repository, third.id)?.revision).toBe(3)
  expect(() => confirmRevision(repository, { projectKey: key, revision: 2, by: "owner" })).toThrow(
    ProfileStoreError,
  )
  try {
    confirmRevision(repository, { projectKey: key, revision: 2, by: "owner" })
  } catch (error) {
    expect((error as ProfileStoreError).code).toBe("PROFILE_REVISION_NOT_PENDING")
  }
})

test("a discarded or proposed revision cannot be pinned; a missing one is reported", async () => {
  const { repository, key } = await setup()
  const row = propose(repository, key, "cargo test")
  expect(profileRevisionByID(repository, row.id)).toBeUndefined()
  discardRevision(repository, { projectKey: key, revision: 1, by: "owner" })
  expect(profileRevisionByID(repository, row.id)).toBeUndefined()
  expect(() => confirmRevision(repository, { projectKey: key, revision: 1, by: "owner" })).toThrow(
    /PROFILE_REVISION_NOT_PENDING|not pending/,
  )
  try {
    confirmRevision(repository, { projectKey: key, revision: 9, by: "owner" })
  } catch (error) {
    expect((error as ProfileStoreError).code).toBe("PROFILE_REVISION_MISSING")
  }
  expect(pendingRevision(repository, key)).toBeUndefined()
})

test("confirming changes only state and decision columns", async () => {
  const { repository, key } = await setup()
  propose(repository, key, "cargo test")
  const read = () =>
    repository.read((db) =>
      db
        .query<Record<string, unknown>, []>(
          "SELECT payload,sha256,reason,created_at,author_kind,session_id,agent FROM lazers_profile_revisions",
        )
        .get(),
    )
  const before = read()
  confirmRevision(repository, { projectKey: key, revision: 1, by: "owner" })
  expect(read()).toEqual(before)
  expect(before?.sha256).toMatch(/^[0-9a-f]{64}$/)
})

test("an invalid profile is refused on write; a corrupted stored payload reads as no profile", async () => {
  const { repository, directory, key } = await setup()
  expect(() =>
    proposeRevision(repository, {
      projectKey: key,
      profile: { verify: [] } as unknown as ProjectProfile,
      author,
      reason: "bad",
      proofs: [],
    }),
  ).toThrow(ProfileStoreError)
  propose(repository, key, "cargo test")
  confirmRevision(repository, { projectKey: key, revision: 1, by: "owner" })
  expect(activeProfile(repository, directory)).toBeDefined()
  repository.atomic((db) => db.exec("UPDATE lazers_profile_revisions SET payload='{'"))
  expect(activeProfile(repository, directory)).toBeUndefined()
  expect(profileRevisions(repository, key)).toEqual([])
})

test("an unregistered directory has no profile", async () => {
  const { repository } = await setup()
  expect(activeProfile(repository, "/nowhere")).toBeUndefined()
})

test("a confirmation hook runs inside the confirming transaction", async () => {
  const { repository, key } = await setup()
  propose(repository, key, "cargo test")
  let seen = ""
  expect(() =>
    confirmRevision(repository, {
      projectKey: key,
      revision: 1,
      by: "owner",
      onConfirmed: (_db, row) => {
        seen = row.state
        throw new Error("hook failed")
      },
    }),
  ).toThrow("hook failed")
  expect(seen).toBe("confirmed")
  expect(activeProfileForKey(repository, key)).toBeUndefined()
  expect(pendingRevision(repository, key)?.revision).toBe(1)
})

test("the revision machine: only proposed has exits, and SQL transitions use it", () => {
  expect(lifecycleTransition("profile", "proposed", "OWNER_CONFIRMED")).toBe("confirmed")
  expect(lifecycleTransition("profile", "proposed", "OWNER_DISCARDED")).toBe("discarded")
  expect(lifecycleTransition("profile", "proposed", "REPLACED")).toBe("discarded")
  expect(() => lifecycleTransition("profile", "confirmed", "OWNER_DISCARDED")).toThrow()
  expect(profileRevisionMachine.config.initial).toBe("proposed")
})

test("the setup dismissal setting defaults to null and round-trips an epoch value", async () => {
  const { repository, key } = await setup()
  expect(projectSettings(repository, key).setupDismissedAt).toBeNull()
  setProjectSetting(repository, key, "setupDismissedAt", 1_800_000_000_000)
  expect(projectSettings(repository, key).setupDismissedAt).toBe(1_800_000_000_000)
  setProjectSetting(repository, key, "setupDismissedAt", undefined)
  expect(projectSettings(repository, key).setupDismissedAt).toBeNull()
})
