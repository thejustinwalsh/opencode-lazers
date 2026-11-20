import type { Database } from "bun:sqlite"
import { RECOVERY_BUNDLE_EVENT } from "../runner/recovery-bundle.ts"
import type { TaskRepository } from "../storage.ts"
import { taskStatePredicate } from "../tasks/state-filter.ts"
import { taskTitle } from "../tasks/presentation.ts"
import { allowAll, canonicalPath, pickUnit } from "./scope.ts"
import type { CanRead, ProjectRef, ProjectUnit } from "./scope.ts"

/** One thing that waits on the owner, without its project (the page names that). */
export type NeedsYouEntry = {
  kind: "owner-hold" | "recovery-bundle" | "architect-question"
  /** Task id, outbox id or session id. */
  id: string
  title: string
  /** `<CODE>-<n>` for a task. */
  reference?: string
  reason?: string
  /** Epoch ms; absent when the record does not carry one. */
  since?: number
  /** Items inside a bundle or questions inside a session. */
  count?: number
}
export type NeedsYouItem = NeedsYouEntry & { project: ProjectRef }

/**
 * Owner holds of one checkout: the tasks the Tasks panel's Needs you filter lists (`blocked`),
 * every one of them, newest first. Read from recorded rows only, so it works for a project that
 * is not loaded.
 */
export function ownerHolds(db: Database, directory: string): NeedsYouEntry[] {
  return db
    .query<
      {
        id: string
        title: string | null
        reference: string | null
        reason: string | null
        created: string | null
      },
      [string]
    >(
      `SELECT tasks.id AS id, substr(json_extract(tasks.body,'$.proposal.objective'),1,600) AS title,
              r.reference AS reference, json_extract(tasks.body,'$.createdAt') AS created,
              (SELECT n.reason FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
                WHERE n.task_id=tasks.id AND p.project_directory=tasks.project_directory
                ORDER BY p.rowid DESC LIMIT 1) AS reason
         FROM tasks
         LEFT JOIN task_references r ON r.project_directory=tasks.project_directory AND r.task_id=tasks.id
        WHERE tasks.project_directory=?
          AND NOT EXISTS (SELECT 1 FROM task_dispositions d WHERE d.project_directory=tasks.project_directory AND d.task_id=tasks.id)
          AND ${taskStatePredicate("blocked", "tasks")}
        ORDER BY tasks.rowid DESC`,
    )
    .all(directory)
    .map((row) => {
      const since = row.created ? Date.parse(row.created) : Number.NaN
      return {
        kind: "owner-hold" as const,
        id: row.id,
        title: taskTitle(row.title ?? ""),
        ...(row.reference ? { reference: row.reference } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
        ...(Number.isFinite(since) ? { since } : {}),
      }
    })
}

/**
 * The latest recovery bundle of one checkout while its notice is still undelivered: no live
 * Architect has taken it. Delivered bundles are the Architect's to act on, not the owner's.
 */
export function openRecoveryBundle(db: Database, directory: string): NeedsYouEntry | undefined {
  const raised = db
    .query<{ payload: string }, [string, string]>(
      `SELECT t.payload FROM runner_transitions t JOIN runner_plans p ON p.id=t.plan_id
        WHERE p.project_directory=? AND t.event=? ORDER BY t.id DESC LIMIT 1`,
    )
    .get(directory, RECOVERY_BUNDLE_EVENT)
  if (!raised) return undefined
  let body: { outboxID?: unknown; raisedAt?: unknown; keys?: unknown }
  try {
    body = JSON.parse(raised.payload)
  } catch {
    return undefined
  }
  if (typeof body.outboxID !== "string") return undefined
  const row = db
    .query<{ state: string }, [string]>("SELECT state FROM runner_outbox WHERE id=?")
    .get(body.outboxID)
  if (row?.state !== "pending") return undefined
  return {
    kind: "recovery-bundle",
    id: body.outboxID,
    title: "Recovery bundle",
    ...(typeof body.raisedAt === "number" ? { since: body.raisedAt } : {}),
    ...(Array.isArray(body.keys) ? { count: body.keys.length } : {}),
  }
}

/** Owners of the checkout's open plans: the sessions that may hold an Architect question. */
export function planOwners(db: Database, directory: string): string[] {
  return db
    .query<{ owner: string }, [string]>(
      `SELECT DISTINCT owner FROM runner_plans
        WHERE project_directory=? AND state NOT IN ('integrated','cancelled','cleaning','cleanup-blocked')`,
    )
    .all(directory)
    .map((row) => row.owner)
}

/** What a loaded location can say about a session: only its own OpenCode project's are readable. */
export type NeedsYouSession = {
  id: string
  agent?: string
  archived: boolean
  pendingForms?: number
}

/** Native questions waiting in sessions of the location that is asked; none for any other. */
export function architectQuestions(sessions: readonly NeedsYouSession[]): NeedsYouEntry[] {
  return sessions.flatMap((session) =>
    !session.archived && (session.pendingForms ?? 0) > 0
      ? [
          {
            kind: "architect-question" as const,
            id: session.id,
            title: "Question for you",
            count: session.pendingForms ?? 0,
          },
        ]
      : [],
  )
}

/**
 * One page of the Needs you list: one checkout of one readable project. Holds and bundles come
 * from the database for every checkout; native questions only for the caller's own checkout,
 * whose sessions `sessionOf` can read. Items are oldest first within the page.
 */
export async function needsYouPage(input: {
  repository: TaskRepository
  units: readonly ProjectUnit[]
  canRead?: CanRead
  cursor?: string
  ownDirectory: string
  sessionOf?: (sessionID: string) => Promise<NeedsYouSession | null>
}): Promise<{ project: ProjectRef; items: NeedsYouItem[]; nextCursor: string | null } | undefined> {
  const picked = await pickUnit(input.units, input.cursor, input.canRead ?? allowAll)
  if (!picked) return undefined
  const { unit } = picked
  const { entries, owners } = input.repository.read((db) => {
    const bundle = openRecoveryBundle(db, unit.directory)
    return {
      entries: [...ownerHolds(db, unit.directory), ...(bundle ? [bundle] : [])],
      owners:
        input.sessionOf && canonicalPath(unit.directory) === canonicalPath(input.ownDirectory)
          ? planOwners(db, unit.directory)
          : [],
    }
  })
  const sessions = (
    await Promise.all(owners.map((owner) => input.sessionOf!(owner).catch(() => null)))
  ).flatMap((session) => session ?? [])
  return {
    project: unit.project,
    items: [...entries, ...architectQuestions(sessions)]
      .toSorted((a, b) => (a.since ?? 0) - (b.since ?? 0))
      .map((entry) => ({ ...entry, project: unit.project })),
    nextCursor: picked.nextCursor,
  }
}
