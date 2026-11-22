import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { ReloadObservation } from "./reload-safety.ts"

const OPENCODE_VERSION = "2.3.0"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorReason(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300)
}

export async function observeOpenCodeSessions(): Promise<ReloadObservation> {
  try {
    const endpoint = await Service.discover({ version: OPENCODE_VERSION })
    if (!endpoint)
      return { kind: "unavailable", reason: "OpenCode 2.3.0 service is not registered" }
    const active = await OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
    }).session.active()
    if (!isRecord(active))
      return { kind: "unavailable", reason: "host returned an invalid active-session inventory" }
    const sessionIDs: string[] = []
    for (const [sessionID, status] of Object.entries(active)) {
      if (!isRecord(status) || status.type !== "running")
        return { kind: "unavailable", reason: "host returned an invalid active-session status" }
      sessionIDs.push(sessionID)
    }
    return { kind: "observed", sessionIDs }
  } catch (error) {
    return { kind: "unavailable", reason: errorReason(error) }
  }
}
