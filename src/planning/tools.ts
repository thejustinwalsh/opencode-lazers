import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Delivery, runbook } from "../guidance/index.ts"
import type { PlanningState } from "../runner/lifecycle-machines.ts"
import type { TaskRepository } from "../storage.ts"
import { PlanningAgentId, type PlanningAgentId as AgentID } from "./contract.ts"
import { AGENT_ORDER } from "./decision/tree.ts"
import { rulesAdd } from "./checks.ts"
import { PlanTaskInput, type PlanTasker } from "./tasking.ts"
import type { AgentSelection, PlanningReviews, ReviewResult } from "./reviews.ts"
import type { TargetField } from "./contract.ts"
import {
  DEFERRED_TO_TASKING,
  DraftID,
  PlanningBody,
  fieldHashes,
  validateBody,
  type Validation,
} from "./draft.ts"
import { isStale } from "./view-assembly.ts"
import { planMarkdownLink } from "./links.ts"
import { renderBreakdown } from "./render.ts"
import { PlanningStore, type QuestionRow } from "./store.ts"

export const PlanDraftInput = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("store"),
    planningID: z.uuid().optional().describe("Omit to start a new plan; give it to revise one."),
    expectedRevision: z
      .int()
      .positive()
      .optional()
      .describe(
        "The revision you edited from. Required to revise; a newer one is never overwritten.",
      ),
    decisionMessageID: z
      .string()
      .optional()
      .describe("The m=<id> of the decision note this plan answers, when there was one."),
    architectPick: z
      .strictObject({
        size: z.enum(["one task", "a few tasks", "a large effort"]).optional(),
        agents: z.array(PlanningAgentId).optional(),
      })
      .optional()
      .describe("Your own classification of the ask, recorded beside the decision model's."),
    body: PlanningBody,
  }),
  z.strictObject({
    action: z.literal("finalize"),
    planningID: z.uuid(),
    body: PlanningBody.optional(),
  }),
  z.strictObject({
    action: z.literal("abandon"),
    planningID: z.uuid(),
    reason: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    action: z.literal("guide"),
    topic: z.enum(["draft", "show", "resolve", "brainstorm"]),
  }),
  z.strictObject({ action: z.literal("evidence"), planningID: z.uuid(), draftID: DraftID }),
])
export type PlanDraftInput = z.infer<typeof PlanDraftInput>

export type PlanDraftResult =
  | {
      status: "stored"
      planningID: string
      revision: number
      state: PlanningState
      breakdown: string
      link: string
      validation: Validation
      deferred: typeof DEFERRED_TO_TASKING
      runbook?: string
      /** After `finalize`: findings and questions still open, listed as they were left. */
      open?: number
    }
  | { status: "conflict"; currentRevision: number }
  | { status: "invalid"; errors: { path: string; message: string }[] }
  | { status: "abandoned"; planningID: string }
  | { status: "guide"; topic: string; guidance: string }
  | { status: "evidence"; evidence: string[] }

type Caller = { sessionID: string }
const MAX_EVIDENCE = 20
const MAX_EVIDENCE_CHARS = 6_000

const invalid = (path: string, message: string): PlanDraftResult => ({
  status: "invalid",
  errors: [{ path, message }],
})

const text = (json: string | null | undefined): string => {
  if (!json) return ""
  try {
    const value = JSON.parse(json) as Record<string, unknown>
    for (const key of ["answer", "evidence", "note", "what", "question"])
      if (typeof value[key] === "string") return value[key] as string
    return json
  } catch {
    return json
  }
}

/** The Architect's one tool for a stored plan: the logic apart from the host, for tests. */
export class PlanDrafts {
  readonly store: PlanningStore
  constructor(
    repository: Pick<TaskRepository, "read" | "atomic" | "projectDirectory">,
    private readonly projectID: string,
    private readonly now: () => number = Date.now,
    /** Called when a plan is abandoned, so its running review runs are cancelled. */
    private readonly cancelReviews?: (planningID: string, reason: string) => void,
  ) {
    this.store = new PlanningStore(repository)
    this.directory = repository.projectDirectory
  }
  private readonly directory: string

  private owned(planningID: string) {
    const row = this.store.planning(planningID)
    return row && row.projectKey === this.projectID ? row : undefined
  }

