import { randomUUID } from "node:crypto"
import { DEFAULT_CONSTANTS, type DecisionConstants } from "./constants.ts"
import { decide, type Decider, type DecisionNode, type DecisionOutcome } from "./procedure.ts"
import { decisionNote, type DecisionDelivery } from "../render.ts"
import type { DecisionNodeRow, DecisionRow, PlanningStore } from "../store.ts"

/** The marker every outcome notice carries; such a message is not an ask. */
const NOTICE = "[lz-notice "

export type PlanningServiceDeps = {
  store: PlanningStore
  projectKey: string
  /** Read at each ask: the local window comes and goes. `undefined` when no decision model is set up. */
  decider: () => Decider | undefined | Promise<Decider | undefined>
  now?: () => number
  /** Read at each ask, so a Settings change applies to the next one. */
  constants?: Partial<DecisionConstants> | (() => Partial<DecisionConstants>)
  /** The planning runbook for the first decided note of a session; its pointer afterwards. */
  runbook?: (
    first: boolean,
    context: { size: string | null; sessionID: string },
  ) => string | undefined
  wait?: (ms: number) => Promise<void>
}

type Pending = {
  id: string
  sessionID: string
  messageID: string
  text: string
  startedAt: number
  done: Promise<void>
}

const summary = (outcome: DecisionOutcome) =>
  outcome.status === "decided"
    ? {
        status: outcome.status,
        size: outcome.size,
        scores: outcome.scores,
        selected: outcome.selected,
        stopped: outcome.stopped,
        modelMs: outcome.modelMs,
      }
    : {
        status: outcome.status,
        reason: outcome.reason,
        error: outcome.error,
        modelMs: outcome.modelMs,
      }

const nodeRows = (decisionID: string, nodes: readonly DecisionNode[]): DecisionNodeRow[] =>
  nodes.map((node) => ({
    decisionId: decisionID,
    nodeId: node.id,
    parentId: node.parent,
    depth: node.depth,
    spanStart: node.span.start,
    spanEnd: node.span.end,
    kind: node.span.kind,
    callsJson: JSON.stringify(node.calls),
    outcome: node.outcome,
    inputTokens: node.calls.reduce((sum, call) => sum + call.inputTokens, 0),
    elapsedMs: node.calls.reduce((sum, call) => sum + call.elapsedMs, 0),
  }))

/**
 * Decides on each Architect ask and delivers one stable note. The decision starts without being
 * awaited by the prompt hook; the `context` hook waits at most `deliveryWaitMs` for it, and a
 * result that arrives later is recorded for measurement and never replaces what was delivered.
 */
