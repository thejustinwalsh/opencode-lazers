import { existsSync } from "node:fs"
import { z } from "zod"
import { fingerprint } from "../identity.ts"
import { taskStateView, taskExplanation } from "../tasks/task-state.ts"
import { taskReasonView, taskTitle } from "../tasks/presentation.ts"
import { gitAsync } from "./artifacts.ts"
import { holdFamily, holdActions, unblockingActions } from "./hold-actions.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { planCommandProblem } from "./plan-commands.ts"
import { messageID } from "./runtime-helpers.ts"
import type { AttemptRow, NodeRow, OutboxRow, PlanRow, RunnerStore } from "./store.ts"

/**
 * Recovery bundle: everything stale that waits for an Architect decision, delivered as one notice.
 *
 * A failed task or a held plan waits for its Architect to choose an unblocking action. When
 * Architect contact was paused, or the notice went unanswered, that work sat for days. The
 * scheduler therefore collects every item that still needs a decision, once it is stale and
 * nothing live is working on it, and hands the Architect ONE bundle through the outbox.
 *
 * No state is added here. An item is a reading of existing plan, node and attempt states; the
 * bundle is an outbox row (`status: "recovery-bundle"`) plus a `RECOVERY_BUNDLE_RAISED`
 * transition; the Architect resolves items with the commands that already exist.
 */

/** A plan or task is stale when nothing meaningful happened to it for this long. */
export const RECOVERY_STALE_MS = 2 * 3_600_000
/** A delivered bundle that stays unanswered is raised again, replacing itself, after this long. */
export const RECOVERY_REPRAISE_MS = 6 * 3_600_000
/** A bundle that could not reach an Architect is tried again no sooner than this. */
export const RECOVERY_RETRY_MS = 5 * 60_000
/** Items beyond this are counted in the notice text but not listed. The payload keeps all. */
export const RECOVERY_TEXT_ITEMS = 60

export const RECOVERY_BUNDLE_STATUS = "recovery-bundle"
export const RECOVERY_BUNDLE_EVENT = "RECOVERY_BUNDLE_RAISED"

/**
 * Events that record what the runtime observed or delivered, not what happened to the work. They
 * never make an item look fresh: otherwise a hold that is re-observed every tick never goes stale.
 */
const NOISE_EVENT_PREFIXES = [
  "OUTCOME_",
  "ARCHITECT_",
  "CLEANUP_",
  "CANCELLATION_CLEANUP",
  "EFFECT_",
  "SOURCE_",
  "PLAN_STEP_",
  "PLAN_DELIVERY",
  "OWNER_",
  "WORKER_",
  "WORKTREES_",
  "CANCELLED_WORKTREES_",
  "QUEUE_REVIEW_",
  "RECOVERY_BUNDLE_",
]

export const RecoveryKind = z.enum([
  "held-plan",
  "failed-task",
  "accepted-unintegrated",
  "cleanup-blocked",
  "stuck-cancelling",
])
export type RecoveryKind = z.infer<typeof RecoveryKind>

const RecoveryReuse = z.strictObject({
  /** The attempt (or plan) artifact commit available to reuse. */
  artifact: z.string().nullable(),
  /** Whether the artifact is already an ancestor of the landing branch; null when unknown. */
  artifactInLanding: z.boolean().nullable(),
  /** Every recorded verification of the artifact passed; null when none was recorded. */
  checksPassed: z.boolean().nullable(),
  /** The owned worktree of the latest attempt, when one still exists. */
  worktree: z
    .strictObject({
      path: z.string(),
      unmergedCommits: z.number().int().nonnegative(),
      uncommitted: z.boolean(),
    })
    .nullable(),
  /** The latest attempt's worker session: gone, or still there but not working. */
  worker: z.enum(["none", "missing", "present"]),
})
export type RecoveryReuse = z.infer<typeof RecoveryReuse>