  private stored(
    planningID: string,
    body: PlanningBody,
    revision: number,
    delivery: Delivery,
  ): PlanDraftResult {
    const validation = validateBody(body)
    const row = this.store.planning(planningID)!
    return {
      status: "stored",
      planningID,
      revision,
      state: row.state,
      breakdown: renderBreakdown({
        body,
        revision,
        validation,
        planningID,
        projectID: this.projectID,
      }),
      link: planMarkdownLink(planningID, this.projectID),
      validation,
      deferred: DEFERRED_TO_TASKING,
      runbook: delivery.once("planning-show"),
    }
  }

  call(
    input: PlanDraftInput,
    caller: Caller,
    delivery = new Delivery(caller.sessionID),
  ): PlanDraftResult {
    switch (input.action) {
      case "store":
        return this.storeBody(input, caller, delivery)
      case "finalize":
        return this.finalize(input, caller, delivery)
      case "abandon":
        return this.abandon(input.planningID)
      case "guide":
        return {
          status: "guide",
          topic: input.topic,
          guidance: {
            draft: runbook("planning-draft"),
            show: runbook("planning-show"),
            resolve: runbook("planning-resolve"),
            brainstorm: runbook("planning-brainstorm"),
          }[input.topic],
        }
      case "evidence":
        return this.evidence(input.planningID, input.draftID)
    }
  }

  private storeBody(
    input: Extract<PlanDraftInput, { action: "store" }>,
    caller: Caller,
    delivery: Delivery,
  ): PlanDraftResult {
    const { body } = input
    const validation = validateBody(body)
    let planningID = input.planningID
    if (planningID) {
      const row = this.owned(planningID)
      if (!row) return invalid("planningID", "no such plan in this project")
      if (row.state === "tasked" || row.state === "abandoned")
        return invalid("planningID", `plan is ${row.state}; start a new plan`)
      if (input.expectedRevision === undefined)
        return invalid("expectedRevision", "state the revision you edited from")
    } else {
      planningID = randomUUID()
      const decision = input.decisionMessageID
        ? this.store.decision(caller.sessionID, input.decisionMessageID)
        : undefined
      this.store.createPlanning({
        id: planningID,
        projectKey: this.projectID,
        projectDirectory: this.directory,
        sessionId: caller.sessionID,
        decisionId: decision?.id ?? null,
        title: body.title,
        createdAt: this.now(),
        updatedAt: this.now(),
      })
    }
    const appended = this.store.appendRevision(
      planningID,
      input.planningID ? input.expectedRevision : undefined,
      body,
      validation,
      fieldHashes(body),
      caller.sessionID,
      this.now(),
    )
    if ("conflict" in appended) return { status: "conflict", currentRevision: appended.conflict }
    const row = this.store.planning(planningID)!
    if (row.title !== body.title) this.store.setTitle(planningID, body.title)
    // An edit after the plan was ready returns it to drafted; elsewhere a revision is a self transition.
    if (row.state === "ready") this.store.move(planningID, "drafted", this.now())
    if (input.architectPick && row.decisionId)
      this.store.setArchitectPick(row.decisionId, input.architectPick)
    return this.stored(planningID, body, appended.revision, delivery)
  }

  private finalize(
    input: Extract<PlanDraftInput, { action: "finalize" }>,
    caller: Caller,
    delivery: Delivery,
  ): PlanDraftResult {
    const row = this.owned(input.planningID)
    if (!row) return invalid("planningID", "no such plan in this project")
    if (row.state !== "final-review")
      return invalid("planningID", `plan is ${row.state}; finalize follows the final review`)
    let revision = row.revision
    const body = input.body
    if (body) {
      const appended = this.store.appendRevision(
        row.id,
        row.revision,
        body,
        validateBody(body),
        fieldHashes(body),
        caller.sessionID,
        this.now(),
      )
      if ("conflict" in appended) return { status: "conflict", currentRevision: appended.conflict }
      revision = appended.revision
    }
    this.store.move(row.id, "ready", this.now())
    const stored = JSON.parse(this.store.revision(row.id, revision)!.body) as PlanningBody
    const result = this.stored(row.id, PlanningBody.parse(stored), revision, delivery)
    if (result.status !== "stored") return result
    // Informational, never a gate: tasking follows unless the owner says stop.
    return {
      ...result,
      breakdown: `${result.breakdown}\nFinal r${revision} — tasking next. Reply "stop" to keep it open.`,
      open: this.openCount(row.id),
    }
  }

