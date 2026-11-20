import type { SystemOneQuestion } from "../../webgpu/system-one.ts"
import type { PlanningAgentId } from "../contract.ts"
import { DEFAULT_CONSTANTS, stateLimit, type DecisionConstants } from "./constants.ts"
import {
  AGENT_RULES,
  CHANGES_PER_LEVEL,
  OBSERVATIONS,
  bandOf,
  breadthQuestion,
  observationQuestion,
  ruleScore,
  sizeFromChanges,
  type Band,
} from "./observations.ts"
import {
  fixedSlices,
  groupChildren,
  packToLimit,
  sentenceWindows,
  structuralChildren,
  type Slice,
} from "./slicers.ts"
import {
  AGENT_ORDER,
  FOLLOW_UPS,
  FOLLOW_UP_YES,
  SIZE_CHOICES,
  agentChoiceQuestion,
  agentQuestion,
  sizeQuestion,
  type FollowUp,
  type SizePick,
} from "./tree.ts"

export { SIZE_CHOICES, type SizePick } from "./tree.ts"

export type Answers = Record<
  string,
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number }
  | { type: "score"; probabilities: Record<string, number> }
>

export interface Decider {
  readonly id: "local" | "external"
  readonly model: string
  available(): { ok: true } | { ok: false; reason: "no-window" | "feature-off" | "no-model" }
  ask(
    state: string,
    questions: Record<string, SystemOneQuestion>,
    signal: AbortSignal,
  ): Promise<{ answers: Answers; inputTokens: number }>
}

export type NodeOutcome =
  | "confident"
  | "expanded"
  | "pruned"
  | "depth-stop"
  | "budget-stop"
  | "single-sentence"
  | "pre-sliced"
  | "skipped-oversize"
  | "simple"

export type DecisionCall = {
  questions: string[]
  probabilities: Record<string, Record<string, number>>
  elapsedMs: number
  inputTokens: number
}
export type DecisionNode = {
  id: string
  parent: string | null
  depth: number
  span: Slice
  calls: DecisionCall[]
  outcome: NodeOutcome
  /** Probability per agent at this piece, and the size it picked; absent when unscored. */
  scores?: Record<PlanningAgentId, number>
  /** The observation form: P(yes) per observation at this piece, and its expected number of changes. */
  observations?: Record<string, number>
  changes?: number
  size?: SizePick
  sizeConfidence?: number
}
export type AgentScore = {
  score: number
  nodeID: string
  final: boolean
  /** yes, no, or the Architect decides: from the rule's score. */
  band: Band
  /** The observation the rule's score came from (observation form). */
  from?: string
}
export type DecisionOutcome =
  | {
      status: "decided"
      size: SizePick
      /** The size is from the number of changes and pieces: unreliable (about 40% exact); nothing routes on it. */
      sizeReliable: false
      /** Per observation, the largest P(yes) over the pieces and the piece it came from. */
      observations?: Record<string, { score: number; nodeID: string }>
      scores: Record<PlanningAgentId, AgentScore>
      /** Agents at or above the threshold. The default threshold cuts none. */
      selected: PlanningAgentId[]
      /** Set when a cost bound ended the search before every piece was scored. */
      stopped?: "budget" | "depth-bound"
      nodes: DecisionNode[]
      modelMs: number
    }
  | {
      status: "unavailable"
      reason: "no-window" | "feature-off" | "no-model" | "error" | "over-limit" | "budget"
      error?: string
      nodes: DecisionNode[]
      modelMs: number
    }

export type DecideDeps = {
  decider: Decider
  clock: () => number
  constants?: Partial<DecisionConstants>
  followUps?: readonly FollowUp[]
  signal: AbortSignal
}

class Oversize extends Error {}
const OVERSIZE = "D1 prompt exceeds"
/** Where an agent's yes/no sits when the model cannot tell; a 5-way uniform is 0.2. */
const UNSURE = { observations: 0.5, yesno: 0.5, choice: 0.22 } as const

const argmax = (record: Record<string, number>) =>
  Object.entries(record).reduce((best, entry) => (entry[1] > best[1] ? entry : best))

