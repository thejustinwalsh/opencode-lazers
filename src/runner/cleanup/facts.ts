import type { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { StampGate } from "../../core/stamp-gate.ts"
import { fingerprint } from "../../identity.ts"
import { cleanupRevisionStamp } from "../../observability/cleanup-revision.ts"
import { sameProject } from "../../project-key.ts"
import { TaskSpecSchema } from "../../task.ts"
import type { AttemptRow, EffectRow } from "../store.ts"
import { WORKTREE_CREATION_KINDS } from "./worktree-kinds.ts"

export { WORKTREE_CREATION_KINDS } from "./worktree-kinds.ts"

const creationKinds = new Set<string>(WORKTREE_CREATION_KINDS)

type CleanupPlanFacts = {
  id: string
  state: string
  revision: number
  owner: string
  artifact: string | null
}

type CleanupRetryFact = {
  sourceID: string
  workspace: string
  graphCheckActivityRefs: CleanupGraphCheckActivityRef[]
  workspaceExists: boolean
  retryFacts?: string
  removalFound: boolean
  removalState?: string
  previousFacts?: unknown
  previousCheckedAt?: unknown
  liveBlocker: boolean
}

export type CleanupGraphCheckActivityRef = {
  effectID: string
  identity: string
}

export type CleanupFacts = {
  plan: Pick<CleanupPlanFacts, "state"> | undefined
  pending: boolean
  retries: CleanupRetryFact[]
}

type ParsedCreation = { effect: EffectRow; workspace: string }

type AttemptOwner = {
  plan_id: string
  id: string
  task_id: string
  session_id: string
  state: string
}

type CleanupAttemptFact = Pick<
  AttemptRow,
  "id" | "plan_id" | "task_id" | "session_id" | "message_id" | "workspace" | "artifact" | "state"
>

type RetryPlan = Pick<CleanupPlanFacts, "id" | "revision" | "owner" | "artifact">
const READ_PAGE = 200

/**
 * Cleanup's row-derived facts are project-owned and stamped by SQLite observations. The cached
 * value contains only the compact cleanup decision and fingerprints, not a second copy of history.
 */
export class CleanupFactsCache {
  private readonly gate = new StampGate<CleanupFacts>({ maxBytes: 8_000_000 })

  constructor(
    private readonly directory: string,
    private readonly projectID: string,
  ) {}

  read(db: Database, planID: string): CleanupFacts {
    const stamp = cleanupRevisionStamp(db, this.directory, planID)
    return this.gate.runSync(planID, stamp, () =>
      readCleanupFacts(db, this.directory, this.projectID, planID),
    )
  }

  clear() {
    this.gate.clear()
  }
}

function readCleanupFacts(
  db: Database,
  directory: string,
  projectID: string,
  planID: string,
): CleanupFacts {
  const plan = db
    .query<CleanupPlanFacts, [string, string]>(
      "SELECT id,state,revision,owner,artifact FROM runner_plans WHERE id=? AND project_directory=?",
    )
    .get(planID, directory)
  if (!plan) return { plan: undefined, pending: false, retries: [] }

  const effects = readPlanEffects(db, planID)
  let attempts: CleanupAttemptFact[] = []
  let attemptsAvailable = true
  try {
    attempts = readPlanAttempts(db, planID)
  } catch {
    // A failed local signal read falls back to the recorded native retry interval.
    attemptsAvailable = false
  }
  const removalsByWorkspace = new Map<string, EffectRow[]>()
  for (const effect of effects) {
    if (effect.kind !== "worktree-remove") continue
    const workspace = jsonWorkspace(effect.payload)
    if (workspace === undefined) continue
    const entries = removalsByWorkspace.get(workspace) ?? []
    entries.push(effect)
    removalsByWorkspace.set(workspace, entries)
  }

  const creations: ParsedCreation[] = effects.flatMap((effect) => {
    if (!creationKinds.has(effect.kind) || effect.state !== "completed" || !effect.receipt)
      return []
    const workspace = jsonWorkspace(effect.receipt)
    return workspace === undefined ? [] : [{ effect, workspace }]
  })
  const pending = creations.some(
    ({ workspace }) =>
      !(removalsByWorkspace.get(workspace) ?? []).some((effect) => effect.state === "completed"),
  )
  const attemptsByWorkspace = new Map<string, CleanupAttemptFact[]>()
  for (const attempt of attempts) {
    const target = resolve(attempt.workspace)
    const entries = attemptsByWorkspace.get(target) ?? []
    entries.push(attempt)
    attemptsByWorkspace.set(target, entries)
  }
  const summarizedEffects = effectFacts(
    effects.filter((effect) => effect.kind !== "worktree-remove"),
  )
  const ownersByWorkspace = new Map<string, AttemptOwner[]>()
  const retries = creations.map(({ effect, workspace }) => {
    const removal = removalsByWorkspace.get(workspace)?.[0]
    const prior = removalReceipt(removal)
    let retryFacts: string | undefined
    try {
      if (!attemptsAvailable) throw new Error("Cleanup attempt facts are unavailable")
      let owners = ownersByWorkspace.get(workspace)
      if (!owners) {
        owners = readAttemptOwners(db, directory, workspace)
        ownersByWorkspace.set(workspace, owners)
      }
      retryFacts = retryFactsForRows(db, directory, projectID, plan, effect, workspace, {
        effects: summarizedEffects,
        attempts: attemptsByWorkspace.get(resolve(workspace)) ?? [],
        owners,
      })
    } catch {
      // A failed local signal read never authorizes cleanup; the bounded native fallback retries.
    }
    return {
      sourceID: effect.id,
      workspace,
      graphCheckActivityRefs: graphCheckActivityRefs(effects, workspace),
      workspaceExists: existsSync(workspace),
      retryFacts,
      removalFound: removal !== undefined,
      ...(removal ? { removalState: removal.state } : {}),
      ...(prior?.retryFacts !== undefined ? { previousFacts: prior.retryFacts } : {}),
      ...(prior?.retryCheckedAt !== undefined ? { previousCheckedAt: prior.retryCheckedAt } : {}),
      liveBlocker: prior?.liveBlocker === true,
    }
  })
  return { plan: { state: plan.state }, pending, retries }
}

function graphCheckActivityRefs(
  effects: EffectRow[],
  workspace: string,
): CleanupGraphCheckActivityRef[] {
  return effects.flatMap((effect) => {
    if (!effect.kind.startsWith("graph-verify:") || jsonWorkspace(effect.payload) !== workspace)
      return []
    return [
      {
        effectID: effect.id,
        identity: fingerprint({ effectID: effect.id, payload: effect.payload }),
      },
    ]
  })
}

/** Current facts for a source effect; used by active cleanup and retry receipts. */
export function currentWorktreeCleanupRetryFacts(
  db: Database,
  directory: string,
  projectID: string,
  planID: string,
  source: EffectRow,
  workspace: string,
): string {
  const plan = db
    .query<CleanupPlanFacts, [string, string]>(
      "SELECT id,state,revision,owner,artifact FROM runner_plans WHERE id=? AND project_directory=?",
    )
    .get(planID, directory)
  if (!plan) throw new Error("Cleanup plan no longer exists")
  const effects = effectFacts(
    readPlanEffects(db, planID).filter((effect) => effect.kind !== "worktree-remove"),
  )
  const attempts = readPlanAttempts(db, planID).filter(
    (attempt) => resolve(attempt.workspace) === resolve(workspace),
  )
  return retryFactsForRows(db, directory, projectID, plan, source, workspace, {
    effects,
    attempts,
  })
}

function retryFactsForRows(
  db: Database,
  directory: string,
  projectID: string,
  plan: RetryPlan,
  source: EffectRow,
  workspace: string,
  rows: {
    effects: ReturnType<typeof effectFacts>
    attempts: CleanupAttemptFact[]
    owners?: AttemptOwner[]
  },
): string {
  const target = resolve(workspace)
  const attempts = rows.attempts.filter((attempt) => resolve(attempt.workspace) === target)
  const sessions = attempts.map((attempt) => ({
    sessionID: attempt.session_id,
    assignment: assignmentForSession(db, directory, projectID, attempt),
  }))
  const owners = rows.owners ?? readAttemptOwners(db, directory, workspace)
  const adoptionFacts = readAdoptionFacts(db, source)
  return fingerprint({
    plan: { id: plan.id, revision: plan.revision, owner: plan.owner, artifact: plan.artifact },
    workspace: target,
    workspaceExists: existsSync(workspace),
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      taskID: attempt.task_id,
      state: attempt.state,
      messageID: attempt.message_id,
      sessionID: attempt.session_id,
      artifact: attempt.artifact,
    })),
    sessions,
    owners,
    adoptionFacts,
    source: {
      kind: source.kind,
      payload: fingerprint(source.payload),
      receipt: source.receipt ? fingerprint(source.receipt) : null,
    },
    effects: rows.effects,
  })
}

