import type { ModelCandidate } from "./comparison-presentation.ts"
import { parseModelName, vendorSlug } from "./name-identity.ts"

export type RouteRef = { providerID: string; modelID: string }
const routeRefKey = (route: RouteRef) => `${route.providerID}\u0000${route.modelID}`

/**
 * One model is one entry, whoever offers it and under whatever alias: a dated snapshot and its
 * `latest` alias (`claude-opus-4-5-20251101`, `claude-opus-4-5`), and the same model through
 * several providers (`anthropic`, `github-copilot`). The vendor's own provider speaks for it, then
 * the undated alias, then the newest; the other routes are siblings whose quotes and scores can
 * still stand in when the chosen one has none.
 */
/** Which of several routes to one model speaks for it: first-party, undated, newest, shortest. */
export function speakingRoute<T extends { key: string; id: string; provider: string }>(
  members: readonly T[],
): T[] {
  return members.toSorted((a, b) => {
    const firstParty = (member: { provider: string }) =>
      vendorSlug(member.provider) === member.provider ? 0 : 1
    const left = parseModelName(a.id).date
    const right = parseModelName(b.id).date
    return (
      firstParty(a) - firstParty(b) ||
      Number(left !== null) - Number(right !== null) ||
      (right ?? "").localeCompare(left ?? "") ||
      a.id.length - b.id.length ||
      a.key.localeCompare(b.key)
    )
  })
}

export function mergeRoutesByIdentity(candidates: readonly ModelCandidate[]) {
  const routeGroups = new Map<string, ModelCandidate[]>()
  for (const candidate of candidates) {
    const key = routeRefKey(candidate.identity)
    routeGroups.set(key, [...(routeGroups.get(key) ?? []), candidate])
  }
  const sameModel = new Map<string, Array<{ key: string; id: string; provider: string }>>()
  for (const [key, group] of routeGroups) {
    const { providerID, modelID } = group[0]!.identity
    const identity = parseModelName(modelID, {
      vendor: vendorSlug(providerID) ? providerID : null,
    })
    sameModel.set(identity.key, [
      ...(sameModel.get(identity.key) ?? []),
      { key, id: modelID, provider: providerID },
    ])
  }
  const aliasOf = new Map<string, string>()
  const groups = new Map<string, ModelCandidate[]>()
  const providersOf = new Map<string, string[]>()
  const siblings = new Map<string, ModelCandidate[][]>()
  for (const members of sameModel.values()) {
    const ordered = speakingRoute(members)
    const chosen = ordered[0]!
    groups.set(chosen.key, routeGroups.get(chosen.key)!)
    providersOf.set(chosen.key, [...new Set(members.map((member) => member.provider))].sort())
    siblings.set(
      chosen.key,
      ordered.slice(1).map((member) => routeGroups.get(member.key)!),
    )
    for (const member of members) aliasOf.set(member.key, chosen.key)
  }
  return { groups, aliasOf, providersOf, siblings }
}

/** The identity key of a route: the same model under any provider shares it. */
export const routeIdentityKey = (route: RouteRef) =>
  parseModelName(route.modelID, { vendor: vendorSlug(route.providerID) ? route.providerID : null })
    .key

/** The effort-less configuration of a route's candidates, else the first. */
export const representativeOf = (group: readonly ModelCandidate[]) =>
  group.find((entry) => entry.identity.variant === null) ?? group[0]!
