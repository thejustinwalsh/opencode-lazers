import { canonical } from "../identity.ts"
import { isWorkerAgent } from "../runner/worker-agent.ts"
import type {
  ManagedUsageAssociation,
  ManagedUsageCategories,
  ManagedUsageNativeFact,
  ManagedUsageRoute,
} from "./contract.ts"
import { ManagedUsageCategoriesSchema } from "./contract.ts"
import type { ManagedUsageSnapshot, ManagedUsageStoredFact } from "./store.ts"

export type ManagedUsageGeneration = {
  sessionID: string
  assistantMessageID: string
  startSequence: number | null
  terminalSequence: number | null
  startEventIDs: string[]
  terminalEventIDs: string[]
  eventFactCount: number
  provenanceTruncated: boolean
  route: ManagedUsageRoute | null
  routeStatus: "observed" | "missing" | "invalid" | "conflicting"
  categories: ManagedUsageCategories
  outcome: "succeeded" | "failed" | "pending" | "conflicting"
  status: "observed" | "partial" | "missing" | "unavailable"
  association: ManagedUsageAssociation
  associationRevision: number | null
  associationBoundarySequence: number | null
  associationReason: string | null
}

function key(sessionID: string, messageID: string) {
  return `${sessionID}\u0000${messageID}`
}

function routeKey(route: ManagedUsageRoute | null, status: string) {
  return canonical({ route, status })
}

function semanticStart(fact: ManagedUsageNativeFact) {
  return canonical({
    sequence: fact.sequence,
    agent: fact.agent,
    routeStatus: fact.routeStatus,
    route: fact.route,
  })
}

function semanticTerminal(fact: ManagedUsageNativeFact) {
  return canonical({ eventType: fact.eventType, categories: fact.categories })
}

function unknownCategories(status: "missing" | "unavailable"): ManagedUsageCategories {
  return ManagedUsageCategoriesSchema.parse(
    Object.fromEntries(
      ["uncachedInput", "output", "reasoning", "cacheRead", "cacheWrite"].map((category) => [
        category,
        { tokens: null, status },
      ]),
    ),
  )
}

function terminalCategories(facts: readonly ManagedUsageNativeFact[]): {
  categories: ManagedUsageCategories
  outcome: ManagedUsageGeneration["outcome"]
  sequence: number | null
} {
  if (!facts.length)
    return { categories: unknownCategories("missing"), outcome: "pending", sequence: null }
  const distinct = new Map(facts.map((fact) => [semanticTerminal(fact), fact]))
  if (distinct.size !== 1) {
    return {
      categories: unknownCategories("unavailable"),
      outcome: "conflicting",
      sequence: null,
    }
  }
  const selected = [...distinct.values()][0]!
  return {
    categories: selected.categories ?? unknownCategories("missing"),
    outcome: selected.eventType === "ended" ? "succeeded" : "failed",
    sequence: selected.sequence,
  }
}

function associationForStart(
  facts: readonly ManagedUsageNativeFact[],
  boundaries: ManagedUsageSnapshot["boundaries"],
  sourceConflict: boolean,
): Pick<
  ManagedUsageGeneration,
  "association" | "associationRevision" | "associationBoundarySequence" | "associationReason"
> {
  const empty = (reason: string) => ({
    association: { kind: "unallocated" as const },
    associationRevision: null,
    associationBoundarySequence: null,
    associationReason: reason,
  })
  if (sourceConflict) return empty("Conflicting native event identity")
  if (facts.length === 0) return empty("Native generation start was not observed")
  const semantic = new Map(facts.map((fact) => [semanticStart(fact), fact]))
  if (semantic.size !== 1) return empty("Native generation start evidence conflicts")
  const start = [...semantic.values()][0]!
  if (start.sequence === null) return empty("Native generation start has no durable sequence")
  if (!start.agent || isWorkerAgent(start.agent))
    return empty("Native generation agent is not an authorized managed role")
  const boundary = boundaries
    .filter(
      (candidate) =>
        candidate.sessionID === start.sessionID && candidate.boundarySequence < start.sequence!,
    )
    .sort(
      (left, right) =>
        left.boundarySequence - right.boundarySequence || left.revision - right.revision,
    )
    .reverse()
    .find((candidate) => candidate.excludedAssistantMessageID !== start.assistantMessageID)
  if (!boundary) return empty("Generation began before an explicit enrollment boundary")
  if (boundary.agent !== start.agent)
    return empty("Generation agent differs from the explicitly enrolled session role")
  return {
    association: boundary.association,
    associationRevision: boundary.revision,
    associationBoundarySequence: boundary.boundarySequence < 0 ? null : boundary.boundarySequence,
    associationReason: null,
  }
}

function eventIDs(facts: readonly ManagedUsageNativeFact[]) {
  const ids = [
    ...new Set(facts.flatMap((fact) => (fact.nativeEventID ? [fact.nativeEventID] : []))),
  ].sort()
  return { values: ids.slice(0, 20), truncated: ids.length > 20 }
}

