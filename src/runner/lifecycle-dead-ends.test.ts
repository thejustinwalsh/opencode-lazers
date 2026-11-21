import { expect, test } from "bun:test"
import { transition } from "xstate"
import { lifecycleMachines } from "./lifecycle-machines.ts"

/**
 * Every transition event is classified as either a directly observable event
 * or an Architect action the hold advertises (proceed, retry, reconcile,
 * cancel). A new event or state must be classified here, so a stall-capable
 * state cannot be added without an explicit exit.
 */
type Classification = {
  observable: readonly string[]
  architect: readonly string[]
  /** States that may end the lifecycle with no exit. Everything else needs one. */
  terminal: readonly string[]
}

const classification: Record<keyof typeof lifecycleMachines, Classification> = {
  task: {
    observable: [
      "READY",
      "DISPATCH",
      "VERIFY",
      "ACCEPT",
      "FAIL",
      "EXHAUST",
      "REPAIR",
      "BLOCK",
      "INCORPORATE",
    ],
    architect: [
      "CANCEL",
      "RETRY",
      "RESUME",
      "RECONCILE",
      "ADOPT_ACCEPT",
      "RETAINED_ACCEPT",
      "RETAINED_REPAIR",
    ],
    terminal: ["incorporated"],
  },
  dispatch: { observable: [], architect: ["PAUSE", "UNPAUSE"], terminal: [] },
  capacity: {
    observable: ["queued", "admitted", "released", "cancelled"],
    architect: [],
    terminal: [],
  },
  source: { observable: ["PREPARE", "ACTIVATE", "RETIRE"], architect: [], terminal: [] },
  contact: { observable: [], architect: ["PAUSE", "UNPAUSE"], terminal: [] },
  // Owner controls: a project or global pause is lifted by hand.
  pause: {
    observable: [],
    architect: [
      "PROJECT_DISPATCH_PAUSED",
      "PROJECT_DISPATCH_UNPAUSED",
      "GLOBAL_DISPATCH_PAUSED",
      "GLOBAL_DISPATCH_UNPAUSED",
    ],
    terminal: [],
  },
  // A profile revision is active until the project's next revision supersedes it.
  profile: {
    observable: ["SUPERSEDED"],
    architect: [],
    terminal: ["superseded"],
  },
  plan: {
    observable: ["blocked", "accepted", "cancelled", "cleanup-blocked", "integrated"],
    architect: ["running", "cancelling", "cleaning"],
    terminal: ["integrated"],
  },
  attempt: {
    observable: ["failed", "running", "verifying", "accepted"],
    architect: ["preparing", "cancelled"],
    terminal: [],
  },
  effect: {
    observable: ["completed", "uncertain", "failed", "held", "intended"],
    architect: [],
    terminal: ["completed", "failed"],
  },
  outbox: {
    observable: ["pending", "delivered"],
    architect: ["superseded"],
    terminal: ["delivered", "superseded"],
  },
  renewal: {
    observable: [
      "creating",
      "archiving",
      "deferred",
      "rolling-back",
      "committed",
      "recovering-input",
      "archive-failed",
    ],
    architect: [],
    terminal: [],
  },
  adoption: {
    observable: ["pending", "task-checks", "combined-checks", "held", "accepted", "failed"],
    architect: ["cancelled"],
    terminal: ["accepted", "failed", "cancelled"],
  },
  retained: {
    observable: ["pending", "task-checks", "failed", "accepted", "cancelled"],
    architect: [],
    terminal: ["accepted", "failed", "cancelled"],
  },
  resource: {
    observable: ["creating", "active", "uncertain", "removed"],
    architect: [],
    terminal: [],
  },
  check: {
    observable: ["intended", "completed", "uncertain"],
    architect: [],
    terminal: [],
  },
  cleanup: { observable: ["pending", "complete", "failed"], architect: [], terminal: [] },
  workspace: {
    observable: ["unallocated", "reserved", "owned", "uncertain", "removed"],
    architect: [],
    terminal: [],
  },
  // The notice is sent or the worker is already stopped, the handoff is saved or its window
  // passes, the worker goes quiet; a plan cancellation cancels an open takeover.
  takeover: {
    observable: ["notifying", "awaiting-handoff", "stopping", "taken-over"],
    architect: ["cancelled"],
    terminal: ["taken-over", "cancelled"],
  },
  // A stored plan: every state is left by tasking or abandoning; the observable fact is the
  // review settling with questions open; the rest are Architect or owner actions.
  planning: {
    observable: ["questions-open"],
    architect: ["drafted", "in-review", "final-review", "ready", "tasked", "abandoned"],
    terminal: ["tasked", "abandoned"],
  },
  // One agent's attempt ends by its reply, a failure, the inactivity span, or cancellation.
  planningRun: {
    observable: ["starting", "running", "reviewed", "failed", "stuck"],
    architect: ["cancelled"],
    terminal: ["reviewed", "failed", "stuck", "cancelled"],
  },
  // The backfill reaches the last row, the integer indexes are built, the text indexes are dropped.
  identityKeys: {
    observable: ["backfilling", "indexing", "keyed", "text-retired"],
    architect: [],
    terminal: ["text-retired"],
  },
}

type StateConfig = { on?: Record<string, unknown>; type?: string }

test("every machine is classified", () => {
  expect(Object.keys(classification).sort()).toEqual(Object.keys(lifecycleMachines).sort())
})

test("every event is classified as observable or an Architect action", () => {
  for (const [domain, machine] of Object.entries(lifecycleMachines)) {
    const known = new Set([
      ...classification[domain as keyof typeof classification].observable,
      ...classification[domain as keyof typeof classification].architect,
    ])
    for (const [state, config] of Object.entries(machine.config.states ?? {}) as [
      string,
      StateConfig,
    ][])
      for (const event of Object.keys(config.on ?? {}))
        expect(known.has(event), `${domain}.${state} event ${event} is unclassified`).toBe(true)
  }
})

test("no non-terminal state is a dead end", () => {
  for (const [domain, machine] of Object.entries(lifecycleMachines)) {
    const { observable, architect, terminal } =
      classification[domain as keyof typeof classification]
    const exits = new Set([...observable, ...architect])
    for (const [state, config] of Object.entries(machine.config.states ?? {}) as [
      string,
      StateConfig,
    ][]) {
      if (config.type === "final" || terminal.includes(state)) continue
      const current = machine.resolveState({ value: state, context: {} })
      const reachable = Object.keys(config.on ?? {}).filter((event) => {
        if (!exits.has(event) || !current.can({ type: event })) return false
        return transition(machine, current, { type: event })[0].value !== state
      })
      expect(reachable.length, `${domain}.${state} has no outgoing exit`).toBeGreaterThan(0)
    }
  }
})

test("a state declared terminal really has no exit", () => {
  for (const [domain, machine] of Object.entries(lifecycleMachines)) {
    for (const state of classification[domain as keyof typeof classification].terminal) {
      const config = (machine.config.states?.[state] ?? {}) as StateConfig
      const current = machine.resolveState({ value: state, context: {} })
      const leaves = Object.keys(config.on ?? {}).filter(
        (event) =>
          current.can({ type: event }) &&
          transition(machine, current, { type: event })[0].value !== state,
      )
      expect(leaves, `${domain}.${state} is declared terminal but has exits`).toEqual([])
    }
  }
})
