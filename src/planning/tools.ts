import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Delivery, runbook } from "../guidance/index.ts"
import type { PlanningState } from "../runner/lifecycle-machines.ts"
import type { TaskRepository } from "../storage.ts"
import { PlanningAgentId } from "./contract.ts"
import {
  DEFERRED_TO_TASKING,
  DraftID,
  PlanningBody,
  fieldHashes,
  validateBody,
  type Validation,
} from "./draft.ts"
import { planMarkdownLink } from "./links.ts"
import { renderBreakdown } from "./render.ts"
import { PlanningStore } from "./store.ts"

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
        return input.topic === "show"
          ? { status: "guide", topic: "show", guidance: runbook("planning-show") }
          : {
              status: "guide",
              topic: input.topic,
              guidance: `The ${input.topic} runbook is not written yet; topic "show" is available.`,
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
    return this.stored(row.id, PlanningBody.parse(stored), revision, delivery)
  }

  private abandon(planningID: string): PlanDraftResult {
    const row = this.owned(planningID)
    if (!row) return invalid("planningID", "no such plan in this project")
    if (row.state === "tasked" || row.state === "abandoned")
      return invalid("planningID", `plan is already ${row.state}`)
    this.store.move(planningID, "abandoned", this.now())
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
