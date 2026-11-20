import type { FindingSeverity } from "./contract.ts"
import type { PlanningBody, Validation } from "./draft.ts"
import { planMarkdownLink } from "./links.ts"

export type ReviewSummary = {
  agents: number
  notRun: number
  findings: Record<FindingSeverity, number>
  ownerQuestions: number
  tokens: number
  costUSD?: number
}

const OBJECTIVE_MAX = 100

/** The first sentence of the objective, at most 100 characters, `…` when cut. */
function firstSentence(proposal: unknown): string {
  const objective =
    proposal !== null && typeof proposal === "object"
      ? (proposal as { objective?: unknown }).objective
      : undefined
  if (typeof objective !== "string" || !objective.trim()) return "(no objective yet)"
  const text = objective.trim().replace(/\s+/g, " ")
  const sentence = text.split(/(?<=[.!?])\s/u)[0]!
  return sentence.length > OBJECTIVE_MAX ? `${sentence.slice(0, OBJECTIVE_MAX - 1)}…` : sentence
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