const RecoveryRecommendation = z.strictObject({
  /** A `lz-plan-command` action, or null when only a review can decide. */
  action: z.string().nullable(),
  because: z.string(),
})

export const RecoveryItem = z.strictObject({
  /** Stable while the condition is unchanged; a changed state or reason is a new item. */
  key: z.string(),
  kind: RecoveryKind,
  planID: z.string(),
  taskID: z.string().nullable(),
  /** The human reference of the task, `LZ-n`. */
  reference: z.string().nullable(),
  title: z.string(),
  state: z.string(),
  /** The one word the panels use for this state. */
  stateLabel: z.string(),
  /** The same user sentence the panels show for the reason. */
  explanation: z.string().nullable(),
  /** The recorded runtime reason. */
  reason: z.string().nullable(),
  holdFamily: z.string().nullable(),
  ageMs: z.number().int().nonnegative(),
  /** Unblocking actions the plan's current state accepts for this item. */
  actions: z.array(z.string()),
  reuse: RecoveryReuse,
  recommendation: RecoveryRecommendation,
})
export type RecoveryItem = z.infer<typeof RecoveryItem>

export const RecoveryBundle = z.strictObject({
  status: z.literal(RECOVERY_BUNDLE_STATUS),
  /** The anchor plan: the plan the outbox row hangs on. */
  planID: z.string(),
  version: z.number().int().nonnegative(),
  raisedAt: z.number(),
  /** One more than the bundles raised before it in this project. */
  generation: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  planIDs: z.array(z.string()),
  staleAfterMs: z.number(),
  /** The outbox row this bundle replaces, when an earlier one was still open. */
  replaces: z.string().nullable(),
  items: z.array(RecoveryItem),
})
export type RecoveryBundle = z.infer<typeof RecoveryBundle>

/** What the panels may read: that a bundle exists and how many items it carries. */
export type RecoveryBundleStatus = {
  items: number
  open: { outboxID: string; state: string; raisedAt: number; count: number } | null
}

export type RecoveryFacts = {
  kind: RecoveryKind
  family: string | undefined
  hasTask: boolean
  reuse: RecoveryReuse
  actions: readonly string[]
}

/**
 * The advice for one item, computed from facts only. The Architect decides.
 * Rules run in order; a recommendation the item cannot take falls back to its first action.
 */
export function recommend(facts: RecoveryFacts): z.infer<typeof RecoveryRecommendation> {
  const { reuse, kind, family } = facts
  const pick = (action: string, because: string) =>
    facts.actions.includes(action)
      ? { action, because }
      : {
          action: facts.actions[0] ?? null,
          because: `${because} (${action} is not available in this state)`,
        }
  const short = reuse.artifact?.slice(0, 8)
  if (reuse.artifactInLanding === true) {
    if (kind === "accepted-unintegrated" || kind === "cleanup-blocked")
      return pick(
        "integrated",
        `Artifact ${short} is already in the landing branch; record the integration`,
      )
    if (facts.hasTask)
      return pick(
        "cancel",
        `Artifact ${short} is already in the landing branch; the work is done, cancel and dispose the task`,
      )
  }
  if (kind === "stuck-cancelling")
    return pick("reconcile", "Cancellation is not progressing; reconcile re-observes it")
  if (kind === "accepted-unintegrated")
    return {
      action: null,
      because: `Artifact ${short} passed review but is not in the landing branch; merge it, then record integrated, or send it back with retained-repair`,
    }
  if (kind === "cleanup-blocked") {
    if (reuse.worktree?.uncommitted || reuse.worktree?.unmergedCommits)
      return pick(
        "reconcile",
        "The preserved worktree holds uncommitted or unmerged work; commit or merge it, then reconcile",
      )
    return pick("reconcile", "Cleanup retries when facts change; reconcile re-observes it now")
  }
  if (family === "scope-divergence")
    return pick(
      "amend-scope",
      "The change diverged from the task's scope and checks passed; the worker's reason is in the hold reason. Accept it with amend-scope and a reason, send it back with retained-repair, or cancel",
    )
  if (family === "scope-violation")
    return pick("amend-scope", "The change reached outside the write scope; decide the scope")
  if (family === "uncertain-effect")
    return pick("reconcile", "An effect result is uncertain; reconcile re-observes it")
  const tree = reuse.worktree
  if (tree && !tree.uncommitted && tree.unmergedCommits > 0 && reuse.checksPassed === true)
    return pick(
      "verify-retained",
      `The worktree holds ${tree.unmergedCommits} unmerged commit(s) and recorded checks passed; verify that commit`,
    )
  if (tree && (tree.uncommitted || tree.unmergedCommits > 0))
    return pick(
      "retained-repair",
      "The worktree holds unfinished work; continue it with retained-repair instead of starting over",
    )
  if (reuse.artifact && reuse.checksPassed === true)
    return pick("verify-retained", `Artifact ${short} has passing checks; verify it and accept`)
  if (reuse.artifact)
    return pick(
      "retained-repair",
      `Artifact ${short} exists but its checks did not pass; repair it`,
    )
  if (reuse.worker === "present")
    return pick("resume", "No artifact yet and the worker session is still there; resume it")
  if (facts.hasTask || family === "dispatch-failed")
    return pick("retry", "No artifact and no live worker; start a fresh attempt")
  return pick("reconcile", "Re-observe the plan and continue")
}

