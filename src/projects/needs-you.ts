import type { Database } from "bun:sqlite"
import { RECOVERY_BUNDLE_EVENT } from "../runner/recovery-bundle.ts"
import type { TaskRepository } from "../storage.ts"
import { scheduleReady } from "../tasks/schedule/stored.ts"
import { canonicalPath, pickUnit } from "./scope.ts"
import { projectSettingsIn } from "./settings.ts"
import type { ProjectRef, ProjectUnit } from "./scope.ts"

/** One thing that waits on the owner, without its project (the page names that). */
export type NeedsYouEntry = {
  kind: "owner-hold" | "recovery-bundle" | "architect-question" | "project-setup"
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
 * Owner holds of one checkout: the tasks in the stored Blocked bucket, the ones the Tasks panel's
 * Needs you filter lists, every one of them, newest first. Read from the stored list
 * (`task_schedule`, bucket index), so it works for a project that is not loaded as long as the
 * project is indexed; `undefined` says it is not, and no hold is listed for it.
 */
export function ownerHolds(db: Database, directory: string): NeedsYouEntry[] | undefined {
  if (!scheduleReady(db, directory)) return undefined
  return db
    .query<
      {
        task_id: string
        title: string
        reference: string
        reason: string | null
        created_at: string
      },
      [string]
    >(
      `SELECT task_id,title,reference,node_reason AS reason,created_at FROM task_schedule
        WHERE project_directory=? AND retired=0 AND bucket='blocked' ORDER BY seq DESC`,
    )
    .all(directory)
    .map((row) => {
      const since = Date.parse(row.created_at)
      return {
        kind: "owner-hold" as const,
        id: row.task_id,
        title: row.title,
        reference: row.reference,
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

/**
 * What the project's profile asks of the owner: set one up, while none is active and the notice
 * is not dismissed. Read from recorded rows only.
 */
export function profileEntries(db: Database, projectKey: string): NeedsYouEntry[] {
  const active = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM lazers_profile_revisions WHERE project_key=? AND state='active'",
    )
    .get(projectKey)
  if ((active?.n ?? 0) > 0) return []
  if (projectSettingsIn(db, projectKey).setupDismissedAt !== null) return []
  return [{ kind: "project-setup", id: projectKey, title: "Set up LAZERS" }]
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
  cursor?: string
  ownDirectory: string
  sessionOf?: (sessionID: string) => Promise<NeedsYouSession | null>
}): Promise<
  | {
      project: ProjectRef
      items: NeedsYouItem[]
      /** False when this checkout's native questions could not be read, so none are listed. */
      questionsRead: boolean
      /** False when this checkout's task list is not indexed yet, so no hold is listed. */
      holdsRead: boolean
      nextCursor: string | null
    }
  | undefined
> {
  const picked = pickUnit(input.units, input.cursor)
  if (!picked) return undefined
  const { unit } = picked
  const questionsRead =
    input.sessionOf !== undefined &&
    canonicalPath(unit.directory) === canonicalPath(input.ownDirectory)
  const { entries, owners, holds } = input.repository.read((db) => {
    const bundle = openRecoveryBundle(db, unit.directory)
    const holds = ownerHolds(db, unit.directory)
    return {
      holds: holds !== undefined,
      entries: [
        ...(holds ?? []),
        ...(bundle ? [bundle] : []),
        // The profile is the project's, so only its first checkout lists it.
        ...(input.units.find((candidate) => candidate.project.key === unit.project.key) === unit
          ? profileEntries(db, unit.project.key)
          : []),
      ],
      owners: questionsRead ? planOwners(db, unit.directory) : [],
    }
  })
  const sessions = (
    await Promise.all(owners.map((owner) => input.sessionOf!(owner).catch(() => null)))
  ).flatMap((session) => session ?? [])
  return {
    project: unit.project,
    questionsRead,
    holdsRead: holds,
    items: [...entries, ...architectQuestions(sessions)]
      .toSorted((a, b) => (a.since ?? 0) - (b.since ?? 0))
      .map((entry) => ({ ...entry, project: unit.project })),
    nextCursor: picked.nextCursor,
  }
}
