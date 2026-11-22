import { lifecycleMachines, type PlanLifecycleState } from "./lifecycle-machines.ts"
import type { CommandInput } from "./schema.ts"

type PlanAction = CommandInput["action"]

/**
 * Which plan states each Architect command may start from.
 *
 * `event` is the plan-machine event the command drives; legality asks
 * `lifecycleMachines.plan` whether the current state accepts it. `from`
 * narrows the machine to the states where the command is a meaningful
 * request (for example `run` admits a draft or a held plan, not a running
 * one). A command with no `event` changes no plan state and is decided by
 * `from` alone. The caller never supplies a version: the recorded state is
 * the authority.
 */
const PLAN_COMMANDS: Readonly<
  Record<PlanAction, { event?: string; from: readonly PlanLifecycleState[] | "any" }>
> = {
  run: { event: "running", from: ["draft", "blocked"] },
  cancel: {
    event: "cancelling",
    from: ["draft", "running", "blocked", "accepted", "cancelling", "cleaning"],
  },
  pause: { from: ["draft", "running", "blocked"] },
  unpause: { from: ["draft", "running", "blocked"] },
  audit: { from: "any" },
  reconcile: {
    from: [
      "draft",
      "running",
      "blocked",
      "accepted",
      "cancelling",
      "cancelled",
      "failed",
      "cleaning",
      "cleanup-blocked",
    ],
  },
  reassign: { from: "any" },
  resume: { event: "running", from: ["blocked", "cancelled", "failed", "running"] },
  retry: { event: "running", from: ["blocked", "cancelled", "failed", "running"] },
  integrated: { event: "cleaning", from: ["accepted", "cleanup-blocked"] },
  schedule: { from: ["draft", "running", "blocked"] },
  "amend-scope": { from: ["draft", "running", "blocked", "cancelling", "cleaning"] },
  "adopt-descendant": { from: ["blocked"] },
  "settle-startup": { from: ["blocked"] },
  "retained-repair": { event: "running", from: ["running", "accepted", "blocked"] },
  "verify-retained": { from: ["blocked", "accepted", "cleanup-blocked"] },
  "takeover-submit": { from: ["running", "blocked"] },
}

/** Commands that read or administer the plan; never advertised as a next step. */
const UNADVERTISED: ReadonlySet<PlanAction> = new Set(["audit", "reassign"])

export const planCommandTable = PLAN_COMMANDS

function machineAccepts(state: string, event: string) {
  try {
    return lifecycleMachines.plan.resolveState({ value: state, context: {} }).can({ type: event })
  } catch {
    // A legacy persisted state the machine no longer declares accepts nothing.
    return false
  }
}

/**
 * Plan-level `integrated`, `resume` and `retry` without a task keep narrower
 * rules than their task-scoped forms. A task-scoped `integrated` is decided by
 * the task's own accepted artifact, not by the plan state.
 */
function legal(state: string, action: PlanAction, command?: Pick<CommandInput, "taskID">) {
  if (action === "integrated" && command?.taskID) return state !== "integrated"
  if (action === "resume" && command && !command.taskID) return state === "blocked"
  const spec = PLAN_COMMANDS[action]
  if (spec.from !== "any" && !(spec.from as readonly string[]).includes(state)) return false
  return spec.event ? machineAccepts(state, spec.event) : true
}

/** Actions the plan's current recorded state accepts, in a stable order. */
export function availablePlanCommands(state: string): PlanAction[] {
  return (Object.keys(PLAN_COMMANDS) as PlanAction[]).filter(
    (action) => !UNADVERTISED.has(action) && legal(state, action),
  )
}

/** A specific, actionable rejection for an action the current state does not accept. */
export function planCommandProblem(
  state: string,
  command: Pick<CommandInput, "action" | "taskID">,
): string | undefined {
  if (legal(state, command.action, command)) return undefined
  const available = availablePlanCommands(state)
  return `Plan is ${state}; ${command.action} is not available. Available: ${
    available.length ? available.join(", ") : "none"
  }.`
}

/**
 * The plan version the runtime read when it began handling a command moved
 * before its transaction (a scheduler tick, another command). The command is
 * re-read and re-evaluated against the machine, a bounded number of times.
 */
export class PlanMovedDuringCommand extends Error {
  constructor() {
    super("Plan changed while the command was being applied")
    this.name = "PlanMovedDuringCommand"
  }
}

/**
 * Earlier Architect prompts sent an optimistic `expectedVersion`. It no longer
 * decides anything: drop it before validation so an in-flight session whose
 * prompt still names the field does not start failing. The schema neither
 * documents nor accepts it.
 */
export function withoutLegacyVersion(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input
  if (!Object.hasOwn(input, "expectedVersion")) return input
  const { expectedVersion: _legacy, ...rest } = input as Record<string, unknown>
  return rest
}
