import type { AccountingAttempt } from "../trajectory/accounting.ts"
import { modelConfigurationID } from "./model-identity.ts"
import type { CurrentPriceIndex } from "./valuation-schema.ts"

/**
 * A deterministic synthetic history for the valuation tests: many sessions in every situation the
 * valuation distinguishes (native snapshots, cumulative snapshots, additive steps only, mixed
 * routes, lost identities, calls without a message id, repeated calls, attempt-only costs, zero
 * costs, sessions no attempt owns), interleaved in one global sequence like `runner_progress`.
 */
export type SeedRoute = { providerID: string; modelID: string; variant: string | null }
type SeedFact = Record<string, unknown> & { sequence: number; sessionID: string }

export const SEED_ROUTES: SeedRoute[] = [
  { providerID: "openrouter", modelID: "a-model", variant: "medium" },
  { providerID: "openrouter", modelID: "b-model", variant: "medium" },
  { providerID: "anthropic", modelID: "c-model", variant: null },
]

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const usage = (random: () => number, costUSD: number | null) => ({
  input: Math.floor(random() * 4000),
  output: Math.floor(random() * 900),
  reasoning: Math.floor(random() * 300),
  cacheRead: Math.floor(random() * 9000),
  cacheWrite: Math.floor(random() * 500),
  costUSD,
})

function attemptFor(
  id: string,
  sessionID: string,
  route: SeedRoute | null,
  extra: Partial<AccountingAttempt> = {},
): AccountingAttempt {
  return {
    id,
    sessionID,
    state: "accepted",
    legacyTokenCount: null,
    recordedCostUSD: null,
    planRoute: route,
    planRouteStatus: route ? "explicit" : "unavailable",
    frozenRoute: route,
    frozenRouteSource: "runner_attempt.policy",
    personaRequested: null,
    personaFrozen: null,
    sessionStatus: "missing",
    contextStatus: "not-read",
    currentRoute: null,
    currentRouteObservedAt: null,
    sessionUsage: null,
    sessionUsageObservedAt: null,
    stepRoutes: [],
    ...extra,
  }
}

export type SeedOptions = { sessions: number; callsPerSession: number; seed?: number }