/** The rendering the panels already use: state word and user sentence for one recorded state. */
function presentation(input: {
  taskID: string
  title: string
  state: string
  reason: string | null
  reference?: string
}) {
  const failed = input.state === "failed" || input.state === "exhausted"
  const view = taskStateView({
    taskID: input.taskID,
    title: input.title,
    status: input.state,
    reason: input.reason,
    waiting: !failed && Boolean(input.reason),
    holdReason: failed ? null : input.reason,
    ordinal: 0,
    contextOnly: false,
    prerequisites: [],
    successors: [],
    ...(input.reference ? { reference: input.reference } : {}),
  })
  return {
    label: view.label,
    explanation:
      taskExplanation(view, {
        hold: input.reason ? [input.reason] : [],
        failure: input.reason,
      }) ?? null,
  }
}

const PLAN_STATE_WORD: Readonly<Record<string, string>> = {
  blocked: "Held",
  failed: "Failed",
  accepted: "Accepted, not integrated",
  "cleanup-blocked": "Cleanup blocked",
  cancelling: "Cancelling",
}

/** Plan states whose tasks can still be recovered. Cancelled and integrated work is excluded. */
const OPEN_PLAN_STATES = new Set([
  "draft",
  "running",
  "blocked",
  "accepted",
  "cleanup-blocked",
  "failed",
])

export type RecoveryDeps = {
  store: RunnerStore
  host: Pick<RunnerHost, "session">
  directory: string
  projectID: string
  owner: string
  now: () => number
  validArchitect: (session: HostSession | null | undefined) => session is HostSession
  ensureArchitectOwner: (
    plan: PlanRow,
    previous: HostSession | null | undefined,
    adopt?: boolean,
  ) => Promise<HostSession>
  git?: (directory: string, args: string[]) => Promise<string>
  exists?: (path: string) => boolean
}

export class RecoveryBundles {
  private readonly git: NonNullable<RecoveryDeps["git"]>
  private readonly exists: NonNullable<RecoveryDeps["exists"]>
  constructor(private readonly deps: RecoveryDeps) {
    this.git = deps.git ?? ((directory, args) => gitAsync(directory, args))
    this.exists = deps.exists ?? existsSync
  }

