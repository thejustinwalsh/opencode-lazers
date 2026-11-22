import { randomUUID } from "node:crypto"
import {
  parsePlanningResult,
  type FindingSeverity,
  type PlanningAgentId as AgentID,
} from "./contract.ts"
import { PlanningBody, type Validation } from "./draft.ts"
import { pathCheck } from "./checks.ts"
import type { ModelRef, PlanningHost } from "./host.ts"
import { planningReviewMessage } from "./prompt.ts"
import { planningHostID } from "./register.ts"
import { renderBreakdown, renderFullPlan, type ReviewSummary } from "./render.ts"
import type {
  FindingRow,
  PlanningStore,
  QuestionRow,
  ReviewRow,
  ReviewStage,
  RunRow,
} from "./store.ts"

/** Why an agent is in the review. `all` is the default: every planning agent runs. */
export type AgentSelection = {
  agent: AgentID
  source: "all" | "decision" | "architect" | "rule:stored-data" | "final"
}

/** What a review needs to run again after a restart, kept in `planning_reviews.selection_json`. */
type ReviewSelection = {
  agents: AgentSelection[]
  parentSessionID: string
  directory: string
}

export type ReviewResult = {
  reviewID: string
  planningID: string
  revision: number
  stage: ReviewStage
  agents: {
    agent: AgentID
    status: "reviewed" | "not-run"
    reason?: string
    attempts: number
    tokens: number
    durationMs: number
    bySeverity: Record<FindingSeverity, number>
  }[]
  findings: FindingRow[]
  questions: QuestionRow[]
  summary: ReviewSummary
  breakdown: string
  runbook?: string
}

type RepoMapFacts = { text: string; hash: string; tokens: number; paths: ReadonlySet<string> }

export type PlanningReviewsDeps = {
  store: PlanningStore
  host: PlanningHost
  now: () => number
  /** Wait between observations of the children; 0 in tests. */
  pollMs?: number
  mapFor: (directory: string) => Promise<RepoMapFacts>
  /** Reports a settled review nobody was waiting for, once, to the Architect's session. */
  notify: (sessionID: string, id: string, text: string) => Promise<void>
  title: (agent: AgentID, revision: number) => string
  model?: () => ModelRef | undefined
  /**
   * USD per million tokens for the model a run used, from the configured price sources; `undefined`
   * when no source prices it. A review's cost is shown only when every run it counts was priced,
   * and it is never a limit.
   */
  price?: (model: ModelRef) => RunPrice | undefined
}

export type RunPrice = { input: number; output: number; cacheRead?: number }

/** Cost of runs in USD, or undefined when any run has no price or no recorded model. */
export function runsCost(
  runs: readonly RunRow[],
  price?: (model: ModelRef) => RunPrice | undefined,
) {
  if (!price || !runs.length) return undefined
  let total = 0
  for (const run of runs) {
    if (!run.modelJson) return undefined
    const rates = price(JSON.parse(run.modelJson) as ModelRef)
    if (!rates) return undefined
    total +=
      ((run.inputTokens ?? 0) * rates.input +
        (run.outputTokens ?? 0) * rates.output +
        (run.cacheReadTokens ?? 0) * (rates.cacheRead ?? 0)) /
      1_000_000
  }
  return total
}

const sessionID = () => `ses_${randomUUID()}`
const messageID = () => `msg_${randomUUID().replaceAll("-", "")}`

/** The notice's message id: stable for a review, so a repeated notice is the same message. */
export const reviewNoticeID = (reviewID: string) => `msg_${reviewID.replaceAll("-", "")}`

const emptySeverities = (): Record<FindingSeverity, number> => ({
  blocker: 0,
  major: 0,
  minor: 0,
  nit: 0,
})

export class PlanningReviews {
  /** Reviews a caller in this process is waiting on; `tick` leaves them to that caller. */
  private readonly live = new Set<string>()
  private readonly prompted = new Set<string>()
  private readonly seenUpdate = new Map<string, number>()
  private readonly maps = new Map<string, RepoMapFacts>()

  constructor(private readonly deps: PlanningReviewsDeps) {}

  private selection(review: ReviewRow): ReviewSelection {
    return JSON.parse(review.selectionJson) as ReviewSelection
  }

