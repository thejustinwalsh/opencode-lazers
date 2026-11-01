import type {
  ObservationChange,
  ObservationScope,
  RadarResponse,
  SnapshotResponse,
} from "./contract.ts"

function scopeMatches(
  response: Pick<SnapshotResponse | RadarResponse, "scope">,
  scope: ObservationScope,
) {
  return (
    response.scope.kind === scope.kind &&
    (scope.kind === "project" ||
      (response.scope.kind === "session" && response.scope.sessionID === scope.sessionID))
  )
}

/** Reject stale responses and make live-only RPC event gaps require a full resnapshot. */
export class ObservationSyncState {
  generation = 0
  projectID = ""
  scope?: ObservationScope
  snapshot?: SnapshotResponse
  radar?: RadarResponse
  eventSequence?: number
  stale = true

  connect(projectID: string, scope: ObservationScope) {
    this.generation++
    this.projectID = projectID
    this.scope = scope
    this.snapshot = undefined
    this.radar = undefined
    this.eventSequence = undefined
    this.stale = true
    return this.generation
  }

  reconnect() {
    const scope = this.scope
    if (!scope) return this.generation
    return this.connect(this.projectID, scope)
  }

  acceptSnapshot(generation: number, snapshot: SnapshotResponse) {
    if (
      generation !== this.generation ||
      snapshot.projectID !== this.projectID ||
      !this.scope ||
      !scopeMatches(snapshot, this.scope) ||
      (this.eventSequence !== undefined && snapshot.boundary.eventSequence < this.eventSequence)
    )
      return false
    this.snapshot = snapshot
    this.eventSequence = snapshot.boundary.eventSequence
    this.stale = false
    return true
  }

  acceptRadar(generation: number, radar: RadarResponse) {
    if (
      generation !== this.generation ||
      radar.projectID !== this.projectID ||
      !this.scope ||
      !scopeMatches(radar, this.scope) ||
      (this.eventSequence !== undefined && radar.boundary.eventSequence < this.eventSequence)
    )
      return false
    this.radar = radar
    this.eventSequence = radar.boundary.eventSequence
    this.stale = false
    return true
  }

  acceptChange(generation: number, projectID: string, change: ObservationChange) {
    if (
      generation !== this.generation ||
      projectID !== this.projectID ||
      change.projectID !== this.projectID
    )
      return false
    if (this.eventSequence !== undefined && change.sequence <= this.eventSequence) return false
    const gap = this.eventSequence === undefined || change.sequence !== this.eventSequence + 1
    this.eventSequence = change.sequence
    this.stale = true
    return !gap && !change.resnapshotRequired
  }
}