  /** Milliseconds since the plan last changed for a reason that is not an observation. */
  private idleSince(planID: string): number {
    const clauses = NOISE_EVENT_PREFIXES.map(() => "event NOT LIKE ?").join(" AND ")
    const last = this.deps.store.read(
      (db) =>
        db
          .query<{ at: number | null }, string[]>(
            `SELECT max(created_at) AS at FROM runner_transitions WHERE plan_id=? AND ${clauses}`,
          )
          .get(planID, ...NOISE_EVENT_PREFIXES.map((prefix) => `${prefix}%`))?.at ?? null,
    )
    return last === null ? Number.POSITIVE_INFINITY : this.deps.now() - last
  }

  private async live(attempts: AttemptRow[]): Promise<boolean> {
    for (const attempt of attempts) {
      if (!["preparing", "running", "verifying"].includes(attempt.state)) continue
      const session = await this.deps.host.session(attempt.session_id)
      if (
        session &&
        (session.busy ||
          session.pendingInput ||
          (session.pendingPermissions ?? 0) > 0 ||
          (session.pendingForms ?? 0) > 0)
      )
        return true
    }
    return false
  }

  private async inLanding(
    artifact: string,
    landing: () => Promise<string | null>,
  ): Promise<boolean | null> {
    const head = await landing()
    if (!head) return null
    const { directory } = this.deps
    try {
      await this.git(directory, ["merge-base", "--is-ancestor", artifact, head])
      return true
    } catch {
      try {
        await this.git(directory, ["cat-file", "-e", `${artifact}^{commit}`])
        return false
      } catch {
        return null
      }
    }
  }

  private checksPassed(planID: string, taskID: string, artifact: string): boolean | null {
    const rows = this.deps.store.read((db) =>
      db
        .query<{ body: string }, [string, string]>(
          "SELECT body FROM runner_evidence WHERE plan_id=? AND task_id=? AND kind='verification'",
        )
        .all(planID, taskID),
    )
    const results = rows.flatMap((row) => {
      try {
        const body = JSON.parse(row.body) as {
          artifact?: unknown
          exitCode?: unknown
          timedOut?: unknown
        }
        return body.artifact === artifact ? [body.exitCode === 0 && body.timedOut !== true] : []
      } catch {
        return []
      }
    })
    return results.length ? results.every(Boolean) : null
  }

  private async worktree(attempt: AttemptRow | undefined, landing: () => Promise<string | null>) {
    if (!attempt) return null
    const path = attempt.workspace
    if (!path || path === this.deps.directory || !this.exists(path)) return null
    const head = await landing()
    if (!head) return null
    try {
      const [unmerged, status] = await Promise.all([
        this.git(path, ["rev-list", "--count", "HEAD", `^${head}`]),
        this.git(path, ["status", "--porcelain"]),
      ])
      return {
        path,
        unmergedCommits: Number.parseInt(unmerged, 10) || 0,
        uncommitted: status.trim().length > 0,
      }
    } catch {
      return null
    }
  }

  private async reuse(
    plan: PlanRow,
    node: NodeRow | undefined,
    attempt: AttemptRow | undefined,
    head: () => Promise<string | null>,
  ): Promise<RecoveryReuse> {
    const artifact = (node ? (attempt?.artifact ?? node.artifact) : plan.artifact) ?? null
    const session = attempt ? await this.deps.host.session(attempt.session_id) : undefined
    return {
      artifact,
      artifactInLanding: artifact ? await this.inLanding(artifact, head) : null,
      checksPassed: artifact && node ? this.checksPassed(plan.id, node.task_id, artifact) : null,
      worktree: node ? await this.worktree(attempt, head) : null,
      worker: !attempt ? "none" : session ? "present" : "missing",
    }
  }

  private legalActions(
    plan: PlanRow,
    taskID: string | null,
    reason: string | null,
    extra: readonly string[],
  ) {
    const base = reason ? holdActions(reason) : ["reconcile", "cancel"]
    const wanted = [...new Set([...unblockingActions(base), ...extra])]
    return wanted.filter(
      (action) =>
        !planCommandProblem(plan.state, { action, ...(taskID ? { taskID } : {}) } as never),
    )
  }

