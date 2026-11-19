import { join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { z } from "zod"
import { openConcerns } from "../recovery/detector.ts"
import type { HandoffStore } from "../recovery/handoff/store.ts"
import { git } from "./artifacts.ts"
import { messageID } from "./runtime-helpers.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import type { AttemptRow, RunnerStore } from "./store.ts"

/**
 * An Architect takes a task over from its worker and finishes it itself in the same workspace.
 *
 * One blocking `lz-request-handoff` call runs the whole sequence; each step is a transition of
 * `lifecycleMachines.takeover`, so the scheduler finishes a call cut short by a reload and a
 * repeated call joins the open takeover instead of starting another:
 *
 *   notifying ──notice steered into the running worker──> awaiting-handoff
 *       │  (worker absent, archived or idle: nothing to tell)      │ draft saved, turn ended,
 *       v                                                         │ worker gone, window passed
 *   stopping <─────────────────────────────────────────────────────┘
 *       │ worker quiet (or stop window passed): WIP snapshot, worker attempt cancelled,
 *       v Architect attempt created in the same workspace
 *   taken-over
 *
 * The Architect then edits and commits in the workspace and submits with `lz-plan-command
 * takeover-submit`; the runtime verifies that attempt like any worker result (checks, Fallow
 * audit, scope) and accepts or fails it through the ordinary task and attempt machines.
 */

/** Attempts the Architect works itself have no native worker session; this marks their id. */
export const TAKEOVER_SESSION_PREFIX = "lazers-takeover:"
/**
 * How long the worker has to commit and write its handoff, from the request. A handoff is a
 * commit plus one tool call; a steered notice is read at the worker's next step boundary, and a
 * step can be a long command. Time, not turns: a worker mid-turn has no countable turns, and its
 * tool count does not bound wall time. Five minutes covers two ordinary steps and stays well
 * below the 15-minute check inactivity allowance the Architect would otherwise wait on.
 */
export const TAKEOVER_HANDOFF_WINDOW_MS = 5 * 60_000
/** After the window, a busy worker is interrupted and given this long to go quiet. */
export const TAKEOVER_STOP_WAIT_MS = 60_000

export type TakeoverState =
  "notifying" | "awaiting-handoff" | "stopping" | "taken-over" | "cancelled"
export const OPEN_TAKEOVER_STATES: readonly TakeoverState[] = [
  "notifying",
  "awaiting-handoff",
  "stopping",
]

export const TakeoverInput = z.strictObject({
  attemptID: z.uuid().describe("The worker attempt to take over (its latest attempt)."),
  reason: z.string().trim().min(1).max(2000).describe("Why the Architect takes the task over."),
  requestID: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Reuse after an interrupted call to get its outcome; nothing is sent twice."),
})
export type TakeoverInput = z.infer<typeof TakeoverInput>

type TakeoverRow = {
  id: string
  project_directory: string
  plan_id: string
  task_id: string
  attempt_id: string
  architect_session_id: string
  state: TakeoverState
  payload: string
  created_at: number
  updated_at: number
}

/** Recorded facts about the task; they accompany every handoff, the worker's included. */
export type TakeoverFacts = {
  failingChecks: { id: string; command: string; exitCode: number | null; output: string }[]
  concerns: string[]
  attempts: number
  /** Omitted when no attempt measured its tokens. */
  tokens?: number
}

/** The worker's own account, from `lz-takeover-handoff`. Every field is optional text. */
export type WorkerHandoff = {
  author: "worker"
  done?: string
  remaining?: string
  workspaceState?: string
  struggledWith?: string
  tried?: string
  notes?: string
  /** What the worker sent when it did not fit the fields; kept verbatim, never dropped. */
  raw?: string
}

export type TakeoverHandoff =
  | WorkerHandoff
  | { author: "worker"; draftVersion: number; draft: unknown }
  | { author: "runtime"; note: string }

const HANDOFF_FIELDS = [
  "done",
  "remaining",
  "workspaceState",
  "struggledWith",
  "tried",
  "notes",
] as const
const FIELD_LIMIT = 8_000

/** The slim worker handoff as advertised; `recordWorkerHandoff` accepts anything. */
export const WorkerHandoffInput = z.looseObject({
  done: z.string().optional().describe("What is done."),
  remaining: z.string().optional().describe("What is left."),
  workspaceState: z.string().optional().describe("Commits, uncommitted changes, anything odd."),
  struggledWith: z.string().optional().describe("What kept failing."),
  tried: z.string().optional().describe("What you tried and what happened."),
  notes: z.string().optional(),
})

/** Never rejects: known fields become text, anything else is kept verbatim as `raw`. */
export function normalizeWorkerHandoff(input: unknown): WorkerHandoff {
  const text = (value: unknown) =>
    (typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n")
        : JSON.stringify(value)
    ).slice(0, FIELD_LIMIT)
  const handoff: WorkerHandoff = { author: "worker" }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    if (input !== undefined) handoff.raw = text(input)
    return handoff
  }
  const record = input as Record<string, unknown>
  for (const field of HANDOFF_FIELDS)
    if (record[field] !== undefined && record[field] !== null && record[field] !== "")
      handoff[field] = text(record[field])
  const extra = Object.keys(record).filter(
    (key) => !(HANDOFF_FIELDS as readonly string[]).includes(key),
  )
  if (extra.length) handoff.raw = text(Object.fromEntries(extra.map((key) => [key, record[key]])))
  return handoff
}

