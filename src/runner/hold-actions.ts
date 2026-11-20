/**
 * Every hold raises to the Architect with at least one action that unblocks it:
 * proceed with a recorded reason (`resume`, `run`), retry, reconcile (re-observe
 * and continue) or cancel. `audit` only reads, so it never counts.
 */
export type HoldFamily = {
  name: string
  match: RegExp
  /** Actions that unblock this family, most specific first. */
  actions: readonly string[]
}

export const HOLD_FAMILIES: readonly HoldFamily[] = [
  {
    // The Architect's own result after a takeover: it fixes and submits again, or cancels.
    name: "takeover-verification",
    match: /^Takeover verification failed/,
    actions: ["takeover-submit", "cancel"],
  },
  {
    // The Architect that took the task over is gone; another live Architect continues or cancels.
    name: "takeover-abandoned",
    match: /^Takeover abandoned/,
    actions: ["takeover-submit", "cancel"],
  },
  {
    name: "fallow-config-required",
    match: /^FALLOW_CONFIG_REQUIRED/,
    actions: ["run", "reconcile", "cancel"],
  },
  {
    name: "retained-repair",
    match: /^Retained (repair|worker)/,
    actions: ["retained-repair", "reconcile", "cancel"],
  },
  {
    name: "mechanical-preparation",
    match: /^Mechanical candidate/,
    actions: ["reconcile", "resume", "cancel"],
  },
  {
    name: "scope-divergence",
    match: /^Scope divergence needs a decision/,
    actions: ["amend-scope", "retained-repair", "reconcile", "cancel"],
  },
  {
    name: "scope-violation",
    match: /scope|outside the write scope|not permitted/i,
    actions: ["amend-scope", "reconcile", "cancel"],
  },
  {
    name: "missing-evidence",
    match: /evidence missing|Required .*evidence/i,
    actions: ["resume", "retry", "reconcile", "cancel"],
  },
  {
    name: "check-failed",
    match:
      /verification (failed|command failed)|Verification .* (completed|failed)|exit \d|timed out|timedOut/i,
    actions: ["resume", "retry", "reconcile", "cancel"],
  },
  {
    name: "uncommitted-candidate",
    match: /Commit task edits|uncommitted|candidate changed/i,
    actions: ["resume", "retry", "reconcile", "cancel"],
  },
  {
    name: "uncertain-effect",
    match: /uncertain|not replayed|was not repeated|Recovery uncertain|unresolved/i,
    actions: ["reconcile", "cancel"],
  },
  {
    name: "native-input",
    match: /pending permission|pending form|waiting for human/i,
    actions: ["reconcile", "cancel"],
  },
  {
    name: "worker-observation",
    match: /Worker |worker |Native worker|background|idle|interrupted/,
    actions: ["reconcile", "retry", "cancel"],
  },
  {
    name: "route-unavailable",
    match: /Select an implementor model|No native worker route/,
    actions: ["reconcile", "run", "cancel"],
  },
  {
    name: "baseline-or-overlap",
    match: /baseline|overlap|Overlap|conflict|integration order/,
    actions: ["reconcile", "cancel"],
  },
  {
    name: "dispatch-failed",
    match: /^Dispatch failed|^Task [^:]+:/,
    actions: ["retry", "reconcile", "cancel"],
  },
  {
    name: "cleanup",
    match: /cleanup|worktree|checkout/i,
    actions: ["reconcile", "cancel"],
  },
  {
    name: "dependency",
    match: /prerequisite|dependency/i,
    actions: ["schedule", "reconcile", "cancel"],
  },
  {
    name: "combined-verification",
    match: /Combined (verification|candidate|artifact)/,
    actions: ["resume", "reconcile", "cancel"],
  },
]

/** A reason that matches no family still unblocks through reconcile or cancel. */
export const FALLBACK_HOLD_ACTIONS: readonly string[] = ["reconcile", "cancel"]

export function holdFamily(reason: string): HoldFamily | undefined {
  return HOLD_FAMILIES.find((family) => family.match.test(reason))
}

/**
 * Actions advertised with a hold: the caller's choices plus every action that
 * unblocks the reason's family. Read-only `audit` is kept but never counted.
 */
export function holdActions(reason: string, requested: readonly string[] = []): string[] {
  const unblocking = holdFamily(reason)?.actions ?? FALLBACK_HOLD_ACTIONS
  const merged = new Set<string>([
    ...requested.filter((action) => action !== "audit"),
    ...unblocking,
  ])
  if (requested.includes("audit") || requested.length === 0) merged.add("audit")
  return [...merged]
}

export function unblockingActions(actions: readonly string[]): string[] {
  return actions.filter((action) => action !== "audit")
}
