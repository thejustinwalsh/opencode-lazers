/**
 * Persistence for stable change identity.
 *
 * Identity lives in one additive side table rather than new columns on the
 * runner tables: several plugin versions can be loaded against one database,
 * and an older process (or fixture) that inserts positionally into
 * `runner_attempts`, `runner_nodes`, `runner_plans`, `runner_evidence` or
 * `runner_adoptions` must keep working. Every SHA column on those tables stays
 * as an observation; this table records what the SHA stood for.
 *
 * One row per (subject, subject_id). `sha` is the commit the row was computed
 * for, so a row for a different SHA is stale and gets restamped.
 *
 *   subject            subject_id            meaning
 *   attempt            attempt id            attempt artifact + change id + base tree
 *   node               plan_id:task_id       current accepted artifact of a task node
 *   plan               plan id               combined plan artifact
 *   plan-base          plan id               plan baseCommit
 *   evidence           evidence id           artifact a receipt was recorded for
 *   adoption-old | adoption-descendant | adoption-combined | adoption-landing |
 *   adoption-baseline  adoption id           the five SHAs an adoption pins
 */
import type { Database } from "bun:sqlite"

export const identitySubjects = [
  "attempt",
  "node",
  "plan",
  "plan-base",
  "evidence",
  "adoption-old",
  "adoption-descendant",
  "adoption-combined",
  "adoption-landing",
  "adoption-baseline",
] as const
export type IdentitySubject = (typeof identitySubjects)[number]

export type IdentityRow = {
  subject: IdentitySubject
  subject_id: string
  sha: string
  tree: string | null
  patch_id: string | null
  commit_patch_ids: string | null
  base_tree: string | null
  change_id: string | null
  recorded_at: number
}

export function installChangeIdentity(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runner_change_identity (
      subject TEXT NOT NULL, subject_id TEXT NOT NULL, sha TEXT NOT NULL DEFAULT '',
      tree TEXT, patch_id TEXT, commit_patch_ids TEXT, base_tree TEXT, change_id TEXT,
      recorded_at INTEGER NOT NULL, PRIMARY KEY(subject,subject_id)
    );
    CREATE INDEX IF NOT EXISTS runner_change_identity_sha
      ON runner_change_identity(sha) WHERE sha!='';
    CREATE INDEX IF NOT EXISTS runner_change_identity_change
      ON runner_change_identity(change_id) WHERE change_id IS NOT NULL;
  `)
}

export const nodeSubjectID = (planID: string, taskID: string) => `${planID}:${taskID}`

export type IdentityRecord = {
  sha: string
  tree?: string | null
  patchId?: string | null
  commitPatchIds?: readonly string[] | null
  baseTree?: string | null
  changeId?: string | null
}

/** Record or refresh a row. An existing change id is never replaced. */
export function recordIdentity(
  db: Database,
  subject: IdentitySubject,
  subjectID: string,
  record: IdentityRecord,
  now = Date.now(),
) {
  db.query(
    `INSERT INTO runner_change_identity(subject,subject_id,sha,tree,patch_id,commit_patch_ids,base_tree,change_id,recorded_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(subject,subject_id) DO UPDATE SET
       sha=excluded.sha,tree=excluded.tree,patch_id=excluded.patch_id,
       commit_patch_ids=excluded.commit_patch_ids,base_tree=excluded.base_tree,
       change_id=COALESCE(runner_change_identity.change_id,excluded.change_id),
       recorded_at=excluded.recorded_at`,
  ).run(
    subject,
    subjectID,
    record.sha,
    record.tree ?? null,
    record.patchId ?? null,
    record.commitPatchIds ? JSON.stringify(record.commitPatchIds) : null,
    record.baseTree ?? null,
    record.changeId ?? null,
    now,
  )
}

export function readIdentity(
  db: Database,
  subject: IdentitySubject,
  subjectID: string,
): IdentityRow | undefined {
  return (
    db
      .query<IdentityRow, [string, string]>(
        "SELECT * FROM runner_change_identity WHERE subject=? AND subject_id=?",
      )
      .get(subject, subjectID) ?? undefined
  )
}

/** The identity for `sha` only when the stored row was computed for exactly that commit. */
export function identityFor(
  db: Database,
  subject: IdentitySubject,
  subjectID: string,
  sha: string | null | undefined,
): IdentityRow | undefined {
  if (!sha) return undefined
  const row = readIdentity(db, subject, subjectID)
  return row && row.sha === sha ? row : undefined
}

/** Tree OID of any commit previously stamped, from any subject. Never invokes Git. */
export function knownTree(db: Database, sha: string | null | undefined): string | undefined {
  if (!sha) return undefined
  return (
    db
      .query<{ tree: string }, [string]>(
        "SELECT tree FROM runner_change_identity WHERE sha=? AND tree IS NOT NULL LIMIT 1",
      )
      .get(sha)?.tree ?? undefined
  )
}

/** Reads an attempt's change id, assigning and storing a fresh UUID once. Run inside a transaction. */
export function changeIdFor(db: Database, attemptID: string): string {
  const existing = readIdentity(db, "attempt", attemptID)?.change_id
  if (existing) return existing
  const created = crypto.randomUUID()
  db.query(
    `INSERT INTO runner_change_identity(subject,subject_id,sha,change_id,recorded_at)
     VALUES('attempt',?,'',?,?)
     ON CONFLICT(subject,subject_id) DO UPDATE SET change_id=COALESCE(change_id,excluded.change_id)`,
  ).run(attemptID, created, Date.now())
  return readIdentity(db, "attempt", attemptID)?.change_id ?? created
}