export async function decide(ask: string, deps: DecideDeps): Promise<DecisionOutcome> {
  const c: DecisionConstants = { ...DEFAULT_CONSTANTS, ...deps.constants }
  const followUps = deps.followUps ?? FOLLOW_UPS
  const limit = stateLimit(c)
  const { decider, clock, signal } = deps
  const gate = decider.available()
  if (!gate.ok) return { status: "unavailable", reason: gate.reason, nodes: [], modelMs: 0 }
  const text = ask
  if (!text.trim())
    return { status: "unavailable", reason: "error", error: "empty ask", nodes: [], modelMs: 0 }

  const nodes: DecisionNode[] = []
  const started = clock()
  let lastMs = 0
  let modelMs = 0
  let stopped: "budget" | "depth-bound" | undefined
  const stop = (reason: "budget" | "depth-bound") => (stopped ??= reason)
  const centre = UNSURE[c.agentForm]

  /** One request. `undefined` when the budget does not allow it. */
  async function request(
    span: Slice,
    questions: Record<string, SystemOneQuestion>,
  ): Promise<{ call: DecisionCall; answers: Answers } | undefined> {
    if (signal.aborted) throw new Error("aborted")
    if (clock() - started + lastMs > c.budgetMs) return (stop("budget"), undefined)
    const begin = clock()
    let reply: Awaited<ReturnType<Decider["ask"]>>
    try {
      reply = await decider.ask(text.slice(span.start, span.end), questions, signal)
    } catch (error) {
      if (error instanceof Error && error.message.includes(OVERSIZE)) throw new Oversize()
      throw error
    }
    const elapsedMs = clock() - begin
    lastMs = elapsedMs
    modelMs += elapsedMs
    const probabilities: DecisionCall["probabilities"] = {}
    for (const [name, answer] of Object.entries(reply.answers))
      probabilities[name] =
        answer.type === "noul"
          ? { true: answer.noul, false: 1 - answer.noul }
          : { ...answer.probabilities }
    return {
      call: {
        questions: Object.keys(questions),
        probabilities,
        elapsedMs,
        inputTokens: reply.inputTokens,
      },
      answers: reply.answers,
    }
  }

  /** Score one piece: size when wanted, then every agent; returns false when the budget ended it. */
  async function score(node: DecisionNode, wantSize: boolean, withFollowUps: boolean) {
    const questions: Record<string, SystemOneQuestion> = {}
    if (wantSize) questions.size = sizeQuestion()
    if (c.agentForm === "choice") questions.agents = agentChoiceQuestion()
    else for (const id of AGENT_ORDER) questions[`agent:${id}`] = agentQuestion(id)
    const batches = c.batch
      ? [questions]
      : Object.entries(questions).map(([name, question]) => ({ [name]: question }))
    const answers: Answers = {}
    try {
      for (const batch of batches) {
        const result = await request(node.span, batch)
        if (!result) {
          node.outcome = "budget-stop"
          return false
        }
        node.calls.push(result.call)
        Object.assign(answers, result.answers)
      }
      const scores = {} as Record<PlanningAgentId, number>
      for (const id of AGENT_ORDER) {
        const answer = c.agentForm === "choice" ? answers.agents : answers[`agent:${id}`]
        scores[id] =
          answer?.type === "choice"
            ? (answer.probabilities[id] ?? 0)
            : answer?.type === "noul"
              ? answer.noul
              : 0
      }
      const sizeAnswer = answers.size
      if (sizeAnswer?.type === "choice") {
        const [pick, probability] = argmax(sizeAnswer.probabilities)
        node.size = pick as SizePick
        node.sizeConfidence = probability
      }
      if (withFollowUps && node.size)
        for (const followUp of followUps) {
          if (followUp.parent.answer !== node.size) continue
          const result = await request(node.span, {
            [`followup:${followUp.id}`]: followUp.question,
          })
          if (!result) break
          node.calls.push(result.call)
          const answer = result.answers[`followup:${followUp.id}`]
          if (answer?.type === "noul" && answer.noul >= FOLLOW_UP_YES)
            scores[followUp.effect.agent] = Math.max(scores[followUp.effect.agent], c.followUpFloor)
        }
      node.scores = scores
      return true
    } catch (error) {
      if (error instanceof Oversize) {
        node.outcome = "skipped-oversize"
        return true
      }
      throw error
    }
  }

  /** The observation form: one request per observation, then the breadth score. */
  async function observe(node: DecisionNode): Promise<boolean> {
    const observed: Record<string, number> = {}
    try {
      for (const observation of OBSERVATIONS) {
        const result = await request(node.span, {
          [observation.id]: observationQuestion(observation),
        })
        if (!result) {
          node.outcome = "budget-stop"
          if (Object.keys(observed).length) node.observations = observed
          return false
        }
        node.calls.push(result.call)
        const answer = result.answers[observation.id]
        observed[observation.id] = answer?.type === "noul" ? answer.noul : 0
      }
      node.observations = observed
      const breadth = await request(node.span, { breadth: breadthQuestion() })
      if (!breadth) {
        node.outcome = "budget-stop"
        return false
      }
      node.calls.push(breadth.call)
      const levels = breadth.answers.breadth
      if (levels?.type === "score") {
        const keys = Object.keys(levels.probabilities).sort((a, b) => Number(a) - Number(b))
        node.changes = keys.reduce(
          (sum, key, index) =>
            sum + (levels.probabilities[key] ?? 0) * (CHANGES_PER_LEVEL[index] ?? 5),
          0,
        )
      }
      return true
    } catch (error) {
      if (error instanceof Oversize) {
        node.outcome = "skipped-oversize"
        return true
      }
      throw error
    }
  }
  const observing = c.agentForm === "observations"
  const scoreNode = (node: DecisionNode, followUps: boolean) =>
    observing ? observe(node) : score(node, true, followUps)

  const make = (
    id: string,
    parent: string | null,
    depth: number,
    span: Slice,
    outcome: NodeOutcome,
  ): DecisionNode => {
    const node: DecisionNode = { id, parent, depth, span, calls: [], outcome }
    nodes.push(node)
    return node
  }

  /** Slices of a span by necessity; a unit over the limit is recorded and never asked. */
  const pack = (span: Slice) => packToLimit(text, span, limit)

  const confidentOrOpen = (node: DecisionNode) => {
    const values = AGENT_ORDER.map((id) => node.scores![id])
    const nonFinal = values.filter((p) => Math.abs(p - centre) < c.uncertainBand).length
    const spread = Math.max(...values) - Math.min(...values)
    return { nonFinal, flat: spread < c.flatSpread }
  }

  try {
    const whole: Slice = { kind: "whole", start: 0, end: text.length }
    if (c.strategy === "windows" || c.strategy === "pre-slice") {
      const pieces =
        c.strategy === "windows"
          ? sentenceWindows(text, c.windowSentences, c.windowOverlap)
          : fixedSlices(text)
      const spans = pieces.flatMap((piece) => {
        const packed = pack(piece)
        return packed.slices.map((slice) => ({ slice, oversize: packed.oversize.includes(slice) }))
      })
      for (const [index, { slice, oversize }] of spans.entries()) {
        const node = make(String(index), null, 0, slice, "pre-sliced")
        if (oversize) node.outcome = "skipped-oversize"
        else if (!(await scoreNode(node, false))) break
      }
    } else if (c.strategy === "whole" || (observing && c.strategy === "uncertainty")) {
      const packed = pack(whole)
      for (const [index, slice] of packed.slices.entries()) {
        const node = make(String(index), null, 0, slice, "confident")
        if (packed.oversize.includes(slice)) node.outcome = "skipped-oversize"
        else if (!(await scoreNode(node, true))) break
        else if (node.size === "one task") node.outcome = "simple"
      }
    } else {
      const packed = pack(whole)
      let frontier: DecisionNode[] = []
      let rootConfidence = 1
      for (const [index, slice] of packed.slices.entries()) {
        const node = make(String(index), null, 0, slice, "confident")
        if (packed.oversize.includes(slice)) node.outcome = "skipped-oversize"
        else if (!(await scoreNode(node, true))) break
        else if (node.size === "one task") node.outcome = "simple"
        else {
          rootConfidence = Math.min(rootConfidence, node.sizeConfidence ?? 1)
          const { nonFinal, flat } = confidentOrOpen(node)
          if (nonFinal > 0 || flat) frontier.push(node)
        }
      }
      for (let depth = 0; frontier.length; depth++) {
        const open = frontier.filter((node) => {
          if (structuralChildren(text, node.span).length) return true
          node.outcome = "single-sentence"
          return false
        })
        if (depth >= c.maxDepth) {
          for (const node of open) node.outcome = "depth-stop"
          if (open.length) stop("depth-bound")
          break
        }
        const ranked = open
          .map((node) => ({ node, nonFinal: confidentOrOpen(node).nonFinal }))
          .sort(
            (a, b) =>
              b.nonFinal - a.nonFinal ||
              b.node.span.end - b.node.span.start - (a.node.span.end - a.node.span.start) ||
              a.node.span.start - b.node.span.start,
          )
          .map((entry) => entry.node)
        for (const node of ranked.slice(c.beamWidth)) node.outcome = "pruned"
        const next: DecisionNode[] = []
        for (const parent of ranked.slice(0, c.beamWidth)) {
          parent.outcome = "expanded"
          const children = groupChildren(structuralChildren(text, parent.span), c.maxChildren)
          for (const [index, slice] of children.entries()) {
            const node = make(`${parent.id}.${index}`, parent.id, depth + 1, slice, "confident")
            if (stopped === "budget") {
              node.outcome = "budget-stop"
              continue
            }
            if (!(await score(node, rootConfidence < c.sizeConfident, false))) continue
            const { nonFinal, flat } = confidentOrOpen(node)
            if (nonFinal > 0 || flat) next.push(node)
          }
        }
        frontier = next
      }
    }
  } catch (error) {
    return {
      status: "unavailable",
      reason: "error",
      error: error instanceof Error ? error.message : String(error),
      nodes,
      modelMs,
    }
  }

  if (observing) {
    const seen = nodes.filter((node) => node.observations)
    if (!seen.length)
      return {
        status: "unavailable",
        reason: stopped === "budget" ? "budget" : "over-limit",
        nodes,
        modelMs,
      }
    // Per observation, the largest P(yes) over the pieces: "does any piece say this".
    const observations: Record<string, { score: number; nodeID: string }> = {}
    for (const observation of OBSERVATIONS) {
      let best: { score: number; nodeID: string } | undefined
      for (const node of seen) {
        const value = node.observations![observation.id]
        if (value !== undefined && (!best || value > best.score))
          best = { score: value, nodeID: node.id }
      }
      if (best) observations[observation.id] = best
    }
    const flat = Object.fromEntries(Object.entries(observations).map(([id, o]) => [id, o.score]))
    const pieces = nodes.filter((node) => node.depth === 0).length
    const scores = {} as Record<PlanningAgentId, AgentScore>
    for (const rule of AGENT_RULES) {
      const result = ruleScore(rule, flat, pieces)
      scores[rule.agent] = {
        score: result.score,
        nodeID: observations[result.from]?.nodeID ?? "0",
        final: true,
        band: bandOf(result.score, c.yesAt, c.noAt),
        from: result.from,
      }
    }
    const sumChanges = seen.reduce((sum, node) => sum + (node.changes ?? 1), 0)
    return {
      status: "decided",
      size: SIZE_CHOICES[sizeFromChanges(sumChanges, pieces)]!,
      sizeReliable: false,
      observations,
      scores,
      // Selection cuts nothing by default: the threshold is 0.
      selected: AGENT_ORDER.filter((id) => scores[id].score >= c.agentThreshold),
      ...(stopped ? { stopped } : {}),
      nodes,
      modelMs,
    }
  }
  const scored = nodes.filter((node) => node.scores)
  if (!scored.length)
    return {
      status: "unavailable",
      reason: stopped === "budget" ? "budget" : "over-limit",
      nodes,
      modelMs,
    }
  const leaves = scored.filter((node) => node.outcome !== "expanded")
  const pool = leaves.length ? leaves : scored
  const scores = {} as Record<PlanningAgentId, AgentScore>
  for (const id of AGENT_ORDER) {
    let best = pool[0]!
    for (const node of pool) if (node.scores![id] > best.scores![id]) best = node
    scores[id] = {
      score: best.scores![id],
      nodeID: best.id,
      final: !["pruned", "depth-stop", "single-sentence", "budget-stop"].includes(best.outcome),
      band: bandOf(best.scores![id], c.yesAt, c.noAt),
    }
  }
  const size = scored.reduce<SizePick>(
    (largest, node) =>
      node.size && SIZE_CHOICES.indexOf(node.size) > SIZE_CHOICES.indexOf(largest)
        ? node.size
        : largest,
    "one task",
  )
  return {
    status: "decided",
    size,
    sizeReliable: false,
    scores,
    selected: AGENT_ORDER.filter((id) => scores[id].score >= c.agentThreshold),
    ...(stopped ? { stopped } : {}),
    nodes,
    modelMs,
  }
}