  /** Every item that needs an Architect decision now. Read-only. */
  async collect(): Promise<RecoveryItem[]> {
    const { store, directory } = this.deps
    // Git is only asked when a stale item needs it; an idle project runs no git at all.
    let landing: Promise<string | null> | undefined
    const head = () => (landing ??= this.git(directory, ["rev-parse", "HEAD"]).catch(() => null))
    const items: RecoveryItem[] = []
    for (const plan of store.plans()) {
      const stuck = ["blocked", "failed", "accepted", "cleanup-blocked", "cancelling"].includes(
        plan.state,
      )
      if (!stuck && !OPEN_PLAN_STATES.has(plan.state)) continue
      const idle = this.idleSince(plan.id)
      if (idle < RECOVERY_STALE_MS) continue
      const nodes = store.nodes(plan.id)
      const attempts = store.attempts(plan.id)
      const latest = (taskID: string) => attempts.filter((a) => a.task_id === taskID).at(-1)
      const planLive = await this.live(attempts)
      const ageMs = Math.min(idle, Number.MAX_SAFE_INTEGER)

      const planKinds: Record<string, RecoveryKind> = {
        blocked: "held-plan",
        failed: "held-plan",
        accepted: "accepted-unintegrated",
        "cleanup-blocked": "cleanup-blocked",
        cancelling: "stuck-cancelling",
      }
      const planKind = planKinds[plan.state]
      const taskItems: RecoveryItem[] = []

      if (OPEN_PLAN_STATES.has(plan.state)) {
        for (const node of nodes) {
          const attempt = latest(node.task_id)
          const failed =
            node.state === "failed" ||
            node.state === "exhausted" ||
            (node.state === "blocked" && attempt?.state === "failed")
          if (!failed) continue
          const task = store.repository.get(node.task_id)
          if (!task || store.repository.taskDisposition(node.task_id)) continue
          if (await this.live(attempt ? [attempt] : [])) continue
          const reason = node.reason ?? null
          const family = reason ? holdFamily(reason)?.name : undefined
          if (family === "native-input") continue
          const reuse = await this.reuse(plan, node, attempt, head)
          const actions = this.legalActions(plan, node.task_id, reason, [
            "retry",
            "resume",
            "cancel",
            ...(reuse.artifact ? ["verify-retained", "retained-repair"] : []),
            ...(reuse.artifactInLanding ? ["integrated"] : []),
          ])
          const title = taskTitle(task.proposal.objective)
          const reference = store.repository.referenceFor(node.task_id) ?? null
          const shown = presentation({
            taskID: node.task_id,
            title,
            state: node.state,
            reason,
            ...(reference ? { reference } : {}),
          })
          taskItems.push({
            key: fingerprint({ planID: plan.id, taskID: node.task_id, state: node.state, reason }),
            kind: "failed-task",
            planID: plan.id,
            taskID: node.task_id,
            reference,
            title,
            state: node.state,
            stateLabel: shown.label,
            explanation: shown.explanation,
            reason,
            holdFamily: family ?? null,
            ageMs,
            actions,
            reuse,
            recommendation: recommend({
              kind: "failed-task",
              family,
              hasTask: true,
              reuse,
              actions,
            }),
          })
        }
      }

      let planItem: RecoveryItem | undefined
      const reason = plan.reason ?? null
      const family = reason ? holdFamily(reason)?.name : undefined
      if (planKind && !planLive && family !== "native-input") {
        const reuse = await this.reuse(plan, undefined, undefined, head)
        const actions = this.legalActions(
          plan,
          null,
          reason,
          plan.state === "accepted" || plan.state === "cleanup-blocked"
            ? ["integrated", "reconcile", "cancel", "verify-retained"]
            : plan.state === "cancelling"
              ? ["reconcile"]
              : [],
        )
        const objective = (() => {
          try {
            return (JSON.parse(plan.body) as { objective?: string }).objective ?? plan.id
          } catch {
            return plan.id
          }
        })()
        planItem = {
          key: fingerprint({ planID: plan.id, taskID: null, state: plan.state, reason }),
          kind: planKind,
          planID: plan.id,
          taskID: null,
          reference: null,
          title: taskTitle(objective),
          state: plan.state,
          stateLabel: PLAN_STATE_WORD[plan.state] ?? plan.state,
          explanation: reason ? taskReasonView(reason, "waiting").text : null,
          reason,
          holdFamily: family ?? null,
          ageMs,
          actions,
          reuse,
          recommendation: recommend({ kind: planKind, family, hasTask: false, reuse, actions }),
        }
      }
      // A held plan whose failed tasks already name the decision lists the tasks; the plan item
      // stays so its own actions (run, cancel, schedule) are offered once.
      if (planItem) items.push(planItem)
      items.push(...taskItems)
    }
    return items
  }

