import { ObservationReads } from "../../src/observability/read.ts"
import type { RadarNativeSession, RadarSessionHost } from "../../src/observability/native.ts"
import type { makeFixture } from "../trajectory/fixture.ts"

export function operationalReads(
  fixture: ReturnType<typeof makeFixture>,
  projectID = "project",
  secret = new Uint8Array(32).fill(5),
  additionalSessions: RadarNativeSession[] = [],
) {
  const sessions: RadarNativeSession[] = [
    ...[...fixture.sessions.values()].map((session) => ({
      id: session.id,
      projectID,
      parentID: session.parentID,
      directory: fixture.store.repository.projectDirectory,
      agent: "worker",
      model: session.model
        ? {
            providerID: session.model.providerID,
            id: session.model.id,
            variant: session.model.variant ?? null,
          }
        : null,
      archived: false,
      busy: session.busy,
      createdAt: session.time.created,
      updatedAt: session.time.updated,
    })),
    ...additionalSessions,
  ]
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const nativeSessions: RadarSessionHost = {
    get: async (id) => byID.get(id) ?? null,
    project: async (requestedProjectID, includeArchived, limit) => {
      const matching = sessions.filter(
        (session) =>
          session.projectID === requestedProjectID && (includeArchived || !session.archived),
      )
      return { sessions: matching.slice(0, limit), truncated: matching.length > limit }
    },
    descendants: async (requestedProjectID, rootID, includeArchived, limit) => {
      const output: RadarNativeSession[] = []
      const visited = new Set([rootID])
      let changed = true
      while (changed) {
        changed = false
        for (const session of sessions) {
          if (
            session.projectID === requestedProjectID &&
            session.parentID &&
            visited.has(session.parentID) &&
            !visited.has(session.id) &&
            (includeArchived || !session.archived)
          ) {
            visited.add(session.id)
            output.push(session)
            changed = true
          }
        }
      }
      return { sessions: output.slice(0, limit), truncated: output.length > limit }
    },
  }
  return new ObservationReads(fixture.store, fixture.host, projectID, secret, nativeSessions)
}
