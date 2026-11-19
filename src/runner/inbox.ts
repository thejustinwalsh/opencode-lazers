export type OutcomeOwnership = {
  lazersKind: "runner-outcome"
  lazersProjectID: string
  lazersProjectDirectory: string
  lazersPlanID: string
  lazersOutboxID: string
  lazersMessageID: string
  lazersSessionID: string
  lazersStatus: string
  lazersVersion: number
}

export type OutcomeInboxEntry = {
  id: string
  type: string
  delivery?: string
  metadata?: Record<string, unknown>
}

export type OutcomeTranscriptMessage = {
  id: string
  type?: string
  metadata?: Record<string, unknown>
}

const ownershipKeys = [
  "lazersKind",
  "lazersProjectID",
  "lazersProjectDirectory",
  "lazersPlanID",
  "lazersOutboxID",
  "lazersMessageID",
  "lazersSessionID",
  "lazersStatus",
  "lazersVersion",
] as const

export function parseOutcomeOwnership(value: unknown): OutcomeOwnership | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const metadata = value as Record<string, unknown>
  if (
    metadata.lazersKind !== "runner-outcome" ||
    typeof metadata.lazersProjectID !== "string" ||
    typeof metadata.lazersProjectDirectory !== "string" ||
    typeof metadata.lazersPlanID !== "string" ||
    typeof metadata.lazersOutboxID !== "string" ||
    typeof metadata.lazersMessageID !== "string" ||
    typeof metadata.lazersSessionID !== "string" ||
    typeof metadata.lazersStatus !== "string" ||
    typeof metadata.lazersVersion !== "number"
  )
    return undefined
  return metadata as OutcomeOwnership
}

function matchesOutcomeOwnership(actual: unknown, expected: OutcomeOwnership): boolean {
  const metadata = parseOutcomeOwnership(actual)
  return Boolean(metadata && ownershipKeys.every((key) => metadata[key] === expected[key]))
}

/** Only a queued synthetic with the complete durable identity is cancellable. */
export function isOwnedQueuedOutcome(
  entry: OutcomeInboxEntry,
  expected: OutcomeOwnership,
): boolean {
  return (
    entry.id === expected.lazersMessageID &&
    entry.type === "synthetic" &&
    entry.delivery === "queue" &&
    matchesOutcomeOwnership(entry.metadata, expected)
  )
}

export function isOwnedOutcomeTranscript(
  message: OutcomeTranscriptMessage,
  expected: OutcomeOwnership,
): boolean {
  return (
    message.id === expected.lazersMessageID &&
    message.type === "synthetic" &&
    matchesOutcomeOwnership(message.metadata, expected)
  )
}