type Payload = {
  requestID: string
  reason: string
  handoffRequestID: string
  noticeID: string
  deadline: number
  noticeSent?: boolean
  noticeError?: string
  stopDeadline?: number
  stopCause?: string
  workerQuiet?: boolean
  workspace?: string
  head?: string
  commits?: string[]
  uncommitted?: string[]
  wipTree?: string
  wipRef?: string
  handoff?: TakeoverHandoff
  /** The worker's `lz-takeover-handoff`, saved as soon as it arrives. */
  workerHandoff?: WorkerHandoff
  facts?: TakeoverFacts
  architectAttemptID?: string
}

export type TakeoverResult = {
  status: "taken-over" | "cancelled" | "in-progress"
  takeoverID: string
  requestID: string
  planID: string
  taskID: string
  workerAttemptID: string
  attemptID?: string
  workspace?: string
  head?: string
  commits?: string[]
  uncommitted?: string[]
  wipRef?: string
  workerQuiet?: boolean
  handoff?: TakeoverHandoff
  facts?: TakeoverFacts
  next: string
}

export type TakeoverDeps = {
  store: RunnerStore
  host: RunnerHost
  now: () => number
  validArchitect: (session: HostSession | null | undefined) => session is HostSession
  handoff: Pick<HandoffStore, "request">
  /** Notify the Architect when the scheduler, not the blocking call, finished a takeover. */
  notify: (planID: string, result: TakeoverResult) => void
  handoffWindowMs?: number
  stopWaitMs?: number
  pollMs?: number
}

export function isTakeoverSession(id: string): boolean {
  return id.startsWith(TAKEOVER_SESSION_PREFIX)
}

/**
 * The runtime's view of the host: an Architect-worked attempt has no native session, so reading
 * it is an authoritative absence and interrupting it is nothing. One choke point instead of a
 * guard at every `host.session(attempt.session_id)`.
 */
