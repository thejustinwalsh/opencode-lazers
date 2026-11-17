/**
 * Record stable change identity (tree OID, patch-id, change id, git note) for
 * every stored artifact, base and combined SHA that still resolves. Idempotent,
 * offline-safe and additive: SHA columns are never touched. The same pass backs
 * the one-time backfill script and the lazy runtime stamping.
 */
import type { Database } from "bun:sqlite"
import {
  artifactIdentity,
  commitResolves,
  isObjectID,
  treeOf,
  writeChangeNote,
} from "./change-identity.ts"
import {
  changeIdFor,
  nodeSubjectID,
  readIdentity,
  recordIdentity,
  type IdentitySubject,
} from "./identity-store.ts"

export type StampAccess = {
  read<T>(run: (db: Database) => T): T
  write<T>(run: (db: Database) => T): T
}

export type StampReport = {
  /** Distinct SHAs whose tree resolved. */
  resolved: number
  /** Distinct stored SHAs that no longer resolve in the repository; they stay unstamped. */
  unresolved: string[]
  notesWritten: number
  changeIdsAssigned: number
  rowsUpdated: Record<string, number>
}

export type StampOptions = {
  /** Restrict to one project's plans; the runtime always passes its own directory. */
  projectDirectory?: string
  dryRun?: boolean
  /** Write git notes for stamped attempt and node artifacts. Default true. */
  notes?: boolean
}

type NoteTarget = { commit: string; changeId: string; taskId: string; attemptId?: string }

/** A stored SHA with the subject that should carry its identity. */
type Pending = { subject: IdentitySubject; id: string; sha: string }

const STALE = `(i.sha IS NULL OR i.sha!=SHA OR i.tree IS NULL)`
const stale = (sha: string) => STALE.replace("SHA", sha)

