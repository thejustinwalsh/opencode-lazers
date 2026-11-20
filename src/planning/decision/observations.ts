import type { SystemOneQuestion } from "../../webgpu/system-one.ts"
import type { PlanningAgentId } from "../contract.ts"

/**
 * What the decision model is asked: small judgments about what a piece of text says, never which
 * reviewer would help. Each is one short positive yes/no with `true` and `false` criteria (the
 * criteria move an answer a long way) and one request each. Code decides what the answers mean.
 * The wording is the wording that was measured (`.agents/research/decision-spike.md`, "Second
 * run"), including the reworded `open_choice` and `wording_only`.
 */
export type Observation = {
  id: string
  /** The question as the model sees it. */
  question: string
  /** The criteria text for yes and for no. */
  yes: string
  no: string
  /** The observation in plain words, for the note: `<phrase>: yes 0.91`. */
  phrase: string
}

export const OBSERVATIONS: readonly Observation[] = [
  {
    id: "names_code",
    question: "The text names a specific file, function, table or command.",
    yes: "It gives a concrete name from a codebase, such as src/runner/retention.ts, getUserName, a table name or a CLI command.",
    no: "It talks about features in general terms and gives no concrete name.",
    phrase: "names existing code",
  },
  {
    id: "existing_behaviour",
    question: "The text describes behaviour that exists today.",
    yes: "It says what the software currently does or shows, such as 'the purge deletes rows in a loop'.",
    no: "It only says what should be built, with nothing about what happens now.",
    phrase: "describes how things work today",
  },
  {
    id: "open_choice",
    question: "The text leaves a default, format, limit or error case for the builder to decide.",
    yes: "It says what to build but not how an edge case, default, format or limit should behave, such as what happens on empty input.",
    no: "It states how every case it mentions should behave, or it names no behaviour at all.",
    phrase: "leaves a behaviour choice open",
  },
  {
    id: "states_check",
    question: "The text states how the result is checked.",
    yes: "It names a test, command, screenshot or condition that shows the work is done, such as 'the suite passes'.",
    no: "It does not say how to tell that the work is done.",
    phrase: "states how the result is checked",
  },
  {
    id: "multi_change",
    question: "The text describes more than one separate change.",
    yes: "It lists or implies two or more changes that could be built and reviewed on their own.",
    no: "It describes a single change.",
    phrase: "describes more than one change",
  },
  {
    id: "stored_data",
    question: "The text changes stored data, a schema or a migration.",
    yes: "It adds or alters a table, column, file format or saved setting, or rewrites existing records.",
    no: "Nothing saved in a database or on disk is changed.",
    phrase: "changes stored data",
  },
  {
    id: "symptom_only",
    question: "The text describes a symptom without its cause.",
    yes: "It reports what goes wrong, such as an error, NaN or a button that does nothing, but not why.",
    no: "It names the cause, or it reports no problem.",
    phrase: "reports a symptom without its cause",
  },
  {
    id: "may_exist",
    question: "The text asks for something that may already exist.",
    yes: "It asks for a general capability the project may already have, such as caching, remembering, retrying or logging.",
    no: "It asks for a specific new thing, or for a fix to named code.",
    phrase: "asks for something that may already exist",
  },
  {
    id: "depends_other",
    question: "The text depends on other work finishing first.",
    yes: "It says after, once or wait for, or refers to another task or plan that must land first.",
    no: "It can be done on its own.",
    phrase: "depends on other work",
  },
  {
    id: "undefined_term",
    question: "The text uses a term it does not define.",
    yes: "It uses a project-specific word, code name or abbreviation that a newcomer could not follow, such as 'Luna Max' or 'LZ-182'.",
    no: "Every term is plain or explained.",
    phrase: "uses a term it does not define",
  },
  {
    id: "user_visible",
    question: "The text changes what the user sees.",
    yes: "It changes a screen, panel, button, message or label.",
    no: "It changes only code, data or behaviour out of sight.",
    phrase: "changes what the user sees",
  },
  {
    id: "wording_only",
    question: "The change is only a typo, a rename or formatting.",
    yes: "Nothing but wording, a name or formatting changes, such as fixing 'recieve' or renaming a function.",
    no: "The work changes behaviour, adds a feature or fixes a bug.",
    phrase: "is only a typo, rename or formatting",
  },
  {
    id: "adds_new",
    question: "The text adds something new, such as a module, tool, setting or table.",
    yes: "It creates a new module, tool, setting, command, table or panel.",
    no: "It changes or fixes only what already exists.",
    phrase: "adds something new",
  },
]

export function observationQuestion(observation: Observation): SystemOneQuestion {
  return {
    type: "noul",
    instructions: observation.question,
    criteria: { true: observation.yes, false: observation.no },
  }
}

/** The one Score question, kept for the size record: levels are one change, two or three, four or more. */
export const BREADTH_LEVELS = [
  "One change.",
  "Two or three separate changes.",
  "Four or more separate changes.",
] as const
export function breadthQuestion(): SystemOneQuestion {
  return {
    type: "score",
    instructions: "How many separate changes does this text describe?",
    criteria: [...BREADTH_LEVELS],
  }
}
/** Expected changes in one piece from the level probabilities (one, two or three, four or more). */
export const CHANGES_PER_LEVEL = [1, 2.5, 5] as const

/** A yes at or above `YES_AT`, a no at or below `NO_AT`; between is the Architect's call. */
export const YES_AT = 0.7
export const NO_AT = 0.3
export type Band = "yes" | "architect" | "no"
export const bandOf = (score: number, yesAt = YES_AT, noAt = NO_AT): Band =>
  score >= yesAt ? "yes" : score <= noAt ? "no" : "architect"

/** `unsure` is the plain word the note uses for the middle band of one observation. */
export const observationWord = (band: Band) => (band === "architect" ? "unsure" : band)

/** At least this many pieces is itself a sign the text is long and may need an explanation. */
export const MANY_PIECES = 8

/**
 * Which observations feed which agent, as data. A rule's score is the largest of its observations
 * (fuzzy OR), each already the largest over the pieces. `user_visible` and `multi_change` feed no
 * agent; `wording_only` is recorded and read, but no rule is multiplied by it.
 */
export type AgentRule = {
  agent: PlanningAgentId
  from: readonly string[]
  /** The agent also scores 1 when the text has at least `MANY_PIECES` pieces. */
  manyPieces?: boolean
}
export const AGENT_RULES: readonly AgentRule[] = [
  { agent: "comprehension", from: ["undefined_term"], manyPieces: true },
  { agent: "grounding", from: ["names_code", "existing_behaviour"] },
  { agent: "readiness", from: ["states_check", "open_choice"] },
  { agent: "critic", from: ["stored_data", "depends_other"] },
  { agent: "zoom-out", from: ["adds_new", "symptom_only", "may_exist"] },
]

export function ruleScore(
  rule: AgentRule,
  observed: Record<string, number>,
  pieces: number,
): { score: number; from: string } {
  let best = { score: 0, from: rule.from[0]! }
  for (const id of rule.from) {
    const score = observed[id] ?? 0
    if (score > best.score) best = { score, from: id }
  }
  if (rule.manyPieces && pieces >= MANY_PIECES) best = { score: 1, from: "pieces" }
  return best
}

/** Size from code, only recorded: unreliable (about 40% exact on the labelled set); nothing routes on it. */
export function sizeFromChanges(sumChanges: number, pieces: number): 0 | 1 | 2 {
  const total = pieces > 1 ? sumChanges * 0.75 : sumChanges
  return total <= 1.75 ? 0 : total <= 4.5 ? 1 : 2
}
