import type { PlanningBody, Validation } from "./draft.ts"
import { firstSentence } from "./sentence.ts"

import type { PlanningState } from "../runner/lifecycle-machines.ts"

/** What the plan view shows. Plain data, safe to cross the RPC boundary and the GUI bundle. */
export type ViewFinding = {
  id: string
  source: string
  revision: number
  draftId: string | null
  field: string | null
  severity: string | null
  confidence: string | null
  what: string
  resolution: string
  stale: boolean
}
export type ViewQuestion = {
  id: string
  source: string
  revision: number
  question: string
  route: string
  answer: string | null
}
export type ViewAgent = {
  agent: string
  status: "running" | "stuck" | "reviewed" | "not-run"
  attempts: number
  tokens: number
  durationMs: number
  reason?: string
}
export type ViewReview = {
  id: string
  stage: "review" | "final"
  revision: number
  agents: ViewAgent[]
  costUSD?: number
}
export type PlanningView = {
  id: string
  title: string
  state: PlanningState
  /** The latest revision. */
  revision: number
  /** The revision `body` is from. */
  shownRevision: number
  body: PlanningBody
  validation: Validation
  breakdown: string
  findings: ViewFinding[]
  questions: ViewQuestion[]
  reviews: ViewReview[]
  tasked?: { draftID: string; reference: string | null; changedFields: string[] }[]
}

export type Row = { text: string; tone?: "warn" | "muted" }
export type Section = { id: string; title: string; rows: Row[] }

const duration = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`

/** The sections the plan panel renders, top to bottom. Empty sections are left out. */
export function planningViewModel(view: PlanningView): Section[] {
  const sections: Section[] = []
  const incomplete = new Set([
    ...Object.keys(view.validation.drafts),
    ...view.validation.graph.map((problem) => problem.draftID),
  ])
  const taskedBy = new Map((view.tasked ?? []).map((entry) => [entry.draftID, entry]))
  const latest = view.shownRevision === view.revision ? "" : `, latest r${view.revision}`
  sections.push({
    id: "tasks",
    title: `Tasks (r${view.shownRevision}${latest})`,
    rows: view.body.tasks.flatMap((task, index): Row[] => {
      const done = taskedBy.get(task.draftID)
      const head = [
        `${index + 1}. ${task.draftID} — ${firstSentence(task.proposal)}`,
        ...(task.dependsOn.length ? [`after ${task.dependsOn.join(", ")}`] : []),
        ...(incomplete.has(task.draftID) ? ["incomplete"] : []),
        ...(done?.reference ? [done.reference] : []),
      ].join(" · ")
      return [
        { text: head, ...(incomplete.has(task.draftID) ? { tone: "warn" as const } : {}) },
        ...(view.validation.drafts[task.draftID] ?? []).map((problem) => ({
          text: `${problem.path}: ${problem.message}`,
          tone: "muted" as const,
        })),
        ...(done?.changedFields.length
          ? [
              {
                text: `changed after review: ${done.changedFields.join(", ")}`,
                tone: "warn" as const,
              },
            ]
          : []),
      ]
    }),
  })
  const open = view.body.openDecisions.filter((decision) => decision.answer === undefined)
  if (open.length)
    sections.push({
      id: "decisions",
      title: "Open decisions",
      rows: open.map((d) => ({
        text: `${d.id} ${d.question}${d.options ? ` (${d.options.join(" / ")})` : ""}`,
      })),
    })
  if (view.findings.length)
    sections.push({
      id: "findings",
      title: "Findings",
      rows: view.findings.map((f) => ({
        text: `${f.source} · ${f.severity ?? "?"} · ${f.draftId ?? "plan"}${f.field ? ` ${f.field}` : ""}: ${f.what}${
          f.stale ? ` — stale (r${f.revision})` : ""
        }${f.resolution === "open" ? "" : ` — ${f.resolution}`}`,
        ...(f.stale ? { tone: "muted" as const } : {}),
      })),
    })
  if (view.questions.length)
    sections.push({
      id: "questions",
      title: "Questions",
      rows: view.questions.map((q) => ({
        text: `${q.source}: ${q.question} — ${q.route}${q.answer ? `: ${q.answer}` : ""}`,
      })),
    })
  for (const review of view.reviews) {
    const rows: Row[] = review.agents.map((agent) => ({
      text: `${agent.agent}: ${agent.status === "stuck" ? "stuck, retrying" : agent.status} · ${
        agent.attempts
      } ${agent.attempts === 1 ? "attempt" : "attempts"} · ${agent.tokens.toLocaleString(
        "en-US",
      )} tokens · ${duration(agent.durationMs)}${agent.reason ? ` · ${agent.reason}` : ""}`,
      ...(agent.status === "stuck" || agent.status === "not-run" ? { tone: "warn" as const } : {}),
    }))
    if (review.costUSD !== undefined) rows.push({ text: `Cost: $${review.costUSD.toFixed(2)}` })
    sections.push({
      id: `review-${review.id}`,
      title: `${review.stage === "final" ? "Final pass" : "Review"} of r${review.revision}`,
      rows,
    })
  }
  return sections.filter((section) => section.rows.length)
}
