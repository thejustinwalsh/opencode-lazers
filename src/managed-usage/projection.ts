import { canonical } from "../identity.ts"
import { isWorkerAgent } from "../runner/worker-agent.ts"
import type {
  ManagedUsageAssociation,
  ManagedUsageCategories,
  ManagedUsageNativeFact,
  ManagedUsageRoute,
} from "./contract.ts"
import { ManagedUsageCategoriesSchema } from "./contract.ts"
import type { ManagedUsageBoundary, ManagedUsageSnapshot, ManagedUsageStoredFact } from "./store.ts"

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

function emptyAssociation(reason: string) {
  return {
    association: { kind: "unallocated" as const },
    associationRevision: null,
    associationBoundarySequence: null,
    associationReason: reason,
  }
}

function uniqueStart(facts: readonly ManagedUsageNativeFact[]) {
  const semantic = new Map(facts.map((fact) => [semanticStart(fact), fact]))
  return semantic.size === 1 ? [...semantic.values()][0]! : null
}

type BoundarySelection =
  { kind: "selected"; boundary: ManagedUsageBoundary } | { kind: "rejected"; reason: string }

function explicitBoundary(
  start: ManagedUsageNativeFact,
  boundaries: ManagedUsageSnapshot["boundaries"],
): BoundarySelection {
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
  if (!boundary)
    return { kind: "rejected", reason: "Generation began before an explicit enrollment boundary" }
  if (boundary.agent !== start.agent)
    return {
      kind: "rejected",
      reason: "Generation agent differs from the explicitly enrolled session role",
    }
  return { kind: "selected", boundary }
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
  if (sourceConflict) return emptyAssociation("Conflicting native event identity")
  if (!facts.length) return emptyAssociation("Native generation start was not observed")
  const start = uniqueStart(facts)
  if (!start) return emptyAssociation("Native generation start evidence conflicts")
  if (start.sequence === null)
    return emptyAssociation("Native generation start has no durable sequence")
  if (!start.agent || isWorkerAgent(start.agent))
    return emptyAssociation("Native generation agent is not an authorized managed role")
  const selected = explicitBoundary(start, boundaries)
  if (selected.kind === "rejected") return emptyAssociation(selected.reason)
  const { boundary } = selected
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
  if (hasCategoryStatus(input.categories, "unavailable")) return "unavailable"
  if (completeGenerationEvidence(input)) return "observed"
  return allCategoriesMissing(input.categories) ? "missing" : "partial"
}

function hasCategoryStatus(categories: ManagedUsageCategories, status: string) {
  return Object.values(categories).some((category) => category.status === status)
}

function allCategoriesMissing(categories: ManagedUsageCategories) {
  return Object.values(categories).every((category) => category.status === "missing")
}

function completeGenerationEvidence(input: {
  categories: ManagedUsageCategories
  routeStatus: ManagedUsageGeneration["routeStatus"]
  association: ManagedUsageAssociation
}) {
  const allCategoriesObserved = Object.values(input.categories).every(
    (category) => category.status === "observed",
  )
  const routeRequired = Object.values(input.categories).some(
    (category) => (category.tokens ?? 0) > 0,
  )
  const routeResolved = input.routeStatus === "observed"
  const associated = input.association.kind !== "unallocated"
  return allCategoriesObserved && (!routeRequired || routeResolved) && associated
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
  const exactStart = uniqueStart(starts) ?? undefined
  const status = startRouteStatus(exactStart, starts)
  const route = exactStart?.route ?? null
  const conflicts =
    sourceConflict ||
    starts.some((fact) => routeKey(fact.route, fact.routeStatus) !== routeKey(route, status))
  return conflicts
    ? { exactStart, route: null, status: "conflicting" as const }
    : { exactStart, route, status }
}

function startRouteStatus(
  exactStart: ManagedUsageNativeFact | undefined,
  starts: readonly ManagedUsageNativeFact[],
): ManagedUsageGeneration["routeStatus"] {
  if (!exactStart) return starts.length ? "conflicting" : "missing"
  if (exactStart.routeStatus === "observed") return "observed"
  if (exactStart.routeStatus === "missing") return "missing"
  return "invalid"
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
