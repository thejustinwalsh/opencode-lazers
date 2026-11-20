import { expect, test } from "bun:test"
import { PlanningBody, validateBody, type Validation } from "./draft.ts"
import { planMarkdownLink } from "./links.ts"
import { decisionNote, renderBreakdown, renderFullPlan } from "./render.ts"
import { OBSERVATIONS } from "./decision/observations.ts"
import { AGENT_ORDER, SIZE_CHOICES, useWhen } from "./decision/tree.ts"

const planningID = "0b4e2c1a-0000-4000-8000-000000000001"
const draft = (draftID: string, objective: string, dependsOn: string[] = []) => ({
  draftID,
  dependsOn,
  proposal: { objective },
})
const make = (decisions = true) =>
  PlanningBody.parse({
    title: "Planning flow",
    ask: "Plan the flow",
    plan: { objective: "Plan the flow" },
    openDecisions: decisions
      ? [
          {
            id: "D1",
            question: "Which slicer is the default?",
            options: ["whole", "pre-slice", "uncertainty"],
          },
        ]
      : [],
    tasks: [
      draft("store-schema", "Store plan drafts and their revisions. Keep every revision."),
      draft("breakdown", "Render the chat breakdown from the stored plan.", ["store-schema"]),
      draft("plan-link", "Open a stored plan from a chat link.", ["store-schema", "breakdown"]),
    ],
  })
const validation: Validation = {
  drafts: { "plan-link": [{ path: "acceptance", message: "Required" }] },
  plan: [],
  graph: [],
}
const input = (over = {}) => ({
  body: make(),
  revision: 3,
  validation,
  planningID,
  projectID: "proj",
  ...over,
})
const link = "[Full plan](.lazers/plans/70726f6a/0b4e2c1a-0000-4000-8000-000000000001)"
const reply = 'Reply LGTM to continue, a change to revise, or "just task it" to skip the agents.'

test("the breakdown is the exact terse message", () => {
  expect(renderBreakdown(input())).toBe(
    [
      "**Planning flow** · r3",
      "1. store-schema — Store plan drafts and their revisions.",
      "2. breakdown — Render the chat breakdown from the stored plan. · after store-schema",
      "3. plan-link — Open a stored plan from a chat link. · after store-schema, breakdown · incomplete",
      "",
      "Open decisions",
      "- D1 Which slicer is the default? (whole / pre-slice / uncertainty)",
      "",
      link,
      reply,
    ].join("\n"),
  )
  expect(planMarkdownLink(planningID, "proj")).toBe(link)
})

test("a review adds one line before the link, and a missing price drops the dollars", () => {
  const review = {
    agents: 5,
    notRun: 1,
    findings: { blocker: 1, major: 4, minor: 2, nit: 0 },
    ownerQuestions: 3,
    tokens: 412000,
    costUSD: 0.83,
  }
  const line =
    "Review r3: 5 agents (1 not run) · 7 findings (1 blocker, 4 major) · 3 questions for you · 412,000 tokens · $0.83"
  const text = renderBreakdown(input({ review }))
  expect(text).toContain(`\n\n${line}\n${link}\n`)
  expect(renderBreakdown(input({ review: { ...review, costUSD: undefined } }))).toContain(
    "412,000 tokens\n",
  )
})

test("with no open decisions the section is omitted", () => {
  const text = renderBreakdown(input({ body: make(false) }))
  expect(text).not.toContain("Open decisions")
  expect(text).toContain(`incomplete\n\n${link}`)
})

test("a cut objective ends with an ellipsis within 100 characters", () => {
  const body = PlanningBody.parse({
    title: "t",
    ask: "a",
    plan: { objective: "o" },
    tasks: [draft("long", "word ".repeat(40).trim())],
  })
  const task = renderBreakdown(input({ body, validation: validateBody(body) })).split("\n")[1]!
  expect(task.startsWith("1. long — ")).toBe(true)
  const objective = task.slice("1. long — ".length).split(" · ")[0]!
  expect(objective.length).toBe(100)
  expect(objective.endsWith("…")).toBe(true)
})

test("the full plan has a section per task draft", () => {
  const text = renderFullPlan(make(), 3)
  expect(text).toContain("# Planning flow (r3)")
  expect(text).toContain("## Task plan-link")
  expect(text).toContain("dependsOn: store-schema, breakdown")
})

const row = (over: Record<string, unknown> = {}) =>
  ({
    messageId: "m1",
    status: "decided",
    size: "a few tasks",
    observationsJson: JSON.stringify({
      names_code: { score: 0.91, nodeID: "0" },
      open_choice: { score: 0.52, nodeID: "1" },
      stored_data: { score: 0.12, nodeID: "0" },
    }),
    scoresJson: JSON.stringify({
      comprehension: { score: 0.1, band: "no" },
      grounding: { score: 0.91, band: "yes" },
      readiness: { score: 0.52, band: "architect" },
      critic: { score: 0.12, band: "no" },
      "zoom-out": { score: 0.2, band: "no" },
    }),
    threshold: 0,
    ...over,
  }) as never

test("a decided note states the observations in plain words and what each agent's rule made of them", () => {
  const note = decisionNote(row(), [{ title: "Plan view", state: "in-review" }])
  expect(note).toBe(
    [
      "[lz-planning decision m=m1] The decision model read the ask piece by piece · open plans: Plan view (in-review)",
      "It says: names existing code: yes 0.91 · leaves a behaviour choice open: unsure 0.52 · changes stored data: no 0.12",
      "Planning agents: comprehension no, grounding yes, readiness Architect decides, critic no, zoom-out no",
      "Size guess: a few tasks (unreliable, about 40% right; judge it yourself). All five planning agents run on a stored plan; this is context, not routing.",
    ].join("\n"),
  )
  expect(note).not.toContain("answer these")
})

test("a one-task guess is stated as a guess, never as a verdict", () => {
  expect(decisionNote(row({ size: "one task" }))).toContain(
    "Size guess: one task (unreliable, about 40% right; judge it yourself)",
  )
})

test("with the decision model not run the note gives the Architect the same observations as questions", () => {
  const note = decisionNote(row({ status: "unavailable", reason: "no-window", size: null }))
  expect(note).toContain("decision model not run (no-window)")
  expect(note).toContain("answer these about the ask yourself")
  expect(note).toContain("`architectPick`")
  for (const observation of OBSERVATIONS) expect(note).toContain(`- ${observation.phrase}?`)
  for (const choice of SIZE_CHOICES) expect(note).toContain(choice)
  for (const id of AGENT_ORDER) expect(note).toContain(`- ${id}: ${useWhen(id)}`)
})