  /** Findings still open plus questions not yet answered or merged. */
  private openCount(planningID: string): number {
    return (
      this.store.findings(planningID).filter((f) => f.resolution === "open").length +
      this.store.questions(planningID).filter((q) => q.route === "open" || q.route === "owner")
        .length
    )
  }

  private abandon(planningID: string): PlanDraftResult {
    const row = this.owned(planningID)
    if (!row) return invalid("planningID", "no such plan in this project")
    if (row.state === "tasked" || row.state === "abandoned")
      return invalid("planningID", `plan is already ${row.state}`)
    this.store.move(planningID, "abandoned", this.now())
    this.cancelReviews?.(planningID, "plan abandoned")
    return { status: "abandoned", planningID }
  }

  /** Owner answers and resolved findings about one draft, as evidence a task review may cite. */
  private evidence(planningID: string, draftID: string): PlanDraftResult {
    if (!this.owned(planningID)) return invalid("planningID", "no such plan in this project")
    const findings = this.store.findings(planningID).filter((f) => f.draftId === draftID)
    const lines: string[] = []
    for (const finding of findings)
      if (finding.resolution && finding.resolution !== "open")
        lines.push(
          `Planning ${finding.source} on ${finding.field ?? "plan"}: ${text(finding.body)} — resolved ${finding.resolution}: ${text(finding.resolutionJson) || "no note"}`,
        )
    for (const question of this.store.questions(planningID)) {
      const finding = findings.find((f) => f.id === question.findingId)
      if (!finding || question.route !== "owner-answered" || !question.answer) continue
      lines.push(
        `Planning ${question.source} on ${finding.field ?? "plan"}: ${text(question.body)} — resolved owner-answered: ${question.answer}`,
      )
    }
    return {
      status: "evidence",
      evidence: lines.slice(0, MAX_EVIDENCE).map((line) => line.slice(0, MAX_EVIDENCE_CHARS)),
    }
  }
}

/** Registers `lz-plan-draft`. Permission `lz-plan-draft` is the Architect's alone (workers deny it in `roles.ts`). */
export function registerPlanningTools(
  ctx: Pick<Plugin.Context, "tool" | "permission" | "location">,
  drafts: PlanDrafts,
) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-plan-draft",
      description:
        'Store a plan as complete task drafts, revise it, finalize it or abandon it. A draft is exactly what lz-submit-task takes (minus idempotencyKey) plus draftID and dependsOn. action "store" without planningID starts a plan; with planningID and expectedRevision it adds a revision and never overwrites a newer one. The result carries the breakdown and link to show the owner verbatim, the validation (incomplete drafts are stored anyway) and the checks left to tasking. "evidence" returns the owner answers and resolved findings about one draft, for a task review. "guide" returns a runbook.',
      input: PlanDraftInput,
      output: z.record(z.string(), z.unknown()),
      options: { codemode: true, permission: "lz-plan-draft" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-plan-draft",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.try({
                try: () => {
                  const delivery = new Delivery(call.sessionID)
                  const output = drafts.call(input, { sessionID: call.sessionID }, delivery)
                  delivery.commit()
                  return { content: JSON.stringify(output), output: output as never }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
  })
}

/** The one agent of the final pass (the owner's decision). */
const FINAL_PASS_AGENT: AgentID = "readiness"

const PlanReviewInput = z.strictObject({
  planningID: z.uuid(),
  stage: z.enum(["review", "final"]).default("review"),
  agents: z
    .array(PlanningAgentId)
    .optional()
    .describe(
      "Agents to run in addition to the default; the only agents when automatic dispatch is off.",
    ),
})
export type PlanReviewInput = z.infer<typeof PlanReviewInput>

export type PlanReviewResult =
  | (ReviewResult & { note?: string })
  | { status: "needs-agents"; scores?: Record<string, number>; reason: string }
  | { status: "invalid"; errors: { path: string; message: string }[] }