/** Mirrors ProgressRecorder.assignmentForSession without opening a nested store transaction. */
function assignmentForSession(
  db: Database,
  directory: string,
  projectID: string,
  attempt: CleanupAttemptFact,
) {
  const task = db
    .query<{ body: string }, [string, string, string]>(
      `SELECT t.body FROM runner_attempts a
       JOIN runner_plans p ON p.id=a.plan_id
       JOIN tasks t ON t.id=a.task_id AND t.project_directory=p.project_directory
       WHERE p.project_directory=? AND t.project_directory=? AND a.session_id=?`,
    )
    .get(directory, directory, attempt.session_id)
  if (!task) return null
  const parsed = TaskSpecSchema.parse(JSON.parse(task.body))
  if (
    parsed.id !== attempt.task_id ||
    !sameProject(parsed.provenance.projectID, projectID) ||
    parsed.provenance.projectDirectory !== directory
  )
    return null
  return {
    projectID: parsed.provenance.projectID,
    taskID: attempt.task_id,
    planID: attempt.plan_id,
    attemptID: attempt.id,
    attemptState: attempt.state,
    sessionID: attempt.session_id,
    assignedMessageID: attempt.message_id,
    workspace: attempt.workspace,
  }
}

function effectFacts(effects: EffectRow[]) {
  return effects.map((effect) => ({
    id: effect.id,
    kind: effect.kind,
    state: effect.state,
    payload: fingerprint(effect.payload),
    receipt: effect.receipt ? fingerprint(effect.receipt) : null,
  }))
}