  /** The open bundle for this project: the newest raised one, with its outbox state. */
  private latestBundle(): {
    outboxID: string
    raisedAt: number
    keys: string[]
    generation: number
  } | null {
    const row = this.deps.store.read((db) =>
      db
        .query<{ payload: string }, [string, string]>(
          `SELECT t.payload FROM runner_transitions t JOIN runner_plans p ON p.id=t.plan_id
           WHERE p.project_directory=? AND t.event=? ORDER BY t.id DESC LIMIT 1`,
        )
        .get(this.deps.directory, RECOVERY_BUNDLE_EVENT),
    )
    if (!row) return null
    const body = JSON.parse(row.payload) as {
      outboxID: string
      raisedAt: number
      keys: string[]
      generation: number
    }
    return body
  }

  /** Observable by the panels later: how many items wait and which bundle covers them. */
  async status(): Promise<RecoveryBundleStatus> {
    const items = await this.collect()
    const latest = this.latestBundle()
    const row = latest ? this.deps.store.outboxRowByID(latest.outboxID) : undefined
    return {
      items: items.length,
      open:
        latest && row
          ? {
              outboxID: row.id,
              state: row.state,
              raisedAt: latest.raisedAt,
              count: latest.keys.length,
            }
          : null,
    }
  }

  /**
   * Sessions that may be this project's Architect, most likely first: owners of plans by recent
   * activity, sessions that received notices, plan continuations, then the sessions that
   * submitted tasks. The first one the host reports as a live Architect receives the bundle.
   */
  private candidateSessions(items: RecoveryItem[]): string[] {
    const { store, directory } = this.deps
    const column = (sql: string, ...args: string[]) =>
      store.read((db) =>
        db
          .query<{ id: string | null }, string[]>(sql)
          .all(...args)
          .flatMap((row) => row.id ?? []),
      )
    const itemOwners = items.flatMap((item) => store.plan(item.planID)?.owner ?? [])
    return [
      ...new Set([
        ...itemOwners,
        ...column(
          `SELECT p.owner AS id FROM runner_plans p
           LEFT JOIN runner_transitions t ON t.plan_id=p.id
           WHERE p.project_directory=? GROUP BY p.owner ORDER BY max(t.id) DESC LIMIT 10`,
          directory,
        ),
        ...column(
          `SELECT o.session_id AS id FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
           WHERE p.project_directory=? GROUP BY o.session_id ORDER BY max(o.rowid) DESC LIMIT 10`,
          directory,
        ),
        ...column(
          `SELECT c.session_id AS id FROM runner_continuations c JOIN runner_plans p ON p.id=c.plan_id
           WHERE p.project_directory=? ORDER BY c.rowid DESC LIMIT 10`,
          directory,
        ),
        ...column(
          `SELECT json_extract(body,'$.provenance.sessionID') AS id FROM tasks
           WHERE project_directory=? ORDER BY rowid DESC LIMIT 20`,
          directory,
        ),
      ]),
    ]
  }

