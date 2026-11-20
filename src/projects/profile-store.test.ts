import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerProject, resetProjectAliasCache } from "../project-key.ts"
import { TaskRepository } from "../storage.ts"
import { parseProfile, type ProjectProfile } from "./profile.ts"
import {
  activateRevision,
  activeProfile,
  activeProfileForKey,
  profileRevisionByID,
  profileRevisions,
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
const activate = (repository: TaskRepository, key: string, command: string) =>
  activateRevision(repository, {
    projectKey: key,
    profile: make(command),
    author,
    reason: "test",
    proofs: [proof("verify:tests")],
  })

test("a revision is active and readable the moment it is written, with its proofs", async () => {
  const { repository, directory, key } = await setup()
  expect(activeProfile(repository, directory)).toBeUndefined()
  const row = activate(repository, key, "cargo test")
  expect(row).toMatchObject({ revision: 1, state: "active", projectKey: key })
  const active = activeProfile(repository, directory)
  expect(active).toMatchObject({ revision: 1, projectKey: key, revisionID: row.id })
  expect(active?.profile.verify[0]?.command).toBe("cargo test")
  expect(active?.proofs.get("verify:tests")?.outcome).toBe("proven")
  expect(activeProfileForKey(repository, key)?.revision).toBe(1)
})

test("a new revision supersedes the active one; the earlier one stays readable by id", async () => {
  const { repository, directory, key } = await setup()
  const first = activate(repository, key, "cargo test")
  const second = activate(repository, key, "cargo test --locked")
  expect(second.revision).toBe(2)
  const states = Object.fromEntries(
    profileRevisions(repository, key).map((r) => [r.revision, r.state]),
  )
  expect(states).toEqual({ 1: "superseded", 2: "active" })
  expect(profileRevisions(repository, key).map((r) => r.revision)).toEqual([2, 1])
  expect(activeProfile(repository, directory)?.revision).toBe(2)
  // A run pinned to the first revision still reads it.
  expect(profileRevisionByID(repository, first.id)?.profile.verify[0]?.command).toBe("cargo test")
  expect(profileRevisionByID(repository, second.id)?.revision).toBe(2)
  expect(profileRevisionByID(repository, 9999)).toBeUndefined()
})

test("superseding changes only the state and decision columns", async () => {
  const { repository, key } = await setup()
  activate(repository, key, "cargo test")
  const read = () =>
    repository.read((db) =>
      db
        .query<Record<string, unknown>, []>(
          "SELECT payload,sha256,reason,created_at,author_kind,session_id,agent FROM lazers_profile_revisions WHERE revision=1",
        )
        .get(),
    )
  const before = read()
  activate(repository, key, "cargo test --locked")
  expect(read()).toEqual(before)
  expect(before?.sha256).toMatch(/^[0-9a-f]{64}$/)
})

test("an invalid profile is refused on write; a corrupted stored payload reads as no profile", async () => {
  const { repository, directory, key } = await setup()
  expect(() =>
    activateRevision(repository, {
      projectKey: key,
      profile: { verify: [] } as unknown as ProjectProfile,
      author,
      reason: "bad",
      proofs: [],
    }),
  ).toThrow(ProfileStoreError)
  expect(profileRevisions(repository, key)).toEqual([])
  activate(repository, key, "cargo test")
  expect(activeProfile(repository, directory)).toBeDefined()
  repository.atomic((db) => db.exec("UPDATE lazers_profile_revisions SET payload='{'"))
  expect(activeProfile(repository, directory)).toBeUndefined()
  expect(profileRevisions(repository, key)).toEqual([])
})

test("an unregistered directory has no profile", async () => {
  const { repository } = await setup()
  expect(activeProfile(repository, "/nowhere")).toBeUndefined()
})

test("activating drops the project's stored source filters in the same transaction", async () => {
  const { repository, directory, key } = await setup()
  repository.atomic((db) =>
    db.query("INSERT INTO repo_map_sources VALUES(?,?,?,?)").run(directory, '["src/**"]', "[]", 1),
  )
  const rows = () =>
    repository.read(
      (db) => db.query("SELECT COUNT(*) AS n FROM repo_map_sources").get() as { n: number },
    ).n
  expect(rows()).toBe(1)
  activate(repository, key, "cargo test")
  expect(rows()).toBe(0)
})

test("the revision machine: active has an exit, superseded none, and SQL transitions use it", () => {
  expect(lifecycleTransition("profile", "active", "SUPERSEDED")).toBe("superseded")
  expect(() => lifecycleTransition("profile", "superseded", "SUPERSEDED")).toThrow()
  expect(profileRevisionMachine.config.initial).toBe("active")
})

test("a database written before the confirmation step was removed is migrated: the newest proposal wins", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "lazers-profile-migrate-")))
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }))
  const path = join(parent, "db.sqlite")
  const directory = join(parent, "project")
  mkdirSync(directory)
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["remote", "add", "origin", "git@h.com:a/m.git"],
  ])
    Bun.spawnSync(["git", "-C", directory, ...args])
  let repository = new TaskRepository(path, directory)
  const { key } = await registerProject(repository, { directory, opencodeProjectID: "p1" })
  const payload = JSON.stringify(make("cargo test"))
  // Put the profile tables back as the previous generation left them.
  repository.atomic((db) => {
    db.exec(`
      DROP TABLE lazers_profile_revisions;
      CREATE TABLE lazers_profile_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('proposed','confirmed','discarded')),
        payload TEXT NOT NULL, sha256 TEXT NOT NULL,
        author_kind TEXT NOT NULL CHECK(author_kind IN ('architect','owner')),
        session_id TEXT, agent TEXT, reason TEXT NOT NULL, map_preview TEXT,
        created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT,
        UNIQUE(project_key, revision));
      UPDATE schema_modules SET generation=2 WHERE module='project-profile';
    `)
    const insert = db.query(
      `INSERT INTO lazers_profile_revisions(project_key,revision,state,payload,sha256,author_kind,reason,created_at)
       VALUES(?,?,?,?,?,'architect','old',?)`,
    )
    insert.run(key, 1, "confirmed", payload, "a", 1)
    insert.run(key, 2, "discarded", payload, "b", 2)
    insert.run(key, 3, "proposed", payload, "c", 3)
    db.query("INSERT INTO repo_map_sources VALUES(?,?,?,?)").run(directory, '["src/**"]', "[]", 1)
  })
  repository.close()
  resetProjectAliasCache()
  repository = new TaskRepository(path, directory)
  cleanups.push(() => repository.close())
  const states = Object.fromEntries(
    profileRevisions(repository, key).map((r) => [r.revision, r.state]),
  )
  expect(states).toEqual({ 1: "superseded", 2: "superseded", 3: "active" })
  expect(activeProfile(repository, directory)?.revision).toBe(3)
  expect(
    repository.read(
      (db) => db.query("SELECT COUNT(*) AS n FROM repo_map_sources").get() as { n: number },
    ).n,
  ).toBe(0)
  // New revisions continue the numbering, and the migrated table accepts them.
  expect(activate(repository, key, "cargo test --locked").revision).toBe(4)
})

test("the setup dismissal setting defaults to null and round-trips an epoch value", async () => {
  const { repository, key } = await setup()
  expect(projectSettings(repository, key).setupDismissedAt).toBeNull()
  setProjectSetting(repository, key, "setupDismissedAt", 1_800_000_000_000)
  expect(projectSettings(repository, key).setupDismissedAt).toBe(1_800_000_000_000)
  setProjectSetting(repository, key, "setupDismissedAt", undefined)
  expect(projectSettings(repository, key).setupDismissedAt).toBeNull()
})