function readPlanEffects(db: Database, planID: string): EffectRow[] {
  const effects: EffectRow[] = []
  let after = 0
  for (;;) {
    const page = db
      .query<EffectRow & { cursor: number }, [string, number, number]>(
        `SELECT rowid AS cursor,id,plan_id,task_id,attempt_id,kind,state,payload,receipt,fence
         FROM runner_effects WHERE plan_id=? AND rowid>? ORDER BY rowid LIMIT ?`,
      )
      .all(planID, after, READ_PAGE)
    effects.push(
      ...page.map(({ id, plan_id, task_id, attempt_id, kind, state, payload, receipt, fence }) => ({
        id,
        plan_id,
        task_id,
        attempt_id,
        kind,
        state,
        payload,
        receipt,
        fence,
      })),
    )
    if (page.length < READ_PAGE) return effects
    after = page.at(-1)!.cursor
  }
}

function readPlanAttempts(db: Database, planID: string): CleanupAttemptFact[] {
  const attempts: CleanupAttemptFact[] = []
  let after: { startedAt: number; number: number; rowid: number } | undefined
  for (;;) {
    const page = after
      ? db
          .query<
            CleanupAttemptFact & { cursor: number; started_at: number; number: number },
            [string, number, number, number, number, number, number, number]
          >(
            `SELECT rowid AS cursor,started_at,number,id,plan_id,task_id,session_id,message_id,workspace,artifact,state
             FROM runner_attempts WHERE plan_id=? AND (
               started_at>? OR (started_at=? AND number>?) OR
               (started_at=? AND number=? AND rowid>?))
             ORDER BY started_at,number,rowid LIMIT ?`,
          )
          .all(
            planID,
            after.startedAt,
            after.startedAt,
            after.number,
            after.startedAt,
            after.number,
            after.rowid,
            READ_PAGE,
          )
      : db
          .query<
            CleanupAttemptFact & { cursor: number; started_at: number; number: number },
            [string, number]
          >(
            `SELECT rowid AS cursor,started_at,number,id,plan_id,task_id,session_id,message_id,workspace,artifact,state
             FROM runner_attempts WHERE plan_id=? ORDER BY started_at,number,rowid LIMIT ?`,
          )
          .all(planID, READ_PAGE)
    attempts.push(
      ...page.map(
        ({ id, plan_id, task_id, session_id, message_id, workspace, artifact, state }) => ({
          id,
          plan_id,
          task_id,
          session_id,
          message_id,
          workspace,
          artifact,
          state,
        }),
      ),
    )
    if (page.length < READ_PAGE) return attempts
    const last = page.at(-1)!
    after = { startedAt: last.started_at, number: last.number, rowid: last.cursor }
  }
}

