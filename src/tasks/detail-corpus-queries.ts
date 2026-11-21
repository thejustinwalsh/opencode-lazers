import type { Database } from "bun:sqlite"
import type { detailCorpus } from "./detail.fixture.ts"

type Corpus = Awaited<ReturnType<typeof detailCorpus>>

/**
 * The reads the detail recording covers. `linked` reads through the session's links (creator,
 * plan owner, attempt session: the panel's session view); otherwise `sessionID` names the
 * creating session (the agent tool).
 */
export function detailQueries({ tasks, workerSession }: Corpus) {
  const each = Object.fromEntries(
    Object.entries(tasks).map(([name, taskID]) => [name, { input: { taskID } }]),
  ) as Record<string, { input: Record<string, unknown>; linked?: true }>
  return {
    ...each,
    byReference: { input: { taskID: "LZ-8" } },
    unknown: { input: { taskID: crypto.randomUUID() } },
    revisionUnavailable: { input: { taskID: tasks.grind, revision: 2 } },
    classificationAt1: { input: { taskID: tasks.advised, classificationRevision: 1 } },
    classificationAt9: { input: { taskID: tasks.advised, classificationRevision: 9 } },
    creatorMatches: { input: { taskID: tasks.other, sessionID: "ses_b" } },
    creatorDiffers: { input: { taskID: tasks.other, sessionID: "ses_a" } },
    linkedAttempt: {
      input: { taskID: tasks.grind, sessionID: workerSession(tasks.grind, 2) },
      linked: true,
    },
    linkedOwner: { input: { taskID: tasks.grind, sessionID: "architect" }, linked: true },
    linkedNot: { input: { taskID: tasks.grind, sessionID: "ses_b" }, linked: true },
    linkedReference: { input: { taskID: "LZ-8", sessionID: "ses_a" }, linked: true },
  } satisfies Record<string, { input: Record<string, unknown>; linked?: true }>
}

export const searchQueries = {
  objective: { search: "grind" },
  scope: { search: "src/held" },
  acceptance: { search: "reopening the database" },
  context: { search: "readme.md" },
  reference: { search: "lz-3" },
  none: { search: "zz-no-such-text" },
  scopePath: { scopePath: "src/first" },
  both: { search: "first", scopePath: "src/first" },
} as const

/** Host sessions as the old read saw them, and as `host_session_state` stores them. */
function hostRecords({ tasks, f, workerSession }: Corpus) {
  const attempt = (taskID: string, number: number) =>
    f.repository.read(
      (db) =>
        db
          .query<{ id: string }, [string, number]>(
            "SELECT id FROM runner_attempts WHERE task_id=? AND number=?",
          )
          .get(taskID, number)!.id,
    )
  const worker = (id: string, attemptID: string, extra: Record<string, unknown> = {}) => ({
    id,
    projectID: "global",
    directory: "/worktree",
    agent: "lazers-implementor",
    metadata: { lazersAttemptID: attemptID },
    archived: false,
    busy: false,
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    outcome: null as string | null,
    ...extra,
  })
  return new Map<string, ReturnType<typeof worker>>([
    [
      workerSession(tasks.grind, 2),
      worker(workerSession(tasks.grind, 2), attempt(tasks.grind, 2), {
        busy: true,
        pendingPermissions: 1,
        pendingInput: true,
      }),
    ],
    // The takeover attempt runs as the Architect: not a worker session.
    [
      workerSession(tasks.calm, 1),
      worker(workerSession(tasks.calm, 1), attempt(tasks.calm, 1), { agent: "architect" }),
    ],
    [
      "ses_stuck_worker",
      worker("ses_stuck_worker", attempt(tasks.stuck, 1), {
        archived: true,
        outcome: "succeeded",
      }),
    ],
  ])
}

/** The stored rows the host fold writes for `hostRecords`. */
export function seedHostSessions(db: Database, corpus: Corpus) {
  for (const record of hostRecords(corpus).values())
    db.query(
      `INSERT INTO host_session_state(project_directory,session_id,role,agent,title,attempt_id,task_id,
        parent_session_id,directory,busy,pending_input,pending_permissions,pending_forms,outcome,archived,
        route_provider,route_model,route_variant,tokens_in,tokens_out,created_at,updated_at,host_updated_at)
       VALUES(?,?,?,?,NULL,?,NULL,NULL,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,1,1,1)`,
    ).run(
      corpus.f.repository.projectDirectory,
      record.id,
      record.agent === "architect" ? "architect" : "worker",
      record.agent,
      String(record.metadata.lazersAttemptID),
      record.directory,
      record.busy ? 1 : 0,
      record.pendingInput ? 1 : 0,
      record.pendingPermissions,
      record.pendingForms,
      record.outcome,
      record.archived ? 1 : 0,
    )
}

export function activityQueries({ tasks, workerSession }: Corpus) {
  const all = Object.values(tasks)
  return {
    project: { sessionID: "ses_a", scope: "project", taskIDs: all },
    session: { sessionID: "ses_a", scope: "session", taskIDs: all },
    worker: { sessionID: workerSession(tasks.grind, 2), scope: "session", taskIDs: all },
  }
}
