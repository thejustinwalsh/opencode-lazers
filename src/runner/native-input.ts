import type { OpenCode } from "@opencode/client"

/** Context is only the latest compaction window; message cursors retain durable order. */
export async function retainedNativeInputID(
  client: Pick<ReturnType<typeof OpenCode.make>, "message">,
  sessionID: string,
): Promise<string | undefined> {
  const [users, synthetics] = await Promise.all(
    (["user", "synthetic"] as const).map((type) =>
      client.message.list({ sessionID, type, order: "desc", limit: 1 }),
    ),
  )
  const user = users!.data[0]
  const synthetic = synthetics!.data[0]
  if (!user) return synthetic?.id
  if (!synthetic) return user.id
  // A previous cursor in descending order selects newer records by host sequence,
  // independent of timestamps, generated IDs, or how much history was compacted.
  const cursor = synthetics!.cursor.previous
  if (!cursor) throw new Error("Native input history did not provide its ordering cursor")
  const newerUsers = await client.message.list({ sessionID, type: "user", cursor, limit: 1 })
  return newerUsers.data.length ? user.id : synthetic.id
}

export async function resolveNativeInputID(
  messages: readonly unknown[],
  retained: () => Promise<string | undefined>,
): Promise<string | undefined> {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { type?: string; id?: string } | undefined
    if (message?.type === "user" || message?.type === "synthetic") return message.id
  }
  return messages.some((message) => {
    const value = message as { type?: string; status?: string } | undefined
    return value?.type === "compaction" && value.status === "completed"
  })
    ? retained()
    : undefined
}
