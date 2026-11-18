import { taskMachine } from "./machine.ts"
import { dispatchControlMachine } from "./dispatch-control-machine.ts"
import { architectSourceMachine } from "./architect-source-machine.ts"
import { architectContactMachine } from "./architect-contact-machine.ts"
import type { Database } from "bun:sqlite"
import { createMachine, transition } from "xstate"

const planStates = {
  draft: { on: { running: "running", blocked: "blocked", cancelling: "cancelling" } },
  running: {
    on: {
      running: "running",
      blocked: "blocked",
      accepted: "accepted",
      cancelling: "cancelling",
    },
  },
  blocked: {
    on: {
      blocked: "blocked",
      running: "running",
      accepted: "accepted",
      cancelling: "cancelling",
    },
  },
  accepted: {
    on: {
      accepted: "accepted",
      running: "running",
      blocked: "blocked",
      cleaning: "cleaning",
      cancelling: "cancelling",
    },
  },
  cancelling: { on: { cancelled: "cancelled", blocked: "blocked", cancelling: "cancelling" } },
  cancelled: { on: { running: "running", blocked: "blocked", cancelled: "cancelled" } },
  failed: { on: { running: "running", blocked: "blocked", cancelling: "cancelling" } },
  cleaning: {
    on: {
      cancelling: "cancelling",
      "cleanup-blocked": "cleanup-blocked",
      integrated: "integrated",
      blocked: "blocked",
    },
  },
  "cleanup-blocked": {
    on: {
      "cleanup-blocked": "cleanup-blocked",
      cleaning: "cleaning",
      integrated: "integrated",
      blocked: "blocked",
      running: "running",
      cancelling: "cancelling",
    },
  },
  integrated: { type: "final" },
} as const

export const planMachine = createMachine({
  id: "runner-plan",
  initial: "draft",
  states: planStates,
})

const attemptStates = {
  unknown: { on: { preparing: "preparing", failed: "failed", cancelled: "cancelled" } },
  preparing: {
    on: { preparing: "preparing", running: "running", failed: "failed", cancelled: "cancelled" },
  },
  running: {
    on: {
      preparing: "preparing",
      verifying: "verifying",
      accepted: "accepted",
      failed: "failed",
      cancelled: "cancelled",
    },
  },
  verifying: {
    on: {
      preparing: "preparing",
      accepted: "accepted",
      failed: "failed",
      cancelled: "cancelled",
    },
  },
  accepted: { on: { preparing: "preparing", accepted: "accepted" } },
  failed: { on: { preparing: "preparing" } },
  cancelled: { on: { preparing: "preparing", cancelled: "cancelled" } },
  exhausted: { on: { preparing: "preparing" } },
} as const

export const attemptMachine = createMachine({
  id: "runner-attempt",
  initial: "preparing",
  states: attemptStates,
})

const effectStates = {
  intended: {
    on: { completed: "completed", uncertain: "uncertain", failed: "failed", held: "held" },
  },
  held: { on: { held: "held", intended: "intended", completed: "completed" } },
  uncertain: { on: { uncertain: "uncertain", completed: "completed", failed: "failed" } },
  completed: { type: "final" },
  failed: { type: "final" },
} as const

export const effectMachine = createMachine({
  id: "runner-effect",
  initial: "intended",
  states: effectStates,
})

function defineLifecycle(id: string, initial: string, edges: Record<string, readonly string[]>) {
  return createMachine({
    id,
    initial,
    states: Object.fromEntries(
      Object.entries(edges).map(([state, targets]) => [
        state,
        { on: Object.fromEntries([state, ...targets].map((target) => [target, target])) },
      ]),
    ),
  })
}

/**
 * A notice is queued until the Architect session's inbox holds it, then delivered.
 * A queued notice replaced by a newer outcome for the same plan, or one retired
 * before admission, ends superseded. Whether OpenCode later consumes it is not tracked.
 */
