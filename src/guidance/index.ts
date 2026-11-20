import fallowConfig from "./fallow-config.md" with { type: "text" }
import fallowSuppressions from "./fallow-suppressions.md" with { type: "text" }
import planningResolve from "./planning-resolve.md" with { type: "text" }
import planningShow from "./planning-show.md" with { type: "text" }
import projectSetup from "./project-setup.md" with { type: "text" }
import recoveryBundle from "./recovery-bundle.md" with { type: "text" }
import recoveryControls from "./recovery-controls.md" with { type: "text" }
import scopeDivergence from "./scope-divergence.md" with { type: "text" }
import takeover from "./takeover.md" with { type: "text" }
import workerConcerns from "./worker-concerns.md" with { type: "text" }
import workerTakeoverNotice from "./worker-takeover-notice.md" with { type: "text" }

/**
 * Situational guidance. Each runbook is one markdown file in this folder, rendered into the notice
 * or tool result that opens its situation, so it is in context when it is needed and not in the
 * standing prompt of every request. Text only: guidance adds no state, hold or gate.
 */
export const runbooks = {
  "fallow-config": fallowConfig,
  "fallow-suppressions": fallowSuppressions,
  "planning-resolve": planningResolve,
  "planning-show": planningShow,
  "project-setup": projectSetup,
  "recovery-bundle": recoveryBundle,
  "recovery-controls": recoveryControls,
  "scope-divergence": scopeDivergence,
  takeover,
  "worker-concerns": workerConcerns,
  "worker-takeover-notice": workerTakeoverNotice,
} as const

export type RunbookTopic = keyof typeof runbooks

/** The runbook's text, trimmed of its file's trailing newline. */
export function runbook(topic: RunbookTopic): string {
  return runbooks[topic].trim()
}

/** How an Architect reads a runbook again after it was delivered once; only for once-per-scope topics. */
const retrieval = {
  "fallow-config": '`lz-fallow-config` with `mode: "guide"`',
  "fallow-suppressions": '`lz-fallow-config` with `mode: "guide", topic: "suppressions"`',
  "planning-resolve": '`lz-plan-draft` with `action: "guide", topic: "resolve"`',
  "planning-show": '`lz-plan-draft` with `action: "guide", topic: "show"`',
  "project-setup": '`lz-project-profile` with `mode: "guide"`',
} as const satisfies Partial<Record<RunbookTopic, string>>

export type RetrievableTopic = keyof typeof retrieval

/** The one line that stands in for a runbook already delivered. */
export function pointer(topic: RetrievableTopic): string {
  return `(${topic} guidance was delivered earlier in this session; ${retrieval[topic]} returns it again.)`
}

/**
 * Which runbooks a session already holds, by topic and scope (a plan ID, or empty for the whole
 * session). In memory: a restarted service or a fresh Architect session has no earlier delivery,
 * so the full runbook is sent again, which is the safe direction.
 */
export class GuidanceLedger {
  private readonly seen = new Map<string, Set<string>>()

  has(sessionID: string, topic: RunbookTopic, scope = ""): boolean {
    return this.seen.get(sessionID)?.has(`${topic}\u0000${scope}`) ?? false
  }

  record(sessionID: string, topic: RunbookTopic, scope = ""): void {
    let set = this.seen.get(sessionID)
    if (!set) this.seen.set(sessionID, (set = new Set()))
    set.add(`${topic}\u0000${scope}`)
  }

  clear(): void {
    this.seen.clear()
  }
}

export const guidanceLedger = new GuidanceLedger()

/**
 * One rendering's view of the ledger. `once` returns the runbook the first time a session sees the
 * topic in a scope and the pointer after; the claim is recorded by `commit`, called only once the
 * text reached the session, so a failed delivery sends the runbook again.
 */
export class Delivery {
  private readonly pending = new Set<string>()

  constructor(
    private readonly sessionID: string,
    private readonly ledger: GuidanceLedger = guidanceLedger,
  ) {}

  once(topic: RetrievableTopic, scope = ""): string {
    const key = `${topic}\u0000${scope}`
    if (this.ledger.has(this.sessionID, topic, scope) || this.pending.has(key))
      return pointer(topic)
    this.pending.add(key)
    return runbook(topic)
  }

  commit(): void {
    for (const key of this.pending) {
      const [topic, scope] = key.split("\u0000") as [RunbookTopic, string]
      this.ledger.record(this.sessionID, topic, scope)
    }
    this.pending.clear()
  }
}