/**
 * `lz-plan-review`: runs the planning agents on the stored plan in fresh context and returns
 * when every one has an outcome. All five run by default (the owner's decision); the per-project
 * switch turns the default off, and then the Architect names the agents.
 */
export class PlanReviewer {
  constructor(
    private readonly store: PlanningStore,
    private readonly reviews: PlanningReviews,
    private readonly projectID: string,
    private readonly autoDispatch: () => boolean,
    private readonly directory: string,
  ) {}

  /** Who runs, and why each runs. */
  selection(planningID: string, requested: readonly AgentID[] = []): AgentSelection[] | string {
    const planning = this.store.planning(planningID)!
    if (!this.autoDispatch())
      return requested.length
        ? AGENT_ORDER.filter((agent) => requested.includes(agent)).map((agent) => ({
            agent,
            source: "architect" as const,
          }))
        : "automatic planning agents are off for this project"
    const decision = planning.decisionId ? this.store.decisionByID(planning.decisionId) : undefined
    const chosen: AgentID[] =
      decision?.status === "decided" && decision.selectedJson
        ? (JSON.parse(decision.selectedJson) as AgentID[])
        : [...AGENT_ORDER]
    const body = PlanningBody.parse(
      JSON.parse(this.store.revision(planningID, planning.revision)!.body),
    )
    const rules = rulesAdd(body)
    return AGENT_ORDER.flatMap((agent): AgentSelection[] => {
      if (chosen.includes(agent))
        return [{ agent, source: decision?.status === "decided" ? "decision" : "all" }]
      const rule = rules.find((entry) => entry.agent === agent)
      if (rule) return [{ agent, source: `rule:${rule.ruleID}` as AgentSelection["source"] }]
      return requested.includes(agent) ? [{ agent, source: "architect" }] : []
    })
  }

  /** One agent, Readiness, on the current revision, after the owner's answers. */
  private async final(
    planningID: string,
    caller: { sessionID: string },
    signal: AbortSignal | undefined,
    delivery: Delivery,
    input: PlanReviewInput,
  ): Promise<PlanReviewResult> {
    const planning = this.store.planning(planningID)!
    if (!["questions-open", "final-review"].includes(planning.state))
      return invalid(
        "planningID",
        `plan is ${planning.state}; the final pass follows the review`,
      ) as PlanReviewResult
    const review = await this.reviews.start({
      planningID,
      stage: "final",
      agents: [{ agent: FINAL_PASS_AGENT, source: "final" }],
      parentSessionID: caller.sessionID,
      directory: this.directory,
    })
    const result = await this.reviews.run(review.id, signal)
    return {
      ...result,
      runbook: delivery.once("planning-resolve"),
      ...(input.agents?.length
        ? { note: "agents is ignored for the final pass; only Readiness ran" }
        : {}),
    }
  }

  async call(
    input: PlanReviewInput,
    caller: { sessionID: string },
    signal?: AbortSignal,
    delivery = new Delivery(caller.sessionID),
  ): Promise<PlanReviewResult> {
    const planning = this.store.planning(input.planningID)
    if (!planning || planning.projectKey !== this.projectID)
      return invalid("planningID", "no such plan in this project") as PlanReviewResult
    if (input.stage === "final") return this.final(planning.id, caller, signal, delivery, input)
    if (!["drafted", "questions-open", "in-review"].includes(planning.state))
      return invalid(
        "planningID",
        `plan is ${planning.state}; it cannot be reviewed`,
      ) as PlanReviewResult
    const selected = this.selection(planning.id, input.agents)
    if (typeof selected === "string") {
      const decision = planning.decisionId
        ? this.store.decisionByID(planning.decisionId)
        : undefined
      const scores = decision?.scoresJson
        ? Object.fromEntries(
            Object.entries(
              JSON.parse(decision.scoresJson) as Record<string, { score: number }>,
            ).map(([agent, value]) => [agent, value.score]),
          )
        : undefined
      return { status: "needs-agents", ...(scores ? { scores } : {}), reason: selected }
    }
    const review = await this.reviews.start({
      planningID: planning.id,
      stage: "review",
      agents: selected,
      parentSessionID: caller.sessionID,
      directory: this.directory,
    })
    const result = await this.reviews.run(review.id, signal)
    const runbookText = delivery.once("planning-resolve")
    return { ...result, runbook: runbookText }
  }
}

