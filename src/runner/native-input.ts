import type { OpenCode } from "@opencode/client"

// Pinned session/runner/llm.ts emits these bare notes within the same logical step.
const nativeContinuations = new Set([
  "The previous response was interrupted. Continue from where you left off without repeating completed content.",
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.",
])

function isNativeInput(message: unknown): message is { id?: string } {
  const value = message as
    | { type?: string; text?: unknown; metadata?: { instruction?: { paths?: unknown } } }
    | undefined
    | null
  if (value?.type === "user") return true
  if (value?.type !== "synthetic") return false
  if (
    value.metadata === undefined &&
    typeof value.text === "string" &&
    nativeContinuations.has(value.text)
  )
    return false
  // OpenCode publishes loaded instruction files as context, not a new turn input.
  const paths = value.metadata?.instruction?.paths
  return !(
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every((path) => typeof path === "string")
  )
}

/** Context is only the latest compaction window; message cursors retain durable order. */
export async function retainedNativeInputID(
  client: Pick<ReturnType<typeof OpenCode.make>, "message">,
  sessionID: string,
): Promise<string | undefined> {
  const [users, latestSynthetics] = await Promise.all(
    (["user", "synthetic"] as const).map((type) =>
      client.message.list({ sessionID, type, order: "desc", limit: 1 }),
    ),
  )
  const user = users!.data[0]
  let synthetics = latestSynthetics!
  const cursors = new Set<string>()
  while (synthetics.data.length && !isNativeInput(synthetics.data[0])) {
    const cursor = synthetics.cursor.next
    if (!cursor) return user?.id
    if (cursors.has(cursor)) throw new Error("Native input history cursor did not advance")
    cursors.add(cursor)
    synthetics = await client.message.list({ sessionID, type: "synthetic", cursor, limit: 1 })
  }
  const synthetic = synthetics.data[0]
  if (!user) return synthetic?.id
  if (!synthetic) return user.id
  // A previous cursor in descending order selects newer records by host sequence,
  // independent of timestamps, generated IDs, or how much history was compacted.
  const cursor = synthetics.cursor.previous
  if (!cursor) throw new Error("Native input history did not provide its ordering cursor")
  const newerUsers = await client.message.list({ sessionID, type: "user", cursor, limit: 1 })
  return newerUsers.data.length ? user.id : synthetic.id
}

export async function resolveNativeInputID(
  messages: readonly unknown[],
  retained: () => Promise<string | undefined>,
): Promise<string | undefined> {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (isNativeInput(message)) return message.id
  }
  return messages.some((message) => {
    const value = message as { type?: string; status?: string } | undefined
    return value?.type === "compaction" && value.status === "completed"
  })
    ? retained()
    : undefined
}