/** Stamp identity for every stored SHA that has no current identity row yet. */
export async function stampChangeIdentity(
  access: StampAccess,
  directory: string,
  options: StampOptions = {},
): Promise<StampReport> {
  const report: StampReport = {
    resolved: 0,
    unresolved: [],
    notesWritten: 0,
    changeIdsAssigned: 0,
    rowsUpdated: {},
  }
  const trees = new Map<string, string | undefined>()
  const unresolved = new Set<string>()
  const resolved = new Set<string>()
  const tree = async (sha: string | null | undefined) => {
    if (!sha || !isObjectID(sha)) return undefined
    if (!trees.has(sha)) trees.set(sha, await treeOf(directory, sha))
    const found = trees.get(sha)
    if (found) resolved.add(sha)
    else unresolved.add(sha)
    return found
  }
  const bump = (subject: string) => {
    report.rowsUpdated[subject] = (report.rowsUpdated[subject] ?? 0) + 1
  }
  const projectFilter = options.projectDirectory ? " AND p.project_directory=?" : ""
  const projectArgs = options.projectDirectory ? [options.projectDirectory] : []
  const noteTargets: NoteTarget[] = []
  const stampTreeOnly = async (items: Pending[]) => {
    for (const item of items) {
      const found = await tree(item.sha)
      if (!found) continue
      if (!options.dryRun)
        access.write((db) =>
          recordIdentity(db, item.subject, item.id, { sha: item.sha, tree: found }),
        )
      bump(item.subject)
    }
  }

  // Attempts: artifact identity, base tree and change id.
  const attempts = access.read((db) =>
    db
      .query<{ id: string; task_id: string; base_commit: string; artifact: string }, string[]>(
        `SELECT a.id,a.task_id,a.base_commit,a.artifact FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id
         LEFT JOIN runner_change_identity i ON i.subject='attempt' AND i.subject_id=a.id
         WHERE a.artifact IS NOT NULL AND ${stale("a.artifact")}${projectFilter}`,
      )
      .all(...projectArgs),
  )
  for (const attempt of attempts) {
    const artifactTree = await tree(attempt.artifact)
    if (!artifactTree) continue
    const baseTree = await tree(attempt.base_commit)
    const identity = await artifactIdentity(
      directory,
      baseTree ? attempt.base_commit : undefined,
      attempt.artifact,
    )
    if (options.dryRun) {
      report.changeIdsAssigned++
      bump("attempt")
      continue
    }
    const changeId = access.write((db) => {
      const had = readIdentity(db, "attempt", attempt.id)?.change_id
      const assigned = changeIdFor(db, attempt.id)
      if (!had) report.changeIdsAssigned++
      recordIdentity(db, "attempt", attempt.id, {
        sha: attempt.artifact,
        tree: artifactTree,
        patchId: identity.patchId,
        commitPatchIds: identity.commitPatchIds,
        baseTree,
        changeId: assigned,
      })
      return assigned
    })
    bump("attempt")
    noteTargets.push({
      commit: attempt.artifact,
      changeId,
      taskId: attempt.task_id,
      attemptId: attempt.id,
    })
  }

  // Nodes: the node's artifact can differ from the attempt's (adoption, retained repair).
  const nodes = access.read((db) =>
    db
      .query<{ plan_id: string; task_id: string; artifact: string }, string[]>(
        `SELECT n.plan_id,n.task_id,n.artifact FROM runner_nodes n
         JOIN runner_plans p ON p.id=n.plan_id
         LEFT JOIN runner_change_identity i ON i.subject='node' AND i.subject_id=n.plan_id||':'||n.task_id
         WHERE n.artifact IS NOT NULL AND ${stale("n.artifact")}${projectFilter}`,
      )
      .all(...projectArgs),
  )
  for (const node of nodes) {
    const nodeTree = await tree(node.artifact)
    if (!nodeTree) continue
    const latest = access.read((db) =>
      db
        .query<{ id: string; base_commit: string }, [string, string, string]>(
          `SELECT id,base_commit FROM runner_attempts WHERE plan_id=? AND task_id=?
           ORDER BY (artifact=?) DESC,number DESC LIMIT 1`,
        )
        .get(node.plan_id, node.task_id, node.artifact),
    )
    const baseKnown = latest && (await tree(latest.base_commit)) ? latest.base_commit : undefined
    const identity = await artifactIdentity(directory, baseKnown, node.artifact)
    if (!options.dryRun) {
      const changeId = latest
        ? access.write((db) => {
            const had = readIdentity(db, "attempt", latest.id)?.change_id
            const assigned = changeIdFor(db, latest.id)
            if (!had) report.changeIdsAssigned++
            return assigned
          })
        : undefined
      access.write((db) =>
        recordIdentity(db, "node", nodeSubjectID(node.plan_id, node.task_id), {
          sha: node.artifact,
          tree: nodeTree,
          patchId: identity.patchId,
          commitPatchIds: identity.commitPatchIds,
          changeId,
        }),
      )
      if (changeId && latest)
        noteTargets.push({
          commit: node.artifact,
          changeId,
          taskId: node.task_id,
          attemptId: latest.id,
        })
    }
    bump("node")
  }

  // Plans: combined artifact and baseline.
  const plans = access.read((db) =>
    db
      .query<{ id: string; artifact: string | null; base: string | null }, string[]>(
        `SELECT p.id,p.artifact,json_extract(p.body,'$.baseCommit') AS base FROM runner_plans p
         LEFT JOIN runner_change_identity i ON i.subject='plan' AND i.subject_id=p.id
         LEFT JOIN runner_change_identity b ON b.subject='plan-base' AND b.subject_id=p.id
         WHERE ((p.artifact IS NOT NULL AND ${stale("p.artifact")})
            OR (json_extract(p.body,'$.baseCommit') IS NOT NULL
                AND (b.sha IS NULL OR b.sha!=json_extract(p.body,'$.baseCommit') OR b.tree IS NULL)))${projectFilter}`,
      )
      .all(...projectArgs),
  )
  for (const plan of plans) {
    const baseTree = await tree(plan.base)
    if (baseTree && plan.base) {
      if (!options.dryRun)
        access.write((db) =>
          recordIdentity(db, "plan-base", plan.id, { sha: plan.base!, tree: baseTree }),
        )
      bump("plan-base")
    }
    const artifactTree = await tree(plan.artifact)
    if (artifactTree && plan.artifact) {
      const identity = await artifactIdentity(
        directory,
        baseTree ? plan.base! : undefined,
        plan.artifact,
      )
      if (!options.dryRun)
        access.write((db) =>
          recordIdentity(db, "plan", plan.id, {
            sha: plan.artifact!,
            tree: artifactTree,
            patchId: identity.patchId,
            commitPatchIds: identity.commitPatchIds,
            baseTree,
          }),
        )
      bump("plan")
    }
  }

  // Evidence.
  await stampTreeOnly(
    access.read((db) =>
      db
        .query<{ id: string; sha: string }, string[]>(
          `SELECT e.id,e.artifact AS sha FROM runner_evidence e
           JOIN runner_plans p ON p.id=e.plan_id
           LEFT JOIN runner_change_identity i ON i.subject='evidence' AND i.subject_id=e.id
           WHERE ${stale("e.artifact")}${projectFilter}`,
        )
        .all(...projectArgs)
        .map((row) => ({ subject: "evidence" as const, ...row })),
    ),
  )

  // Adoptions pin five SHAs each.
  const adoptionColumns: Array<[IdentitySubject, string]> = [
    ["adoption-old", "old_artifact"],
    ["adoption-descendant", "descendant_commit"],
    ["adoption-combined", "combined_artifact"],
    ["adoption-landing", "landing_head"],
    ["adoption-baseline", "reviewed_baseline"],
  ]
  for (const [subject, column] of adoptionColumns)
    await stampTreeOnly(
      access.read((db) =>
        db
          .query<{ id: string; sha: string }, string[]>(
            `SELECT a.id,a.${column} AS sha FROM runner_adoptions a
             JOIN runner_plans p ON p.id=a.plan_id
             LEFT JOIN runner_change_identity i ON i.subject='${subject}' AND i.subject_id=a.id
             WHERE a.${column}!='' AND ${stale(`a.${column}`)}${projectFilter}`,
          )
          .all(...projectArgs)
          .map((row) => ({ subject, ...row })),
      ),
    )

  if (options.dryRun) {
    // A dry run reports how many notes a real run would write.
    report.notesWritten = new Set(
      attempts.filter((attempt) => trees.get(attempt.artifact)).map((attempt) => attempt.artifact),
    ).size
  } else if (options.notes !== false) {
    const done = new Set<string>()
    for (const target of noteTargets) {
      if (done.has(target.commit) || !(await commitResolves(directory, target.commit))) continue
      done.add(target.commit)
      if (await writeChangeNote(directory, target.commit, target)) report.notesWritten++
    }
  }

  report.resolved = resolved.size
  report.unresolved = [...unresolved].sort()
  return report
}
