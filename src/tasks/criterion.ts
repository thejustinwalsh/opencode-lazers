/** Longest short line a criterion shows before its chevron opens the full text. */
export const CRITERION_LINE_MAX = 72

function atWordBoundary(text: string, max: number) {
  if (text.length <= max) return text
  const prefix = text.slice(0, max - 1)
  const boundary = prefix.lastIndexOf(" ")
  return `${prefix.slice(0, boundary > 0 ? boundary : prefix.length).trimEnd()}…`
}

/** `restart-runs-same-worker` as `Restart runs same worker`. */
export function humanizeIdentifier(id: string) {
  const words = id.replace(/[-_]+/g, " ").trim()
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : ""
}

/** The first clause: up to a sentence end, semicolon, colon, dash or comma past a few words. */
function firstClause(text: string) {
  const flat = text.trim().replace(/\s+/g, " ")
  const stop = /[.!?;:](?=\s|$)|\s[—–-]\s|,\s/g
  for (let match = stop.exec(flat); match; match = stop.exec(flat))
    if (match.index >= 12) return flat.slice(0, match.index)
  return flat
}

/**
 * The one-line form of a done condition. It is derived on display, never stored: the name of the
 * required evidence group (the criterion id) when the criterion has mechanical evidence, otherwise
 * the first clause of the assertion. Either is cut at a word boundary to `CRITERION_LINE_MAX`.
 */
export function criterionLine(criterion: {
  id: string
  assertion: string
  evidence: readonly unknown[]
}) {
  const named = criterion.evidence.length > 0 ? humanizeIdentifier(criterion.id) : ""
  return atWordBoundary(named || firstClause(criterion.assertion), CRITERION_LINE_MAX)
}
