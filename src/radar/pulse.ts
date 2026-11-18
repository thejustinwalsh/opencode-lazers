/** The slice of an edge the quiet-baseline tracker reads. */
export type RadarMapEdge = {
  id: string
  kind: string
  from: string
  to: string
  status: string
  records: unknown[]
  evidence: unknown[]
  routeRecords: unknown[]
  related: string[]
  pulseEventIDs: string[]
}

export type RadarPulse = { edgeID: string; eventID: string }

/** Consume identified live native evidence once; old/history edges never become pulses. */
export function observeRadarPulses(
  edges: readonly RadarMapEdge[],
  seen: Set<string>,
  motionAllowed: boolean,
): RadarPulse[] {
  const pulses: RadarPulse[] = []
  for (const edge of edges) {
    for (const eventID of edge.pulseEventIDs) {
      const key = `${edge.id}\u0000${eventID}`
      if (seen.has(key)) continue
      seen.add(key)
      if (motionAllowed) pulses.push({ edgeID: edge.id, eventID })
    }
  }
  return pulses
}

/** Establish a quiet baseline at startup and whenever the observation reconnects. */
export class RadarPulseTracker {
  private readonly seen = new Set<string>()
  private initialized = false
  private wasStale = true

  update(edges: readonly RadarMapEdge[], stale: boolean, motionAllowed: boolean) {
    if (!this.initialized || stale || this.wasStale) {
      observeRadarPulses(edges, this.seen, false)
      this.initialized = true
      this.wasStale = stale
      return []
    }
    this.wasStale = false
    return observeRadarPulses(edges, this.seen, motionAllowed)
  }
}