export class PlanningDecisions {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly deps: PlanningServiceDeps) {}

  private get constants(): DecisionConstants {
    const given = this.deps.constants
    return { ...DEFAULT_CONSTANTS, ...(typeof given === "function" ? given() : given) }
  }
  private now() {
    return (this.deps.now ?? Date.now)()
  }
  private key(sessionID: string, messageID: string) {
    return `${sessionID}\u0000${messageID}`
  }

  /** Messages of a session that have a decision, recorded or still running. */
  messagesFor(sessionID: string): { messageId: string; askText: string }[] {
    const recorded = this.deps.store
      .sessionDecisions(sessionID)
      .map((row) => ({ messageId: row.messageId, askText: row.askText }))
    const running = [...this.pending.values()]
      .filter((entry) => entry.sessionID === sessionID)
      .map((entry) => ({ messageId: entry.messageID, askText: entry.text }))
    return [
      ...recorded,
      ...running.filter((r) => !recorded.some((x) => x.messageId === r.messageId)),
    ]
  }

  /** Never throws into the caller and is never awaited by it. */
  start(input: { sessionID: string; messageID: string; text: string; agent: string }): void {
    try {
      const { sessionID, messageID, text, agent } = input
      if (agent !== "architect" || text.includes(NOTICE) || !text.trim()) return
      const key = this.key(sessionID, messageID)
      if (this.pending.has(key) || this.deps.store.decision(sessionID, messageID)) return
      const entry: Pending = {
        id: randomUUID(),
        sessionID,
        messageID,
        text,
        startedAt: this.now(),
        done: Promise.resolve(),
      }
      this.pending.set(key, entry)
      entry.done = this.run(sessionID, messageID, entry).catch(() => undefined)
    } catch {
      // A decision is advisory; a failure here must not reach the prompt.
    }
  }

  private async run(sessionID: string, messageID: string, entry: Pending) {
    const { store } = this.deps
    const begin = this.now()
    const decider = await this.deps.decider()
    const outcome: DecisionOutcome = decider
      ? await decide(entry.text, {
          decider,
          clock: () => this.now(),
          constants: this.constants,
          signal: new AbortController().signal,
        }).catch((error): DecisionOutcome => ({
          status: "unavailable",
          reason: "error",
          error: String(error),
          nodes: [],
          modelMs: 0,
        }))
      : { status: "unavailable", reason: "no-model", nodes: [], modelMs: 0 }
    const rows = nodeRows(entry.id, outcome.nodes)
    const existing = store.decision(sessionID, messageID)
    if (existing) {
      // Delivered already (timeout): keep what was delivered, record what came late.
      store.updateDecision(existing.id, { lateJson: JSON.stringify(summary(outcome)) })
      store.addDecisionNodes(nodeRows(existing.id, outcome.nodes))
      return
    }
    store.recordDecision(this.row(sessionID, messageID, entry, outcome, decider, begin), rows)
  }

  private row(
    sessionID: string,
    messageID: string,
    entry: Pending,
    outcome: DecisionOutcome,
    decider: Decider | undefined,
    begin: number,
  ): DecisionRow {
    const c = this.constants
    return {
      id: entry.id,
      projectKey: this.deps.projectKey,
      sessionId: sessionID,
      messageId: messageID,
      createdAt: entry.startedAt,
      askText: entry.text,
      askChars: entry.text.length,
      strategy: c.strategy,
      decider: decider?.id ?? null,
      deciderModel: decider?.model ?? null,
      status: outcome.status === "decided" ? "decided" : "unavailable",
      reason: outcome.status === "unavailable" ? outcome.reason : (outcome.stopped ?? null),
      size: outcome.status === "decided" ? outcome.size : null,
      scoresJson: outcome.status === "decided" ? JSON.stringify(outcome.scores) : null,
      selectedJson: outcome.status === "decided" ? JSON.stringify(outcome.selected) : null,
      threshold: c.agentThreshold,
      constantsJson: JSON.stringify(c),
      modelMs: outcome.modelMs,
      elapsedMs: this.now() - begin,
      calls: outcome.nodes.reduce((sum, node) => sum + node.calls.length, 0),
      openPlanningIdsJson: JSON.stringify(
        this.deps.store.plannings(sessionID, true).map((plan) => plan.id),
      ),
    }
  }

  /**
   * The note for one user message, or `undefined` when no decision was started for it. Waits for
   * the decision until `deliveryWaitMs` after it started, then fixes the text once.
   */
  async noteFor(sessionID: string, messageID: string): Promise<string | undefined> {
    try {
      const { store } = this.deps
      let row = store.decision(sessionID, messageID)
      if (row?.deliveredText) return row.deliveredText
      const entry = this.pending.get(this.key(sessionID, messageID))
      if (!row) {
        if (!entry) return undefined
        const remaining = Math.max(0, entry.startedAt + this.constants.deliveryWaitMs - this.now())
        const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
        await Promise.race([entry.done, wait(remaining)])
        row = store.decision(sessionID, messageID)
        if (!row) {
          store.recordDecision(
            this.row(
              sessionID,
              messageID,
              entry,
              { status: "unavailable", reason: "error", nodes: [], modelMs: 0 },
              undefined,
              entry.startedAt,
            ),
          )
          store.updateDecision(entry.id, { reason: "timeout", decider: null })
          row = store.decision(sessionID, messageID)!
        }
        if (row.deliveredText) return row.deliveredText
      }
      const earlier = store
        .sessionDecisions(sessionID)
        .some((other) => other.id !== row!.id && other.deliveredText?.includes(RUNBOOK_MARK))
      const delivery: DecisionDelivery = {}
      const runbook = this.deps.runbook?.(!earlier, { size: row.size ?? null, sessionID })
      if (runbook && row.size !== "one task") delivery.runbook = `${RUNBOOK_MARK}\n${runbook}`
      const text = decisionNote(
        row,
        store.plannings(sessionID, true).map((plan) => ({ title: plan.title, state: plan.state })),
        delivery,
      )
      store.updateDecision(row.id, { deliveredText: text })
      return text
    } catch {
      return undefined
    }
  }
}

const RUNBOOK_MARK = "[lz-runbook planning]"

export function startDecision(
  service: PlanningDecisions,
  input: { sessionID: string; messageID: string; text: string; agent: string },
): void {
  service.start(input)
}