/** Registers `lz-plan-review`; its permission is the Architect's alone. */
export function registerPlanReviewTool(
  ctx: Pick<Plugin.Context, "tool" | "permission" | "location">,
  reviewer: PlanReviewer,
) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-plan-review",
      description:
        "Run the planning agents on a stored plan, each in a fresh context, and return when every one has finished. All five run by default; if automatic planning agents are off for the project, name them in agents. The result lists each agent's status (a failed agent is retried once, then shown as not run), the findings and questions with the revision they reviewed, and the breakdown to show the owner. Then resolve them with lz-plan-resolve.",
      input: PlanReviewInput,
      output: z.record(z.string(), z.unknown()),
      options: { codemode: true, permission: "lz-plan-review" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-plan-review",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async (signal) => {
                  const delivery = new Delivery(call.sessionID)
                  const output = await reviewer.call(
                    input,
                    { sessionID: call.sessionID },
                    signal,
                    delivery,
                  )
                  delivery.commit()
                  return { content: JSON.stringify(output), output: output as never }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
  })
}

export const ResolveInput = z.strictObject({
  planningID: z.uuid(),
  findings: z
    .array(
      z.discriminatedUnion("outcome", [
        z.strictObject({
          findingID: z.string(),
          outcome: z.literal("revised"),
          revision: z.int().positive(),
        }),
        z.strictObject({
          findingID: z.string(),
          outcome: z.literal("contested"),
          evidence: z.array(z.string().min(1)).min(1).max(10),
        }),
        z.strictObject({ findingID: z.string(), outcome: z.literal("to-owner") }),
      ]),
    )
    .max(500)
    .default([]),
  questions: z
    .array(
      z.discriminatedUnion("route", [
        z.strictObject({
          questionID: z.string(),
          route: z.literal("conversation"),
          answer: z.string().min(1),
          citation: z.strictObject({ messageID: z.string(), quote: z.string().min(8).max(2000) }),
        }),
        z.strictObject({ questionID: z.string(), route: z.literal("owner") }),
        z.strictObject({ questionID: z.string(), route: z.literal("merged"), into: z.string() }),
        z.strictObject({
          questionID: z.string(),
          route: z.literal("owner-answered"),
          answer: z.string().min(1),
          messageID: z.string(),
        }),
      ]),
    )
    .max(500)
    .default([]),
})
export type ResolveInput = z.infer<typeof ResolveInput>

export type ResolveResult = {
  applied: number
  refused: { id: string; reason: string }[]
  /** The questions for the owner as one numbered list, to ask in one native question form. */
  ownerBatch: string
  openCount: number
  suggestedMerges: string[][]
}

const WEIGHT_ORDER = ["changes-design", "changes-scope", "changes-detail"]
const SEVERITY_ORDER = ["blocker", "major", "minor", "nit"]
const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim()

const questionText = (question: QuestionRow) => {
  try {
    const value = (JSON.parse(question.body) as { question?: unknown }).question
    return typeof value === "string" ? value : question.body
  } catch {
    return question.body
  }
}
const questionOptions = (question: QuestionRow): string[] => {
  try {
    const options = (JSON.parse(question.body) as { options?: unknown }).options
    return Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : []
  } catch {
    return []
  }
}

/**
 * `lz-plan-resolve`: the Architect records what it did with each finding and question. A question
 * is answered by the Architect only on a verbatim citation of this conversation; every other
 * question goes to the owner in one batch.
 */
export class PlanResolver {
  constructor(
    private readonly store: PlanningStore,
    private readonly projectID: string,
    /** The text of one message of the Architect's own session; undefined when there is none. */
    private readonly messageText: (
      sessionID: string,
      messageID: string,
    ) => Promise<string | undefined>,
    private readonly now: () => number = Date.now,
  ) {}

