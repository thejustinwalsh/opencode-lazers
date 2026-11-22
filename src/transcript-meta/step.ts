import { DateTime } from "effect"

/**
 * The metadata of one assistant message (a model step) that LAZERS keeps: ids, position, route,
 * times, the two token counts a consumer reads, the error name and the provider retry (time,
 * attempt, error name). Never the
 * message text, tool input or output, reasoning, or an error message.
 */
export type TranscriptStep = {
  messageID: string
  ordinal: number
  providerID: string | null
  modelID: string | null
  variant: string | null
  createdAt: number | null
  streamedAt: number | null
  completedAt: number | null
  inputTokens: number | null
  outputTokens: number | null
  errorType: string | null
  retryAt: number | null
  retryAttempt: number | null
  retryErrorType: string | null
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** Epoch milliseconds of a host time (a number, or a decoded `DateTime`), as the report reads it. */
export function dateMillis(value: unknown): number | null {
  let millis: number
  if (typeof value === "number" && Number.isFinite(value)) millis = value
  else {
    if (value === null || value === undefined) return null
    try {
      millis = DateTime.toEpochMillis(value as DateTime.DateTime)
    } catch {
      return null
    }
  }
  const integer = Math.trunc(millis)
  return Number.isSafeInteger(integer) ? integer : null
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null

const text = (value: unknown) => (typeof value === "string" ? value : null)

/**
 * An error's name is an identifier (`ProviderError`, `APIError`); anything else, which could carry
 * text, is stored as `other`. The message is never stored.
 */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
function errorType(value: unknown): string | null {
  const error = record(value)
  if (!error) return value ? "other" : null
  const name = error.type
  return typeof name === "string" && ERROR_NAME.test(name) ? name : "other"
}

/** The step of one host message at `ordinal`, or null when it is not an assistant message. */
export function transcriptStep(raw: unknown, ordinal: number): TranscriptStep | null {
  const message = record(raw)
  if (message?.type !== "assistant" || typeof message.id !== "string") return null
  const model = record(message.model)
  const time = record(message.time)
  const tokens = record(message.tokens)
  const retry = record(message.retry)
  return {
    messageID: message.id,
    ordinal,
    providerID: text(model?.providerID),
    modelID: text(model?.id),
    variant: text(model?.variant),
    createdAt: dateMillis(time?.created),
    streamedAt: dateMillis(time?.streamed),
    completedAt: dateMillis(time?.completed),
    inputTokens: count(tokens?.input),
    outputTokens: count(tokens?.output),
    errorType: errorType(message.error),
    retryAt: retry ? dateMillis(retry.at) : null,
    retryAttempt: retry ? count(retry.attempt) : null,
    retryErrorType: retry ? errorType(retry.error) : null,
  }
}
