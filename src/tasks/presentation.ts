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

/** The full first sentence of an objective, for a heading that wraps instead of truncating. */
export function taskHeading(objective: string) {
  return objective
    .trim()
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s/)[0]!
}

const INTERRUPTED =
  "Worker was interrupted by the service restart. Resumes when the runtime confirms the session is idle."

/** Runtime reasons worth rewriting, tried in order; the first match wins. */
const reasonMap: ReadonlyArray<readonly [RegExp, string]> = [
  [/native idle background observation/i, INTERRUPTED],
  [/(idle|background) (report|observation)/i, INTERRUPTED],
  [/unknown (installer|process|settlement)/i, "The runtime is checking what was left running."],
]

/** Fallback for a runtime reason no rule covers and that still names an unknown. */
const PENDING = "Waiting for the runtime to confirm the current state."

export type TaskReasonView = {
  /** One plain sentence in user terms; never contains "unknown". */
  text: string
  /** The recorded runtime reason, when it differs from `text`; shown behind "Details". */
  raw?: string
}

/** Present a recorded runtime reason as one user sentence, keeping the raw text for Details. */
export function taskReasonView(reason: string): TaskReasonView {
  const raw = reason.trim()
  const mapped = reasonMap.find(([pattern]) => pattern.test(raw))?.[1]
  const first = raw.split(/\r?\n/)[0]!.trim()
  const text = mapped ?? (/unknown/i.test(first) ? PENDING : first)
  return text === raw ? { text } : { text, raw }
}
