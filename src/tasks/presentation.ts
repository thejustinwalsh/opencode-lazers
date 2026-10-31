/** A display excerpt, not an inferred or persisted semantic title. */
export function taskTitle(objective: string) {
  const sentence = objective
    .trim()
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s/)[0]!
  if (sentence.length <= 72) return sentence
  const prefix = sentence.slice(0, 71)
  const boundary = prefix.lastIndexOf(" ")
  return `${prefix.slice(0, boundary > 0 ? boundary : prefix.length).trimEnd()}…`
}
