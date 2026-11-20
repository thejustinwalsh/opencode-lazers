import { sharedInFlight, sharedSessionSet } from "../core/process-shared.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import type { TaskRepository } from "../storage.ts"
import { currentRepoMap, recordMapDelivery, repoMapBlock } from "./repo-map-store.ts"

/** Key of the keyed session instruction that carries the map. */
export const architectMapKey = "lazers-repo-map"

type SessionApi = Pick<Plugin.Context["session"], "get" | "instructions">
const inFlight = sharedInFlight<boolean>("architect-map.inFlight")
/** Sessions known to hold the entry, so later prompts cost nothing. */
const installed = sharedSessionSet("architect-map.installed")

/**
 * Install the repository map as a keyed session instruction on an Architect session: once, at the
 * session's start, so it joins the cached prefix and is never re-sent. A session that already holds
 * the entry (re-entry, a renewal seam running twice, a lost response) is left untouched. Returns
 * whether this call installed it.
 */
export function ensureArchitectMap(
  session: SessionApi,
  repository: TaskRepository,
  sessionID: string,
): Promise<boolean> {
  if (installed.has(sessionID)) return Promise.resolve(false)
  const running = inFlight.get(sessionID)
  if (running) return running
  const run = (async () => {
    const id = Session.ID.make(sessionID)
    const info = await Effect.runPromise(session.get({ sessionID: id }))
    if (info.agent !== "architect") return false
    const entries = await Effect.runPromise(session.instructions.entry.list({ sessionID: id }))
    if (entries.some((entry) => entry.key === architectMapKey)) {
      installed.add(sessionID)
      return false
    }
    const map = await currentRepoMap(
      repository,
      info.location.directory,
      repository.projectDirectory,
    )
    await Effect.runPromise(
      session.instructions.entry.put({
        sessionID: id,
        key: architectMapKey,
        value: repoMapBlock(map, "session start"),
      }),
    )
    recordMapDelivery(repository, { sessionID, role: "architect", map })
    installed.add(sessionID)
    return true
  })().finally(() => inFlight.delete(sessionID))
  inFlight.set(sessionID, run)
  return run
}
