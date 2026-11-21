import { privateTagOmission, safeText, safeValue } from "./privacy.ts"
import type { PrivacyStats } from "./privacy.ts"
import { dateMillis } from "../transcript-meta/step.ts"

/**
 * The privacy-filtered events one host message contributes to a trajectory read, shared by the
 * report (`read.ts`, the parity oracle) and the `trajectory.transcript` stream source. Every text
 * passes `safeText` and friends; reasoning, system and attachment parts are only counted.
 */

export const modelIdentities = new WeakMap<
  object,
  {
    providerID: string
    modelID: string
    variant: string | null
  }
>()

export function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const EPOCH_MILLIS = "unix-epoch-ms" as const

function contextTiming(
  endpoints: Record<string, { value: unknown; sourceType: string; meaning: string }>,
) {
  return {
    unit: EPOCH_MILLIS,
    endpoints: Object.fromEntries(
      Object.entries(endpoints).map(([key, endpoint]) => {
        const at = dateMillis(endpoint.value)
        return [
          key,
          {
            at,
            source: at === null ? null : "native-context",
            sourceType: at === null ? null : endpoint.sourceType,
            meaning: endpoint.meaning,
          },
        ]
      }),
    ),
  }
}

export function modelView(value: unknown, stats: PrivacyStats) {
  const data = object(value)
  if (!data) return null
  const providerID = typeof data.providerID === "string" ? data.providerID : null
  const id = typeof data.id === "string" ? data.id : null
  if (!providerID || !id) return null
  const view = {
    providerID: safeText(providerID, stats, 120),
    id: safeText(id, stats, 120),
    ...(typeof data.variant === "string" ? { variant: safeText(data.variant, stats, 120) } : {}),
  }
  modelIdentities.set(view, {
    providerID,
    modelID: id,
    variant: typeof data.variant === "string" ? data.variant : null,
  })
  return view
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function safeErrorView(value: unknown, stats: PrivacyStats) {
  try {
    if (value instanceof Error) {
      const message = safeText(value.message, stats, 1000)
      return message ? { message } : null
    }
    const data = object(value)
    if (!data) return null
    const rawType = data.type
    const privateKind = privateTagOmission(rawType)
    if (privateKind === "reasoning") stats.omittedReasoning++
    else if (privateKind === "system") stats.omittedSystem++
    else if (privateKind === "attachment") stats.omittedAttachments++
    if (privateKind) return null
    const type = typeof rawType === "string" ? safeText(rawType, stats, 160) : null
    const message = typeof data.message === "string" ? safeText(data.message, stats, 1000) : null
    return type || message ? { ...(type ? { type } : {}), ...(message ? { message } : {}) } : null
  } catch {
    stats.omittedUnsupportedParts++
    return null
  }
}

function safeToolContent(value: unknown, stats: PrivacyStats) {
  const output: string[] = []
  try {
    if (!Array.isArray(value)) return ""
    const length = value.length
    for (let index = 0; index < Math.min(length, 40); index++) {
      const entry = object(value[index])
      if (entry?.type === "text" && typeof entry.text === "string")
        output.push(safeText(entry.text, stats))
      else if (entry?.type === "file") stats.omittedAttachments++
      else stats.omittedUnsupportedParts++
    }
    if (length > 40) stats.truncated++
  } catch {
    stats.omittedUnsupportedParts++
    return ""
  }
  return safeText(output.join("\n"), stats)
}

export type MessageContext = {
  stats: PrivacyStats
  base: (id: string, at: number | null, kind: string) => Record<string, unknown>
  add: (event: Record<string, unknown>) => void
}

export type MessageSlice = {
  message: Record<string, unknown>
  messageID: string
  createdAt: number | null
}

const TOOL_STATUSES = ["streaming", "running", "completed", "error"]

function userMessageEvents(ctx: MessageContext, { message, messageID, createdAt }: MessageSlice) {
  if (typeof message.text === "string")
    ctx.add({
      ...ctx.base(`${messageID}:text`, createdAt, message.type as string),
      text: safeText(message.text, ctx.stats),
    })
  if (Array.isArray(message.files)) ctx.stats.omittedAttachments += message.files.length
}

function assistantStepStatus(message: Record<string, unknown>, createdAt: number | null) {
  const messageTime = object(message.time)
  if (message.error) return "failed"
  if (dateMillis(messageTime?.completed) !== null) return "ended"
  if (dateMillis(messageTime?.streamed) !== null) return "streamed"
  return createdAt !== null ? "started" : "unknown"
}

function assistantStepEvent(
  ctx: MessageContext,
  { message, messageID, createdAt }: MessageSlice,
  model: ReturnType<typeof modelView>,
) {
  const messageTime = object(message.time)
  const stepStatus = assistantStepStatus(message, createdAt)
  ctx.add({
    ...ctx.base(`${messageID}:assistant-step`, createdAt, "assistant-step"),
    model,
    status: stepStatus,
    timing: contextTiming({
      startedAt: {
        value: messageTime?.created,
        sourceType: "session-message.assistant.time.created",
        meaning: "Retained assistant message start time",
      },
      streamedAt: {
        value: messageTime?.streamed,
        sourceType: "session-message.assistant.time.streamed",
        meaning: "Provider response-body end before tool settlement",
      },
      completedAt: {
        value: messageTime?.completed,
        sourceType: "session-message.assistant.time.completed",
        meaning: "Assistant completion after tool settlement",
      },
    }),
  })
}

function assistantToolEvent(
  ctx: MessageContext,
  part: Record<string, unknown>,
  partIndex: number,
  { messageID }: MessageSlice,
  model: ReturnType<typeof modelView>,
) {
  const { stats } = ctx
  const toolState = object(part.state)
  const status = typeof toolState?.status === "string" ? toolState.status : "unsupported"
  if (!toolState || !TOOL_STATUSES.includes(status)) stats.omittedUnsupportedParts++
  const input = toolState?.input
  const inputView = typeof input === "string" ? safeText(input, stats) : safeValue(input, stats)
  const toolTime = object(part.time)
  const ranAt = dateMillis(toolTime?.ran)
  const completedAt = dateMillis(toolTime?.completed)
  const executed = typeof part.executed === "boolean" ? part.executed : null
  const content =
    status === "completed" || status === "error" ? safeToolContent(toolState?.content, stats) : ""
  const error = status === "error" ? safeErrorView(toolState?.error, stats) : null
  ctx.add({
    ...ctx.base(
      `${messageID}:tool:${typeof part.id === "string" ? part.id : partIndex}`,
      ranAt,
      "tool",
    ),
    model,
    tool: typeof part.name === "string" ? safeText(part.name, stats, 160) : "[unknown tool]",
    status: TOOL_STATUSES.includes(status) ? status : "unsupported",
    callStatus: ranAt !== null || executed !== null ? "called" : null,
    input: inputView,
    result: content,
    ...(error ? { error } : {}),
    completedAt,
    execution: {
      status: executed === null ? "unknown" : executed ? "executed" : "not-executed",
      source: executed === null ? null : "native-context",
      sourceType: executed === null ? null : "session-message.assistant.tool.executed",
      meaning: "Retained explicit executed flag; called/ran time alone is not execution proof",
    },
    timing: contextTiming({
      inputAt: {
        value: toolTime?.created,
        sourceType: "session-message.assistant.tool.time.created",
        meaning: "Retained assistant tool input creation boundary",
      },
      calledAt: {
        value: toolTime?.ran,
        sourceType: "session-message.assistant.tool.time.ran",
        meaning: "Retained assistant tool call boundary; not proof that the tool executed",
      },
      completedAt: {
        value: toolTime?.completed,
        sourceType: "session-message.assistant.tool.time.completed",
        meaning: "Retained assistant tool result terminal boundary",
      },
    }),
  })
}

function assistantPartEvent(
  ctx: MessageContext,
  rawPart: unknown,
  partIndex: number,
  slice: MessageSlice,
  model: ReturnType<typeof modelView>,
) {
  const { stats } = ctx
  const part = object(rawPart)
  if (!part || typeof part.type !== "string") {
    stats.omittedUnsupportedParts++
    return
  }
  if (part.type === "reasoning") {
    stats.omittedReasoning++
    return
  }
  if (part.type === "text") {
    if (typeof part.text !== "string") {
      stats.omittedUnsupportedParts++
      return
    }
    ctx.add({
      ...ctx.base(`${slice.messageID}:text:${partIndex}`, slice.createdAt, "assistant-text"),
      model,
      text: safeText(part.text, stats),
    })
    return
  }
  if (part.type !== "tool") {
    stats.omittedUnsupportedParts++
    return
  }
  assistantToolEvent(ctx, part, partIndex, slice, model)
}

function assistantTrailingEvents(
  ctx: MessageContext,
  { message, messageID, createdAt }: MessageSlice,
) {
  if (message.retry) {
    const retry = object(message.retry)
    if (retry) {
      ctx.add({
        ...ctx.base(`${messageID}:provider-retry`, dateMillis(retry.at), "provider-retry"),
        attempt: asNumber(retry.attempt),
        error: safeErrorView(retry.error, ctx.stats),
        timing: contextTiming({
          scheduledAt: {
            value: retry.at,
            sourceType: "session-message.assistant.retry.at",
            meaning: "Retained provider retry scheduled time",
          },
        }),
      })
    }
  }
  if (message.error) {
    ctx.add({
      ...ctx.base(`${messageID}:error`, createdAt, "assistant-error"),
      error: safeErrorView(message.error, ctx.stats),
    })
  }
}

function assistantMessageEvents(ctx: MessageContext, slice: MessageSlice) {
  const model = modelView(slice.message.model, ctx.stats)
  const parts = Array.isArray(slice.message.content) ? slice.message.content : []
  assistantStepEvent(ctx, slice, model)
  for (const [partIndex, rawPart] of parts.entries())
    assistantPartEvent(ctx, rawPart, partIndex, slice, model)
  assistantTrailingEvents(ctx, slice)
}

function shellMessageEvents(ctx: MessageContext, { message, messageID, createdAt }: MessageSlice) {
  const { stats } = ctx
  const output = object(message.output)
  const shellTime = object(message.time)
  ctx.add({
    ...ctx.base(messageID, createdAt, "shell"),
    command: typeof message.command === "string" ? safeText(message.command, stats) : "",
    status: typeof message.status === "string" ? safeText(message.status, stats, 80) : "unknown",
    exit: asNumber(message.exit),
    output: typeof output?.output === "string" ? safeText(output.output, stats) : "",
    outputTruncated: output?.truncated === true,
    completedAt: dateMillis(shellTime?.completed),
    timing: contextTiming({
      createdAt: {
        value: shellTime?.created,
        sourceType: "session-message.shell.time.created",
        meaning: "Retained shell message creation; not process start",
      },
      startedAt: {
        value: undefined,
        sourceType: "session-message.shell.process.started",
        meaning: "Process start is not available in the retained shell message",
      },
      completedAt: {
        value: shellTime?.completed,
        sourceType: "session-message.shell.time.completed",
        meaning: "Retained shell completion time",
      },
    }),
  })
  if (output?.truncated === true) stats.truncated++
}

function compactionMessageEvents(
  ctx: MessageContext,
  { message, messageID, createdAt }: MessageSlice,
) {
  ctx.stats.compacted++
  const status = message.status
  const failed = status === "failed"
  ctx.add({
    ...ctx.base(messageID, createdAt, "compaction"),
    status: ["running", "completed", "failed"].includes(String(status)) ? status : "unknown",
    reason: message.reason === "auto" || message.reason === "manual" ? message.reason : "unknown",
    ...(failed ? { error: safeErrorView(message.error, ctx.stats) } : {}),
    summary: "[omitted: compaction summary and replay data are private]",
  })
}

function switchMessageEvents(
  ctx: MessageContext,
  { message, messageID, createdAt }: MessageSlice,
): boolean {
  const { stats } = ctx
  if (message.type === "idle") {
    ctx.add({
      ...ctx.base(messageID, createdAt, "session-idle"),
      outcome: ["succeeded", "failed", "interrupted"].includes(String(message.outcome))
        ? message.outcome
        : "unknown",
      error: safeErrorView(message.error, stats),
    })
    return true
  }
  if (message.type === "model-switched") {
    ctx.add({
      ...ctx.base(messageID, createdAt, "model-switched"),
      model: modelView(message.model, stats),
      previous: modelView(message.previous, stats),
    })
    return true
  }
  if (message.type === "agent-switched") {
    ctx.add({
      ...ctx.base(messageID, createdAt, "agent-switched"),
      agent: typeof message.agent === "string" ? safeText(message.agent, stats, 120) : null,
      previous:
        typeof message.previous === "string" ? safeText(message.previous, stats, 120) : null,
    })
    return true
  }
  if (message.type === "location-switched") {
    ctx.add({ ...ctx.base(messageID, createdAt, "location-switched"), location: "[path omitted]" })
    return true
  }
  return false
}

export function messageSliceEvents(ctx: MessageContext, slice: MessageSlice) {
  const type = slice.message.type
  if (type === "user" || type === "synthetic") return userMessageEvents(ctx, slice)
  if (type === "assistant") return assistantMessageEvents(ctx, slice)
  if (type === "shell") return shellMessageEvents(ctx, slice)
  if (type === "compaction") return compactionMessageEvents(ctx, slice)
  if (switchMessageEvents(ctx, slice)) return
  if (type === "system" || type === "skill") ctx.stats.omittedSystem++
  else ctx.stats.omittedUnsupportedParts++
}