  async call(input: ResolveInput, caller: { sessionID: string }): Promise<ResolveResult> {
    const planning = this.store.planning(input.planningID)
    const refused: ResolveResult["refused"] = []
    if (!planning || planning.projectKey !== this.projectID)
      return {
        applied: 0,
        refused: [{ id: input.planningID, reason: "no such plan in this project" }],
        ownerBatch: "",
        openCount: 0,
        suggestedMerges: [],
      }
    if (planning.state === "tasked" || planning.state === "abandoned")
      return {
        applied: 0,
        refused: [{ id: input.planningID, reason: `plan is ${planning.state}` }],
        ownerBatch: "",
        openCount: 0,
        suggestedMerges: [],
      }
    let applied = 0
    const hashes = new Map<number, ReturnType<typeof JSON.parse>>()
    const hashesAt = (n: number) => {
      if (!hashes.has(n)) {
        const at = this.store.revision(planning.id, n)
        hashes.set(n, at ? JSON.parse(at.fieldHashes) : {})
      }
      return hashes.get(n)!
    }
    const findings = () => this.store.findings(planning.id)
    const questions = () => this.store.questions(planning.id)

    for (const item of input.findings) {
      const finding = findings().find((f) => f.id === item.findingID)
      if (!finding) {
        refused.push({ id: item.findingID, reason: "unknown finding" })
        continue
      }
      if (item.outcome === "revised") {
        if (item.revision <= finding.revision || item.revision > planning.revision) {
          refused.push({
            id: finding.id,
            reason: `revision must be between r${finding.revision + 1} and r${planning.revision}`,
          })
          continue
        }
        const changed = isStale(
          {
            draftID: finding.draftId ?? null,
            field: (finding.field ?? "other") as TargetField,
            revision: finding.revision,
          },
          hashesAt,
          item.revision,
        )
        if (!changed) {
          refused.push({ id: finding.id, reason: `field unchanged since r${finding.revision}` })
          continue
        }
        this.store.updateFinding(finding.id, {
          resolution: "revised",
          resolutionJson: JSON.stringify({ revision: item.revision }),
          resolvedRevision: item.revision,
        })
      } else if (item.outcome === "contested")
        this.store.updateFinding(finding.id, {
          resolution: "contested",
          resolutionJson: JSON.stringify({ evidence: item.evidence }),
        })
      else this.store.updateFinding(finding.id, { resolution: "to-owner" })
      applied++
    }

    for (const item of input.questions) {
      const question = questions().find((q) => q.id === item.questionID)
      if (!question) {
        refused.push({ id: item.questionID, reason: "unknown question" })
        continue
      }
      const answered = (answer: string, citation: object) => {
        this.store.updateQuestion(question.id, {
          route: item.route as "conversation" | "owner-answered",
          answer,
          citationJson: JSON.stringify(citation),
          answeredAt: this.now(),
        })
        const finding = findings().find((f) => f.id === question.findingId)
        if (finding && (finding.resolution === "open" || finding.resolution === "to-owner"))
          this.store.updateFinding(finding.id, { resolution: "answered" })
      }
      if (item.route === "conversation") {
        const message = await this.messageText(caller.sessionID, item.citation.messageID)
        if (!message?.includes(item.citation.quote)) {
          refused.push({
            id: question.id,
            reason: `citation not found in ${item.citation.messageID}`,
          })
          continue
        }
        answered(item.answer, item.citation)
      } else if (item.route === "owner-answered")
        answered(item.answer, { messageID: item.messageID })
      else if (item.route === "owner") this.store.updateQuestion(question.id, { route: "owner" })
      else {
        const target = questions().find((q) => q.id === item.into)
        if (!target || target.id === question.id) {
          refused.push({ id: question.id, reason: "unknown merge target" })
          continue
        }
        if (!this.mergeable(question, target)) {
          refused.push({ id: question.id, reason: "the questions are about different fields" })
          continue
        }
        this.store.updateQuestion(question.id, { route: "merged", mergedInto: target.id })
      }
      applied++
    }

    const open = questions().filter((q) => q.route === "open" || q.route === "owner")
    return {
      applied,
      refused,
      ownerBatch: this.ownerBatch(planning.id),
      openCount: open.length + findings().filter((f) => f.resolution === "open").length,
      suggestedMerges: this.suggestedMerges(planning.id),
    }
  }