export function takeoverAwareHost(host: RunnerHost): RunnerHost {
  const wrapped = Object.create(host) as RunnerHost
  wrapped.session = (id, options) =>
    isTakeoverSession(id) ? Promise.resolve(null) : host.session(id, options)
  wrapped.interrupt = (id) => (isTakeoverSession(id) ? Promise.resolve() : host.interrupt(id))
  return wrapped
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class TakeoverExecution {
  private readonly windowMs: number
  private readonly stopWaitMs: number
  private readonly pollMs: number

  constructor(private readonly deps: TakeoverDeps) {
    this.windowMs = deps.handoffWindowMs ?? TAKEOVER_HANDOFF_WINDOW_MS
    this.stopWaitMs = deps.stopWaitMs ?? TAKEOVER_STOP_WAIT_MS
    this.pollMs = deps.pollMs ?? 1_000
  }

  private get directory() {
    return this.deps.store.repository.projectDirectory
  }

  /** Open takeovers of a plan, oldest first. */
  open(planID: string): TakeoverRow[] {
    return this.deps.store.read((db) =>
      db
        .query<TakeoverRow, [string, string]>(
          `SELECT * FROM runner_takeovers WHERE project_directory=? AND plan_id=?
             AND state IN ('notifying','awaiting-handoff','stopping') ORDER BY created_at`,
        )
        .all(this.directory, planID),
    )
  }

  /** Worker attempts the scheduler must leave alone while their takeover runs. */
  heldAttempts(planID: string): Set<string> {
    return new Set(this.open(planID).map((row) => row.attempt_id))
  }

  private row(id: string): TakeoverRow | undefined {
    return this.deps.store.read(
      (db) =>
        db.query<TakeoverRow, [string]>("SELECT * FROM runner_takeovers WHERE id=?").get(id) ??
        undefined,
    )
  }

  /** Cancel every open takeover of a plan, inside the caller's transaction (plan cancellation). */
  cancelForPlan(planID: string, reason: string) {
    for (const row of this.open(planID)) {
      const changed = this.deps.store.atomic(
        (db) =>
          db
            .query(
              "UPDATE runner_takeovers SET state=lz_runner_transition('takeover',state,'cancelled'),updated_at=? WHERE id=? AND state=?",
            )
            .run(this.deps.now(), row.id, row.state).changes,
      )
      if (changed)
        this.deps.store.record(planID, row.task_id, "TAKEOVER_CANCELLED", {
          takeoverID: row.id,
          reason,
        })
    }
  }

  /**
   * Validate and record a takeover, or join the open one for this attempt. The request is the
   * authorization: any live Architect of the project may take over, and adopts the plan.
   */
  async start(input: TakeoverInput, caller: string): Promise<TakeoverRow> {
    const { store, host } = this.deps
    const parsed = TakeoverInput.parse(input)
    const session = await host.session(caller)
    if (!this.deps.validArchitect(session))
      throw new Error("Only a live Architect of this project may take a task over")
    const existing = store.read((db) =>
      db
        .query<TakeoverRow, [string, string, string]>(
          `SELECT * FROM runner_takeovers WHERE project_directory=? AND (attempt_id=? OR id=?)
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(this.directory, parsed.attemptID, takeoverIDFor(parsed.requestID ?? "")),
    )
    if (existing && (existing.state !== "cancelled" || parsed.requestID)) return existing
    const attempt = store
      .plans()
      .flatMap((plan) => store.attempts(plan.id))
      .find((candidate) => candidate.id === parsed.attemptID)
    if (!attempt) throw new Error("No attempt of this project matches attemptID")
    const plan = store.plan(attempt.plan_id)!
    const latest = store
      .attempts(plan.id)
      .filter((candidate) => candidate.task_id === attempt.task_id)
      .at(-1)
    if (latest?.id !== attempt.id)
      throw new Error(`Attempt ${attempt.id} is not the task's latest attempt (${latest?.id})`)
    if (!["running", "blocked", "failed"].includes(plan.state))
      throw new Error(`Plan is ${plan.state}; a takeover needs a running, blocked or failed plan`)
    const node = store.nodes(plan.id).find((candidate) => candidate.task_id === attempt.task_id)!
    if (["accepted", "incorporated"].includes(node.state))
      throw new Error("The task is already accepted; use retained-repair to reopen it")
    if (store.repository.taskDisposition(attempt.task_id))
      throw new Error("The task has a recorded disposition")
    if (store.activeAdoptions(plan.id).length)
      throw new Error("A descendant adoption is pending on this plan")
    if (plan.owner !== caller) store.adoptPlanOwner(plan.id, plan.owner, caller)
    const requestID = parsed.requestID ?? `takeover-${attempt.id}-${crypto.randomUUID()}`
    const id = takeoverIDFor(requestID)
    const handoffRequestID = `takeover:${id}`
    this.deps.handoff.request(
      {
        requestID: handoffRequestID,
        sourceAttemptID: attempt.id,
        request: {
          purpose: `The Architect is taking this task over: ${parsed.reason}`,
          references: [{ kind: "task", reference: attempt.task_id }],
        },
      },
      { sessionID: caller, agent: "architect", role: "architect" },
    )
    const now = this.deps.now()
    const payload: Payload = {
      requestID,
      reason: parsed.reason,
      handoffRequestID,
      noticeID: messageID(),
      deadline: now + this.windowMs,
    }
    store.atomic((db) => {
      db.query(
        `INSERT OR IGNORE INTO runner_takeovers
           (id,project_directory,plan_id,task_id,attempt_id,architect_session_id,state,payload,created_at,updated_at)
         VALUES(?,?,?,?,?,?,'notifying',?,?,?)`,
      ).run(
        id,
        this.directory,
        plan.id,
        attempt.task_id,
        attempt.id,
        caller,
        JSON.stringify(payload),
        now,
        now,
      )
      store.record(plan.id, attempt.task_id, "TAKEOVER_REQUESTED", {
        takeoverID: id,
        attemptID: attempt.id,
        architectSessionID: caller,
        reason: parsed.reason,
        deadline: payload.deadline,
      })
    })
    return this.row(id)!
  }

  /** The blocking call: start or join, advance until the Architect holds the task, report. */
  async run(input: TakeoverInput, caller: string, signal?: AbortSignal): Promise<TakeoverResult> {
    let row = await this.start(input, caller)
    const limit = this.deps.now() + this.windowMs + this.stopWaitMs + 30_000
    while (OPEN_TAKEOVER_STATES.includes(row.state) && this.deps.now() < limit) {
      if (signal?.aborted) break
      row = await this.advance(row)
      if (OPEN_TAKEOVER_STATES.includes(row.state)) await sleep(this.pollMs)
    }
    return this.result(row)
  }

  /** One step. Used by the blocking call and by every scheduler tick, so a reload resumes it. */
  async advance(initial: TakeoverRow, fromScheduler = false): Promise<TakeoverRow> {
    let row = this.row(initial.id) ?? initial
    for (let step = 0; step < 3 && OPEN_TAKEOVER_STATES.includes(row.state); step++) {
      const before = row.state
      if (row.state === "notifying") await this.notify(row)
      else if (row.state === "awaiting-handoff") await this.awaitHandoff(row)
      else if (row.state === "stopping") await this.stop(row, fromScheduler)
      row = this.row(row.id)!
      if (row.state === before) break
    }
    return row
  }

  private payload(row: TakeoverRow): Payload {
    return JSON.parse(row.payload) as Payload
  }

  private move(row: TakeoverRow, to: TakeoverState, patch: Partial<Payload>, event?: string) {
    const { store } = this.deps
    return store.atomic((db) => {
      const changed = db
        .query(
          "UPDATE runner_takeovers SET state=lz_runner_transition('takeover',state,?),payload=?,updated_at=? WHERE id=? AND state=?",
        )
        .run(
          to,
          JSON.stringify({ ...this.payload(row), ...patch }),
          this.deps.now(),
          row.id,
          row.state,
        ).changes
      if (changed && event)
        store.record(row.plan_id, row.task_id, event, { takeoverID: row.id, ...patch })
      return changed === 1
    })
  }

  private worker(row: TakeoverRow): AttemptRow | undefined {
    return this.deps.store.attempts(row.plan_id).find((attempt) => attempt.id === row.attempt_id)
  }

  private async notify(row: TakeoverRow) {
    const payload = this.payload(row)
    const attempt = this.worker(row)
    const session = attempt ? await this.deps.host.session(attempt.session_id) : null
    // A worker that is gone or already idle has nothing to be told: stop and hand off from facts.
    if (!attempt || !session || session.archived || !session.busy) {
      this.move(row, "stopping", { stopCause: session ? "worker-idle" : "worker-absent" })
      return
    }
    if (!this.deps.host.steerWorker) {
      this.move(row, "stopping", { stopCause: "host-cannot-steer" })
      return
    }
    // Claim the one notice before sending it, so neither a second call nor a tick resends it.
    const claimed = this.deps.store.atomic(
      (db) =>
        db
          .query(
            "UPDATE runner_takeovers SET payload=?,updated_at=? WHERE id=? AND state='notifying' AND json_extract(payload,'$.noticeSent') IS NULL",
          )
          .run(JSON.stringify({ ...payload, noticeSent: true }), this.deps.now(), row.id)
          .changes === 1,
    )
    if (!claimed) return
    let noticeError: string | undefined
    try {
      await this.deps.host.steerWorker({
        sessionID: attempt.session_id,
        attemptID: attempt.id,
        directory: attempt.workspace,
        id: payload.noticeID,
        text: takeoverNotice(payload, attempt, Math.round(this.windowMs / 60_000)),
      })
    } catch (error) {
      // Delivery is unknown; the notice is never resent. The window still bounds the wait.
      noticeError = String(error).slice(0, 500)
    }
    this.move(
      this.row(row.id)!,
      "awaiting-handoff",
      noticeError ? { noticeError } : {},
      "TAKEOVER_NOTICE_DELIVERED",
    )
  }

  private workerDraft(row: TakeoverRow) {
    const payload = this.payload(row)
    return this.deps.store.read((db) => {
      const exists = db
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recovery_handoff_drafts'")
        .get()
      if (!exists) return undefined
      const draft = db
        .query<{ payload: string }, [string, string]>(
          `SELECT payload FROM recovery_handoff_drafts WHERE project_directory=? AND request_id=?
            ORDER BY draft_version DESC LIMIT 1`,
        )
        .get(this.directory, payload.handoffRequestID)
      if (!draft) return undefined
      const record = JSON.parse(draft.payload) as {
        draftVersion: number
        draft: unknown
        author: { role: string }
      }
      return record.author.role === "worker" ? record : undefined
    })
  }

  private async awaitHandoff(row: TakeoverRow) {
    const payload = this.payload(row)
    if (payload.workerHandoff || this.workerDraft(row)) {
      this.move(row, "stopping", { stopCause: "handoff-written" }, "TAKEOVER_HANDOFF_RECEIVED")
      return
    }
    const attempt = this.worker(row)
    const session = attempt ? await this.deps.host.session(attempt.session_id) : null
    if (!session || session.archived) this.move(row, "stopping", { stopCause: "worker-absent" })
    else if (!session.busy && !session.pendingInput)
      this.move(row, "stopping", { stopCause: "worker-turn-ended" })
    else if (this.deps.now() >= payload.deadline)
      this.move(row, "stopping", { stopCause: "handoff-window-passed" })
  }

  private async stop(row: TakeoverRow, fromScheduler: boolean) {
    const { store, host, now } = this.deps
    let payload = this.payload(row)
    const attempt = this.worker(row)!
    const session = await host.session(attempt.session_id)
    const busy = Boolean(
      session &&
      !session.archived &&
      (session.busy || (session.runningShells ?? 0) > 0 || (session.activeChildren ?? 0) > 0),
    )
    if (busy) {
      if (payload.stopDeadline === undefined) {
        payload = { ...payload, stopDeadline: now() + this.stopWaitMs }
        store.atomic((db) =>
          db
            .query("UPDATE runner_takeovers SET payload=? WHERE id=? AND state='stopping'")
            .run(JSON.stringify(payload), row.id),
        )
        store.record(row.plan_id, row.task_id, "TAKEOVER_WORKER_INTERRUPTED", {
          takeoverID: row.id,
          sessionID: attempt.session_id,
        })
      }
      await host.interrupt(attempt.session_id)
      if (now() < payload.stopDeadline!) return
    }
    const facts = this.workspaceFacts(row, attempt)
    // The worker's handoff may have arrived while it was being stopped; read the row again.
    const latest = this.payload(this.row(row.id)!)
    const draft = latest.workerHandoff ? undefined : this.workerDraft(row)
    const handoff: TakeoverHandoff = latest.workerHandoff
      ? latest.workerHandoff
      : draft
        ? { author: "worker", draftVersion: draft.draftVersion, draft: draft.draft }
        : {
            author: "runtime",
            note: "Not written by the worker: it wrote no handoff before it stopped. Built from recorded facts; read the commits, the uncommitted paths and the trajectory before continuing.",
          }
    const settled = this.settle(this.row(row.id)!, attempt, {
      ...facts,
      handoff,
      facts: this.taskFacts(row),
      workerQuiet: !busy,
    })
    if (settled && fromScheduler) this.deps.notify(row.plan_id, this.result(this.row(row.id)!))
  }

  /** Commits since the attempt began, uncommitted paths, and a tree snapshot kept by a ref. */
  private workspaceFacts(row: TakeoverRow, attempt: AttemptRow): Partial<Payload> {
    const ws = attempt.workspace
    const read = (args: string[], env?: Record<string, string>) => {
      try {
        return git(ws, args, undefined, env)
      } catch {
        return ""
      }
    }
    const head = read(["rev-parse", "HEAD"])
    const commits = read(["log", "--format=%h %s", "-n", "30", `${attempt.base_commit}..HEAD`])
      .split("\n")
      .filter(Boolean)
    const uncommitted = read(["status", "--porcelain", "--untracked-files=all"])
      .split("\n")
      .filter(Boolean)
      .slice(0, 100)
    if (!uncommitted.length) return { workspace: ws, head, commits, uncommitted }
    // A tree of the whole working copy, written through a private index: the worktree, its index
    // and its branch are untouched, and the ref keeps the snapshot from garbage collection.
    const scratch = mkdtempSync(join(tmpdir(), "lazers-takeover-"))
    try {
      const env = { GIT_INDEX_FILE: join(scratch, "index") }
      read(["read-tree", "HEAD"], env)
      read(["add", "-A"], env)
      const tree = read(["write-tree"], env)
      const ref = `refs/lazers/takeover/${row.id}`
      if (tree) read(["update-ref", ref, tree])
      return {
        workspace: ws,
        head,
        commits,
        uncommitted,
        ...(tree ? { wipTree: tree, wipRef: ref } : {}),
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /**
   * The worker's slim handoff, from `lz-takeover-handoff`. The caller is the worker session of an
   * open takeover; the payload is never rejected for its shape, only kept.
   */
  recordWorkerHandoff(input: unknown, sessionID: string) {
    const { store } = this.deps
    const row = store.read((db) =>
      db
        .query<TakeoverRow, [string, string]>(
          `SELECT t.* FROM runner_takeovers t JOIN runner_attempts a ON a.id=t.attempt_id
            WHERE t.project_directory=? AND a.session_id=?
              AND t.state IN ('notifying','awaiting-handoff','stopping')
            ORDER BY t.created_at DESC LIMIT 1`,
        )
        .get(this.directory, sessionID),
    )
    if (!row)
      throw new Error("No takeover is waiting for a handoff from this session; continue your task")
    const handoff = normalizeWorkerHandoff(input)
    const saved = store.atomic((db) => {
      const current = db
        .query<{ payload: string; state: string }, [string]>(
          "SELECT payload,state FROM runner_takeovers WHERE id=?",
        )
        .get(row.id)
      if (!current || !OPEN_TAKEOVER_STATES.includes(current.state as TakeoverState)) return false
      const payload = JSON.parse(current.payload) as Payload
      if (payload.workerHandoff) return true
      db.query("UPDATE runner_takeovers SET payload=?,updated_at=? WHERE id=?").run(
        JSON.stringify({ ...payload, workerHandoff: handoff }),
        this.deps.now(),
        row.id,
      )
      return true
    })
    if (!saved) throw new Error("The takeover already finished; your handoff was not needed")
    return {
      status: "received",
      next: "Thank you. Stop now and end your turn; the Architect continues in this workspace.",
    }
  }

  /** Recorded facts about the task, given with every handoff. */
  private taskFacts(row: TakeoverRow): TakeoverFacts {
    const { store } = this.deps
    const attempts = store.attempts(row.plan_id).filter((a) => a.task_id === row.task_id)
    const ids = attempts.map((a) => a.id)
    const failingChecks = store.read((db) => {
      const latest = new Map<string, TakeoverFacts["failingChecks"][number]>()
      for (const id of ids)
        for (const { body } of db
          .query<{ body: string }, [string]>(
            "SELECT body FROM runner_evidence WHERE attempt_id=? AND kind='verification' ORDER BY rowid",
          )
          .all(id)) {
          const receipt = JSON.parse(body) as {
            id: string
            command: string
            exitCode: number | null
            stdout?: string
            stderr?: string
          }
          if (receipt.exitCode === 0) latest.delete(receipt.id)
          else
            latest.set(receipt.id, {
              id: receipt.id,
              command: receipt.command,
              exitCode: receipt.exitCode,
              output: `${receipt.stderr ?? ""}\n${receipt.stdout ?? ""}`.trim().slice(-600),
            })
        }
      return [...latest.values()]
    })
    const concerns = store
      .read((db) => openConcerns(db, this.directory, { taskID: row.task_id }))
      .map((concern) => concern.reason)
    const counted = attempts.filter((a) => a.token_count !== null)
    return {
      failingChecks,
      concerns,
      attempts: attempts.length,
      ...(counted.length ? { tokens: counted.reduce((sum, a) => sum + a.token_count!, 0) } : {}),
    }
  }

  /**
   * One transaction: cancel the worker's attempt, move the task and plan back to running through
   * their machines, and open the Architect's attempt in the same workspace on the same base.
   */
  private settle(row: TakeoverRow, worker: AttemptRow, patch: Partial<Payload>): boolean {
    const { store } = this.deps
    if (row.state !== "stopping") return false
    const architectAttemptID = crypto.randomUUID()
    return store.atomic((db) => {
      const current = db
        .query<{ state: string }, [string]>("SELECT state FROM runner_takeovers WHERE id=?")
        .get(row.id)
      if (current?.state !== "stopping") return false
      const attempt = store.attempts(row.plan_id).find((a) => a.id === worker.id)!
      if (["preparing", "running", "verifying"].includes(attempt.state))
        db.query(
          "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'cancelled') WHERE id=?",
        ).run(attempt.id)
      const reason = `Architect takeover: ${this.payload(row).reason}`
      const node = store.nodes(row.plan_id).find((n) => n.task_id === row.task_id)!
      const path: Record<string, string[]> = {
        running: [],
        verifying: ["RESUME"],
        failed: ["RESUME"],
        exhausted: ["RESUME"],
        cancelled: ["RESUME"],
        blocked: ["RETRY", "DISPATCH"],
        ready: ["DISPATCH"],
        queued: ["READY", "DISPATCH"],
      }
      const events = path[node.state]
      if (!events) throw new Error(`A ${node.state} task cannot be taken over`)
      for (const event of events) store.move(row.plan_id, row.task_id, event, reason)
      const plan = store.plan(row.plan_id)!
      if (plan.state !== "running")
        db.query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=?",
        ).run(plan.id)
      const number =
        Math.max(
          0,
          ...store
            .attempts(row.plan_id)
            .filter((a) => a.task_id === row.task_id)
            .map((a) => a.number),
        ) + 1
      const policy = {
        ...(JSON.parse(worker.policy) as Record<string, unknown>),
        agent: "architect",
        repairAttempt: true,
        takeover: {
          takeoverID: row.id,
          architectSessionID: row.architect_session_id,
          fromAttemptID: worker.id,
        },
      }
      db.query(
        "INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at) VALUES(?,?,?,?,?,?,?,?,?,'preparing',?)",
      ).run(
        architectAttemptID,
        row.plan_id,
        row.task_id,
        number,
        `${TAKEOVER_SESSION_PREFIX}${row.id}`,
        `takeover-${row.id}`,
        worker.workspace,
        worker.base_commit,
        JSON.stringify(policy),
        this.deps.now(),
      )
      db.query(
        "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'running') WHERE id=?",
      ).run(architectAttemptID)
      const changed = db
        .query(
          "UPDATE runner_takeovers SET state=lz_runner_transition('takeover',state,'taken-over'),payload=?,updated_at=? WHERE id=? AND state='stopping'",
        )
        .run(
          JSON.stringify({ ...this.payload(row), ...patch, architectAttemptID }),
          this.deps.now(),
          row.id,
        ).changes
      if (changed !== 1) throw new Error("Takeover changed while it was being settled")
      store.record(row.plan_id, row.task_id, "TAKEOVER_WORKER_STOPPED", {
        takeoverID: row.id,
        attemptID: worker.id,
        workerQuiet: patch.workerQuiet ?? null,
        head: patch.head ?? null,
        wipRef: patch.wipRef ?? null,
        uncommitted: patch.uncommitted?.length ?? 0,
      })
      store.record(row.plan_id, row.task_id, "TAKEOVER_STARTED", {
        takeoverID: row.id,
        attemptID: architectAttemptID,
        architectSessionID: row.architect_session_id,
        handoffAuthor: patch.handoff?.author ?? null,
      })
      return true
    })
  }

  result(row: TakeoverRow): TakeoverResult {
    const payload = this.payload(row)
    const base = {
      takeoverID: row.id,
      requestID: payload.requestID,
      planID: row.plan_id,
      taskID: row.task_id,
      workerAttemptID: row.attempt_id,
    }
    if (row.state === "cancelled")
      return { ...base, status: "cancelled", next: "The takeover was cancelled with its plan." }
    if (row.state !== "taken-over")
      return {
        ...base,
        status: "in-progress",
        next: `The worker has not stopped yet (${row.state}). Call lz-request-handoff again with requestID ${payload.requestID}; nothing is sent twice.`,
      }
    return {
      ...base,
      status: "taken-over",
      ...(payload.architectAttemptID ? { attemptID: payload.architectAttemptID } : {}),
      ...(payload.workspace ? { workspace: payload.workspace } : {}),
      ...(payload.head ? { head: payload.head } : {}),
      commits: payload.commits ?? [],
      uncommitted: payload.uncommitted ?? [],
      ...(payload.wipRef ? { wipRef: payload.wipRef } : {}),
      ...(payload.workerQuiet === undefined ? {} : { workerQuiet: payload.workerQuiet }),
      ...(payload.handoff ? { handoff: payload.handoff } : {}),
      ...(payload.facts ? { facts: payload.facts } : {}),
      next: `Read the handoff, then finish the task yourself in ${payload.workspace}: edit and commit there (uncommitted work is kept; ${payload.wipRef ?? "no snapshot was needed"}). Then lz-plan-command {action:"takeover-submit", planID:"${row.plan_id}", taskID:"${row.task_id}", reason}; the runtime verifies it like a worker result.${payload.workerQuiet === false ? " The worker did not go quiet after interruption; check it before writing." : ""}`,
    }
  }
}

function takeoverIDFor(requestID: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(`lazers-takeover:${requestID}`)
  const h = hasher.digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function takeoverNotice(payload: Payload, attempt: AttemptRow, minutes: number): string {
  return [
    `The Architect is taking task ${attempt.task_id} over from you now. Reason: ${payload.reason}`,
    "Stop starting new work. Within the next step or two:",
    "1. Commit your work in progress in this workspace (a WIP commit is fine; never discard changes).",
    "2. Call lz-takeover-handoff once: done, remaining, workspaceState, struggledWith, tried (plain text; anything missing is fine).",
    "3. End your turn.",
    `After ${minutes} minutes you are stopped and the runtime writes the handoff from recorded facts.`,
  ].join("\n")
}