function readAttemptOwners(db: Database, directory: string, workspace: string): AttemptOwner[] {
  const owners: AttemptOwner[] = []
  let after: { planID: string; id: string } | undefined
  for (;;) {
    const page = after
      ? db
          .query<AttemptOwner, [string, string, string, string, string, number]>(
            `SELECT plan_id,id,task_id,session_id,state FROM runner_attempts
             WHERE project_directory=? AND workspace=?
             AND (plan_id>? OR (plan_id=? AND id>?)) ORDER BY plan_id,id LIMIT ?`,
          )
          .all(directory, workspace, after.planID, after.planID, after.id, READ_PAGE)
      : db
          .query<AttemptOwner, [string, string, number]>(
            `SELECT plan_id,id,task_id,session_id,state FROM runner_attempts
             WHERE project_directory=? AND workspace=? ORDER BY plan_id,id LIMIT ?`,
          )
          .all(directory, workspace, READ_PAGE)
    owners.push(...page)
    if (page.length < READ_PAGE) return owners
    const last = page.at(-1)!
    after = { planID: last.plan_id, id: last.id }
  }
}

type AdoptionCheckFact = {
  phase: string
  check_id: string
  state: string
  receipt: string | null
  created_at: number
}

function readAdoptionFacts(db: Database, source: EffectRow): unknown {
  try {
    const payload = JSON.parse(source.payload) as { adoptionID?: unknown }
    if (typeof payload.adoptionID !== "string") return null
    const adoption = db
      .query<
        {
          id: string
          state: string
          task_workspace: string | null
          combined_workspace: string | null
        },
        [string]
      >("SELECT id,state,task_workspace,combined_workspace FROM runner_adoptions WHERE id=?")
      .get(payload.adoptionID)
    const checks = readAdoptionChecks(db, payload.adoptionID)
    return {
      id: adoption?.id ?? null,
      state: adoption?.state ?? null,
      taskWorkspace: adoption?.task_workspace ?? null,
      combinedWorkspace: adoption?.combined_workspace ?? null,
      checks: (["task", "combined"] as const).flatMap((phase) =>
        checks
          .filter((check) => check.phase === phase)
          .map((check) => ({
            phase,
            checkID: check.check_id,
            state: check.state,
            receipt: check.receipt ? fingerprint(check.receipt) : null,
          })),
      ),
    }
  } catch {
    return { unavailable: true }
  }
}

function readAdoptionChecks(db: Database, adoptionID: string): AdoptionCheckFact[] {
  const checks: AdoptionCheckFact[] = []
  let after: { createdAt: number; phase: string; checkID: string } | undefined
  for (;;) {
    const page = after
      ? db
          .query<AdoptionCheckFact, [string, number, number, string, string, string, number]>(
            `SELECT phase,check_id,state,receipt,created_at FROM runner_adoption_checks
             WHERE adoption_id=? AND (created_at>? OR
               (created_at=? AND (phase>? OR (phase=? AND check_id>?))))
             ORDER BY created_at,phase,check_id LIMIT ?`,
          )
          .all(
            adoptionID,
            after.createdAt,
            after.createdAt,
            after.phase,
            after.phase,
            after.checkID,
            READ_PAGE,
          )
      : db
          .query<AdoptionCheckFact, [string, number]>(
            `SELECT phase,check_id,state,receipt,created_at FROM runner_adoption_checks
             WHERE adoption_id=? ORDER BY created_at,phase,check_id LIMIT ?`,
          )
          .all(adoptionID, READ_PAGE)
    checks.push(...page)
    if (page.length < READ_PAGE) return checks
    const last = page.at(-1)!
    after = { createdAt: last.created_at, phase: last.phase, checkID: last.check_id }
  }
}

function jsonWorkspace(value: string): string | undefined {
  try {
    const workspace = (JSON.parse(value) as { workspace?: unknown }).workspace
    return typeof workspace === "string" ? workspace : undefined
  } catch {
    return undefined
  }
}

function removalReceipt(effect: EffectRow | undefined) {
  if (!effect) return undefined
  try {
    return JSON.parse(effect.receipt ?? "{}") as {
      retryFacts?: unknown
      retryCheckedAt?: unknown
      liveBlocker?: unknown
    }
  } catch {
    return undefined
  }
}