  private unit(question: QuestionRow) {
    const finding = this.store
      .findings(question.planningId)
      .find((f) => f.id === question.findingId)
    return { draftID: finding?.draftId ?? null, field: finding?.field ?? null, finding }
  }

  private mergeable(a: QuestionRow, b: QuestionRow): boolean {
    const x = this.unit(a)
    const y = this.unit(b)
    if (x.field && x.field === y.field && x.draftID === y.draftID) return true
    return normalized(questionText(a)) === normalized(questionText(b))
  }

  private suggestedMerges(planningID: string): string[][] {
    const open = this.store
      .questions(planningID)
      .filter((q) => q.route === "open" || q.route === "owner")
    const groups = new Map<string, string[]>()
    for (const question of open) {
      const { draftID, field } = this.unit(question)
      for (const key of [
        ...(field ? [`unit:${draftID}.${field}`] : []),
        `text:${normalized(questionText(question))}`,
      ])
        groups.set(key, [...(groups.get(key) ?? []), question.id])
    }
    const seen = new Set<string>()
    return [...groups.values()].filter((ids) => {
      if (ids.length < 2) return false
      const key = [...ids].sort().join("|")
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private ownerBatch(planningID: string): string {
    const owner = this.store.questions(planningID).filter((q) => q.route === "owner")
    const rank = (list: string[], value: string | null | undefined) => {
      const index = list.indexOf(value ?? "")
      return index === -1 ? list.length : index
    }
    return owner
      .map((question) => ({ question, ...this.unit(question) }))
      .sort(
        (a, b) =>
          rank(WEIGHT_ORDER, a.question.weight) - rank(WEIGHT_ORDER, b.question.weight) ||
          rank(SEVERITY_ORDER, a.finding?.severity) - rank(SEVERITY_ORDER, b.finding?.severity) ||
          AGENT_ORDER.indexOf(a.question.source as AgentID) -
            AGENT_ORDER.indexOf(b.question.source as AgentID),
      )
      .map(({ question, draftID, field }, index) => {
        const options = questionOptions(question)
        return `${index + 1}. ${questionText(question)}${options.length ? ` (${options.join(" / ")})` : ""} — ${question.source}, ${
          field ? `${draftID ?? "plan"}.${field}` : (draftID ?? "plan")
        }`
      })
      .join("\n")
  }
}

export function registerPlanResolveTool(
  ctx: Pick<Plugin.Context, "tool" | "permission" | "location">,
  resolver: PlanResolver,
) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-plan-resolve",
      description:
        "Record what you did with a plan review's findings and questions. A finding is revised (give the revision that fixes it; refused if its field did not change), contested (give evidence a reviewer could read) or passed to the owner. A question is answered by you only with a verbatim quote of this conversation and its message id; merged into one about the same field; or sent to the owner. The result lists refusals, the owner's questions as one numbered batch to ask in a single question form, and how many items stay open.",
      input: ResolveInput,
      output: z.record(z.string(), z.unknown()),
      options: { codemode: true, permission: "lz-plan-resolve" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-plan-resolve",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const output = await resolver.call(input, { sessionID: call.sessionID })
                  return { content: JSON.stringify(output), output: output as never }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
  })
}

/** Registers `lz-plan-task`: "just task it" from any open state, and normal tasking after the final pass. */
export function registerPlanTaskTool(
  ctx: Pick<Plugin.Context, "tool" | "permission" | "location">,
  tasker: PlanTasker,
) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-plan-task",
      description:
        'Task a stored plan exactly as stored: each draft goes through the same path as lz-submit-task, then the plan through lz-submit-plan. It works from every open state, so "just task it" needs no review. Every check runs before anything is written; a failing draft is listed and nothing is saved. Open reviews are cancelled. A repeat call returns the same tasks. The result maps each draft to its task and lists the fields changed after the last review. Run lz-verify-task on each draft first, with evidence from lz-plan-draft action "evidence", and pass the review ids in selfReviews.',
      input: PlanTaskInput,
      output: z.record(z.string(), z.unknown()),
      options: { codemode: true, permission: "lz-plan-task" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-plan-task",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const output = await tasker.call(input, { sessionID: call.sessionID })
                  return { content: JSON.stringify(output), output: output as never }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
  })
}
