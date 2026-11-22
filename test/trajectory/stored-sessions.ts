import type { HostSessionRecord } from "../../src/host-sessions/state.ts"
import { writeHostSession } from "../../src/host-sessions/state.ts"
import { ensureTaskEffortSchema } from "../../src/trajectory/effort-store.ts"
import type { TrajectorySession } from "../../src/trajectory/native.ts"
import type { makeFixture } from "./fixture.ts"

type Fixture = ReturnType<typeof makeFixture>

/** The fixture's sessions as the host session fold stores them. */
function hostRecord(session: TrajectorySession): HostSessionRecord {
  return {
    id: session.id,
    projectID: session.projectID,
    parentID: session.parentID,
    agent: "lazers-implementor",
    title: null,
    directory: null,
    archived: false,
    busy: session.busy,
    busyAt: session.time.busy,
    idleAt: session.time.idle,
    outcome: session.outcome,
    model: session.model
      ? {
          providerID: session.model.providerID,
          id: session.model.id,
          variant: session.model.variant ?? null,
        }
      : null,
    tokensIn: session.tokens?.input ?? null,
    tokensOut: session.tokens?.output ?? null,
    tokensReasoning: session.tokens?.reasoning ?? null,
    tokensCacheRead: session.tokens?.cache.read ?? null,
    tokensCacheWrite: session.tokens?.cache.write ?? null,
    createdAt: session.time.created,
    updatedAt: session.time.updated,
  }
}

export function storeSessions(fixture: Fixture, only?: readonly string[]) {
  ensureTaskEffortSchema(fixture.repository)
  fixture.repository.atomic((db) => {
    for (const session of fixture.sessions.values())
      if (!only || only.includes(session.id))
        writeHostSession(db, fixture.directory, "project", session.id, hostRecord(session))
  })
}