  /** The Architect that receives the bundle: the project's most recently active live one. */
  private async receiver(items: RecoveryItem[]): Promise<HostSession | undefined> {
    const { store, host, validArchitect } = this.deps
    for (const id of this.candidateSessions(items)) {
      const session = await host.session(id)
      if (validArchitect(session)) return session
    }
    // No live Architect is known: the existing continuation path creates one.
    const anchor = store.plan(items[0]!.planID)!
    try {
      return await this.deps.ensureArchitectOwner(anchor, null, false)
    } catch {
      return undefined
    }
  }

  /**
   * Hand the Architect one bundle when an item is not covered by the open one. Idempotent: the
   * outbox id is derived from the generation and content, so two reconcilers or a restart
   * insert the same row once.
   */
  async reconcile(fence: number): Promise<RecoveryBundle | undefined> {
    const { store, now, owner } = this.deps
    if (store.architectContactPaused()) return undefined
    const items = await this.collect()
    if (!items.length) return undefined
    const latest = this.latestBundle()
    const row = latest ? store.outboxRowByID(latest.outboxID) : undefined
    const at = now()
    const covering =
      latest &&
      row &&
      (row.state === "pending" ||
        (row.state === "delivered" && at - latest.raisedAt < RECOVERY_REPRAISE_MS))
    const covered = new Set(covering ? latest.keys : [])
    if (items.every((item) => covered.has(item.key))) return undefined
    // A bundle that found no Architect is not retried every tick.
    if (latest && row?.state === "superseded" && at - latest.raisedAt < RECOVERY_RETRY_MS)
      return undefined

    const target = await this.receiver(items)
    if (!target) return undefined
    const anchor = store.plan(items[0]!.planID)!
    const generation = (latest?.generation ?? 0) + 1
    const replaces = covering && row ? row.id : null
    const bundle = RecoveryBundle.parse({
      status: RECOVERY_BUNDLE_STATUS,
      planID: anchor.id,
      version: anchor.version,
      raisedAt: at,
      generation,
      count: items.length,
      planIDs: [...new Set(items.map((item) => item.planID))],
      staleAfterMs: RECOVERY_STALE_MS,
      replaces,
      items,
    })
    const id = fingerprint({
      kind: RECOVERY_BUNDLE_STATUS,
      projectDirectory: this.deps.directory,
      generation,
      keys: items.map((item) => item.key),
    })
    const nativeMessageID = messageID()
    const metadata = {
      lazersKind: "runner-outcome",
      lazersProjectID: this.deps.projectID,
      lazersProjectDirectory: this.deps.directory,
      lazersPlanID: anchor.id,
      lazersOutboxID: id,
      lazersMessageID: nativeMessageID,
      lazersSessionID: target.id,
      lazersStatus: RECOVERY_BUNDLE_STATUS,
      lazersVersion: anchor.version,
    }
    return store.fenced(owner, fence, () =>
      store.atomic((db) => {
        // Re-read inside the write: a second reconciler may have raised this generation.
        const taken = this.latestBundle()
        if ((taken?.generation ?? 0) >= generation) return undefined
        if (replaces) {
          const current = store.outboxRowByID(replaces)
          if (current?.state === "pending")
            db.query(
              "UPDATE runner_outbox SET state=lz_runner_transition('outbox',state,'superseded'),receipt=? WHERE id=? AND state='pending'",
            ).run(
              JSON.stringify({
                history: [{ kind: "superseded-by-recovery-bundle", byOutboxID: id }],
              }),
              replaces,
            )
        }
        const inserted = db
          .query(
            "INSERT OR IGNORE INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',1,?,NULL)",
          )
          .run(
            id,
            anchor.id,
            target.id,
            nativeMessageID,
            JSON.stringify(bundle),
            JSON.stringify(metadata),
          ).changes
        if (!inserted) return undefined
        store.record(anchor.id, null, RECOVERY_BUNDLE_EVENT, {
          outboxID: id,
          generation,
          raisedAt: at,
          count: items.length,
          keys: items.map((item) => item.key),
          planIDs: bundle.planIDs,
          sessionID: target.id,
          replaces,
        })
        store.repository.changed()
        return bundle
      }),
    )
  }
}

