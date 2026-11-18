/** View-local Start feedback must never outlive its selection or scope. */
export class StartFeedback {
  private identity = ""
  private ticket?: object
  private error = ""
  constructor(private readonly changed: (value: { taskID: string; error: string }) => void) {}

  reset(identity: string) {
    if (identity === this.identity) return
    this.identity = identity
    this.ticket = undefined
    this.error = ""
    this.changed({ taskID: "", error: "" })
  }

  begin(taskID: string) {
    if (this.ticket) return
    const ticket = {}
    this.ticket = ticket
    this.error = ""
    this.changed({ taskID, error: "" })
    return ticket
  }

  fail(ticket: object, error: unknown) {
    if (ticket !== this.ticket) return
    this.error = error instanceof Error ? error.message : String(error)
  }

  finish(ticket: object) {
    if (ticket !== this.ticket) return
    this.ticket = undefined
    this.changed({ taskID: "", error: this.error })
  }
}

/** Restore only after the relevant content mounts, once per view/selection. */
export class ScrollRestoration {
  private generation = 0
  private key = ""
  private applied = ""
  constructor(
    private readonly schedule: (apply: () => void) => void = (apply) => queueMicrotask(apply),
  ) {}

  restored(key: string) {
    return Boolean(key) && this.applied === key
  }

  restore(key: string, ready: boolean, element: { scrollTop: number } | undefined, top: number) {
    if (key !== this.key || !ready) this.applied = ""
    this.key = key
    const generation = ++this.generation
    if (!key || !ready || !element || this.restored(key)) return
    this.schedule(() => {
      if (generation !== this.generation) return
      element.scrollTop = top
      this.applied = key
    })
  }
}

export const canStart = (state: string) => ["submitted", "queued", "ready"].includes(state)
export function workerActivityLabel(activity?: { foreground: string; archived?: boolean }) {
  return activity?.foreground === "inactive" && activity.archived
    ? "archived"
    : activity?.foreground === "unknown"
      ? ""
      : (activity?.foreground ?? "")
}