  private async map(directory: string, reviewID: string) {
    let map = this.maps.get(reviewID)
    if (!map) this.maps.set(reviewID, (map = await this.deps.mapFor(directory)))
    return map
  }

  /** Starts a review, or joins the open one of the same plan, stage and revision. */
  async start(input: {
    planningID: string
    stage: ReviewStage
    agents: AgentSelection[]
    parentSessionID: string
    directory: string
  }): Promise<ReviewRow> {
    const { store, now } = this.deps
    const planning = store.planning(input.planningID)
    if (!planning || planning.revision === 0)
      throw new Error(`Unknown planning ${input.planningID}`)
    const open = store.openReview(planning.id, input.stage, planning.revision)
    if (open) return open
    if (input.stage === "review") {
      if (!["drafted", "questions-open", "in-review"].includes(planning.state))
        throw new Error(`plan is ${planning.state}; it cannot be reviewed`)
      store.move(planning.id, "in-review", now())
    } else if (planning.state === "questions-open") store.move(planning.id, "final-review", now())
    else if (planning.state !== "final-review")
      throw new Error(`plan is ${planning.state}; the final pass follows the review`)
    const revision = store.revision(planning.id, planning.revision)!
    const body = PlanningBody.parse(JSON.parse(revision.body))
    const map = await this.deps.mapFor(input.directory)
    const id = randomUUID()
    this.maps.set(id, map)
    const selection: ReviewSelection = {
      agents: input.agents,
      parentSessionID: input.parentSessionID,
      directory: input.directory,
    }
    store.createReview({
      id,
      planningId: planning.id,
      revision: planning.revision,
      stage: input.stage,
      selectionJson: JSON.stringify(selection),
      createdAt: now(),
    })
    // No model: a draft path missing from the map is a finding of its own.
    for (const finding of pathCheck(body, map.paths, map.hash))
      store.addFinding({
        id: `${id}:${finding.id}`,
        planningId: planning.id,
        reviewId: id,
        runId: "path-check",
        source: "path-check",
        agentFindingId: finding.id,
        revision: planning.revision,
        draftId: finding.target.unit,
        unit: finding.target.unit,
        field: finding.target.field,
        severity: finding.severity,
        confidence: finding.confidence,
        body: JSON.stringify(finding),
      })
    for (const { agent } of input.agents)
      store.createRun({
        id: randomUUID(),
        reviewId: id,
        agent,
        attempt: 1,
        sessionId: sessionID(),
        state: "starting",
        promptMessageId: messageID(),
        startedAt: now(),
        lastActivityAt: now(),
        maxGapMs: 0,
        mapHash: map.hash,
        mapTokens: map.tokens,
      })
    return store.review(id)!
  }

  /** Blocks until every agent has an outcome, then marks the review returned to this caller. */
  async run(reviewID: string, signal?: AbortSignal): Promise<ReviewResult> {
    this.live.add(reviewID)
    try {
      for (;;) {
        if (signal?.aborted) await this.cancel(reviewID, "cancelled")
        const review = await this.advance(reviewID)
        if (review.settledAt) break
        await this.sleep(signal)
      }
    } finally {
      this.live.delete(reviewID)
    }
    this.deps.store.updateReview(reviewID, { returnedAt: this.deps.now() })
    return this.result(reviewID)
  }