export function isRecoveryBundleRow(row: Pick<OutboxRow, "payload">): boolean {
  try {
    return (JSON.parse(row.payload) as { status?: unknown }).status === RECOVERY_BUNDLE_STATUS
  } catch {
    return false
  }
}

function ago(ms: number) {
  const hours = ms / 3_600_000
  return hours < 48 ? `${Math.max(1, Math.round(hours))}h` : `${Math.round(hours / 24)}d`
}

/** The notice the Architect reads: the whole backlog, each item with its facts and advice. */
export function recoveryBundleText(serialized: string): string {
  const bundle = RecoveryBundle.parse(JSON.parse(serialized))
  const listed = bundle.items.slice(0, RECOVERY_TEXT_ITEMS)
  const lines = listed.flatMap((item, index) => {
    const ref = item.reference ?? `plan ${item.planID.slice(0, 8)}`
    const reuse = [
      item.reuse.artifact
        ? `artifact ${item.reuse.artifact.slice(0, 8)} ${
            item.reuse.artifactInLanding === true
              ? "(already in the landing branch)"
              : item.reuse.artifactInLanding === false
                ? "(not in the landing branch)"
                : "(landing unknown)"
          }${item.reuse.checksPassed === true ? ", checks passed" : item.reuse.checksPassed === false ? ", checks failed" : ""}`
        : "no artifact",
      item.reuse.worktree
        ? `worktree ${item.reuse.worktree.unmergedCommits} unmerged commit(s)${item.reuse.worktree.uncommitted ? ", uncommitted edits" : ""}`
        : "no worktree",
      `worker ${item.reuse.worker}`,
    ].join("; ")
    return [
      `${index + 1}. ${ref} ${JSON.stringify(item.title)} - ${item.stateLabel} (${item.kind}${item.holdFamily ? `, ${item.holdFamily}` : ""}), idle ${ago(item.ageMs)}; plan ${item.planID}${item.taskID ? ` task ${item.taskID}` : ""}`,
      ...(item.explanation ? [`   Why: ${item.explanation}`] : []),
      ...(item.reason ? [`   Recorded: ${item.reason}`] : []),
      `   Reuse: ${reuse}`,
      `   Actions: ${item.actions.join(", ") || "none"}. Recommended: ${item.recommendation.action ?? "review"} - ${item.recommendation.because}`,
    ]
  })
  return [
    `LAZERS recovery bundle: ${bundle.count} item(s) across ${bundle.planIDs.length} plan(s) have waited at least ${ago(bundle.staleAfterMs)} for a decision and nothing live is working on them.`,
    "Work through all of it in this one pass. Verify each with lz-inspect-plan, then resolve it with lz-plan-command or lz-dispose-task. Reuse what exists before starting fresh: resume a live worker, verify-retained a committed result whose checks passed, retained-repair unfinished work; submit a new task only when the old approach is wrong, and then cancel and dispose what it supersedes. The recommendation is advice from recorded facts; you decide. Resolved items leave the next bundle.",
    ...(bundle.replaces ? ["This bundle replaces the earlier one; ignore the earlier list."] : []),
    "",
    ...lines,
    ...(bundle.items.length > listed.length
      ? [
          `... and ${bundle.items.length - listed.length} more; list the plans with lz-inspect-plan.`,
        ]
      : []),
    `bundle ${bundle.generation} raised ${new Date(bundle.raisedAt).toISOString()}`,
  ].join("\n")
}
