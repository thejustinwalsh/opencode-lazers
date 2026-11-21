import { coalescedOutcomeText, outcomeText } from "./outcome.ts"
import type { Delivery } from "../guidance/index.ts"
import { RecoveryBundle, recoveryBundleText } from "./recovery-bundle.ts"
import type { ContextMessage } from "./context-stubs.ts"

/** Test fixtures: messages shaped like the model-request messages, notices rendered by the real renderers. */
export type Msg = ContextMessage & { content: unknown }

export const planID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
export const taskID = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function payload(status: string, plan: number, version: number, extra: object = {}) {
  return JSON.stringify({
    planID: planID(plan),
    planRevision: 1,
    version,
    status,
    ...(status === "blocked"
      ? {
          reason: "Dispatch failed: the worker session was lost while the check ran",
          allowedActions: ["retry", "cancel"],
        }
      : {}),
    currentPlan: { state: status === "integrated" ? "integrated" : "running", reason: null },
    reviewableTasks: [],
    ...extra,
  })
}

/** One notice as the runtime renders it. */
export function notice(status: string, plan: number, version: number, extra: object = {}) {
  return outcomeText(payload(status, plan, version, extra), "ONS", { planID: planID(plan) })
}

/** One coalesced notice over several plans, as the delivery renders it. */
export function coalesced(
  entries: Array<{ status: string; plan: number; version: number; extra?: object }>,
  delivery?: Delivery,
) {
  return coalescedOutcomeText(
    entries.map((e) => ({
      planID: planID(e.plan),
      payload: payload(e.status, e.plan, e.version, e.extra),
    })),
    "ONS",
    delivery,
  )
}

export function bundle(plan: number, generation: number, concern = false) {
  const item = {
    key: `k${generation}`,
    kind: concern ? "worker-concern" : "held-plan",
    planID: planID(plan),
    taskID: null,
    reference: "ONS-1",
    title: "Fix the parser",
    state: "blocked",
    stateLabel: "Blocked",
    explanation: null,
    reason: "Dispatch failed",
    holdFamily: null,
    ageMs: 7_200_000,
    actions: ["retry"],
    reuse: {
      artifact: null,
      artifactInLanding: null,
      checksPassed: null,
      worktree: null,
      worker: "none",
    },
    recommendation: { action: "retry", because: "the cause was transient" },
    ...(concern
      ? {
          concern: {
            concernID: "c1",
            version: 1,
            ruleID: "r1",
            line: "stuck",
            boundary: { fromSequence: 0, throughSequence: 1 },
          },
        }
      : {}),
  }
  return recoveryBundleText(
    JSON.stringify(
      RecoveryBundle.parse({
        status: "recovery-bundle",
        planID: planID(plan),
        version: 3,
        raisedAt: 1_700_000_000_000,
        generation,
        count: 1,
        planIDs: [planID(plan)],
        staleAfterMs: 3_600_000,
        replaces: generation > 1 ? "earlier" : null,
        items: [item],
      }),
    ),
  )
}

export const user = (id: string, text: string): Msg => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
})
export const assistantText = (id: string, text: string): Msg => ({
  id,
  role: "assistant",
  content: [{ type: "text", text }],
})
export const call = (id: string, callID: string, name: string, input: unknown): Msg => ({
  id,
  role: "assistant",
  content: [{ type: "tool-call", id: callID, name, input }],
})
export const result = (callID: string, name: string, text: string): Msg => ({
  role: "tool",
  content: [{ type: "tool-result", id: callID, name, result: { type: "text", value: text } }],
})
export const errorResult = (callID: string, name: string, text: string): Msg => ({
  role: "tool",
  content: [{ type: "tool-result", id: callID, name, result: { type: "error", value: text } }],
})

export const textOf = (message: Msg): string =>
  typeof message.content === "string"
    ? message.content
    : (message.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("")

/** Characters the model request carries for these messages. */
export const sizeOf = (messages: readonly Msg[]) => JSON.stringify(messages).length

/**
 * A session shaped like the measured one: 551 notices about 75 plans (blocked 349,
 * architect-source-change 83, accepted 33, integrated 29, task-accepted the rest), each followed by
 * an Architect turn that reads the plan back, plus plan and task submissions that stay in history.
 */
export function measuredSession(): Msg[] {
  let seed = 7
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const kinds = [
    ...Array<string>(349).fill("blocked"),
    ...Array<string>(83).fill("architect-source-change"),
    ...Array<string>(33).fill("accepted"),
    ...Array<string>(29).fill("integrated"),
    ...Array<string>(57).fill("task-accepted"),
  ]
  const versions = new Map<number, number>()
  const messages: Msg[] = [user("u0", "Start the backlog")]
  for (let i = 0; i < 551; i++) {
    const kind = kinds[next(kinds.length)]!
    kinds.splice(kinds.indexOf(kind), 1)
    const plan = i < 75 ? i + 1 : 1 + next(75)
    const version = (versions.get(plan) ?? 0) + 1
    versions.set(plan, version)
    messages.push(
      user(
        `n${i}`,
        notice(kind, plan, version, kind === "task-accepted" ? { taskID: taskID(plan) } : {}),
      ),
    )
    // The Architect reads the plan back after about one notice in four.
    if (i % 4 === 0) {
      const id = `c${i}`
      messages.push(call(`a${i}`, id, "lz-inspect-plan", { planID: planID(plan) }))
      messages.push(
        result(
          id,
          "lz-inspect-plan",
          JSON.stringify({ planID: planID(plan), nodes: "x".repeat(3800) }),
        ),
      )
    }
    // Every 30th notice, the Architect submits work whose input stays in history.
    if (i % 30 === 0) {
      const id = `s${i}`
      messages.push(
        call(`as${i}`, id, "lz-submit-task", {
          idempotencyKey: `key-${i}`,
          objective: "y".repeat(5200),
        }),
      )
      messages.push(
        result(
          id,
          "lz-submit-task",
          JSON.stringify({
            status: "submitted",
            taskID: taskID(i),
            reference: `ONS-${i}`,
            revision: 1,
          }),
        ),
      )
    }
  }
  return messages
}
