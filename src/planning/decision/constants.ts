import type { SlicerStrategy } from "./slicers.ts"

/**
 * Every value here is a hand-picked starting value; not measured. Each names the measurement
 * that replaces it. They are recorded with each decision (`constants_json`), so a later setting
 * is chosen from evidence, never from this file.
 */
export type DecisionConstants = {
  /** An agent is selected at or above this combined score. 0 cuts no agent: all five run. Moved by planning-report (Decisions). */
  agentThreshold: number
  /** Distance from the unsure centre at which an agent's score is final. Moved by planning-report (Decisions). */
  uncertainBand: number
  /** Max minus min below this: the piece is flat. Moved by planning-report (Decisions). */
  flatSpread: number
  /** Size confidence at the root below this: children are asked size too. */
  sizeConfident: number
  /** Nodes expanded per level (uncertainty strategy). */
  beamWidth: number
  /** Groups per expansion (uncertainty strategy). */
  maxChildren: number
  /** Depth bound (uncertainty strategy); replaced by the latency fit of measurement M1. */
  maxDepth: number
  /** Model time per ask; a call starts only if elapsed plus the last call fits. Replaced by measurement M1. */
  budgetMs: number
  /** The context hook waits at most this from prompt admission. Replaced by measurement M2. */
  deliveryWaitMs: number
  /** Input tokens a request may carry (state plus question). The owner's bound, from the spike. */
  maxInputTokens: number
  /** Characters per token assumed when sizing a piece; below the measured p5 on prose. Replaced by measurement M1. */
  charsPerToken: number
  /** Share of the input bound reserved for the question text. */
  questionReserveTokens: number
  /** Sentences per window, and the sentences two windows share. Replaced by measurement M2. */
  windowSentences: number
  windowOverlap: number
  /** One question per request, unless batching is measured faster per question. Replaced by measurement M1. */
  batch: boolean
  /**
   * `observations` (default): small yes/no judgments about the text, one request each, and a rule
   * table in code. `yesno` (per-agent) and `choice` (5-way) are the old forms, kept for replay.
   */
  agentForm: "observations" | "yesno" | "choice"
  /** A rule's score at or above this is yes; at or below `noAt` is no; between is the Architect's call. */
  yesAt: number
  noAt: number
  /** Score a follow-up floor raises an agent to. */
  followUpFloor: number
  strategy: SlicerStrategy
}

export const DEFAULT_CONSTANTS: DecisionConstants = {
  agentThreshold: 0,
  uncertainBand: 0.08,
  flatSpread: 0.1,
  sizeConfident: 0.6,
  beamWidth: 2,
  maxChildren: 4,
  maxDepth: 2,
  budgetMs: 10_000,
  deliveryWaitMs: 3_000,
  maxInputTokens: 400,
  charsPerToken: 3,
  questionReserveTokens: 100,
  windowSentences: 4,
  windowOverlap: 1,
  batch: false,
  agentForm: "observations",
  yesAt: 0.7,
  noAt: 0.3,
  followUpFloor: 0.22,
  strategy: "windows",
}

/** The longest state a request may carry, so state plus question stays within the input bound. */
export function stateLimit(constants: DecisionConstants = DEFAULT_CONSTANTS): { maxChars: number } {
  return {
    maxChars: Math.max(
      1,
      Math.floor(
        (constants.maxInputTokens - constants.questionReserveTokens) * constants.charsPerToken,
      ),
    ),
  }
}
