export const REVIEW_ROUNDS = 3
export const REVIEW_THRESHOLD = 0.7

export type ReviewDisposition =
  "resolved" | "not_applicable" | "non_regressed" | "limit" | "pending"
export type ReviewStage = "feedback" | "completed" | "completed_with_concerns" | "unavailable"
export type PreviousResultKind = "feedback" | "terminal" | "retryable"

export interface ReviewFinding {
  id: string
  score: number | null
  disposition: ReviewDisposition
}

export interface ReviewProgressionRecord<Finding extends ReviewFinding> {
  round: number
  focus: string | null
  previous: Finding[]
  completed: Record<string, ReviewDisposition>
}

export interface ReviewObservation {
  /** Direction-normalized P(good), or null when no usable result was produced. */
  score: number | null
  notApplicable?: boolean
}

export interface ReviewEvaluation<Check extends { id: string }> {
  findings: Array<Check & ReviewFinding>
  focus: (Check & ReviewFinding) | null
  completed: Record<string, ReviewDisposition>
  status: ReviewStage
  done: boolean
  concerns: boolean
}

export type ReplayDecision<Result> =
  { kind: "continue" } | { kind: "replay"; result: Result } | { kind: "stale"; result: Result }

/** Shared subject-independent replay, round reservation, and forward-progress policy. */
export class ReviewProgression {
  constructor(
    readonly maxRounds = REVIEW_ROUNDS,
    readonly threshold = REVIEW_THRESHOLD,
  ) {}

  inspect<Result extends { fingerprint: string }>(
    last: Result | undefined,
    fingerprint: string,
    classify: (result: Result) => PreviousResultKind,
  ): ReplayDecision<Result> {
    if (!last) return { kind: "continue" }
    const kind = classify(last)
    if (kind === "terminal")
      return last.fingerprint === fingerprint
        ? { kind: "replay", result: last }
        : { kind: "stale", result: last }
    if (kind === "feedback" && last.fingerprint === fingerprint)
      return { kind: "replay", result: last }
    return { kind: "continue" }
  }

  hasRounds(record: Pick<ReviewProgressionRecord<ReviewFinding>, "round">): boolean {
    return record.round < this.maxRounds
  }

  /** Reserve before inference so a crash or interrupted call consumes its round. */
  reserveRound(record: Pick<ReviewProgressionRecord<ReviewFinding>, "round">): boolean {
    if (!this.hasRounds(record)) return false
    record.round++
    return true
  }

  limit<Check extends { id: string }>(checks: readonly Check[]): Array<Check & ReviewFinding> {
    return checks.map((check) => ({ ...check, score: null, disposition: "limit" }))
  }

  evaluate<Check extends { id: string }, Finding extends ReviewFinding>(
    checks: readonly Check[],
    observations: Readonly<Record<string, ReviewObservation>>,
    record: ReviewProgressionRecord<Finding>,
    hasErrors: boolean,
  ): ReviewEvaluation<Check> {
    const findings = checks.map((check): Check & ReviewFinding => {
      const observation = observations[check.id]
      const candidate = observation?.score
      const score =
        typeof candidate === "number" &&
        Number.isFinite(candidate) &&
        candidate >= 0 &&
        candidate <= 1
          ? candidate
          : null
      let disposition: ReviewDisposition =
        observation?.notApplicable && !hasErrors
          ? "not_applicable"
          : score !== null && score >= this.threshold
            ? "resolved"
            : "pending"
      const previous = record.previous.find((item) => item.id === check.id)
      if (
        disposition === "pending" &&
        score !== null &&
        previous?.score !== null &&
        previous?.score !== undefined &&
        (record.focus === check.id || record.completed[check.id] === "non_regressed") &&
        score >= previous.score
      )
        disposition = "non_regressed"
      if (disposition === "pending" && record.round >= this.maxRounds) disposition = "limit"
      return { ...check, score, disposition }
    })
    const focus = findings.find((item) => item.disposition === "pending") ?? null
    const done = focus === null
    const concerns =
      findings.some(
        (item) => item.disposition === "non_regressed" || item.disposition === "limit",
      ) || hasErrors
    const status: ReviewStage = done
      ? concerns
        ? "completed_with_concerns"
        : "completed"
      : hasErrors
        ? "unavailable"
        : "feedback"
    const completed = Object.fromEntries(
      findings
        .filter((item) => item.disposition !== "pending")
        .map((item) => [item.id, item.disposition]),
    )
    return { findings, focus, completed, status, done, concerns }
  }
}

export const reviewProgression = new ReviewProgression()
