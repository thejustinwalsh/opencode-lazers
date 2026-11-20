const OBJECTIVE_MAX = 100

/** The first sentence of a draft's objective, at most 100 characters, `…` when cut. */
export function firstSentence(proposal: unknown): string {
  const objective =
    proposal !== null && typeof proposal === "object"
      ? (proposal as { objective?: unknown }).objective
      : undefined
  if (typeof objective !== "string" || !objective.trim()) return "(no objective yet)"
  const text = objective.trim().replace(/\s+/g, " ")
  const sentence = text.split(/(?<=[.!?])\s/u)[0]!
  return sentence.length > OBJECTIVE_MAX ? `${sentence.slice(0, OBJECTIVE_MAX - 1)}…` : sentence
}