export const outboxMachine = defineLifecycle("runner-outbox", "pending", {
  pending: ["delivered", "superseded"],
  delivered: [],
  superseded: [],
})
export const renewalMachine = defineLifecycle("runner-architect-renewal", "creating", {
  creating: ["archiving", "deferred", "rolling-back"],
  archiving: ["committed", "recovering-input", "rolling-back", "deferred", "archive-failed"],
  "recovering-input": ["archiving", "rolling-back", "deferred", "archive-failed"],
  "rolling-back": ["deferred", "archive-failed"],
  committed: ["deferred"],
  deferred: ["creating"],
  "archive-failed": ["creating"],
})
export const adoptionMachine = defineLifecycle("runner-adoption", "pending", {
  pending: ["task-checks", "combined-checks", "held", "accepted", "failed", "cancelled"],
  "task-checks": ["combined-checks", "held", "accepted", "failed", "cancelled"],
  "combined-checks": ["task-checks", "held", "accepted", "failed", "cancelled"],
  held: ["cancelled"],
  accepted: [],
  failed: [],
  cancelled: [],
})
/** One call: it passes (accepted), fails, or is cancelled with its plan. No hold, no resume. */
export const retainedVerificationMachine = defineLifecycle(
  "runner-retained-verification",
  "pending",
  {
    pending: ["task-checks", "failed", "cancelled"],
    "task-checks": ["accepted", "failed", "cancelled"],
    accepted: [],
    failed: [],
    cancelled: [],
  },
)
export const verificationResourceMachine = defineLifecycle(
  "runner-verification-resource",
  "creating",
  {
    creating: ["active", "uncertain", "removed"],
    active: ["uncertain", "removed"],
    uncertain: ["active", "removed"],
    removed: ["creating"],
  },
)
export const verificationCheckMachine = defineLifecycle("runner-verification-check", "intended", {
  intended: ["completed", "uncertain"],
  uncertain: ["completed"],
  completed: ["uncertain"],
})
export const verificationCleanupMachine = defineLifecycle(
  "runner-verification-cleanup",
  "pending",
  {
    pending: ["complete", "failed"],
    failed: ["complete"],
    complete: ["pending"],
  },
)

export const workspaceMachine = defineLifecycle("runner-verification-workspace", "unallocated", {
  unallocated: ["reserved", "owned", "uncertain", "removed"],
  reserved: ["owned", "uncertain", "removed"],
  owned: ["uncertain", "removed"],
  uncertain: ["owned", "removed"],
  removed: ["uncertain"],
})
export const lifecycleMachines = {
  task: taskMachine,
  dispatch: dispatchControlMachine,
  source: architectSourceMachine,
  contact: architectContactMachine,
  plan: planMachine,
  attempt: attemptMachine,
  effect: effectMachine,
  outbox: outboxMachine,
  renewal: renewalMachine,
  adoption: adoptionMachine,
  retained: retainedVerificationMachine,
  resource: verificationResourceMachine,
  check: verificationCheckMachine,
  cleanup: verificationCleanupMachine,
  workspace: workspaceMachine,
} as const

/** SQL invokes the same XState transition against the row's current persisted value. */
export function lifecycleTransition(domain: string, state: string, event: string): string {
  if (!Object.hasOwn(lifecycleMachines, domain))
    throw new Error(`Unknown runner lifecycle: ${domain}`)
  const machine = lifecycleMachines[domain as keyof typeof lifecycleMachines]
  const current = machine.resolveState({ value: state, context: {} })
  if (!current.can({ type: event })) {
    throw new Error(`Invalid ${domain} transition ${state} → ${event}`)
  }
  return transition(machine, current, { type: event })[0].value as string
}

const registered = new WeakSet<Database>()
export function registerLifecycleTransitions(db: Database) {
  if (registered.has(db)) return
  db.function("lz_runner_transition", (domain, state, event) => {
    if (typeof domain !== "string" || typeof state !== "string" || typeof event !== "string")
      throw new Error("Runner transition requires a domain, state and event")
    return lifecycleTransition(domain, state, event)
  })
  registered.add(db)
}

export type PlanLifecycleState = keyof typeof planStates
export type AttemptLifecycleState = keyof typeof attemptStates
export type EffectLifecycleState = keyof typeof effectStates