function generationStatus(input: {
  starts: readonly ManagedUsageNativeFact[]
  terminals: readonly ManagedUsageNativeFact[]
  sourceConflict: boolean
  routeStatus: ManagedUsageGeneration["routeStatus"]
  categories: ManagedUsageCategories
  association: ManagedUsageAssociation
}): ManagedUsageGeneration["status"] {
  if (input.sourceConflict || input.terminals.some((fact) => !fact.categories)) return "unavailable"
  if (!input.terminals.length) return "partial"
  if (Object.values(input.categories).some((category) => category.status === "unavailable"))
    return "unavailable"
  const allCategoriesObserved = Object.values(input.categories).every(
    (category) => category.status === "observed",
  )
  const routeRequired = Object.values(input.categories).some(
    (category) => (category.tokens ?? 0) > 0,
  )
  const routeResolved = input.routeStatus === "observed"
  const associated = input.association.kind !== "unallocated"
  if (allCategoriesObserved && (!routeRequired || routeResolved) && associated) return "observed"
  if (allCategoriesObserved && !routeRequired && !associated) return "partial"
  return Object.values(input.categories).every((category) => category.status === "missing")
    ? "missing"
    : "partial"
}

type GenerationFacts = {
  facts: ManagedUsageStoredFact[]
  conflictKeys: ReadonlySet<string>
}

function groupGenerationFacts(snapshot: ManagedUsageSnapshot) {
  const conflictKeys = new Set(
    snapshot.factConflicts.map((fact) => `${fact.sessionID}\u0000${fact.eventKey}`),
  )
  const byCall = new Map<string, ManagedUsageStoredFact[]>()
  for (const fact of [...snapshot.facts, ...snapshot.factConflicts]) {
    const callKey = key(fact.sessionID, fact.assistantMessageID)
    const values = byCall.get(callKey) ?? []
    values.push(fact)
    byCall.set(callKey, values)
  }
  return [...byCall.values()].map((facts) => ({ facts, conflictKeys }))
}

function routeEvidence(starts: readonly ManagedUsageNativeFact[], sourceConflict: boolean) {
  const semantics = new Map(starts.map((fact) => [semanticStart(fact), fact]))
  const exactStart = semantics.size === 1 ? [...semantics.values()][0] : undefined
  let route = exactStart?.route ?? null
  let status: ManagedUsageGeneration["routeStatus"] = exactStart
    ? exactStart.routeStatus === "observed"
      ? "observed"
      : exactStart.routeStatus === "missing"
        ? "missing"
        : "invalid"
    : starts.length
      ? "conflicting"
      : "missing"
  if (
    sourceConflict ||
    starts.some((fact) => routeKey(fact.route, fact.routeStatus) !== routeKey(route, status))
  ) {
    route = null
    status = "conflicting"
  }
  return { exactStart, route, status }
}

function terminalEvidence(
  terminals: readonly ManagedUsageNativeFact[],
  exactStart: ManagedUsageNativeFact | undefined,
  sourceConflict: boolean,
) {
  const terminal = terminalCategories(terminals)
  const terminalBeforeStart =
    exactStart?.sequence !== null &&
    exactStart?.sequence !== undefined &&
    terminal.sequence !== null &&
    terminal.sequence <= exactStart.sequence
  const conflict = sourceConflict || terminalBeforeStart
  return {
    terminal,
    conflict,
    categories:
      conflict && terminals.length > 0 ? unknownCategories("unavailable") : terminal.categories,
    associationConflict: conflict,
  }
}

function generationFromFacts(
  entry: GenerationFacts,
  boundaries: ManagedUsageSnapshot["boundaries"],
): ManagedUsageGeneration {
  const first = entry.facts[0]!
  const starts = entry.facts.filter((fact) => fact.eventType === "started")
  const terminals = entry.facts.filter((fact) => fact.eventType !== "started")
  const sourceConflict = entry.facts.some((fact) =>
    entry.conflictKeys.has(`${fact.sessionID}\u0000${fact.eventKey}`),
  )
  const route = routeEvidence(starts, sourceConflict)
  const terminal = terminalEvidence(terminals, route.exactStart, sourceConflict)
  const association = associationForStart(starts, boundaries, terminal.associationConflict)
  const startProvenance = eventIDs(starts)
  const terminalProvenance = eventIDs(terminals)
  return {
    sessionID: first.sessionID,
    assistantMessageID: first.assistantMessageID,
    startSequence: route.exactStart?.sequence ?? null,
    terminalSequence: terminal.terminal.sequence,
    startEventIDs: startProvenance.values,
    terminalEventIDs: terminalProvenance.values,
    eventFactCount: entry.facts.length,
    provenanceTruncated: startProvenance.truncated || terminalProvenance.truncated,
    route: route.route,
    routeStatus: route.status,
    categories: terminal.categories,
    outcome: terminal.conflict ? "conflicting" : terminal.terminal.outcome,
    status: generationStatus({
      starts,
      terminals,
      sourceConflict: terminal.conflict,
      routeStatus: route.status,
      categories: terminal.categories,
      association: association.association,
    }),
    ...association,
  }
}

export function managedUsageGenerations(snapshot: ManagedUsageSnapshot): ManagedUsageGeneration[] {
  return groupGenerationFacts(snapshot)
    .map((entry) => generationFromFacts(entry, snapshot.boundaries))
    .sort(
      (left, right) =>
        left.sessionID.localeCompare(right.sessionID) ||
        left.assistantMessageID.localeCompare(right.assistantMessageID),
    )
}