export function seedHistory(options: SeedOptions) {
  const random = mulberry32(options.seed ?? 20_261_120)
  const attempts: AccountingAttempt[] = []
  const bySession: SeedFact[][] = []
  for (let index = 0; index < options.sessions; index++) {
    const sessionID = `ses-${String(index).padStart(5, "0")}`
    const route = SEED_ROUTES[index % SEED_ROUTES.length]!
    const scenario = index % 11
    const facts: Record<string, unknown>[] = []
    const calls = Math.max(1, Math.floor(random() * options.callsPerSession) + 1)
    const withRoute = (extra: Record<string, unknown> = {}, r: SeedRoute = route) => ({
      route: r,
      routeEvidence: { status: "observed", route: r },
      observations: [
        {
          source: "native-event",
          eventType: "message.updated",
          at: 1,
          messageID: null,
          eventID: null,
          route: r,
        },
      ],
      ...extra,
    })
    const step = (call: number, extra: Record<string, unknown> = {}, r: SeedRoute = route) => ({
      kind: "worker-step",
      messageID: `${sessionID}-m${call}`,
      measurementBasis: "additive-step-measurement",
      usage: usage(random, scenario === 8 ? 0 : random() < 0.3 ? null : random() / 50),
      ...withRoute({}, r),
      ...extra,
    })
    const snapshot = () => ({
      kind: "worker-usage-snapshot",
      messageID: null,
      measurementBasis: "cumulative-session-snapshot",
      usage: usage(random, scenario === 8 ? 0 : random()),
      ...withRoute(),
    })
    const attemptCount = scenario === 5 ? 2 : 1
    const owned = scenario !== 9
    if (owned)
      for (let a = 0; a < attemptCount; a++)
        attempts.push(
          attemptFor(`att-${index}-${a}`, sessionID, route, {
            state: a ? "failed" : "accepted",
            recordedCostUSD: scenario === 6 ? random() : scenario === 10 && a ? 0.0125 : null,
            sessionStatus: scenario === 0 || scenario === 6 ? "available" : "missing",
            contextStatus: scenario === 0 ? "available" : "not-read",
            currentRoute: scenario === 0 || scenario === 6 ? route : null,
            currentRouteObservedAt: 100 + index,
            sessionUsage: scenario === 0 ? usage(random, null) : null,
            sessionUsageObservedAt: scenario === 0 ? 5000 + index : null,
            stepRoutes:
              scenario === 0
                ? [{ messageID: `${sessionID}-m1`, route, observedAt: 7 }]
                : scenario === 3
                  ? [
                      {
                        messageID: `${sessionID}-m1`,
                        route: SEED_ROUTES[(index + 1) % 3]!,
                        observedAt: 8,
                      },
                    ]
                  : [],
          }),
        )
    if (scenario === 6) {
      bySession.push([])
      continue
    }
    for (let call = 0; call < calls; call++) {
      if (scenario === 3 && call % 2) facts.push(step(call, {}, SEED_ROUTES[(index + 1) % 3]!))
      else if (scenario === 4 && call === 1) facts.push(step(call, { messageID: null }))
      else if (scenario === 7 && call === 0)
        facts.push(
          step(call, {
            routeEvidence: {
              status: "observed",
              route: { providerID: "x", modelID: "[REDACTED]", variant: null },
            },
            route: { providerID: "x", modelID: "[REDACTED]", variant: null },
          }),
        )
      else facts.push(step(call))
      if (scenario === 5 && call === 0) facts.push(step(call, { usage: usage(random, 1) }))
      if (scenario === 1 && call % 4 === 3) facts.push(snapshot())
    }
    if (scenario === 1 || scenario === 10) facts.push(snapshot())
    bySession.push(
      facts.map((fact, offset) => ({
        id: "",
        sequence: 0,
        attemptID: owned ? `att-${index}-0` : `orphan-${index}`,
        sessionID,
        source: "runtime",
        sources: ["runtime"],
        eventIDs: [],
        at: 70_000 + index * 10 + offset,
        recordedAt: 70_001 + index * 10 + offset,
        timing: {
          endpoints: { completedAt: { at: 70_000 + index * 10 + offset, sourceType: "event" } },
        },
        ...fact,
      })) as SeedFact[],
    )
  }
  // Interleave the sessions in one global sequence, each session's facts in its own order.
  const cursors = bySession.map(() => 0)
  const facts: SeedFact[] = []
  let remaining = bySession.reduce((total, list) => total + list.length, 0)
  while (remaining) {
    const pick = Math.floor(random() * bySession.length)
    for (let offset = 0; offset < bySession.length; offset++) {
      const list = bySession[(pick + offset) % bySession.length]!
      const at = cursors[(pick + offset) % bySession.length]!
      if (at >= list.length) continue
      cursors[(pick + offset) % bySession.length]!++
      const fact = list[at]!
      fact.sequence = facts.length + 1
      fact.id = `progress:${fact.sequence}`
      facts.push(fact)
      remaining--
      break
    }
  }
  return { attempts, facts }
}

export function seedPriceIndex(): CurrentPriceIndex {
  return {
    indexID: "valuation-seed",
    retrievedAt: "2026-11-05T12:00:00.000Z",
    pins: SEED_ROUTES.map((route, index) => ({
      route,
      productID: `${route.providerID}/${route.modelID}`,
      configurationID: modelConfigurationID(route.providerID, route.modelID, route.variant),
      semantics: "quote" as const,
      resolution: {
        route: "resolved" as const,
        sku: "resolved" as const,
        configuration: "resolved" as const,
        tier: "resolved" as const,
        schedule: "not-applicable" as const,
      },
      tier: {
        id: "base",
        contextTierTokens: null,
        minPromptTokens: null,
        utcStart: null,
        utcEnd: null,
      },
      rates: {
        unit: "USD per token" as const,
        uncachedInput: `0.00000${index + 1}1`,
        completion: `0.00000${index + 2}3`,
        cacheRead: "0.0000001",
        cacheWrite: "0.0000012",
      },
      provenance: {
        source: "openrouter-models" as const,
        snapshotID: `aaaaaaaa-aaaa-4aaa-8aaa-${(index + 1).toString(16).padStart(12, "0")}`,
        generation: 1,
        retrievedAt: "2026-11-05T12:00:00.000Z",
        asOf: null,
        sourceURL: "https://openrouter.ai/api/v1/models",
        recordIndex: index,
        recordID: route.modelID,
      },
    })),
  }
}
