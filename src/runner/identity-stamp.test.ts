import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backfillChangeIdentity } from "../../scripts/backfill-change-identity.ts"
import { git } from "./artifacts.ts"
import { cleanupFixtureRepos, commitFile, fixtureRepo } from "./change-identity-fixture.ts"
import { readChangeNote } from "./change-identity.ts"
import { identityFor, knownTree, nodeSubjectID, readIdentity } from "./identity-store.ts"

const directories: string[] = []
afterEach(() => {
  cleanupFixtureRepos()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const missing = "f".repeat(40)

/** A legacy-shaped database: runner rows with SHAs and no identity table yet. */
function legacyDatabase(input: { base: string; artifact: string; descendant: string }) {
  const directory = mkdtempSync(join(tmpdir(), "lazers-backfill-db-"))
  directories.push(directory)
  const path = join(directory, "tasks.sqlite")
  const db = new Database(path)
  db.exec(`
    CREATE TABLE runner_plans (id TEXT PRIMARY KEY, project_directory TEXT, body TEXT NOT NULL, artifact TEXT);
    CREATE TABLE runner_nodes (plan_id TEXT, task_id TEXT, artifact TEXT);
    CREATE TABLE runner_attempts (id TEXT PRIMARY KEY, plan_id TEXT, task_id TEXT, number INTEGER,
      base_commit TEXT NOT NULL, artifact TEXT);
    CREATE TABLE runner_evidence (id TEXT PRIMARY KEY, plan_id TEXT, artifact TEXT NOT NULL);
    CREATE TABLE runner_adoptions (id TEXT PRIMARY KEY, plan_id TEXT, old_artifact TEXT NOT NULL,
      descendant_commit TEXT NOT NULL, combined_artifact TEXT NOT NULL, landing_head TEXT NOT NULL,
      reviewed_baseline TEXT NOT NULL DEFAULT '');
  `)
  db.query("INSERT INTO runner_plans VALUES('plan','/project',?,?)").run(
    JSON.stringify({ baseCommit: input.base }),
    input.artifact,
  )
  db.query("INSERT INTO runner_nodes VALUES('plan','task',?)").run(input.artifact)
  db.query("INSERT INTO runner_attempts VALUES('attempt','plan','task',1,?,?)").run(
    input.base,
    input.artifact,
  )
  db.query("INSERT INTO runner_attempts VALUES('gone','plan','task',2,?,?)").run(
    input.base,
    missing,
  )
  db.query("INSERT INTO runner_evidence VALUES('evidence','plan',?)").run(input.artifact)
  db.query("INSERT INTO runner_adoptions VALUES('adoption','plan',?,?,?,?,'')").run(
    input.artifact,
    input.descendant,
    input.artifact,
    input.base,
  )
  db.close()
  return path
}

test("backfill stamps identity, writes notes, reports unresolved SHAs and is idempotent", async () => {
  const repo = fixtureRepo()
  commitFile(repo, "a.txt", "base\n", "base")
  const base = git(repo, ["rev-parse", "HEAD"])
  const artifact = commitFile(repo, "b.txt", "work\n", "work")
  const descendant = commitFile(repo, "c.txt", "more\n", "more")
  const path = legacyDatabase({ base, artifact, descendant })

  const dry = await backfillChangeIdentity({ db: path, repo, dryRun: true })
  expect(dry.unresolved).toEqual([missing])
  expect(dry.notesWritten).toBe(1)
  expect(() => git(repo, ["notes", "--ref=lazers", "show", artifact])).toThrow()
  const untouched = new Database(path, { readonly: true })
  expect(
    untouched.query("SELECT name FROM sqlite_master WHERE name='runner_change_identity'").get(),
  ).toBeNull()
  untouched.close()

  const report = await backfillChangeIdentity({ db: path, repo })
  expect(report.unresolved).toEqual([missing])
  expect(report.changeIdsAssigned).toBe(1)
  expect(report.notesWritten).toBe(1)

  const db = new Database(path)
  const attempt = readIdentity(db, "attempt", "attempt")!
  expect(attempt.sha).toBe(artifact)
  expect(attempt.tree).toBe(git(repo, ["rev-parse", `${artifact}^{tree}`]))
  expect(attempt.base_tree).toBe(git(repo, ["rev-parse", `${base}^{tree}`]))
  expect(attempt.patch_id).toMatch(/^[a-f0-9]{40}/)
  expect(attempt.change_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(readIdentity(db, "attempt", "gone")).toBeUndefined()
  expect(identityFor(db, "node", nodeSubjectID("plan", "task"), artifact)?.change_id).toBe(
    attempt.change_id!,
  )
  expect(knownTree(db, descendant)).toBe(git(repo, ["rev-parse", `${descendant}^{tree}`]))
  expect(readIdentity(db, "plan-base", "plan")?.sha).toBe(base)
  expect((await readChangeNote(repo, artifact))?.changeId).toBe(attempt.change_id!)
  // SHA columns are untouched observations.
  expect(
    db.query<{ artifact: string }, []>("SELECT artifact FROM runner_attempts WHERE id='gone'").get()
      ?.artifact,
  ).toBe(missing)
  db.close()

  const again = await backfillChangeIdentity({ db: path, repo })
  expect(again.changeIdsAssigned).toBe(0)
  expect(again.rowsUpdated).toEqual({})
  const after = new Database(path, { readonly: true })
  expect(readIdentity(after, "attempt", "attempt")?.change_id).toBe(attempt.change_id!)
  after.close()
})
