import type { RunnerHostMessage, RunnerHost } from "./host.ts"

/**
 * One message of a session by ID: a point read, not a conversation read. Older injected hosts
 * without `message` answer from the current turn their `session` read returns.
 */
export async function hostMessageByID(
  host: Pick<RunnerHost, "message" | "session">,
  sessionID: string,
  messageID: string,
): Promise<RunnerHostMessage | undefined> {
  if (host.message) return host.message(sessionID, messageID)
  const session = await host.session(sessionID, { messages: true })
  return session?.messages.find((message) => message.id === messageID)
}
