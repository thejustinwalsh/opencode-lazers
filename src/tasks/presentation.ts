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

/** Runtime reasons worth rewriting, tried in order; the first match wins. Each says what happened and what happens next. */
const reasonMap: ReadonlyArray<readonly [RegExp, string]> = [
  [/native idle background observation/i, INTERRUPTED],
  [/(idle|background) (report|observation)/i, INTERRUPTED],
  [
    /does not match a completed response|completed turn for another input/i,
    "The worker finished a different request than the one it was given. Architect can reconcile it or retry.",
  ],
  [
    /prerequisite .*(integrat|not been integrated)|prerequisite plans? .*integrated/i,
    "Waiting for prerequisite work to be integrated. This starts once it lands.",
  ],
  [
    /checkout or write scope|scopes are reserved|conflicting write scope/i,
    "Another task holds the files this one needs. This starts when they are free.",
  ],
  [
    /combined artifact (verification failed|conflict)/i,
    "This work conflicts with other accepted changes when combined. Open Architect to reconcile it.",
  ],
  [
    /worker (execution )?(was )?interrupted|could not resume/i,
    "The worker was interrupted and the runtime could not resume it. Open Architect to resume or retry it.",
  ],
  [
    /verification .*(exited with code|failed)|checks? failed/i,
    "A verification check failed. Open Architect to retry or amend the task.",
  ],
  [
    /no native worker route/i,
    "No worker model is configured for this kind of task. Assign one in Models.",
  ],
  [
    /landing branch or head changed/i,
    "The target branch moved while integrating. Open Architect to integrate again.",
  ],
  [
    /owned worktree (is dirty|has unmerged)/i,
    "The task's worktree holds work that was kept. Open Architect to decide what to do with it.",
  ],
  [/higher-priority/i, "A higher-priority plan goes first. This runs after it."],
  [/cancellation requested/i, "Cancellation was requested. The runtime is stopping this work."],
  [/awaits human evidence/i, "This needs evidence from you. Open Architect to provide it."],
  [
    /no task is currently dispatchable/i,
    "Nothing in this plan can start yet. It starts when a prerequisite finishes.",
  ],
  [
    /unknown (installer|process|settlement)/i,
    "The runtime is checking what was left running. This clears once it finishes.",
  ],
  [
    /coverage is (incomplete|bounded|insufficient)|(facts|ancestry|coverage) (is|are) unavailable/i,
    "The scheduler is still gathering facts. This clears on the next refresh.",
  ],
]

/** One user sentence per state for a runtime reason no rule covers. Never prints the raw text. */
const GENERIC: Readonly<Record<string, string>> = {
  waiting: "This task is on hold. It continues when the runtime clears the hold.",
  blocked: "This task is on hold. It continues when the runtime clears the hold.",
  paused: "Starting new work on this task is paused. It resumes when the pause is lifted.",
  failed: "The last attempt failed. Open Architect to choose the next step.",
  exhausted: "The last attempt failed. Open Architect to choose the next step.",
}
const GENERIC_DEFAULT = "The runtime recorded a note on this task. Details has the full text."

export type TaskReasonView = {
  /** One plain sentence in user terms; never contains raw runtime prose or "unknown". */
  text: string
  /** The recorded runtime reason, behind "Details"; absent only when it already is `text`. */
  raw?: string
}

/**
 * Present a recorded runtime reason as one user sentence, keeping the raw text for Details.
 * `state` picks the generic sentence for a reason no rule covers.
 */
export function taskReasonView(reason: string, state?: string): TaskReasonView {
  const raw = reason.trim()
  const text =
    reasonMap.find(([pattern]) => pattern.test(raw))?.[1] ??
    GENERIC[(state ?? "").toLowerCase()] ??
    GENERIC_DEFAULT
  return text === raw ? { text } : { text, raw }
}
