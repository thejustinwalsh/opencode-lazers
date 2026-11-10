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

/** Resolve the recorded heading against today's document before using the line hint. */
export function sourcePlanLine(source: { section?: string; line?: number }, content: string) {
  const heading = source.section
    ?.trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+$/, "")
  if (heading) {
    const found = content.split(/\r?\n/).findIndex((line) => {
      const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
      return match?.[1] === heading
    })
    if (found >= 0) return found + 1
  }
  return source.line
}
