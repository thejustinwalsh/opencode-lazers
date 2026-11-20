import type { FindingSeverity } from "./contract.ts"
import type { PlanningBody, Validation } from "./draft.ts"
import { AGENT_ORDER, SIZE_CHOICES, SIZE_CRITERIA, useWhen } from "./decision/tree.ts"
import { planMarkdownLink } from "./links.ts"
import { firstSentence } from "./sentence.ts"
import type { DecisionRow } from "./store.ts"

export type ReviewSummary = {
  agents: number
  notRun: number
  findings: Record<FindingSeverity, number>
  ownerQuestions: number
  tokens: number
  costUSD?: number
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

function reviewLine(revision: number, review: ReviewSummary): string {
  const total = Object.values(review.findings).reduce((sum, n) => sum + n, 0)
  const serious = [
    review.findings.blocker ? `${review.findings.blocker} blocker` : "",
    review.findings.major ? `${review.findings.major} major` : "",
  ].filter(Boolean)
  return [
    `Review r${revision}: ${count(review.agents, "agent")}${review.notRun ? ` (${review.notRun} not run)` : ""}`,
    `${count(total, "finding")}${serious.length ? ` (${serious.join(", ")})` : ""}`,
    `${count(review.ownerQuestions, "question")} for you`,
    `${review.tokens.toLocaleString("en-US")} tokens`,
    ...(review.costUSD === undefined ? [] : [`$${review.costUSD.toFixed(2)}`]),
  ].join(" · ")
}

/** The terse chat message: tasks with dependencies, open decisions, then the link. */
export function renderBreakdown(input: {
  body: PlanningBody
  revision: number
  validation: Validation
  planningID: string
  projectID: string
  review?: ReviewSummary
}): string {
  const { body, revision, validation } = input
  const incomplete = new Set([
    ...Object.entries(validation.drafts)
      .filter(([, list]) => list.length)
      .map(([id]) => id),
    ...validation.graph.map((problem) => problem.draftID),
  ])
  const tasks = [
    `**${body.title}** · r${revision}`,
    ...body.tasks.map(
      (task, index) =>
        `${index + 1}. ${task.draftID} — ${firstSentence(task.proposal)}` +
        (task.dependsOn.length ? ` · after ${task.dependsOn.join(", ")}` : "") +
        (incomplete.has(task.draftID) ? " · incomplete" : ""),
    ),
  ]
  const open = body.openDecisions.filter((decision) => decision.answer === undefined)
  const decisions = open.length
    ? [
        "Open decisions",
        ...open.map(
          (decision) =>
            `- ${decision.id} ${decision.question}` +
            (decision.options ? ` (${decision.options.join(" / ")})` : ""),
        ),
      ]
    : []
  const tail = [
    ...(input.review ? [reviewLine(revision, input.review)] : []),
    planMarkdownLink(input.planningID, input.projectID),
    'Reply LGTM to continue, a change to revise, or "just task it" to skip the agents.',
  ]
  return [tasks, decisions, tail]
    .filter((block) => block.length)
    .map((block) => block.join("\n"))
    .join("\n\n")
}

const fenced = (value: unknown) => `\`\`\`json\n${JSON.stringify(value, null, 2) ?? "null"}\n\`\`\``

/** The full plan the agents read; its headings and draft ids are the units findings target. */
export function renderFullPlan(body: PlanningBody, revision: number): string {
  const sections = [
    `# ${body.title} (r${revision})`,
    `## Ask\n\n${body.ask}`,
    `## Assumptions\n\n${body.assumptions.length ? body.assumptions.map((a) => `- ${a}`).join("\n") : "None."}`,
    `## Open decisions\n\n${
      body.openDecisions.length
        ? body.openDecisions
            .map(
              (d) =>
                `- ${d.id} ${d.question}` +
                (d.options ? ` (${d.options.join(" / ")})` : "") +
                (d.answer === undefined ? "" : ` — answer: ${d.answer}`),
            )
            .join("\n")
        : "None."
    }`,
    `## Plan\n\n${fenced(body.plan)}`,
    ...body.tasks.map(
      (task) =>
        `## Task ${task.draftID}\n\n` +
        `dependsOn: ${task.dependsOn.length ? task.dependsOn.join(", ") : "none"}` +
        (task.persona ? `\npersona: ${task.persona}` : "") +
        `\n\n${fenced(task.proposal)}`,
    ),
  ]
  return `${sections.join("\n\n")}\n`
}

export type DecisionDelivery = {
  /** The planning runbook's text, on the first decided note of a session; its pointer afterwards. */
  runbook?: string
}

const score = (n: number) => n.toFixed(2)

/**
 * The one block delivered with the Architect's user message, in the model request only. Its
 * numbers are context, never routing: every planning agent runs on a stored plan. With no decision
 * model it carries the decision model's own questions, from the same definitions, so the
 * Architect classifies the ask itself and says so in one line.
 */
export function decisionNote(
  row: Pick<
    DecisionRow,
    "messageId" | "status" | "reason" | "size" | "scoresJson" | "threshold" | "deciderModel"
  >,
  openPlannings: readonly { title: string; state: string }[] = [],
  delivery: DecisionDelivery = {},
): string {
  const header = `[lz-planning decision m=${row.messageId}]`
  const open = openPlannings.length
    ? ` · open plans: ${openPlannings.map((plan) => `${plan.title} (${plan.state})`).join(", ")}`
    : ""
  if (row.status === "unavailable") {
    return [
      `${header} decision model not run (${row.reason ?? "unavailable"})${open}`,
      'Before planning, answer these yourself and state your picks in one line ("size: <choice> · agents: <ids>"), and pass them as `architectPick` when you store the plan with `lz-plan-draft`. All five agents run on a stored plan; your picks are recorded as context.',
      `size, one of: ${SIZE_CHOICES.map((choice) => `${choice} (${SIZE_CRITERIA[choice]})`).join("; ")}`,
      "agents, use when:",
      ...AGENT_ORDER.map((id) => `- ${id}: ${useWhen(id)}`),
      ...(delivery.runbook ? [delivery.runbook] : []),
    ].join("\n")
  }
  const size = row.size ?? "unknown"
  if (size === "one task")
    return `${header} size: one task — no planning flow; ask one question first if the ask is unclear.${open}`
  const scores = row.scoresJson
    ? (JSON.parse(row.scoresJson) as Record<string, { score: number }>)
    : {}
  const listed = AGENT_ORDER.filter((id) => scores[id]).map(
    (id) => `${id} ${score(scores[id]!.score)}`,
  )
  return [
    `${header} size: ${size}${listed.length ? ` · agent scores: ${listed.join(", ")}` : ""}${open}`,
    `All five planning agents run on a stored plan; the scores are context (threshold ${row.threshold ?? 0}, hand-picked; cuts none).`,
    ...(delivery.runbook ? [delivery.runbook] : []),
  ].join("\n")
}