  private sleep(signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.deps.pollMs ?? 1000)
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }

  /** One step for every agent of the review; safe to call from `run` and `tick` at once. */
  async advance(reviewID: string): Promise<ReviewRow> {
    const { store } = this.deps
    const review = store.review(reviewID)
    if (!review || review.settledAt) return review!
    const agents = [...new Set(store.runs(reviewID).map((run) => run.agent))]
    await Promise.all(agents.map((agent) => this.advanceAgent(review, agent)))
    if (this.allSettled(reviewID)) this.settle(review)
    return store.review(reviewID)!
  }

  private latest(reviewID: string, agent: string) {
    return this.deps.store
      .runs(reviewID)
      .filter((run) => run.agent === agent)
      .sort((a, b) => a.attempt - b.attempt)
      .at(-1)!
  }

  private allSettled(reviewID: string): boolean {
    const runs = this.deps.store.runs(reviewID)
    return [...new Set(runs.map((run) => run.agent))].every((agent) => {
      const latest = this.latest(reviewID, agent)
      if (latest.state === "reviewed" || latest.state === "cancelled") return true
      return latest.state === "failed" && latest.attempt >= 2
    })
  }

  private async advanceAgent(review: ReviewRow, agent: string) {
    let run = this.latest(review.id, agent)
    try {
      if (run.state === "failed" && run.attempt === 1) {
        run = await this.retry(review, run)
      }
      if (run.state === "starting") await this.startRun(review, run)
      run = this.latest(review.id, agent)
      if (run.state === "starting" || run.state === "running") await this.observeRun(review, run)
    } catch {
      // A host failure is retried on the next step; the run ends on the host's own outcome or a
      // lost session, never on elapsed time.
    }
  }

  private async message(review: ReviewRow, run: RunRow): Promise<string> {
    const { store } = this.deps
    const selection = this.selection(review)
    const stored = store.revision(review.planningId, review.revision)!
    const body = PlanningBody.parse(JSON.parse(stored.body))
    const map = await this.map(selection.directory, review.id)
    const base = planningReviewMessage({
      planMarkdown: renderFullPlan(body, review.revision),
      source: `plan ${review.planningId} r${review.revision}`,
      mapText: map.text,
    })
    if (run.attempt < 2) return base
    const previous = store
      .runs(review.id)
      .find((other) => other.agent === run.agent && other.attempt === run.attempt - 1)
    return `${base}\n\nA previous attempt ended: ${previous?.reason ?? "unknown"}. Reply with the JSON object only.`
  }

  private async startRun(review: ReviewRow, run: RunRow) {
    const { host, store, now } = this.deps
    const selection = this.selection(review)
    const observed = await host.observe(run.sessionId!)
    if (!observed.found)
      await host.create({
        id: run.sessionId!,
        parentID: selection.parentSessionID,
        agent: planningHostID(run.agent as AgentID),
        ...(this.deps.model?.() ? { model: this.deps.model() } : {}),
        directory: selection.directory,
        title: this.deps.title(run.agent as AgentID, review.revision),
      })
    if (!this.prompted.has(run.id)) {
      await host.prompt({
        sessionID: run.sessionId!,
        messageID: run.promptMessageId!,
        text: await this.message(review, run),
        directory: selection.directory,
      })
      this.prompted.add(run.id)
      store.patchRun(run.id, { lastActivityAt: now() })
    }
  }

  private async retry(review: ReviewRow, failed: RunRow): Promise<RunRow> {
    const { store, now } = this.deps
    const next: RunRow = {
      id: randomUUID(),
      reviewId: review.id,
      agent: failed.agent,
      attempt: failed.attempt + 1,
      sessionId: sessionID(),
      state: "starting",
      promptMessageId: messageID(),
      startedAt: now(),
      lastActivityAt: now(),
      maxGapMs: 0,
      mapHash: failed.mapHash,
      mapTokens: failed.mapTokens,
    }
    store.createRun(next)
    return next
  }

  private async observeRun(review: ReviewRow, initial: RunRow) {
    const { host, store, now } = this.deps
    let run = initial
    const observed = await host.observe(run.sessionId!)
    if (!observed.found) {
      // A child that vanished before it ran is created again on the next step.
      if (run.state === "running")
        store.moveRun(run.id, "running", "failed", { reason: "session lost", endedAt: now() })
      return
    }
    if (run.state === "starting") {
      if (observed.busyAt === undefined || observed.busyAt < run.startedAt) return
      store.moveRun(run.id, "starting", "running")
      run = { ...run, state: "running" }
    }
    // Progress is recorded for the planning report; it decides nothing.
    if (this.seenUpdate.get(run.id) !== observed.updatedAt) {
      this.seenUpdate.set(run.id, observed.updatedAt)
      const gap = now() - (run.lastActivityAt ?? run.startedAt)
      store.patchRun(run.id, {
        lastActivityAt: now(),
        maxGapMs: Math.max(run.maxGapMs ?? 0, gap),
      })
      run = { ...run, lastActivityAt: now() }
    }
    const done =
      observed.outcome !== undefined &&
      observed.busyAt !== undefined &&
      observed.idleAt !== undefined &&
      observed.idleAt >= observed.busyAt
    if (done) await this.finish(run, observed.outcome!)
  }

  private async finish(run: RunRow, outcome: "succeeded" | "failed" | "interrupted") {
    const { host, store, now } = this.deps
    const ended = { endedAt: now(), durationMs: now() - run.startedAt }
    if (outcome !== "succeeded") {
      store.moveRun(run.id, "running", "failed", { ...ended, reason: outcome })
      return
    }
    const reply = await host.reply(run.sessionId!)
    if (!reply) {
      store.moveRun(run.id, "running", "failed", { ...ended, reason: "no reply" })
      return
    }
    const facts = {
      ...ended,
      rawReply: reply.text,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      cacheReadTokens: reply.cacheReadTokens,
      ...(reply.model ? { modelJson: JSON.stringify(reply.model) } : {}),
    }
    if (reply.finish === "length") {
      store.moveRun(run.id, "running", "failed", { ...facts, reason: "truncated" })
      return
    }
    try {
      const result = parsePlanningResult(reply.text)
      if (result.agent !== run.agent) throw new Error(`reply is from ${result.agent}`)
      store.moveRun(run.id, "running", "reviewed", {
        ...facts,
        ...(result.status === "not-run" ? { reason: result.reason } : {}),
      })
    } catch (error) {
      store.moveRun(run.id, "running", "failed", {
        ...facts,
        reason: `malformed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
      })
    }
  }

  /** Stores each reviewed agent's findings and questions, once, with the revision they reviewed. */
  private settle(review: ReviewRow) {
    const { store, now } = this.deps
    const stored = store.revision(review.planningId, review.revision)!
    const drafts = new Set(
      PlanningBody.parse(JSON.parse(stored.body)).tasks.map((task) => task.draftID),
    )
    const findings: FindingRow[] = []
    const questions: QuestionRow[] = []
    for (const agent of this.selection(review).agents.map((entry) => entry.agent)) {
      const run = this.latest(review.id, agent)
      if (run.state !== "reviewed" || !run.rawReply) continue
      const result = parsePlanningResult(run.rawReply)
      for (const finding of result.findings)
        findings.push({
          id: `${run.id}:${finding.id}`,
          planningId: review.planningId,
          reviewId: review.id,
          runId: run.id,
          source: agent,
          agentFindingId: finding.id,
          revision: review.revision,
          draftId: drafts.has(finding.target.unit) ? finding.target.unit : null,
          unit: finding.target.unit,
          field: finding.target.field,
          severity: finding.severity,
          confidence: finding.confidence,
          body: JSON.stringify(finding),
        })
      for (const question of result.questions)
        questions.push({
          id: `${run.id}:${question.id}`,
          planningId: review.planningId,
          reviewId: review.id,
          source: agent,
          agentQuestionId: question.id,
          revision: review.revision,
          findingId: question.relatedFinding ? `${run.id}:${question.relatedFinding}` : null,
          weight: question.weight,
          body: JSON.stringify(question),
        })
    }
    store.settleReview({
      reviewID: review.id,
      planningID: review.planningId,
      now: now(),
      findings,
      questions,
      ...(review.stage === "review"
        ? { from: "in-review" as const, to: "questions-open" as const }
        : {}),
    })
    this.maps.delete(review.id)
  }

  /** Interrupts the children, ends their runs `cancelled`, and settles the review. */
  async cancel(reviewID: string, reason: string): Promise<void> {
    const { store, host, now } = this.deps
    const review = store.review(reviewID)
    if (!review || review.settledAt) return
    for (const agent of new Set(store.runs(reviewID).map((run) => run.agent))) {
      const latest = this.latest(reviewID, agent)
      if (latest.state === "starting" || latest.state === "running") {
        if (latest.sessionId) await host.interrupt(latest.sessionId).catch(() => undefined)
        store.moveRun(latest.id, latest.state, "cancelled", { reason, endedAt: now() })
      } else if (latest.state === "failed" && latest.attempt === 1) {
        // The retry that would have followed never starts.
        store.createRun({
          ...latest,
          id: randomUUID(),
          attempt: 2,
          sessionId: null,
          state: "cancelled",
          reason,
          startedAt: now(),
          endedAt: now(),
        })
      }
    }
    await this.advance(reviewID)
  }

  /** Cancels every open review of a plan: it was abandoned or tasked. */
  async cancelForPlanning(planningID: string, reason: string): Promise<void> {
    for (const review of this.deps.store.reviews(planningID))
      if (!review.settledAt) await this.cancel(review.id, reason)
  }

  /** Advances open reviews no live caller holds, and reports each settled one once. */
  async tick(): Promise<void> {
    const { store, now, notify } = this.deps
    // Nothing open and nothing to report: one probe and stop.
    if (!store.hasOpenReviewWork()) return
    for (const review of store.unsettledReviews())
      if (!this.live.has(review.id)) await this.advance(review.id).catch(() => undefined)
    for (const review of store.reviewsToNotify()) {
      if (this.live.has(review.id)) continue
      if (!store.claimNotice(review.id, now())) continue
      const result = this.result(review.id)
      const s = result.summary
      const text = [
        `[lz-notice kind=planning-review plan=${review.planningId} v=${review.revision}]`,
        `The ${review.stage} of plan r${review.revision} finished while you were away: ${s.agents} agents${
          s.notRun ? ` (${s.notRun} not run)` : ""
        }, ${Object.values(s.findings).reduce((a, b) => a + b, 0)} findings, ${s.ownerQuestions} questions.`,
        result.breakdown,
      ].join("\n")
      await notify(this.selection(review).parentSessionID, reviewNoticeID(review.id), text).catch(
        () => undefined,
      )
    }
  }

  /** The review as the tool returns it, built from stored rows only. */
  result(reviewID: string): ReviewResult {
    const { store } = this.deps
    const review = store.review(reviewID)!
    const selection = this.selection(review)
    const findings = store.findings(review.planningId).filter((f) => f.reviewId === reviewID)
    const questions = store.questions(review.planningId).filter((q) => q.reviewId === reviewID)
    const agents = selection.agents.map(({ agent }) => {
      const runs = store
        .runs(reviewID)
        .filter((run) => run.agent === agent)
        .sort((a, b) => a.attempt - b.attempt)
      const latest = runs.at(-1)!
      const bySeverity = emptySeverities()
      for (const finding of findings)
        if (finding.source === agent && finding.severity && finding.severity in bySeverity)
          bySeverity[finding.severity as FindingSeverity]++
      const reviewed = latest.state === "reviewed" && !latest.reason
      return {
        agent,
        status: reviewed ? ("reviewed" as const) : ("not-run" as const),
        ...(!reviewed && latest.reason ? { reason: latest.reason } : {}),
        attempts: runs.filter((run) => run.sessionId).length,
        tokens: runs.reduce(
          (sum, run) => sum + (run.inputTokens ?? 0) + (run.outputTokens ?? 0),
          0,
        ),
        durationMs: runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0),
        bySeverity,
      }
    })
    const severities = emptySeverities()
    for (const finding of findings)
      if (finding.severity && finding.severity in severities)
        severities[finding.severity as FindingSeverity]++
    const cost = runsCost(store.runs(reviewID), this.deps.price)
    const summary: ReviewSummary = {
      agents: agents.length,
      notRun: agents.filter((agent) => agent.status === "not-run").length,
      findings: severities,
      ownerQuestions: questions.length,
      tokens: agents.reduce((sum, agent) => sum + agent.tokens, 0),
      ...(cost === undefined ? {} : { costUSD: cost }),
    }
    const stored = store.revision(review.planningId, review.revision)!
    const body = PlanningBody.parse(JSON.parse(stored.body))
    return {
      reviewID,
      planningID: review.planningId,
      revision: review.revision,
      stage: review.stage,
      agents,
      findings,
      questions,
      summary,
      breakdown: renderBreakdown({
        body,
        revision: review.revision,
        validation: JSON.parse(stored.validation) as Validation,
        planningID: review.planningId,
        projectID: store.planning(review.planningId)!.projectKey,
        review: summary,
      }),
    }
  }
}
